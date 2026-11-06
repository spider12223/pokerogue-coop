/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  type CoopChallenge,
  type CoopRunMode,
  isCoopChallenges,
  isCoopRunMode,
  type PlayerCount,
  type SeatRecord,
} from "#coop/protocol";
import type { KeyValueStore } from "#coop/save/seat-store";

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

/** How many co-op save files a browser keeps for the runs it hosts (D19, amended): as many as the solo slots */
export const COOP_SLOT_FILES = 5;

/** Whether `file` is one of the co-op save files, `1` to {@linkcode COOP_SLOT_FILES} */
export function isCoopFile(file: unknown): file is number {
  return Number.isInteger(file) && (file as number) >= 1 && (file as number) <= COOP_SLOT_FILES;
}

/**
 * The storage key of a co-op save file. The first keeps the key of the one slot there was, so a run saved before there
 * were files is file 1 (and a build from before still finds it).
 * @throws `RangeError` for a file that is not one of them
 */
export function coopSlotKey(file: number): string {
  if (!isCoopFile(file)) {
    throw new RangeError(`co-op: there is no save file ${file}`);
  }
  return file === 1 ? COOP_SLOT_KEY : `${COOP_SLOT_KEY}${file}`;
}

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
  names: SeatRecord<string>;
  /** `"trainerId:secretId"` of each account: the same two players only (D4, D21) */
  accountIds: SeatRecord<string>;
  /** The session save, `JSON.stringify`d */
  session: string;
  /** The kind of run (D39), for the title menu; a slot from before has none and is classic */
  runMode?: CoopRunMode;
  /** A challenge run's challenges (D41), for the partner's handshake when the run is continued */
  challenges?: CoopChallenge[];
  /** How many played when it was saved (D40); a run of three has the third seat's name and account. Default 2 */
  players?: PlayerCount;
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
    // A challenge run has its challenges, and no other run has any (D41)
    && (slot["runMode"] === "challenge" ? isCoopChallenges(slot["challenges"]) : slot["challenges"] === undefined)
    && (slot["players"] === undefined || slot["players"] === 2 || slot["players"] === 3)
  );
}

/**
 * Write the slot into a save file.
 * @returns Whether it was written (storage can be full)
 */
export function writeCoopSlot(store: KeyValueStore, slot: CoopSlot, file: number): boolean {
  const key = coopSlotKey(file);
  try {
    store.setItem(key, JSON.stringify(slot));
    return true;
  } catch {
    return false;
  }
}

/** @returns The slot of a save file, or `null` if there is none or it is damaged (a damaged one is removed) */
export function readCoopSlot(store: KeyValueStore, file: number): CoopSlot | null {
  const key = coopSlotKey(file);
  try {
    const text = store.getItem(key);
    // (a store that has none answers `null`; the mock of the tests answers `undefined`)
    if (text == null) {
      return null;
    }
    const parsed: unknown = JSON.parse(text);
    if (isCoopSlot(parsed)) {
      return parsed;
    }
    store.removeItem(key);
  } catch {
    try {
      store.removeItem(key);
    } catch {
      // nothing more to do
    }
  }
  return null;
}

/** @returns Every save file's slot, file 1 first: `null` for an empty (or damaged) one */
export function readCoopSlots(store: KeyValueStore): (CoopSlot | null)[] {
  return Array.from({ length: COOP_SLOT_FILES }, (_, i) => readCoopSlot(store, i + 1));
}

/** @returns The first save file with no run in it, or `null` if every one has one */
export function firstFreeCoopFile(store: KeyValueStore): number | null {
  const index = readCoopSlots(store).indexOf(null);
  return index === -1 ? null : index + 1;
}

/**
 * The run of a save file is over (victory, game over) or deleted: it goes. Leaving it behind would offer a finished run to
 * continue.
 */
export function clearCoopSlot(store: KeyValueStore, file: number): void {
  const key = coopSlotKey(file);
  try {
    store.removeItem(key);
  } catch {
    // nothing to clear
  }
}
