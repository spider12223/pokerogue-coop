/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defaultStarterOwners, isOwnerRecord, OwnerMap, STARTERS_PER_SEAT } from "#coop/ownership";
import { describe, expect, it } from "vitest";

describe("OwnerMap (D7)", () => {
  it("knows who owns what, and nothing about what it was not told", () => {
    const owners = new OwnerMap();
    owners.set(10, "host");
    owners.set(20, "guest");
    expect(owners.get(10)).toBe("host");
    expect(owners.get(20)).toBe("guest");
    expect(owners.get(30)).toBeUndefined();
    expect(owners.has(10)).toBe(true);
    expect(owners.has(30)).toBe(false);
    expect(owners.partnerOf(10)).toBe("guest");
    expect(owners.partnerOf(30)).toBeUndefined();
  });

  it("require throws for a Pokémon without an owner", () => {
    const owners = new OwnerMap();
    owners.set(1, "guest");
    expect(owners.require(1)).toBe("guest");
    expect(() => owners.require(2)).toThrow("Pokémon 2 has no owner");
  });

  it("a trade or a catch is a set: ownership moves, nothing else changes", () => {
    const owners = new OwnerMap();
    owners.set(1, "host");
    owners.set(2, "guest");
    owners.set(1, "guest");
    expect(owners.toJSON()).toEqual({ "1": "guest", "2": "guest" });
  });

  it("counts what a seat owns among some Pokémon", () => {
    const owners = new OwnerMap();
    [1, 2, 3].forEach(id => owners.set(id, "host"));
    [4, 5].forEach(id => owners.set(id, "guest"));
    expect(owners.countOwned([1, 2, 4, 99], "host")).toBe(2);
    expect(owners.countOwned([1, 2, 4, 99], "guest")).toBe(1);
  });

  it("keeps only the Pokémon that are still in the party", () => {
    const owners = new OwnerMap();
    [1, 2, 3].forEach(id => owners.set(id, "host"));
    owners.retain([2, 3, 4]);
    expect(owners.toJSON()).toEqual({ "2": "host", "3": "host" });
  });

  it("serializes with the ids in ascending order, whatever the order they were set in", () => {
    const a = new OwnerMap();
    a.set(30, "host");
    a.set(4, "guest");
    a.set(1000, "host");
    const b = new OwnerMap();
    b.set(1000, "host");
    b.set(30, "host");
    b.set(4, "guest");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a.toJSON())).toEqual(["4", "30", "1000"]);
  });

  it("loads what it saved", () => {
    const a = new OwnerMap();
    a.set(7, "guest");
    a.set(8, "host");
    const b = new OwnerMap();
    b.set(99, "host");
    b.load(JSON.parse(JSON.stringify(a)));
    expect(b.toJSON()).toEqual(a.toJSON());
    expect(b.has(99)).toBe(false);
  });
});

describe("starter ownership", () => {
  it("is three each, the host's first", () => {
    expect(STARTERS_PER_SEAT).toBe(3);
    expect(defaultStarterOwners()).toEqual(["host", "host", "host", "guest", "guest", "guest"]);
    expect(defaultStarterOwners(1)).toEqual(["host", "guest"]);
  });
});

describe("isOwnerRecord", () => {
  it("accepts ids mapped to seats and rejects the rest", () => {
    expect(isOwnerRecord({})).toBe(true);
    expect(isOwnerRecord({ "12": "host", "13": "guest" })).toBe(true);
    expect(isOwnerRecord({ "12": "both" })).toBe(false);
    expect(isOwnerRecord({ x: "host" })).toBe(false);
    expect(isOwnerRecord({ "-1": "host" })).toBe(false);
    expect(isOwnerRecord([["12", "host"]])).toBe(false);
    expect(isOwnerRecord(null)).toBe(false);
  });
});
