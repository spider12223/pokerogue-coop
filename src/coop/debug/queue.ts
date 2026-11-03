/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { type DebugAction, type DebugBatch, MAX_DEBUG_ACTIONS } from "#coop/debug/actions";

/**
 * The host's cheats that wait to be sent, and what became of them: the debug window's change log (DECISIONS D42). The
 * window adds changes to it; each turn's command sync takes what waits (its `DEBUG` key is always sent, empty or not), and
 * an open reward screen sends at once through its sink. A change is pending until it is sent, then applied once the batch
 * that carries it is carried out on the host.
 * @module
 */

/** Where a batch took effect: a turn of a wave, or a reward screen (`turn: null`) */
export interface DebugWhere {
  wave: number;
  turn: number | null;
}

export type DebugChangeState = "pending" | "sent" | "applied";

/** One change of the host's: what the window says about it, and the actions that make it */
export interface DebugChange {
  readonly id: number;
  readonly actions: readonly DebugAction[];
  readonly note: string;
  /** A pending change to the same thing (a Pokémon's level, the money) gives way to a newer one; `null`: never */
  readonly key: string | null;
  state: DebugChangeState;
  /** Where it took effect, once applied */
  where: DebugWhere | null;
}

/** How many applied changes the log keeps */
const KEPT_APPLIED = 40;

let changes: DebugChange[] = [];
/** The batches sent and not yet carried out: their changes, oldest first */
let inFlight: { json: string; ids: number[] }[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
/** The open step of a reward screen, which sends a batch at once; `false` if it could not */
let sink: ((batch: DebugBatch) => boolean) | null = null;

function changed(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

const pending = (): DebugChange[] => changes.filter(change => change.state === "pending");

/** @returns The cheats that wait, oldest first */
export function waitingDebug(): readonly DebugAction[] {
  return pending().flatMap(change => change.actions);
}

/** @returns Every change of the log: what waits, what was sent, the last ones applied; oldest first */
export function debugChanges(): readonly DebugChange[] {
  return changes;
}

/** @returns Whether a reward screen would send a cheat at once */
export function debugSendsNow(): boolean {
  return sink !== null;
}

/** Add cheats to send, with nothing to say about them; on a reward screen they go at once */
export function queueDebug(...actions: DebugAction[]): void {
  queueDebugChange("", null, ...actions);
}

/**
 * Add a change to send; on a reward screen it goes at once.
 * @param note - What the window says about it
 * @param key - A pending change with the same key is replaced by this one; `null`: none is
 * @returns The change
 */
export function queueDebugChange(note: string, key: string | null, ...actions: DebugAction[]): DebugChange {
  if (key !== null) {
    changes = changes.filter(change => change.state !== "pending" || change.key !== key);
  }
  const change: DebugChange = { id: nextId++, actions, note, key, state: "pending", where: null };
  changes.push(change);
  changed();
  flushDebug();
  return change;
}

/** @returns Whether the change was still pending and is now dropped */
export function cancelDebugChange(id: number): boolean {
  const index = changes.findIndex(change => change.id === id && change.state === "pending");
  if (index < 0) {
    return false;
  }
  changes.splice(index, 1);
  changed();
  return true;
}

/** @returns The batch of what waits (whole changes, at most {@linkcode MAX_DEBUG_ACTIONS} actions), now sent */
export function takeDebugBatch(): DebugBatch {
  const taken: DebugChange[] = [];
  let count = 0;
  for (const change of pending()) {
    if (count + change.actions.length > MAX_DEBUG_ACTIONS && taken.length > 0) {
      break;
    }
    taken.push(change);
    count += change.actions.length;
  }
  const actions = taken.flatMap(change => change.actions).slice(0, MAX_DEBUG_ACTIONS);
  if (taken.length > 0) {
    for (const change of taken) {
      change.state = "sent";
    }
    inFlight.push({ json: JSON.stringify(actions), ids: taken.map(change => change.id) });
    changed();
  }
  return { actions };
}

/** Put a batch that could not be sent back at the front */
export function requeueDebug(batch: DebugBatch): void {
  const json = JSON.stringify(batch.actions);
  const index = inFlight.findIndex(sent => sent.json === json);
  if (index < 0) {
    // (not one of ours: its actions wait again, with nothing to say about them)
    const back = batch.actions.map(action => ({
      id: nextId++,
      actions: [action],
      note: "",
      key: null,
      state: "pending" as const,
      where: null,
    }));
    changes = [...back, ...changes];
  } else {
    const ids = inFlight[index].ids;
    inFlight.splice(index, 1);
    const back = changes.filter(change => ids.includes(change.id));
    for (const change of back) {
      change.state = "pending";
    }
    changes = [...back, ...changes.filter(change => !ids.includes(change.id))];
  }
  changed();
}

/**
 * The host carried out a batch: the changes it carried are applied.
 * @param batch - The batch, as it came back sequenced
 * @param where - Where it took effect
 */
export function debugBatchApplied(batch: DebugBatch, where: DebugWhere): void {
  const json = JSON.stringify(batch.actions);
  const index = inFlight.findIndex(sent => sent.json === json);
  if (index < 0) {
    return;
  }
  const ids = inFlight[index].ids;
  inFlight.splice(index, 1);
  const applied: DebugChange[] = [];
  for (const change of changes) {
    if (ids.includes(change.id)) {
      change.state = "applied";
      change.where = where;
      applied.push(change);
    }
  }
  // The log shows the newest applied changes last; the oldest are forgotten
  changes = [...changes.filter(change => !ids.includes(change.id)), ...applied];
  const old = changes.filter(change => change.state === "applied").length - KEPT_APPLIED;
  if (old > 0) {
    let dropped = 0;
    changes = changes.filter(change => change.state !== "applied" || dropped++ >= old);
  }
  changed();
}

/** Forget every change (the run ended, or the host cleared it) */
export function clearDebugQueue(): void {
  changes = [];
  inFlight = [];
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
  if (sink === null || pending().length === 0) {
    return;
  }
  const batch = takeDebugBatch();
  if (!sink(batch)) {
    requeueDebug(batch);
  }
}
