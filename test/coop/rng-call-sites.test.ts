/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, it } from "vitest";
import { scanSimCallSites, stripComments } from "./sim-call-sites";

/**
 * Call-site test (DECISIONS D3, fork pattern): every unseeded RNG call (`Math.random`, `randInt`, `randIntRange`,
 * `randItem`, `randGauss`, unseeded `randomString`) and every wall-clock read (`Date.now`, `new Date`,
 * `performance.now`, `crypto`) under `src/` is listed here with the reason it is harmless in co-op. A new call fails
 * the test: decide whether it is on a simulation path (give it a dedicated seeded stream like `simRandInt`, or guard
 * it) or not (list it here), do not just bump a number.
 *
 * Each entry is the exact count per pattern. The list is every such call found in this build.
 */
type Why =
  | "ui" // screens, animations, particles, splash text: never read by the simulation
  | "account" // account data (ids, save timestamps, unlock times): not part of a co-op run's simulation (D4)
  | "solo-only" // the solo branch of a co-op wrapper; co-op draws from a dedicated stream
  | "guarded" // reachable only through a feature that is off in co-op (D12); throws there
  | "dead" // no callers at this SHA
  | "definition" // the helper itself
  | "run-seed" // replaced by the host's seed from START in co-op
  | "disabled"; // gated off in co-op (D3, D12)

const ALLOWED: Record<string, { counts: Record<string, number>; why: Why; note?: string }> = {
  "src/account.ts": { counts: { randomString: 1 }, why: "account", note: "clientSessionId" },
  "src/animations.ts": { counts: { randInt: 3, randGauss: 1 }, why: "ui", note: "evolution/particle tweens" },
  "src/battle-scene.ts": {
    counts: { randomString: 1, "Date.now": 2 },
    why: "run-seed",
    note: "reset() picks the run seed (the host's in co-op); Date.now = achv/voucher unlock times (account)",
  },
  "src/coop/lobby.ts": {
    counts: { randomString: 1, "Date.now": 1 },
    why: "run-seed",
    note: "the host draws the seed of the run before the lobby; it travels in START (D3); Date.now = when a seat token was stored (D20)",
  },
  "src/coop/coop-log.ts": {
    counts: { "new Date": 1, crypto: 2 },
    why: "ui",
    note: "the co-op log's clock (when a line was written) and the id of a page load (D26); nothing reads them back",
  },
  "src/coop/cosmetic-view.ts": {
    counts: { "Date.now": 2 },
    why: "ui",
    note: "when a ping or an emote bubble was shown (what the debug view lists); the simulation never reads it (D16)",
  },
  "src/coop/rejoin.ts": {
    counts: { "Date.now": 3 },
    why: "ui",
    note: "when a rejoin began and when the handshake was through (the debug API shows them); nothing reads them back",
  },
  "src/coop/resync-run.ts": {
    counts: { "Date.now": 2 },
    why: "ui",
    note: "when a RESYNC arrived and when a report was saved (the debug API shows them); nothing reads them back",
  },
  "src/coop/wave-save.ts": {
    counts: { "Date.now": 1 },
    why: "ui",
    note: "when the co-op slot was written, to show it; the simulation never reads it",
  },
  "src/phases/coop-resync-phase.ts": {
    counts: { "Date.now": 2 },
    why: "ui",
    note: "when a reload began and ended (the debug API shows them); nothing reads them back",
  },
  "src/coop/stall-detector.ts": {
    counts: { "Date.now": 4 },
    why: "ui",
    note: "dev builds only: how long the phase trace has not moved; it only reads the game",
  },
  "src/coop/chat.ts": {
    counts: { "Date.now": 1 },
    why: "ui",
    note: "the chat box's sending and receiving limits (D38); the chat is not part of a run",
  },
  "src/coop/save-backup-offer.ts": {
    counts: { "Date.now": 1 },
    why: "account",
    note: "when the account was backed up or the offer put off (title screen); no run reads it",
  },
  "src/coop/sim-rng.ts": { counts: { randInt: 1 }, why: "solo-only", note: "simRandInt in solo play" },
  "src/coop/transport/transport.ts": { counts: { "Date.now": 1 }, why: "ui", note: "transport clock, not simulation" },
  "src/data/egg.ts": {
    counts: { randInt: 2, randomString: 1, "Date.now": 1, "new Date": 1 },
    why: "account",
    note: "a new egg is this account's (D30): its draws run under a seed override that executeWithSeedOffset puts back, so the run's stream is untouched; new Date = egg date label",
  },
  "src/data/mystery-encounters/encounters/absolute-avarice-encounter.ts": {
    counts: { randInt: 12 },
    why: "ui",
    note: "tween offsets",
  },
  "src/data/mystery-encounters/encounters/global-trade-system-encounter.ts": {
    counts: { randInt: 2 },
    why: "solo-only",
    note: "the ball of the traded Pokémon: co-op rolls it from the run's stream (D29)",
  },
  "src/data/splash-messages.ts": { counts: { "new Date": 3 }, why: "ui" },
  "src/data/status-effect.ts": {
    counts: { randIntRange: 2 },
    why: "dead",
    note: "generateRandomStatusEffect, getRandomStatusEffect: no callers; getRandomStatus uses simRandInt",
  },
  "src/field/pokemon-sprite-tera-sparkle-handler.ts": { counts: { randInt: 2 }, why: "ui" },
  "src/phases/egg-hatch-phase.ts": {
    counts: { randInt: 3 },
    why: "ui",
    note: "hatch particles",
  },
  "src/phases/game-over-phase.ts": { counts: { "Date.now": 1 }, why: "account", note: "run history timestamp" },
  "src/phases/title-phase.ts": {
    counts: { "new Date": 2 },
    why: "ui",
    note: "title screen and daily-run seed (daily is off)",
  },
  "src/phases/coop-turn-sync-phase.ts": {
    counts: { "performance.now": 2 },
    why: "ui",
    note: "how long this client waited for its partner's commands (latency report); never read by the simulation",
  },
  "src/system/game-data.ts": {
    counts: { randInt: 3, "Date.now": 2 },
    why: "account",
    note: "new-account TID/SID, dex defaults, save timestamps",
  },
  "src/system/version-migration/version-converter.ts": { counts: { "Date.now": 1 }, why: "account" },
  "src/timed-event-manager.ts": {
    counts: { "new Date": 2 },
    why: "disabled",
    note: "the clock only decides solo play: isActive() reads the run's events in co-op (D33); isAprilFoolsActive is title-screen UI",
  },
  "src/ui/containers/event-display.ts": { counts: { "new Date": 1 }, why: "ui" },
  "src/ui/handlers/achvs-ui-handler.ts": { counts: { "new Date": 2 }, why: "ui" },
  "src/ui/handlers/egg-gacha-ui-handler.ts": {
    counts: { "Date.now": 2, randInt: 1 },
    why: "account",
    note: "Date.now: the machine's timers; randInt: in co-op, the order of this player's pulled eggs (D30)",
  },
  "src/ui/handlers/egg-list-ui-handler.ts": { counts: { "new Date": 1 }, why: "ui" },
  "src/ui/handlers/party-ui-handler.ts": { counts: { randInt: 1 }, why: "ui" },
  "src/ui/handlers/pokedex-ui-handler.ts": { counts: { randIntRange: 1 }, why: "ui" },
  "src/ui/handlers/run-history-ui-handler.ts": { counts: { "new Date": 1 }, why: "ui" },
  "src/ui/handlers/save-slot-select-ui-handler.ts": { counts: { "new Date": 2 }, why: "ui" },
  "src/ui/handlers/starter-select-ui-handler.ts": {
    counts: { "Math.random": 1 },
    why: "ui",
    note: "random-starter button",
  },
  "src/ui/handlers/title-ui-handler.ts": { counts: { randInt: 1, randItem: 2, "new Date": 1 }, why: "ui" },
  "src/ui/handlers/unavailable-modal-ui-handler.ts": {
    counts: { "Math.random": 1 },
    why: "ui",
    note: "reconnect jitter",
  },
  "src/utils/common.ts": {
    counts: { "Math.random": 4, randInt: 3, randIntRange: 1, randGauss: 1, randomString: 1, "new Date": 1 },
    why: "definition",
    note: "the helpers; new Date = getCurrentTime (sprite tint, UI)",
  },
  "src/utils/cookies.ts": { counts: { "Date.now": 1, "new Date": 1 }, why: "ui" },
  "src/utils/pokemon-utils.ts": {
    counts: { "new Date": 1 },
    why: "ui",
    note: "getPokerusStarters: starter/dex screens only",
  },
};

/** Fixed event dates: `new Date(Date.UTC(...))` literals, not clock reads. */
const STATIC_FILES = ["src/data/balance/timed-events.ts"];

describe("unseeded RNG and wall-clock call sites in src/ (D3)", () => {
  const found = scanSimCallSites(process.cwd());
  for (const file of STATIC_FILES) {
    delete found[file];
  }

  it("has no call site in a file that is not listed", () => {
    const unlisted = Object.keys(found).filter(file => !(file in ALLOWED));
    expect(unlisted, `unlisted call sites: ${JSON.stringify(unlisted.map(f => [f, found[f]]))}`).toEqual([]);
  });

  it("lists exact counts per file (a new call in a listed file counts as new)", () => {
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([file, entry]) => [file, entry.counts]));
    expect(found).toEqual(expected);
  });

  it("the entries that depend on a co-op guard are exactly the guarded ones", () => {
    // These are the entries a reviewer must re-check when the code around them changes.
    const sensitive = Object.entries(ALLOWED)
      .filter(([, entry]) => entry.why === "guarded" || entry.why === "disabled" || entry.why === "solo-only")
      .map(([file]) => file)
      .sort();
    expect(sensitive).toEqual([
      "src/coop/sim-rng.ts",
      "src/data/mystery-encounters/encounters/global-trade-system-encounter.ts",
      "src/timed-event-manager.ts",
    ]);
  });
});

describe("stripComments", () => {
  it("ignores calls that only appear in comments, keeps code after a URL string", () => {
    expect(stripComments("// randInt(2)\nconst a = 1;")).not.toContain("randInt");
    expect(stripComments("/* Math.random() */ x")).not.toContain("Math.random");
    expect(stripComments('const u = "http://x"; randInt(2);')).toContain("randInt(2)");
  });
});
