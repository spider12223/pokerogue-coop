/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * A player's collection as it goes over the wire (DECISIONS D32): what the partner's starter select needs of it to show
 * the Pokémon of both players. Plain JSON (no bigint), and no game imports, so the protocol can validate it.
 *
 * The code that fills it and merges it into the starter select is `src/coop/shared-collection.ts`.
 *
 * @module
 */

/** A caught species of the dex */
export interface CollectionDexEntry {
  /** `caughtAttr`, as a decimal string */
  caught: string;
  /** `seenAttr`, as a decimal string */
  seen: string;
  /** `natureAttr` */
  natures: number;
  /** The best IVs */
  ivs: number[];
}

/** A starter species with something unlocked */
export interface CollectionStarterEntry {
  abilities: number;
  passive: number;
  /** `valueReduction` */
  reduction: number;
  eggMoves: number;
  /** `classicWinCount` */
  wins: number;
}

export interface CollectionData {
  /** Species id → entry, only for caught species */
  dex: Record<number, CollectionDexEntry>;
  /** Starter species id → entry, only for starters with something unlocked */
  starters: Record<number, CollectionStarterEntry>;
}

/** More than every species of the game, so that a forged collection cannot be huge */
const MAX_ENTRIES = 5000;

const isCount = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;

const isAttr = (value: unknown): boolean => typeof value === "string" && /^\d{1,40}$/.test(value);

function isEntries(value: unknown, check: (entry: Record<string, unknown>) => boolean): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_ENTRIES
    && entries.every(
      ([key, entry]) =>
        Number.isSafeInteger(Number(key))
        && typeof entry === "object"
        && entry !== null
        && check(entry as Record<string, unknown>),
    )
  );
}

export function isCollectionData(value: unknown): value is CollectionData {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const collection = value as Record<string, unknown>;
  return (
    isEntries(
      collection["dex"],
      entry =>
        isAttr(entry["caught"])
        && isAttr(entry["seen"])
        && isCount(entry["natures"])
        && Array.isArray(entry["ivs"])
        && entry["ivs"].length === 6
        && entry["ivs"].every(iv => isCount(iv) && iv <= 31),
    )
    && isEntries(collection["starters"], entry =>
      ["abilities", "passive", "reduction", "eggMoves", "wins"].every(field => isCount(entry[field])),
    )
  );
}
