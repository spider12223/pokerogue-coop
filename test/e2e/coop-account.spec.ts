/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from "@playwright/test";
import {
  bothAtScreen,
  type Client,
  describeClients,
  desyncOf,
  newClientContext,
  openClient,
  playUntil,
  seatClients,
  skipScreen,
  startLinkedRun,
  useRelay,
  waitForTitle,
} from "./coop-client.ts";

/**
 * End-to-end test (DECISIONS D4a, D19): what a co-op run gives a player's own Pokémon reaches the account their browser
 * saves, through the real lobby (the merge of both collections, D32), the starter select and the start of the run, for the
 * guest as for the host. A player's report: the second player got no candies and none of their catches on their account.
 *
 * | step | what happens | what is checked |
 * | --- | --- | --- |
 * | 1 | both start a run from the title screen | each player's own starter is known |
 * | 2 | wave 1 is won (both starters took part), the reward is skipped, wave 2 starts | each browser saved its account at the start of wave 2, and its own starter's candy progress went up there; the partner's starter's did not |
 */

/** Candy and candy progress of a starter, in an account */
interface StarterProgress {
  candyCount: number;
  friendship: number;
}

/** The root species of this player's own Pokémon in the run */
const ownRootSpecies = (client: Client): Promise<number[]> =>
  client.page.evaluate(
    async paths => {
      const [{ globalScene }, { getCoopSession }] = await Promise.all(paths.map(path => import(path)));
      const session = getCoopSession();
      return globalScene
        .getPlayerParty()
        .filter((p: any) => session.ownerOf(p.id) === session.seat)
        .map((p: any) => p.species.getRootSpeciesId() as number);
    },
    ["/src/globals/global-scene.ts", "/src/coop/session.ts"],
  );

/** The starters' progress in the account this browser saved last (`data_<user>`): what the next start of the game loads */
const savedProgress = (client: Client, species: number[]): Promise<Record<number, StarterProgress> | null> =>
  client.page.evaluate(
    async ({ path, species }) => {
      const { loggedInUser } = await import(path);
      const stored = localStorage.getItem(`data_${loggedInUser?.username}`);
      if (stored === null) {
        return null;
      }
      // a local account (bypassLogin) is saved as base64 of the URI-encoded JSON (`encrypt` in src/utils/data.ts)
      const data = JSON.parse(decodeURIComponent(atob(stored)));
      const out: Record<number, { candyCount: number; friendship: number }> = {};
      for (const id of species) {
        const entry = data.starterData[id];
        out[id] = { candyCount: entry?.candyCount ?? 0, friendship: entry?.friendship ?? 0 };
      }
      return out;
    },
    { path: "/src/account.ts", species },
  );

/** Candy counts for more than the progress toward the next one */
const progressOf = (entry: StarterProgress | undefined): number =>
  entry === undefined ? 0 : entry.candyCount * 10_000 + entry.friendship;

test.describe("co-op: each player's account keeps what the run gives their own Pokémon", () => {
  useRelay();

  test("the guest's starter gets its candy progress on the guest's saved account, as the host's on the host's", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(900_000);
    const hostContext = await newClientContext(browser, true);
    const guestContext = await newClientContext(browser, true);
    const [host, guest] = await Promise.all([openClient(hostContext, "host"), openClient(guestContext, "guest")]);

    try {
      await Promise.all([waitForTitle(host), waitForTitle(guest)]);
      await startLinkedRun(host, guest);

      // #region 1: each player's own starter
      const [hostOwn, guestOwn] = await Promise.all([ownRootSpecies(host), ownRootSpecies(guest)]);
      expect(hostOwn, "the host's own starter").toHaveLength(1);
      expect(guestOwn, "the guest's own starter").toHaveLength(1);
      expect(guestOwn[0]).not.toBe(hostOwn[0]);
      const both = [...hostOwn, ...guestOwn];
      // the account as saved at the start of wave 1 (or never, for a new account: nothing yet)
      const before = {
        host: await savedProgress(host, both),
        guest: await savedProgress(guest, both),
      };
      console.log(`account e2e: own ${JSON.stringify({ hostOwn, guestOwn })}; before ${JSON.stringify(before)}`);
      // #endregion

      // #region 2: wave 1 won, the reward skipped, wave 2 started (the account is saved at its start, D19)
      const first = await bothAtScreen(host, guest, 0);
      const { picker } = seatClients(host, guest, first.picker);
      await skipScreen(picker);
      const atWaveTwo = (client: Client) =>
        playUntil(client, "the command menu of wave 2", state => state.wave >= 2 && state.ui === "COMMAND");
      await Promise.all([atWaveTwo(host), atWaveTwo(guest)]);
      const after = {
        host: await savedProgress(host, both),
        guest: await savedProgress(guest, both),
      };
      console.log(`account e2e: after ${JSON.stringify(after)}`);

      expect(after.host, "the host's browser saved its account").not.toBeNull();
      expect(after.guest, "the guest's browser saved its account").not.toBeNull();
      // each player's own starter went up on their own account
      expect(progressOf(after.host?.[hostOwn[0]]), "the host's starter, host's account").toBeGreaterThan(
        progressOf(before.host?.[hostOwn[0]]),
      );
      expect(progressOf(after.guest?.[guestOwn[0]]), "the guest's starter, guest's account").toBeGreaterThan(
        progressOf(before.guest?.[guestOwn[0]]),
      );
      // and the partner's did not (D4a: each client writes only for its own player's Pokémon)
      expect(progressOf(after.host?.[guestOwn[0]]), "the guest's starter, host's account").toBe(
        progressOf(before.host?.[guestOwn[0]]),
      );
      expect(progressOf(after.guest?.[hostOwn[0]]), "the host's starter, guest's account").toBe(
        progressOf(before.guest?.[hostOwn[0]]),
      );
      for (const client of [host, guest]) {
        expect(await desyncOf(client), `${client.label} desync`).toBeNull();
      }
      // #endregion
    } catch (error) {
      const state = JSON.stringify(await describeClients(host, guest), null, 2);
      await testInfo.attach("clients.json", { body: state, contentType: "application/json" });
      console.log(`co-op account e2e failed; clients: ${state}`);
      throw error;
    } finally {
      expect([...host.errors, ...guest.errors], "console errors").toEqual([]);
      await hostContext.close();
      await guestContext.close();
    }
  });
});
