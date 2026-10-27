/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { DecisionKey, Seat } from "#coop/protocol";

/**
 * The choices of a Mystery Encounter as sequenced decisions (DECISIONS D29). The chooser (the host, or the player who goes
 * in a one-Pokémon encounter) makes every choice of an encounter; each is an `ME_CHOICE` decision, numbered by the
 * encounter decisions of the wave (`ref = "${n}"`). Both clients then run the encounter's own code with that choice.
 *
 * | Choice | Payload | Asked by |
 * |---|---|---|
 * | the option | `option {index}` | the encounter's option screen (also its follow-up screens) |
 * | a Pokémon | `pokemon {pokemonId}`, `null` to go back | `selectPokemonForOption` |
 * | the menu after it | `sub {index}`, `null` to go back | `selectPokemonForOption` |
 * | a menu, then a Pokémon | `optionPokemon {index, pokemonId}`, both `null` to go back | `selectOptionThenPokemon` |
 * | yes or no | `confirm {yes}` | an encounter's own question |
 * | who goes | `who {seat}`, `null` for nobody | a one-Pokémon encounter, before its options |
 *
 * No game imports, so it runs in Node.
 *
 * @module
 */

export type MeChoice =
  | { k: "option"; index: number }
  | { k: "pokemon"; pokemonId: number | null }
  | { k: "sub"; index: number | null }
  | { k: "optionPokemon"; index: number | null; pokemonId: number | null }
  | { k: "confirm"; yes: boolean }
  | { k: "who"; seat: Seat | null };

export type MeChoiceKind = MeChoice["k"];

/**
 * What the open choice may be answered with, as both clients see it when they ask (D24). Both run the same encounter, so
 * they build the same question.
 */
export interface MeQuestion {
  k: MeChoiceKind;
  /** `option`, `sub`, `optionPokemon`: which entries may be chosen */
  enabled?: readonly boolean[];
  /** `pokemon`, `optionPokemon`: the Pokémon that may be chosen (the chooser's own that the encounter allows) */
  pokemon?: readonly number[];
  /** `who`: the players who may go (they have enough Pokémon for it) */
  seats?: readonly Seat[];
}

/** @returns The key of the `n`-th encounter decision of wave `wave` */
export function meChoiceKey(wave: number, n: number): DecisionKey {
  return { wave, turn: 0, kind: "ME_CHOICE", ref: `${n}` };
}

const isIndex = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const isIndexOrNull = (value: unknown): boolean => value === null || isIndex(value);

/** @returns Whether this is a well-formed encounter choice */
export function isMeChoice(value: unknown): value is MeChoice {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const choice = value as Record<string, unknown>;
  switch (choice["k"]) {
    case "option":
      return isIndex(choice["index"]);
    case "pokemon":
      return isIndexOrNull(choice["pokemonId"]);
    case "sub":
      return isIndexOrNull(choice["index"]);
    case "optionPokemon":
      return isIndexOrNull(choice["index"]) && isIndexOrNull(choice["pokemonId"]);
    case "confirm":
      return typeof choice["yes"] === "boolean";
    case "who":
      return choice["seat"] === null || choice["seat"] === "host" || choice["seat"] === "guest";
    default:
      return false;
  }
}

/** @returns Whether `value` is an encounter choice of kind `k` */
export function isMeChoiceOf<K extends MeChoiceKind>(k: K) {
  return (value: unknown): value is Extract<MeChoice, { k: K }> => isMeChoice(value) && value.k === k;
}

/**
 * Whether a sequenced encounter choice answers the open question (D24).
 * @returns The reason it does not, or `null`
 */
export function checkMeChoice(choice: unknown, question: MeQuestion | null): string | null {
  if (!isMeChoice(choice)) {
    return "an encounter choice that cannot be read";
  }
  if (question === null) {
    return "an encounter choice while no encounter asks one";
  }
  if (choice.k !== question.k) {
    return "an encounter choice of another kind than the one asked";
  }
  const enabled = (index: number): boolean => question.enabled?.[index] === true;
  const allowed = (id: number): boolean => question.pokemon?.includes(id) === true;
  switch (choice.k) {
    case "option":
      return enabled(choice.index) ? null : "an option that cannot be chosen";
    case "sub":
      return choice.index === null || enabled(choice.index) ? null : "a menu entry that is not there";
    case "pokemon":
      return choice.pokemonId === null || allowed(choice.pokemonId) ? null : "a Pokémon that may not be chosen";
    case "optionPokemon":
      if (choice.index === null || choice.pokemonId === null) {
        return choice.index === choice.pokemonId ? null : "half an answer";
      }
      return enabled(choice.index) && allowed(choice.pokemonId) ? null : "an entry or a Pokémon that may not be chosen";
    case "who":
      return choice.seat === null || question.seats?.includes(choice.seat) === true ? null : "a player who cannot go";
    case "confirm":
      return null;
  }
}
