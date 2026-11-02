/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * What the host's debug menu (DECISIONS D42) keeps between turns: the plans for later waves, the next reward screen, a wave
 * jump, a biome, and the modes that stay on. Every client keeps the same state: it changes only through the host's
 * sequenced batches, and it is saved in the co-op save block. What the game reads of it goes through its own overrides
 * (`activeOverrides`), written from this state (`debug/overrides.ts`) at the start of each wave and after each batch.
 * @module
 */

/** What the host planned for one wave. Every field left at its "game's" value lets the game choose. */
export interface WavePlan {
  /** The kind of wave: the game's, a wild battle, a trainer battle or a Mystery Encounter */
  battle: "game" | "wild" | "trainer" | "me";
  /** The species of the enemies, in the order they are made (cycled); empty: the game's */
  species: number[];
  /** Their level; 0: the game's */
  level: number;
  /** Shiny or not; `null`: the game's */
  shiny: boolean | null;
  /** Health bar segments (a boss has more than 1); 0: the game's */
  boss: number;
  /** The trainer of a trainer battle; `null`: a random one */
  trainer: number | null;
  /** The Mystery Encounter of an encounter wave; `null`: a random one */
  encounter: number | null;
}

/** The modes of the menu that stay on until the host turns them off */
export interface DebugModes {
  /** The shop costs nothing */
  freeShop: boolean;
  /** Rerolls cost nothing */
  freeRerolls: boolean;
  /** Our Pokémon take no damage */
  noDamage: boolean;
  /** Our attacks knock out what they hit */
  oneHit: boolean;
  /** Every enemy is shiny */
  shinyEnemies: boolean;
  /** EXP multiplier: 1 is the game's */
  exp: number;
  /** Money multiplier: 1 is the game's */
  money: number;
  /** Every enemy has this level; 0: the game's */
  enemyLevel: number;
}

export interface DebugState {
  /** `wave -> plan` */
  plans: Record<string, WavePlan>;
  /** The items of the next reward screen (names of `modifierTypes`); `null`: the game's */
  rewards: string[] | null;
  /** The wave after this one is this wave; `null`: the next */
  jump: number | null;
  /** The run goes to this biome after this wave; `null`: the game's */
  biome: number | null;
  modes: DebugModes;
  /** How many enemies of the planned wave were made: the next takes the next planned species */
  made: number;
}

export const MAX_PLANNED_SPECIES = 6;
export const MAX_PLANNED_REWARDS = 8;
export const MAX_MULTIPLIER = 100;
export const MAX_LEVEL = 10_000;

export function defaultModes(): DebugModes {
  return {
    freeShop: false,
    freeRerolls: false,
    noDamage: false,
    oneHit: false,
    shinyEnemies: false,
    exp: 1,
    money: 1,
    enemyLevel: 0,
  };
}

export function emptyDebugState(): DebugState {
  return { plans: {}, rewards: null, jump: null, biome: null, modes: defaultModes(), made: 0 };
}

export function emptyWavePlan(): WavePlan {
  return { battle: "game", species: [], level: 0, shiny: null, boss: 0, trainer: null, encounter: null };
}

const isInt = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

const isIntOrNull = (value: unknown, min: number, max: number): boolean => value === null || isInt(value, min, max);

export function isWavePlan(value: unknown): value is WavePlan {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const plan = value as Record<string, unknown>;
  return (
    (plan["battle"] === "game" || plan["battle"] === "wild" || plan["battle"] === "trainer" || plan["battle"] === "me")
    && Array.isArray(plan["species"])
    && plan["species"].length <= MAX_PLANNED_SPECIES
    && plan["species"].every(species => isInt(species, 1, 100_000))
    && isInt(plan["level"], 0, MAX_LEVEL)
    && (plan["shiny"] === null || typeof plan["shiny"] === "boolean")
    && isInt(plan["boss"], 0, 5)
    && isIntOrNull(plan["trainer"], 1, 10_000)
    && isIntOrNull(plan["encounter"], 0, 10_000)
  );
}

export function isRewardNames(value: unknown): value is string[] {
  return (
    Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_PLANNED_REWARDS
    && value.every(name => typeof name === "string" && /^[A-Z0-9_]{1,40}$/.test(name))
  );
}

export function isDebugModes(value: unknown): value is DebugModes {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const modes = value as Record<string, unknown>;
  const flags = ["freeShop", "freeRerolls", "noDamage", "oneHit", "shinyEnemies"] as const;
  return (
    flags.every(flag => typeof modes[flag] === "boolean")
    && isInt(modes["exp"], 1, MAX_MULTIPLIER)
    && isInt(modes["money"], 1, MAX_MULTIPLIER)
    && isInt(modes["enemyLevel"], 0, MAX_LEVEL)
  );
}

export function isDebugState(value: unknown): value is DebugState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const state = value as Record<string, unknown>;
  const plans = state["plans"];
  return (
    typeof plans === "object"
    && plans !== null
    && Object.entries(plans).every(([wave, plan]) => /^\d{1,5}$/.test(wave) && isWavePlan(plan))
    && (state["rewards"] === null || isRewardNames(state["rewards"]))
    && isIntOrNull(state["jump"], 1, 100_000)
    && isIntOrNull(state["biome"], 0, 1000)
    && isDebugModes(state["modes"])
    && isInt(state["made"], 0, 1000)
  );
}

/** @returns Whether the state is the empty one: a save of a run without cheats has none */
export function isEmptyDebugState(state: DebugState): boolean {
  return JSON.stringify(state) === JSON.stringify(emptyDebugState());
}

/**
 * A new wave starts: the plans of the waves before it are done; the count of planned enemies starts again.
 * @param wave - The wave that starts
 */
export function beginDebugWave(state: DebugState, wave: number): void {
  for (const planned of Object.keys(state.plans)) {
    if (Number(planned) < wave) {
      delete state.plans[planned];
    }
  }
  state.made = 0;
}

/**
 * @returns The species of the next enemy made in `wave`, if the host planned one; counts it
 */
export function nextPlannedSpecies(state: DebugState, wave: number): number | null {
  const species = state.plans[String(wave)]?.species ?? [];
  if (species.length === 0) {
    return null;
  }
  return species[state.made++ % species.length];
}
