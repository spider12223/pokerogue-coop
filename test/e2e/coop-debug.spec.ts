/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
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
 * The host's debug menu (DECISIONS D42, amended): the host turns it on in the settings, its key (F8) opens the debug window
 * beside the game, connected to it; the guest has none. One click is one change, which reaches both clients with the next
 * turn; the window's change log says when.
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

async function windowShot(win: Page, name: string): Promise<void> {
  await win.screenshot({ path: join(SHOTS, `${name}-window.png`) });
}

useRelay();

test("the host's debug window: F8 opens it beside the game for the host only; one click is one change, it reaches both clients (D42)", async ({
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

  // F8 opens the window on the host; on the guest it does nothing
  const opened = host.page.waitForEvent("popup");
  await host.page.keyboard.press("F8");
  const win = await opened;
  await guest.page.keyboard.press("F8");
  await expect.poll(() => coop<boolean>(host, "debugMenu.panel.open")).toBe(true);
  expect(await coop<string>(host, "debugMenu.panel.kind")).toBe("window");
  expect(await coop<unknown>(guest, "debugMenu.panel")).toBeNull();
  expect(guest.page.context().pages()).toHaveLength(1);
  await win.setViewportSize({ width: 1340, height: 900 });
  const root = win.locator("#coopDebug");
  await expect(root.locator(".cdw-live .cdw-mon").first()).toBeVisible();
  await expect(root.locator(".cdw-top .cdw-conn")).toBeVisible();
  await win.evaluate(() => document.fonts.ready);
  await win.waitForTimeout(300);
  await windowShot(win, "01-pokemon");
  await shot(host, "01-game");

  for (const [label, name] of [
    ["Enemies & Field", "02-enemies"],
    ["Waves", "03-waves"],
    ["Rewards & Shop", "04-rewards"],
    ["Modes", "05-modes"],
  ] as const) {
    await root.locator(".cdw-tabs button", { hasText: label }).click();
    await win.waitForTimeout(150);
    await windowShot(win, name);
  }

  // The full item catalog: a Mega Stone goes on the next reward screen in one click; the log takes it back
  await root.locator(".cdw-tabs button", { hasText: "Rewards & Shop" }).click();
  await root.locator('[data-family="forms"]').click();
  await root.locator(".cdw-items .cdw-item").first().click();
  await expect.poll(() => coop<number>(host, "debugMenu.panel.waiting")).toBe(1);
  await expect(root.locator(".cdw-log .cdw-pending")).toHaveCount(1);
  await windowShot(win, "06-catalog");
  await root.locator(".cdw-log .cdw-pending .cdw-x").click();
  await expect.poll(() => coop<number>(host, "debugMenu.panel.waiting")).toBe(0);

  // The search finds cards of every section
  await root.locator(".cdw-search").fill("shiny");
  await expect(root.locator(".cdw-section-h").first()).toBeVisible();
  await windowShot(win, "07-search");
  await root.locator(".cdw-search").fill("");

  // One click, one change: the first Pokémon of the party to level 100, for both clients, with the turn
  await root.locator(".cdw-live .cdw-mon").first().click();
  await root.locator(".cdw-who button", { hasText: "Lv 100" }).click();
  await expect.poll(() => coop<number>(host, "debugMenu.panel.waiting")).toBe(1);
  await windowShot(win, "08-pending");

  const firstLevel = (client: Client) => coop<number>(client, "party.0.level");
  await Promise.all([
    playUntil(host, "the cheat is carried out", async () => (await firstLevel(host)) === 100),
    playUntil(guest, "the cheat is carried out", async () => (await firstLevel(guest)) === 100, 300_000, false, "own"),
  ]);
  expect(await coop<number>(host, "debugMenu.panel.waiting")).toBe(0);
  await expect(root.locator(".cdw-log .cdw-applied").first()).toContainText("100");
  await expect(root.locator(".cdw-log .cdw-applied small").first()).toContainText("turn");
  await windowShot(win, "09-applied");
  await shot(host, "09-after");
  await shot(guest, "09-after");

  // The chat box is still dragged by its title bar; the browser keeps where it was dropped (D38)
  const page = host.page;
  await page.locator("#coopChat .coop-chat-toggle").click();
  await expect.poll(() => coop<boolean>(host, "chat.open")).toBe(true);
  const chatBefore = (await page.locator("#coopChat").boundingBox())!;
  const handle = (await page.locator("#coopChat .coop-chat-head").boundingBox())!;
  await page.mouse.move(handle.x + 40, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 40 - 700, handle.y + handle.height / 2 + 250, { steps: 8 });
  await page.mouse.up();
  const chatAfter = (await page.locator("#coopChat").boundingBox())!;
  expect(chatBefore.x - chatAfter.x).toBeGreaterThan(500);
  expect(await page.evaluate(() => localStorage.getItem("coopChatPos"))).not.toBeNull();

  // The game's page goes: the window says so, and how to connect again
  await page.reload();
  await expect(win.locator(".cdw-disconnected")).toBeVisible();
  await windowShot(win, "10-disconnected");
});
