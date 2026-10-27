/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Scheduler } from "#coop/transport/transport";

/** A virtual clock: timers fire when {@linkcode advance} passes them, in order. */
export class FakeScheduler implements Scheduler {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  public now(): number {
    return this.time;
  }

  public setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  }

  public clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** How many timers are waiting */
  public get pending(): number {
    return this.timers.size;
  }

  /** Move the clock forward, firing every timer that comes due on the way */
  public advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let due: [number, { at: number; callback: () => void }] | null = null;
      for (const entry of this.timers) {
        if (entry[1].at <= target && (due === null || entry[1].at < due[1].at)) {
          due = entry;
        }
      }
      if (due === null) {
        break;
      }
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].callback();
    }
    this.time = target;
  }
}
