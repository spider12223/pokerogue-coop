/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { type DecisionKey, NO_REF } from "#coop/protocol";

/**
 * The decision keys of the in-battle decisions (DECISIONS D2). Only `TURN_COMMANDS`, `FAINT_SWITCH` and `PIVOT_SWITCH`
 * carry `battle.turn`; a prompt uses `turn = 0` and a `ref` that is unique within the wave.
 *
 * Refs are `pokemon.id`s, never slots: a slot says nothing about which Pokémon acts, and an id does.
 *
 * @module
 */

/**
 * The commands of one Pokémon for a turn. A side action that the partner declined is chosen again; the new choice is
 * attempt 1, 2, ... and has its own key.
 */
export function turnCommandsKey(wave: number, turn: number, pokemonId: number, attempt = 0): DecisionKey {
  return { wave, turn, kind: "TURN_COMMANDS", ref: attempt === 0 ? pokemonId : `${pokemonId}:${attempt}` };
}

/**
 * The partner's answer to a Ball or Run that the Pokémon `pokemonId` chose in attempt `attempt`.
 * Same turn as the commands it answers.
 */
export function sideActionKey(wave: number, turn: number, pokemonId: number, attempt = 0): DecisionKey {
  return { wave, turn, kind: "SIDE_ACTION", ref: `${pokemonId}:${attempt}` };
}

/**
 * Both players chose a Ball or a Run in the same turn: which one happens. One per turn (a decline is never asked then,
 * so the commands are not chosen again).
 */
export function sidePickKey(wave: number, turn: number): DecisionKey {
  return { wave, turn, kind: "SIDE_PICK", ref: NO_REF };
}

/**
 * The replacement of the fainted Pokémon `faintedId`. `turn` is `battle.turn` as it stands when the faint `SwitchPhase`
 * runs: the faint turn + 1 (D2, amended).
 */
export function faintSwitchKey(wave: number, turn: number, faintedId: number): DecisionKey {
  return { wave, turn, kind: "FAINT_SWITCH", ref: faintedId };
}

/** The replacement of `leavingId`, who switched itself out (U-turn, Eject Button, ...). */
export function pivotSwitchKey(wave: number, turn: number, leavingId: number): DecisionKey {
  return { wave, turn, kind: "PIVOT_SWITCH", ref: leavingId };
}

/** The biome after this wave, when the Map lets the picker choose (one per wave) */
export function biomeKey(wave: number): DecisionKey {
  return { wave, turn: 0, kind: "BIOME", ref: NO_REF };
}

/** What the thrower does with the caught Pokémon `caughtId` when their seat is full: release one of their own, or decline. */
export function catchReleaseKey(wave: number, caughtId: number): DecisionKey {
  return { wave, turn: 0, kind: "CATCH_RELEASE", ref: caughtId };
}

/**
 * The part of a prompt's ref that tells apart the same prompt asked again in a wave (an evolution cancelled and offered
 * again at the next level, a declined TM picked again): none the first time, `:n` from the second
 * (`CoopSession.nextOccurrence`, counted alike on both clients)
 */
function occurrencePart(occurrence: number): string {
  return occurrence > 1 ? `:${occurrence}` : "";
}

/**
 * Whether `pokemonId` learns `moveId` in place of one of its moves (or not).
 * @param occurrence - The how-manyth time this wave asks it (1 for the first)
 */
export function learnMoveKey(wave: number, pokemonId: number, moveId: number, occurrence = 1): DecisionKey {
  return { wave, turn: 0, kind: "LEARN_MOVE", ref: `${pokemonId}:${moveId}${occurrencePart(occurrence)}` };
}

/**
 * Whether the evolution of `pokemonId` into `speciesId` is cancelled.
 * @param occurrence - The how-manyth time this wave offers that evolution (1 for the first)
 */
export function evolutionCancelKey(wave: number, pokemonId: number, speciesId: number, occurrence = 1): DecisionKey {
  return { wave, turn: 0, kind: "EVOLUTION_CANCEL", ref: `${pokemonId}:${speciesId}${occurrencePart(occurrence)}` };
}

/** Whether evolutions are paused for `pokemonId` after the cancelled evolution into `speciesId` (its `occurrence`). */
export function evolutionPauseKey(wave: number, pokemonId: number, speciesId: number, occurrence = 1): DecisionKey {
  return {
    wave,
    turn: 0,
    kind: "EVOLUTION_CANCEL",
    ref: `${pokemonId}:${speciesId}${occurrencePart(occurrence)}:pause`,
  };
}

/**
 * The party is wiped: whether the wave is played again from its start or the run ends (D4a, amended). One per wave: a retry
 * reloads the wave under a new epoch, where the key of the next game over is asked again.
 */
export function retryKey(wave: number): DecisionKey {
  return { wave, turn: 0, kind: "RETRY", ref: NO_REF };
}

export { NO_REF };
