/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { checkDecisionLegal } from "#coop/legal";
import { checkMeChoice, isMeChoice, isMeChoiceOf, meChoiceKey } from "#coop/me-choice";
import { takeoverPlan } from "#coop/takeover";
import { describe, expect, it } from "vitest";
import { key, view } from "./legal-fixtures";

/** The choices of a Mystery Encounter as sequenced decisions (DECISIONS D29): what they look like, and what answers what */

describe("an encounter choice", () => {
  it.each([
    { k: "option", index: 2 },
    { k: "pokemon", pokemonId: 41 },
    { k: "pokemon", pokemonId: null },
    { k: "sub", index: 0 },
    { k: "sub", index: null },
    { k: "optionPokemon", index: 1, pokemonId: 41 },
    { k: "optionPokemon", index: null, pokemonId: null },
    { k: "confirm", yes: false },
    { k: "who", seat: "guest" },
    { k: "who", seat: null },
  ])("reads %o", choice => {
    expect(isMeChoice(choice)).toBe(true);
  });

  it.each<unknown>([
    null,
    { k: "option" },
    { k: "option", index: -1 },
    { k: "pokemon", pokemonId: "41" },
    { k: "sub", index: 1.5 },
    { k: "confirm", yes: "yes" },
    { k: "who", seat: "both" },
    { k: "dance" },
  ])("drops %o", choice => {
    expect(isMeChoice(choice)).toBe(false);
  });

  it("is keyed by the encounter decisions of the wave", () => {
    expect(meChoiceKey(23, 4)).toEqual({ wave: 23, turn: 0, kind: "ME_CHOICE", ref: "4" });
    expect(isMeChoiceOf("option")({ k: "option", index: 0 })).toBe(true);
    expect(isMeChoiceOf("option")({ k: "sub", index: 0 })).toBe(false);
  });
});

describe("what answers the open question (D24)", () => {
  it("an option that can be chosen", () => {
    const question = { k: "option", enabled: [true, false, true] } as const;
    expect(checkMeChoice({ k: "option", index: 2 }, question)).toBeNull();
    expect(checkMeChoice({ k: "option", index: 1 }, question)).toMatch(/cannot be chosen/);
    expect(checkMeChoice({ k: "option", index: 3 }, question)).toMatch(/cannot be chosen/);
  });

  it("one of the chooser's Pokémon that the encounter allows, or going back", () => {
    const question = { k: "pokemon", pokemon: [1, 3] } as const;
    expect(checkMeChoice({ k: "pokemon", pokemonId: 3 }, question)).toBeNull();
    expect(checkMeChoice({ k: "pokemon", pokemonId: null }, question)).toBeNull();
    expect(checkMeChoice({ k: "pokemon", pokemonId: 2 }, question)).toMatch(/may not be chosen/);
  });

  it("an entry, then a Pokémon; both or neither", () => {
    const question = { k: "optionPokemon", enabled: [true, true], pokemon: [5] } as const;
    expect(checkMeChoice({ k: "optionPokemon", index: 1, pokemonId: 5 }, question)).toBeNull();
    expect(checkMeChoice({ k: "optionPokemon", index: null, pokemonId: null }, question)).toBeNull();
    expect(checkMeChoice({ k: "optionPokemon", index: 1, pokemonId: null }, question)).toMatch(/half/);
    expect(checkMeChoice({ k: "optionPokemon", index: 1, pokemonId: 4 }, question)).toMatch(/may not be chosen/);
  });

  it("a player who has enough Pokémon goes, or nobody", () => {
    const question = { k: "who", seats: ["guest"] } as const;
    expect(checkMeChoice({ k: "who", seat: "guest" }, question)).toBeNull();
    expect(checkMeChoice({ k: "who", seat: null }, question)).toBeNull();
    expect(checkMeChoice({ k: "who", seat: "host" }, question)).toMatch(/cannot go/);
  });

  it("an answer of another kind, or when nothing is asked, is not one", () => {
    expect(checkMeChoice({ k: "confirm", yes: true }, { k: "option", enabled: [true] })).toMatch(/another kind/);
    expect(checkMeChoice({ k: "confirm", yes: true }, null)).toMatch(/no encounter asks/);
  });

  it("is checked as a sequenced decision on both clients, and taken over with the chooser's screens (D17)", () => {
    const asked = view({ meQuestion: () => ({ k: "option", enabled: [false, true] }) });
    expect(checkDecisionLegal(asked, key("ME_CHOICE", "0"), { k: "option", index: 1 }, "host")).toBeNull();
    expect(checkDecisionLegal(asked, key("ME_CHOICE", "0"), { k: "option", index: 0 }, "host")).toMatch(
      /cannot be chosen/,
    );
    expect(takeoverPlan({ kind: "ME_CHOICE", ref: "0" })).toEqual({ mode: "ask" });
  });
});
