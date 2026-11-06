/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import type { EnemyPlan } from "#coop/debug/state";
import type { PokemonSpecies } from "#data/pokemon-species";
import type { EnemyPokemon } from "#field/pokemon";

/**
 * Making an enemy the host planned (DECISIONS D42, amended): `addEnemyPokemon` asks for the column of each enemy it makes
 * fresh (`debugEnemyPlan`), puts its species, level and boss rule in before the Pokémon is made, and the rest on it
 * after. Every client makes the same enemy: the plan is the run's debug state, the game's own rolls are the battle's
 * random numbers in the same order.
 * @module
 */

/**
 * @returns The species, level and boss rule the enemy is made with: the plan's where it has one, the game's otherwise
 */
export function planBeforeMade(
  plan: EnemyPlan,
  species: PokemonSpecies,
  level: number,
  boss: boolean,
): { species: PokemonSpecies; level: number; boss: boolean } {
  if (plan.level > 0) {
    level = plan.level;
  }
  if (plan.species !== null) {
    species = speciesDataRegistry.getSpecies(plan.species);
    // (whether a Pokémon is a boss depends on its species and level, as for the game's own override)
    boss = globalScene.getEncounterBossSegments(globalScene.currentBattle.waveIndex, level, species) > 1;
  }
  if (plan.boss === 1) {
    boss = false;
  } else if (plan.boss > 1) {
    boss = true;
  }
  return { species, level, boss };
}

/** Put the rest of the plan on the enemy just made, before it is set up (`init`) */
export function planAfterMade(pokemon: EnemyPokemon, plan: EnemyPlan): void {
  if (plan.boss === 1) {
    pokemon.setBoss(false);
  } else if (plan.boss > 1) {
    pokemon.setBoss(true, plan.boss);
  }
}
