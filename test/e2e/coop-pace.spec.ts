/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from "@playwright/test";
import {
  type Client,
  describeClients,
  newClientContext,
  openClient,
  type PlayState,
  playUntil,
  press,
  skipScreen,
  startLinkedRun,
  useRelay,
  waitForRewardReady,
  waitForTitle,
} from "./coop-client.ts";

/**
 * Pacing in two browsers (DECISIONS D27): the host's screen is the clock of the run's text.
 * - The guest never presses on a line of the run and still keeps up with the host, through its own slower settings (move
 *   animations, the level-up stats panel); it takes the host's game speed.
 * - Both screens show the same line at each place.
 * - When both wait on the same line, the guest's press moves the host's too.
 */

type At = [number, number, number];

interface Pace {
  position: At;
  leader: At | null;
  behind: boolean;
  private: boolean;
  open: At | null;
  prompts: { at: At; text: string }[];
  stats: { followed: number; presses: number };
  gameSpeed: number;
}

const paceOf = (client: Client): Promise<Pace | null> => client.page.evaluate(() => (window as any).__coop.pace);
const key = (at: readonly number[]): string => at.join(":");
const before = (a: readonly number[], b: readonly number[]): boolean =>
  a[0] - b[0] < 0 || (a[0] === b[0] && (a[1] - b[1] < 0 || (a[1] === b[1] && a[2] < b[2])));

const atRewards = (state: PlayState): boolean =>
  state.phase?.name === "SelectModifierPhase" && state.ui === "MODIFIER_SELECT";

test.describe("co-op: the host's screen is the clock of the text (D27)", () => {
  useRelay();

  test("the guest keeps up without pressing on a line, the lines match, and its press moves the host", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(900_000);
    // The host plays with the fast settings; the guest with the slow defaults of its own
    const hostContext = await newClientContext(browser, true);
    const guestContext = await newClientContext(browser, false);
    const [host, guest] = await Promise.all([openClient(hostContext, "host"), openClient(guestContext, "guest")]);
    try {
      await Promise.all([waitForTitle(host), waitForTitle(guest)]);
      await startLinkedRun(host, guest);

      // The guest takes the host's game speed
      await expect
        .poll(async () => (await paceOf(guest))?.gameSpeed, { message: "the guest's game speed", timeout: 30_000 })
        .toBe(5);

      // Wave 1: the host plays as usual; the guest makes its decisions and answers its own questions, but never presses on
      // a line of the run
      await Promise.all([
        playUntil(host, "the first reward screen", atRewards),
        playUntil(guest, "the first reward screen", atRewards, 300_000, false, "own"),
      ]);
      const [hostPace, guestPace] = await Promise.all([paceOf(host), paceOf(guest)]);
      expect(guestPace!.stats.followed, "lines the guest's screen closed by itself").toBeGreaterThan(0);
      expect(guestPace!.stats.presses).toBe(0);

      // The same line at each place on both screens
      const hostLines = new Map(hostPace!.prompts.map(line => [key(line.at), line.text]));
      const shared = guestPace!.prompts.filter(line => hostLines.has(key(line.at)));
      expect(shared.length, "lines both screens showed").toBeGreaterThan(2);
      for (const line of shared) {
        expect(line.text, `the line at ${key(line.at)}`).toBe(hostLines.get(key(line.at)));
      }
      await testInfo.attach("lines.json", {
        body: JSON.stringify({ host: hostPace!.prompts, guest: guestPace!.prompts }, null, 2),
        contentType: "application/json",
      });

      // Wave 2: nobody presses on a line of the run, so both stop on the same one; the guest's press moves both
      await waitForRewardReady(host);
      await skipScreen(host);
      const sameLine = async (): Promise<boolean> => {
        const [h, g] = await Promise.all([paceOf(host), paceOf(guest)]);
        return h?.open != null && g?.open != null && key(h.open) === key(g.open);
      };
      await Promise.all([
        playUntil(host, "a line both wait on", sameLine, 300_000, false, "own"),
        playUntil(guest, "a line both wait on", sameLine, 300_000, false, "own"),
      ]);
      const line = (await paceOf(host))!.open!;
      await press(guest, "ACTION");
      await expect
        .poll(async () => before(line, (await paceOf(host))!.position), {
          message: `the host's line at ${key(line)} after the guest's press`,
          timeout: 10_000,
        })
        .toBe(true);
      expect((await paceOf(host))!.stats.presses).toBe(1);

      expect(host.errors, "host console errors").toEqual([]);
      expect(guest.errors, "guest console errors").toEqual([]);
    } catch (error) {
      await testInfo.attach("clients.json", {
        body: JSON.stringify(
          { ...(await describeClients(host, guest)), pace: { host: await paceOf(host), guest: await paceOf(guest) } },
          null,
          2,
        ),
        contentType: "application/json",
      });
      throw error;
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});
