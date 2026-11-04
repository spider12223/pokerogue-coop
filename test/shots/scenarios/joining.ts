/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { enableThreePlayers, openCoopMenu } from "../../e2e/coop-client.ts";
import type { ShotRun } from "../engine.ts";
import type { Scenario } from "../scenario.ts";

/** From the title screen to the first wave: the co-op menu, hosting and joining, the starter select */

/** Wait until the option menu that is open has this entry */
async function untilMenu(run: ShotRun, label: string): Promise<void> {
  await run.waitFor("host", `the menu with "${label}"`, async () => (await run.state("host")).menu.includes(label));
}

const title: Scenario = {
  id: "join:title",
  area: "Joining",
  summary: "the title screen, then the co-op menu",
  async play(run) {
    await run.open();
    await run.shot("title");
    await openCoopMenu(run.host);
    await run.shot("coop-menu");
  },
};

const lobby: Scenario = {
  id: "join:lobby",
  area: "Joining",
  summary: "the host makes a room (players, run mode, join code), each guest joins with the code",
  async play(run, vars) {
    await run.open();
    if (vars.players === "3") {
      await enableThreePlayers(run.host);
    }
    await openCoopMenu(run.host);
    await run.shot("coop-menu");
    await run.press("host", "ACTION");
    if (vars.players === "3") {
      await untilMenu(run, "3 players (Beta)");
      await run.shot("players-question");
      await run.press("host", "DOWN");
      await run.host.page.waitForTimeout(200);
      await run.press("host", "ACTION");
    }
    const mode = vars.mode === "endless" ? "Endless" : "Classic";
    await untilMenu(run, mode);
    await run.shot("run-mode-question");
    if (vars.mode === "endless") {
      await run.press("host", "DOWN");
      await run.host.page.waitForTimeout(200);
    }
    await run.press("host", "ACTION");
    const code = await run.waitFor(
      "host",
      "a join code",
      async () => (await run.eval<string | null>("host", "joinCode")) ?? false,
    );
    await run.shot("host-waiting-with-code");
    for (const seat of run.guests) {
      await run.openJoinForm(seat);
      await run.shot(`${seat}-join-form`);
      await run.submitCode(seat, code);
      await run.shot(`${seat}-joined`);
    }
    for (const seat of run.seats) {
      await run.waitFor(
        seat,
        "the starter select",
        async () => (await run.state(seat)).ui === "STARTER_SELECT",
        60_000,
      );
    }
    await run.shot("starter-select");
  },
};

const starters: Scenario = {
  id: "join:starters",
  area: "Joining",
  summary: "the co-op starter select: each player picks and is ready in turn, the others see it; then the run starts",
  async play(run) {
    await run.link();
    await run.shot("starter-select");
    for (const seat of run.seats) {
      await run.pickParty(seat);
      await run.shot(`${seat}-picked`);
      await run.client(seat).page.waitForTimeout(500);
      await run.pressFor(seat, "SUBMIT", "CONFIRM");
      await run.shot(`${seat}-ready-question`);
      await run.pressFor(seat, "ACTION", "STARTER_SELECT");
      await run.shot(`${seat}-ready`);
    }
    await run.drive({ until: states => states.every(state => state.ui === "COMMAND") });
  },
};

export const joiningScenarios: Scenario[] = [title, lobby, starters];
