/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { activeOverrides, defaultOverrides } from "#app/overrides";
import { type DebugAction, isDebugAction, isDebugBatch, MAX_DEBUG_ACTIONS } from "#coop/debug/actions";
import { isItemId, itemId, parseItemId } from "#coop/debug/item-id";
import { identityOverrides, writeDebugOverrides } from "#coop/debug/overrides";
import {
  cancelDebugChange,
  clearDebugQueue,
  debugBatchApplied,
  debugChanges,
  debugSendsNow,
  queueDebug,
  queueDebugChange,
  requeueDebug,
  setDebugSink,
  takeDebugBatch,
  waitingDebug,
} from "#coop/debug/queue";
import {
  beginDebugWave,
  defaultModes,
  emptyDebugState,
  emptyEnemyPlan,
  emptyWavePlan,
  isDebugState,
  isEmptyDebugState,
  isWavePlan,
  nextPlannedEnemy,
  readDebugState,
  type WavePlan,
} from "#coop/debug/state";
import { overridesAreDefaults } from "#coop/link/build-info";
import { hashCanonical } from "#coop/protocol";
import { COOP_SAVE_VERSION, isCoopSaveBlock } from "#coop/save/save-block";
import { BattleType } from "#enums/battle-type";
import { afterEach, describe, expect, it } from "vitest";

/** The host's debug menu (DECISIONS D42): what its batches may carry, and what it writes for the game to read */

const EVERY_KIND: DebugAction[] = [
  { t: "level", p: 1, v: 100 },
  { t: "ivs", p: 1, v: [31, 31, 31, 31, 31, 31] },
  { t: "nature", p: 1, v: 3 },
  { t: "ability", p: 1, v: 22 },
  { t: "passive", p: 1, v: 0 },
  { t: "friendship", p: 1, v: 255 },
  { t: "species", p: 1, v: 150, form: 0 },
  { t: "fusion", p: 1, v: 0, form: 0 },
  { t: "shiny", p: 1, shiny: true, variant: 2 },
  { t: "gender", p: 1, v: -1 },
  { t: "tera", p: 1, v: 18 },
  { t: "move", p: 1, slot: 3, v: 0 },
  { t: "item", p: 1, item: "LEFTOVERS", count: 3 },
  { t: "item", p: null, item: "EXP_SHARE", count: 1 },
  { t: "drop", p: 1, index: 2, key: "LEFTOVERS" },
  { t: "heal", p: null },
  { t: "add", seat: "guest2", species: 25, form: 0, level: 50, shiny: false, variant: 0, seed: 12_345 },
  { t: "remove", p: 1 },
  { t: "owner", p: 1, seat: "guest" },
  { t: "money", v: 1_000_000 },
  { t: "balls", ball: 4, v: 99 },
  {
    t: "plan",
    wave: 12,
    plan: {
      ...emptyWavePlan(),
      battle: "trainer",
      trainer: 5,
      enemies: [{ ...emptyEnemyPlan(), species: 150 }, null, { ...emptyEnemyPlan(), fusion: "random", shiny: 1 }],
    },
  },
  { t: "plan", wave: 12, plan: null },
  { t: "rewards", items: ["MASTER_BALL", "RARE_CANDY"] },
  { t: "rewards", items: null },
  { t: "jump", v: 50 },
  { t: "biome", v: null },
  { t: "mode", mode: "noDamage", v: true },
  { t: "mode", mode: "exp", v: 10 },
  { t: "weather", v: 2 },
  { t: "terrain", v: 4 },
  { t: "enemy", e: null, what: "faint", v: 0 },
  { t: "stages", side: "enemy", v: -6 },
  { t: "status", side: "party", v: 0 },
  { t: "win" },
  { t: "allShiny" },
  { t: "randomize", seed: 7 },
];

describe("Co-op debug menu: batches (D42)", () => {
  it("every kind of action is read back as it was written", () => {
    for (const action of EVERY_KIND) {
      expect(isDebugAction(JSON.parse(JSON.stringify(action))), JSON.stringify(action)).toBe(true);
    }
    expect(isDebugBatch({ actions: EVERY_KIND })).toBe(true);
  });

  it("a value out of its range, an unknown kind or too long a batch is refused", () => {
    const bad: unknown[] = [
      { t: "level", p: 1, v: 0 },
      { t: "ivs", p: 1, v: [31, 31, 31, 31, 31] },
      { t: "nature", p: 1, v: 25 },
      { t: "shiny", p: 1, shiny: true, variant: 3 },
      { t: "add", seat: "guest3", species: 25, form: 0, level: 5, shiny: false, variant: 0, seed: 1 },
      { t: "item", p: 1, item: "leftovers; drop", count: 1 },
      { t: "drop", p: 1, index: -1, key: "LEFTOVERS" },
      { t: "drop", p: 1, index: 0, key: "left overs" },
      { t: "mode", mode: "exp", v: 0 },
      { t: "mode", mode: "constructor", v: true },
      { t: "status", side: "enemy", v: 7 },
      { t: "plan", wave: 3, plan: { ...emptyWavePlan(), battle: "boss" } },
      { t: "warp" },
      null,
    ];
    for (const action of bad) {
      expect(isDebugAction(action), JSON.stringify(action)).toBe(false);
    }
    expect(isDebugBatch({ actions: Array.from({ length: MAX_DEBUG_ACTIONS + 1 }, () => ({ t: "win" })) })).toBe(false);
    expect(isDebugBatch({ actions: "win" })).toBe(false);
  });
});

describe("Co-op debug menu: state and overrides (D42)", () => {
  afterEach(() => writeDebugOverrides(null, 0));

  it("a wave's kind and trainer are what the overrides say while that wave is played; its enemies' values are not", () => {
    const state = emptyDebugState();
    state.plans["5"] = {
      ...emptyWavePlan(),
      battle: "trainer",
      trainer: 12,
      enemies: [{ ...emptyEnemyPlan(), level: 77, boss: 3, shiny: 0 }],
    };
    writeDebugOverrides(state, 5);
    expect(activeOverrides.BATTLE_TYPE_OVERRIDE).toBe(BattleType.TRAINER);
    expect(activeOverrides.RANDOM_TRAINER_OVERRIDE).toEqual({ trainerType: 12 });
    // (each enemy's level, boss bars and shiny are put on that enemy when it is made: `debug/enemy-plan.ts`)
    expect(activeOverrides.ENEMY_LEVEL_OVERRIDE).toBe(defaultOverrides.ENEMY_LEVEL_OVERRIDE);
    expect(activeOverrides.ENEMY_HEALTH_SEGMENTS_OVERRIDE).toBe(defaultOverrides.ENEMY_HEALTH_SEGMENTS_OVERRIDE);
    expect(activeOverrides.ENEMY_SHINY_OVERRIDE).toBe(defaultOverrides.ENEMY_SHINY_OVERRIDE);
    writeDebugOverrides(state, 6);
    expect(activeOverrides.BATTLE_TYPE_OVERRIDE).toBe(defaultOverrides.BATTLE_TYPE_OVERRIDE);
    expect(activeOverrides.ENEMY_LEVEL_OVERRIDE).toBe(defaultOverrides.ENEMY_LEVEL_OVERRIDE);
  });

  it("the modes stay until they are changed; no menu: the defaults", () => {
    const state = emptyDebugState();
    state.modes.freeShop = true;
    state.modes.enemyLevel = 3;
    state.rewards = ["MASTER_BALL"];
    writeDebugOverrides(state, 9);
    expect(activeOverrides.WAIVE_SHOP_FEES_OVERRIDE).toBe(true);
    expect(activeOverrides.ENEMY_LEVEL_OVERRIDE).toBe(3);
    // (the next reward screen's items are the screen's own to place: no override)
    expect(activeOverrides.ITEM_REWARD_OVERRIDE).toEqual([]);
    writeDebugOverrides(null, 9);
    expect(activeOverrides.WAIVE_SHOP_FEES_OVERRIDE).toBe(false);
    expect(activeOverrides.ENEMY_LEVEL_OVERRIDE).toBe(0);
  });

  it("the build identity does not see the menu's overrides: a rejoining player still matches (D1)", () => {
    const before = hashCanonical(identityOverrides());
    const state = emptyDebugState();
    state.modes.freeRerolls = true;
    state.plans["2"] = { ...emptyWavePlan(), battle: "wild", enemies: [{ ...emptyEnemyPlan(), level: 50 }] };
    writeDebugOverrides(state, 2);
    expect(hashCanonical(identityOverrides())).toBe(before);
    expect(hashCanonical(activeOverrides)).not.toBe(before);
    expect(overridesAreDefaults()).toBe(true);
  });

  it("a new wave forgets the plans of the waves before it; its enemies take the columns in turn, none past the plan", () => {
    const state = emptyDebugState();
    const first = { ...emptyEnemyPlan(), species: 1 };
    const third = { ...emptyEnemyPlan(), species: 4, level: 9 };
    state.plans["3"] = { ...emptyWavePlan(), battle: "wild", enemies: [first] };
    state.plans["4"] = { ...emptyWavePlan(), battle: "trainer", enemies: [first, { ...emptyEnemyPlan() }, third] };
    beginDebugWave(state, 4);
    expect(Object.keys(state.plans)).toEqual(["4"]);
    // (a column with nothing set plans nothing; every enemy made still counts)
    expect([1, 2, 3, 4].map(() => nextPlannedEnemy(state, 4))).toEqual([
      { slot: 0, plan: first },
      null,
      { slot: 2, plan: third },
      null,
    ]);
    beginDebugWave(state, 5);
    expect(state.made).toBe(0);
    expect(nextPlannedEnemy(state, 5)).toBeNull();
  });

  it("a wave's plan holds one plan per enemy and comes back as it was written; a bad one is refused", () => {
    const plan: WavePlan = {
      ...emptyWavePlan(),
      battle: "wild",
      enemies: [
        {
          ...emptyEnemyPlan(),
          species: 6,
          fusion: 94,
          shiny: 2,
          level: 50,
          boss: 1,
          ability: 22,
          nature: 10,
          gender: 1,
          tera: 1,
          moves: [53, 0, 0, 0],
          items: ["LEFTOVERS", "LEFTOVERS"],
        },
        null,
      ],
    };
    expect(isWavePlan(JSON.parse(JSON.stringify(plan)))).toBe(true);
    const enemy = plan.enemies[0]!;
    for (const bad of [
      { enemies: Array.from({ length: 7 }, () => null) },
      { enemies: [{ ...enemy, shiny: 3 }] },
      { enemies: [{ ...enemy, fusion: "x" }] },
      { enemies: [{ ...enemy, boss: 6 }] },
      { enemies: [{ ...enemy, moves: [1, 2, 3, 4, 5] }] },
      { enemies: [{ ...enemy, items: Array.from({ length: 9 }, () => "LEFTOVERS") }] },
      { enemies: [{ ...enemy, items: ["left overs"] }] },
      { species: [6] },
    ]) {
      expect(isWavePlan({ ...plan, ...bad }), JSON.stringify(bad)).toBe(false);
    }
  });

  it("an old save's plans are converted: species into the columns in turn, the wave's level, shiny and boss in each", () => {
    const old = {
      plans: {
        "4": { battle: "game", species: [6, 25], level: 30, shiny: true, boss: 3, trainer: null, encounter: null },
        "6": { battle: "trainer", species: [9], level: 0, shiny: false, boss: 0, trainer: 12, encounter: null },
        "7": { battle: "me", species: [], level: 0, shiny: null, boss: 0, trainer: null, encounter: 3 },
        "9": { nonsense: 1 },
      },
      rewards: ["RARE_CANDY"],
      jump: null,
      biome: 4,
      modes: { ...defaultModes(), freeShop: true },
      made: 0,
    };
    const read = readDebugState(JSON.parse(JSON.stringify(old)))!;
    expect(isDebugState(read)).toBe(true);
    expect(Object.keys(read.plans)).toEqual(["4", "6", "7"]);
    expect(read.plans["4"].battle).toBe("wild");
    expect(read.plans["4"].enemies.map(e => [e?.species, e?.level, e?.shiny, e?.boss])).toEqual([
      [6, 30, 0, 3],
      [25, 30, 0, 3],
    ]);
    expect(read.plans["6"]).toMatchObject({ battle: "trainer", trainer: 12 });
    expect(read.plans["6"].enemies.map(e => [e?.species, e?.shiny])).toEqual(Array.from({ length: 6 }, () => [9, -1]));
    expect(read.plans["7"]).toEqual({ ...emptyWavePlan(), battle: "me", encounter: 3 });
    expect([read.rewards, read.biome, read.modes.freeShop]).toEqual([["RARE_CANDY"], 4, true]);
    // what cannot be read is dropped, the rest kept; nothing at all to read: none
    expect(readDebugState({ ...read, jump: -1, biome: 5 })).toMatchObject({ jump: null, biome: 5 });
    expect(readDebugState("debug")).toBeNull();
  });

  it("the state goes into the save block and is read back; a damaged one does not refuse the save", () => {
    const state = emptyDebugState();
    expect(isEmptyDebugState(state)).toBe(true);
    state.jump = 30;
    state.plans["8"] = { ...emptyWavePlan(), battle: "me", encounter: 4 };
    expect(isEmptyDebugState(state)).toBe(false);
    const saved = JSON.parse(JSON.stringify(state));
    expect(isDebugState(saved)).toBe(true);
    const block = {
      version: COOP_SAVE_VERSION,
      accountIds: { host: "h", guest: "g" },
      owners: { "10": "host", "20": "guest" },
      rewardPickCount: 0,
      trades: 0,
      accounts: {
        host: {
          trainerId: 1,
          secretId: 2,
          unlocked: { eviolite: false, miniBlackHole: false },
          caught: {},
          eggMoves: {},
        },
        guest: {
          trainerId: 3,
          secretId: 4,
          unlocked: { eviolite: false, miniBlackHole: false },
          caught: {},
          eggMoves: {},
        },
      },
    };
    expect(isCoopSaveBlock({ ...block, debug: saved })).toBe(true);
    // (a debug state that cannot be read never refuses the save: it is read back without what is damaged)
    expect(isCoopSaveBlock({ ...block, debug: { ...saved, jump: -1 } })).toBe(true);
    expect(isCoopSaveBlock({ ...block, debug: { plans: { "8": { battle: "game", species: [4] } } } })).toBe(true);
    expect(isCoopSaveBlock(block)).toBe(true);
  });
});

describe("Co-op debug menu: exact items (D42, amended)", () => {
  afterEach(() => writeDebugOverrides(null, 0));

  it("an item is its key, or its key and which one of the family", () => {
    expect(itemId("RARE_CANDY")).toBe("RARE_CANDY");
    expect(itemId("EVOLUTION_ITEM", 12)).toBe("EVOLUTION_ITEM:12");
    expect(itemId("SPECIES_STAT_BOOSTER", "LIGHT_BALL")).toBe("SPECIES_STAT_BOOSTER:LIGHT_BALL");
    expect(itemId("MYSTERY_ENCOUNTER_SHUCKLE_JUICE", -15)).toBe("MYSTERY_ENCOUNTER_SHUCKLE_JUICE:-15");
    expect(parseItemId("EVOLUTION_ITEM:12")).toEqual({ key: "EVOLUTION_ITEM", arg: 12 });
    expect(parseItemId("SPECIES_STAT_BOOSTER:LIGHT_BALL")).toEqual({ key: "SPECIES_STAT_BOOSTER", arg: "LIGHT_BALL" });
    expect(parseItemId("MYSTERY_ENCOUNTER_SHUCKLE_JUICE:-15")).toEqual({
      key: "MYSTERY_ENCOUNTER_SHUCKLE_JUICE",
      arg: -15,
    });
    expect(parseItemId("RARE_CANDY")).toEqual({ key: "RARE_CANDY", arg: null });
    for (const bad of ["", "rare_candy", "EVOLUTION_ITEM:", "EVOLUTION_ITEM:1:2", "EVOLUTION_ITEM:light", "A B", 7]) {
      expect(isItemId(bad), String(bad)).toBe(false);
    }
  });

  it("a batch may give or offer an exact item", () => {
    const exact: DebugAction[] = [
      { t: "item", p: 1, item: "ATTACK_TYPE_BOOSTER:9", count: 1 },
      { t: "item", p: 1, item: "RARE_FORM_CHANGE_ITEM:3", count: 1 },
      { t: "rewards", items: ["EVOLUTION_ITEM:12", "TM_ULTRA:89", "RARE_CANDY"] },
    ];
    for (const action of exact) {
      expect(isDebugAction(JSON.parse(JSON.stringify(action))), JSON.stringify(action)).toBe(true);
    }
    expect(isDebugAction({ t: "rewards", items: ["EVOLUTION_ITEM:x y"] })).toBe(false);
  });

  it("the next reward screen's items, exact or of a tier, are not written to the game's item override", () => {
    const state = emptyDebugState();
    state.rewards = ["EVOLUTION_ITEM:12", "SPECIES_STAT_BOOSTER:LIGHT_BALL", "MASTER_BALL", "TIER:MASTER"];
    writeDebugOverrides(state, 4);
    // the reward screen places them itself (`debug/rewards.ts`), in the host's order
    expect(activeOverrides.ITEM_REWARD_OVERRIDE).toEqual(defaultOverrides.ITEM_REWARD_OVERRIDE);
    expect(isDebugAction({ t: "rewards", items: ["TIER:MASTER", "RARE_CANDY"] })).toBe(true);
  });
});

describe("Co-op debug menu: the change log (D42, amended)", () => {
  afterEach(() => {
    setDebugSink(null);
    clearDebugQueue();
  });

  it("a change replaces the pending change to the same thing; the others keep their order", () => {
    queueDebugChange("Pikachu: level 50", "level:1", { t: "level", p: 1, v: 50 });
    queueDebugChange("Wave won", null, { t: "win" });
    queueDebugChange("Pikachu: level 70", "level:1", { t: "level", p: 1, v: 70 });
    expect(debugChanges().map(change => change.note)).toEqual(["Wave won", "Pikachu: level 70"]);
    expect(takeDebugBatch().actions).toEqual([{ t: "win" }, { t: "level", p: 1, v: 70 }]);
  });

  it("a pending change can be cancelled; one already sent cannot", () => {
    const first = queueDebugChange("Team healed", null, { t: "heal", p: null });
    const second = queueDebugChange("Money: 5", "money", { t: "money", v: 5 });
    expect(cancelDebugChange(first.id)).toBe(true);
    expect(waitingDebug()).toEqual([{ t: "money", v: 5 }]);
    takeDebugBatch();
    expect(cancelDebugChange(second.id)).toBe(false);
    expect(debugChanges().map(change => change.state)).toEqual(["sent"]);
  });

  it("a change of several actions travels whole; a sent batch is applied where it took effect", () => {
    const everyone = queueDebugChange(
      "Everyone: level 100",
      null,
      { t: "level", p: 1, v: 100 },
      { t: "level", p: 2, v: 100 },
    );
    const batch = takeDebugBatch();
    expect(batch.actions).toHaveLength(2);
    debugBatchApplied(JSON.parse(JSON.stringify(batch)), { wave: 7, turn: 3 });
    const applied = debugChanges().find(change => change.id === everyone.id);
    expect(applied?.state).toBe("applied");
    expect(applied?.where).toEqual({ wave: 7, turn: 3 });
  });

  it("a batch that could not be sent is pending again, at the front", () => {
    queueDebugChange("Wave won", null, { t: "win" });
    const batch = takeDebugBatch();
    queueDebugChange("Money: 9", "money", { t: "money", v: 9 });
    requeueDebug(batch);
    expect(debugChanges().map(change => [change.note, change.state])).toEqual([
      ["Wave won", "pending"],
      ["Money: 9", "pending"],
    ]);
    expect(waitingDebug()).toEqual([{ t: "win" }, { t: "money", v: 9 }]);
  });
});

describe("Co-op debug menu: the host's queue (D42)", () => {
  afterEach(() => {
    setDebugSink(null);
    clearDebugQueue();
  });

  it("cheats wait for the next turn, which takes them all", () => {
    queueDebug({ t: "win" }, { t: "heal", p: null });
    expect(waitingDebug()).toHaveLength(2);
    expect(takeDebugBatch().actions).toEqual([{ t: "win" }, { t: "heal", p: null }]);
    expect(takeDebugBatch().actions).toEqual([]);
  });

  it("an open reward screen sends at once; one it cannot send waits for the next step", () => {
    const sent: unknown[] = [];
    let accepts = true;
    setDebugSink(batch => {
      if (accepts) {
        sent.push(batch);
      }
      return accepts;
    });
    expect(debugSendsNow()).toBe(true);
    queueDebug({ t: "money", v: 5 });
    expect(sent).toEqual([{ actions: [{ t: "money", v: 5 }] }]);
    accepts = false;
    queueDebug({ t: "win" });
    expect(waitingDebug()).toEqual([{ t: "win" }]);
    accepts = true;
    setDebugSink(batch => {
      sent.push(batch);
      return true;
    });
    expect(waitingDebug()).toEqual([]);
    expect(sent).toHaveLength(2);
  });
});
