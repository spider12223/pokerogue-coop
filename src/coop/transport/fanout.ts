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
  private pending: Envelope[] = [];

  constructor(private readonly channels: ReadonlyMap<Seat, ReliableTransport>) {
    for (const [seat, channel] of channels) {
      channel.onMessage(message => this.deliver({ ...message, from: seat }));
    }
  }

  /** The guest seats it sends to */
  get seats(): readonly Seat[] {
    return [...this.channels.keys()];
  }

  send(message: Envelope): void {
    for (const channel of this.channels.values()) {
      channel.send(message);
    }
  }

  sendVolatile(message: Envelope): void {
    for (const channel of this.channels.values()) {
      channel.sendVolatile(message);
    }
  }

  /** Send to one guest only (a `REJECT` goes to the guest whose proposal it refuses) */
  sendTo(seat: Seat, message: Envelope): void {
    this.channels.get(seat)?.send(message);
  }

  onMessage(listener: (message: Envelope) => void): Unsubscribe {
    this.listeners.add(listener);
    if (this.listeners.size === 1 && this.pending.length > 0) {
      const waiting = this.pending;
      this.pending = [];
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
      this.pending.push(message);
      return;
    }
    for (const listener of [...this.listeners]) {
      listener(message);
    }
  }
}
