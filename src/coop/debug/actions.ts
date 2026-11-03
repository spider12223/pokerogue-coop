/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  type DebugModes,
  isRewardNames,
  isWavePlan,
  MAX_LEVEL,
  MAX_MULTIPLIER,
  type WavePlan,
} from "#coop/debug/state";
import type { Seat } from "#coop/protocol";

/**
 * The cheats of the host's debug menu (DECISIONS D42), as they travel: a batch of actions in one sequenced `DEBUG` decision
 * of the host. Every client applies the same batch at the same point. The host chose every value before sending (the
 * random ones too: a seed), so nothing in an action depends on a client's own state.
 * - `p`: a Pokémon of the party, by `pokemon.id`
 * - `e`: an enemy on the field, by its field index; `null`: every enemy
 * @module
 */
export type DebugAction =
  // the party
  | { t: "level"; p: number; v: number }
  | { t: "ivs"; p: number; v: number[] }
  | { t: "nature"; p: number; v: number }
  | { t: "ability"; p: number; v: number }
  | { t: "passive"; p: number; v: number }
  | { t: "friendship"; p: number; v: number }
  | { t: "species"; p: number; v: number; form: number }
  | { t: "fusion"; p: number; v: number; form: number }
  | { t: "shiny"; p: number; shiny: boolean; variant: number }
  | { t: "gender"; p: number; v: number }
  | { t: "tera"; p: number; v: number }
  | { t: "move"; p: number; slot: number; v: number }
  | { t: "item"; p: number | null; item: string; count: number }
  // a held item taken away: the one at `index` of the Pokémon's held items, if it is still of the item `key`
  | { t: "drop"; p: number; index: number; key: string }
  | { t: "heal"; p: number | null }
  | {
      t: "add";
      seat: Seat;
      species: number;
      form: number;
      level: number;
      shiny: boolean;
      variant: number;
      seed: number;
    }
  | { t: "remove"; p: number }
  | { t: "owner"; p: number; seat: Seat }
  // the bag
  | { t: "money"; v: number }
  | { t: "balls"; ball: number; v: number }
  // later waves
  | { t: "plan"; wave: number; plan: WavePlan | null }
  | { t: "rewards"; items: string[] | null }
  | { t: "jump"; v: number | null }
  | { t: "biome"; v: number | null }
  | { t: "mode"; mode: keyof DebugModes; v: number | boolean }
  // the battle
  | { t: "weather"; v: number }
  | { t: "terrain"; v: number }
  | { t: "enemy"; e: number | null; what: "faint" | "hp1" | "heal" | "level"; v: number }
  | { t: "stages"; side: "party" | "enemy"; v: number }
  | { t: "status"; side: "party" | "enemy"; v: number }
  | { t: "win" }
  // for fun
  | { t: "allShiny" }
  | { t: "randomize"; seed: number };

export interface DebugBatch {
  actions: DebugAction[];
}

export type DebugActionType = DebugAction["t"];

/** The most actions one batch carries */
export const MAX_DEBUG_ACTIONS = 64;

const SEATS: readonly Seat[] = ["host", "guest", "guest2"];

const isInt = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

const isId = (value: unknown): value is number => isInt(value, 0, 4_294_967_295);
const isIdOrNull = (value: unknown): boolean => value === null || isId(value);
const isSeat = (value: unknown): value is Seat => SEATS.includes(value as Seat);
const isSide = (value: unknown): boolean => value === "party" || value === "enemy";
const isItemName = (value: unknown): value is string => isRewardNames([value]);

const MODE_FLAGS: readonly string[] = ["freeShop", "freeRerolls", "noDamage", "oneHit", "shinyEnemies"];
const MODE_NUMBERS: Readonly<Record<string, [number, number]>> = {
  exp: [1, MAX_MULTIPLIER],
  money: [1, MAX_MULTIPLIER],
  enemyLevel: [0, MAX_LEVEL],
};

/** @returns Whether `value` is an action of the menu, with every value in its range */
export function isDebugAction(value: unknown): value is DebugAction {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const a = value as Record<string, unknown>;
  switch (a["t"]) {
    case "level":
      return isId(a["p"]) && isInt(a["v"], 1, MAX_LEVEL);
    case "ivs":
      return isId(a["p"]) && Array.isArray(a["v"]) && a["v"].length === 6 && a["v"].every(iv => isInt(iv, 0, 31));
    case "nature":
      return isId(a["p"]) && isInt(a["v"], 0, 24);
    case "ability":
    case "passive":
      // 0: the Pokémon's own
      return isId(a["p"]) && isInt(a["v"], 0, 10_000);
    case "friendship":
      return isId(a["p"]) && isInt(a["v"], 0, 255);
    case "species":
      return isId(a["p"]) && isInt(a["v"], 1, 100_000) && isInt(a["form"], 0, 100);
    case "fusion":
      // 0: no fusion
      return isId(a["p"]) && isInt(a["v"], 0, 100_000) && isInt(a["form"], 0, 100);
    case "shiny":
      return isId(a["p"]) && typeof a["shiny"] === "boolean" && isInt(a["variant"], 0, 2);
    case "gender":
      return isId(a["p"]) && isInt(a["v"], -1, 1);
    case "tera":
      return isId(a["p"]) && isInt(a["v"], 0, 18);
    case "move":
      // 0: forget the move of that slot
      return isId(a["p"]) && isInt(a["slot"], 0, 3) && isInt(a["v"], 0, 10_000);
    case "item":
      return isIdOrNull(a["p"]) && isItemName(a["item"]) && isInt(a["count"], 1, 99);
    case "drop":
      return (
        isId(a["p"]) && isInt(a["index"], 0, 500) && typeof a["key"] === "string" && /^[A-Z0-9_]{1,48}$/.test(a["key"])
      );
    case "heal":
      return isIdOrNull(a["p"]);
    case "add":
      return (
        isSeat(a["seat"])
        && isInt(a["species"], 1, 100_000)
        && isInt(a["form"], 0, 100)
        && isInt(a["level"], 1, MAX_LEVEL)
        && typeof a["shiny"] === "boolean"
        && isInt(a["variant"], 0, 2)
        && isInt(a["seed"], 0, 1_000_000_000)
      );
    case "remove":
      return isId(a["p"]);
    case "owner":
      return isId(a["p"]) && isSeat(a["seat"]);
    case "money":
      return isInt(a["v"], 0, 1_000_000_000);
    case "balls":
      return isInt(a["ball"], 0, 5) && isInt(a["v"], 0, 999);
    case "plan":
      return isInt(a["wave"], 1, 100_000) && (a["plan"] === null || isWavePlan(a["plan"]));
    case "rewards":
      return a["items"] === null || isRewardNames(a["items"]);
    case "jump":
      return a["v"] === null || isInt(a["v"], 1, 100_000);
    case "biome":
      return a["v"] === null || isInt(a["v"], 0, 1000);
    case "mode": {
      const mode = a["mode"];
      if (typeof mode !== "string") {
        return false;
      }
      if (MODE_FLAGS.includes(mode)) {
        return typeof a["v"] === "boolean";
      }
      const range = Object.hasOwn(MODE_NUMBERS, mode) ? MODE_NUMBERS[mode] : undefined;
      return range !== undefined && isInt(a["v"], range[0], range[1]);
    }
    case "weather":
      return isInt(a["v"], 0, 9);
    case "terrain":
      return isInt(a["v"], 0, 4);
    case "enemy":
      return (
        (a["e"] === null || isInt(a["e"], 0, 2))
        && (a["what"] === "faint" || a["what"] === "hp1" || a["what"] === "heal" || a["what"] === "level")
        && isInt(a["v"], 0, MAX_LEVEL)
      );
    case "stages":
      return isSide(a["side"]) && isInt(a["v"], -6, 6);
    case "status":
      // 0: cure
      return isSide(a["side"]) && isInt(a["v"], 0, 6);
    case "win":
    case "allShiny":
      return true;
    case "randomize":
      return isInt(a["seed"], 0, 1_000_000_000);
    default:
      return false;
  }
}

/** @returns Whether `value` is a batch of the menu: what a `DEBUG` decision carries */
export function isDebugBatch(value: unknown): value is DebugBatch {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const actions = (value as Record<string, unknown>)["actions"];
  return Array.isArray(actions) && actions.length <= MAX_DEBUG_ACTIONS && actions.every(isDebugAction);
}
