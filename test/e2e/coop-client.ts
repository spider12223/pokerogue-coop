/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { type RelayServer, startRelayServer } from "../../coop-server/src/relay-server.ts";

/**
 * What the co-op end-to-end specs share: two browser clients, the real relay (`coop-server`), and the player's inputs.
 *
 * Inputs go through `window.__coop` (dev builds): `press` is the player's button, `ui` and `phase` say where the game is.
 *
 * @module
 */

const RELAY_PORT = 8787;

/**
 * Where a spec puts its screenshots: `test-results/screenshots/<name>/` (not tracked)
 * @param name - The spec's folder, such as `fluid` or `resync`
 */
export function shotsDir(name: string): string {
  return join("test-results", "screenshots", name);
}

/**
 * The address of a game that is already running (`E2E_BASE_URL`), for example the container of a deploy: the specs then start
 * no dev server and no relay, and the game's own relay at `/coop` of that origin is used (DECISIONS D22). The container must
 * have been built with `COOP_E2E=1`, for the debug API the specs press buttons with.
 */
export const EXTERNAL_BASE_URL: string | undefined = process.env["E2E_BASE_URL"] || undefined;
const GAME_VERSION: string = JSON.parse(readFileSync("package.json", "utf8")).version;
/** `PlayerGender.MALE` */
const PLAYER_GENDER_MALE = 1;

export type Button = "UP" | "DOWN" | "LEFT" | "RIGHT" | "SUBMIT" | "ACTION" | "CANCEL";

export interface Checkpoint {
  index: number;
  kind: string;
  wave: number;
  turn: number;
  phaseName: string;
  hash: string;
}

export interface Waits {
  turns: number;
  waitedMs: number;
  maxWaitedMs: number;
  instant: number;
  samples: number[];
}

export interface Reward {
  screen: number;
  step: number;
  picker: "host" | "guest";
  money: number;
  ready: boolean;
  tradeRequested: boolean;
  label: string;
  options: { name: string; tmMove: number | null }[];
  shop: { name: string; cost: number; needsTarget: boolean }[];
}

export interface PartyMember {
  owner: "host" | "guest" | null;
  name: string;
  hp: number;
  maxHp: number;
  moves: number[];
  ppUsed: number[];
  usedTms: number[];
}

export interface Client {
  label: string;
  page: Page;
  errors: string[];
  /** The buttons the play loop pressed: the phase and screen they were pressed on, and the button */
  presses: string[];
}

/**
 * A browser context with the settings a player would have saved. `fast` is the fastest local-only set (game speed, no
 * animations, no exp or hp bar animations): none of them is pinned in co-op, so they must not matter to the run (D5).
 */
export async function newClientContext(browser: Browser, fast = false): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addInitScript(
    ({ version, gender, fastSettings }) => {
      if (localStorage.getItem("settings") === null) {
        localStorage.setItem(
          "settings",
          JSON.stringify({
            meta: { gameVersion: version },
            general: {
              enableTutorials: false,
              playerGender: gender,
              ...(fastSettings ? { gameSpeed: 5, hpBarSpeed: 3, expGainsSpeed: 3, skipSeenDialogues: true } : {}),
            },
            display: fastSettings ? { enableMoveAnimations: false, showStatsOnLevelUp: false } : {},
            audio: { enableAudio: false },
          }),
        );
      }
    },
    { version: GAME_VERSION, gender: PLAYER_GENDER_MALE, fastSettings: fast },
  );
  return context;
}

/**
 * Console errors that upstream logs in solo play too, and that say nothing about co-op: Phaser's loader complaining that
 * the animation texture of a move that was just learned (`initMoveAnim` + `loadMoveAnimAssets` in `LearnMovePhase`) is
 * already loaded.
 */
function isUpstreamNoise(text: string): boolean {
  return /^Texture key already in use: /.test(text);
}

export async function openClient(context: BrowserContext, label: string): Promise<Client> {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", message => {
    if (
      message.type() === "error"
      && !message.location().url.endsWith("/manifest.json")
      // The co-op log's upload (D26): a relay that does not collect logs answers 404, and the client stops sending
      && !message.location().url.endsWith("/coop/log")
      && !isUpstreamNoise(message.text())
    ) {
      // A resource that did not load says which one only in its location
      const url = message.text().startsWith("Failed to load resource") ? ` (${message.location().url})` : "";
      errors.push(`[${label}] console.error: ${message.text()}${url}`);
    }
  });
  page.on("pageerror", error => errors.push(`[${label}] pageerror: ${error.message}`));
  await page.goto("/");
  return { label, page, errors, presses: [] };
}

/**
 * Start the relay for the specs of this file (or use the one that is already listening on its port)
 * @param options - `clientLogs`: collect the players' co-op logs (D26) into `clientLines`, one JSON line per entry
 */
export function useRelay(options: { clientLogs?: boolean } = {}): { clientLines: string[] } {
  let relay: RelayServer | null = null;
  const clientLines: string[] = [];

  test.beforeAll(async () => {
    if (EXTERNAL_BASE_URL !== undefined) {
      return; // the game that is running has its own relay
    }
    try {
      relay = await startRelayServer({
        port: RELAY_PORT,
        host: "127.0.0.1",
        allowedOrigins: ["*"],
        ...(options.clientLogs === true
          ? { clientLogs: { enabled: true, write: line => clientLines.push(line) } }
          : {}),
      });
    } catch {
      // A relay is already listening on the port (started by hand): use it
      relay = null;
    }
  });

  test.afterAll(async () => {
    await relay?.close();
  });
  return { clientLines };
}

/** The state of the game as `window.__coop` reports it */
export const ui = (client: Client): Promise<string> => client.page.evaluate(() => (window as any).__coop?.ui ?? "NONE");

export async function press(client: Client, button: Button): Promise<void> {
  await pressIf(client, button, null);
}

/**
 * Press a button if the screen is `mode` right now (`null`: whatever it is). The check and the press are one step in the
 * page: a bot that read the screen a moment ago must not press into the one that has replaced it (a message that ended and
 * left the command menu under the button).
 * @returns Whether it was pressed
 */
export async function pressIf(client: Client, button: Button, mode: string | null): Promise<boolean> {
  const where = await client.page.evaluate(
    ([b, expected]) => {
      const coop = (window as any).__coop;
      if (expected !== null && coop.ui !== expected) {
        return null;
      }
      const where = `${coop.phase?.wave}:${coop.phase?.name}/${coop.ui}`;
      coop.press(b);
      return where;
    },
    [button, mode] as const,
  );
  if (where === null) {
    return false;
  }
  client.presses.push(`${where} ${button}`);
  return true;
}

/** Press a button, then wait for the screen to change to `mode` */
export async function pressUntil(client: Client, button: Button, mode: string): Promise<void> {
  await press(client, button);
  await expect.poll(() => ui(client), { message: `${client.label} after ${button}`, timeout: 20_000 }).toBe(mode);
}

export async function waitForTitle(client: Client): Promise<void> {
  await expect
    .poll(() => client.page.evaluate(() => (window as any).__coop?.phase?.name ?? ""), {
      message: `${client.label} never reached the title screen`,
      timeout: 240_000,
      intervals: [1000],
    })
    .toBe("TitlePhase");
  await expect.poll(() => ui(client), { timeout: 60_000 }).toBe("TITLE");
  // The options appear a moment after the screen
  await client.page.waitForTimeout(1500);
}

/** On the title screen: open the co-op entry (the second one, after "New Game") */
export async function openCoopMenu(client: Client): Promise<void> {
  await press(client, "DOWN");
  await client.page.waitForTimeout(200);
  await press(client, "ACTION");
  await expect.poll(() => ui(client), { timeout: 20_000 }).toBe("OPTION_SELECT");
}

/** Classic or Endless (D39), which Host a game and Find a partner ask: pick one */
export async function chooseRunMode(client: Client, mode: "Classic" | "Endless" = "Classic"): Promise<void> {
  await expect
    .poll(() => client.page.evaluate(() => (window as any).__coop.menuOptions as string[]), {
      message: `${client.label}: no Classic or Endless question`,
      timeout: 20_000,
    })
    .toContain(mode);
  await client.page.waitForTimeout(300);
  if (mode === "Endless") {
    await press(client, "DOWN");
    await client.page.waitForTimeout(150);
  }
  await press(client, "ACTION");
}

/** The starter select: add the starter under the cursor to the party, and become ready */
export async function pickAndReady(client: Client, moveRight: number): Promise<void> {
  await expect
    .poll(() => ui(client), { timeout: 60_000, message: `${client.label} starter select` })
    .toBe("STARTER_SELECT");
  await client.page.waitForTimeout(1000);
  for (let i = 0; i < moveRight; i++) {
    await press(client, "RIGHT");
    await client.page.waitForTimeout(150);
  }
  // The pokémon menu, then "Add to party"
  await pressUntil(client, "ACTION", "OPTION_SELECT");
  await pressUntil(client, "ACTION", "STARTER_SELECT");
  // Start: "Begin with these Pokémon?" -> yes
  await client.page.waitForTimeout(500);
  await press(client, "SUBMIT");
  await expect.poll(() => ui(client), { timeout: 20_000 }).toBe("CONFIRM");
  await pressUntil(client, "ACTION", "STARTER_SELECT");
}

/**
 * From the title screen of both clients to wave 1 of a linked run: the host creates a room, the guest joins it by its
 * code, both pick a starter at the same time (the host the first of the grid, the guest the second) and become ready.
 *
 * @param afterLinked - Runs once both clients are linked, before the starters are picked. A client with overrides cannot
 * host or join (D1), so a spec that needs them sets them here, on both clients.
 */
export async function startLinkedRun(host: Client, guest: Client, afterLinked?: () => Promise<void>): Promise<void> {
  await linkClients(host, guest);
  await afterLinked?.();
  await Promise.all([pickAndReady(host, 0), pickAndReady(guest, 1)]);
  await untilWaveOne(host, guest);
}

/**
 * From the title screen of both clients to the co-op starter select: the host creates a room, the guest joins it
 * @param mode - The kind of run the host chooses (D39)
 */
export async function linkClients(host: Client, guest: Client, mode: "Classic" | "Endless" = "Classic"): Promise<void> {
  // The host: Co-op -> Host a game -> Classic or Endless -> a join code
  await openCoopMenu(host);
  await press(host, "ACTION");
  await chooseRunMode(host, mode);
  await expect
    .poll(() => host.page.evaluate(() => (window as any).__coop.joinCode as string | null), {
      message: "the host never got a join code",
      timeout: 30_000,
    })
    .not.toBeNull();
  const code = (await host.page.evaluate(() => (window as any).__coop.joinCode)) as string;
  expect(code).toMatch(/^[A-Z0-9]{4,8}$/);

  // The guest: Co-op -> Join a game -> the code
  await openCoopMenu(guest);
  await press(guest, "DOWN");
  await guest.page.waitForTimeout(200);
  await press(guest, "ACTION");
  await expect.poll(() => ui(guest), { timeout: 20_000 }).toBe("COOP_JOIN_FORM");
  expect(await guest.page.evaluate(c => (window as any).__coop.submitJoinCode(c), code)).toBe(true);

  // Both are linked and on the starter select
  for (const client of [host, guest]) {
    await expect
      .poll(() => client.page.evaluate(() => (window as any).__coop.linked), {
        message: `${client.label} not linked`,
      })
      .toBe(true);
  }
  expect(await host.page.evaluate(() => (window as any).__coop.seat)).toBe("host");
  expect(await guest.page.evaluate(() => (window as any).__coop.seat)).toBe("guest");
}

/** Both players are ready: the run starts on both */
export async function untilWaveOne(host: Client, guest: Client): Promise<void> {
  for (const client of [host, guest]) {
    await expect
      .poll(() => client.page.evaluate(() => (window as any).__coop.phase?.wave ?? 0), {
        message: `${client.label} never started wave 1`,
        timeout: 120_000,
      })
      .toBe(1);
  }
}

export interface PlayState {
  ui: string;
  phase: { name: string } | null;
  desync: string | null;
  /** The open reward screen's number, or `null` */
  screen: number | null;
  /** The wave of the phase that is running */
  wave: number;
  /** The turn of the phase that is running */
  turn: number;
  /** The lines on the screen are this player's own, not the run's (D27: a question of theirs, a command menu) */
  ownText: boolean;
}

/**
 * Play like a player who always takes the first option (the first move, the first target, "yes") until `done` says the
 * game is where the spec wants it. Presses are spaced out, and a message that waits for a button gets one now and then.
 * Nothing is pressed on a reward screen.
 * @param tolerateDesync - A spec that expects the clients to disagree (and to recover) does not stop at the report
 * @param pressMessages - `"own"`: a player who makes their decisions but presses only on the lines of their own questions,
 * never on the run's text (D27: the guest's screen follows the host's)
 * @throws If the client reports a desync, or `done` does not come true in 5 minutes
 */
export async function playUntil(
  client: Client,
  description: string,
  done: (state: PlayState) => boolean | Promise<boolean>,
  timeout = 300_000,
  tolerateDesync = false,
  pressMessages: true | "own" = true,
): Promise<void> {
  const { page } = client;
  let lastMessagePress = 0;
  // The move menu comes up again in the same turn when the first move cannot be used (a wild Pokémon's Disable): the bot
  // takes the next move then, as a player would
  let fightTurn = "";
  let fightEntries = 0;
  let wasFight = false;
  await expect
    .poll(
      async () => {
        const state: PlayState = await page.evaluate(() => {
          const coop = (window as any).__coop;
          return {
            ui: coop.ui as string,
            phase: coop.phase as { name: string } | null,
            desync: coop.desync as string | null,
            screen: (coop.reward?.screen ?? null) as number | null,
            wave: (coop.phase?.wave ?? 0) as number,
            turn: (coop.phase?.turn ?? 0) as number,
            ownText: (coop.pace?.private ?? true) as boolean,
          };
        });
        if (state.desync !== null && !tolerateDesync) {
          throw new Error(`${client.label} reports a desync: ${state.desync}`);
        }
        if (await done(state)) {
          return description;
        }
        if (state.phase?.name === "GameOverPhase" || state.phase?.name === "PostGameOverPhase") {
          // a lost battle ends the run: nothing more to play, and waiting for the screen of the spec would take minutes
          throw new Error(`${client.label}: the run is over (${state.phase.name})`);
        }
        const inFight = state.ui === "FIGHT";
        if (inFight && !wasFight) {
          const turn = `${state.wave}:${state.turn}`;
          fightEntries = turn === fightTurn ? fightEntries + 1 : 1;
          fightTurn = turn;
          if (fightEntries > 1) {
            await pressIf(client, "DOWN", "FIGHT");
            await page.waitForTimeout(200);
          }
        }
        wasFight = inFight;
        switch (state.ui) {
          case "COMMAND":
          case "FIGHT":
          case "TARGET_SELECT":
          case "CONFIRM":
            await pressIf(client, "ACTION", state.ui);
            break;
          case "SUMMARY":
            if (state.phase?.name === "SwitchPhase") {
              // a summary opened from the party screen of a switch: back to the party
              await pressIf(client, "CANCEL", "SUMMARY");
              break;
            }
            // Which move to forget: the cursor starts on the new move (which means "do not learn it"), so go up to the
            // last of the old ones
            await pressIf(client, "UP", "SUMMARY");
            await page.waitForTimeout(200);
            await pressIf(client, "ACTION", "SUMMARY");
            break;
          case "PARTY":
            // a replacement after a faint: the first Pokémon that can be sent out
            await pressIf(client, "ACTION", "PARTY");
            await page.waitForTimeout(300);
            await pressIf(client, "ACTION", "PARTY");
            break;
          case "MESSAGE":
            if (
              (pressMessages === true || state.ownText)
              && Date.now() - lastMessagePress > 1500
              && (await pressIf(client, "ACTION", "MESSAGE"))
            ) {
              lastMessagePress = Date.now();
            }
            break;
          default:
            break;
        }
        return `${state.phase?.name}/${state.ui}`;
      },
      { message: `${client.label} never reached: ${description}`, timeout, intervals: [250] },
    )
    .toBe(description);
}

/** Play until reward screen number `screen` is up (`null`: any) */
export function playToRewardScreen(client: Client, screen: number | null = null): Promise<void> {
  return playUntil(
    client,
    "the reward screen",
    state =>
      state.phase?.name === "SelectModifierPhase"
      && state.ui === "MODIFIER_SELECT"
      && (screen === null || state.screen === screen),
  );
}

/** What each client shows, for the failure report of a spec */
export async function describeClients(...clients: Client[]): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {};
  for (const client of clients) {
    report[client.label] = await client.page
      .evaluate(() => {
        const coop = (window as any).__coop;
        return {
          phase: coop.phase,
          ui: coop.ui,
          window: coop.window,
          desync: coop.desync,
          reward: coop.reward,
          party: coop.party,
          // what the stall detector wrote down, if it did (`src/coop/stall-detector.ts`)
          stalls: coop.stalls,
          // the last phases this client started: `wave:turn:phase`
          trace: coop
            .trace()
            .slice(-50)
            .map((entry: any) => `${entry.wave}:${entry.turn}:${entry.phaseName}`),
        };
      })
      .catch((error: Error) => ({ unreadable: error.message }));
    (report[client.label] as Record<string, unknown>).presses = client.presses.slice(-40);
  }
  return report;
}

export const checkpointsOf = (client: Client): Promise<Checkpoint[]> =>
  client.page.evaluate(() => (window as any).__coop.checkpoints);
export const waitsOf = (client: Client): Promise<Waits | null> =>
  client.page.evaluate(() => (window as any).__coop.waits);
export const desyncOf = (client: Client): Promise<string | null> =>
  client.page.evaluate(() => (window as any).__coop.desync);
export const rewardOf = (client: Client): Promise<Reward | null> =>
  client.page.evaluate(() => (window as any).__coop.reward);
export const partyOf = (client: Client): Promise<PartyMember[]> =>
  client.page.evaluate(() => (window as any).__coop.party);

/** Wait until the open reward screen has finished showing and takes input */
export async function waitForRewardReady(client: Client): Promise<void> {
  await expect
    .poll(async () => (await rewardOf(client))?.ready ?? false, {
      message: `${client.label}: the reward screen never took input`,
      timeout: 30_000,
      intervals: [200],
    })
    .toBe(true);
}

export function seatClients(host: Client, guest: Client, seat: "host" | "guest"): { picker: Client; other: Client } {
  return seat === "host" ? { picker: host, other: guest } : { picker: guest, other: host };
}

/** Both clients are on the same open reward screen: same step, same options, same shop, same money */
export async function bothAtScreen(host: Client, guest: Client, screen: number): Promise<Reward> {
  await Promise.all([playToRewardScreen(host, screen), playToRewardScreen(guest, screen)]);
  await Promise.all([waitForRewardReady(host), waitForRewardReady(guest)]);
  const [a, b] = await Promise.all([rewardOf(host), rewardOf(guest)]);
  expect(a, `screen ${screen}`).not.toBeNull();
  // the same screen on both, apart from the moment each finished showing
  // (the line that says who is choosing is the non-picker's only)
  expect({ ...b, ready: true, label: "" }).toEqual({ ...a, ready: true, label: "" });
  return a as Reward;
}

/** The picker skips the screen: cancel, then "yes" */
export async function skipScreen(picker: Client): Promise<void> {
  await pressIf(picker, "CANCEL", "MODIFIER_SELECT");
  await expect.poll(() => ui(picker), { message: `${picker.label} skip question`, timeout: 20_000 }).toBe("CONFIRM");
  await pressIf(picker, "ACTION", "CONFIRM");
}
