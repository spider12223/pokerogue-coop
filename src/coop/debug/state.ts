/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { isItemId } from "#coop/debug/item-id";

/**
 * What the host's debug menu (DECISIONS D42) keeps between turns: the plans for later waves, the next reward screen, a wave
 * jump, a biome, and the modes that stay on. Every client keeps the same state: it changes only through the host's
 * sequenced batches, and it is saved in the co-op save block. What the game reads of it goes through its own overrides
 * (`activeOverrides`), written from this state (`debug/overrides.ts`) at the start of each wave and after each batch, and
 * through the hooks that make a planned enemy (`debug/hooks.ts`, `debug/enemy-plan.ts`).
 * @module
 */

/** What the host planned for one enemy of a wave. Every field left at its "game's" value lets the game choose. */
export interface EnemyPlan {
  /** Its species; `null`: the game's pick */
  species: number | null;
  /** Fused with this species, or with a partner the game picks as it fuses a wild Pokémon; `null`: not fused */
  fusion: number | "random" | null;
  /** Its level; 0: the game's */
  level: number;
  /** `null`: the game's; -1: not shiny; 0, 1, 2: shiny of that rarity (★, ★★, ★★★) */
  shiny: number | null;
  /** Health bar segments; 0: the game's; 1: not a boss; 2 to 5: a boss with that many */
  boss: number;
  /** Its ability; 0: the game's */
  ability: number;
  /** `null`: the game's */
  nature: number | null;
  /** `null`: the game's */
  gender: number | null;
  /** It Terastallizes into this type on its first turn; `null`: the game's */
  tera: number | null;
  /** Its four move slots; 0: the game's move there */
  moves: number[];
  /** Held items (exact item ids) on top of the game's; an item listed twice is two */
  items: string[];
}

/** What the host planned for one wave. Every field left at its "game's" value lets the game choose. */
export interface WavePlan {
  /** The kind of wave: the game's, a wild battle, a trainer battle or a Mystery Encounter */
  battle: "game" | "wild" | "trainer" | "me";
  /**
   * Column k is for the k-th enemy made fresh in the wave: a wild battle's in field order, a trainer's team in order
   * (a fixed wave's trainer too); `null`: the game's
   */
  enemies: (EnemyPlan | null)[];
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
  /** How many enemies of the planned wave were made: the next takes the next column */
  made: number;
}

export const MAX_PLANNED_ENEMIES = 6;
/** A wild battle has two enemies, in a game of three too (D40); a lone boss is one */
export const MAX_WILD_ENEMIES = 2;
export const MAX_ENEMY_ITEMS = 8;
export const ENEMY_MOVE_SLOTS = 4;
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
  return { battle: "game", enemies: [], trainer: null, encounter: null };
}

export function emptyEnemyPlan(): EnemyPlan {
  return {
    species: null,
    fusion: null,
    level: 0,
    shiny: null,
    boss: 0,
    ability: 0,
    nature: null,
    gender: null,
    tera: null,
    moves: [0, 0, 0, 0],
    items: [],
  };
}

/** @returns Whether the plan of an enemy sets anything (a column left at the game's plans nothing) */
export function isEnemyPlanSet(plan: EnemyPlan | null | undefined): plan is EnemyPlan {
  return (
    plan != null
    && (plan.species !== null
      || plan.fusion !== null
      || plan.level !== 0
      || plan.shiny !== null
      || plan.boss !== 0
      || plan.ability !== 0
      || plan.nature !== null
      || plan.gender !== null
      || plan.tera !== null
      || plan.moves.some(move => move !== 0)
      || plan.items.length > 0)
  );
}

const isInt = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

const isIntOrNull = (value: unknown, min: number, max: number): boolean => value === null || isInt(value, min, max);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** @returns Whether the object has these keys and no others */
function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

const ENEMY_PLAN_KEYS = Object.keys(emptyEnemyPlan());
const WAVE_PLAN_KEYS = Object.keys(emptyWavePlan());

const isBattleKind = (value: unknown): value is WavePlan["battle"] =>
  value === "game" || value === "wild" || value === "trainer" || value === "me";

export function isEnemyPlan(value: unknown): value is EnemyPlan {
  if (!isRecord(value) || !hasKeys(value, ENEMY_PLAN_KEYS)) {
    return false;
  }
  const { moves, items } = value;
  return (
    isIntOrNull(value["species"], 1, 100_000)
    && (value["fusion"] === null || value["fusion"] === "random" || isInt(value["fusion"], 1, 100_000))
    && isInt(value["level"], 0, MAX_LEVEL)
    && isIntOrNull(value["shiny"], -1, 2)
    && isInt(value["boss"], 0, 5)
    && isInt(value["ability"], 0, 10_000)
    && isIntOrNull(value["nature"], 0, 24)
    && isIntOrNull(value["gender"], -1, 1)
    && isIntOrNull(value["tera"], 0, 18)
    && Array.isArray(moves)
    && moves.length === ENEMY_MOVE_SLOTS
    && moves.every(move => isInt(move, 0, 10_000))
    && Array.isArray(items)
    && items.length <= MAX_ENEMY_ITEMS
    && items.every(isItemId)
  );
}

export function isWavePlan(value: unknown): value is WavePlan {
  if (!isRecord(value) || !hasKeys(value, WAVE_PLAN_KEYS)) {
    return false;
  }
  const { enemies } = value;
  return (
    isBattleKind(value["battle"])
    && Array.isArray(enemies)
    && enemies.length <= MAX_PLANNED_ENEMIES
    && enemies.every(enemy => enemy === null || isEnemyPlan(enemy))
    && isIntOrNull(value["trainer"], 1, 10_000)
    && isIntOrNull(value["encounter"], 0, 10_000)
  );
}

/** @returns Whether the value is a list of the next reward screen's items: exact items (`debug/item-id.ts`) */
export function isRewardNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_PLANNED_REWARDS && value.every(isItemId);
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

const isWaveKey = (wave: string): boolean => /^\d{1,5}$/.test(wave);

export function isDebugState(value: unknown): value is DebugState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const state = value as Record<string, unknown>;
  const plans = state["plans"];
  return (
    typeof plans === "object"
    && plans !== null
    && Object.entries(plans).every(([wave, plan]) => isWaveKey(wave) && isWavePlan(plan))
    && (state["rewards"] === null || isRewardNames(state["rewards"]))
    && isIntOrNull(state["jump"], 1, 100_000)
    && isIntOrNull(state["biome"], 0, 1000)
    && isDebugModes(state["modes"])
    && isInt(state["made"], 0, 1000)
  );
}

/**
 * A plan as the build before per-enemy plans saved it (D42 before its amendment): the species cycled over every enemy
 * made, and one level, shiny and boss bars for them all. Its species go into six columns in turn, its values into each
 * column; a "game's" wave with something planned becomes a wild one (where it landed then is not known now).
 * @returns The plan; `null` if it is not one either
 */
function fromOldPlan(value: unknown): WavePlan | null {
  if (!isRecord(value)) {
    return null;
  }
  const { battle, species, level, shiny, boss, trainer, encounter } = value;
  if (
    !isBattleKind(battle)
    || !Array.isArray(species)
    || !species.every(id => isInt(id, 1, 100_000))
    || !isInt(level, 0, MAX_LEVEL)
    || !(shiny === null || typeof shiny === "boolean")
    || !isInt(boss, 0, 5)
    || !isIntOrNull(trainer, 1, 10_000)
    || !isIntOrNull(encounter, 0, 10_000)
  ) {
    return null;
  }
  const planned = species.length > 0 || level > 0 || shiny !== null || boss > 0;
  const kind = battle === "game" && planned ? "wild" : battle;
  const plan: WavePlan = {
    battle: kind,
    enemies: [],
    trainer: trainer as number | null,
    encounter: encounter as number | null,
  };
  if (planned && kind !== "me" && kind !== "game") {
    // (six: on a fixed wave every one goes on its trainer's team, as the old species did; a wild battle uses two)
    plan.enemies = Array.from({ length: MAX_PLANNED_ENEMIES }, (_, column) => ({
      ...emptyEnemyPlan(),
      species: species.length > 0 ? (species[column % species.length] as number) : null,
      level,
      shiny: shiny === null ? null : shiny ? 0 : -1,
      boss,
    }));
  }
  return plan;
}

/**
 * Read a saved debug state (the co-op save block's `debug`): this build's, or one saved before per-enemy plans
 * (converted). What cannot be read is dropped and the rest kept, so a damaged debug state never refuses the save.
 * @returns The state; `null` if there is nothing to read
 */
export function readDebugState(value: unknown): DebugState | null {
  if (!isRecord(value)) {
    return null;
  }
  const state = emptyDebugState();
  const { plans, rewards, jump, biome, modes, made } = value;
  if (isRecord(plans)) {
    for (const [wave, plan] of Object.entries(plans)) {
      const read = isWavePlan(plan) ? structuredClone(plan) : fromOldPlan(plan);
      if (isWaveKey(wave) && read !== null) {
        state.plans[wave] = read;
      }
    }
  }
  if (isRewardNames(rewards)) {
    state.rewards = [...rewards];
  }
  if (isInt(jump, 1, 100_000)) {
    state.jump = jump;
  }
  if (isInt(biome, 0, 1000)) {
    state.biome = biome;
  }
  if (isDebugModes(modes)) {
    state.modes = structuredClone(modes);
  }
  if (isInt(made, 0, 1000)) {
    state.made = made;
  }
  return state;
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
 * An enemy of `wave` is made fresh: it is counted, and takes the next column of the wave's plan.
 * @returns Its column and that column's plan, if the column plans anything
 */
export function nextPlannedEnemy(state: DebugState, wave: number): { slot: number; plan: EnemyPlan } | null {
  const slot = state.made;
  state.made = Math.min(state.made + 1, 1000);
  const plan = state.plans[String(wave)]?.enemies[slot];
  return isEnemyPlanSet(plan) ? { slot, plan } : null;
}
