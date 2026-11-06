/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { EpochInner } from "#coop/epoch";
import type { Envelope, Seat } from "#coop/protocol";
import type { ReliableTransport } from "#coop/transport/reliable";
import type { Unsubscribe } from "#coop/transport/transport";

/**
 * The host's transport in a game of three (DECISIONS D40): one reliable channel per guest, seen as one. What the host sends
 * goes to every guest, or to one; what a guest sends arrives with `from` set to that guest's seat, overwriting whatever the
 * guest wrote there, so the sequencer can check that a proposal's author is the guest who sent it. Each guest's channel keeps
 * its own order and acknowledgements: one guest's drop does not hold up the other.
 *
 * As the transports it stands for, it keeps what arrives while nobody listens for the first listener.
 */
export class FanoutTransport implements EpochInner {
  private readonly listeners = new Set<(message: Envelope) => void>();
  private early: Envelope[] = [];
  /** Guests nothing is sent to any more: their connection dropped or they left */
  private readonly gone = new Set<Seat>();

  private readonly channels: Map<Seat, ReliableTransport>;

  constructor(channels: ReadonlyMap<Seat, ReliableTransport>) {
    this.channels = new Map(channels);
    for (const [seat, channel] of this.channels) {
      channel.onMessage(message => this.deliver({ ...message, from: seat }));
    }
  }

  /**
   * A guest who came back (D40): its new channel, once its handshake is through, takes the old one's place. Sending to it
   * starts again with {@linkcode resume}, from the reload it joins with: what it missed before that comes with the reload.
   */
  replace(seat: Seat, channel: ReliableTransport): void {
    const old = this.channels.get(seat);
    if (old === undefined) {
      throw new RangeError(`${seat} is not a guest of this hub`);
    }
    if (old !== channel) {
      old.close();
      this.channels.set(seat, channel);
      channel.onMessage(message => this.deliver({ ...message, from: seat }));
    }
  }

  /** Send to a guest again (one that came back, from the reload it joins with) */
  resume(seat: Seat): void {
    this.gone.delete(seat);
  }

  /** Envelopes sent and not yet acknowledged, over all guests */
  get pending(): number {
    let pending = 0;
    for (const channel of this.channels.values()) {
      pending += channel.pending;
    }
    return pending;
  }

  close(): void {
    for (const channel of this.channels.values()) {
      channel.close();
    }
  }

  send(message: Envelope): void {
    for (const [seat, channel] of this.channels) {
      if (!this.gone.has(seat)) {
        channel.send(message);
      }
    }
  }

  sendVolatile(message: Envelope): void {
    for (const [seat, channel] of this.channels) {
      if (!this.gone.has(seat)) {
        channel.sendVolatile(message);
      }
    }
  }

  /** Send to one guest only (a `REJECT` goes to the guest whose proposal it refuses) */
  sendTo(seat: Seat, message: Envelope): void {
    if (!this.gone.has(seat)) {
      this.channels.get(seat)?.send(message);
    }
  }

  /**
   * A guest's connection dropped, or they left: nothing more is sent to them, and what they had not acknowledged is not sent
   * again (resending to a player who is not there would only fill the relay). A guest who comes back joins at a wave start
   * with a reload of their own (D40), not on this channel's old numbers.
   */
  stopSending(seat: Seat): void {
    if (this.channels.has(seat) && !this.gone.has(seat)) {
      this.gone.add(seat);
      this.channels.get(seat)?.detach();
    }
  }

  onMessage(listener: (message: Envelope) => void): Unsubscribe {
    this.listeners.add(listener);
    if (this.listeners.size === 1 && this.early.length > 0) {
      const waiting = this.early;
      this.early = [];
      for (const message of waiting) {
        listener(message);
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  private deliver(message: Envelope): void {
    if (this.listeners.size === 0) {
      this.early.push(message);
      return;
    }
    for (const listener of [...this.listeners]) {
      listener(message);
    }
  }
}
