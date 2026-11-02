/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  type Client,
  choosePlayers,
  desyncOf,
  newClientContext,
  openClient,
  openCoopMenu,
  pickAndReady,
  press,
  shotsDir,
  ui,
  untilWaveOne,
  useRelay,
  waitForTitle,
} from "./coop-client.ts";

/**
 * Co-op challenge runs (DECISIONS D41): the host picks a challenge (Mono Type, Fire) on the challenge screen and hosts; the
 * guest joins and plays the same challenge run: both starter selects apply it, and the run starts as one on both.
 */

const SHOTS = shotsDir("challenge");

useRelay();

async function shot(name: string, ...clients: Client[]): Promise<void> {
  for (const client of clients) {
    await client.page.screenshot({ path: join(SHOTS, `${name}-${client.label}.png`) });
  }
}

/** The run's game mode on this client, as far as a test needs it */
const modeOf = (client: Client) =>
  client.page.evaluate(async () => {
    // (paths in the page's dev server, which the test's compiler does not resolve)
    const scenePath = "/src/globals/global-scene.ts";
    const { globalScene } = await import(scenePath);
    const mode = globalScene.gameMode;
    return {
      isCoop: mode.isCoop,
      isChallenge: mode.isChallenge,
      on: mode.challenges
        .filter((c: { value: number }) => c.value !== 0)
        .map((c: { id: number; value: number }) => [c.id, c.value]),
    };
  });

test("the host's challenge run is the guest's too (D41)", async ({ browser }) => {
  test.setTimeout(600_000);
  const [host, guest] = await Promise.all(
    (["host", "guest"] as const).map(async label => openClient(await newClientContext(browser), label)),
  );
  await Promise.all([waitForTitle(host), waitForTitle(guest)]);

  // The host: Co-op -> Host a game -> 2 players -> Challenge -> the challenge screen
  await openCoopMenu(host);
  await press(host, "ACTION");
  await choosePlayers(host, 2);
  await expect
    .poll(() => host.page.evaluate(() => (window as any).__coop.menuOptions as string[]), { timeout: 20_000 })
    .toContain("Challenge");
  await host.page.waitForTimeout(300);
  await press(host, "DOWN");
  await host.page.waitForTimeout(150);
  await press(host, "DOWN");
  await host.page.waitForTimeout(150);
  await press(host, "ACTION");
  await expect.poll(() => ui(host), { timeout: 20_000 }).toBe("CHALLENGE_SELECT");

  // Mono Type: Fire, as the screen sets it
  await host.page.evaluate(async () => {
    const paths = ["/src/globals/global-scene.ts", "/src/enums/challenges.ts", "/src/enums/pokemon-type.ts"];
    const [{ globalScene }, { Challenges }, { PokemonType }] = await Promise.all(paths.map(path => import(path)));
    globalScene.gameMode.setChallengeValue(Challenges.SINGLE_TYPE, PokemonType.FIRE + 1);
    (globalScene.ui.getHandler() as any).updateText();
  });
  await host.page.waitForTimeout(800);
  await shot("01-challenge-screen", host);
  // Start, then confirm it
  await press(host, "SUBMIT");
  await host.page.waitForTimeout(300);
  await press(host, "SUBMIT");
  await expect
    .poll(() => host.page.evaluate(() => (window as any).__coop.joinCode as string | null), { timeout: 30_000 })
    .not.toBeNull();
  const code = (await host.page.evaluate(() => (window as any).__coop.joinCode)) as string;

  // The guest joins by the code and gets the challenge
  await openCoopMenu(guest);
  await press(guest, "DOWN");
  await guest.page.waitForTimeout(200);
  await press(guest, "ACTION");
  await expect.poll(() => ui(guest), { timeout: 20_000 }).toBe("COOP_JOIN_FORM");
  expect(await guest.page.evaluate(c => (window as any).__coop.submitJoinCode(c), code)).toBe(true);
  for (const client of [host, guest]) {
    await expect
      .poll(() => ui(client), { timeout: 60_000, message: `${client.label} starter select` })
      .toBe("STARTER_SELECT");
  }
  for (const client of [host, guest]) {
    expect(await modeOf(client)).toEqual({ isCoop: true, isChallenge: true, on: [[expect.any(Number), 10]] });
  }
  await guest.page.waitForTimeout(1500);
  await shot("02-starter-select", host, guest);

  // Both pick a Fire starter (the grid shows only those) and the run starts as a challenge run on both
  await Promise.all([pickAndReady(host, 0), pickAndReady(guest, 1)]);
  await untilWaveOne(host, guest);
  for (const client of [host, guest]) {
    expect((await modeOf(client)).isChallenge).toBe(true);
  }
  expect(await desyncOf(host)).toBeNull();
  expect(await desyncOf(guest)).toBeNull();
  await shot("03-wave-one", host, guest);
});
