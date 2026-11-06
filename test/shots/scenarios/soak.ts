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

export const soakScenarios: Scenario[] = [soak];
