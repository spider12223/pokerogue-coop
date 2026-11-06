/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { debugPlannedEnemy } from "#coop/debug/hooks";
import { makeKnownItemType } from "#coop/debug/make-item";
import type { EnemyPlan } from "#coop/debug/state";
import type { Gender } from "#data/gender";
import { CustomPokemonData } from "#data/pokemon-data";
import type { PokemonSpecies } from "#data/pokemon-species";
import type { Nature } from "#enums/nature";
import type { PokemonType } from "#enums/pokemon-type";
import type { EnemyPokemon } from "#field/pokemon";
import { PokemonHeldItemModifier } from "#modifiers/modifier";
import { PokemonMove } from "#moves/pokemon-move";
import type { Variant } from "#sprites/variant";

/**
 * Making an enemy the host planned (DECISIONS D42, amended): `addEnemyPokemon` asks for the column of each enemy it makes
 * fresh (`debugEnemyPlan`), puts its species, level and boss rule in before the Pokémon is made, and the rest on it
 * after; the encounter gives its held items after the game's, and it Terastallizes on its first turn. Every client makes
 * the same enemy: the plan is the run's debug state, the game's own rolls are the battle's random numbers in the same
 * order. What comes after it is made reads the plan again by the enemy's place in its team, so a reload finds it.
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

/** Put the rest of the plan on the enemy just made, before it is set up (`init`): it starts at full HP */
export function planAfterMade(pokemon: EnemyPokemon, plan: EnemyPlan): void {
  if (plan.boss === 1) {
    pokemon.setBoss(false);
  } else if (plan.boss > 1) {
    pokemon.setBoss(true, plan.boss);
  }
  if (plan.nature !== null) {
    pokemon.setNature(plan.nature as Nature);
  }
  if (plan.gender !== null) {
    pokemon.gender = plan.gender as Gender;
  }
  if (plan.fusion === "random") {
    pokemon.generateFusionSpecies();
  } else if (plan.fusion !== null) {
    pokemon.generateFusionSpecies(false, speciesDataRegistry.getSpecies(plan.fusion));
  }
  if (plan.shiny !== null) {
    const shiny = plan.shiny >= 0;
    pokemon.shiny = shiny;
    pokemon.variant = (shiny ? plan.shiny : 0) as Variant;
    if (pokemon.fusionSpecies !== null) {
      pokemon.fusionShiny = shiny;
      pokemon.fusionVariant = pokemon.variant;
    }
  }
  if (plan.shiny !== null || plan.fusion !== null) {
    // (as the enemy's own luck is made: `EnemyPokemon`'s constructor)
    pokemon.luck = (pokemon.shiny ? pokemon.variant + 1 : 0) + (pokemon.fusionShiny ? pokemon.fusionVariant + 1 : 0);
    pokemon.fusionLuck = pokemon.luck;
  }
  if (plan.ability !== 0) {
    pokemon.customPokemonData.ability = plan.ability;
    if (pokemon.isFusion()) {
      // (a fusion has the ability of its second half)
      pokemon.fusionCustomPokemonData ??= new CustomPokemonData();
      pokemon.fusionCustomPokemonData.ability = plan.ability;
    }
  }
  if (plan.tera !== null) {
    pokemon.teraType = plan.tera as PokemonType;
  }
  // Each planned move in its slot (one the enemy knew elsewhere moves there; the slot's move takes its place)
  for (const [slot, move] of plan.moves.entries()) {
    if (move === 0) {
      continue;
    }
    const at = Math.min(slot, pokemon.moveset.length);
    const known = pokemon.moveset.findIndex(entry => entry?.moveId === move);
    if (known === -1) {
      pokemon.moveset[at] = new PokemonMove(move);
    } else if (known !== at && at < pokemon.moveset.length) {
      [pokemon.moveset[at], pokemon.moveset[known]] = [pokemon.moveset[known], pokemon.moveset[at]];
    }
  }
  pokemon.calculateStats();
  pokemon.hp = pokemon.getMaxHp();
  pokemon.generateName();
}

/** The encounter gave the enemies their items: each planned enemy gets its planned held items too, one per entry */
export function giveDebugEnemyItems(): void {
  let given = false;
  for (const enemy of globalScene.getEnemyParty()) {
    for (const id of debugPlannedEnemy(enemy)?.items ?? []) {
      // (an id that is no held item of this build gives nothing, alike on every client)
      const modifier = makeKnownItemType(id, [enemy])?.newModifier(enemy);
      if (modifier instanceof PokemonHeldItemModifier) {
        modifier.pokemonId = enemy.id;
        modifier.stackCount = 1;
        // (its work is done at once; the promise only says when the bar of items is drawn again)
        globalScene.addEnemyModifier(modifier, true, true);
        given = true;
      }
    }
  }
  if (given) {
    globalScene.updateModifiers(false);
  }
}

/** @returns Whether the host planned this enemy to Terastallize, and it has not yet */
export function debugShouldTera(pokemon: EnemyPokemon): boolean {
  return (debugPlannedEnemy(pokemon)?.tera ?? null) !== null && !pokemon.isTerastallized;
}
