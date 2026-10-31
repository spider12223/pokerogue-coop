/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { AccountSnapshot } from "#coop/account-snapshot";
import {
  type BuildIdentity,
  type CoopStarter,
  canonicalJson,
  cleanName,
  compareBuild,
  DECISION_KINDS,
  DEFAULT_NAME,
  type DecisionKey,
  type Envelope,
  type HelloPayload,
  hashCanonical,
  isBuildIdentity,
  isCheckpointMessage,
  isDecisionKey,
  isEnvelope,
  isHelloAckPayload,
  isHelloPayload,
  isLobbyMessage,
  isStartPayload,
  keyId,
  keysEqual,
  MAX_KEY_WAVE,
  MAX_NAME_LENGTH,
  MAX_REF_LENGTH,
  NO_REF,
  type StartPayload,
} from "#coop/protocol";
import { describe, expect, it } from "vitest";

const key: DecisionKey = { wave: 3, turn: 2, kind: "TURN_COMMANDS", ref: 1 };

const build: BuildIdentity = {
  protocolVersion: 1,
  gitSha: "a6995c571a092e762ea036589bb6f3a8fa4f5dbd",
  dirtyHash: "clean",
  buildMode: "development+bypass",
  overridesHash: "00000000000000",
};

const hello: HelloPayload = {
  build,
  pinnedSettings: { battleStyle: 1, enableTutorials: false, playerGender: 1 },
  name: "Sam",
  mode: "new",
  runMode: "classic",
};

describe("DecisionKey", () => {
  it("compares by value and has a stable id", () => {
    expect(keysEqual(key, { ...key })).toBe(true);
    expect(keysEqual(key, { ...key, ref: 0 })).toBe(false);
    expect(keysEqual(key, { ...key, turn: 3 })).toBe(false);
    expect(keysEqual(key, { ...key, wave: 4 })).toBe(false);
    expect(keysEqual(key, { ...key, kind: "FAINT_SWITCH" })).toBe(false);
    expect(keyId(key)).toBe("3:2:TURN_COMMANDS:1");
    // composite refs (D2): prompt decisions carry `turn = 0` and a string that is unique within the wave
    const learn: DecisionKey = { wave: 3, turn: 0, kind: "LEARN_MOVE", ref: "123456:33" };
    expect(keyId(learn)).toBe('3:0:LEARN_MOVE:"123456:33"');
    expect(keysEqual(learn, { ...learn })).toBe(true);
    expect(keysEqual(learn, { ...learn, ref: "123456:34" })).toBe(false);
    // a number and the same number as a string are different keys
    expect(keysEqual({ ...key, ref: 1 }, { ...key, ref: "1" })).toBe(false);
    expect(keyId({ ...key, ref: 1 })).not.toBe(keyId({ ...key, ref: "1" }));
  });

  it("accepts every decision kind and rejects malformed keys", () => {
    for (const kind of DECISION_KINDS) {
      expect(isDecisionKey({ wave: 1, turn: 0, kind, ref: NO_REF })).toBe(true);
    }
    expect(isDecisionKey(null)).toBe(false);
    expect(isDecisionKey({ ...key, kind: "NOPE" })).toBe(false);
    expect(isDecisionKey({ ...key, wave: 1.5 })).toBe(false);
    expect(isDecisionKey({ ...key, ref: "123:33" })).toBe(true);
    expect(isDecisionKey({ ...key, ref: "" })).toBe(false);
    expect(isDecisionKey({ ...key, ref: 1.5 })).toBe(false);
    expect(isDecisionKey({ ...key, ref: null })).toBe(false);
    expect(isDecisionKey({ ...key, ref: ["1"] })).toBe(false);
    expect(isDecisionKey({ wave: 1, turn: 1, kind: "BIOME" })).toBe(false);
  });

  it("bounds what a forged key can be: the wave, the turn and the length of the ref", () => {
    const key = { wave: 1, turn: 0, kind: "LEARN_MOVE", ref: "12:33" };
    expect(isDecisionKey({ ...key, wave: MAX_KEY_WAVE })).toBe(true);
    expect(isDecisionKey({ ...key, wave: MAX_KEY_WAVE + 1 })).toBe(false);
    expect(isDecisionKey({ ...key, wave: -1 })).toBe(false);
    expect(isDecisionKey({ ...key, turn: -1 })).toBe(false);
    expect(isDecisionKey({ ...key, turn: 2 ** 40 })).toBe(false);
    expect(isDecisionKey({ ...key, ref: "1".repeat(MAX_REF_LENGTH) })).toBe(true);
    expect(isDecisionKey({ ...key, ref: "1".repeat(MAX_REF_LENGTH + 1) })).toBe(false);
    expect(isDecisionKey({ ...key, ref: 2 ** 60 })).toBe(false);
    // a Pokémon id is 32 bits
    expect(isDecisionKey({ ...key, ref: 2 ** 32 - 1 })).toBe(true);
  });
});

describe("display names (D1)", () => {
  it("cannot carry the message box's markup: a font size code would black out the partner's screen", () => {
    expect(cleanName("@f{99999999}")).toBe("f99999999");
    expect(cleanName("Sam@d{50}")).toBe("Samd50");
    expect(cleanName("a$b")).toBe("ab");
    expect(cleanName("@c{red}Al@s{se}")).toBe("credAlsse");
    expect(cleanName("@{}$")).toBe(DEFAULT_NAME);
  });

  it("drops invisible format characters and control characters, and keeps the rest", () => {
    expect(cleanName("Al‮ex")).toBe("Alex");
    expect(cleanName("A‍l﻿ex")).toBe("Alex");
    expect(cleanName("Al\nex\t")).toBe("Al ex");
    expect(cleanName("  Pokémon   Fan ")).toBe("Pokémon Fan");
    expect(cleanName("ジョン")).toBe("ジョン");
    expect(cleanName("x".repeat(40))).toHaveLength(MAX_NAME_LENGTH);
    expect(cleanName(5)).toBe(DEFAULT_NAME);
  });
});

describe("isEnvelope", () => {
  const sequenced: Envelope = { seq: 1, key, author: "host", kind: "SEQUENCED", payload: { move: 3 } };

  it("accepts well-formed envelopes", () => {
    expect(isEnvelope(sequenced)).toBe(true);
    expect(isEnvelope({ key: null, author: "guest", kind: "HELLO", payload: hello })).toBe(true);
    expect(isEnvelope({ key, author: "guest", kind: "PROPOSE", payload: null })).toBe(true);
  });

  it("rejects what the sequencer could not handle", () => {
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope({ ...sequenced, author: "spectator" })).toBe(false);
    expect(isEnvelope({ ...sequenced, kind: "WHATEVER" })).toBe(false);
    expect(isEnvelope({ ...sequenced, seq: 0 })).toBe(false);
    expect(isEnvelope({ ...sequenced, seq: undefined })).toBe(false);
    expect(isEnvelope({ ...sequenced, key: null })).toBe(false);
    expect(isEnvelope({ key: null, author: "guest", kind: "PROPOSE", payload: null })).toBe(false);
    expect(isEnvelope({ ...sequenced, key: { ...key, kind: "NOPE" } })).toBe(false);
  });
});

describe("HELLO", () => {
  it("identical builds match", () => {
    expect(compareBuild(build, { ...build })).toEqual([]);
  });

  it("names every build field that differs", () => {
    const remote: BuildIdentity = {
      protocolVersion: 2,
      gitSha: "deadbeef",
      dirtyHash: "0123456789abcd",
      buildMode: "production",
      overridesHash: "11111111111111",
    };
    expect(compareBuild(build, remote).map(m => m.field)).toEqual([
      "protocolVersion",
      "gitSha",
      "dirtyHash",
      "buildMode",
      "overridesHash",
    ]);
  });

  it("validates the payload shapes", () => {
    expect(isBuildIdentity(build)).toBe(true);
    expect(isBuildIdentity({ ...build, dirtyHash: 5 })).toBe(false);
    expect(isHelloPayload(hello)).toBe(true);
    expect(isHelloPayload({ ...hello, build: { ...build, gitSha: 5 } })).toBe(false);
    expect(isHelloPayload({ ...hello, pinnedSettings: null })).toBe(false);
    expect(isHelloPayload({ ...hello, pinnedSettings: [] })).toBe(false);
    expect(isHelloPayload(null)).toBe(false);
    expect(isHelloPayload({ build, pinnedSettings: hello.pinnedSettings })).toBe(false);
    // the host says whether it continues a saved run (D21)
    expect(isHelloPayload({ ...hello, mode: "resume" })).toBe(true);
    expect(isHelloPayload({ ...hello, mode: "other" })).toBe(false);
    // the kind of run (D39)
    expect(isHelloPayload({ ...hello, runMode: "endless" })).toBe(true);
    expect(isHelloPayload({ ...hello, runMode: "daily" })).toBe(false);
    expect(isHelloPayload({ ...hello, runMode: undefined })).toBe(false);
    expect(isHelloPayload({ build, pinnedSettings: hello.pinnedSettings, name: "Sam" })).toBe(false);
    // the guest says which account it is (D21)
    expect(isHelloAckPayload({ build, effectiveSettingsHash: "abc", name: "Sam", accountId: "1:2" })).toBe(true);
    expect(isHelloAckPayload({ build, effectiveSettingsHash: "abc", name: "Sam" })).toBe(false);
    expect(isHelloAckPayload({ build, effectiveSettingsHash: "abc", accountId: "1:2" })).toBe(false);
    expect(isHelloAckPayload({ build, effectiveSettingsHash: 5, name: "Sam", accountId: "1:2" })).toBe(false);
    expect(isHelloAckPayload({ effectiveSettingsHash: "abc", name: "Sam", accountId: "1:2" })).toBe(false);
  });
});

const starter: CoopStarter = {
  speciesId: 1,
  shiny: false,
  variant: 0,
  formIndex: 0,
  female: false,
  abilityIndex: 0,
  passive: false,
  nature: 3,
  moveset: [33, 45],
  pokerus: false,
  ivs: [1, 2, 3, 4, 5, 6],
};

const account: AccountSnapshot = {
  trainerId: 1,
  secretId: 2,
  unlocked: { eviolite: false, miniBlackHole: false },
  caught: { 1: "1" },
  eggMoves: {},
};

const start: StartPayload = {
  runSeed: "x7Kq",
  starters: { host: [starter], guest: [starter, { ...starter, speciesId: 4 }] },
  snapshots: { host: account, guest: account },
  timedEvents: ["Halloween 26"],
};

describe("START", () => {
  it("carries the run seed, the starters of both seats, both accounts and the timed events of the run", () => {
    expect(isStartPayload(start)).toBe(true);
    expect(isStartPayload(JSON.parse(JSON.stringify(start)))).toBe(true);
  });

  it.each([
    ["an empty seed", { ...start, runSeed: "" }],
    ["a seed that is no string", { ...start, runSeed: 5 }],
    ["no starters", { runSeed: "x7Kq", snapshots: start.snapshots }],
    ["a seat with no starter", { ...start, starters: { host: [], guest: [starter] } }],
    [
      "four starters for a seat",
      { ...start, starters: { host: [starter, starter, starter, starter], guest: [starter] } },
    ],
    ["a starter that is no starter", { ...start, starters: { host: [{ speciesId: "x" }], guest: [starter] } }],
    ["no snapshots", { ...start, snapshots: null }],
    ["no timed events", { ...start, timedEvents: undefined }],
    ["a timed event that is no name", { ...start, timedEvents: [""] }],
    ["too many timed events", { ...start, timedEvents: Array.from({ length: 17 }, (_, i) => `event ${i}`) }],
    ["null", null],
  ])("rejects %s", (_name, payload) => {
    expect(isStartPayload(payload)).toBe(false);
  });
});

describe("LOBBY", () => {
  it("accepts picks, ready, unready and reset", () => {
    expect(isLobbyMessage({ t: "picks", picks: [starter], cost: 3 })).toBe(true);
    expect(isLobbyMessage({ t: "picks", picks: [], cost: 0 })).toBe(true);
    expect(isLobbyMessage({ t: "ready", starters: [starter], cost: 3, snapshot: account, events: [], gen: 1 })).toBe(
      true,
    );
    expect(
      isLobbyMessage({ t: "ready", starters: [starter], cost: 3, snapshot: account, events: ["Halloween 26"], gen: 2 }),
    ).toBe(true);
    expect(isLobbyMessage({ t: "unready" })).toBe(true);
    expect(isLobbyMessage({ t: "reset", gen: 1 })).toBe(true);
  });

  it("rejects what is not one", () => {
    expect(isLobbyMessage({ t: "picks", picks: [starter, starter, starter, starter], cost: 3 })).toBe(false);
    expect(isLobbyMessage({ t: "picks", picks: [starter] })).toBe(false);
    expect(isLobbyMessage({ t: "ready", starters: [starter], cost: 3 })).toBe(false);
    expect(isLobbyMessage({ t: "ready", starters: [starter], cost: 3, snapshot: account })).toBe(false);
    expect(isLobbyMessage({ t: "ready", starters: [starter], cost: 3, snapshot: account, events: [3] })).toBe(false);
    // the count of the sender's readies, which a reset answers
    expect(isLobbyMessage({ t: "ready", starters: [starter], cost: 3, snapshot: account, events: [] })).toBe(false);
    expect(isLobbyMessage({ t: "reset" })).toBe(false);
    expect(isLobbyMessage({ t: "nope" })).toBe(false);
    expect(isLobbyMessage(null)).toBe(false);
  });
});

describe("CHECKPOINT", () => {
  const checkpoint = {
    index: 0,
    kind: "turn",
    wave: 1,
    turn: 1,
    phaseName: "TurnInitPhase",
    hash: hashCanonical({ state: 1 }),
  };

  it("has an index, a kind, the wave and turn, the phase and a hash", () => {
    expect(isCheckpointMessage(checkpoint)).toBe(true);
    expect(isCheckpointMessage({ ...checkpoint, hash: 5 })).toBe(false);
    expect(isCheckpointMessage({ ...checkpoint, index: 0.5 })).toBe(false);
  });

  it("is bounded: the hash is the state hash's, the strings are short, the numbers in range", () => {
    expect(isCheckpointMessage({ ...checkpoint, hash: "ab" })).toBe(false);
    expect(isCheckpointMessage({ ...checkpoint, hash: "x".repeat(14) })).toBe(false);
    expect(isCheckpointMessage({ ...checkpoint, hash: "a".repeat(100_000) })).toBe(false);
    expect(isCheckpointMessage({ ...checkpoint, phaseName: "P".repeat(65) })).toBe(false);
    expect(isCheckpointMessage({ ...checkpoint, kind: "k".repeat(17) })).toBe(false);
    expect(isCheckpointMessage({ ...checkpoint, index: -1 })).toBe(false);
    expect(isCheckpointMessage({ ...checkpoint, wave: -1 })).toBe(false);
    expect(isCheckpointMessage({ ...checkpoint, turn: MAX_KEY_WAVE + 1 })).toBe(false);
  });
});

describe("canonical JSON and hash", () => {
  it("ignores key order, recursively", () => {
    const a = { x: 1, y: { b: [1, { d: 4, c: 3 }], a: true } };
    const b = { y: { a: true, b: [1, { c: 3, d: 4 }] }, x: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(hashCanonical(a)).toBe(hashCanonical(b));
  });

  it("changes when the data changes, and has a fixed width", () => {
    expect(hashCanonical({ a: 1 })).not.toBe(hashCanonical({ a: 2 }));
    expect(hashCanonical([1, 2])).not.toBe(hashCanonical([2, 1]));
    expect(hashCanonical({})).toMatch(/^[0-9a-f]{14}$/);
    expect(hashCanonical("x")).toMatch(/^[0-9a-f]{14}$/);
  });
});
