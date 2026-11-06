/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { enableThreePlayers, openCoopMenu, waitForTitle } from "../../e2e/coop-client.ts";
import { choose, type ShotRun } from "../engine.ts";
import type { Scenario } from "../scenario.ts";

/** Where a page keeps the seat it takes back after a reload (`SEAT_KEY_PREFIX` of `src/coop/save/seat-store.ts`, D20) */
const SEAT_KEY_PREFIX = "coopSeat:";

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

/** Choose the entry of the host's open menu with this label, once it is there */
async function pick(run: ShotRun, label: string): Promise<void> {
  await untilMenu(run, label);
  await run.act("host", choose(await run.state("host"), label));
}

const saveFiles: Scenario = {
  id: "join:save-files",
  area: "Joining",
  summary:
    "the host's five co-op save files (D19): Continue's list, a file's menu, a new game's list and its overwrite question",
  async play(run) {
    // a run's first wave puts a real save (its party) in the first file
    await run.toRun();
    await run.waitFor("host", "the first file's save", () =>
      run.host.page.evaluate(() => localStorage.getItem("coopSlot") !== null),
    );
    // a second run, with someone else, in the third file; no seat to take back, so a reload goes to the title screen
    await run.host.page.evaluate(() => {
      const slot = JSON.parse(localStorage.getItem("coopSlot") as string);
      const session = { ...JSON.parse(slot.session), waveIndex: 23 };
      const third = { ...slot, wave: 23, names: { ...slot.names, guest: "Kim" }, session: JSON.stringify(session) };
      localStorage.setItem("coopSlot3", JSON.stringify(third));
    });
    for (const seat of run.seats) {
      const { page } = run.client(seat);
      await page.evaluate(seatPrefix => {
        for (const key of Object.keys(localStorage).filter(k => k.startsWith(seatPrefix))) {
          localStorage.removeItem(key);
        }
      }, SEAT_KEY_PREFIX);
      await page.goto("/");
    }
    await Promise.all(run.seats.map(seat => waitForTitle(run.client(seat))));
    await openCoopMenu(run.host);
    await untilMenu(run, "Continue (2 saved runs)");
    await run.shot("coop-menu");
    await pick(run, "Continue (2 saved runs)");
    await run.waitFor("host", "the save screen", async () => (await run.state("host")).ui === "SAVE_SLOT");
    await run.shot("continue-files");
    await run.press("host", "ACTION");
    await untilMenu(run, "Continue");
    await run.shot("file-menu");
    // Cancel, then back to the co-op menu: a new game
    await pick(run, "Cancel");
    await run.waitFor("host", "the save screen", async () => (await run.state("host")).ui === "SAVE_SLOT");
    await run.press("host", "CANCEL");
    await pick(run, "Host a game");
    await pick(run, "Classic");
    await run.waitFor("host", "the save screen", async () => (await run.state("host")).ui === "SAVE_SLOT");
    await run.shot("new-game-files");
    // the first file has a run: the new game asks before it takes it
    await run.press("host", "ACTION");
    await run.waitFor("host", "the overwrite question", async () => (await run.state("host")).ui === "CONFIRM");
    await run.shot("overwrite-question");
  },
};

export const joiningScenarios: Scenario[] = [title, lobby, starters, saveFiles];
