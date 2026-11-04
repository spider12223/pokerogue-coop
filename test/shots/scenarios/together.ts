/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

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
    // the others choose their moves, then wait for the one who is gone
    await run.drive({ until: states => states.some(state => state.seat !== vars.seat && state.away !== null) });
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

export const togetherScenarios: Scenario[] = [chat, pings, away, reconnect, debugWindow];
