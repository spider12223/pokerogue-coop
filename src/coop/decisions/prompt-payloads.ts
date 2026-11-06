/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Payloads of the prompt decisions of the battle (DECISIONS D10): what the owner of a Pokémon answers when it learns a move
 * or evolves. Plain JSON, with guards for what arrives over the wire.
 *
 * @module
 */

/** `LEARN_MOVE`: the move slot (0-3) the new move replaces, or `null` if the Pokémon does not learn it */
export interface LearnMovePayload {
  replaceIndex: number | null;
}

export function isLearnMovePayload(value: unknown): value is LearnMovePayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const index = (value as Record<string, unknown>)["replaceIndex"];
  return index === null || (Number.isInteger(index) && (index as number) >= 0 && (index as number) <= 3);
}

/** `BIOME`: the biome the picker chose (a `BiomeId`) */
export interface BiomePayload {
  biome: number;
}

export function isBiomePayload(value: unknown): value is BiomePayload {
  return typeof value === "object" && value !== null && Number.isInteger((value as Record<string, unknown>)["biome"]);
}

/** `CATCH_RELEASE`: the `pokemon.id` the thrower releases to make room for the catch, or `null` to decline the catch */
export interface CatchReleasePayload {
  release: number | null;
}

export function isCatchReleasePayload(value: unknown): value is CatchReleasePayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const release = (value as Record<string, unknown>)["release"];
  return release === null || Number.isInteger(release);
}

/** `EVOLUTION_CANCEL`, the evolution itself: whether the owner stopped it */
export interface EvolutionCancelPayload {
  cancel: boolean;
}

export function isEvolutionCancelPayload(value: unknown): value is EvolutionCancelPayload {
  return (
    typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)["cancel"] === "boolean"
  );
}

/** `EVOLUTION_CANCEL`, after a cancelled evolution: whether the owner pauses the Pokémon's evolutions */
export interface EvolutionPausePayload {
  pause: boolean;
}

export function isEvolutionPausePayload(value: unknown): value is EvolutionPausePayload {
  return (
    typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)["pause"] === "boolean"
  );
}
