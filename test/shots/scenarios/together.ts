/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Page } from "@playwright/test";
import { type ClientState, choose } from "../engine.ts";
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

const reconnect: Scenario = {
  id: "coop:reload",
  area: "Co-op",
  summary:
    "--seat's tab goes away in a battle: the others wait with the room code; it comes back, rejoins by itself (D20)",
  vars: { seat: "guest" },
  async play(run, vars) {
    // a rejoin compares the overrides (D1), and a reloaded page has none: this run has none either
    await run.toRun({}, { plain: true });
    await run.drive({ until: atCommand, shoot: () => false });
    await run.shot("before");
    // gone (a reload is over before the others' screens can be shot), then back on the game's page
    const page = run.client(vars.seat).page;
    await page.goto("about:blank");
    // the others choose their moves, then wait for the one who is gone: the reconnect screen in a game of two, the turn's
    // "Waiting for …" in a game of three (the one who is gone comes in at the next wave start, D40)
    await run.drive({
      until: states =>
        states.some(
          state =>
            state.seat !== vars.seat
            && (state.away !== null || (state.phase === "CoopTurnSyncPhase" && state.ui === "MESSAGE")),
        ),
    });
    await page.goto("/");
    await run.drive({
      until: states => states.every(state => state.ui === "COMMAND" && state.linked),
      maxSteps: 60,
    });
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
      settings.update("general", "coopDebugMenu", true);
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

export const togetherScenarios: Scenario[] = [chat, pings, away, reconnect, debugWindow, view];
