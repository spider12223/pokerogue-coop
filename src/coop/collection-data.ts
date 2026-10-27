/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * A player's collection as it goes over the wire (DECISIONS D32): what the partner's starter select needs of it to show
 * the Pokémon of both players. Plain JSON (no bigint), and no game imports but a constant, so the protocol can validate it
 * in Node.
 *
 * The code that fills it and merges it into the starter select is `src/coop/shared-collection.ts`.
 *
 * @module
 */

import { VALUE_REDUCTION_MAX } from "#app/constants";

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

/**
 * The range of each field, as the game has them, so that a partner's collection cannot make the starter select loop or draw
 * what does not exist (the cost of a starter counts down its `valueReduction` one by one)
 */
export const COLLECTION_LIMITS = {
  /** `VALUE_REDUCTION_MAX` */
  reduction: VALUE_REDUCTION_MAX,
  /** `AbilityAttr`: the first, second and hidden ability */
  abilities: 0b111,
  /** `Passive`: unlocked and enabled */
  passive: 0b11,
  /** One bit per egg move: a species has four */
  eggMoves: 0b1111,
  /** A natures bit field: bit `nature + 1` for each of the 25 natures */
  natures: 2 ** 26 - 1,
  /** More classic wins than anyone has */
  wins: 1_000_000,
  /** `DexAttr`: seven bits of shininess, gender and variant, then one bit per form (far fewer than this) */
  attrBits: 64,
} as const;

const isUpTo = (value: unknown, max: number): boolean =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;

const isAttr = (value: unknown): boolean =>
  typeof value === "string" && /^\d{1,20}$/.test(value) && BigInt(value) < 2n ** BigInt(COLLECTION_LIMITS.attrBits);

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
        && isUpTo(entry["natures"], COLLECTION_LIMITS.natures)
        && Array.isArray(entry["ivs"])
        && entry["ivs"].length === 6
        && entry["ivs"].every(iv => isUpTo(iv, 31)),
    )
    && isEntries(collection["starters"], entry =>
      (["abilities", "passive", "reduction", "eggMoves", "wins"] as const).every(field =>
        isUpTo(entry[field], COLLECTION_LIMITS[field]),
      ),
    )
  );
}
