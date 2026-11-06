/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { BuildIdentity } from "#coop/protocol";
import { noRoomQuestion } from "#coop/rules/catch-room";
import { endCoopSession, startCoopSession } from "#coop/session";
import i18next from "i18next";
import { afterEach, describe, expect, it } from "vitest";

const build: BuildIdentity = {
  protocolVersion: 1,
  gitSha: "a6995c571a092e762ea036589bb6f3a8fa4f5dbd",
  dirtyHash: "clean",
  buildMode: "test",
  overridesHash: "00000000000000",
};

/**
 * The question of a catch there is no room for (D10, D40). A player's report: "the game thought I had a full party at 5
 * Pokémon": a player at the cap of their own was told the party was full.
 */
describe("Co-op: the question of a catch with no room", () => {
  afterEach(() => {
    endCoopSession();
  });

  const partyFull = (name: string) => i18next.t("battle:partyFull", { pokemonName: name });

  it("is 'the party is full' in solo play", () => {
    expect(noRoomQuestion(null, "Rookidee", 6)).toBe(partyFull("Rookidee"));
  });

  it("says the player has their three when the party has room", () => {
    startCoopSession({ seat: "host", runSeed: "abc", build });
    expect(noRoomQuestion("host", "Rookidee", 5)).toBe(
      "You already have 3 Pokémon of your own.\nRelease one to make room for Rookidee?",
    );
    expect(noRoomQuestion("guest", "Rookidee", 4)).toContain("You already have 3 Pokémon of your own.");
  });

  it("says two in a game of three", () => {
    startCoopSession({ seat: "guest2", runSeed: "abc", build, players: 3 });
    expect(noRoomQuestion("guest2", "Rookidee", 5)).toBe(
      "You already have 2 Pokémon of your own.\nRelease one to make room for Rookidee?",
    );
  });

  it("is 'the party is full' in co-op when it is (a gift can leave one player with fewer than the cap)", () => {
    startCoopSession({ seat: "host", runSeed: "abc", build });
    expect(noRoomQuestion("host", "Rookidee", 6)).toBe(partyFull("Rookidee"));
  });
});
