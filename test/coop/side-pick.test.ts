/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { sidePickKey } from "#coop/decision-keys";
import { checkDecisionLegal } from "#coop/legal";
import { takeoverPlan } from "#coop/takeover";
import { isSidePickPayload } from "#coop/turn-commands";
import { describe, expect, it } from "vitest";
import { key, view } from "./legal-fixtures";

/** Both players chose a Ball or a Run in the same turn: the host picks the one that happens (DECISIONS D8) */

describe("the pick of a side action", () => {
  it("is one per turn", () => {
    expect(sidePickKey(12, 3)).toEqual({ wave: 12, turn: 3, kind: "SIDE_PICK", ref: -1 });
  });

  it.each([{ pokemonId: 0 }, { pokemonId: 41 }])("reads %o", payload => {
    expect(isSidePickPayload(payload)).toBe(true);
  });

  it.each<unknown>([null, {}, { pokemonId: -1 }, { pokemonId: 1.5 }, { pokemonId: "41" }, { accept: true }])(
    "drops %o",
    payload => {
      expect(isSidePickPayload(payload)).toBe(false);
    },
  );

  it("picks one of the Pokémon that chose a Ball or a Run, on both clients (D24)", () => {
    const both = view({ sidePick: () => [1, 2] });
    expect(checkDecisionLegal(both, key("SIDE_PICK", -1, 3), { pokemonId: 2 }, "host")).toBeNull();
    expect(checkDecisionLegal(both, key("SIDE_PICK", -1, 3), { pokemonId: 3 }, "host")).toMatch(/chose no Ball or Run/);
    expect(checkDecisionLegal(view(), key("SIDE_PICK", -1, 3), { pokemonId: 1 }, "host")).toMatch(/nobody has two/);
    expect(checkDecisionLegal(both, key("SIDE_PICK", -1, 3), { accept: true }, "host")).toMatch(/cannot be read/);
  });

  it("is taken over with the host's menu (D17)", () => {
    expect(takeoverPlan({ kind: "SIDE_PICK", ref: -1 })).toEqual({ mode: "ask" });
  });
});
