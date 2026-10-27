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
  describeClients,
  newClientContext,
  openClient,
  playUntil,
  press,
  pressUntil,
  shotsDir,
  startLinkedRun,
  ui,
  useRelay,
  waitForTitle,
} from "./coop-client.ts";

/**
 * What one player sees of the other while the commands of a turn are chosen (D16): the partner looking at a move, aiming it,
 * locked in, and their emotes and pings. Screenshots of each, for a person to look at, in
 * `test-results/screenshots/intents/`; it checks that the partner's markers are drawn.
 */

const SHOTS = shotsDir("intents");
const sleep = (client: Client, ms: number): Promise<void> => client.page.waitForTimeout(ms);

async function shot(step: string, ...clients: Client[]): Promise<void> {
  await Promise.all(
    clients.map(client => client.page.screenshot({ path: join(SHOTS, `${step}-${client.label}.png`) })),
  );
}

/** How many of the partner's markers and bubbles this client draws */
const drawn = (client: Client): Promise<number> =>
  client.page.evaluate(() => (window as any).__coop.cosmetics?.drawn ?? 0);

test.describe("co-op: the partner's intents, pings and emotes", () => {
  useRelay();

  test("as the other player sees them", async ({ browser }, testInfo) => {
    test.setTimeout(600_000);
    mkdirSync(SHOTS, { recursive: true });
    const hostContext = await newClientContext(browser, true);
    const guestContext = await newClientContext(browser, true);
    const [host, guest] = await Promise.all([openClient(hostContext, "host"), openClient(guestContext, "guest")]);
    try {
      await Promise.all([waitForTitle(host), waitForTitle(guest)]);
      await host.page.evaluate(() => (window as any).__coop.setName("Sam"));
      await guest.page.evaluate(() => (window as any).__coop.setName("Alex"));
      await startLinkedRun(host, guest);
      await Promise.all([
        playUntil(host, "the command menu", state => state.ui === "COMMAND"),
        playUntil(guest, "the command menu", state => state.ui === "COMMAND"),
      ]);
      await sleep(host, 1200);
      await shot("i00-command", host, guest);

      // the host looks at its first move, then its second
      await pressUntil(host, "ACTION", "FIGHT");
      await sleep(host, 800);
      await shot("i01-host-looks-at-a-move", host, guest);
      expect(await drawn(guest)).toBeGreaterThan(0);
      await press(host, "RIGHT");
      await sleep(host, 800);
      await shot("i02-host-looks-at-another", guest);
      await press(host, "LEFT");
      await sleep(host, 400);

      // it aims the first one, at one enemy then the other, and chooses
      await press(host, "ACTION");
      await sleep(host, 900);
      if ((await ui(host)) === "TARGET_SELECT") {
        await shot("i03-host-aims", host, guest);
        await press(host, "RIGHT");
        await sleep(host, 800);
        await shot("i04-host-aims-the-other", guest);
        await press(host, "ACTION");
      }
      await sleep(host, 1500);
      await shot("i05-host-ready", host, guest);

      // the guest looks at a move: the host sees it
      await pressUntil(guest, "ACTION", "FIGHT");
      await sleep(guest, 800);
      await shot("i06-guest-looks-at-a-move", host, guest);

      // an emote of the guest, a ping of the host
      expect(await guest.page.evaluate(() => (window as any).__coop.emote(1))).toBe(true);
      await sleep(guest, 600);
      await shot("i07-guest-emote", host, guest);
      expect(await host.page.evaluate(() => (window as any).__coop.nudge())).toBe(true);
      await sleep(host, 600);
      await shot("i08-host-ping", host, guest);
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
});
