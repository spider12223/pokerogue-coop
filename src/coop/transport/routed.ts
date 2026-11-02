/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Seat } from "#coop/protocol";
import type { CloseInfo, RawTransport, Unsubscribe } from "#coop/transport/transport";

/**
 * The host's side of a room of three (DECISIONS D40): the relay's one connection split into one channel per guest. In such a
 * room the host's frames start with the guest they are for and {@linkcode ROUTE_SEPARATOR}, and what the relay hands the host
 * starts with the guest who sent it. The format is `coop-server/src/relay-protocol.ts`'s (`routedFrame`, `parseRouted`);
 * `test/coop/relay-stack.test.ts` runs both against each other.
 * @module
 */

export const ROUTE_SEPARATOR = "\n";

/** One guest's channel: what it sends goes to that guest, what it hears came from that guest */
class GuestChannel implements RawTransport {
  private open = true;
  private readonly frameListeners = new Set<(frame: string) => void>();
  private readonly closeListeners = new Set<(info: CloseInfo) => void>();

  constructor(
    private readonly seat: Seat,
    private readonly relay: RawTransport,
  ) {
    relay.onClose(info => this.shutdown(info));
  }

  get isOpen(): boolean {
    return this.open && this.relay.isOpen;
  }

  send(frame: string): void {
    if (!this.open) {
      throw new Error(`the channel to ${this.seat} is closed`);
    }
    this.relay.send(this.seat + ROUTE_SEPARATOR + frame);
  }

  onFrame(listener: (frame: string) => void): Unsubscribe {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  onClose(listener: (info: CloseInfo) => void): Unsubscribe {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  /** Closes this guest's channel only: the relay connection and the other guest's channel go on */
  close(code?: number, reason?: string): void {
    const info: CloseInfo = {};
    if (code !== undefined) {
      info.code = code;
    }
    if (reason !== undefined) {
      info.reason = reason;
    }
    this.shutdown(info);
  }

  /** A frame the relay said came from this guest */
  receive(frame: string): void {
    if (!this.open) {
      return;
    }
    for (const listener of [...this.frameListeners]) {
      listener(frame);
    }
  }

  private shutdown(info: CloseInfo): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    for (const listener of [...this.closeListeners]) {
      listener(info);
    }
  }
}

export class RoutedHub {
  private readonly channels = new Map<Seat, GuestChannel>();

  /**
   * @param relay - The host's connection to a room of three
   * @param guests - The guest seats of the room
   */
  constructor(
    private readonly relay: RawTransport,
    guests: readonly Seat[],
  ) {
    for (const seat of guests) {
      this.channels.set(seat, new GuestChannel(seat, relay));
    }
    relay.onFrame(frame => {
      const at = frame.indexOf(ROUTE_SEPARATOR);
      if (at <= 0) {
        return; // names no guest
      }
      this.channels.get(frame.slice(0, at) as Seat)?.receive(frame.slice(at + ROUTE_SEPARATOR.length));
    });
  }

  /**
   * A new channel for a seat whose player left before the game began, for the next one to take it (D40); the old channel
   * is closed
   * @throws If `seat` is not a guest seat of the room
   */
  reopen(seat: Seat): RawTransport {
    const old = this.channels.get(seat);
    if (old === undefined) {
      throw new RangeError(`${seat} is not a guest of this room`);
    }
    old.close();
    const channel = new GuestChannel(seat, this.relay);
    this.channels.set(seat, channel);
    return channel;
  }

  /** @throws If `seat` is not a guest seat of the room */
  channel(seat: Seat): RawTransport {
    const channel = this.channels.get(seat);
    if (channel === undefined) {
      throw new RangeError(`${seat} is not a guest of this room`);
    }
    return channel;
  }
}
