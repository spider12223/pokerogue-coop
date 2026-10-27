/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { isAllowedSwitch } from "#coop/control";
import type { FighterView, LegalityView } from "#coop/legal";
import type { PartyMemberView } from "#coop/party-edit";
import { getCoopSession } from "#coop/session";
import { BattleType } from "#enums/battle-type";
import type { PlayerPokemon } from "#field/pokemon";
import { type PokemonFormChangeItemModifier, PokemonHeldItemModifier } from "#modifiers/modifier";
import { getMoveTargets } from "#moves/move-utils";
import { canTerastallize } from "#utils/pokemon-utils";

/**
 * The picture of the game that the legality check of a decision looks at (DECISIONS D24). Built when a decision is about to be
 * applied, from what the simulation holds at that moment; it reads and changes nothing.
 *
 * @module
 */

function fighterView(pokemon: PlayerPokemon): FighterView {
  const session = getCoopSession();
  const moveset = pokemon.getMoveset();
  const fieldIndex = pokemon.getFieldIndex();
  const battlers = globalScene.currentBattle.getBattlerCount();
  return {
    fieldIndex,
    controller: session?.ownership.get(pokemon.id) ?? "host",
    moves: moveset.map((move, index) => ({ id: move.moveId, usable: pokemon.trySelectMove(index, false)[0] })),
    queuedMove: pokemon.getMoveQueue()[0]?.move ?? null,
    trapped: pokemon.isTrapped(),
    canTera: canTerastallize(pokemon),
    switchTargets: globalScene
      .getPlayerParty()
      .map((_, index) => index)
      .filter(index => index >= battlers && isAllowedSwitch(fieldIndex, index, "voluntary")),
    targetsOf: moveId => {
      // A random target (Outrage) was drawn by the client that chose the move: any one it could have drawn is legal, and
      // nothing is drawn here (a draw would move the battle's stream, and a second draw need not agree with the first)
      const set = getMoveTargets(pokemon, moveId, undefined, "all");
      return { targets: [...set.targets], multiple: set.multiple };
    },
  };
}

/** @returns What a decision is checked against, from the game as it is now */
export function gameLegalityView(): LegalityView {
  const session = getCoopSession();
  const party = (): PlayerPokemon[] => globalScene.getPlayerParty();
  const pokemonById = (id: number): PlayerPokemon | undefined => party().find(pokemon => pokemon.id === id);
  const battleType = (): BattleType => globalScene.currentBattle.battleType;
  return {
    ownerOf: id => session?.ownership.get(id),
    fighter: id => {
      const pokemon = globalScene.getPlayerField().find(candidate => candidate.id === id && candidate.isActive());
      return pokemon === undefined ? null : fighterView(pokemon);
    },
    get canCatch() {
      return battleType() !== BattleType.TRAINER;
    },
    get canRun() {
      return battleType() !== BattleType.TRAINER;
    },
    ballCount: type => globalScene.pokeballCounts[type as keyof typeof globalScene.pokeballCounts] ?? 0,
    replacements: (leavingId, reason) => {
      const fieldIndex = party().findIndex(pokemon => pokemon.id === leavingId);
      if (fieldIndex < 0) {
        return [];
      }
      const battlers = globalScene.currentBattle.getBattlerCount();
      return party()
        .map((_, index) => index)
        .filter(index => index >= battlers && isAllowedSwitch(fieldIndex, index, reason));
    },
    reward: () => session?.rewardLegality?.() ?? null,
    transferable: id =>
      (
        globalScene.findModifiers(
          modifier =>
            modifier instanceof PokemonHeldItemModifier && modifier.isTransferable && modifier.pokemonId === id,
        ) as PokemonHeldItemModifier[]
      ).map(modifier => modifier.stackCount),
    moveCount: id => pokemonById(id)?.getMoveset().length ?? null,
    biomeChoices: () => session?.biomeChoices ?? null,
    ownership: () => session?.ownership,
    partyMembers: () => party().map(pokemon => partyMemberView(pokemon)),
    meQuestion: () => session?.meQuestion ?? null,
    sidePick: () => session?.sidePick ?? null,
  };
}

/** A Pokémon of the party, as a party edit is checked against it (D28) */
export function partyMemberView(pokemon: PlayerPokemon): PartyMemberView {
  const formItems = globalScene
    .findModifiers(modifier => modifier.is("PokemonFormChangeItemModifier") && modifier.pokemonId === pokemon.id)
    .map(modifier => (modifier as PokemonFormChangeItemModifier).formChangeItem);
  return {
    id: pokemon.id,
    owner: getCoopSession()?.ownership.get(pokemon.id),
    fused: pokemon.isFusion(),
    formItems,
    evolves:
      speciesDataRegistry.hasEvolutions(pokemon.species.speciesId)
      || (pokemon.isFusion()
        && pokemon.fusionSpecies != null
        && speciesDataRegistry.hasEvolutions(pokemon.fusionSpecies.speciesId)),
  };
}
