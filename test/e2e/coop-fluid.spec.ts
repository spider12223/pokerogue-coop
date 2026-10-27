/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { MoveId } from "../../src/enums/move-id.ts";
import {
  bothAtScreen,
  type Client,
  checkpointsOf,
  describeClients,
  desyncOf,
  newClientContext,
  openClient,
  partyOf,
  playUntil,
  press,
  rewardOf,
  shotsDir,
  skipScreen,
  startLinkedRun,
  ui,
  useRelay,
  waitForRewardReady,
  waitForTitle,
} from "./coop-client.ts";

/**
 * End-to-end test: two real browser clients, three waves, and the things that make a co-op run flow (DECISIONS D11,
 * D16, D17). The settings are the fastest local-only ones.
 *
 * | when | what is checked |
 * | --- | --- |
 * | wave 1, turn 1 | the guest sees the host's tentative move and target as a ghost marker, and a check mark once it is chosen |
 * | reward screen 0 (the host picks) | the guest sees the host's cursor; a ping and an emote arrive, with the host's name; either asks for a trade |
 * | the trade | the host proposes a swap, the guest accepts, both are done; in wave 2 each Pokémon is in the slot of its new owner |
 * | reward screen 1 (the guest picks, and is away) | with the timers at 3 s and 6 s the host is told, is offered to take over, does, and skips for the guest |
 *
 * Screenshots go to `test-results/screenshots/fluid/`.
 */

const SHOTS = shotsDir("fluid");
const OVERRIDES = {
  STARTING_LEVEL_OVERRIDE: 25,
  MOVESET_OVERRIDE: [MoveId.TACKLE, MoveId.GROWL, MoveId.TAIL_WHIP, MoveId.LEER],
};
const TACKLE = MoveId.TACKLE;
const GROWL = MoveId.GROWL;

const sleep = (client: Client, ms: number): Promise<void> => client.page.waitForTimeout(ms);
const cosmetics = (client: Client) => client.page.evaluate(() => (window as any).__coop.cosmetics);
const trade = (client: Client) => client.page.evaluate(() => (window as any).__coop.trade);
const field = (client: Client) => client.page.evaluate(() => (window as any).__coop.field);
const takeovers = (client: Client) => client.page.evaluate(() => (window as any).__coop.takeovers);

async function shot(client: Client, name: string): Promise<void> {
  await client.page.screenshot({ path: join(SHOTS, name) });
}

/** The partner's intent for one of its Pokémon, as this client sees it */
async function intentOf(client: Client, pokemonId: number) {
  const state = await cosmetics(client);
  return state?.intents.find((intent: { pokemonId: number }) => intent.pokemonId === pokemonId) ?? null;
}

/** On the trade screen: move to an action of the bar by its label, and choose it */
async function chooseTradeAction(client: Client, label: string): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const screen = await trade(client);
    if (screen === null) {
      throw new Error(`${client.label} has no trade screen`);
    }
    if (screen.cursor.side !== 2) {
      await press(client, "DOWN");
    } else if (screen.actions[screen.cursor.action] === label) {
      await press(client, "ACTION");
      return;
    } else {
      await press(client, screen.actions.indexOf(label) > screen.cursor.action ? "RIGHT" : "LEFT");
    }
    await sleep(client, 150);
  }
  throw new Error(`${client.label} could not reach "${label}" on the trade screen`);
}

test.describe("co-op: fluid UX and trade", () => {
  useRelay();

  test("intents, a mirrored cursor, pings, a trade and a take over, in three waves", async ({ browser }, testInfo) => {
    test.setTimeout(1_500_000);
    mkdirSync(SHOTS, { recursive: true });
    const hostContext = await newClientContext(browser, true);
    const guestContext = await newClientContext(browser, true);
    const [host, guest] = await Promise.all([openClient(hostContext, "host"), openClient(guestContext, "guest")]);

    try {
      await Promise.all([waitForTitle(host), waitForTitle(guest)]);
      // The names the players chose (D1)
      await host.page.evaluate(() => (window as any).__coop.setName("Sam"));
      await guest.page.evaluate(() => (window as any).__coop.setName("Alex"));
      await startLinkedRun(host, guest, async () => {
        for (const client of [host, guest]) {
          await client.page.evaluate(values => (window as any).__coop.setOverrides(values), OVERRIDES);
        }
      });
      expect(await host.page.evaluate(() => (window as any).__coop.partnerName)).toBe("Alex");
      expect(await guest.page.evaluate(() => (window as any).__coop.partnerName)).toBe("Sam");

      // #region Wave 1, turn 1: the host chooses slowly, and the guest watches (D8, D16)
      const atCommand = (state: { ui: string; phase: { name: string } | null }): boolean =>
        state.ui === "COMMAND" && state.phase?.name === "CommandPhase";
      await Promise.all([
        playUntil(host, "the command screen", atCommand),
        playUntil(guest, "the command screen", atCommand),
      ]);
      const onField = (await field(host)) as { pokemonId: number; owner: string }[];
      const hostPokemonId = onField.find(slot => slot.owner === "host")!.pokemonId;

      await press(host, "ACTION"); // Fight
      await expect.poll(() => ui(host), { timeout: 20_000 }).toBe("FIGHT");
      await expect
        .poll(async () => (await intentOf(guest, hostPokemonId))?.move, {
          message: "the guest never saw the move",
          timeout: 15_000,
        })
        .toBe(TACKLE);
      await press(host, "RIGHT");
      await expect.poll(async () => (await intentOf(guest, hostPokemonId))?.move, { timeout: 15_000 }).toBe(GROWL);
      await press(host, "LEFT");
      await expect.poll(async () => (await intentOf(guest, hostPokemonId))?.move, { timeout: 15_000 }).toBe(TACKLE);
      await press(host, "ACTION");
      await expect.poll(() => ui(host), { timeout: 20_000 }).toBe("TARGET_SELECT");
      await expect
        .poll(async () => (await intentOf(guest, hostPokemonId))?.target, {
          message: "no target on the guest's screen",
          timeout: 15_000,
        })
        .not.toBeNull();
      const firstTarget = (await intentOf(guest, hostPokemonId)).target;
      await press(host, "RIGHT");
      await expect
        .poll(async () => (await intentOf(guest, hostPokemonId))?.target, { timeout: 15_000 })
        .not.toBe(firstTarget);
      // the ghost marker is on the guest's screen
      await sleep(guest, 1500);
      expect((await cosmetics(guest)).drawn).toBeGreaterThan(0);
      await shot(guest, "ghost-marker.png");

      await press(host, "ACTION"); // the command is made
      await expect
        .poll(async () => (await intentOf(guest, hostPokemonId))?.ready, { message: "no check mark", timeout: 15_000 })
        .toBe(true);
      await sleep(guest, 300);
      await shot(guest, "ready-badge.png");
      // #endregion

      // #region Reward screen 0: the host's cursor, a ping, an emote, a trade request
      await bothAtScreen(host, guest, 0);
      const first = await rewardOf(guest);
      expect(first?.picker).toBe("host");
      // the guest is told who is choosing, by name
      expect(first?.label).toContain("Sam");
      // (the markers of the turn are gone)
      await expect.poll(async () => (await cosmetics(guest)).intents, { timeout: 10_000 }).toEqual([]);

      expect(await host.page.evaluate(() => (window as any).__coop.moveRewardCursor(1, 1))).toBe(true);
      await expect
        .poll(async () => (await cosmetics(guest)).cursor, {
          message: "the guest never saw the cursor",
          timeout: 15_000,
        })
        .toEqual({ screen: 0, row: 1, col: 1 });
      await sleep(guest, 1500);
      await shot(guest, "reward-cursor.png");

      expect(await host.page.evaluate(() => (window as any).__coop.hotkey("ping"))).toBe(true);
      await expect
        .poll(async () => (await cosmetics(guest)).pings, { message: "the ping never arrived", timeout: 15_000 })
        .toMatchObject([{ name: "Sam", at: { k: "reward", index: 1 } }]);
      await sleep(guest, 600);
      await shot(guest, "ping.png");
      expect(await host.page.evaluate(() => (window as any).__coop.emote(2))).toBe(true);
      await expect
        .poll(async () => (await cosmetics(guest)).emotes, { timeout: 15_000 })
        .toMatchObject([{ name: "Sam", id: 2 }]);

      // the guest asks for a trade (the button is the fifth of the top row); both see it asked for
      await waitForRewardReady(guest);
      expect(await guest.page.evaluate(() => (window as any).__coop.moveRewardCursor(0, 4))).toBe(true);
      await press(guest, "ACTION");
      for (const client of [host, guest]) {
        await expect
          .poll(async () => (await rewardOf(client))?.tradeRequested, {
            message: `${client.label}: no trade request`,
            timeout: 20_000,
          })
          .toBe(true);
      }
      await waitForRewardReady(host);
      await skipScreen(host);
      // #endregion

      // #region The trade screen (D11)
      for (const client of [host, guest]) {
        await expect
          .poll(() => ui(client), { message: `${client.label}: no trade screen`, timeout: 60_000 })
          .toBe("COOP_TRADE");
      }
      const before = await partyOf(host);
      expect(await partyOf(guest)).toEqual(before);
      const hostPokemon = before.findIndex(member => member.owner === "host");
      const guestPokemon = before.findIndex(member => member.owner === "guest");
      const slots = (await field(host)) as { pokemonId: number; owner: string }[];
      const hostId = slots.find(slot => slot.owner === "host")!.pokemonId;
      const guestId = slots.find(slot => slot.owner === "guest")!.pokemonId;
      await sleep(host, 600);

      await press(host, "ACTION"); // give the first of mine
      await press(host, "RIGHT");
      await press(host, "ACTION"); // for the first of theirs
      await expect.poll(async () => (await trade(host)).give, { timeout: 10_000 }).toBe(hostId);
      await expect.poll(async () => (await trade(host)).want, { timeout: 10_000 }).toBe(guestId);
      await shot(host, "trade-screen.png");
      await chooseTradeAction(host, "Propose");

      await expect
        .poll(async () => (await trade(guest))?.mode, { message: "the guest never saw the proposal", timeout: 20_000 })
        .toBe("answer");
      expect((await trade(guest)).actions).toEqual(["Accept", "Decline"]);
      await sleep(guest, 1500);
      await shot(guest, "trade-proposal.png");
      await chooseTradeAction(guest, "Accept");

      for (const client of [host, guest]) {
        await expect
          .poll(async () => (await partyOf(client))[hostPokemon].owner, {
            message: `${client.label}: the trade did not go through`,
            timeout: 20_000,
          })
          .toBe("guest");
        expect((await partyOf(client))[guestPokemon].owner).toBe("host");
      }
      await chooseTradeAction(host, "Done");
      // the guest sees the host done: a green mark on the host's list
      await expect.poll(async () => (await trade(guest))?.status, { timeout: 10_000 }).toMatch(/is done/);
      await sleep(guest, 800);
      await shot(guest, "trade-partner-done.png");
      await chooseTradeAction(guest, "Done");
      // #endregion

      // #region Wave 2: each Pokémon is in the slot of its new owner
      await Promise.all([
        playUntil(host, "wave 2", state => state.wave === 2 && atCommand(state)),
        playUntil(guest, "wave 2", state => state.wave === 2 && atCommand(state)),
      ]);
      for (const client of [host, guest]) {
        const now = (await field(client)) as { slot: number; pokemonId: number; owner: string }[];
        // the host's first Pokémon is the one it got from the guest, in slot 0; the guest's the one it got, in slot 1
        expect(now.map(slot => [slot.pokemonId, slot.owner])).toEqual([
          [guestId, "host"],
          [hostId, "guest"],
        ]);
      }
      // #endregion

      // #region Reward screen 1: the guest picks, and is away (D17)
      await bothAtScreen(host, guest, 1);
      for (const client of [host, guest]) {
        await client.page.evaluate(() => (window as any).__coop.setAfkTimers(3000, 6000, 3000));
      }
      expect((await rewardOf(host))?.picker).toBe("guest");
      await expect
        .poll(async () => (await rewardOf(host))?.label, { message: "no hint", timeout: 15_000 })
        .toContain("Alex is still choosing");
      await expect.poll(() => ui(host), { message: "no offer to take over", timeout: 20_000 }).toBe("OPTION_SELECT");
      await sleep(host, 300);
      await shot(host, "take-over-offer.png");
      await press(host, "ACTION"); // Take over
      await expect
        .poll(async () => (await rewardOf(host))?.label, { message: "the take over did not start", timeout: 20_000 })
        .toContain("You are choosing for Alex");
      await waitForRewardReady(host);
      await skipScreen(host);
      for (const client of [host, guest]) {
        await expect
          .poll(async () => (await takeovers(client)).length, {
            message: `${client.label}: no take over was sequenced`,
            timeout: 30_000,
          })
          .toBe(1);
        expect((await takeovers(client))[0]).toMatchObject({ author: "host" });
      }
      // #endregion

      // Wave 3 begins on both
      await Promise.all([
        playUntil(host, "wave 3", state => state.wave === 3 && atCommand(state)),
        playUntil(guest, "wave 3", state => state.wave === 3 && atCommand(state)),
      ]);

      const [a, b] = await Promise.all([checkpointsOf(host), checkpointsOf(guest)]);
      expect(b).toEqual(a);
      expect(a.filter(c => c.kind === "rewards").map(c => c.wave)).toEqual([1, 2]);
      expect(await desyncOf(host)).toBeNull();
      expect(await desyncOf(guest)).toBeNull();
      await testInfo.attach("host.png", { body: await host.page.screenshot(), contentType: "image/png" });
      await testInfo.attach("guest.png", { body: await guest.page.screenshot(), contentType: "image/png" });
    } catch (error) {
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
