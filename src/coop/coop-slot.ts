/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { type CoopRunMode, isCoopRunMode, type Seat } from "#coop/protocol";
import type { KeyValueStore } from "#coop/seat-store";

/**
 * The co-op save slot of the host (DECISIONS D19): one entry under its own key, never a solo session slot. A linked run
 * writes it at the start of each wave; "Co-op, Continue" and a rejoin of a reloaded host read it.
 *
 * It holds the session save as the game wrote it (a JSON string, with the `coop` block of D4/D7), plus what a resume needs
 * and the save does not have: both display names, the last epoch and the last `seq` (D18).
 *
 * `Storage` is injected and the session stays a string: this module has no game imports and runs in plain Node.
 *
 * @module
 */

/** The key of the slot. It does not start with `sessionData`, so no solo slot, import or export ever meets it. */
export const COOP_SLOT_KEY = "coopSlot";

export const COOP_SLOT_VERSION = 1;

export interface CoopSlot {
  version: typeof COOP_SLOT_VERSION;
  /** When it was written, ms since the epoch (display only) */
  savedAt: number;
  /** The wave whose start this is */
  wave: number;
  /** The epoch the run was in when it was saved (D18) */
  epoch: number;
  /** The last `seq` the host had assigned (D18) */
  seq: number;
  names: Record<Seat, string>;
  /** `"trainerId:secretId"` of each account: the same two players only (D4, D21) */
  accountIds: Record<Seat, string>;
  /** The session save, `JSON.stringify`d */
  session: string;
  /** The kind of run (D39), for the title menu; a slot from before has none and is classic */
  runMode?: CoopRunMode;
}

export function isCoopSlot(value: unknown): value is CoopSlot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const slot = value as Record<string, unknown>;
  const pair = (record: unknown): boolean => {
    const seats = record as Record<string, unknown> | null;
    return (
      typeof seats === "object"
      && seats !== null
      && typeof seats["host"] === "string"
      && typeof seats["guest"] === "string"
    );
  };
  return (
    slot["version"] === COOP_SLOT_VERSION
    && typeof slot["savedAt"] === "number"
    && Number.isInteger(slot["wave"])
    && Number.isInteger(slot["epoch"])
    && (slot["epoch"] as number) >= 0
    && Number.isInteger(slot["seq"])
    && (slot["seq"] as number) >= 0
    && pair(slot["names"])
    && pair(slot["accountIds"])
    && typeof slot["session"] === "string"
    && slot["session"].length > 0
    && (slot["runMode"] === undefined || isCoopRunMode(slot["runMode"]))
  );
}

/**
 * Write the slot.
 * @returns Whether it was written (storage can be full)
 */
export function writeCoopSlot(store: KeyValueStore, slot: CoopSlot): boolean {
  try {
    store.setItem(COOP_SLOT_KEY, JSON.stringify(slot));
    return true;
  } catch {
    return false;
  }
}

/** @returns The slot, or `null` if there is none or it is damaged (a damaged one is removed) */
export function readCoopSlot(store: KeyValueStore): CoopSlot | null {
  try {
    const text = store.getItem(COOP_SLOT_KEY);
    // (a store that has none answers `null`; the mock of the tests answers `undefined`)
    if (text == null) {
      return null;
    }
    const parsed: unknown = JSON.parse(text);
    if (isCoopSlot(parsed)) {
      return parsed;
    }
    store.removeItem(COOP_SLOT_KEY);
  } catch {
    try {
      store.removeItem(COOP_SLOT_KEY);
    } catch {
      // nothing more to do
    }
  }
  return null;
}

/** The run is over (victory, game over): its slot goes. Leaving it behind would offer a finished run to continue. */
export function clearCoopSlot(store: KeyValueStore): void {
  try {
    store.removeItem(COOP_SLOT_KEY);
  } catch {
    // nothing to clear
  }
}
