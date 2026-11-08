/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import fs from "node:fs";
import type { ClientState, ShotRun } from "../engine.ts";
import type { Scenario } from "../scenario.ts";

/**
 * A longer run, to catch what a short one does not: desyncs (D13) and what the clients log. A player backs out of a target
 * screen once, the host's tab reloads in the middle of a wave, and waves are played on. Every client's reloads, desync
 * message and logged warnings and errors are saved to `test-results/soak-<time>.json` after each part.
 */

const atCommand = (states: ClientState[]) => states.every(state => state.ui === "COMMAND");
/** The reward screens: the picker skips them ("yes" is the bot's), the others wait */
const skipRewards = (state: ClientState): { press: string } | null | undefined =>
  state.ui === "MODIFIER_SELECT"
    ? state.reward?.ready && state.reward.picker === state.seat
      ? { press: "CANCEL" }
      : null
    : undefined;
/** Stop driving: a desync, or the run is over (a wipe: the bot does not choose to retry) */
const stuck = (states: ClientState[]) => states.some(state => state.desync !== null || state.phase === "GameOverPhase");

interface ClientDump {
  seat: string;
  epoch: number;
  resyncs: unknown;
  desync: string | null;
  stopped: unknown;
  problems: { n: number; level: string; kind: string; msg: string }[];
}

async function dump(run: ShotRun, label: string, file: string, parts: unknown[]): Promise<void> {
  const clients: ClientDump[] = [];
  for (const seat of run.seats) {
    const log = (await run.eval<ClientDump["problems"] | null>(seat, "coopLog")) ?? [];
    clients.push({
      seat,
      epoch: await run.eval<number>(seat, "epoch"),
      resyncs: await run.eval<unknown>(seat, "resyncs"),
      desync: await run.eval<string | null>(seat, "desync"),
      stopped: await run.eval<unknown>(seat, "stopped"),
      problems: log.filter(entry => entry.level === "warn" || entry.level === "error").slice(-40),
    });
  }
  parts.push({ label, wave: (await run.state("host")).wave, clients });
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync(file, JSON.stringify(parts, null, 1));
  console.log(
    `  soak: ${label}: ${clients.map(c => `${c.seat} epoch ${c.epoch}${c.desync ? ` DESYNC ${c.desync}` : ""}`).join("; ")}`,
  );
}

const soak: Scenario = {
  id: "coop:soak",
  area: "Co-op",
  summary:
    "a longer run: a player backs out of a target once, the host's tab reloads in a wave, waves go on; every client's reloads and logged errors go to test-results/soak-<time>.json",
  vars: { seat: "guest" },
  async play(run, vars) {
    const file = `test-results/soak-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const parts: unknown[] = [];
    // (a rejoin compares the overrides, D1, and a reloaded page has none: this run has none either)
    await run.toRun({}, { plain: true });
    await run.drive({ until: atCommand, shoot: () => false });
    const first = (await run.state("host")).wave;

    // a player backs out of the target screen once, then picks again
    let backedOut = false;
    await run.drive({
      until: states => stuck(states) || states.every(state => state.wave > first && state.ui === "COMMAND"),
      answer: state => {
        if (!backedOut && state.seat === vars.seat && state.ui === "TARGET_SELECT") {
          backedOut = true;
          return { press: "CANCEL" };
        }
        return skipRewards(state);
      },
      shoot: () => false,
      maxSteps: 600,
    });
    await dump(run, "after a wave with a target backed out of", file, parts);

    // the host's tab goes away in the middle of a turn, and comes back
    const host = run.client("host").page;
    await host.goto("about:blank");
    await run.drive({
      answer: skipRewards,
      until: states =>
        states.some(
          state =>
            state.seat !== "host"
            && (state.away !== null || (state.phase === "CoopTurnSyncPhase" && state.ui === "MESSAGE")),
        ),
      shoot: () => false,
    });
    await host.goto("/");
    await run.drive({
      answer: skipRewards,
      until: states => states.every(state => state.ui === "COMMAND" && state.linked),
      shoot: () => false,
      maxSteps: 120,
    });
    await dump(run, "after the host's tab came back", file, parts);

    // two more waves
    const back = (await run.state("host")).wave;
    await run.drive({
      answer: skipRewards,
      until: states => stuck(states) || states.every(state => state.wave >= back + 2 && state.ui === "COMMAND"),
      shoot: () => false,
      maxSteps: 900,
    });
    await dump(run, "two waves later", file, parts);
  },
};

/**
 * What an alt-tabbed window does, done to a page the browser test cannot really hide: the window loses the focus and is
 * hidden (the events, `document.hidden`), and its game loop stops (a hidden page gets no animation frames). Its network
 * goes on, and its timers too, but at most once a second (as Chrome's are on a hidden page).
 */
async function setHidden(run: ShotRun, seat: Parameters<ShotRun["client"]>[0], hidden: boolean): Promise<void> {
  const scenePath = "/src/globals/global-scene.ts";
  await run.client(seat).page.evaluate(
    async ({ away, path }) => {
      const { globalScene } = await import(path);
      const loop = globalScene.game.loop;
      const w = window as any;
      if (w.__altTabTimers === undefined) {
        // a timer that comes due while hidden runs at the next whole second
        const realSetTimeout = window.setTimeout.bind(window);
        const realSetInterval = window.setInterval.bind(window);
        const aligned =
          (fn: (...a: unknown[]) => void) =>
          (...a: unknown[]) => {
            if (w.__altTabHidden === true) {
              realSetTimeout(() => fn(...a), 1000 - (performance.now() % 1000));
            } else {
              fn(...a);
            }
          };
        w.__altTabTimers = true;
        (window as any).setTimeout = (fn: any, ms?: number, ...a: unknown[]) =>
          typeof fn === "function" ? realSetTimeout(aligned(fn), ms, ...a) : realSetTimeout(fn, ms);
        (window as any).setInterval = (fn: any, ms?: number, ...a: unknown[]) =>
          typeof fn === "function" ? realSetInterval(aligned(fn), Math.max(ms ?? 0, 0), ...a) : realSetInterval(fn, ms);
      }
      w.__altTabHidden = away;
      Object.defineProperty(document, "hidden", { configurable: true, get: () => away });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (away ? "hidden" : "visible"),
      });
      document.hasFocus = () => !away;
      if (away) {
        window.dispatchEvent(new Event("blur"));
        document.dispatchEvent(new Event("visibilitychange"));
        loop.sleep();
      } else {
        loop.wake();
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
      }
    },
    { away: hidden, path: scenePath },
  );
}

const altTab: Scenario = {
  id: "coop:alt-tab",
  area: "Co-op",
  summary:
    "--seat alt-tabs again and again (its window hidden for a few seconds, its game loop stopped) over three waves; every client's reloads and logged errors go to test-results/alt-tab-<time>.json",
  vars: { seat: "guest" },
  async play(run, vars) {
    const file = `test-results/alt-tab-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const parts: unknown[] = [];
    await run.toRun();
    await run.drive({ until: atCommand, shoot: () => false });
    const first = (await run.state("host")).wave;
    let hidden = false;
    let done = false;
    const hides: string[] = [];
    // away for 4 to 9 s, back for 3 to 8 s, at whatever the game shows then (a fixed sequence: the same run each time)
    const awayMs = [6000, 4000, 9000, 5000, 7000];
    const backMs = [3000, 8000, 4000, 6000, 5000];
    const tabber = (async () => {
      for (let i = 0; !done; i++) {
        await new Promise(r => setTimeout(r, backMs[i % backMs.length]));
        if (done) {
          break;
        }
        const at = await run.state(vars.seat);
        hides.push(`${i}: wave ${at.wave} turn ${at.turn} ${at.phase}/${at.ui}`);
        console.log(`  alt-tab ${i}: ${vars.seat} away at wave ${at.wave} turn ${at.turn} ${at.phase}/${at.ui}`);
        hidden = true;
        await setHidden(run, vars.seat, true);
        await new Promise(r => setTimeout(r, awayMs[i % awayMs.length]));
        await setHidden(run, vars.seat, false);
        hidden = false;
      }
    })();
    try {
      await run.drive({
        // (the one who alt-tabs is behind: the others are not on the command menu with it)
        until: states =>
          stuck(states)
          || (states.every(state => state.wave >= first + 3) && states.some(state => state.ui === "COMMAND")),
        // an alt-tabbed player presses nothing
        answer: state => (state.seat === vars.seat && hidden ? null : skipRewards(state)),
        shoot: () => false,
        maxSteps: 1200,
      });
    } finally {
      done = true;
      await tabber;
      parts.push({ hides });
      await dump(run, "after three waves of alt-tabs", file, parts);
    }
  },
};

export const soakScenarios: Scenario[] = [soak, altTab];
