/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from "@playwright/test";
import { MoveId } from "../../src/enums/move-id.ts";
import {
  bothAtScreen,
  checkpointsOf,
  describeClients,
  desyncOf,
  newClientContext,
  openClient,
  type PartyMember,
  partyOf,
  playUntil,
  pressIf,
  rewardOf,
  seatClients,
  skipScreen,
  startLinkedRun,
  ui,
  useRelay,
  waitForRewardReady,
  waitForTitle,
  waitsOf,
} from "./coop-client.ts";

/**
 * End-to-end test: two real browser clients play five waves with the real relay. Between the waves:
 *
 * | screen | picker | what happens                                                                                |
 * | ------ | ------ | ------------------------------------------------------------------------------------------- |
 * | 0      | host   | the guest (not the picker) buys an Ether; the host picks a TM for a Pokémon -> a learn-move |
 * | 1      | guest  | the host tries to pick and cannot; the guest skips                                          |
 * | 2-4    | host, guest, host | the picker skips                                                                 |
 *
 * Both clients must pass the same state-hash checkpoints and neither may report a desync. The settings are the fastest
 * local-only ones (game speed, no animations): none of them is pinned, so they cannot matter (D5).
 */

/** What both clients are given after the handshake and before the run: the simulation is the same only if the overrides are */
const OVERRIDES = {
  // Strong enough to win five waves in a turn or two; four moves each, so that a TM asks which one to forget
  STARTING_LEVEL_OVERRIDE: 25,
  MOVESET_OVERRIDE: [MoveId.TACKLE, MoveId.GROWL, MoveId.TAIL_WHIP, MoveId.LEER],
  // The first reward of every screen is a TM
  ITEM_REWARD_OVERRIDE: [{ name: "TM_COMMON" }],
};

const WAVES = 5;

test.describe("co-op: two clients play five waves with the reward screens", () => {
  useRelay();

  test("the picker alternates, the non-picker buys, a TM teaches a move, and the hashes stay equal", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(1_200_000);
    const hostContext = await newClientContext(browser, true);
    const guestContext = await newClientContext(browser, true);
    const [host, guest] = await Promise.all([openClient(hostContext, "host"), openClient(guestContext, "guest")]);
    const started = Date.now();

    try {
      await Promise.all([waitForTitle(host), waitForTitle(guest)]);
      // A client with overrides cannot host or join (D1): they are set once both are linked
      await startLinkedRun(host, guest, async () => {
        for (const client of [host, guest]) {
          await client.page.evaluate(values => (window as any).__coop.setOverrides(values), OVERRIDES);
        }
      });

      // #region Screen 0: the host picks; the guest buys
      const first = await bothAtScreen(host, guest, 0);
      expect(first.picker).toBe("host");
      expect(first.step).toBe(0);
      expect(first.options[0].tmMove).not.toBeNull();
      const ether = first.shop.findIndex(item => /ether/i.test(item.name) && !/max/i.test(item.name));
      expect(ether, "an Ether in the shop").toBeGreaterThanOrEqual(0);
      expect(first.shop[ether].cost).toBeLessThanOrEqual(first.money);

      // The guest is not the picker, and buys: the shop row, the Ether, the first Pokémon's first move
      expect(await guest.page.evaluate(i => (window as any).__coop.moveRewardCursor(2, i), ether)).toBe(true);
      await pressIf(guest, "ACTION", "MODIFIER_SELECT");
      await expect.poll(() => ui(guest), { message: "the party menu of the buy", timeout: 20_000 }).toBe("PARTY");
      await pressIf(guest, "ACTION", "PARTY");
      await guest.page.waitForTimeout(300);
      await pressIf(guest, "ACTION", "PARTY");

      // Both see the purchase: the same money, the next step of the same screen
      for (const client of [host, guest]) {
        await expect
          .poll(async () => (await rewardOf(client))?.step, {
            message: `${client.label} after the buy`,
            timeout: 30_000,
          })
          .toBe(1);
        expect((await rewardOf(client))?.money).toBe(first.money - first.shop[ether].cost);
        expect((await rewardOf(client))?.screen).toBe(0);
      }

      // The host picks the TM, for a Pokémon that can learn it (the guest's, if it can)
      await waitForRewardReady(host);
      const tmMove = first.options[0].tmMove as number;
      const party: PartyMember[] = await partyOf(host);
      expect(await partyOf(guest)).toEqual(party);
      const learners: number[] = [];
      for (let i = 0; i < party.length; i++) {
        const can = await host.page.evaluate(
          ([index, move]) => (window as any).__coop.canLearnTm(index, move),
          [i, tmMove],
        );
        if (can && !party[i].moves.includes(tmMove)) {
          learners.push(i);
        }
      }
      expect(learners.length, "a Pokémon that can learn the TM").toBeGreaterThan(0);
      const target = learners.find(i => party[i].owner === "guest") ?? learners[0];
      expect(await host.page.evaluate(() => (window as any).__coop.moveRewardCursor(1, 0))).toBe(true);
      await pressIf(host, "ACTION", "MODIFIER_SELECT");
      await expect.poll(() => ui(host), { message: "the party menu of the TM", timeout: 20_000 }).toBe("PARTY");
      expect(await host.page.evaluate(i => (window as any).__coop.movePartyCursor(i), target)).toBe(true);
      await pressIf(host, "ACTION", "PARTY");
      await host.page.waitForTimeout(300);
      await pressIf(host, "ACTION", "PARTY");

      // The TM's owner is asked which move to forget (the loop answers "yes" and the first move); the other waits
      await Promise.all(
        [host, guest].map(client =>
          playUntil(
            client,
            "the learned move",
            async () => (await partyOf(client))[target].usedTms.includes(tmMove),
            60_000,
          ),
        ),
      );
      // #endregion

      // #region Screen 1: the guest picks, and the host cannot
      // (the learn-move prompt and wave 2 are played by the same loop as a battle)
      const second = await bothAtScreen(host, guest, 1);
      expect(second.picker).toBe("guest");
      expect(second.step).toBe(0);
      await waitForRewardReady(host);
      // the host tries to pick the first reward: nothing happens
      expect(await host.page.evaluate(() => (window as any).__coop.moveRewardCursor(1, 0))).toBe(true);
      await pressIf(host, "ACTION", "MODIFIER_SELECT");
      await host.page.waitForTimeout(1000);
      expect(await ui(host)).toBe("MODIFIER_SELECT");
      expect((await rewardOf(host))?.step).toBe(0);
      expect((await rewardOf(guest))?.step).toBe(0);
      await skipScreen(guest);
      // #endregion

      // #region Screens 2 to 4: the picker of each skips
      for (let screen = 2; screen < WAVES; screen++) {
        const opened = await bothAtScreen(host, guest, screen);
        expect(opened.picker).toBe(screen % 2 === 0 ? "host" : "guest");
        if (screen < WAVES - 1) {
          await skipScreen(seatClients(host, guest, opened.picker).picker);
        }
      }
      // #endregion

      // Wave 5 was played: the same checkpoints on both, five reward lists, no desync
      for (const client of [host, guest]) {
        expect((await rewardOf(client))?.screen).toBe(WAVES - 1);
        expect(await client.page.evaluate(() => (window as any).__coop.phase?.wave)).toBe(WAVES);
      }
      const [a, b] = await Promise.all([checkpointsOf(host), checkpointsOf(guest)]);
      expect(b).toEqual(a);
      expect(a.filter(c => c.kind === "rewards").map(c => c.wave)).toEqual([1, 2, 3, 4, 5]);
      expect(a.filter(c => c.kind === "waveStart").map(c => c.wave)).toEqual([1, 2, 3, 4, 5]);
      expect(await desyncOf(host)).toBeNull();
      expect(await desyncOf(guest)).toBeNull();

      const waits = { host: await waitsOf(host), guest: await waitsOf(guest) };
      const seconds = Math.round((Date.now() - started) / 1000);
      console.log(`co-op e2e: ${WAVES} waves in ${seconds} s after the title screens; waits ${JSON.stringify(waits)}`);
      await testInfo.attach("waits.json", { body: JSON.stringify(waits, null, 2), contentType: "application/json" });
      await testInfo.attach("host.png", { body: await host.page.screenshot(), contentType: "image/png" });
      await testInfo.attach("guest.png", { body: await guest.page.screenshot(), contentType: "image/png" });
    } catch (error) {
      // Where both clients were when it went wrong
      const state = JSON.stringify(await describeClients(host, guest), null, 2);
      await testInfo.attach("clients.json", { body: state, contentType: "application/json" });
      console.log(`co-op e2e failed; clients: ${state}`);
      throw error;
    } finally {
      expect([...host.errors, ...guest.errors], "console errors").toEqual([]);
      await hostContext.close();
      await guestContext.close();
    }
  });
});
