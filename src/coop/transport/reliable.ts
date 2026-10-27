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
  /** First resend delay. Doubles with every retry up to {@linkcode maxRtoMs}. Default 200 ms. */
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
  /** Timers and clock. Default: real ones. */
  scheduler?: Scheduler;
}

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
}

function isFrameNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/**
 * An ordered, exactly-once envelope channel over a lossy {@linkcode RawTransport}.
 *
 * Every sent envelope gets a per-sender number `n` and is kept until the partner acknowledges it, resent with
 * exponential backoff meanwhile. The receiver delivers envelopes in `n` order, drops duplicates and holds frames that
 * arrive ahead of a gap. Acks are cumulative plus a list of the out-of-order numbers already held.
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
  private ackScheduled = false;
  private closed = false;

  private readonly rtoMs: number;
  private readonly maxRtoMs: number;
  private readonly tickMs: number;
  private readonly maxSackEntries: number;
  private readonly maxHeld: number;
  private readonly scheduler: Scheduler;

  constructor(raw: RawTransport | null = null, options: ReliableOptions = {}) {
    this.rtoMs = options.rtoMs ?? 200;
    this.maxRtoMs = options.maxRtoMs ?? 2000;
    this.tickMs = options.tickMs ?? 25;
    this.maxSackEntries = options.maxSackEntries ?? 64;
    this.maxHeld = options.maxHeld ?? 256;
    this.scheduler = options.scheduler ?? systemScheduler;
    if (raw) {
      this.attach(raw);
    }
  }

  /** Envelopes sent and not yet acknowledged. */
  get pending(): number {
    return this.unacked.size;
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
    const frame = JSON.stringify({ n, b: message });
    this.unacked.set(n, { frame, sentAt: this.scheduler.now(), tries: 0 });
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
    this.sendRaw(JSON.stringify({ v: message }));
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
    if (typeof frame["a"] === "number") {
      this.receiveAck(frame["a"], frame["s"]);
    } else if ("v" in frame) {
      if (isEnvelope(frame["v"]) && !this.closed) {
        this.stats.volatileDelivered++;
        this.dispatch(frame["v"]);
      } else {
        this.stats.malformed++;
      }
    } else if (isFrameNumber(frame["n"]) && "b" in frame) {
      this.receiveData(frame["n"], frame["b"]);
    } else {
      this.stats.malformed++;
    }
  }

  private receiveAck(upTo: number, selective: unknown): void {
    for (const n of this.unacked.keys()) {
      if (n > upTo) {
        break; // keys are in ascending order
      }
      this.unacked.delete(n);
    }
    if (Array.isArray(selective)) {
      for (const n of selective.slice(0, this.maxSackEntries)) {
        if (isFrameNumber(n)) {
          this.unacked.delete(n);
        }
      }
    }
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

  /** One ack per burst of frames. */
  private scheduleAck(): void {
    if (this.ackScheduled) {
      return;
    }
    this.ackScheduled = true;
    queueMicrotask(() => {
      this.ackScheduled = false;
      if (this.closed || !this.raw) {
        return;
      }
      const selective = [...this.held.keys()].sort((a, b) => a - b).slice(0, this.maxSackEntries);
      this.sendRaw(JSON.stringify({ a: this.deliveredN, s: selective }));
    });
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
      const rto = Math.min(this.maxRtoMs, this.rtoMs * 2 ** Math.min(pending.tries, 6));
      if (now - pending.sentAt >= rto) {
        pending.sentAt = now;
        pending.tries++;
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
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("reliable transport is closed");
    }
  }
}
