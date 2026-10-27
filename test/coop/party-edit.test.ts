/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { checkDecisionLegal } from "#coop/legal";
import { checkPartyEdit, isPartyEdit, type PartyMemberView, pokemonOfEdit } from "#coop/party-edit";
import { takeoverPlan } from "#coop/takeover";
import { describe, expect, it } from "vitest";
import { key, view } from "./legal-fixtures";

/** Party edits on the reward screen (DECISIONS D28): what an edit looks like, and who may make which */

/** Host: 1, 3, 5; guest: 2, 4. Pokémon 3 is fused, 4 holds form item 7, 6 is nobody's. 5 does not evolve. */
const PARTY: PartyMemberView[] = [
  { id: 1, owner: "host", fused: false, formItems: [], evolves: true },
  { id: 2, owner: "guest", fused: false, formItems: [], evolves: true },
  { id: 3, owner: "host", fused: true, formItems: [], evolves: true },
  { id: 4, owner: "guest", fused: false, formItems: [7], evolves: true },
  { id: 5, owner: "host", fused: false, formItems: [], evolves: false },
];

describe("a party edit", () => {
  it.each([
    { k: "swap", a: 1, b: 3 },
    { k: "release", pokemonId: 1 },
    { k: "rename", pokemonId: 1, nickname: "Um9ja3k=" },
    { k: "rename", pokemonId: 1, nickname: "" },
    { k: "evolution", pokemonId: 1, paused: true },
    { k: "formItem", pokemonId: 4, item: 7, active: true },
    { k: "unsplice", pokemonId: 3 },
  ])("reads %o", edit => {
    expect(isPartyEdit(edit)).toBe(true);
  });

  it.each<unknown>([
    null,
    { k: "swap", a: 1 },
    { k: "swap", a: 1, b: -2 },
    { k: "release", pokemonId: 1.5 },
    { k: "rename", pokemonId: 1, nickname: "<script>" },
    { k: "rename", pokemonId: 1, nickname: "A".repeat(97) },
    { k: "evolution", pokemonId: 1, paused: "yes" },
    { k: "formItem", pokemonId: 4, item: 7 },
    { k: "teleport", pokemonId: 1 },
  ])("drops %o", edit => {
    expect(isPartyEdit(edit)).toBe(false);
  });

  it("names the Pokémon it changes", () => {
    expect(pokemonOfEdit({ k: "swap", a: 1, b: 3 })).toEqual([1, 3]);
    expect(pokemonOfEdit({ k: "release", pokemonId: 5 })).toEqual([5]);
  });
});

describe("who may make which edit", () => {
  it("a player changes their own Pokémon", () => {
    expect(checkPartyEdit({ k: "swap", a: 1, b: 3 }, "host", PARTY)).toBeNull();
    expect(checkPartyEdit({ k: "rename", pokemonId: 2, nickname: "" }, "guest", PARTY)).toBeNull();
    expect(checkPartyEdit({ k: "unsplice", pokemonId: 3 }, "host", PARTY)).toBeNull();
    expect(checkPartyEdit({ k: "formItem", pokemonId: 4, item: 7, active: true }, "guest", PARTY)).toBeNull();
  });

  it("never the partner's, not even in a swap with one of their own", () => {
    expect(checkPartyEdit({ k: "release", pokemonId: 2 }, "host", PARTY)).toMatch(/partner's/);
    expect(checkPartyEdit({ k: "swap", a: 1, b: 2 }, "host", PARTY)).toMatch(/partner's/);
    expect(checkPartyEdit({ k: "rename", pokemonId: 1, nickname: "" }, "guest", PARTY)).toMatch(/partner's/);
  });

  it("keeps the player's last Pokémon", () => {
    expect(checkPartyEdit({ k: "release", pokemonId: 2 }, "guest", PARTY)).toBeNull();
    const oneLeft = PARTY.filter(member => member.id !== 4);
    expect(checkPartyEdit({ k: "release", pokemonId: 2 }, "guest", oneLeft)).toMatch(/last/);
  });

  it("refuses what makes no sense for that Pokémon", () => {
    expect(checkPartyEdit({ k: "swap", a: 1, b: 1 }, "host", PARTY)).toMatch(/itself/);
    expect(checkPartyEdit({ k: "unsplice", pokemonId: 1 }, "host", PARTY)).toMatch(/not fused/);
    expect(checkPartyEdit({ k: "formItem", pokemonId: 4, item: 8, active: true }, "guest", PARTY)).toMatch(/hold/);
    expect(checkPartyEdit({ k: "evolution", pokemonId: 5, paused: true }, "host", PARTY)).toMatch(/none/);
    expect(checkPartyEdit({ k: "release", pokemonId: 9 }, "host", PARTY)).toMatch(/not in the party/);
    expect(checkPartyEdit({ k: "release" }, "host", PARTY)).toMatch(/cannot be read/);
  });

  it("is checked as a sequenced decision on both clients (D24), and nobody takes it over", () => {
    expect(checkDecisionLegal(view(), key("PARTY_EDIT", "0:0"), { k: "swap", a: 1, b: 3 }, "host")).toBeNull();
    expect(checkDecisionLegal(view(), key("PARTY_EDIT", "0:0"), { k: "release", pokemonId: 2 }, "host")).toMatch(
      /partner's/,
    );
    expect(takeoverPlan({ kind: "PARTY_EDIT", ref: "0:0" })).toEqual({ mode: "payload", payload: null });
  });
});
