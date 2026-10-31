/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from "@playwright/test";
import {
  type Client,
  chooseRunMode,
  newClientContext,
  openClient,
  openCoopMenu,
  press,
  ui,
  useRelay,
  waitForTitle,
} from "./coop-client.ts";

/**
 * "Find a partner" (D37) and the chat box (D38), end to end: two players who share nothing are matched by the relay and land
 * linked on the starter select; one opens the chat with its key and types, and the other reads the line, filtered. What is
 * typed in the box never reaches the game.
 */

type Window = {
  __coop: { menuOptions: string[]; linked: boolean; seat: string; chat: { lines: string[]; open: boolean } | null };
};

async function findPartner(client: Client): Promise<void> {
  await openCoopMenu(client);
  const options = await client.page.evaluate(() => (window as unknown as Window).__coop.menuOptions);
  const at = options.indexOf("Find a partner");
  expect(at, `the co-op menu: ${JSON.stringify(options)}`).toBeGreaterThanOrEqual(0);
  for (let i = 0; i < at; i++) {
    await press(client, "DOWN");
    await client.page.waitForTimeout(150);
  }
  await press(client, "ACTION");
  await chooseRunMode(client);
}

test.describe("co-op: find a partner, and chat", () => {
  useRelay();

  test("two players are matched, linked on the starter select, and chat", async ({ browser }) => {
    test.setTimeout(600_000);
    const first = await openClient(await newClientContext(browser), "first");
    const second = await openClient(await newClientContext(browser), "second");
    try {
      await Promise.all([waitForTitle(first), waitForTitle(second)]);
      await findPartner(first);
      // in the queue first, alone: it is not linked to anyone yet
      await first.page.waitForTimeout(1500);
      expect(await first.page.evaluate(() => (window as unknown as Window).__coop.linked)).toBe(false);
      await findPartner(second);

      for (const client of [first, second]) {
        await expect
          .poll(() => client.page.evaluate(() => (window as unknown as Window).__coop.linked), {
            timeout: 60_000,
            message: `${client.label} not linked`,
          })
          .toBe(true);
        await expect.poll(() => ui(client), { timeout: 60_000 }).toBe("STARTER_SELECT");
      }
      // the one who waited longer hosts
      expect(await first.page.evaluate(() => (window as unknown as Window).__coop.seat)).toBe("host");
      expect(await second.page.evaluate(() => (window as unknown as Window).__coop.seat)).toBe("guest");

      // the chat key opens the box; what is typed goes to the box, not the game (Space would pick a starter)
      await first.page.keyboard.press("h");
      await expect
        .poll(() => first.page.evaluate(() => (window as unknown as Window).__coop.chat?.open ?? false))
        .toBe(true);
      await first.page.waitForTimeout(300);
      await first.page.keyboard.type("hello fuck you");
      await first.page.keyboard.press("Enter");
      expect(await ui(first)).toBe("STARTER_SELECT");
      await expect
        .poll(() => second.page.evaluate(() => (window as unknown as Window).__coop.chat?.lines.at(-1) ?? ""), {
          timeout: 15_000,
        })
        .toMatch(/: hello \*\*\*\* you$/);
      const mine = await first.page.evaluate(() => (window as unknown as Window).__coop.chat?.lines.at(-1) ?? "");
      expect(mine).toMatch(/: hello \*\*\*\* you$/);
      // Esc closes it, and the game has its keys again
      await first.page.keyboard.press("Escape");
      await expect
        .poll(() => first.page.evaluate(() => (window as unknown as Window).__coop.chat?.open ?? true))
        .toBe(false);
      expect(await ui(first)).toBe("STARTER_SELECT");
      // the guest's box was closed: the line waits in the corner
      expect(await second.page.locator(".coop-chat-toast").first().textContent()).toMatch(/hello \*\*\*\* you/);
    } finally {
      await first.page.context().close();
      await second.page.context().close();
    }
  });
});
