/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { MysteryEncounterType } from "../../../src/enums/mystery-encounter-type.ts";
import type { ClientState } from "../engine.ts";
import type { Scenario } from "../scenario.ts";

/**
 * `me:<name>`: every mystery encounter of the game, one scenario each, made from `MysteryEncounterType` (a new encounter
 * is here without an edit). The run starts at the encounter's wave; the players answer it with `--option`, `--goer` and
 * `--pick` until it ends: a battle starts, the rewards are up, or the next wave begins.
 */

/** The encounters that ask who goes (D29): their scenario takes `--goer` */
const ONE_POKEMON = new Set<MysteryEncounterType>([
  MysteryEncounterType.THE_EXPERT_POKEMON_BREEDER,
  MysteryEncounterType.FUN_AND_GAMES,
]);

const names = Object.keys(MysteryEncounterType).filter(key =>
  Number.isNaN(Number(key)),
) as (keyof typeof MysteryEncounterType)[];

/**
 * The encounter is over: a battle's first command (only the one who goes gets one in a one-Pokémon encounter), the
 * rewards, the biome, the next wave or the run's end
 */
function over(states: ClientState[], wave: number): boolean {
  return states.some(
    state =>
      state.ui === "COMMAND"
      || state.ui === "MODIFIER_SELECT"
      || state.phase === "SelectBiomePhase"
      || state.phase.startsWith("GameOver")
      || (state.wave > wave && state.me === null),
  );
}

export const encounterScenarios: Scenario[] = names.map(name => {
  const type = MysteryEncounterType[name];
  return {
    id: `me:${name.toLowerCase().replace(/_/g, "-")}`,
    area: "Encounters",
    summary: `${name.toLowerCase().replace(/_/g, " ")}: every step of one option, to its battle, rewards or the next wave`,
    vars: {
      wave: 33,
      level: 40,
      // a full share: what some options need (a type, a move); an encounter that gives a Pokémon then asks who to release
      party: 0,
      // some options cost money (the Safari Zone's entry, the salesman's Pokémon)
      money: 100_000,
      option: null,
      pick: null,
      ...(ONE_POKEMON.has(type) ? { goer: null } : {}),
    },
    sweep: "option",
    async play(run, vars) {
      await run.toRun({
        MYSTERY_ENCOUNTER_RATE_OVERRIDE: 256,
        MYSTERY_ENCOUNTER_OVERRIDE: type,
        DISABLE_STANDARD_TRAINERS_OVERRIDE: true,
      });
      await run.drive({ until: states => over(states, vars.wave) });
    },
  };
});
