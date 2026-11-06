/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PLAYER_PARTY_MAX_SIZE } from "#app/constants";
import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import type { DebugAction, DebugBatch } from "#coop/debug/actions";
import { isKnownItem, makeItemType } from "#coop/debug/catalog";
import { writeDebugOverrides } from "#coop/debug/overrides";
import { type DebugWhere, debugBatchApplied } from "#coop/debug/queue";
import type { Seat } from "#coop/protocol";
import { type CoopSession, requireCoopSession } from "#coop/session";
import { writesForPokemon } from "#coop/sync/sim-account";
import { getLevelTotalExp } from "#data/exp";
import type { Gender } from "#data/gender";
import { CustomPokemonData } from "#data/pokemon-data";
import type { TerrainType } from "#data/terrain";
import { HitResult } from "#enums/hit-result";
import type { Nature } from "#enums/nature";
import type { PokeballType } from "#enums/pokeball";
import type { PokemonType } from "#enums/pokemon-type";
import { BATTLE_STATS } from "#enums/stat";
import { StatusEffect } from "#enums/status-effect";
import type { WeatherType } from "#enums/weather-type";
import type { EnemyPokemon, PlayerPokemon, Pokemon } from "#field/pokemon";
import { PersistentModifier, PokemonHeldItemModifier } from "#modifiers/modifier";
import { PokemonMove } from "#moves/pokemon-move";
import type { Variant } from "#sprites/variant";
import { randSeedItem } from "#utils/common";

/**
 * Carry out the host's debug batch (DECISIONS D42) on this client. Every client runs it at the same point of the
 * simulation with the same state, so all end in the same state: an action that does not fit (a Pokémon that left, a full
 * party) is skipped on every client alike.
 * @module
 */
/**
 * @param where - Where it takes effect (a turn, or a reward screen): the host's change log says so
 */
export async function applyDebugBatch(batch: DebugBatch, where?: DebugWhere): Promise<void> {
  const session = requireCoopSession();
  for (const action of batch.actions) {
    try {
      await applyDebugAction(session, action);
    } catch (error) {
      // The same on every client: the action has no effect past where it failed
      console.error(`co-op debug: "${action.t}" failed`, error);
    }
  }
  writeDebugOverrides(session.debugState, globalScene.currentBattle?.waveIndex ?? 0);
  globalScene.updateModifiers(true, true);
  globalScene.updateMoneyText();
  if (session.isHost && where !== undefined) {
    debugBatchApplied(batch, where);
  }
}

function partyMember(id: number): PlayerPokemon | null {
  return globalScene.getPlayerParty().find(pokemon => pokemon.id === id) ?? null;
}

/** The enemies on the field the action is about: one by its field index, or every one */
function enemiesOf(index: number | null): EnemyPokemon[] {
  const field = globalScene.getEnemyField();
  return (index === null ? field : [field[index]]).filter(
    (enemy): enemy is EnemyPokemon => enemy != null && enemy.isActive(true),
  );
}

function activeOf(side: "party" | "enemy"): Pokemon[] {
  return (side === "party" ? globalScene.getPlayerField() : globalScene.getEnemyField()).filter(pokemon =>
    pokemon?.isActive(true),
  );
}

/** Stats, name, sprite and box of a Pokémon after a change; its HP keeps its share of the maximum */
async function refresh(pokemon: Pokemon, reloadSprite = false): Promise<void> {
  const ratio = pokemon.getHpRatio(true);
  const fainted = pokemon.isFainted();
  pokemon.generateName();
  pokemon.calculateStats();
  if (!fainted) {
    pokemon.hp = Math.max(1, Math.min(pokemon.getMaxHp(), Math.round(pokemon.getMaxHp() * ratio)));
  }
  if (reloadSprite) {
    pokemon.updateFusionPalette();
    await pokemon.loadAssets(false);
    if (pokemon.isOnField()) {
      pokemon.playAnim();
    }
  }
  if (pokemon.isOnField()) {
    await pokemon.updateInfo(true);
  }
}

function setLevel(pokemon: Pokemon, level: number): void {
  pokemon.level = level;
  pokemon.exp = getLevelTotalExp(level, pokemon.species.growthRate);
}

/** A form index the species has; 0 if it has not */
function formOf(speciesId: number, form: number): number {
  const species = speciesDataRegistry.getSpecies(speciesId);
  return form < species.forms.length ? form : 0;
}

/** Keep the ability slot inside what the (new) species has */
function clampAbility(pokemon: Pokemon): void {
  const count = pokemon.getSpeciesForm().getAbilityCount();
  if (pokemon.abilityIndex >= count) {
    pokemon.abilityIndex = count - 1;
  }
}

async function setSpecies(pokemon: Pokemon, speciesId: number, form: number): Promise<void> {
  pokemon.species = speciesDataRegistry.getSpecies(speciesId);
  pokemon.formIndex = formOf(speciesId, form);
  clampAbility(pokemon);
  pokemon.setScale(pokemon.getSpriteScale());
  await refresh(pokemon, true);
}

/** A held item for a Pokémon, or an item of the whole team when `pokemon` is `null`: any item of the catalog, exact */
function giveItem(pokemon: PlayerPokemon | null, id: string, count: number): void {
  const type = makeItemType(id);
  if (type === null) {
    return;
  }
  const modifier = type.newModifier(pokemon ?? undefined);
  if (pokemon !== null && modifier instanceof PokemonHeldItemModifier) {
    modifier.pokemonId = pokemon.id;
    modifier.stackCount = Math.min(count, modifier.getMaxStackCount());
    globalScene.addModifier(modifier, true, false, false, true);
  } else if (
    pokemon === null
    && modifier instanceof PersistentModifier
    && !(modifier instanceof PokemonHeldItemModifier)
  ) {
    modifier.stackCount = Math.min(count, modifier.getMaxStackCount());
    globalScene.addModifier(modifier, true, false, false, true);
  }
}

function heal(pokemon: Pokemon): void {
  pokemon.clearStatus(true, false);
  pokemon.hp = pokemon.getMaxHp();
  for (const move of pokemon.getMoveset()) {
    move.ppUsed = 0;
  }
}

/** Knock out an enemy as an indirect hit does (the game's own faint follows) */
function knockOut(enemy: EnemyPokemon): void {
  enemy.damageAndUpdate(enemy.hp, { result: HitResult.INDIRECT_KO, ignoreSegments: true });
}

function setStatus(pokemon: Pokemon, effect: StatusEffect): void {
  if (effect === StatusEffect.NONE) {
    pokemon.clearStatus(false, false);
  } else if (pokemon.status == null) {
    // (a fixed sleep: the battle's random numbers are not touched)
    pokemon.doSetStatus(effect as StatusEffect.SLEEP, 3);
  }
}

/** The species of a party member is new: the dex counts it as for a catch (D4: an account counts everything, D42) */
function countInDex(pokemon: PlayerPokemon): void {
  globalScene.gameData.setPokemonSeen(pokemon, false);
  if (writesForPokemon(pokemon)) {
    void globalScene.gameData.setPokemonCaught(pokemon, false);
  }
}

async function addPokemon(session: CoopSession, action: Extract<DebugAction, { t: "add" }>): Promise<void> {
  const party = globalScene.getPlayerParty();
  if (party.length >= PLAYER_PARTY_MAX_SIZE || (action.seat === "guest2" && session.players !== 3)) {
    return;
  }
  const species = speciesDataRegistry.getSpecies(action.species);
  let added: PlayerPokemon | null = null;
  // What the game draws for a new Pokémon (its id, IVs, nature, ...) comes from the host's seed: the same on every client
  globalScene.executeWithSeedOffset(() => {
    added = globalScene.addPlayerPokemon(
      species,
      action.level,
      undefined,
      formOf(action.species, action.form),
      undefined,
      action.shiny,
      action.variant as Variant,
    );
  }, action.seed);
  const pokemon = added as PlayerPokemon | null;
  if (pokemon === null) {
    return;
  }
  party.push(pokemon);
  pokemon.setVisible(false);
  session.ownership.set(pokemon.id, action.seat);
  await pokemon.loadAssets();
  countInDex(pokemon);
}

function removePokemon(session: CoopSession, id: number): void {
  const pokemon = partyMember(id);
  const owner = session.ownership.get(id);
  // Not one on the field, and every player keeps at least one
  if (pokemon === null || pokemon.isOnField() || owner === undefined) {
    return;
  }
  const left = globalScene.getPlayerParty().filter(member => session.ownership.get(member.id) === owner);
  if (left.length <= 1) {
    return;
  }
  globalScene.removePokemonFromPlayerParty(pokemon, true);
  session.ownership.delete(id);
}

function giveTo(session: CoopSession, id: number, seat: Seat): void {
  const pokemon = partyMember(id);
  const owner = session.ownership.get(id);
  if (pokemon === null || pokemon.isOnField() || owner === undefined || owner === seat) {
    return;
  }
  if (seat === "guest2" && session.players !== 3) {
    return;
  }
  const left = globalScene.getPlayerParty().filter(member => session.ownership.get(member.id) === owner);
  if (left.length <= 1) {
    return;
  }
  session.ownership.set(id, seat);
}

async function applyPartyAction(session: CoopSession, action: DebugAction): Promise<boolean> {
  if (!("p" in action) || action.p === null || action.t === "item" || action.t === "heal") {
    return false;
  }
  const pokemon = partyMember(action.p);
  if (pokemon === null) {
    return true;
  }
  switch (action.t) {
    case "level":
      setLevel(pokemon, action.v);
      await refresh(pokemon);
      break;
    case "ivs":
      pokemon.ivs = [...action.v];
      await refresh(pokemon);
      break;
    case "nature":
      pokemon.setNature(action.v as Nature);
      await refresh(pokemon);
      break;
    case "ability":
      pokemon.customPokemonData.ability = action.v === 0 ? -1 : action.v;
      if (pokemon.isFusion()) {
        // (a fusion has the ability of its second half)
        pokemon.fusionCustomPokemonData ??= new CustomPokemonData();
        pokemon.fusionCustomPokemonData.ability = pokemon.customPokemonData.ability;
      }
      await refresh(pokemon);
      break;
    case "passive":
      pokemon.customPokemonData.passive = action.v === 0 ? -1 : action.v;
      pokemon.passive = true;
      await refresh(pokemon);
      break;
    case "friendship":
      pokemon.friendship = action.v;
      break;
    case "species":
      await setSpecies(pokemon, action.v, action.form);
      countInDex(pokemon);
      break;
    case "fusion":
      if (action.v === 0) {
        pokemon.clearFusionSpecies();
      } else {
        pokemon.fusionSpecies = speciesDataRegistry.getSpecies(action.v);
        pokemon.fusionFormIndex = formOf(action.v, action.form);
        pokemon.fusionAbilityIndex = 0;
        pokemon.fusionShiny = pokemon.shiny;
        pokemon.fusionVariant = pokemon.variant;
        pokemon.fusionGender = pokemon.gender;
        pokemon.fusionLuck = pokemon.luck;
      }
      await refresh(pokemon, true);
      break;
    case "shiny":
      pokemon.shiny = action.shiny;
      pokemon.variant = (action.shiny ? action.variant : 0) as Variant;
      if (pokemon.fusionSpecies !== null) {
        pokemon.fusionShiny = pokemon.shiny;
        pokemon.fusionVariant = pokemon.variant;
      }
      pokemon.luck = Math.max(pokemon.luck, action.shiny ? pokemon.variant + 1 : 0);
      await refresh(pokemon, true);
      break;
    case "gender":
      pokemon.gender = action.v as Gender;
      await refresh(pokemon, true);
      break;
    case "tera":
      pokemon.teraType = action.v as PokemonType;
      break;
    case "move": {
      const moveset = pokemon.moveset;
      if (action.v === 0) {
        // (a Pokémon keeps at least one move)
        if (moveset.length > 1 && action.slot < moveset.length) {
          moveset.splice(action.slot, 1);
        }
      } else if (!moveset.some(move => move.moveId === action.v)) {
        moveset[Math.min(action.slot, moveset.length)] = new PokemonMove(action.v);
      }
      break;
    }
    case "remove":
      removePokemon(session, pokemon.id);
      break;
    case "owner":
      giveTo(session, pokemon.id, action.seat);
      break;
    default:
      return false;
  }
  return true;
}

async function applyDebugAction(session: CoopSession, action: DebugAction): Promise<void> {
  if (await applyPartyAction(session, action)) {
    return;
  }
  const state = session.debugState;
  const wave = globalScene.currentBattle?.waveIndex ?? 0;
  switch (action.t) {
    case "item": {
      const pokemon = action.p === null ? null : partyMember(action.p);
      if (action.p === null || pokemon !== null) {
        giveItem(pokemon, action.item, action.count);
      }
      break;
    }
    case "drop": {
      // (the item at that place of the list, if it is still that item: the same on every client)
      const held = globalScene.findModifiers(
        modifier => modifier instanceof PokemonHeldItemModifier && modifier.pokemonId === action.p,
      );
      const modifier = held[action.index];
      if (modifier !== undefined && modifier.type.id === action.key) {
        globalScene.removeModifier(modifier);
      }
      break;
    }
    case "heal":
      for (const pokemon of globalScene.getPlayerParty()) {
        if (action.p === null || pokemon.id === action.p) {
          heal(pokemon);
          await refresh(pokemon);
        }
      }
      break;
    case "add":
      await addPokemon(session, action);
      break;
    case "money":
      globalScene.money = action.v;
      break;
    case "balls":
      globalScene.pokeballCounts[action.ball as PokeballType] = action.v;
      break;
    case "plan":
      if (action.wave <= wave && action.plan !== null) {
        // (a plan for a wave that is made already has nothing to change)
        break;
      }
      if (action.plan === null) {
        delete state.plans[String(action.wave)];
      } else {
        state.plans[String(action.wave)] = structuredClone(action.plan);
      }
      break;
    case "rewards":
      {
        // (an id that names no item of this build is left out, alike on every client)
        const items = action.items?.filter(isKnownItem) ?? [];
        state.rewards = items.length === 0 ? null : items;
      }
      break;
    case "jump":
      state.jump = action.v !== null && action.v > wave ? action.v : null;
      break;
    case "biome":
      state.biome = action.v;
      break;
    case "mode":
      (state.modes as unknown as Record<string, number | boolean>)[action.mode] = action.v;
      break;
    case "weather":
      globalScene.arena.trySetWeather(action.v as WeatherType);
      break;
    case "terrain":
      globalScene.arena.trySetTerrain(action.v as TerrainType, true);
      break;
    case "enemy":
      for (const enemy of enemiesOf(action.e)) {
        if (action.what === "faint") {
          knockOut(enemy);
        } else if (action.what === "hp1") {
          enemy.bossSegmentIndex = 0;
          enemy.hp = 1;
          await enemy.updateInfo(true);
        } else if (action.what === "heal") {
          heal(enemy);
          // (a boss gets its health bars back with its HP)
          if (enemy.bossSegments > 0) {
            enemy.bossSegmentIndex = enemy.bossSegments - 1;
          }
          await enemy.updateInfo(true);
        } else if (action.v > 0) {
          setLevel(enemy, action.v);
          await refresh(enemy);
        }
      }
      break;
    case "stages":
      for (const pokemon of activeOf(action.side)) {
        for (const stat of BATTLE_STATS) {
          pokemon.setStatStage(stat, action.v);
        }
      }
      break;
    case "status":
      for (const pokemon of activeOf(action.side)) {
        setStatus(pokemon, action.v as StatusEffect);
      }
      break;
    case "win": {
      // The enemies that wait (a trainer's) are out too, so the battle is over when the ones on the field fall
      const field = globalScene.getEnemyField();
      for (const enemy of globalScene.getEnemyParty()) {
        if (!field.includes(enemy)) {
          enemy.hp = 0;
        }
      }
      for (const enemy of enemiesOf(null)) {
        knockOut(enemy);
      }
      break;
    }
    case "allShiny":
      for (const pokemon of globalScene.getPlayerParty()) {
        if (!pokemon.shiny) {
          pokemon.shiny = true;
          pokemon.luck = Math.max(pokemon.luck, 1);
          await refresh(pokemon, true);
        }
      }
      break;
    case "randomize": {
      const all = speciesDataRegistry.getAllSpecies();
      const picks: number[] = [];
      globalScene.executeWithSeedOffset(() => {
        for (const _ of globalScene.getPlayerParty()) {
          picks.push(randSeedItem(all).speciesId);
        }
      }, action.seed);
      for (const [index, pokemon] of globalScene.getPlayerParty().entries()) {
        await setSpecies(pokemon, picks[index], 0);
        countInDex(pokemon);
      }
      break;
    }
    default:
      break;
  }
}
