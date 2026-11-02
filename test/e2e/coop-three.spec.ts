/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  type Client,
  choosePlayers,
  chooseRunMode,
  enableThreePlayers,
  newClientContext,
  openClient,
  openCoopMenu,
  pickAndReady,
  press,
  shotsDir,
  ui,
  useRelay,
  waitForTitle,
} from "./coop-client.ts";

/**
 * Three players (DECISIONS D40): the host asks for 3 players, two guests join by the code, each is told who is in, and all
 * three pick on one starter select; the host's START reaches both guests.
 */

const SHOTS = shotsDir("three");

useRelay();

const coop = <T>(client: Client, field: string): Promise<T> =>
  client.page.evaluate(name => (window as any).__coop[name], field);

async function shot(name: string, ...clients: Client[]): Promise<void> {
  for (const client of clients) {
    await client.page.screenshot({ path: join(SHOTS, `${name}-${client.label}.png`) });
  }
}

/** Co-op -> Join a game -> the code */
async function joinByCode(client: Client, code: string): Promise<void> {
  await openCoopMenu(client);
  await press(client, "DOWN");
  await client.page.waitForTimeout(200);
  await press(client, "ACTION");
  await expect.poll(() => ui(client), { timeout: 20_000 }).toBe("COOP_JOIN_FORM");
  expect(await client.page.evaluate(c => (window as any).__coop.submitJoinCode(c), code)).toBe(true);
  await expect.poll(() => coop<boolean>(client, "linked"), { message: `${client.label} not linked` }).toBe(true);
}

test("three players link up, pick on one starter select, and the host starts the run (D40)", async ({ browser }) => {
  test.setTimeout(600_000);
  const [host, guest, guest2] = await Promise.all(
    (["host", "guest", "guest2"] as const).map(async label => openClient(await newClientContext(browser), label)),
  );
  await Promise.all([host, guest, guest2].map(waitForTitle));
  for (const [client, name] of [
    [host, "Sam"],
    [guest, "Alex"],
    [guest2, "Kim"],
  ] as const) {
    await client.page.evaluate(n => (window as any).__coop.setName(n), name);
  }

  // The host: 3-Player Co-op (Beta) on in the settings; Co-op -> Host a game -> 3 players (Beta) -> Classic -> a join code
  await enableThreePlayers(host);
  await openCoopMenu(host);
  await press(host, "ACTION");
  await expect.poll(() => coop<string[]>(host, "menuOptions"), { timeout: 20_000 }).toContain("3 players (Beta)");
  await host.page.waitForTimeout(600);
  await shot("01-players-question", host);
  await choosePlayers(host, 3);
  await chooseRunMode(host);
  await expect.poll(() => coop<string | null>(host, "joinCode"), { timeout: 30_000 }).not.toBeNull();
  const code = await coop<string>(host, "joinCode");
  await host.page.waitForTimeout(800);
  await shot("02-host-waiting-none", host);

  // The first guest is in at once; it waits for the room to be full
  await joinByCode(guest, code);
  await guest.page.waitForTimeout(3500);
  await shot("03-waiting-one", host, guest);
  expect(await coop<string>(guest, "seat")).toBe("guest");
  expect(await ui(guest)).not.toBe("STARTER_SELECT");

  // The second guest fills the room: all three go to the starter select
  await joinByCode(guest2, code);
  expect(await coop<string>(guest2, "seat")).toBe("guest2");
  for (const client of [host, guest, guest2]) {
    await expect
      .poll(() => ui(client), { timeout: 60_000, message: `${client.label} starter select` })
      .toBe("STARTER_SELECT");
    await expect.poll(() => client.page.evaluate(() => (window as any).__coop.lobby?.players ?? null)).toBe(3);
  }
  await host.page.waitForTimeout(1500);
  await shot("04-starter-select", host, guest2);

  // Each picks one and is ready; the second guest last
  await Promise.all([pickAndReady(host, 0), pickAndReady(guest, 1)]);
  await expect
    .poll(() => guest2.page.evaluate(() => (window as any).__coop.lobby?.partners ?? null), { timeout: 20_000 })
    .toEqual({ host: { picks: 1, ready: true }, guest: { picks: 1, ready: true } });
  await guest2.page.waitForTimeout(800);
  await shot("05-two-ready", guest2, host);
  await pickAndReady(guest2, 2);

  // START: every client leaves the starter select's lobby for the run
  for (const client of [host, guest, guest2]) {
    await expect
      .poll(() => client.page.evaluate(() => (window as any).__coop.lobby), {
        timeout: 30_000,
        message: `${client.label}: the run did not start`,
      })
      .toBeNull();
  }
});
