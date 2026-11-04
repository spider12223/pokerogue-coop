/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Action, ClientState, ShotRun } from "../engine.ts";
import type { Scenario } from "../scenario.ts";
import { partnerOf, type Seat, seatsOf, type Vars } from "../variables.ts";

/** After a wave: the reward screen (each player's turn to pick, D9), the shop, a reroll, a trade (D11), the biome */

/** The reward screen's rows for `moveRewardCursor`: the buttons, the rewards, the shop */
const BUTTONS = 0;
const REWARDS = 1;
const SHOP = 2;
/** The buttons' entries: Reroll, then the Trade button of a linked run (`TRADE_CURSOR` of the reward screen) */
const REROLL = 0;
const TRADE = 4;

/** The first reward of every screen is `--item`, if one is given */
function itemOverrides(vars: Vars): Record<string, unknown> {
  return vars.item === "" ? {} : { ITEM_REWARD_OVERRIDE: [{ name: vars.item }] };
}

const onScreen = (state: ClientState, screen: number): boolean =>
  state.ui === "MODIFIER_SELECT" && state.reward?.screen === screen && state.reward.ready;

/**
 * Play to the reward screen `--seat` picks on (the host's is the first, D9), without shooting the way there: the players
 * before them skip theirs
 */
async function toPickersScreen(run: ShotRun, vars: Vars): Promise<number> {
  const screen = seatsOf(vars.players).indexOf(vars.seat);
  await run.drive({
    until: states => states.some(state => onScreen(state, screen)),
    shoot: () => false,
    answer: skipping(at => at < screen),
  });
  for (const seat of run.seats) {
    await run.waitFor(seat, `reward screen ${screen + 1}`, async () => onScreen(await run.state(seat), screen), 30_000);
  }
  return screen;
}

/**
 * On a reward screen, its picker skips it (cancel, then "yes") when `skip` says so of its number; the others wait.
 * Elsewhere the bot answers.
 */
function skipping(skip: (screen: number) => boolean): (state: ClientState) => Action | null | undefined {
  return state => {
    if (state.ui !== "MODIFIER_SELECT") {
      return;
    }
    const { reward } = state;
    return reward?.ready && reward.picker === state.seat && skip(reward.screen) ? { press: "CANCEL" } : null;
  };
}

/** Move the reward screen's cursor, as the arrows would */
async function rewardCursor(run: ShotRun, seat: Seat, row: number, entry: number): Promise<void> {
  if (
    !(await run.client(seat).page.evaluate(([r, c]) => (window as any).__coop.moveRewardCursor(r, c), [row, entry]))
  ) {
    throw new Error(`${seat} has no reward screen to move on`);
  }
}

/**
 * The party screen of a reward that needs a target: the acting player's first Pokémon; if the item can do nothing for it
 * (a Potion at full HP) the screen comes back, and then it is left. The reward screen itself waits.
 */
function targetOnce(seat: Seat): (state: ClientState) => Action | null | undefined {
  let chosen = false;
  return state => {
    if (state.ui === "MODIFIER_SELECT") {
      return null;
    }
    if (state.seat !== seat || state.ui !== "PARTY" || state.phase !== "SelectModifierPhase") {
      return;
    }
    if (chosen) {
      return { press: "CANCEL" };
    }
    chosen = true;
    return { member: state.party.findIndex(member => member.owner === seat) };
  };
}

/** Until the next wave's first command menu: what a pick or a trade leads to (a target, a move to forget, a trade) */
const nextWave = (wave: number) => (states: ClientState[]) =>
  states.some(state => state.wave > wave && state.ui === "COMMAND");

const rewards: Scenario = {
  id: "wave:rewards",
  area: "Between waves",
  summary: "the reward screen of --seat (the others watch), the first reward taken (on whom), until the next wave",
  vars: { seat: null, item: null, wave: null },
  async play(run, vars) {
    await run.toRun(itemOverrides(vars));
    await toPickersScreen(run, vars);
    await run.shot("reward-screen");
    await rewardCursor(run, vars.seat, REWARDS, 0);
    await run.shot("first-reward");
    const wave = (await run.state("host")).wave;
    await run.press(vars.seat, "ACTION");
    await run.drive({ until: nextWave(wave), answer: targetOnce(vars.seat) });
  },
};

const shop: Scenario = {
  id: "wave:shop",
  area: "Between waves",
  summary: "--seat buys the shop's first item (on whom), on the screen it picks on",
  vars: { seat: null, wave: null, money: 20_000 },
  async play(run, vars) {
    await run.toRun();
    await toPickersScreen(run, vars);
    await rewardCursor(run, vars.seat, SHOP, 0);
    await run.shot("shop-item");
    await run.press(vars.seat, "ACTION");
    await run.drive({
      // bought (or left): the screen is back and takes input again
      until: states => states.every(state => state.ui === "MODIFIER_SELECT" && state.reward?.ready === true),
      answer: targetOnce(vars.seat),
    });
  },
};

const reroll: Scenario = {
  id: "wave:reroll",
  area: "Between waves",
  summary: "--seat rerolls the rewards of the screen it picks on",
  vars: { seat: null, wave: null, money: 20_000 },
  async play(run, vars) {
    await run.toRun();
    await toPickersScreen(run, vars);
    await run.shot("before");
    await rewardCursor(run, vars.seat, BUTTONS, REROLL);
    await run.shot("reroll-button");
    await run.press(vars.seat, "ACTION");
    await run.drive({
      until: states => states.every(state => state.ui === "MODIFIER_SELECT" && state.reward?.ready === true),
      answer: state => (state.ui === "MODIFIER_SELECT" ? null : undefined),
    });
  },
};

/** The trade screen's sides: the player's list, the partner's list beside it, the action bar under both */
const THEIRS = 1;
const ACTION_BAR = 2;

/** The arrow that moves the trade cursor from side `from` (at entry `at`) towards entry `index` of side `side` */
function towards(from: number, at: number, side: number, index: number): string {
  if (from !== side) {
    if (side === ACTION_BAR) {
      return "DOWN";
    }
    if (from === ACTION_BAR) {
      return "UP";
    }
    return side === THEIRS ? "RIGHT" : "LEFT";
  }
  if (side === ACTION_BAR) {
    return at < index ? "RIGHT" : "LEFT";
  }
  return at < index ? "DOWN" : "UP";
}

/** On the trade screen: put the cursor on a list's row (0: mine, 1: theirs) or the action bar (2), by pressing */
async function tradeCursor(run: ShotRun, seat: Seat, side: number, index: number): Promise<void> {
  for (let presses = 0; presses < 20; presses++) {
    const trade = (await run.state(seat)).trade;
    if (trade === null) {
      throw new Error(`${seat} has no trade screen`);
    }
    const at = side === ACTION_BAR ? trade.cursor.action : trade.cursor.row;
    if (trade.cursor.side === side && at === index) {
      return;
    }
    await run.press(seat, towards(trade.cursor.side, at, side, index));
    await run.client(seat).page.waitForTimeout(150);
  }
  throw new Error(`${seat} could not put the trade cursor on side ${side}, entry ${index + 1}`);
}

/** On the trade screen: choose an action of the bar by its label */
async function tradeAction(run: ShotRun, seat: Seat, label: string): Promise<void> {
  await run.waitFor(
    seat,
    `the trade action "${label}"`,
    async () => (await run.state(seat)).trade?.actions.includes(label) ?? false,
  );
  const actions = (await run.state(seat)).trade?.actions ?? [];
  await tradeCursor(run, seat, ACTION_BAR, actions.indexOf(label));
  await run.press(seat, "ACTION");
}

const trade: Scenario = {
  id: "wave:trade",
  area: "Between waves",
  summary: "--seat asks for a trade, gives its first Pokémon for the first of --to, who accepts; everyone is done",
  vars: { seat: null, to: null },
  async play(run, vars) {
    const to = partnerOf(vars);
    await run.toRun();
    await toPickersScreen(run, { ...vars, seat: "host" });
    await rewardCursor(run, vars.seat, BUTTONS, TRADE);
    await run.shot("trade-button");
    await run.press(vars.seat, "ACTION");
    await run.waitFor(
      vars.seat,
      "the trade asked for",
      async () => (await run.state(vars.seat)).reward?.tradeRequested ?? false,
    );
    await run.shot("trade-asked");
    // the host's screen ends (it skips), then the trade screen opens for everyone
    await run.press("host", "CANCEL");
    await run.drive({
      until: states => states.every(state => state.ui === "COOP_TRADE"),
      answer: state => (state.ui === "MODIFIER_SELECT" ? null : undefined),
    });
    const before = await run.state(vars.seat);
    const give = before.trade?.mine[0];
    const want =
      before.trade?.theirs.findIndex(id => before.party.find(member => member.id === id)?.owner === to) ?? -1;
    if (give === undefined || want === -1) {
      throw new Error(`${vars.seat} has nothing to give, or ${to} nothing to get`);
    }
    await tradeCursor(run, vars.seat, 0, 0);
    await run.press(vars.seat, "ACTION");
    await tradeCursor(run, vars.seat, THEIRS, want);
    await run.press(vars.seat, "ACTION");
    await run.shot("picked");
    await tradeAction(run, vars.seat, "Propose");
    await run.waitFor(to, "the proposal", async () => (await run.state(to)).trade?.mode === "answer");
    await run.shot("proposal");
    await tradeAction(run, to, "Accept");
    await run.waitFor(
      vars.seat,
      "the trade made",
      async () => (await run.state(vars.seat)).party.find(m => m.id === give)?.owner === to,
    );
    await run.shot("traded");
    for (const seat of run.seats) {
      await tradeAction(run, seat, "Done");
      await run.shot(`${seat}-done`);
    }
    await run.drive({ until: nextWave(before.wave) });
  },
};

const biome: Scenario = {
  id: "wave:biome",
  area: "Between waves",
  summary: "the end of a biome with a Map: the choice of the next biome, until its first wave",
  vars: { wave: 10 },
  async play(run, vars) {
    await run.toRun({ STARTING_MODIFIER_OVERRIDE: [{ name: "MAP" }] });
    await run.drive({
      until: states => states.some(state => state.wave > vars.wave && state.ui === "COMMAND"),
      // the reward screen is skipped by its picker; the biome is the first of the map
      shoot: states => states.some(state => state.phase === "SelectBiomePhase" || state.wave > vars.wave),
      answer: skipping(() => true),
    });
  },
};

export const betweenWavesScenarios: Scenario[] = [rewards, shop, reroll, trade, biome];
