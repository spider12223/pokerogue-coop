/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { coopRunNames, coopStatLabel } from "#coop/labels";
import { describe, expect, it } from "vitest";

/** The words of the co-op rows in upstream's screens */
describe("coopRunNames", () => {
  it("names the two players of a run", () => {
    expect(coopRunNames({ host: "Sam", guest: "Alex" })).toBe("Sam & Alex");
  });

  it("cuts a pair of long names to the line of the list", () => {
    const text = coopRunNames({ host: "A".repeat(20), guest: "B".repeat(20) });
    expect(text).toHaveLength(24);
    expect(text.endsWith("…")).toBe(true);
    expect(coopRunNames({ host: "Sam", guest: "Alex" }, 6)).toBe("Sam &…");
  });
});

describe("coopStatLabel", () => {
  it("names the co-op row of the stats screen in English, and leaves the others to upstream's texts", () => {
    expect(coopStatLabel("coopWins")).toEqual({ defaultValue: "Co-op Clears" });
    expect(coopStatLabel("classicWins")).toEqual({});
    expect(coopStatLabel(undefined)).toEqual({});
  });
});
