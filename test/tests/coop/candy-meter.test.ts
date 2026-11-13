/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { loggedInUser } from "#app/account";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { getStarterValueFriendshipCap } from "#balance/starters";
import { ownerOf } from "#coop/decisions/control";
import { SpeciesId } from "#enums/species-id";
import { advanceTo } from "#test/helpers/coop-harness";
import { type LinkedRun, openLinkedRun, pickerSkips, winWave } from "#test/helpers/coop-linked";
import { decrypt } from "#utils/data";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A player's report (GitHub issue #2): in co-op, after a Pokémon earns a candy, its candy meter went back to what it was
 * when the run started instead of starting again; solo play was right. Each player's own Pokémon fills their own meter
 * (D4a), and the meter starts again after a candy, in play and in the account saved at the next wave start.
 */
describe("Co-op: the candy meter after a candy", () => {
  let phaserGame: Phaser.Game;
  let run: LinkedRun | null = null;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    run?.close();
    run = null;
    vi.restoreAllMocks();
  });

  it.each(["host", "guest"] as const)(
    "the %s's Pokémon earns a candy in a wave: its meter starts again, in play and in the saved account",
    async seat => {
      const r = await openLinkedRun(phaserGame, {
        seat,
        species: [SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER, SpeciesId.PIKACHU],
        starterOwners: ["host", "guest", "host", "guest"],
        configure: game => game.override.startingLevel(40),
        policy: { auto: ["TURN_COMMANDS", "LEARN_MOVE", "EVOLUTION_CANCEL"] },
      });
      run = r;
      const { game } = r.ctx;
      const mine = game.scene.getPlayerField().find(pokemon => ownerOf(pokemon) === seat)!;
      const root = mine.species.getRootSpeciesId();
      const cap = getStarterValueFriendshipCap(speciesDataRegistry.getStarterCost(root));
      const entry = () => game.scene.gameData.starterData[root];
      // The report: a meter almost full when the run starts; the wave's friendship fills it
      const start = cap - 2;
      entry().friendship = start;
      const candies = entry().candyCount;

      // The next wave start saves the account
      if (await winWave(r)) {
        pickerSkips(r);
      }
      await advanceTo(r.ctx, ["CommandPhase"]);

      expect(entry().candyCount).toBe(candies + 1);
      expect(entry().friendship).toBeLessThan(start);
      const saved = JSON.parse(decrypt(localStorage.getItem(`data_${loggedInUser?.username}`)!, true));
      expect(saved.starterData[root]).toMatchObject({ candyCount: candies + 1, friendship: entry().friendship });
      expect(r.session.desyncMessage).toBeNull();
    },
    5 * 60_000,
  );
});
