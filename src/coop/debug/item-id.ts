/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ModifierTier } from "#enums/modifier-tier";

/**
 * How the host's debug menu (DECISIONS D42) names an exact item in its batches and its saved state: the key of the game's
 * item (`RARE_CANDY`), or, for a family the game picks from at random (evolution items, Mega Stones, TMs, berries...), the
 * family's key and which one: `EVOLUTION_ITEM:12`, `SPECIES_STAT_BOOSTER:LIGHT_BALL`. The part after the colon is what the
 * game's own item override passes to the family (`ModifierOverride.type`). A family's key alone lets the game pick.
 * @module
 */

export interface ParsedItemId {
  /** The key of the game's item, or of its family */
  key: string;
  /** Which one of the family: a number (a type, an item, a move...) or a name; `null`: the item itself, or the game picks */
  arg: number | string | null;
}

const ITEM_ID = /^([A-Z0-9_]{1,48})(?::(-?\d{1,6}|[A-Z][A-Z0-9_]{0,39}))?$/;

/** @returns The id of an item: its key, and which one of its family if the family has a choice */
export function itemId(key: string, arg: number | string | null = null): string {
  return arg === null ? key : `${key}:${arg}`;
}

/** @returns The key and the choice of an item id, or `null` if it is not one */
export function parseItemId(value: unknown): ParsedItemId | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = ITEM_ID.exec(value);
  if (match === null) {
    return null;
  }
  const [, key, arg] = match;
  if (arg === undefined) {
    return { key, arg: null };
  }
  return { key, arg: /^-?\d+$/.test(arg) ? Number(arg) : arg };
}

export function isItemId(value: unknown): value is string {
  return parseItemId(value) !== null;
}

/**
 * A tier pick: the reward screen rolls one item of that tier for its place, as the game rolls a tier-locked option
 * (`debug/rewards.ts`). Named `TIER:<tier>`, from the rarest; it is no item of its own (none to give).
 */
export const TIER_KEY = "TIER";
export const TIER_PICKS = ["MASTER", "ROGUE", "ULTRA", "GREAT", "COMMON"] as const;
export type TierPick = (typeof TIER_PICKS)[number];

/** @returns The tier a tier pick rolls from; `null` for any other id */
export function tierOfItem(id: string): ModifierTier | null {
  const item = parseItemId(id);
  if (item?.key !== TIER_KEY || !(TIER_PICKS as readonly unknown[]).includes(item.arg)) {
    return null;
  }
  return ModifierTier[item.arg as TierPick];
}
