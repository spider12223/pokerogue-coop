/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Seat } from "#coop/protocol";

/**
 * The account data the simulation reads (DECISIONS D4), frozen at run start. During co-op the
 * simulation never reads the live `gameData`: two accounts have different TID/SID, dex and unlocks, so reading them
 * live makes the two clients simulate different games.
 *
 * Plain JSON (no bigint, no Map) so it can be sent in `START` and stored in the co-op save block.
 *
 * This module has no game imports; the code that fills and reads it is `src/coop/sim-account.ts`.
 *
 * @module
 */

export interface AccountSnapshot {
  /** `gameData.trainerId` */
  trainerId: number;
  /** `gameData.secretId` */
  secretId: number;
  /** `gameData.isUnlocked(...)`, overrides included, for the unlockables the simulation reads (the reward pools) */
  unlocked: { eviolite: boolean; miniBlackHole: boolean };
  /**
   * `dexData[species].caughtAttr` as a decimal string, only for species with a non-zero value (`BigInt` is not JSON).
   * The number of keys is the dex count of `getSpeciesCount(d => !!d.caughtAttr)`.
   */
  caught: Record<number, string>;
  /** `starterData[rootSpecies].eggMoves`, only non-zero values */
  eggMoves: Record<number, number>;
}

/** Both players' accounts. Which of the two a read uses is the host-or-owner rule of D4. */
export type CoopAccountSnapshot = Record<Seat, AccountSnapshot>;

function isRecordOf(value: unknown, check: (entry: unknown) => boolean): boolean {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.entries(value).every(([key, entry]) => Number.isInteger(Number(key)) && check(entry))
  );
}

export function isAccountSnapshot(value: unknown): value is AccountSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const snapshot = value as Record<string, unknown>;
  const unlocked = snapshot["unlocked"] as Record<string, unknown> | null;
  return (
    Number.isInteger(snapshot["trainerId"])
    && Number.isInteger(snapshot["secretId"])
    && typeof unlocked === "object"
    && unlocked !== null
    && typeof unlocked["eviolite"] === "boolean"
    && typeof unlocked["miniBlackHole"] === "boolean"
    && isRecordOf(snapshot["caught"], entry => typeof entry === "string" && /^\d+$/.test(entry) && entry !== "0")
    && isRecordOf(snapshot["eggMoves"], entry => Number.isInteger(entry) && (entry as number) > 0)
  );
}

export function isCoopAccountSnapshot(value: unknown): value is CoopAccountSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const snapshots = value as Record<string, unknown>;
  return isAccountSnapshot(snapshots["host"]) && isAccountSnapshot(snapshots["guest"]);
}
