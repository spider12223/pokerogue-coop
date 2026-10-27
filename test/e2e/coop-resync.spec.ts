/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type BrowserContext, expect, type TestInfo, test } from "@playwright/test";
import {
  bothAtScreen,
  type Checkpoint,
  type Client,
  checkpointsOf,
  describeClients,
  desyncOf,
  newClientContext,
  openClient,
  openCoopMenu,
  playToRewardScreen,
  playUntil,
  press,
  seatClients,
  shotsDir,
  skipScreen,
  startLinkedRun,
  ui,
  useRelay,
  waitForTitle,
} from "./coop-client.ts";

/**
 * End-to-end tests: two real browser clients, and what happens to a run when a tab is reloaded or closed, when the
 * clients stop agreeing, and when the players come back another day (DECISIONS D13, D18, D19, D20, D21). The settings
 * are the fastest local-only ones. Screenshots go to
 * `test-results/screenshots/resync/`.
 *
 * | test | what happens | what is checked |
 * | --- | --- | --- |
 * | 1 | the guest reloads its tab in the first turn of wave 2 | the host waits with the room code; the guest rejoins by itself; both reload the wave 2 start under epoch 1 and finish the wave with equal hashes |
 * | 2 | the host closes its tab on the reward screen | the guest shows the waiting screen with the code; the host reopens, rejoins, and both resume |
 * | 3 | `__coop.corrupt()` flips one HP value on the guest | the clients notice, both reload the wave start (a notice says so), and play on with equal hashes |
 * | 4 | both players end the session and close the tabs | the host continues from its slot, the guest joins the new code, and they play a wave |
 */

const SHOTS = shotsDir("resync");

const sleep = (client: Client, ms: number): Promise<void> => client.page.waitForTimeout(ms);
/** A value of the debug API, by its path: `coop(client, "phase.name")` */
const coop = <T>(client: Client, path: string): Promise<T> =>
  client.page.evaluate(
    keys => keys.split(".").reduce((value: any, key) => value?.[key], (window as any).__coop) as T,
    path,
  );

/** A screenshot, after the text on screen has been typed out (it appears letter by letter) */
async function shot(client: Client, name: string, wait = 2000): Promise<void> {
  await sleep(client, wait);
  await client.page.screenshot({ path: join(SHOTS, name) });
}

/** The message window of the client shows this text, typed out (what the screenshot will have on it) */
async function expectMessage(client: Client, text: string): Promise<void> {
  await expect
    .poll(() => coop<string>(client, "messageText"), {
      message: `${client.label}'s message window never showed "${text}"`,
      timeout: 30_000,
    })
    .toContain(text);
}

interface Timing {
  rejoinStartedAt?: number;
  handshakeAt?: number;
  resyncReceivedAt?: number;
  reloadStartedAt?: number;
  reloadedAt?: number;
}

type State = { ui: string; phase: { name: string } | null; wave: number };

/**
 * The player is choosing commands (the command menu of this wave is up), or has none to choose and waits for the partner's:
 * with one Pokémon each, a faint in the wave before leaves a player without a command menu
 */
const atCommand =
  (wave: number) =>
  (state: State): boolean =>
    state.wave === wave
    && ((state.ui === "COMMAND" && state.phase?.name === "CommandPhase") || state.phase?.name === "CoopTurnSyncPhase");

/** `atCommand`, in the world that was loaded by a reload (the old world may be waiting at the same turn) */
const afterReload =
  (client: Client, wave: number) =>
  async (state: State): Promise<boolean> =>
    (await coop<number>(client, "epoch")) >= 1 && atCommand(wave)(state);

/** The checkpoints of the epoch this client is in now (an epoch starts its log again from the loaded wave, D18) */
async function currentEpochCheckpoints(client: Client): Promise<Checkpoint[]> {
  return checkpointsOf(client);
}

/** Both clients have the same checkpoints in the current epoch, and no desync */
async function expectEqualHashes(host: Client, guest: Client): Promise<void> {
  const [a, b] = await Promise.all([currentEpochCheckpoints(host), currentEpochCheckpoints(guest)]);
  expect(a.length, "checkpoints of the current epoch").toBeGreaterThan(0);
  expect(b).toEqual(a);
  expect(await desyncOf(host)).toBeNull();
  expect(await desyncOf(guest)).toBeNull();
}

/** Two clients that are linked and in the first wave */
async function startRun(
  browser: import("@playwright/test").Browser,
): Promise<{ hostContext: BrowserContext; guestContext: BrowserContext; host: Client; guest: Client }> {
  mkdirSync(SHOTS, { recursive: true });
  const hostContext = await newClientContext(browser, true);
  const guestContext = await newClientContext(browser, true);
  const [host, guest] = await Promise.all([openClient(hostContext, "host"), openClient(guestContext, "guest")]);
  await Promise.all([waitForTitle(host), waitForTitle(guest)]);
  await host.page.evaluate(() => (window as any).__coop.setName("Sam"));
  await guest.page.evaluate(() => (window as any).__coop.setName("Alex"));
  await startLinkedRun(host, guest);
  return { hostContext, guestContext, host, guest };
}

/** Play wave 1 and its reward screen to the command menu of wave 2 (the picker of the screen skips it) */
async function toWave2(host: Client, guest: Client): Promise<void> {
  const opened = await bothAtScreen(host, guest, 0);
  await skipScreen(seatClients(host, guest, opened.picker).picker);
  await Promise.all([
    playUntil(host, "wave 2 commands", atCommand(2)),
    playUntil(guest, "wave 2 commands", atCommand(2)),
  ]);
}

/** A page that was just loaded: wait until the game has installed its debug API */
async function waitForCoopApi(client: Client): Promise<void> {
  await expect
    .poll(() => client.page.evaluate(() => typeof (window as any).__coop !== "undefined"), {
      message: `${client.label} never loaded the game`,
      timeout: 240_000,
      intervals: [500],
    })
    .toBe(true);
}

/** The time it took a client that came back to be playable: from the first attempt to rejoin to the command menu */
async function timeToPlayable(client: Client, wave: number): Promise<{ ms: number; timing: Timing }> {
  await playUntil(client, "playable again", afterReload(client, wave));
  const now = Date.now();
  const timing = await coop<Timing>(client, "timing");
  return { ms: now - (timing.rejoinStartedAt ?? now), timing };
}

/**
 * The run was lost in a random battle. A rejoin cannot have overrides (the handshake compares them, D1), so the party of the
 * run is two Pokémon at their starting level, and a bad wave can end it. The scenario is played again from the start.
 */
class LostRun extends Error {}

/** Fail the scenario: with `LostRun` when a battle ended the run, with the error as it was otherwise */
function failed(error: unknown, ...clients: Client[]): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("the run is over") || clients.some(c => c.presses.some(p => p.includes("GameOverPhase")))) {
    throw new LostRun(message);
  }
  throw error;
}

const ATTEMPTS = 3;

/** A scenario of this file: played again, from a new run, when a battle ended it (at most `ATTEMPTS` times) */
function scenario(title: string, body: (browser: Browser, testInfo: TestInfo) => Promise<void>): void {
  test(title, async ({ browser }, testInfo) => {
    test.setTimeout(1_800_000);
    for (let attempt = 1; ; attempt++) {
      try {
        await body(browser, testInfo);
        return;
      } catch (error) {
        if (!(error instanceof LostRun) || attempt >= ATTEMPTS) {
          throw error;
        }
        console.log(
          `co-op e2e: the run was lost in a random battle; playing "${title}" again (${attempt}/${ATTEMPTS})`,
        );
      }
    }
  });
}

test.describe("co-op: save, reconnect, resync", () => {
  useRelay();

  scenario(
    "the guest reloads its tab in wave 2: it rejoins by itself and both resume the wave start",
    async (browser, testInfo) => {
      const { hostContext, guestContext, host, guest } = await startRun(browser);
      try {
        await toWave2(host, guest);
        // the first turn of wave 2: the host chooses (the check mark of the guest is not needed here)
        const code = await coop<string | null>(host, "roomCode");
        expect(code).toMatch(/^[A-Z0-9]{4,8}$/);
        expect(await coop<number>(host, "epoch")).toBe(0);

        await guest.page.reload();
        await waitForCoopApi(guest);

        // the host is told and waits at its next decision, with the room code
        await expect
          .poll(() => coop<boolean>(host, "partnerPresent"), {
            message: "the host never saw the guest leave",
            timeout: 30_000,
          })
          .toBe(false);
        // the host goes on until its next decision (it chooses its commands), where it waits for the partner
        await playUntil(
          host,
          "the waiting screen",
          async () => (await coop<string | null>(host, "reconnectScreen")) !== null,
        );
        expect(await coop<string | null>(host, "reconnectScreen")).toContain(code!);
        await expectMessage(host, code!);
        await shot(host, "waiting-screen.png", 300);

        // the guest rejoins without being asked: after the boot, the same room, the same seat
        const { ms, timing } = await timeToPlayable(guest, 2);
        await playUntil(host, "wave 2 commands again", afterReload(host, 2));
        console.log(
          `co-op e2e guest reload: playable ${Math.round(ms)} ms after the rejoin began; ${JSON.stringify(timing)}`,
        );
        await testInfo.attach("rejoin-timing.json", {
          body: JSON.stringify({ ms, timing }, null, 2),
          contentType: "application/json",
        });

        // epoch 1 on both, the same wave, and the wave is played to its end with the same hashes
        expect(await coop<number>(host, "epoch")).toBe(1);
        expect(await coop<number>(guest, "epoch")).toBe(1);
        expect((await coop<{ wave: number }>(host, "phase")).wave).toBe(2);
        await Promise.all([playToRewardScreen(host, 1), playToRewardScreen(guest, 1)]);
        await expectEqualHashes(host, guest);
        expect(await coop<{ reason: string }[]>(host, "resyncs")).toMatchObject([{ reason: "rejoin" }]);
      } catch (error) {
        const state = JSON.stringify(await describeClients(host, guest), null, 2);
        await testInfo.attach("clients.json", { body: state, contentType: "application/json" });
        console.log(`co-op e2e (guest reload) failed; clients: ${state}`);
        failed(error, host, guest);
      } finally {
        await hostContext.close();
        await guestContext.close();
      }
    },
  );

  scenario(
    "the host closes its tab on the reward screen: the guest waits, the host rejoins, both resume",
    async (browser, testInfo) => {
      const { hostContext, guestContext, host, guest } = await startRun(browser);
      let hostAgain: Client = host;
      try {
        await Promise.all([playToRewardScreen(host, 0), playToRewardScreen(guest, 0)]);
        const code = await coop<string | null>(host, "roomCode");
        expect(code).toMatch(/^[A-Z0-9]{4,8}$/);

        await host.page.close();

        // the guest is on the reward screen, which waits for a decision: the waiting screen replaces it, with the code
        await expect
          .poll(() => coop<string | null>(guest, "reconnectScreen"), {
            message: "the guest shows no waiting screen",
            timeout: 60_000,
          })
          .toContain(code!);
        expect(await coop<string>(guest, "ui")).toBe("MESSAGE");
        // the reward screen was still opening when the host left: its own animation must not draw over the waiting text
        await sleep(guest, 4000);
        await expectMessage(guest, code!);
        await shot(guest, "waiting-screen-reward.png", 300);

        // the host opens the game again in the same browser: it takes its seat back and loads its slot
        hostAgain = await openClient(hostContext, "host");
        await waitForCoopApi(hostAgain);
        const { ms, timing } = await timeToPlayable(hostAgain, 1);
        await playUntil(guest, "wave 1 commands again", afterReload(guest, 1));
        console.log(
          `co-op e2e host reopen: playable ${Math.round(ms)} ms after the rejoin began; ${JSON.stringify(timing)}`,
        );
        await testInfo.attach("rejoin-timing.json", {
          body: JSON.stringify({ ms, timing }, null, 2),
          contentType: "application/json",
        });

        expect(await coop<number>(hostAgain, "epoch")).toBe(1);
        expect(await coop<number>(guest, "epoch")).toBe(1);
        // the wave is played again, to the same reward screen, and the hashes of the two clients are the same
        await Promise.all([playToRewardScreen(hostAgain, 0), playToRewardScreen(guest, 0)]);
        await expectEqualHashes(hostAgain, guest);
      } catch (error) {
        const state = JSON.stringify(
          await describeClients(hostAgain.page.isClosed() ? guest : hostAgain, guest),
          null,
          2,
        );
        await testInfo.attach("clients.json", { body: state, contentType: "application/json" });
        console.log(`co-op e2e (host reopen) failed; clients: ${state}`);
        failed(error, hostAgain, guest);
      } finally {
        await hostContext.close();
        await guestContext.close();
      }
    },
  );

  scenario(
    "a corrupted value on the guest triggers a resync, and the run goes on with equal hashes",
    async (browser, testInfo) => {
      const { hostContext, guestContext, host, guest } = await startRun(browser);
      try {
        await toWave2(host, guest);
        expect(await coop<number>(host, "epoch")).toBe(0);

        // flip one HP value on the guest: the next checkpoint (the start of the next turn) differs, so play the turn
        expect(await guest.page.evaluate(() => (window as any).__coop.corrupt())).toBe(true);

        // both reload the wave start, and say so (the notice stays up for a second or two)
        await Promise.all([
          playUntil(host, "the reload notice", state => state.phase?.name === "CoopResyncPhase", 180_000, true),
          playUntil(guest, "the reload notice", state => state.phase?.name === "CoopResyncPhase", 180_000, true),
        ]);
        await shot(host, "resync-notice.png", 300);
        await playUntil(host, "wave 2 commands again", afterReload(host, 2));
        await playUntil(guest, "wave 2 commands again", afterReload(guest, 2));

        expect(await coop<number>(host, "epoch")).toBe(1);
        expect(await coop<number>(guest, "epoch")).toBe(1);
        const resyncs = await coop<{ reason: string; wave: number }[]>(host, "resyncs");
        expect(resyncs).toHaveLength(1);
        expect(["mismatch", "desync"]).toContain(resyncs[0]!.reason);
        expect(resyncs[0]!.wave).toBe(2);

        await Promise.all([playToRewardScreen(host, 1), playToRewardScreen(guest, 1)]);
        await expectEqualHashes(host, guest);
      } catch (error) {
        const state = JSON.stringify(await describeClients(host, guest), null, 2);
        await testInfo.attach("clients.json", { body: state, contentType: "application/json" });
        console.log(`co-op e2e (resync) failed; clients: ${state}`);
        failed(error, host, guest);
      } finally {
        await hostContext.close();
        await guestContext.close();
      }
    },
  );

  scenario(
    "both close: the host continues from its slot, the guest joins the new code, and they play a wave",
    async (browser, testInfo) => {
      const { hostContext, guestContext, host, guest } = await startRun(browser);
      let hostAgain: Client = host;
      let guestAgain: Client = guest;
      try {
        await toWave2(host, guest);
        // the slot of the host has the start of wave 2
        expect(await host.page.evaluate(() => (window as any).__coop.slot)).toMatchObject({ wave: 2 });
        const before = (await coop<{ owner: string; name: string }[]>(host, "party")).map(
          member => `${member.owner}:${member.name}`,
        );

        // end the session on both, as "End session" does, and close the tabs
        expect(await host.page.evaluate(() => (window as any).__coop.leave())).toBe(true);
        // the relay tells the guest that the room is closed: it goes back to the title screen by itself
        await expect
          .poll(() => coop<string | null>(guest, "seat"), {
            message: "the guest is still in the session",
            timeout: 30_000,
          })
          .toBeNull();
        await host.page.close();
        await guest.page.close();

        // the host: Co-op, Continue (the first entry while there is a slot)
        hostAgain = await openClient(hostContext, "host");
        guestAgain = await openClient(guestContext, "guest");
        await Promise.all([waitForTitle(hostAgain), waitForTitle(guestAgain)]);
        expect(await hostAgain.page.evaluate(() => (window as any).__coop.slot)).toMatchObject({ wave: 2 });
        expect(await guestAgain.page.evaluate(() => (window as any).__coop.slot)).toBeNull();
        await openCoopMenu(hostAgain);
        await press(hostAgain, "ACTION");
        await expect
          .poll(() => coop<string | null>(hostAgain, "joinCode"), {
            message: "no code for the continued run",
            timeout: 30_000,
          })
          .not.toBeNull();
        const code = (await coop<string>(hostAgain, "joinCode"))!;

        // the guest joins it with the code: Co-op, Join a game
        await openCoopMenu(guestAgain);
        await press(guestAgain, "DOWN");
        await sleep(guestAgain, 200);
        await press(guestAgain, "ACTION");
        await expect.poll(() => ui(guestAgain), { timeout: 20_000 }).toBe("COOP_JOIN_FORM");
        expect(await guestAgain.page.evaluate(joinCode => (window as any).__coop.submitJoinCode(joinCode), code)).toBe(
          true,
        );

        // both load the start of wave 2
        await Promise.all([
          playUntil(hostAgain, "wave 2 commands", afterReload(hostAgain, 2)),
          playUntil(guestAgain, "wave 2 commands", afterReload(guestAgain, 2)),
        ]);
        expect(
          (await coop<{ owner: string; name: string }[]>(hostAgain, "party")).map(m => `${m.owner}:${m.name}`),
        ).toEqual(before);
        expect(await coop<number>(hostAgain, "epoch")).toBeGreaterThan(0);
        expect(await coop<number>(guestAgain, "epoch")).toBe(await coop<number>(hostAgain, "epoch"));
        await shot(hostAgain, "continue-resumed.png");

        await Promise.all([playToRewardScreen(hostAgain, 1), playToRewardScreen(guestAgain, 1)]);
        await expectEqualHashes(hostAgain, guestAgain);
      } catch (error) {
        const state = JSON.stringify(await describeClients(hostAgain, guestAgain), null, 2);
        await testInfo.attach("clients.json", { body: state, contentType: "application/json" });
        console.log(`co-op e2e (continue) failed; clients: ${state}`);
        failed(error, hostAgain, guestAgain);
      } finally {
        await hostContext.close();
        await guestContext.close();
      }
    },
  );
});
