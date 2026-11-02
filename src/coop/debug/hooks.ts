/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { writeDebugOverrides } from "#coop/debug/overrides";
import { beginDebugWave, type DebugState, nextPlannedSpecies } from "#coop/debug/state";
import { getCoopSession } from "#coop/session";

/**
 * Where the game reads the host's debug menu (DECISIONS D42). Each hook does nothing outside a co-op run whose host turned
 * the menu on, so solo play and other runs are unchanged. The state is the same on every client, so is what they return.
 * @module
 */

/** @returns The menu's state of this run; `null` without the menu */
export function debugState(): DebugState | null {
  const session = getCoopSession();
  return session?.debug === true ? session.debugState : null;
}

/**
 * A new wave is made (`newBattle`): the plans of earlier waves are done, and this wave's plan is what the overrides say.
 * A run without the menu puts back what an earlier run's menu wrote.
 * @param wave - The wave that is made
 */
export function debugBeginWave(wave: number): void {
  const state = debugState();
  if (state !== null) {
    beginDebugWave(state, wave);
  }
  // (without the menu: what a run before wrote goes back to the defaults; nothing at all in solo play)
  writeDebugOverrides(state, wave);
}

/**
 * @param current - The wave that ends
 * @returns The wave the host jumps to after `current`; `null`: the next. A jump is used once.
 */
export function takeDebugJump(current: number): number | null {
  const state = debugState();
  const jump = state?.jump ?? null;
  if (state === null || jump === null) {
    return null;
  }
  state.jump = null;
  // Only forward: the keys of the waves played are used (D42)
  return jump > current ? jump : null;
}

/**
 * @param wave - The wave of the enemy that is made
 * @returns The species the host planned for the next enemy of the wave; `null`: the game's
 */
export function debugEnemySpecies(wave: number): number | null {
  const state = debugState();
  return state === null ? null : nextPlannedSpecies(state, wave);
}

/** @returns Whether the host planned a Mystery Encounter for `wave` */
export function debugForcesEncounter(wave: number): boolean {
  return debugState()?.plans[String(wave)]?.battle === "me";
}

/** @returns Whether the host chose the next biome: the run changes biome after this wave */
export function hasDebugBiome(): boolean {
  return (debugState()?.biome ?? null) !== null;
}

/** @returns The biome the host chose, used once; `null`: the game's choice */
export function takeDebugBiome(): number | null {
  const state = debugState();
  const biome = state?.biome ?? null;
  if (state !== null) {
    state.biome = null;
  }
  return biome;
}

/** A reward screen's options were made: the items the host chose were used */
export function consumeDebugRewards(): void {
  const state = debugState();
  if (state === null || state.rewards === null) {
    return;
  }
  state.rewards = null;
  writeDebugOverrides(state, globalScene.currentBattle?.waveIndex ?? 0);
}

/**
 * @param targetIsPlayer - Whether the Pokémon that takes the damage is ours
 * @param sourceIsPlayer - Whether a Pokémon of ours deals it; `false` if no Pokémon does
 * @param damage - The damage as the game made it
 * @param hp - The target's HP
 * @returns The damage with the menu's modes; whether it goes through boss segments
 */
export function debugDamage(
  targetIsPlayer: boolean,
  sourceIsPlayer: boolean,
  damage: number,
  hp: number,
): { damage: number; ignoreSegments: boolean } {
  const modes = debugState()?.modes;
  if (modes?.noDamage && targetIsPlayer) {
    return { damage: 0, ignoreSegments: false };
  }
  if (modes?.oneHit && sourceIsPlayer && !targetIsPlayer && damage > 0) {
    return { damage: hp, ignoreSegments: true };
  }
  return { damage, ignoreSegments: false };
}

/** @returns The EXP multiplier of the menu (1 without it) */
export function debugExpMultiplier(): number {
  return debugState()?.modes.exp ?? 1;
}

/** @returns The money multiplier of the menu (1 without it) */
export function debugMoneyMultiplier(): number {
  return debugState()?.modes.money ?? 1;
}
