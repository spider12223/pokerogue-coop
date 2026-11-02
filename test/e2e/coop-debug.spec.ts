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
  newClientContext,
  openClient,
  playUntil,
  shotsDir,
  startLinkedRun,
  useRelay,
  waitForTitle,
} from "./coop-client.ts";

/**
 * The host's debug menu (DECISIONS D42): the host turns it on in the settings, its key (F8) opens the panel over the game;
 * the guest has no panel. A cheat of the host reaches both clients with the next turn.
 */

const SHOTS = shotsDir("debug");
const SETTINGS_MODULE = "/src/globals/global-settings-manager.ts";

const coop = <T>(client: Client, path: string): Promise<T> =>
  client.page.evaluate(
    keys => keys.split(".").reduce((value: any, key) => value?.[key], (window as any).__coop) as T,
    path,
  );

async function shot(client: Client, name: string): Promise<void> {
  await client.page.screenshot({ path: join(SHOTS, `${name}-${client.label}.png`) });
}

useRelay();

test("the host's debug menu: F8 opens it for the host only; a cheat reaches both clients (D42)", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  mkdirSync(SHOTS, { recursive: true });
  const [host, guest] = await Promise.all(
    (["host", "guest"] as const).map(async label => openClient(await newClientContext(browser), label)),
  );
  await Promise.all([host, guest].map(waitForTitle));
  await host.page.evaluate(async path => {
    const { settings } = await import(path);
    settings.update("general", "coopDebugMenu", true);
  }, SETTINGS_MODULE);
  // The guest's own setting does nothing: only the host's counts
  await guest.page.evaluate(async path => {
    const { settings } = await import(path);
    settings.update("general", "coopDebugMenu", true);
  }, SETTINGS_MODULE);

  await startLinkedRun(host, guest);
  await playUntil(host, "the first command menu", state => state.ui === "COMMAND");
  expect(await coop<boolean>(host, "debugMenu.on")).toBe(true);
  expect(await coop<boolean>(guest, "debugMenu.on")).toBe(true);
  expect(await coop<unknown>(guest, "debugMenu.panel")).toBeNull();

  // F8 opens the panel on the host; on the guest it does nothing
  await host.page.keyboard.press("F8");
  await guest.page.keyboard.press("F8");
  await expect.poll(() => coop<boolean>(host, "debugMenu.panel.open")).toBe(true);
  await expect(host.page.locator("#coopDebug")).toBeVisible();
  await expect(guest.page.locator("#coopDebug")).toHaveCount(0);
  await host.page.waitForTimeout(400);
  await shot(host, "01-party");
  await shot(guest, "01-party");

  for (const [tab, name] of [
    ["Waves", "02-waves"],
    ["Rewards", "03-rewards"],
    ["Battle", "04-battle"],
    ["Fun", "05-fun"],
  ] as const) {
    await host.page.locator("#coopDebug .coop-debug-tabs button", { hasText: tab }).click();
    await host.page.waitForTimeout(200);
    await shot(host, name);
  }
  await host.page.locator("#coopDebug .coop-debug-search").fill("shiny");
  await host.page.waitForTimeout(200);
  await shot(host, "06-search");

  // A cheat: the first Pokémon of the party goes to level 100, for both clients, with the turn
  await host.page.locator("#coopDebug .coop-debug-search").fill("");
  await host.page.locator("#coopDebug .coop-debug-tabs button", { hasText: "Party" }).click();
  await host.page
    .locator("#coopDebug .coop-debug-row", { hasText: "Level" })
    .locator("button", { hasText: "100" })
    .click();
  await expect.poll(() => coop<number>(host, "debugMenu.panel.waiting")).toBe(1);
  await shot(host, "07-queued");
  await host.page.keyboard.press("Escape");
  await expect.poll(() => coop<boolean>(host, "debugMenu.panel.open")).toBe(false);

  const firstLevel = (client: Client) => coop<number>(client, "party.0.level");
  await Promise.all([
    playUntil(host, "the cheat is carried out", async () => (await firstLevel(host)) === 100),
    playUntil(guest, "the cheat is carried out", async () => (await firstLevel(guest)) === 100, 300_000, false, "own"),
  ]);
  expect(await coop<number>(host, "debugMenu.panel.waiting")).toBe(0);
  await shot(host, "08-after");
  await shot(guest, "08-after");
});
