/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from "@playwright/test";
import {
  checkpointsOf,
  desyncOf,
  newClientContext,
  openClient,
  playToRewardScreen,
  startLinkedRun,
  useRelay,
  waitForTitle,
  waitsOf,
} from "./coop-client.ts";

/**
 * End-to-end test: two real browser clients and the real relay (`coop-server`). The host creates a room, the guest
 * joins it by its code, both pick a starter, and both play wave 1 to the reward screen with scripted inputs.
 *
 * Both clients must then have passed the same state-hash checkpoints (the last one is the reward option list, hashed
 * before it is shown) and neither may have reported a desync. The reward screen itself is `coop-run.spec.ts`.
 */

test.describe("co-op: two clients play wave 1 together", () => {
  useRelay();

  test("host creates a room, guest joins by code, both play wave 1 to the reward screen with equal hashes", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(900_000);
    const hostContext = await newClientContext(browser);
    const guestContext = await newClientContext(browser);
    const [host, guest] = await Promise.all([openClient(hostContext, "host"), openClient(guestContext, "guest")]);

    try {
      await Promise.all([waitForTitle(host), waitForTitle(guest)]);

      await startLinkedRun(host, guest);

      await Promise.all([playToRewardScreen(host), playToRewardScreen(guest)]);

      // Same checkpoints, same hashes, in the same order; the last is the reward option list
      const [a, b] = await Promise.all([checkpointsOf(host), checkpointsOf(guest)]);
      expect(a.length).toBeGreaterThanOrEqual(3);
      expect(b).toEqual(a);
      expect(a.at(-1)?.kind).toBe("rewards");
      expect(a.map(c => c.kind)).toContain("waveStart");
      expect(a.map(c => c.kind)).toContain("turn");

      expect(await desyncOf(host)).toBeNull();
      expect(await desyncOf(guest)).toBeNull();

      const waits = { host: await waitsOf(host), guest: await waitsOf(guest) };
      console.log(`co-op e2e: waits for the partner's commands ${JSON.stringify(waits)}`);
      await testInfo.attach("waits.json", { body: JSON.stringify(waits, null, 2), contentType: "application/json" });
      await testInfo.attach("host.png", { body: await host.page.screenshot(), contentType: "image/png" });
      await testInfo.attach("guest.png", { body: await guest.page.screenshot(), contentType: "image/png" });
    } finally {
      expect([...host.errors, ...guest.errors], "console errors").toEqual([]);
      await hostContext.close();
      await guestContext.close();
    }
  });
});
