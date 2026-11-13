/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Locator, Page } from "@playwright/test";
import { type ClientState, choose, type ShotRun } from "../engine.ts";
import type { Scenario } from "../scenario.ts";
import { partnerOf } from "../variables.ts";

/** What only co-op has around the game: the chat (D38), pings and emotes (D16), a player away (D17), a reload (D20), the
 * host's debug window (D42) */

const atCommand = (states: ClientState[]) => states.every(state => state.ui === "COMMAND");

const chat: Scenario = {
  id: "coop:chat",
  area: "Co-op",
  summary: "--seat opens the chat in a battle, types a line and sends it; the others see it",
  vars: { seat: null },
  async play(run, vars) {
    await run.toRun();
    await run.drive({ until: atCommand, shoot: () => false });
    const page = run.client(vars.seat).page;
    await page.keyboard.press("KeyH");
    await run.waitFor(
      vars.seat,
      "the chat box",
      async () => (await run.eval<{ open: boolean } | null>(vars.seat, "chat"))?.open ?? false,
    );
    await run.shot("chat-open", true);
    await page.keyboard.type(`Hi from ${vars.seat}!`);
    await run.shot("typed", true);
    await page.keyboard.press("Enter");
    for (const seat of run.seats) {
      await run.waitFor(seat, "the line", async () =>
        ((await run.eval<{ lines: string[] } | null>(seat, "chat"))?.lines ?? []).some(line =>
          line.includes(`Hi from ${vars.seat}!`),
        ),
      );
    }
    await run.shot("sent", true);
  },
};

const pings: Scenario = {
  id: "coop:ping",
  area: "Co-op",
  summary: "--seat pings (P) and opens the emote wheel (Q) and sends an emote, in a battle; the others see them",
  vars: { seat: null },
  async play(run, vars) {
    await run.toRun();
    await run.drive({ until: atCommand, shoot: () => false });
    const page = run.client(vars.seat).page;
    await page.keyboard.press("KeyP");
    await page.waitForTimeout(600);
    await run.shot("ping", true);
    await page.keyboard.press("KeyQ");
    await page.waitForTimeout(600);
    await run.shot("emote-wheel", true);
    await run.client(vars.seat).page.evaluate(() => (window as any).__coop.emote(2));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    await run.shot("emote", true);
  },
};

const away: Scenario = {
  id: "coop:afk",
  area: "Co-op",
  summary:
    "--seat does not choose its move: the others are told, --to takes over its turn (D17); --seat comes back after it",
  vars: { seat: "guest", to: null },
  async play(run, vars) {
    const taker = partnerOf(vars);
    await run.toRun();
    // a hint after 3 s, the offer to take over after 6 s
    for (const seat of run.seats) {
      await run.client(seat).page.evaluate(() => (window as any).__coop.setAfkTimers(3000, 6000));
    }
    let tookOver = false;
    // the away player comes back once the turn taken over has been played: its own answer is then refused, and its
    // screen says who took over (D17)
    let back = false;
    await run.drive({
      until: states =>
        back && states.every(state => (state.turn >= 2 && state.ui === "COMMAND") || state.ui === "MODIFIER_SELECT"),
      answer: (state, states) => {
        if (state.seat === vars.seat && !back) {
          const theirs = states.find(other => other.seat === taker);
          back =
            tookOver && theirs !== undefined && theirs.phase !== "CoopTurnSyncPhase" && theirs.phase !== "CommandPhase";
          if (!back) {
            return null;
          }
        }
        if (state.seat === taker && state.menu.includes("Take over")) {
          tookOver = true;
          return choose(state, "Take over");
        }
        return;
      },
    });
  },
};

/**
 * `seat`'s tab goes away in a battle, the others wait; it comes back on the game's page and rejoins by itself (D20)
 * @param beforeGone - What happens in the battle just before the tab goes
 */
async function goneAndBack(
  run: ShotRun,
  seat: Parameters<ShotRun["client"]>[0],
  beforeGone?: () => Promise<void>,
): Promise<void> {
  // a rejoin compares the overrides (D1), and a reloaded page has none: this run has none either
  await run.toRun({}, { plain: true });
  await run.drive({ until: atCommand, shoot: () => false });
  await beforeGone?.();
  await run.shot("before");
  // gone (a reload is over before the others' screens can be shot), then back on the game's page
  const page = run.client(seat).page;
  await page.goto("about:blank");
  // the others choose their moves, then wait for the one who is gone: the reconnect screen in a game of two, the turn's
  // "Waiting for …" in a game of three (the one who is gone comes in at the next wave start, D40)
  await run.drive({
    until: states =>
      states.some(
        state =>
          state.seat !== seat
          && (state.away !== null || (state.phase === "CoopTurnSyncPhase" && state.ui === "MESSAGE")),
      ),
  });
  await page.goto("/");
  await run.drive({
    until: states => states.every(state => state.ui === "COMMAND" && state.linked),
    maxSteps: 60,
  });
}

const reconnect: Scenario = {
  id: "coop:reload",
  area: "Co-op",
  summary:
    "--seat's tab goes away in a battle: the others wait with the room code; it comes back, rejoins by itself (D20)",
  vars: { seat: "guest" },
  async play(run, vars) {
    await goneAndBack(run, vars.seat);
  },
};

/** The host's setting "Co-op Debug Menu (Host)" (D42), as the host would turn it in the settings */
async function setHostDebugMenu(run: ShotRun, on: boolean): Promise<void> {
  await run.host.page.evaluate(
    async ({ path, value }) => {
      const { settings } = await import(path);
      settings.update("coop", "debugMenu", value);
    },
    { path: "/src/globals/global-settings-manager.ts", value: on },
  );
}

/** Play on until every player is on the command menu of a later turn than the host's now */
async function playATurn(run: ShotRun): Promise<void> {
  const { wave, turn } = await run.state("host");
  await run.drive({
    until: states => states.every(state => state.ui === "COMMAND" && (state.wave > wave || state.turn > turn)),
    shoot: () => false,
    maxSteps: 120,
  });
}

const reconnectWithDebug: Scenario = {
  id: "coop:reload-debug",
  area: "Co-op",
  summary:
    "coop:reload with the host's debug menu on (D42): every turn has the host's debug batch; a turn is played after --seat is back",
  vars: { seat: "guest" },
  async play(run, vars) {
    await run.open();
    await setHostDebugMenu(run, true);
    await goneAndBack(run, vars.seat);
    // (the one who came back waits for the host's debug batch of the turn like the others, or the turn is a desync)
    await playATurn(run);
  },
};

const reconnectAfterDebugOff: Scenario = {
  id: "coop:reload-debug-off",
  area: "Co-op",
  summary:
    "the host turns its debug menu off in the middle of a run that has it, then --seat's tab goes away and comes back: the run keeps the menu (D42); a turn is played",
  vars: { seat: "host" },
  async play(run, vars) {
    await run.open();
    await setHostDebugMenu(run, true);
    await goneAndBack(run, vars.seat, () => setHostDebugMenu(run, false));
    await playATurn(run);
  },
};

const debugWindow: Scenario = {
  id: "coop:debug-window",
  area: "Co-op",
  summary: "the host turns the debug menu on and presses F8: its window beside the game (D42); the guests have none",
  async play(run) {
    await run.open();
    await run.host.page.evaluate(async path => {
      const { settings } = await import(path);
      settings.update("coop", "debugMenu", true);
    }, "/src/globals/global-settings-manager.ts");
    await run.toRun();
    await run.drive({ until: atCommand, shoot: () => false });
    const opened = run.host.page.waitForEvent("popup");
    await run.host.page.keyboard.press("F8");
    const popup = await opened;
    await popup.setViewportSize({ width: 1340, height: 900 });
    await popup.locator("#coopDebug .cdw-live .cdw-mon").first().waitFor();
    await popup.evaluate(() => document.fonts.ready);
    run.watch("debug window", popup);
    await run.shot("opened", true);
  },
};

/** Type into a search list of the debug window and pick what comes up first */
async function pickInWindow(box: Locator, text: string): Promise<void> {
  await box.click();
  await box.fill(text);
  await box.press("Enter");
}

const debugWaves: Scenario = {
  id: "coop:debug-waves",
  area: "Co-op",
  summary:
    "the host plans the next battle in the debug window's Waves tab (D42 amended): Charizard fused with Gengar, ★★★, Lv 50, More open; a trainer's team; a Master-tier item among Game picks; then the battle and its reward screen on every screen",
  async play(run) {
    await run.open();
    await run.host.page.evaluate(async path => {
      const { settings } = await import(path);
      settings.update("coop", "debugMenu", true);
    }, "/src/globals/global-settings-manager.ts");
    await run.toRun();
    await run.drive({ until: atCommand, shoot: () => false });
    const opened = run.host.page.waitForEvent("popup");
    await run.host.page.keyboard.press("F8");
    const popup = await opened;
    await popup.setViewportSize({ width: 1340, height: 900 });
    const root = popup.locator("#coopDebug");
    await root.locator(".cdw-live .cdw-mon").first().waitFor();
    await popup.evaluate(() => document.fonts.ready);
    run.watch("debug window", popup);

    await root.locator(".cdw-tabs button", { hasText: "Waves" }).click();
    await run.shot("waves-empty", true);
    const first = () => root.locator(".cdw-ecol").first();
    await pickInWindow(first().locator(".cdw-pick input").first(), "Charizard");
    await pickInWindow(first().locator(".cdw-pick input").nth(1), "Gengar");
    await first().locator(".cdw-seg button", { hasText: "★★★" }).click();
    const level = first().locator('[data-keep="plan-0-level"]');
    await level.fill("50");
    await level.press("Enter");
    await first().locator(".cdw-morebtn").click();
    await first().locator(".cdw-morebox select").first().selectOption({ index: 11 });
    await pickInWindow(first().locator(".cdw-morebox .cdw-pick input").last(), "Leftovers");
    await popup.waitForTimeout(200);
    await run.shot("planned", true);

    // A later wave: a trainer and its team
    const wave = root.locator('[data-keep="plan-wave"]');
    await wave.fill("3");
    await wave.press("Enter");
    await root.locator(".cdw-seg button", { hasText: "Trainer" }).click();
    await pickInWindow(root.locator('[data-keep="plan-trainer"]'), "Lance");
    await root.locator("button", { hasText: "+ Add a team member" }).click();
    await pickInWindow(first().locator(".cdw-pick input").first(), "Dragonite");
    await popup.waitForTimeout(200);
    await run.shot("trainer", true);

    // Game picks: a Master-tier item for the next reward screen
    await root.locator(".cdw-tabs button", { hasText: "Rewards & Shop" }).click();
    await root.locator('[data-family="random"]').click();
    await root.locator(".cdw-items .cdw-item", { hasText: "Master-tier item" }).click();
    await popup.waitForTimeout(200);
    await run.shot("game-picks", true);

    // Win this wave: its reward screen starts with the Master-tier item, then the planned battle
    await root.locator(".cdw-tabs button", { hasText: "Waves" }).click();
    await root.locator(".cdw-quick button", { hasText: "Win" }).first().click();
    await run.drive({
      until: states => states.every(state => state.ui === "MODIFIER_SELECT" && state.reward?.ready === true),
      shoot: () => false,
    });
    await run.shot("reward-screen", true);
    // (its picker skips it: cancel, then "yes"; the others wait)
    await run.drive({
      until: states => states.every(state => state.wave === 2 && state.ui === "COMMAND"),
      answer: state => {
        if (state.ui !== "MODIFIER_SELECT") {
          return;
        }
        return state.reward?.ready && state.reward.picker === state.seat ? { press: "CANCEL" } : null;
      },
      shoot: () => false,
    });
    await run.shot("battle", true);
  },
};

/** Where the hide handle of a box of the field is on the page: an enemy's or ours, and the field index (D44) */
async function handleOnPage(page: Page, enemy: boolean, index: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    async ([path, isEnemy, at]) => {
      const { globalScene } = await import(path as string);
      const pokemon = (isEnemy ? globalScene.getEnemyField() : globalScene.getPlayerField())[at as number];
      const handle = pokemon.getBattleInfo().getByName("coop_hide");
      const point = handle.getWorldTransformMatrix().transformPoint(4.5, 0);
      const rect = (globalScene.game.canvas as HTMLCanvasElement).getBoundingClientRect();
      return {
        x: rect.left + (point.x * rect.width) / globalScene.game.canvas.width,
        y: rect.top + (point.y * rect.height) / globalScene.game.canvas.height,
      };
    },
    ["/src/globals/global-scene.ts", enemy, index] as const,
  );
}

const view: Scenario = {
  id: "coop:view",
  area: "Co-op",
  summary:
    "--seat zooms its battlefield out (numpad minus, then the wheel), sees a partner's move on the zoomed field, and hides an enemy's HP box and its own with their handles (D44); the others' screens do not change",
  vars: { seat: null },
  async play(run, vars) {
    await run.toRun();
    await run.drive({ until: atCommand, shoot: () => false });
    const page = run.client(vars.seat).page;
    await run.shot("before", true);
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press("NumpadSubtract");
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(500);
    await run.shot("zoom-80", true);
    const canvas = await page.locator("canvas").boundingBox();
    if (canvas !== null) {
      await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 3);
    }
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(400);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(700);
    await run.shot("zoom-60", true);
    // a partner picks a move: its tag and target pointer on this player's zoomed field
    const partner = run.seats.find(seat => seat !== vars.seat);
    if (partner !== undefined) {
      await run.pressFor(partner, "ACTION", "FIGHT");
      await run.pressFor(partner, "ACTION", "TARGET_SELECT");
      await page.waitForTimeout(700);
      await run.shot("partner-aims", true);
    }
    const enemyHandle = await handleOnPage(page, true, 0);
    await page.mouse.click(enemyHandle.x, enemyHandle.y);
    await page.waitForTimeout(600);
    const mineHandle = await handleOnPage(page, false, 0);
    await page.mouse.click(mineHandle.x, mineHandle.y);
    await page.waitForTimeout(600);
    await run.shot("boxes-hidden", true);
    const back = await handleOnPage(page, true, 0);
    await page.mouse.click(back.x, back.y);
    await page.waitForTimeout(600);
    await run.shot("enemy-box-back", true);
  },
};

export const togetherScenarios: Scenario[] = [
  chat,
  pings,
  away,
  reconnect,
  reconnectWithDebug,
  reconnectAfterDebugOff,
  debugWindow,
  debugWaves,
  view,
];
