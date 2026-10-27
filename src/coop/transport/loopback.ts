/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Idea (an in-process transport pair for tests) from SunghoLee98/pokerogue `src/coop/loopback-transport.ts`
 * (AGPL-3.0-only); this version adds seeded loss, duplication and reordering.
 */

import type { CloseInfo, RawTransport, Scheduler, Unsubscribe } from "#coop/transport/transport";
import { systemScheduler } from "#coop/transport/transport";

export interface LoopbackOptions {
  /** Probability in [0, 1] that a frame is lost. Default 0. */
  dropRate?: number;
  /** Probability that a frame is delivered twice. Default 0. */
  duplicateRate?: number;
  /** Probability that a frame is held back by a random delay, so later frames overtake it. Default 0. */
  reorderRate?: number;
  /** Longest extra delay of a reordered frame, in ms. Default 20. */
  maxReorderDelayMs?: number;
  /** Seed of the pseudo-random generator, so a failing run can be replayed. Default 1. */
  seed?: number;
  /** Used for the delay of reordered frames. Default: real timers. */
  scheduler?: Scheduler;
}

/** mulberry32: a small seeded PRNG returning floats in [0, 1). */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class LoopbackEnd implements RawTransport {
  peer: LoopbackEnd | null = null;
  private open = true;
  private readonly frameListeners = new Set<(frame: string) => void>();
  private readonly closeListeners = new Set<(info: CloseInfo) => void>();
  private readonly options: Required<Omit<LoopbackOptions, "seed">>;
  private readonly rng: () => number;

  constructor(options: LoopbackOptions, rng: () => number) {
    this.options = {
      dropRate: options.dropRate ?? 0,
      duplicateRate: options.duplicateRate ?? 0,
      reorderRate: options.reorderRate ?? 0,
      maxReorderDelayMs: options.maxReorderDelayMs ?? 20,
      scheduler: options.scheduler ?? systemScheduler,
    };
    this.rng = rng;
  }

  get isOpen(): boolean {
    return this.open;
  }

  send(frame: string): void {
    if (!this.open) {
      throw new Error("loopback transport is closed");
    }
    const peer = this.peer;
    if (!peer) {
      return;
    }
    if (this.rng() < this.options.dropRate) {
      return;
    }
    const copies = this.rng() < this.options.duplicateRate ? 2 : 1;
    for (let i = 0; i < copies; i++) {
      if (this.rng() < this.options.reorderRate) {
        const delay = 1 + Math.floor(this.rng() * this.options.maxReorderDelayMs);
        this.options.scheduler.setTimeout(() => peer.receive(frame), delay);
      } else {
        queueMicrotask(() => peer.receive(frame));
      }
    }
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

  close(code?: number, reason?: string): void {
    const info: CloseInfo = {};
    if (code !== undefined) {
      info.code = code;
    }
    if (reason !== undefined) {
      info.reason = reason;
    }
    this.shutdown(info);
    this.peer?.shutdown(info);
  }

  private receive(frame: string): void {
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

/**
 * Two connected in-process transports for tests. Frames cross as strings, like on the wire. Loss, duplication and
 * reordering are seeded, so a failing run can be replayed with the same `seed`.
 * Closing one end closes the other.
 */
export function createLoopbackPair(options: LoopbackOptions = {}): [RawTransport, RawTransport] {
  const rng = createRng(options.seed ?? 1);
  const a = new LoopbackEnd(options, rng);
  const b = new LoopbackEnd(options, rng);
  a.peer = b;
  b.peer = a;
  return [a, b];
}
