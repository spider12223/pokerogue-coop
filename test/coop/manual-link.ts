/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Envelope } from "#coop/protocol";
import type { MessageTransport, Unsubscribe } from "#coop/transport/transport";

/**
 * One end of a {@linkcode createManualLink}: `send` only records the message; the test decides when, in which order
 * and how often the other end receives it. Like the real transports it keeps messages that arrive while nobody listens.
 */
export class ManualEnd implements MessageTransport {
  /** Everything this end sent and the other end has not received yet */
  readonly outbox: Envelope[] = [];
  peer!: ManualEnd;

  private readonly listeners = new Set<(message: Envelope) => void>();
  private readonly early: Envelope[] = [];

  send(message: Envelope): void {
    // The wire serializes: the receiver must never share objects with the sender.
    this.outbox.push(JSON.parse(JSON.stringify(message)) as Envelope);
  }

  onMessage(listener: (message: Envelope) => void): Unsubscribe {
    this.listeners.add(listener);
    for (const message of this.early.splice(0)) {
      listener(message);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Hand one message to this end's listeners (as if it came from the other end). */
  receive(message: Envelope): void {
    if (this.listeners.size === 0) {
      this.early.push(message);
      return;
    }
    for (const listener of [...this.listeners]) {
      listener(message);
    }
  }

  /**
   * Deliver the other end's pending messages to this end.
   * @param pick - Which of the pending messages to deliver, in which order; default all, in order
   * @param keep - Leave the delivered messages pending (to deliver them again)
   */
  deliverFromPeer(pick: (pending: readonly Envelope[]) => Envelope[] = pending => [...pending], keep = false): void {
    const pending = this.peer.outbox;
    const chosen = pick(pending);
    if (!keep) {
      this.peer.outbox.splice(0);
    }
    for (const message of chosen) {
      this.receive(message);
    }
  }
}

/** Two {@linkcode ManualEnd}s: `host` and `guest`. */
export function createManualLink(): { host: ManualEnd; guest: ManualEnd } {
  const host = new ManualEnd();
  const guest = new ManualEnd();
  host.peer = guest;
  guest.peer = host;
  return { host, guest };
}

/** Let promise continuations run. */
export function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
