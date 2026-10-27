/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { AccountSnapshot } from "#coop/account-snapshot";
import type { BuildIdentity } from "#coop/protocol";
import {
  COOP_SAVE_VERSION,
  type CoopSaveBlock,
  CoopSaveRefusedError,
  checkSaveBlock,
  isCoopSaveBlock,
} from "#coop/save-block";
import { accountIdOf, checkSessionSaveBlock, endCoopSession, rewardPickerOf, startCoopSession } from "#coop/session";
import { afterEach, describe, expect, it } from "vitest";

const build: BuildIdentity = {
  protocolVersion: 1,
  gitSha: "x",
  dirtyHash: "clean",
  buildMode: "test",
  overridesHash: "0",
};

const account = (trainerId: number): AccountSnapshot => ({
  trainerId,
  secretId: 7,
  unlocked: { eviolite: false, miniBlackHole: false },
  caught: { 1: "1" },
  eggMoves: {},
});

function block(overrides: Partial<CoopSaveBlock> = {}): CoopSaveBlock {
  return {
    version: COOP_SAVE_VERSION,
    accountIds: { host: "h", guest: "g" },
    owners: { "10": "host", "20": "guest" },
    rewardPickCount: 3,
    trades: 2,
    accounts: { host: account(1), guest: account(2) },
    ...overrides,
  };
}

describe("coop save block (D4, D7, D9)", () => {
  it("survives JSON", () => {
    expect(isCoopSaveBlock(JSON.parse(JSON.stringify(block())))).toBe(true);
  });

  it.each([
    ["another version", { version: 1 }],
    ["no trade count", { trades: undefined }],
    ["a negative trade count", { trades: -1 }],
    ["no account ids", { accountIds: { host: "h" } }],
    ["a bad owner", { owners: { "1": "nobody" } }],
    ["a negative counter", { rewardPickCount: -1 }],
    ["a fractional counter", { rewardPickCount: 1.5 }],
    ["a bad snapshot", { accounts: { host: account(1) } }],
    ["timed events that are no names", { events: [7] }],
    ["met trainers that are no trainer types", { trainers: ["YOUNGSTER"] }],
    ["a negative met trainer", { trainers: [-1] }],
  ])("rejects a block with %s", (_name, change) => {
    expect(isCoopSaveBlock({ ...block(), ...change })).toBe(false);
  });
});

describe("checkSaveBlock", () => {
  const session = { accountIds: { host: "h", guest: "g" } };

  it("lets a solo save into solo play and a co-op save into its co-op session", () => {
    expect(() => checkSaveBlock(undefined, null)).not.toThrow();
    expect(() => checkSaveBlock(block(), session)).not.toThrow();
  });

  it("never continues a co-op save as a solo run, whatever the block holds", () => {
    expect(() => checkSaveBlock(block(), null)).toThrow(CoopSaveRefusedError);
    expect(() => checkSaveBlock(block(), null)).toThrow("co-op run");
    expect(() => checkSaveBlock({ junk: true }, null)).toThrow(CoopSaveRefusedError);
  });

  it("does not load a solo save into a co-op session", () => {
    expect(() => checkSaveBlock(undefined, session)).toThrow(CoopSaveRefusedError);
    expect(() => checkSaveBlock(null, session)).toThrow("solo run");
  });

  it("refuses a damaged block and a block of another pair of accounts", () => {
    expect(() => checkSaveBlock({ version: 1 }, session)).toThrow("damaged");
    expect(() => checkSaveBlock(block({ accountIds: { host: "h", guest: "someone else" } }), session)).toThrow(
      "two other players",
    );
    expect(() => checkSaveBlock(block({ accountIds: { host: "someone else", guest: "g" } }), session)).toThrow(
      CoopSaveRefusedError,
    );
  });

  it("a session that does not know its players yet accepts any pair", () => {
    expect(() => checkSaveBlock(block(), { accountIds: null })).not.toThrow();
  });

  it("says why, in a field the UI can use", () => {
    try {
      checkSaveBlock(block(), null);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CoopSaveRefusedError);
      expect((error as CoopSaveRefusedError).reason).toBe("coop-save-in-solo");
    }
  });
});

describe("the session and its save block", () => {
  afterEach(() => {
    endCoopSession();
  });

  const snapshot = { host: account(1), guest: account(2) };

  it("saves the owners of the party only, the counter and the snapshots, and loads them into another session", () => {
    const saving = startCoopSession({ seat: "host", runSeed: "s", build, accountSnapshot: snapshot });
    saving.ownership.set(10, "host");
    saving.ownership.set(20, "guest");
    saving.ownership.set(30, "guest"); // left the party
    saving.rewardPickCount = 5;
    saving.setTimedEvents(["Halloween 26"]);
    saving.noteTrainer(4);
    saving.noteTrainer(9);
    saving.noteTrainer(4);

    const saved = JSON.parse(JSON.stringify(saving.toSaveBlock([10, 20])));
    expect(saved.owners).toEqual({ "10": "host", "20": "guest" });
    expect(saved).toMatchObject({ version: COOP_SAVE_VERSION, rewardPickCount: 5, accounts: snapshot });
    expect(saved.accountIds).toEqual({ host: accountIdOf(snapshot.host), guest: accountIdOf(snapshot.guest) });
    endCoopSession();

    const loading = startCoopSession({ seat: "guest", runSeed: "s", build, accountSnapshot: snapshot });
    loading.restoreFromSaveBlock(saved);
    expect(loading.ownership.toJSON()).toEqual({ "10": "host", "20": "guest" });
    expect(loading.rewardPickCount).toBe(5);
    expect(loading.accountSnapshot).toEqual(snapshot);
    // the run keeps its timed events, even once the clock has them off (D33)
    expect(loading.timedEvents).toEqual(["Halloween 26"]);
    // and the trainers it has met (D34)
    expect(loading.metTrainers).toEqual([4, 9]);
    // the block has no seat: the host's save is what both clients load
    expect(loading.seat).toBe("guest");
  });

  it("loads a save of an earlier version, which has no timed events, as a run without one (D33)", () => {
    const old = block({ accountIds: { host: accountIdOf(snapshot.host), guest: accountIdOf(snapshot.guest) } });
    expect(old.events).toBeUndefined();
    const session = startCoopSession({ seat: "host", runSeed: "s", build, accountSnapshot: snapshot });
    session.setTimedEvents(["Halloween 26"]);
    session.noteTrainer(4);
    session.restoreFromSaveBlock(JSON.parse(JSON.stringify(old)));
    expect(session.timedEvents).toEqual([]);
    // nor the trainers it met (D34)
    expect(session.metTrainers).toEqual([]);
  });

  it("will not save a party member that has no owner", () => {
    const session = startCoopSession({ seat: "host", runSeed: "s", build, accountSnapshot: snapshot });
    session.ownership.set(1, "host");
    expect(() => session.toSaveBlock([1, 2])).toThrow("Pokémon 2 has no owner");
  });

  it("refuses the save of two other accounts", () => {
    const saving = startCoopSession({ seat: "host", runSeed: "s", build, accountSnapshot: snapshot });
    saving.ownership.set(1, "host");
    const saved = saving.toSaveBlock([1]);
    endCoopSession();

    const other = startCoopSession({
      seat: "host",
      runSeed: "s",
      build,
      accountSnapshot: { host: account(1), guest: account(99) },
    });
    expect(() => other.restoreFromSaveBlock(saved)).toThrow(CoopSaveRefusedError);
  });

  it("checkSessionSaveBlock follows the active session", () => {
    expect(() => checkSessionSaveBlock(undefined)).not.toThrow();
    expect(() => checkSessionSaveBlock(block())).toThrow("co-op run");
    startCoopSession({
      seat: "host",
      runSeed: "s",
      build,
      accountIds: { host: "h", guest: "g" },
    });
    expect(() => checkSessionSaveBlock(block())).not.toThrow(); // the same two accounts
    expect(() => checkSessionSaveBlock(block({ accountIds: { host: "h", guest: "x" } }))).toThrow("two other players");
    expect(() => checkSessionSaveBlock(undefined)).toThrow("solo run");
  });

  it("the picker of the reward screens alternates, host first, and a reroll is not a new screen", () => {
    expect([0, 1, 2, 3, 4].map(rewardPickerOf)).toEqual(["host", "guest", "host", "guest", "host"]);

    const session = startCoopSession({ seat: "host", runSeed: "s", build });
    expect(session.lastRewardPicker).toBe("host");
    expect(session.beginRewardScreen()).toEqual({ index: 0, picker: "host" });
    expect(session.lastRewardPicker).toBe("host");
    expect(session.beginRewardScreen()).toEqual({ index: 1, picker: "guest" });
    expect(session.lastRewardPicker).toBe("guest");
    expect(session.rewardPickCount).toBe(2);
  });
});
