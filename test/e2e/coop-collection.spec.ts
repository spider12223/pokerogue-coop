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
  desyncOf,
  linkClients,
  newClientContext,
  openClient,
  partyOf,
  pickAndReady,
  press,
  pressUntil,
  shotsDir,
  ui,
  untilWaveOne,
  useRelay,
  waitForTitle,
} from "./coop-client.ts";

/**
 * End-to-end test (DECISIONS D32): the starter select shows the Pokémon of both players, and the budget they share is 15
 * points.
 *
 * | step | what happens | what is checked |
 * | --- | --- | --- |
 * | 1 | the host's account has Mew; the guest's has only the starters of a new account | only the host has Mew |
 * | 2 | both are on the co-op starter select | the guest has Mew there too |
 * | 3 | the guest picks Mew (5) and Charmander (3), the host Bulbasaur (3): 11 points, more than a solo run's 10 | the run starts with Mew in the guest's half of the party, without a desync |
 * | 4 | the run has started | the guest's own account does not have Mew |
 */

const SHOTS = shotsDir("collection");
const MEW = 151;
const CHARMANDER = 4;

const catchSpecies = (client: Client, speciesId: number): Promise<boolean> =>
  client.page.evaluate(id => (window as any).__coop.catchSpecies(id), speciesId);
const hasCaught = (client: Client, speciesId: number): Promise<boolean> =>
  client.page.evaluate(id => (window as any).__coop.hasCaught(id), speciesId);
const starterCursor = (client: Client): Promise<number | null> =>
  client.page.evaluate(() => (window as any).__coop.starterCursor);

/** Move the cursor of the starter select onto a species and add it to the party */
async function addSpecies(client: Client, speciesId: number): Promise<void> {
  for (const button of ["RIGHT", "LEFT"] as const) {
    for (let i = 0; i < 30 && (await starterCursor(client)) !== speciesId; i++) {
      await press(client, button);
      await client.page.waitForTimeout(150);
    }
  }
  expect(await starterCursor(client), `${client.label}: the cursor on ${speciesId}`).toBe(speciesId);
  // The Pokémon menu, then "Add to party"
  await pressUntil(client, "ACTION", "OPTION_SELECT");
  await pressUntil(client, "ACTION", "STARTER_SELECT");
  await client.page.waitForTimeout(300);
}

test.describe("co-op: the starter select of both players", () => {
  useRelay();

  test("the guest picks a Pokémon only the host has, and the points are shared up to 15", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(600_000);
    mkdirSync(SHOTS, { recursive: true });
    const hostContext = await newClientContext(browser, true);
    const guestContext = await newClientContext(browser, true);
    const [host, guest] = await Promise.all([openClient(hostContext, "host"), openClient(guestContext, "guest")]);

    try {
      await Promise.all([waitForTitle(host), waitForTitle(guest)]);
      expect(await catchSpecies(host, MEW)).toBe(true);
      expect(await hasCaught(host, MEW)).toBe(true);
      expect(await hasCaught(guest, MEW)).toBe(false);

      await linkClients(host, guest);
      for (const client of [host, guest]) {
        await expect
          .poll(() => ui(client), { timeout: 60_000, message: `${client.label} starter select` })
          .toBe("STARTER_SELECT");
      }
      await guest.page.waitForTimeout(1000);
      expect(await hasCaught(guest, MEW)).toBe(true);

      const guestPicks = async (): Promise<void> => {
        await addSpecies(guest, MEW);
        await addSpecies(guest, CHARMANDER);
        await guest.page.screenshot({ path: join(SHOTS, "guest-picked-mew.png") });
        await press(guest, "SUBMIT");
        await expect.poll(() => ui(guest), { timeout: 20_000 }).toBe("CONFIRM");
        await pressUntil(guest, "ACTION", "STARTER_SELECT");
      };
      // The guest takes 8 points first; the host's Bulbasaur (3) fits only in a budget of more than 10
      await guestPicks();
      await pickAndReady(host, 0);
      await untilWaveOne(host, guest);

      for (const client of [host, guest]) {
        const party = await partyOf(client);
        const of = (seat: string): string[] =>
          party
            .filter(member => member.owner === seat)
            .map(member => member.name)
            .sort();
        expect(of("host")).toEqual(["Bulbasaur"]);
        expect(of("guest")).toEqual(["Charmander", "Mew"]);
        expect(await desyncOf(client)).toBeNull();
      }
      // The merge came off when the run started: the guest's account has its own Pokémon again
      expect(await hasCaught(guest, MEW)).toBe(false);
      await testInfo.attach("guest.png", { body: await guest.page.screenshot(), contentType: "image/png" });
    } catch (error) {
      const state = JSON.stringify(await describeClients(host, guest), null, 2);
      await testInfo.attach("clients.json", { body: state, contentType: "application/json" });
      console.log(`co-op collection e2e failed; clients: ${state}`);
      throw error;
    } finally {
      expect([...host.errors, ...guest.errors], "console errors").toEqual([]);
      await hostContext.close();
      await guestContext.close();
    }
  });
});
