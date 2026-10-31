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
  linkClients,
  newClientContext,
  openClient,
  pickAndReady,
  shotsDir,
  untilWaveOne,
  useRelay,
  waitForTitle,
} from "./coop-client.ts";

/**
 * Co-op Endless (D39), end to end: the host chooses Endless, the guest joins with the code and is told on the starter
 * select, and both play the first wave of an endless run.
 */

const SHOTS = shotsDir("endless");

type RunMode = { session: string | null; game: string | null };
const runMode = (client: Client): Promise<RunMode> =>
  client.page.evaluate(() => (window as any).__coop.runMode as RunMode);

test.describe("co-op: Endless", () => {
  useRelay();

  test("the host chooses Endless; both play an endless run", async ({ browser }) => {
    test.setTimeout(600_000);
    mkdirSync(SHOTS, { recursive: true });
    const host = await openClient(await newClientContext(browser), "host");
    const guest = await openClient(await newClientContext(browser), "guest");
    try {
      await Promise.all([waitForTitle(host), waitForTitle(guest)]);
      await linkClients(host, guest, "Endless");

      // the guest was told the host's choice in the handshake
      expect(await runMode(host)).toMatchObject({ session: "endless" });
      expect(await runMode(guest)).toMatchObject({ session: "endless" });
      await host.page.waitForTimeout(2500);
      await host.page.screenshot({ path: join(SHOTS, "starter-select-host.png") });
      await guest.page.screenshot({ path: join(SHOTS, "starter-select-guest.png") });

      await Promise.all([pickAndReady(host, 0), pickAndReady(guest, 1)]);
      await untilWaveOne(host, guest);
      // both built the run as Endless
      expect(await runMode(host)).toEqual({ session: "endless", game: "endless" });
      expect(await runMode(guest)).toEqual({ session: "endless", game: "endless" });
      await host.page.waitForTimeout(2000);
      await host.page.screenshot({ path: join(SHOTS, "wave-1-host.png") });
    } catch (error) {
      console.log(JSON.stringify(await describeClients(host, guest), null, 2));
      throw error;
    } finally {
      await host.page.context().close();
      await guest.page.context().close();
    }
  });
});
