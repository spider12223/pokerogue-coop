/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Seat } from "#coop/protocol";
import { type ArrangeMember, arrangeOrder } from "#coop/rules/arrange-plan";
import { describe, expect, it } from "vitest";

/** "h1 g1 h2! k1" is the host's 1, the guest's 1, the host's 2 (fainted: the `!`), the second guest's 1 */
function party(spec: string): ArrangeMember[] {
  return spec.split(" ").map(token => {
    const fainted = token.endsWith("!");
    const name = fainted ? token.slice(0, -1) : token;
    const owner: Seat = name.startsWith("h") ? "host" : name.startsWith("g") ? "guest" : "guest2";
    const base = owner === "host" ? 100 : owner === "guest" ? 200 : 300;
    return { id: Number(name.slice(1)) + base, legal: !fainted, owner };
  });
}

/** The order as the names of the spec */
function names(order: readonly number[]): string {
  return order.map(id => (id >= 300 ? `k${id - 300}` : id >= 200 ? `g${id - 200}` : `h${id - 100}`)).join(" ");
}

describe("arrangeOrder (D7)", () => {
  it.each([
    ["each seat's first legal Pokémon takes its slot", "h1 g1 h2 g2", "h1 g1 h2 g2"],
    ["the slots are the first legal of each seat, whatever the order", "g1 g2 h1 h2", "h1 g1 g2 h2"],
    ["fainted Pokémon do not take a slot", "h1! g1 h2 g2!", "h2 g1 h1 g2"],
    ["the host's fainted lead gives way to its next legal Pokémon", "h1! h2 g1", "h2 g1 h1"],
    [
      "a seat with none is covered by the partner's next legal Pokémon (the partner's first is in its own slot)",
      "h1! h2! g1 g2 g3",
      "g2 g1 h1 h2 g3",
    ],
    ["the guest wiped: the host covers both slots", "h1 g1! h2 h3", "h1 h2 g1 h3"],
    ["a seat with none and the partner with one: that one is alone in front", "h1! g1 g2!", "g1 h1 g2"],
    ["nobody is legal: the order does not change", "h1! g1! h2!", "h1 g1 h2"],
    ["the rest keep their relative order", "h3 g3 g2 h2 h1 g1", "h3 g3 g2 h2 h1 g1"],
  ])("%s", (_name, before, after) => {
    expect(names(arrangeOrder(party(before)))).toBe(after);
  });

  it("is deterministic and idempotent: arranging an arranged party changes nothing", () => {
    const first = arrangeOrder(party("g1 h1! g2 h2 h3 g3!"));
    const arranged = first.map(id => party("g1 h1! g2 h2 h3 g3!").find(m => m.id === id)!);
    expect(arrangeOrder(arranged)).toEqual(first);
    expect(arrangeOrder(party("g1 h1! g2 h2 h3 g3!"))).toEqual(first);
  });

  it("returns every Pokémon exactly once", () => {
    const members = party("g1 h1! g2 h2 h3 g3!");
    const order = arrangeOrder(members);
    expect([...order].sort()).toEqual(members.map(m => m.id).sort());
  });

  it.each([
    ["each of the three seats' first legal Pokémon takes its slot", "h1 h2 g1 g2 k1 k2", "h1 g1 k1 h2 g2 k2"],
    ["the second guest has none: the host, next in order, covers its slot", "h1 h2 g1 g2 k1! k2!", "h1 g1 h2 g2 k1 k2"],
    [
      "the guest has none: the second guest, next in order, covers its slot",
      "h1 h2 g1! g2! k1 k2",
      "h1 k2 k1 h2 g1 g2",
    ],
    ["the host has none: the guest, next in order, covers its slot", "h1! g1 g2 k1 k2", "g2 g1 k1 h1 k2"],
    ["only one seat has Pokémon: they fill the slots in order", "h1! g1 g2 g3 k1!", "g2 g1 g3 h1 k1"],
  ])("in a game of three (D40): %s", (_name, before, after) => {
    expect(names(arrangeOrder(party(before), ["host", "guest", "guest2"]))).toBe(after);
  });

  it("an empty party stays empty", () => {
    expect(arrangeOrder([])).toEqual([]);
  });
});
