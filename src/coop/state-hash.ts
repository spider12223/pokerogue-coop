/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Adapted from SunghoLee98/pokerogue `src/coop/coop-state-hash.ts` (AGPL-3.0-only): the same idea and the same core
 * contents (RNG states, parties, fields, modifiers, weather, reward options). Differences: owners come from the
 * session's resolver, more per-Pokémon fields (exp, luck, nature, IVs, ability, gender), the seeds and the pinned
 * settings are hashed, the hash is `hashCanonical`, and reward options and modifiers carry their generated arguments
 * (DECISIONS D9, D13).
 */

import type { BattleScene } from "#app/battle-scene";
import { globalScene } from "#app/global-scene";
import { settings } from "#app/global-settings-manager";
import { readPinnedSettings } from "#coop/pinned-settings";
import { hashCanonical, type PinnedSettings, type Seat } from "#coop/protocol";
import { getCoopSession } from "#coop/session";
import type { Pokemon } from "#field/pokemon";
import type { PersistentModifier } from "#modifiers/modifier";
import type { ModifierType, ModifierTypeOption } from "#modifiers/modifier-type";
import Phaser from "phaser";

/**
 * What goes into the hash is the simulation state both clients must agree on. What does not: `timestamp` and
 * `playTime` (wall clock, D13), animation and UI state, settings that are local only, and the account (it reaches the
 * simulation only through the snapshot, D4, and shows up as the state it produces).
 */
export interface PokemonHashState {
  id: number;
  speciesId: number;
  formIndex: number;
  level: number;
  exp: number;
  hp: number;
  /** `StatusEffect`, `0` if none */
  status: number;
  shiny: boolean;
  variant: number;
  luck: number;
  nature: number;
  abilityIndex: number;
  passive: boolean;
  gender: number;
  ivs: number[];
  /** `0` if not fused */
  fusionSpeciesId: number;
  /** `[moveId, ppUsed]` per move slot */
  moves: [number, number][];
  /** The co-op player who owns it as the owner map has it: `null` for enemies, and for a member the map lacks */
  owner: Seat | null;
  /** Return, Frustration and friendship evolutions read it */
  friendship: number;
  teraType: number;
  pokerus: boolean;
}

/** A reward option or a modifier type: its id plus what was generated into it. */
export interface TypeHashState {
  id: string;
  tier: number | null;
  /** The primitive fields the generator filled in (a TM's move, an attack booster's type, a berry's kind, ...) */
  args: Record<string, string | number | boolean | null>;
}

export interface RewardOptionHashState extends TypeHashState {
  upgradeCount: number;
  cost: number;
}

export interface StateHashSnapshot {
  wave: number;
  turn: number;
  biome: number;
  money: number;
  /**
   * The pinned settings (D5) as they are in effect now: the handshake checks them once, this notices a client whose
   * overlay is gone or that changed one mid-run
   */
  pinnedSettings: PinnedSettings;
  /** Reward screens started so far (D9): who picks next depends on it */
  rewardPickCount: number;
  /** The timed events of the run (D33): shiny rates, wild Pokémon, rewards and biomes depend on them */
  timedEvents: string[];
  /** The trainers the run has met (D34): which trainer a wave gets depends on them */
  metTrainers: number[];
  /** The run seed and the wave seed derived from it */
  seed: string;
  waveSeed: string;
  /** State of the global seeded RNG (`Phaser.Math.RND`) */
  rngState: string;
  battleSeed: string;
  /** State of the battle-specific RNG, `null` before it is first used */
  battleRngState: string | null;
  playerParty: PokemonHashState[];
  enemyParty: PokemonHashState[];
  /** `pokemon.id`s on the field, in field order */
  playerField: number[];
  enemyField: number[];
  /** `[type id, stack count, holder pokemon id or -1, generated args]` */
  /** `[type id, stack count, holder pokemon id or -1, generated args, battles left or -1]` */
  modifiers: [string, number, number, TypeHashState["args"], number][];
  enemyModifiers: [string, number, number, TypeHashState["args"], number][];
  /** The ball counts, by `PokeballType` */
  pokeballCounts: Record<string, number>;
  /** The Lock Capsule's lock: the reroll cost and the tiers depend on it */
  lockModifierTiers: boolean;
  /** The co-op run's seed: the seeded draws of `sim-rng` are keyed with it (D3) */
  runSeed: string | null;
  /** `WeatherType`, `0` if none */
  weather: number;
  /** `TerrainType`, `0` if none */
  terrain: number;
  /** The reward options on the open reward screen (type + generated args), empty if none is open */
  rewardOptions: RewardOptionHashState[];
}

const TYPE_LABEL_FIELDS = new Set(["id", "tier", "localeKey", "iconImage", "group", "soundName"]);

/** The generated arguments of a modifier type: its own primitive fields other than the labels every type has. */
function generatedArgs(type: ModifierType): TypeHashState["args"] {
  const args: TypeHashState["args"] = {};
  for (const key of [...Object.keys(type)].sort()) {
    const value = (type as unknown as Record<string, unknown>)[key];
    if (
      !TYPE_LABEL_FIELDS.has(key)
      && (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    ) {
      args[key] = value;
    }
  }
  return args;
}

export function describeModifierType(type: ModifierType): TypeHashState {
  return { id: type.id, tier: type.tier ?? null, args: generatedArgs(type) };
}

export function describeRewardOption(option: ModifierTypeOption): RewardOptionHashState {
  return { ...describeModifierType(option.type), upgradeCount: option.upgradeCount, cost: option.cost };
}

/**
 * The reward options of the `SelectModifierPhase` that is open. The phase registers them once they are generated;
 * they count only while that phase is the current one.
 */
let openRewards: { phase: object; options: readonly ModifierTypeOption[] } | null = null;

export function registerOpenRewardOptions(phase: object, options: readonly ModifierTypeOption[]): void {
  openRewards = { phase, options };
}

function openRewardOptions(scene: BattleScene): RewardOptionHashState[] {
  if (openRewards === null || scene.phaseManager.getCurrentPhase() !== openRewards.phase) {
    return [];
  }
  return openRewards.options.map(describeRewardOption);
}

function capturePokemon(pokemon: Pokemon): PokemonHashState {
  return {
    id: pokemon.id,
    speciesId: pokemon.species.speciesId,
    formIndex: pokemon.formIndex,
    level: pokemon.level,
    exp: pokemon.exp,
    hp: pokemon.hp,
    status: pokemon.status?.effect ?? 0,
    shiny: pokemon.shiny,
    variant: pokemon.variant,
    luck: pokemon.luck,
    nature: pokemon.nature,
    abilityIndex: pokemon.abilityIndex,
    passive: pokemon.passive === true,
    gender: pokemon.gender,
    ivs: [...pokemon.ivs],
    fusionSpeciesId: pokemon.fusionSpecies?.speciesId ?? 0,
    moves: pokemon.getMoveset().map(move => [move.moveId, move.ppUsed]),
    // The map itself: `ownerOf` falls back to the host, which would hide a member with no owner
    owner: pokemon.isPlayer() ? (getCoopSession()?.ownership.get(pokemon.id) ?? null) : null,
    friendship: pokemon.friendship,
    teraType: pokemon.teraType,
    pokerus: pokemon.pokerus === true,
  };
}

function captureModifier(modifier: PersistentModifier): StateHashSnapshot["modifiers"][number] {
  const holderId = "pokemonId" in modifier && typeof modifier.pokemonId === "number" ? modifier.pokemonId : -1;
  // A boost that lasts some battles (X Attack, Lures) counts them down
  const battlesLeft =
    "getBattleCount" in modifier && typeof modifier.getBattleCount === "function" ? modifier.getBattleCount() : -1;
  return [modifier.type.id, modifier.getStackCount(), holderId, generatedArgs(modifier.type), battlesLeft];
}

/** Capture the state the clients must agree on as a plain object. */
export function captureStateSnapshot(scene: BattleScene = globalScene): StateHashSnapshot {
  // `currentBattle` is typed non-null but is `null` between runs.
  const battle = scene.currentBattle as BattleScene["currentBattle"] | null;
  return {
    wave: battle?.waveIndex ?? 0,
    turn: battle?.turn ?? 0,
    biome: scene.arena?.biomeId ?? 0,
    money: scene.money,
    pinnedSettings: readPinnedSettings(settings),
    rewardPickCount: getCoopSession()?.rewardPickCount ?? 0,
    timedEvents: [...(getCoopSession()?.timedEvents ?? [])],
    metTrainers: [...(getCoopSession()?.metTrainers ?? [])],
    seed: scene.seed,
    waveSeed: scene.waveSeed,
    rngState: Phaser.Math.RND.state(),
    battleSeed: battle?.battleSeed ?? "",
    // The battle RNG state is private; element access reads it without widening `Battle`.
    battleRngState: battle?.["battleSeedState"] ?? null,
    playerParty: scene.getPlayerParty().map(capturePokemon),
    enemyParty: scene.getEnemyParty().map(capturePokemon),
    playerField: scene.getPlayerField().map(p => p.id),
    enemyField: scene.getEnemyField().map(p => p.id),
    modifiers: scene.modifiers.map(captureModifier),
    enemyModifiers: scene.findModifiers(() => true, false).map(captureModifier),
    pokeballCounts: { ...scene.pokeballCounts },
    lockModifierTiers: scene.lockModifierTiers === true,
    runSeed: getCoopSession()?.runSeed ?? null,
    weather: scene.arena?.weather?.weatherType ?? 0,
    terrain: scene.arena?.terrain?.terrainType ?? 0,
    rewardOptions: openRewardOptions(scene),
  };
}

/** @returns A 14 character hex hash of the state */
export function hashStateSnapshot(snapshot: StateHashSnapshot): string {
  return hashCanonical(snapshot);
}

/** Capture and hash the current state. */
export function computeStateHash(scene: BattleScene = globalScene): string {
  return hashStateSnapshot(captureStateSnapshot(scene));
}
