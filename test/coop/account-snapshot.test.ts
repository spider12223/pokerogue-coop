/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { type AccountSnapshot, isAccountSnapshot, isCoopAccountSnapshot } from "#coop/account-snapshot";
import { describe, expect, it } from "vitest";

const account: AccountSnapshot = {
  trainerId: 12345,
  secretId: 54321,
  unlocked: { eviolite: true, miniBlackHole: false },
  caught: { 1: "255", 25: "9223372036854775807" },
  eggMoves: { 1: 5, 4: 15 },
};

describe("AccountSnapshot", () => {
  it("survives JSON (no bigint, no Map)", () => {
    expect(JSON.parse(JSON.stringify(account))).toEqual(account);
    expect(isAccountSnapshot(JSON.parse(JSON.stringify(account)))).toBe(true);
  });

  it("accepts an empty account", () => {
    expect(
      isAccountSnapshot({
        trainerId: 0,
        secretId: 0,
        unlocked: { eviolite: false, miniBlackHole: false },
        caught: {},
        eggMoves: {},
      }),
    ).toBe(true);
  });

  it.each([
    ["a missing trainer id", { ...account, trainerId: undefined }],
    ["a fractional secret id", { ...account, secretId: 1.5 }],
    ["a missing unlock", { ...account, unlocked: { eviolite: true } }],
    ["a caughtAttr that is a number", { ...account, caught: { 1: 255 } }],
    ["a caughtAttr of zero", { ...account, caught: { 1: "0" } }],
    ["a caughtAttr that is not decimal", { ...account, caught: { 1: "0xff" } }],
    ["a species key that is not a number", { ...account, caught: { pikachu: "1" } }],
    ["a zero egg move mask", { ...account, eggMoves: { 1: 0 } }],
    ["an array as the dex", { ...account, caught: ["1"] }],
    ["null", null],
  ])("rejects %s", (_name, value) => {
    expect(isAccountSnapshot(value)).toBe(false);
  });

  it("a co-op snapshot needs both accounts", () => {
    expect(isCoopAccountSnapshot({ host: account, guest: account })).toBe(true);
    expect(isCoopAccountSnapshot({ host: account })).toBe(false);
    expect(isCoopAccountSnapshot({ host: account, guest: { ...account, trainerId: "1" } })).toBe(false);
  });
});
