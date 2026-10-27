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
import { simAccount } from "#coop/sim-account";
import { getDailyEventSeedBoss } from "#data/daily-run";
import { isDailyFinalBoss } from "#data/daily-seed-utils";
import { allMoves } from "#data/data-lists";
import { AbilityId } from "#enums/ability-id";
import { BattleType } from "#enums/battle-type";
import { BiomeId } from "#enums/biome-id";
import { MoveResult } from "#enums/move-result";
import { MysteryEncounterMode } from "#enums/mystery-encounter-mode";
import { PokeballType } from "#enums/pokeball";
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
  const queued = pokemon.getMoveQueue()[0];
  return {
    fieldIndex,
    controller: session?.ownership.get(pokemon.id) ?? "host",
    moves: moveset.map((move, index) => ({ id: move.moveId, usable: pokemon.trySelectMove(index, false)[0] })),
    queued:
      queued === undefined
        ? null
        : { move: queued.move, targets: [...(queued.targets ?? [])], useMode: queued.useMode },
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

/** Whether the final boss of a daily run may be caught */
function isCatchableDailyBoss(): boolean {
  return isDailyFinalBoss() && (getDailyEventSeedBoss()?.catchable ?? false);
}

/**
 * `CommandPhase.checkCanUseBall`, without its messages: whether a Ball may be thrown in this battle. It must say exactly what
 * the command phase says, or a Ball the player could throw is an illegal decision.
 */
function canUseBall(): boolean {
  const { arena, currentBattle, gameMode } = globalScene;
  const { battleType, waveIndex } = currentBattle;
  if (arena.biomeId === BiomeId.END && battleType === BattleType.WILD) {
    const { isClassic, isEndless, isDaily } = gameMode;
    const account = simAccount();
    const isClassicFinalBoss = gameMode.isBattleClassicFinalBoss(waveIndex);
    const isEndlessMinorBoss = gameMode.isEndlessMinorBoss(waveIndex);
    const isFullFreshStart = gameMode.isFullFreshStartChallenge();
    const someUncaughtSpeciesOnField = globalScene
      .getEnemyField()
      .some(p => p.isActive() && !account.getCaughtAttr(p.species.speciesId, "host"));
    const missingMultipleStarters = account.getStarterCaughtCount() < speciesDataRegistry.getAllStarters().length - 1;
    if (
      (isClassic && !isClassicFinalBoss && someUncaughtSpeciesOnField)
      || (isFullFreshStart && !isClassicFinalBoss)
      || (isEndless && !isEndlessMinorBoss)
    ) {
      return false;
    }
    return !(
      (isClassic && isClassicFinalBoss && missingMultipleStarters)
      || (isFullFreshStart && isClassicFinalBoss)
      || (isEndless && isEndlessMinorBoss)
      || (isDaily && !isCatchableDailyBoss())
    );
  }
  if (battleType === BattleType.TRAINER) {
    return false;
  }
  return !(currentBattle.isBattleMysteryEncounter() && !currentBattle.mysteryEncounter!.catchAllowed);
}

/** The boss rule of `CommandPhase.handleBallCommand`: a boss with shields left takes a Master Ball, or (some) none */
function ballWorks(type: number): boolean {
  const { gameMode, currentBattle } = globalScene;
  const target = globalScene.getEnemyPokemon(false);
  if (target?.isBoss() && target.bossSegmentIndex >= 1 && !target.hasAbility(AbilityId.WONDER_GUARD, false, true)) {
    if (
      gameMode.isBattleClassicFinalBoss(currentBattle.waveIndex)
      && (type < PokeballType.MASTER_BALL || (type === PokeballType.MASTER_BALL && gameMode.hasAnyChallenges()))
    ) {
      return false;
    }
    if (isCatchableDailyBoss() || type < PokeballType.MASTER_BALL) {
      return false;
    }
  }
  return true;
}

/** `CommandPhase.handleRunCommand`, without its messages and the trap (the fighter's own) */
function canRun(): boolean {
  const { currentBattle, arena } = globalScene;
  if (arena.biomeId === BiomeId.END || !(currentBattle.mysteryEncounter?.fleeAllowed ?? true)) {
    return false;
  }
  return !(
    currentBattle.battleType === BattleType.TRAINER
    || currentBattle.mysteryEncounter?.encounterMode === MysteryEncounterMode.TRAINER_BATTLE
  );
}

/** @returns What a decision is checked against, from the game as it is now */
export function gameLegalityView(): LegalityView {
  const session = getCoopSession();
  const party = (): PlayerPokemon[] => globalScene.getPlayerParty();
  const pokemonById = (id: number): PlayerPokemon | undefined => party().find(pokemon => pokemon.id === id);
  return {
    ownerOf: id => session?.ownership.get(id),
    fighter: id => {
      const pokemon = globalScene.getPlayerField().find(candidate => candidate.id === id && candidate.isActive());
      return pokemon === undefined ? null : fighterView(pokemon);
    },
    get canCatch() {
      return canUseBall();
    },
    get canRun() {
      return canRun();
    },
    ballCount: type => globalScene.pokeballCounts[type as keyof typeof globalScene.pokeballCounts] ?? 0,
    catchTargets: () =>
      globalScene
        .getEnemyField()
        .filter(enemy => enemy.isActive(true))
        .map(enemy => enemy.getBattlerIndex()),
    ballWorks,
    baton: id => {
      const pokemon = pokemonById(id);
      const last = pokemon?.getLastXMoves()[0];
      return {
        item:
          globalScene.findModifier(modifier => modifier.is("SwitchEffectTransferModifier") && modifier.pokemonId === id)
          !== undefined,
        move:
          last?.result === MoveResult.SUCCESS
          && (allMoves[last.move].getAttrs("ForceSwitchOutAttr")[0]?.isBatonPass() ?? false),
      };
    },
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
