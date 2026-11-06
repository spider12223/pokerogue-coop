/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { activeOverrides, defaultOverrides } from "#app/overrides";
import type { DebugState } from "#coop/debug/state";
import { BattleType } from "#enums/battle-type";

/**
 * The game's overrides (`activeOverrides`) as the host's debug menu (DECISIONS D42) writes them from the run's debug state.
 * Apart from the state (`debug/state.ts`): the session keeps the state, and the overrides module must not be one of its
 * imports.
 * @module
 */

/** The overrides the menu writes; the build identity (D1) reads them as their defaults */
const MANAGED = [
  "ENEMY_LEVEL_OVERRIDE",
  "ENEMY_SHINY_OVERRIDE",
  "BATTLE_TYPE_OVERRIDE",
  "RANDOM_TRAINER_OVERRIDE",
  "MYSTERY_ENCOUNTER_OVERRIDE",
  "WAIVE_SHOP_FEES_OVERRIDE",
  "WAIVE_ROLL_FEE_OVERRIDE",
] as const satisfies readonly (keyof typeof defaultOverrides)[];

type ManagedOverrides = { -readonly [K in (typeof MANAGED)[number]]: (typeof activeOverrides)[K] };

/** The menu's overrides that differ from their defaults now: only those are put back when the menu is off */
const written = new Set<(typeof MANAGED)[number]>();

/**
 * @returns The overrides in effect, with what the menu wrote at its defaults: what the client started with. A rejoining
 * player's client starts with the defaults while the host's has the cheats of the run in effect; both must still agree
 * (D1). An override set by hand still counts.
 */
export function identityOverrides(): Record<string, unknown> {
  const out: Record<string, unknown> = { ...activeOverrides };
  for (const key of written) {
    out[key] = defaultOverrides[key];
  }
  return out;
}

/** @returns What the managed overrides should be for the state and the wave */
function wantedOverrides(state: DebugState, wave: number): ManagedOverrides {
  const out = Object.fromEntries(MANAGED.map(key => [key, defaultOverrides[key]])) as unknown as ManagedOverrides;
  const plan = state.plans[String(wave)] ?? null;
  const { modes } = state;
  // (a planned enemy's own level, shiny and boss bars are put on it when it is made: `debug/enemy-plan.ts`)
  out.ENEMY_LEVEL_OVERRIDE = modes.enemyLevel;
  out.ENEMY_SHINY_OVERRIDE = modes.shinyEnemies ? true : defaultOverrides.ENEMY_SHINY_OVERRIDE;
  if (plan?.battle === "wild") {
    out.BATTLE_TYPE_OVERRIDE = BattleType.WILD;
  } else if (plan?.battle === "trainer") {
    out.BATTLE_TYPE_OVERRIDE = BattleType.TRAINER;
    if (plan.trainer !== null) {
      out.RANDOM_TRAINER_OVERRIDE = { trainerType: plan.trainer };
    }
  } else if (plan?.battle === "me" && plan.encounter !== null) {
    out.MYSTERY_ENCOUNTER_OVERRIDE = plan.encounter;
  }
  // (the next reward screen's items are placed by the screen itself: `debug/rewards.ts`)
  out.WAIVE_SHOP_FEES_OVERRIDE = modes.freeShop;
  out.WAIVE_ROLL_FEE_OVERRIDE = modes.freeRerolls;
  return out;
}

/**
 * Write the overrides the game reads from the state, for the wave that is played. Only what the menu changes is written: an
 * override the menu never set keeps whatever value it has (a test's, a developer's).
 * @param state - The state; `null`: the menu is off, what it wrote goes back to the default
 * @param wave - The wave that is played (its plan, if any, is in effect)
 */
export function writeDebugOverrides(state: DebugState | null, wave: number): void {
  if (state === null) {
    for (const key of written) {
      Reflect.set(activeOverrides, key, defaultOverrides[key]);
    }
    written.clear();
    return;
  }
  const wanted = wantedOverrides(state, wave);
  for (const key of MANAGED) {
    const value = wanted[key];
    const isDefault = value === defaultOverrides[key];
    if (isDefault && !written.has(key)) {
      continue;
    }
    Reflect.set(activeOverrides, key, value);
    if (isDefault) {
      written.delete(key);
    } else {
      written.add(key);
    }
  }
}
