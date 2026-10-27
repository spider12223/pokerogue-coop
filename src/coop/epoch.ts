/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Envelope, MessageKind } from "#coop/protocol";
import type { MessageTransport, Unsubscribe } from "#coop/transport/transport";

/**
 * Epochs (DECISIONS D18). The host increments the epoch each time both clients reload the run (a resync, a rejoin, a
 * resume). Everything a client sends carries the epoch it is in, and a message of an older epoch is dropped: it was made
 * for a world that no longer exists (a proposal for a window that was closed by the reload, a checkpoint of the old
 * simulation).
 *
 * No game imports.
 *
 * @module
 */

/**
 * Whatever was waiting for a decision when the run was reloaded gets this. It is not a failure: the game ignores it, and the
 * phase that awaited the decision is gone with the rest of the old world.
 */
export class EpochChangedError extends Error {
  constructor(message = "the run was reloaded") {
    super(message);
    this.name = "EpochChangedError";
  }
}

/** The kinds a message of another epoch than the receiver's must never reach the simulation with */
const GUARDED_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>([
  "PROPOSE",
  "SEQUENCED",
  "REJECT",
  "CHECKPOINT",
  "COSMETIC",
  "RESYNC_REQUEST",
  "REPORT",
]);

/** What an {@linkcode EpochTransport} did with the messages it was given */
export interface EpochStats {
  /** Messages of an older epoch than the transport's, dropped */
  droppedOlder: number;
  /** Messages of a newer epoch that waited for the transport to get there */
  heldNewer: number;
  /** Of those, the ones that were handed on once it did (the rest were passed by a later epoch) */
  releasedNewer: number;
}

/**
 * The part of the reliable channel an epoch transport needs: what the sequencer talks to, and the volatile frames (a
 * transport without them sends those as ordinary messages)
 */
export interface EpochInner extends MessageTransport {
  sendVolatile?(message: Envelope): void;
}

/**
 * Stamps the epoch on every envelope it sends and keeps the ones that arrive from the wrong epoch out of the simulation (D18):
 * - older than the local epoch: dropped;
 * - newer than the local epoch: held until the local epoch gets there, which happens when the client applies the `RESYNC`
 *   that brings it (the host may already be in its new world and send decisions of it while the guest is still finishing the
 *   old one); a cosmetic message of a newer epoch is dropped, it does not matter;
 * - the `RESYNC` of a newer epoch always comes through: it is how the epoch arrives;
 * - the handshake, the lobby and `START` are epoch 0 and are never guarded.
 */
export class EpochTransport implements EpochInner {
  readonly stats: EpochStats = { droppedOlder: 0, heldNewer: 0, releasedNewer: 0 };
  private current = 0;
  private readonly listeners = new Set<(message: Envelope) => void>();
  private innerStop: Unsubscribe | null = null;
  private held: Envelope[] = [];

  constructor(private readonly inner: EpochInner) {}

  /** The epoch this end is in */
  get epoch(): number {
    return this.current;
  }

  /**
   * Move to a later epoch; what was held for it is handed on, in the order it arrived. An epoch never goes back.
   * @throws If `epoch` is not an integer of at least the current one
   */
  setEpoch(epoch: number): void {
    if (!Number.isInteger(epoch) || epoch < this.current) {
      throw new RangeError(`epoch ${epoch} is not after ${this.current}`);
    }
    this.current = epoch;
    const waiting = this.held;
    this.held = [];
    for (const message of waiting) {
      const messageEpoch = message.epoch ?? 0;
      if (messageEpoch === this.current) {
        this.stats.releasedNewer++;
        this.dispatch(message);
      } else if (messageEpoch > this.current) {
        this.held.push(message);
      } else {
        this.stats.droppedOlder++;
      }
    }
  }

  /** How many messages of a newer epoch are waiting */
  get heldCount(): number {
    return this.held.length;
  }

  send(message: Envelope): void {
    this.inner.send({ ...message, epoch: this.current });
  }

  sendVolatile(message: Envelope): void {
    const stamped = { ...message, epoch: this.current };
    if (this.inner.sendVolatile === undefined) {
      this.inner.send(stamped);
    } else {
      this.inner.sendVolatile(stamped);
    }
  }

  /** Send a message that brings a newer epoch (the host's `RESYNC`): it carries that epoch, not the current one */
  sendAt(epoch: number, message: Envelope): void {
    this.inner.send({ ...message, epoch });
  }

  onMessage(listener: (message: Envelope) => void): Unsubscribe {
    this.listeners.add(listener);
    // One subscription to the channel below, shared: a message held back is handed to every listener at once
    this.innerStop ??= this.inner.onMessage(message => this.receive(message));
    return () => {
      this.listeners.delete(listener);
    };
  }

  private receive(message: Envelope): void {
    const epoch = message.epoch ?? 0;
    if (message.kind === "RESYNC") {
      // The reload that starts the next epoch; one that is not newer than the local epoch is a leftover
      if (epoch <= this.current) {
        this.stats.droppedOlder++;
      } else {
        this.dispatch(message);
      }
      return;
    }
    if (!GUARDED_KINDS.has(message.kind) || epoch === this.current) {
      this.dispatch(message);
    } else if (epoch < this.current) {
      this.stats.droppedOlder++;
    } else if (message.kind !== "COSMETIC") {
      this.stats.heldNewer++;
      this.held.push(message);
    }
  }

  private dispatch(message: Envelope): void {
    for (const listener of [...this.listeners]) {
      listener(message);
    }
  }
}
