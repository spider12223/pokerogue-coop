/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  type Client,
  chooseRunMode,
  describeClients,
  newClientContext,
  openClient,
  openCoopMenu,
  playToRewardScreen,
  playUntil,
  press,
  pressUntil,
  shotsDir,
  skipScreen,
  ui,
  useRelay,
  waitForRewardReady,
  waitForTitle,
} from "./coop-client.ts";

/**
 * A tour of the co-op screens as both players see them, for a person to look at: the lobby, the starter select while
 * both pick, the first turn, and the reward screens of each picker. Every step is a pair of screenshots, `<step>-host.png`
 * and `<step>-guest.png`, in `test-results/screenshots/visual/`. It checks only that each screen is reached.
 */

const SHOTS = shotsDir("visual");
const sleep = (client: Client, ms: number): Promise<void> => client.page.waitForTimeout(ms);

async function shot(step: string, ...clients: Client[]): Promise<void> {
  await Promise.all(
    clients.map(client => client.page.screenshot({ path: join(SHOTS, `${step}-${client.label}.png`) })),
  );
}

async function untilUi(client: Client, mode: string, timeout = 30_000): Promise<void> {
  await expect.poll(() => ui(client), { message: `${client.label}: ${mode}`, timeout }).toBe(mode);
}

/** The starter under the cursor goes into the party ("Add to party", the first entry of its menu) */
async function addStarter(client: Client, step: string, other: Client): Promise<void> {
  await pressUntil(client, "ACTION", "OPTION_SELECT");
  await sleep(client, 600);
  await shot(`${step}-menu`, client);
  await pressUntil(client, "ACTION", "STARTER_SELECT");
  await sleep(client, 1200);
  await shot(step, client, other);
}

test.describe("co-op: the screens of both players", () => {
  useRelay();

  test("lobby, starter select, a turn and the reward screens", async ({ browser }, testInfo) => {
    test.setTimeout(1_200_000);
    mkdirSync(SHOTS, { recursive: true });
    const hostContext = await newClientContext(browser, true);
    const guestContext = await newClientContext(browser, true);
    const [host, guest] = await Promise.all([openClient(hostContext, "host"), openClient(guestContext, "guest")]);
    try {
      await Promise.all([waitForTitle(host), waitForTitle(guest)]);
      await host.page.evaluate(() => (window as any).__coop.setName("Sam"));
      await guest.page.evaluate(() => (window as any).__coop.setName("Alex"));
      await shot("01-title", host, guest);

      // #region The lobby
      await openCoopMenu(host);
      await sleep(host, 500);
      await shot("02-coop-menu", host);
      await press(host, "ACTION");
      // Classic or Endless (D39)
      await expect
        .poll(() => host.page.evaluate(() => (window as any).__coop.menuOptions as string[]), { timeout: 20_000 })
        .toContain("Endless");
      await sleep(host, 800);
      await shot("02b-run-mode", host);
      await chooseRunMode(host);
      await expect
        .poll(() => host.page.evaluate(() => (window as any).__coop.joinCode as string | null), { timeout: 30_000 })
        .not.toBeNull();
      const code = (await host.page.evaluate(() => (window as any).__coop.joinCode)) as string;
      await sleep(host, 2500);
      await shot("03-host-code", host);

      await openCoopMenu(guest);
      await press(guest, "DOWN");
      await sleep(guest, 200);
      await press(guest, "ACTION");
      await untilUi(guest, "COOP_JOIN_FORM");
      await sleep(guest, 800);
      await shot("04-join-form", guest);
      expect(await guest.page.evaluate(c => (window as any).__coop.submitJoinCode(c), code)).toBe(true);
      // #endregion

      // #region The starter select
      await Promise.all([untilUi(host, "STARTER_SELECT", 60_000), untilUi(guest, "STARTER_SELECT", 60_000)]);
      await sleep(host, 2500);
      await shot("05-starters-empty", host, guest);

      // the host takes the first starter of the grid; the guest sees it, faded
      await addStarter(host, "06-host-picked", guest);

      // the guest takes the second, then the third
      await press(guest, "RIGHT");
      await sleep(guest, 300);
      await addStarter(guest, "07-guest-picked", host);
      await press(guest, "RIGHT");
      await sleep(guest, 300);
      await addStarter(guest, "08-guest-picked-two", host);

      // the host tries one more: the shared budget is spent
      await press(host, "RIGHT");
      await sleep(host, 300);
      await press(host, "ACTION");
      await sleep(host, 800);
      await shot("09-host-over-budget", host, guest);
      await press(host, "CANCEL");
      await sleep(host, 500);
      if ((await ui(host)) !== "STARTER_SELECT") {
        await press(host, "CANCEL");
      }
      await untilUi(host, "STARTER_SELECT");

      // the host is ready
      await press(host, "SUBMIT");
      await untilUi(host, "CONFIRM");
      await sleep(host, 600);
      await shot("10-host-confirm", host);
      await pressUntil(host, "ACTION", "STARTER_SELECT");
      await sleep(host, 1200);
      await shot("11-host-ready", host, guest);

      // the guest is ready: the run starts
      await press(guest, "SUBMIT");
      await untilUi(guest, "CONFIRM");
      await sleep(guest, 600);
      await shot("12-guest-confirm", guest);
      await press(guest, "ACTION");
      await sleep(guest, 700);
      await shot("13-starting", host, guest);
      // #endregion

      // #region The first turn
      await Promise.all([
        playUntil(host, "the command menu", state => state.ui === "COMMAND"),
        playUntil(guest, "the command menu", state => state.ui === "COMMAND"),
      ]);
      await sleep(host, 1500);
      await shot("14-command", host, guest);
      await pressUntil(host, "ACTION", "FIGHT");
      await sleep(host, 600);
      await shot("15-fight", host, guest);
      await press(host, "ACTION");
      await sleep(host, 800);
      if ((await ui(host)) === "TARGET_SELECT") {
        await shot("16-target", host);
        await press(host, "ACTION");
        await sleep(host, 800);
      }
      await sleep(host, 1500);
      await shot("17-host-chose", host, guest);
      // #endregion

      // #region The reward screens: the host picks on the first, the guest on the second
      await Promise.all([playToRewardScreen(host, 0), playToRewardScreen(guest, 0)]);
      await Promise.all([waitForRewardReady(host), waitForRewardReady(guest)]);
      await sleep(host, 1000);
      await shot("18-reward-host-picks", host, guest);
      await skipScreen(host);
      await Promise.all([playToRewardScreen(host, 1), playToRewardScreen(guest, 1)]);
      await Promise.all([waitForRewardReady(host), waitForRewardReady(guest)]);
      await sleep(host, 1000);
      await shot("19-reward-guest-picks", host, guest);

      // the host does not pick here: cancel, move, press a reward, and look at the team
      await press(host, "CANCEL");
      await sleep(host, 600);
      await press(host, "RIGHT");
      await sleep(host, 600);
      await shot("20-non-picker-after-cancel", host, guest);
      expect(await host.page.evaluate(() => (window as any).__coop.moveRewardCursor(1, 0))).toBe(true);
      await sleep(host, 300);
      await press(host, "ACTION");
      await sleep(host, 1500);
      await shot("21-non-picker-presses-reward", host);
      expect(await host.page.evaluate(() => (window as any).__coop.moveRewardCursor(0, 2))).toBe(true);
      await sleep(host, 300);
      await press(host, "ACTION");
      await untilUi(host, "PARTY");
      await sleep(host, 1200);
      await shot("22-check-team", host);
      await press(host, "CANCEL");
      await untilUi(host, "MODIFIER_SELECT");
      // the guest's cursor, mirrored on the host's screen
      expect(await guest.page.evaluate(() => (window as any).__coop.moveRewardCursor(1, 1))).toBe(true);
      await sleep(host, 1500);
      await shot("23-partner-cursor", host, guest);
      // #endregion
    } catch (error) {
      await shot("zz-failure", host, guest).catch(() => undefined);
      await testInfo.attach("clients.json", {
        body: JSON.stringify(await describeClients(host, guest), null, 2),
        contentType: "application/json",
      });
      throw error;
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test("the guest on the starter select: the filters, the team column, Random, ready and back", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(900_000);
    mkdirSync(SHOTS, { recursive: true });
    const hostContext = await newClientContext(browser, true);
    const guestContext = await newClientContext(browser, true);
    const [host, guest] = await Promise.all([openClient(hostContext, "host"), openClient(guestContext, "guest")]);
    /** Press, wait, and shoot the guest (and the host, when it matters) */
    const step = async (name: string, button: Parameters<typeof press>[1] | null, both = false): Promise<void> => {
      if (button !== null) {
        await press(guest, button);
      }
      await sleep(guest, 700);
      await shot(`g-${name}`, ...(both ? [guest, host] : [guest]));
    };
    try {
      await Promise.all([waitForTitle(host), waitForTitle(guest)]);
      await host.page.evaluate(() => (window as any).__coop.setName("Sam"));
      await guest.page.evaluate(() => (window as any).__coop.setName("Alex"));
      await openCoopMenu(host);
      await press(host, "ACTION");
      await chooseRunMode(host);
      await expect
        .poll(() => host.page.evaluate(() => (window as any).__coop.joinCode as string | null), { timeout: 30_000 })
        .not.toBeNull();
      const code = (await host.page.evaluate(() => (window as any).__coop.joinCode)) as string;
      await openCoopMenu(guest);
      await press(guest, "DOWN");
      await sleep(guest, 200);
      await press(guest, "ACTION");
      await untilUi(guest, "COOP_JOIN_FORM");
      expect(await guest.page.evaluate(c => (window as any).__coop.submitJoinCode(c), code)).toBe(true);
      await Promise.all([untilUi(host, "STARTER_SELECT", 60_000), untilUi(guest, "STARTER_SELECT", 60_000)]);
      await sleep(guest, 2500);

      // the filter bar and one of its dropdowns
      await step("01-filter-bar", "UP");
      await step("02-filter-open", "ACTION");
      await step("03-filter-closed", "CANCEL");
      await step("04-back-to-grid", "DOWN");

      // both pick one; the guest walks to the team column
      await addStarter(host, "g-05-host-picked", guest);
      await press(guest, "RIGHT");
      await sleep(guest, 300);
      await addStarter(guest, "g-06-guest-picked", host);
      for (let i = 0; i < 7; i++) {
        await press(guest, "RIGHT");
        await sleep(guest, 150);
      }
      await step("07-last-column", null);
      await step("08-team-column", "RIGHT");
      await step("09-team-down-1", "DOWN");
      await step("10-team-down-2", "DOWN");
      await step("11-team-down-3", "DOWN");
      await step("12-team-up", "UP");
      await step("13-team-up-2", "UP");
      await step("14-team-up-3", "UP");
      // the menu of the guest's own pick
      await step("15-own-pick-menu", "ACTION");
      await step("16-own-pick-menu-closed", "CANCEL");

      // ready, then back
      await press(guest, "SUBMIT");
      await untilUi(guest, "CONFIRM");
      await press(guest, "ACTION");
      await sleep(guest, 1000);
      await shot("g-17-guest-ready", guest, host);
      await step("18-guest-unready", "CANCEL", true);

      // the guest removes its pick by cancel, and the host's party changes meanwhile
      await press(host, "RIGHT");
      await sleep(host, 300);
      await addStarter(host, "g-19-host-second-pick", guest);
      await step("20-guest-cancel-1", "CANCEL", true);
      await step("21-guest-cancel-2", "CANCEL", true);
      await step("22-guest-cancel-3", "CANCEL", true);
      await sleep(guest, 1500);
      await shot("g-23-end", guest, host);
      console.log(`guest ui at the end: ${await ui(guest)}; host ui: ${await ui(host)}`);
    } catch (error) {
      await shot("g-zz-failure", host, guest).catch(() => undefined);
      await testInfo.attach("clients.json", {
        body: JSON.stringify(await describeClients(host, guest), null, 2),
        contentType: "application/json",
      });
      throw error;
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});
