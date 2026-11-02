/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { type DebugAction, type DebugBatch, MAX_DEBUG_ACTIONS } from "#coop/debug/actions";

/**
 * The host's cheats that wait to be sent (DECISIONS D42). The panel adds to it; each turn's command sync takes what waits
 * (its `DEBUG` key is always sent, empty or not), and an open reward screen sends at once through its sink.
 * @module
 */

let waiting: DebugAction[] = [];
const listeners = new Set<() => void>();
/** The open step of a reward screen, which sends a batch at once; `false` if it could not */
let sink: ((batch: DebugBatch) => boolean) | null = null;

function changed(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

/** @returns The cheats that wait, oldest first */
export function waitingDebug(): readonly DebugAction[] {
  return waiting;
}

/** @returns Whether a reward screen would send a cheat at once */
export function debugSendsNow(): boolean {
  return sink !== null;
}

/** Add cheats to send; on a reward screen they go at once */
export function queueDebug(...actions: DebugAction[]): void {
  waiting.push(...actions);
  changed();
  flushDebug();
}

/** @returns The batch of what waits (at most {@linkcode MAX_DEBUG_ACTIONS}), taken out of the queue */
export function takeDebugBatch(): DebugBatch {
  const actions = waiting.slice(0, MAX_DEBUG_ACTIONS);
  waiting = waiting.slice(actions.length);
  if (actions.length > 0) {
    changed();
  }
  return { actions };
}

/** Put a batch that could not be sent back at the front */
export function requeueDebug(batch: DebugBatch): void {
  waiting = [...batch.actions, ...waiting];
  changed();
}

/** Forget what waits (the run ended, or the host cleared it) */
export function clearDebugQueue(): void {
  waiting = [];
  changed();
}

/** @returns A function that stops the listener */
export function onDebugQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The open step of a reward screen takes batches at once (`null`: it closed) */
export function setDebugSink(next: ((batch: DebugBatch) => boolean) | null): void {
  sink = next;
  changed();
  flushDebug();
}

/** Send what waits through the sink, if there is one */
export function flushDebug(): void {
  if (sink === null || waiting.length === 0) {
    return;
  }
  const batch = takeDebugBatch();
  if (!sink(batch)) {
    requeueDebug(batch);
  }
}
