/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Browser, BrowserContext, Page } from "@playwright/test";
import {
  type Client,
  choosePlayers,
  chooseRunMode,
  describeClients,
  enableThreePlayers,
  newClientContext,
  openClient,
  openCoopMenu,
  waitForTitle,
} from "../e2e/coop-client.ts";
import type { SeatCaption, ShotOutput } from "./output.ts";
import { NoSuchValue } from "./scenario.ts";
import { type Seat, seatsOf, type Vars } from "./variables.ts";

/**
 * One run of `pnpm shot`: a browser page per player, linked through the local relay, and what a scenario needs to bring
 * them to a screen and shoot every step of it. A step is shot once all players' screens have settled, and only if it shows
 * something no step before it did.
 *
 * @module
 */

/** What one player's game shows, read in one go */
export interface ClientState {
  seat: Seat;
  /** The phase that is running, `""` before the game has one */
  phase: string;
  wave: number;
  turn: number;
  /** The UI mode: `COMMAND`, `MESSAGE`, `PARTY`, ... */
  ui: string;
  /** The message window's text, as far as it is typed out */
  text: string;
  /** The message waits for a button (a line that goes on by itself, or a "waiting for …", does not) */
  prompt: boolean;
  /** The labels of the option menu that is open */
  menu: string[];
  /** The text on screen is this player's own (a question of theirs), not the run's that follows the host's (D27) */
  own: boolean;
  /** The mystery encounter's question (D29), `null` outside one */
  me: {
    question: { k: string; enabled?: boolean[]; pokemon?: number[]; seats?: Seat[] } | null;
    chooser: Seat;
    step: number;
  } | null;
  reward: { screen: number; step: number; picker: Seat; ready: boolean; tradeRequested: boolean } | null;
  trade: {
    mode: string;
    give: number | null;
    want: number | null;
    cursor: { side: number; row: number; action: number };
    actions: string[];
    mine: number[];
    theirs: number[];
    status: string;
  } | null;
  lobby: { players: number; partners: Record<string, { picks: number; ready: boolean }>; started: boolean } | null;
  linked: boolean;
  desync: string | null;
  /** What the waiting screen says while a partner is away (D20), or `null` */
  away: string | null;
  /** The ids of the party, in party order, and whose each is */
  party: { id: number; owner: Seat | null }[];
  /** How many animations that end are running (a window sliding in, a fade); the endless ones do not count */
  moving: number;
}

/** What a player does at a step: buttons, after the cursor is put on an entry if `cursor` says one */
export type Action =
  | { cursor?: number; press: string | string[] }
  /** The party screen: this member, chosen (the party's two presses: the member, then "Select" or "Send out") */
  | { member: number };

export interface DriveOptions {
  /** The run is where the scenario wants it: drive stops (after the shot of that step) */
  until: (states: ClientState[]) => boolean;
  /** The scenario's own answer for a player, before the bot's: `undefined` lets the bot answer, `null` does nothing */
  answer?: (state: ClientState, states: ClientState[]) => Action | null | undefined;
  /** The most steps before it gives up */
  maxSteps?: number;
  /** Shoot a step only when this says so (default: every step) */
  shoot?: (states: ClientState[]) => boolean;
}

/** The species each player starts with: the cheapest starters (cost 1) after a default one, so that 3 each fit the points */
const PARTIES: Record<Seat, number[]> = {
  // Bulbasaur, Weedle, Rattata
  host: [1, 13, 19],
  // Charmander, Spearow, Seel
  guest: [4, 21, 86],
  // Squirtle, then the host's third (a game of three holds two each)
  guest2: [7, 19],
};
/** The cheap starters a new account does not have: every player's account gets them before the room is made */
const CHEAP_STARTERS = [13, 19, 21, 86];
const NAMES: Record<Seat, string> = { host: "Host", guest: "Guest", guest2: "Guest 2" };

const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

export class ShotRun {
  readonly seats: Seat[];
  private readonly clients = new Map<Seat, Client>();
  /** The screens already shot, so that a step that shows nothing new is not shot again */
  private readonly seen = new Set<string>();
  /** When the last step was shot (or the run began) */
  private lastShot = Date.now();
  /** Other windows shot with every step from now on, beside the players' (the host's debug window) */
  private readonly extras: { label: string; page: Page }[] = [];

  private readonly browser: Browser;
  readonly vars: Vars;
  private readonly out: ShotOutput;

  constructor(browser: Browser, vars: Vars, out: ShotOutput) {
    this.browser = browser;
    this.vars = vars;
    this.out = out;
    this.seats = seatsOf(vars.players);
  }

  client(seat: Seat): Client {
    const client = this.clients.get(seat);
    if (client === undefined) {
      throw new Error(`no ${seat} in this run (--players ${this.vars.players})`);
    }
    return client;
  }

  get host(): Client {
    return this.client("host");
  }

  get guests(): Seat[] {
    return this.seats.filter(seat => seat !== "host");
  }

  // #region Getting there

  /** A page per player, each on the title screen, with its name and the cheap starters */
  async open(): Promise<void> {
    if (this.clients.size > 0) {
      return;
    }
    const opened = await Promise.all(
      this.seats.map(async seat => {
        const context = await newClientContext(this.browser, this.vars.speed === "fast");
        await failSomeDownloads(context, seat);
        return [seat, await openClient(context, seat)] as const;
      }),
    );
    for (const [seat, client] of opened) {
      this.clients.set(seat, client);
    }
    await Promise.all(opened.map(([, client]) => waitForTitle(client)));
    for (const [seat, client] of opened) {
      await client.page.evaluate(
        ({ name, species }) => {
          const coop = (window as any).__coop;
          coop.setName(name);
          for (const id of species) {
            coop.catchSpecies(id);
          }
        },
        { name: NAMES[seat], species: CHEAP_STARTERS },
      );
    }
  }

  /** The host: Co-op, Host a game, the players and the run mode; then it waits with a join code */
  async hostRoom(): Promise<string> {
    const host = this.host;
    if (this.vars.players === "3") {
      await enableThreePlayers(host);
    }
    await openCoopMenu(host);
    await this.press("host", "ACTION");
    await choosePlayers(host, this.vars.players === "3" ? 3 : 2);
    await chooseRunMode(host, this.vars.mode === "endless" ? "Endless" : "Classic");
    return this.waitFor(
      "host",
      "a join code",
      async () => (await this.eval<string | null>("host", "joinCode")) ?? false,
    );
  }

  /** A guest: Co-op, Join a game, the code; then it is linked */
  async joinRoom(seat: Seat, code: string): Promise<void> {
    await this.openJoinForm(seat);
    await this.submitCode(seat, code);
  }

  /** A guest: Co-op, Join a game: the form for the code */
  async openJoinForm(seat: Seat): Promise<void> {
    const client = this.client(seat);
    await openCoopMenu(client);
    await this.press(seat, "DOWN");
    await client.page.waitForTimeout(200);
    await this.press(seat, "ACTION");
    await this.waitFor(seat, "the join form", async () => (await this.state(seat)).ui === "COOP_JOIN_FORM");
  }

  /** A guest on the join form: type the code; then it is linked */
  async submitCode(seat: Seat, code: string): Promise<void> {
    if (!(await this.client(seat).page.evaluate(c => (window as any).__coop.submitJoinCode(c), code))) {
      throw new Error(`${seat} could not type the join code`);
    }
    await this.waitFor(seat, "linked", async () => (await this.state(seat)).linked);
  }

  /** Everyone on the starter select of one room */
  async link(): Promise<void> {
    await this.open();
    const code = await this.hostRoom();
    for (const seat of this.guests) {
      await this.joinRoom(seat, code);
    }
    for (const seat of this.seats) {
      await this.waitFor(
        seat,
        "the starter select",
        async () => (await this.state(seat)).ui === "STARTER_SELECT",
        60_000,
      );
    }
  }

  /** Put the starter of this species in the party: its menu, then "Add to party" */
  async addStarter(seat: Seat, species: number): Promise<void> {
    await this.waitFor(
      seat,
      "the starter select",
      async () => (await this.state(seat)).ui === "STARTER_SELECT",
      60_000,
    );
    // the grid: one step to the right at a time, until the cursor is on the species
    for (let steps = 0; (await this.eval<number | null>(seat, "starterCursor")) !== species; steps++) {
      if (steps > 60) {
        throw new Error(`${seat}: species ${species} is not on the starter select`);
      }
      const before = await this.eval<number | null>(seat, "starterCursor");
      await this.press(seat, "RIGHT");
      await this.waitFor(
        seat,
        "the cursor to move",
        async () => (await this.eval(seat, "starterCursor")) !== before,
        5000,
      );
    }
    await this.pressFor(seat, "ACTION", "OPTION_SELECT");
    await this.pressFor(seat, "ACTION", "STARTER_SELECT");
  }

  /** Done picking: "Ready with these Pokémon?", yes */
  async ready(seat: Seat): Promise<void> {
    await this.client(seat).page.waitForTimeout(500);
    await this.pressFor(seat, "SUBMIT", "CONFIRM");
    await this.pressFor(seat, "ACTION", "STARTER_SELECT");
  }

  /** The party of `--party`, picked */
  async pickParty(seat: Seat): Promise<void> {
    const most = this.vars.players === "3" ? 2 : 3;
    for (const species of PARTIES[seat].slice(0, this.vars.party === 0 ? most : this.vars.party)) {
      await this.addStarter(seat, species);
    }
  }

  /**
   * From nothing to the start of the run: linked, the overrides set on every client (a client with overrides cannot host
   * or join, D1), every player's party picked, everyone ready
   * @param overrides - Of `src/overrides.ts`, on top of `--level`, `--wave` and `--money`
   * @param plain - No overrides at all, not even the variables': a run a reloaded page rejoins (its overrides are compared, D1)
   */
  async toRun(overrides: Record<string, unknown> = {}, { plain = false } = {}): Promise<void> {
    await this.link();
    if (!plain) {
      await this.setOverrides(overrides);
    }
    await this.calmAfk();
    await Promise.all(this.seats.map(seat => this.pickParty(seat)));
    await Promise.all(this.seats.map(seat => this.ready(seat)));
    for (const seat of this.seats) {
      await this.waitFor(
        seat,
        "the run to start",
        async () => {
          const state = await this.state(seat);
          return state.lobby === null && state.ui !== "STARTER_SELECT";
        },
        60_000,
      );
    }
  }

  /**
   * A player the bot does not answer for at once (it waits on another) is not hinted at as away, nor taken over, within
   * a shot (D17): a scenario that wants that sets the timers itself
   */
  async calmAfk(): Promise<void> {
    for (const seat of this.seats) {
      await this.client(seat).page.evaluate(ms => (window as any).__coop.setAfkTimers(ms, ms), AFK_OFF_MS);
    }
  }

  /** The same overrides on every client, with `--level`, `--wave` and `--money` */
  async setOverrides(overrides: Record<string, unknown>): Promise<void> {
    const values = {
      STARTING_LEVEL_OVERRIDE: this.vars.level,
      ...(this.vars.wave > 1 ? { STARTING_WAVE_OVERRIDE: this.vars.wave } : {}),
      ...(this.vars.money > 0 ? { STARTING_MONEY_OVERRIDE: this.vars.money } : {}),
      ...overrides,
    };
    for (const seat of this.seats) {
      await this.client(seat).page.evaluate(v => (window as any).__coop.setOverrides(v), values);
    }
  }

  // #endregion
  // #region Reading and pressing

  /** What the player's game shows; a page that is loading (a reload) shows nothing yet */
  async state(seat: Seat): Promise<ClientState> {
    try {
      return (await this.readState(seat)) ?? loadingState(seat);
    } catch (error) {
      // between two documents, or before the game has its debug API: loading; anything else is a real error
      const loading = await this.client(seat)
        .page.evaluate(() => (window as any).__coop === undefined)
        .catch(() => true);
      if (loading) {
        return loadingState(seat);
      }
      throw error;
    }
  }

  private readState(seat: Seat): Promise<ClientState | null> {
    return this.client(seat).page.evaluate(
      async ({ who, scenePath }) => {
        const coop = (window as any).__coop;
        // (a page that is loading has no debug API yet: asking again whether it has one could see it appear meanwhile)
        if (coop === undefined) {
          return null;
        }
        const { globalScene } = await import(scenePath);
        const reward = coop.reward;
        return {
          seat: who,
          phase: coop.phase?.name ?? "",
          wave: coop.phase?.wave ?? 0,
          turn: coop.phase?.turn ?? 0,
          ui: coop.ui,
          text: (coop.messageText ?? "").trim(),
          prompt: (() => {
            const handler = globalScene?.ui?.getMessageHandler?.();
            return handler?.awaitingActionInput === true && typeof handler.onActionInput === "function";
          })(),
          menu: coop.menuOptions ?? [],
          own: coop.pace?.private ?? true,
          me: coop.me ?? null,
          reward:
            reward == null
              ? null
              : {
                  screen: reward.screen,
                  step: reward.step,
                  picker: reward.picker,
                  ready: reward.ready,
                  tradeRequested: reward.tradeRequested,
                },
          trade: coop.trade,
          lobby: coop.lobby,
          linked: coop.linked,
          desync: coop.desync,
          away: coop.reconnectScreen ?? null,
          party: (globalScene?.getPlayerParty?.() ?? []).map((pokemon: any, i: number) => ({
            id: pokemon.id,
            owner: coop.party?.[i]?.owner ?? null,
          })),
          moving: (globalScene?.tweens?.getTweens?.() ?? []).filter(
            (tween: any) => tween.isPlaying() && !tween.isInfinite,
          ).length,
        };
      },
      { who: seat, scenePath: "/src/globals/global-scene.ts" },
    );
  }

  states(): Promise<ClientState[]> {
    return Promise.all(this.seats.map(seat => this.state(seat)));
  }

  /** What is still moving on each screen (its animations that end), for a step that did not settle */
  private async whatMoves(): Promise<string> {
    const parts = await Promise.all(
      this.seats.map(async seat => {
        const moving = await this.client(seat).page.evaluate(async scenePath => {
          const { globalScene } = await import(scenePath);
          return (globalScene?.tweens?.getTweens?.() ?? [])
            .filter((tween: any) => tween.isPlaying() && !tween.isInfinite)
            .map((tween: any) => {
              const target = tween.targets?.[0];
              return `${target?.constructor?.name ?? "?"}${target?.name ? ` ${target.name}` : ""} ${Math.round(tween.totalDuration ?? 0)} ms`;
            });
        }, "/src/globals/global-scene.ts");
        return `${seat} [${moving.join(", ")}]`;
      }),
    );
    return parts.join("; ");
  }

  /** A field of `window.__coop` */
  eval<T>(seat: Seat, field: string): Promise<T> {
    return this.client(seat).page.evaluate(name => (window as any).__coop[name], field);
  }

  /**
   * Press a game button as the player would (`ACTION`, `CANCEL`, `MENU`, ...). The screen's buttons go to the screen;
   * the others (the menu, the stats, the co-op hotkeys) through the game's own key handler, as a key would
   */
  async press(seat: Seat, button: string): Promise<void> {
    const client = this.client(seat);
    const where = await client.page.evaluate(
      async ({ b, scenePath, buttonsPath, screenButtons }) => {
        const coop = (window as any).__coop;
        if (screenButtons.includes(b)) {
          coop.press(b);
        } else {
          const { globalScene } = await import(scenePath);
          const { Button } = await import(buttonsPath);
          const action = globalScene.uiInputs.getActionsKeyDown()[Button[b]];
          if (action === undefined) {
            throw new Error(`no button ${b}`);
          }
          action();
        }
        return `${coop.phase?.wave}:${coop.phase?.name}/${coop.ui}`;
      },
      {
        b: button,
        scenePath: "/src/globals/global-scene.ts",
        buttonsPath: "/src/enums/buttons.ts",
        screenButtons: SCREEN_BUTTONS,
      },
    );
    client.presses.push(`${where} ${button}`);
  }

  /** Press until the screen is `mode`: the game drops a press that comes before it takes input (slow headless frames) */
  async pressFor(seat: Seat, button: string, mode: string, timeout = 20_000): Promise<void> {
    const end = Date.now() + timeout;
    while ((await this.state(seat)).ui !== mode) {
      if (Date.now() > end) {
        throw new Error(`${seat}: ${button} never led to ${mode} (now ${(await this.state(seat)).ui})`);
      }
      await this.press(seat, button);
      await this.waitFor(seat, mode, async () => (await this.state(seat)).ui === mode, 2500).catch(() => undefined);
    }
  }

  /** Do what a step's action says */
  async act(seat: Seat, action: Action): Promise<void> {
    const page = this.client(seat).page;
    if ("member" in action) {
      const ok = await page.evaluate(i => {
        const coop = (window as any).__coop;
        if (!coop.movePartyCursor(i)) {
          return false;
        }
        coop.press("ACTION");
        coop.press("ACTION");
        return true;
      }, action.member);
      if (!ok) {
        throw new Error(`${seat}: no party screen to choose member ${action.member + 1} on`);
      }
      this.client(seat).presses.push(`party member ${action.member}`);
      return;
    }
    const { cursor } = action;
    if (cursor !== undefined && !(await page.evaluate(i => (window as any).__coop.setCursor(i), cursor))) {
      throw new Error(`${seat}: the screen ${(await this.state(seat)).ui} has no cursor to put on entry ${cursor + 1}`);
    }
    for (const button of typeof action.press === "string" ? [action.press] : action.press) {
      await this.press(seat, button);
      await page.waitForTimeout(250);
    }
  }

  /**
   * Wait until `check` gives a value that is not `false`
   * @returns That value
   */
  async waitFor<T>(seat: Seat, what: string, check: () => Promise<T | false>, timeout = 30_000): Promise<T> {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await check();
      if (value !== false) {
        return value;
      }
      if (Date.now() > end) {
        const state = await this.state(seat).catch(() => null);
        throw new Error(`${seat} never got to ${what} (now ${state?.phase || "no phase"} / ${state?.ui ?? "?"})`);
      }
      await sleep(200);
    }
  }

  // #endregion
  // #region Shooting

  /**
   * Wait until no player's screen has changed for a moment (its mode, text, menu, question), none is still coming up (a
   * reward screen that does not take input yet) and nothing on it is sliding or fading
   * @returns What each shows then (after `timeout` whatever it shows: an animation that never ends)
   */
  async settle(timeout = 15_000, quiet = 600): Promise<ClientState[]> {
    const end = Date.now() + timeout;
    let last = "";
    let since = Date.now();
    for (;;) {
      const states = await this.states();
      for (const state of states) {
        if (state.desync !== null) {
          throw new Error(`${state.seat} reports a desync: ${state.desync}`);
        }
      }
      const signature = states.map(signatureOf).join("\n");
      if (signature !== last) {
        last = signature;
        since = Date.now();
      } else if (Date.now() - since >= quiet && !states.some(comingUp) && states.every(still)) {
        return states;
      } else if (Date.now() > end) {
        console.log(`      (not settled after ${timeout / 1000} s: ${await this.whatMoves()})`);
        return states;
      }
      await sleep(200);
    }
  }

  /**
   * Shoot every player's screen as one step, once they have settled
   * @param name - The step's name in the file names (`a-z0-9-`)
   * @param always - Shoot it even if a step before showed the same
   */
  async shot(name: string, always = false, states?: ClientState[]): Promise<void> {
    const settled = states ?? (await this.settle());
    const signature = settled.map(signatureOf).join("\n");
    if (!always && this.seen.has(signature)) {
      return;
    }
    this.seen.add(signature);
    const shots = await Promise.all([
      ...this.seats.map(async (seat, i) => ({
        png: await this.client(seat).page.screenshot(),
        caption: captionOf(settled[i]),
      })),
      ...this.extras.map(async ({ label, page }) => ({
        png: await page.screenshot(),
        caption: { seat: label, phase: "-", ui: "window", text: "", menu: [] },
      })),
    ]);
    const file = await this.out.add(this.browser, name, shots);
    const seconds = ((Date.now() - this.lastShot) / 1000).toFixed(0);
    this.lastShot = Date.now();
    console.log(`  ${String(this.out.count).padStart(2)}. ${name.padEnd(28)} +${seconds.padStart(3)} s  ${file}`);
  }

  /**
   * Play like players who answer what they are asked (the first entry, "yes", the move and target under the cursor, the
   * variables' option, Pokémon and goer) and shoot every new screen, until `until`
   */
  async drive(options: DriveOptions): Promise<ClientState[]> {
    const maxSteps = options.maxSteps ?? 80;
    const visits = new Map<string, number>();
    for (let step = 0; ; step++) {
      const states = await this.settle();
      // a turn that comes again is not a circle: the wave and turn are part of it
      const seen = states.map(state => `${state.wave}:${state.turn}:${signatureOf(state)}`).join("\n");
      visits.set(seen, (visits.get(seen) ?? 0) + 1);
      if ((visits.get(seen) ?? 0) > MAX_VISITS) {
        throw new Error(
          `the same screens again and again (${states.map(s => `${s.seat}: ${s.phase}/${s.ui}`).join(", ")}): the bot cannot answer this one; give the scenario its own answer`,
        );
      }
      const actions = states.map(state => {
        const own = options.answer?.(state, states);
        return own === undefined ? this.answer(state) : own;
      });
      if (options.shoot?.(states) ?? true) {
        await this.shot(nameOf(states, actions), false, states);
      }
      if (options.until(states)) {
        // the others get there a moment later: their screens then, if they show something new
        const last = await this.settle();
        if (options.shoot?.(last) ?? true) {
          await this.shot(
            nameOf(
              last,
              last.map(() => null),
            ),
            false,
            last,
          );
        }
        console.log(
          `      (there: ${last.map(s => `${s.seat} wave ${s.wave} turn ${s.turn} ${s.phase}/${s.ui}`).join("; ")})`,
        );
        return last;
      }
      if (step >= maxSteps) {
        throw new Error(
          `no end after ${maxSteps} steps (${states.map(s => `${s.seat}: ${s.phase}/${s.ui}`).join(", ")})`,
        );
      }
      const before = states.map(signatureOf).join("\n");
      await Promise.all(states.map((state, i) => (actions[i] === null ? null : this.act(state.seat, actions[i]))));
      // until something changes (a press that came too early is pressed again by the next step)
      const end = Date.now() + 8000;
      while (Date.now() < end && (await this.states()).map(signatureOf).join("\n") === before) {
        await sleep(200);
      }
    }
  }

  /** What a player who takes the first of everything does, with the variables' choices */
  answer(state: ClientState): Action | null {
    const { vars } = this;
    const question = state.me?.question ?? null;
    const choosing = state.me !== null && state.me.chooser === state.seat;
    switch (state.ui) {
      case "MESSAGE":
        // the run's text follows the host's (D27): a guest presses only on a line of its own
        return state.prompt && (state.seat === "host" || state.own) ? { press: "ACTION" } : null;
      case "COMMAND":
      case "FIGHT":
      case "TARGET_SELECT":
      case "CONFIRM":
        return { press: "ACTION" };
      case "MYSTERY_ENCOUNTER":
        if (!choosing || question === null || !["option", "optionPokemon"].includes(question.k)) {
          return null;
        }
        if (question.enabled !== undefined && question.enabled.length < vars.option) {
          throw new NoSuchValue(`the encounter has ${question.enabled.length} options, not ${vars.option}`);
        }
        if (question.enabled !== undefined && question.enabled[vars.option - 1] !== true) {
          throw new Error(`option ${vars.option} cannot be chosen with this party (try --party or --level)`);
        }
        return { cursor: vars.option - 1, press: "ACTION" };
      case "OPTION_SELECT":
        if (question?.k === "who") {
          if (state.seat !== "host") {
            return null;
          }
          const offered = question.seats ?? [];
          if (!offered.includes(vars.goer)) {
            throw new Error(`--goer ${vars.goer} cannot go: the encounter offers ${offered.join(", ") || "nobody"}`);
          }
          return { cursor: offered.indexOf(vars.goer), press: "ACTION" };
        }
        if (state.me !== null && !choosing) {
          return null;
        }
        // "Your party is full. Release a Pokémon?" (Summary, Pokédex, Yes, No): no, the new one is left
        if (state.menu.length > 2 && state.menu.includes("Yes") && state.menu.includes("No")) {
          return choose(state, "No");
        }
        // "<partner> is away. Take over for them?" (D17): the bot plays its own seat only
        if (state.menu.includes("Keep waiting")) {
          return choose(state, "Keep waiting");
        }
        return { press: "ACTION" };
      case "PARTY": {
        if (question !== null && ["pokemon", "optionPokemon"].includes(question.k)) {
          if (!choosing) {
            return null;
          }
          const allowed = question.pokemon ?? state.party.filter(m => m.owner === state.seat).map(m => m.id);
          const id = allowed[vars.pick - 1];
          if (id === undefined) {
            throw new Error(`--pick ${vars.pick}: the encounter lets ${state.seat} pick from ${allowed.length}`);
          }
          return { member: state.party.findIndex(m => m.id === id) };
        }
        // a replacement after a faint: the first that can go
        return { press: "ACTION" };
      }
      case "SUMMARY":
        // which move to forget: the one above the new move; a summary opened from anything else is left
        return state.phase === "LearnMovePhase" ? { press: ["UP", "ACTION"] } : { press: "CANCEL" };
      default:
        return null;
    }
  }

  /** Shoot this window too with every step from now on, as one more pane */
  watch(label: string, page: Page): void {
    this.extras.push({ label, page });
  }

  /** Close every player's page */
  async close(): Promise<void> {
    await Promise.all(
      [...this.clients.values()].map(client =>
        client.page
          .context()
          .close()
          .catch(() => undefined),
      ),
    );
    this.clients.clear();
  }

  /** Every player's screen as it is, whatever was shot before: the last step of a run that failed */
  async failureShot(): Promise<void> {
    if (this.clients.size === 0) {
      return;
    }
    const states = await this.states().catch(() => null);
    if (states !== null) {
      await this.shot("failed-here", true, states).catch(() => undefined);
    }
    console.log(JSON.stringify(await describeClients(...this.clients.values()), null, 1).slice(0, 4000));
  }

  // #endregion
}

/**
 * `SHOT_FAIL_DOWNLOADS=<seat>:<percent>`: that player's browser fails about that share of the game's image and data files,
 * always the same ones (chosen by their path), so that asking again fails too: a download that never comes (D45).
 */
async function failSomeDownloads(context: BrowserContext, seat: Seat): Promise<void> {
  const [who, percent] = (process.env["SHOT_FAIL_DOWNLOADS"] ?? "").split(":");
  const share = Number(percent);
  if (who !== seat || !(share > 0)) {
    return;
  }
  const failed: string[] = [];
  await context.route(/\/images\/.+\.(png|json)(\?|$)/, route => {
    const path = new URL(route.request().url()).pathname;
    let hash = 0;
    for (const char of path) {
      hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    if (hash % 100 < share) {
      if (!failed.includes(path)) {
        failed.push(path);
        console.log(`  (${seat} fails ${path})`);
      }
      return route.fulfill({ status: 503, body: "busy" });
    }
    return route.continue();
  });
}

/** A page between two documents (a reload), or one whose game has not started yet */
function loadingState(seat: Seat): ClientState {
  return {
    seat,
    phase: "",
    wave: 0,
    turn: 0,
    ui: "LOADING",
    text: "",
    prompt: false,
    menu: [],
    own: true,
    me: null,
    reward: null,
    trade: null,
    lobby: null,
    linked: false,
    desync: null,
    away: null,
    party: [],
    moving: 0,
  };
}

/** The buttons the screen that is open takes; the rest are the game's own keys (`ui-inputs.ts`) */
const SCREEN_BUTTONS = ["UP", "DOWN", "LEFT", "RIGHT", "SUBMIT", "ACTION", "CANCEL"];

/** Long enough that no wait within a shot reaches it */
const AFK_OFF_MS = 3_600_000;

/** Choose the entry of the open option menu with this label */
export function choose(state: ClientState, label: string): Action {
  const index = state.menu.indexOf(label);
  if (index === -1) {
    throw new Error(`${state.seat}'s menu has no "${label}" (it has: ${state.menu.join(", ") || "nothing"})`);
  }
  return { cursor: index, press: "ACTION" };
}

/** A step's screens seen this many times means the players go round in circles */
const MAX_VISITS = 6;

/**
 * Nothing on the screen is sliding or fading in; or it shows a line that has been typed out, which is what the player
 * reads while the battle animates under it (a ball that shakes, an HP bar)
 */
function still(state: ClientState): boolean {
  return state.moving === 0 || state.text !== "";
}

/** The screen is still coming up: a reward screen that does not take input yet */
function comingUp(state: ClientState): boolean {
  return state.ui === "MODIFIER_SELECT" && state.reward !== null && !state.reward.ready;
}

/** What makes two steps the same screen */
function signatureOf(state: ClientState): string {
  return JSON.stringify([
    state.phase,
    state.ui,
    state.text,
    state.menu,
    state.me?.question?.k ?? null,
    state.me?.step ?? null,
    state.reward && [state.reward.screen, state.reward.step, state.reward.picker, state.reward.ready],
    state.trade && [state.trade.mode, state.trade.give, state.trade.want, state.trade.status],
    state.lobby,
    state.away,
  ]);
}

function captionOf(state: ClientState): SeatCaption {
  return {
    seat: state.seat,
    phase: state.phase || "-",
    ui: state.ui,
    text: state.text.replace(/\s+/g, " "),
    menu: state.menu,
  };
}

/** A step's name: what the player who acts is on (or the host, when nobody does) */
function nameOf(states: ClientState[], actions: (Action | null)[]): string {
  const i = actions.findIndex(action => action !== null);
  const state = states[i === -1 ? 0 : i];
  const k = state.me?.question?.k;
  const what = `${state.ui.toLowerCase().replace(/_/g, "-")}${k === undefined ? "" : `-${k.toLowerCase()}`}`;
  return i === -1 || state.seat === "host" ? what : `${state.seat}-${what}`;
}
