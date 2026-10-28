/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Concept (per-sender numbering, acks, resend) from SunghoLee98/pokerogue `src/coop/reliable-coop-transport.ts`
 * (AGPL-3.0-only); this version adds selective acks, backoff, buffering until a listener subscribes and re-attaching
 * to a new connection.
 */

import { type Envelope, isEnvelope } from "#coop/protocol";
import type { MessageTransport, RawTransport, Scheduler, Unsubscribe } from "#coop/transport/transport";
import { systemScheduler } from "#coop/transport/transport";

export interface ReliableOptions {
  /**
   * Shortest resend delay. The delay follows the measured round trip (with its variation), from 1 s before the first
   * measurement, and doubles with every retry up to {@linkcode maxRtoMs}. Default 200 ms.
   */
  rtoMs?: number;
  /** Longest resend delay. Default 2000 ms. */
  maxRtoMs?: number;
  /** How often unacknowledged frames are checked. Default 25 ms. */
  tickMs?: number;
  /** How many out-of-order frame numbers an ack may list (selective ack). Default 64. */
  maxSackEntries?: number;
  /**
   * How far ahead of the next frame in order a frame may arrive and be held back. One further ahead is dropped; the sender
   * sends it again until it is acknowledged, so nothing is lost. Default 256.
   */
  maxHeld?: number;
  /**
   * How long an ack waits for a frame going the other way to ride on (one relay message instead of two). It never delays a
   * delivery, only the sender forgetting what it sent. Default 50 ms.
   */
  ackDelayMs?: number;
  /** Timers and clock. Default: real ones. */
  scheduler?: Scheduler;
}

/** The resend delay before the round trip has been measured (as TCP's, RFC 6298) */
const INITIAL_RTO_MS = 1000;

/** The longest frame the relay forwards (`maxPayload` of the relay, `MAX_FRAME_CHARS` of the worker); a longer one is dropped */
export const MAX_FRAME_CHARS = 1_048_576;

export interface ReliableStats {
  /** Envelopes handed to {@linkcode ReliableTransport.send} */
  sent: number;
  /** Frames sent again because their ack did not come in time or the connection was replaced */
  resent: number;
  /** Envelopes handed to listeners (each exactly once, in order) */
  delivered: number;
  /** Data frames received that were already delivered or already buffered */
  duplicatesDropped: number;
  /** Data frames that arrived ahead of a gap and had to wait */
  heldBack: number;
  /** Data frames that arrived too far ahead of a gap to be held, and were dropped (the sender sends them again) */
  tooFarAhead: number;
  /** Frames that were not valid JSON or not an envelope */
  malformed: number;
  /** Volatile envelopes handed to {@linkcode ReliableTransport.sendVolatile} */
  volatileSent: number;
  /** Volatile envelopes received and handed to listeners */
  volatileDelivered: number;
}

interface PendingFrame {
  frame: string;
  sentAt: number;
  tries: number;
  /** Sent more than once: its ack says nothing about the round trip (Karn) */
  resent: boolean;
}

function isFrameNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/**
 * An ordered, exactly-once envelope channel over a lossy {@linkcode RawTransport}.
 *
 * Every sent envelope gets a per-sender number `n` and is kept until the partner acknowledges it, resent with
 * exponential backoff meanwhile. The receiver delivers envelopes in `n` order, drops duplicates and holds frames that
 * arrive ahead of a gap. Acks are cumulative plus a list of the out-of-order numbers already held; an ack rides on the
 * next frame going the other way when one goes within {@linkcode ReliableOptions.ackDelayMs}, else it goes alone.
 *
 * `n` is a transport detail: it is never a decision key (D2). Decisions are ordered by the sequencer's `seq`.
 *
 * Reconnects: after the connection drops, {@linkcode attach} a new {@linkcode RawTransport}; everything unacknowledged
 * is sent again and duplicates are dropped, so the layers above see an uninterrupted stream.
 */
export class ReliableTransport implements MessageTransport {
  readonly stats: ReliableStats = {
    sent: 0,
    resent: 0,
    delivered: 0,
    duplicatesDropped: 0,
    heldBack: 0,
    tooFarAhead: 0,
    malformed: 0,
    volatileSent: 0,
    volatileDelivered: 0,
  };

  private raw: RawTransport | null = null;
  private unsubscribeFrame: Unsubscribe | null = null;
  private unsubscribeClose: Unsubscribe | null = null;

  private nextN = 1;
  private readonly unacked = new Map<number, PendingFrame>();

  /** Highest frame number delivered in order. */
  private deliveredN = 0;
  private readonly held = new Map<number, unknown>();

  private readonly listeners = new Set<(message: Envelope) => void>();
  /** Delivered while nobody listened: handed to the first listener. */
  private readonly early: Envelope[] = [];

  private ticker: unknown = null;
  /** Something was received that the partner has not been told of */
  private ackOwed = false;
  private ackTimer: unknown = null;
  private closed = false;
  /** The smoothed round trip and its variation, in ms; `null` until measured */
  private srtt: number | null = null;
  private rttvar = 0;
  private rto: number;

  private readonly rtoMs: number;
  private readonly maxRtoMs: number;
  private readonly tickMs: number;
  private readonly maxSackEntries: number;
  private readonly maxHeld: number;
  private readonly ackDelayMs: number;
  private readonly scheduler: Scheduler;

  constructor(raw: RawTransport | null = null, options: ReliableOptions = {}) {
    this.rtoMs = options.rtoMs ?? 200;
    this.maxRtoMs = options.maxRtoMs ?? 2000;
    this.tickMs = options.tickMs ?? 25;
    this.maxSackEntries = options.maxSackEntries ?? 64;
    this.maxHeld = options.maxHeld ?? 256;
    this.ackDelayMs = options.ackDelayMs ?? 50;
    this.rto = Math.min(this.maxRtoMs, Math.max(this.rtoMs, INITIAL_RTO_MS));
    this.scheduler = options.scheduler ?? systemScheduler;
    if (raw) {
      this.attach(raw);
    }
  }

  /** Envelopes sent and not yet acknowledged. */
  get pending(): number {
    return this.unacked.size;
  }

  /** The current resend delay of a frame sent once, in ms */
  get retransmitTimeoutMs(): number {
    return this.rto;
  }

  /** Whether a connection is attached and open. */
  get connected(): boolean {
    return this.raw !== null && this.raw.isOpen;
  }

  /**
   * Use `raw` from now on. Frames that were never acknowledged are sent again at once.
   * The previous connection, if any, is left to the caller to close.
   */
  attach(raw: RawTransport): void {
    this.assertOpen();
    this.release();
    this.raw = raw;
    this.unsubscribeFrame = raw.onFrame(frame => this.receiveFrame(frame));
    this.unsubscribeClose = raw.onClose(() => {
      if (this.raw === raw) {
        this.release();
      }
    });
    const now = this.scheduler.now();
    for (const pending of this.unacked.values()) {
      pending.sentAt = now;
      pending.resent = true;
      this.stats.resent++;
      this.sendRaw(pending.frame);
    }
    this.scheduleAck();
    this.ensureTicker();
  }

  /** Stop using the current connection without closing it. Unacknowledged frames wait for the next `attach`. */
  detach(): void {
    this.release();
  }

  /**
   * A new pairing (D20): the partner is another instance (a reloaded tab) or has forgotten this one's numbers, so nothing of
   * the old pairing counts any more. Numbers start again from 1, and whatever was unacknowledged, held back or waiting for a
   * listener is dropped. Listeners stay. Use it before {@linkcode attach}.
   */
  reset(): void {
    this.unacked.clear();
    this.held.clear();
    this.early.length = 0;
    this.nextN = 1;
    this.deliveredN = 0;
  }

  send(message: Envelope): void {
    this.assertOpen();
    const n = this.nextN++;
    const frame = JSON.stringify({ n, b: message, ...this.takeOwedAck() });
    this.unacked.set(n, { frame, sentAt: this.scheduler.now(), tries: 0, resent: false });
    this.stats.sent++;
    this.sendRaw(frame);
    this.ensureTicker();
  }

  /**
   * Send an envelope that may be lost: no number, no acknowledgement, no resend, and it does not wait for the ones before
   * it (D16: cosmetic messages must never delay a decision). The partner hands it to its listeners as soon as it arrives.
   */
  sendVolatile(message: Envelope): void {
    this.assertOpen();
    this.stats.volatileSent++;
    this.sendRaw(JSON.stringify({ v: message, ...this.takeOwedAck() }));
  }

  onMessage(listener: (message: Envelope) => void): Unsubscribe {
    this.listeners.add(listener);
    for (const message of this.early.splice(0)) {
      this.dispatch(message);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Stop for good: no more timers, no more delivery. */
  close(): void {
    this.closed = true;
    this.release();
    this.unacked.clear();
    this.held.clear();
    this.listeners.clear();
  }

  // #region Receiving

  private receiveFrame(text: string): void {
    if (text.length > MAX_FRAME_CHARS) {
      this.stats.malformed++;
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      this.stats.malformed++;
      return;
    }
    if (typeof data !== "object" || data === null) {
      this.stats.malformed++;
      return;
    }
    const frame = data as Record<string, unknown>;
    // An ack may ride on a data or volatile frame
    const hasAck = typeof frame["a"] === "number";
    if (hasAck) {
      this.receiveAck(frame["a"] as number, frame["s"]);
    }
    if ("v" in frame) {
      if (isEnvelope(frame["v"]) && !this.closed) {
        this.stats.volatileDelivered++;
        this.dispatch(frame["v"]);
      } else {
        this.stats.malformed++;
      }
    } else if (isFrameNumber(frame["n"]) && "b" in frame) {
      this.receiveData(frame["n"], frame["b"]);
    } else if (!hasAck) {
      this.stats.malformed++;
    }
  }

  private receiveAck(upTo: number, selective: unknown): void {
    const covered: PendingFrame[] = [];
    for (const [n, pending] of this.unacked) {
      if (n > upTo) {
        break; // keys are in ascending order
      }
      covered.push(pending);
      this.unacked.delete(n);
    }
    const listed = Array.isArray(selective) ? selective.slice(0, this.maxSackEntries).filter(isFrameNumber) : [];
    for (const n of listed) {
      const pending = this.unacked.get(n);
      if (pending !== undefined) {
        covered.push(pending);
        this.unacked.delete(n);
      }
    }
    // The newest frame sent once that this ack covers gives the round trip (one sent again says nothing of it, Karn)
    const sentOnce = covered.filter(pending => !pending.resent).map(pending => pending.sentAt);
    if (sentOnce.length > 0) {
      this.measured(this.scheduler.now() - Math.max(...sentOnce));
    }
  }

  /** A round trip, ack delay included: the resend delay follows it (RFC 6298), so a slow link is not sent everything twice */
  private measured(sample: number): void {
    if (this.srtt === null) {
      this.srtt = sample;
      this.rttvar = sample / 2;
    } else {
      this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - sample);
      this.srtt = 0.875 * this.srtt + 0.125 * sample;
    }
    this.rto = Math.min(this.maxRtoMs, Math.max(this.rtoMs, this.srtt + 4 * this.rttvar));
  }

  private receiveData(n: number, body: unknown): void {
    if (n <= this.deliveredN) {
      this.stats.duplicatesDropped++;
    } else if (n === this.deliveredN + 1) {
      this.deliver(body);
      this.deliveredN = n;
      for (
        let next = this.held.get(this.deliveredN + 1);
        next !== undefined;
        next = this.held.get(this.deliveredN + 1)
      ) {
        this.held.delete(this.deliveredN + 1);
        this.deliveredN++;
        this.deliver(next);
      }
    } else if (this.held.has(n)) {
      this.stats.duplicatesDropped++;
    } else if (n > this.deliveredN + this.maxHeld || this.held.size >= this.maxHeld) {
      // Not acknowledged, so an honest sender sends it again once the gap is closed: only a flood is lost
      this.stats.tooFarAhead++;
    } else {
      this.held.set(n, body);
      this.stats.heldBack++;
    }
    this.scheduleAck();
  }

  private deliver(body: unknown): void {
    if (!isEnvelope(body)) {
      this.stats.malformed++; // still counts as delivered: the numbering must not stall
      return;
    }
    this.stats.delivered++;
    if (this.listeners.size === 0) {
      this.early.push(body);
    } else {
      this.dispatch(body);
    }
  }

  private dispatch(message: Envelope): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(message);
      } catch (error) {
        // A throwing consumer must not stall delivery; surface the error where it is reported as unhandled.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  /** One ack per burst of frames: on the next frame going the other way, or alone after {@linkcode ackDelayMs} */
  private scheduleAck(): void {
    this.ackOwed = true;
    if (this.ackTimer !== null) {
      return;
    }
    this.ackTimer = this.scheduler.setTimeout(() => {
      this.ackTimer = null;
      if (this.ackOwed && !this.closed && this.raw) {
        this.sendRaw(JSON.stringify(this.takeOwedAck()));
      }
    }, this.ackDelayMs);
  }

  /** The ack that is owed, for a frame to carry; nothing if none is */
  private takeOwedAck(): { a: number; s: number[] } | Record<string, never> {
    if (!this.ackOwed || !this.raw?.isOpen) {
      return {};
    }
    this.ackOwed = false;
    if (this.ackTimer !== null) {
      this.scheduler.clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    return { a: this.deliveredN, s: [...this.held.keys()].sort((a, b) => a - b).slice(0, this.maxSackEntries) };
  }

  // #endregion

  // #region Sending

  private sendRaw(frame: string): void {
    const raw = this.raw;
    if (!raw || !raw.isOpen) {
      return;
    }
    try {
      raw.send(frame);
    } catch {
      // The connection died under us: the frame stays unacknowledged and goes out again after `attach`.
    }
  }

  private ensureTicker(): void {
    if (this.ticker !== null || this.closed || !this.raw || this.unacked.size === 0) {
      return;
    }
    this.ticker = this.scheduler.setTimeout(() => {
      this.ticker = null;
      this.resendDue();
    }, this.tickMs);
  }

  private resendDue(): void {
    if (this.closed || !this.raw) {
      return;
    }
    const now = this.scheduler.now();
    for (const pending of this.unacked.values()) {
      const rto = Math.min(this.maxRtoMs, this.rto * 2 ** Math.min(pending.tries, 6));
      if (now - pending.sentAt >= rto) {
        pending.sentAt = now;
        pending.tries++;
        pending.resent = true;
        this.stats.resent++;
        this.sendRaw(pending.frame);
      }
    }
    this.ensureTicker();
  }

  // #endregion

  private release(): void {
    this.unsubscribeFrame?.();
    this.unsubscribeClose?.();
    this.unsubscribeFrame = null;
    this.unsubscribeClose = null;
    this.raw = null;
    if (this.ticker !== null) {
      this.scheduler.clearTimeout(this.ticker);
      this.ticker = null;
    }
    if (this.ackTimer !== null) {
      this.scheduler.clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("reliable transport is closed");
    }
  }
}
