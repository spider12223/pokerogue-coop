/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { speciesDataRegistry } from "#app/global-species-data-registry";
import { endCoopSession, startCoopSession } from "#coop/session";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Nincada's evolution adds a Shedinja to the party. In co-op it is the Nincada owner's, within their cap of three (D10):
 * without an owner the next wave's arrange step and the wave-start save threw, and the run froze.
 */

const BUILD = { protocolVersion: 1, gitSha: "x", dirtyHash: "clean", buildMode: "test", overridesHash: "0" } as const;

describe("Co-op: Nincada's Shedinja (D10)", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override.battleStyle("double").moveset([MoveId.SPLASH]).enemyMoveset(MoveId.SPLASH);
  });

  afterEach(() => {
    endCoopSession();
  });

  /** Nincada evolves into Ninjask */
  async function evolveNincada(): Promise<void> {
    const nincada = game.scene.getPlayerParty().find(member => member.species.speciesId === SpeciesId.NINCADA)!;
    const ninjask = speciesDataRegistry
      .getEvolutions(SpeciesId.NINCADA)
      .find(evo => evo.speciesId === SpeciesId.NINJASK);
    await nincada.evolve(ninjask ?? null, nincada.species);
  }

  it("belongs to the Nincada's owner", async () => {
    await game.classicMode.startBattle(SpeciesId.NINCADA, SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER);
    const session = startCoopSession({ seat: "host", runSeed: "seed", build: BUILD });
    const [nincada, squirtle, charmander] = game.scene.getPlayerParty();
    session.ownership.set(nincada.id, "guest");
    session.ownership.set(squirtle.id, "host");
    session.ownership.set(charmander.id, "host");

    await evolveNincada();

    const shedinja = game.scene.getPlayerParty().find(member => member.species.speciesId === SpeciesId.SHEDINJA);
    expect(shedinja).toBeDefined();
    expect(session.ownership.get(shedinja!.id)).toBe("guest");
  });

  it("is not added when its owner has three already", async () => {
    await game.classicMode.startBattle(SpeciesId.NINCADA, SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER);
    const session = startCoopSession({ seat: "host", runSeed: "seed", build: BUILD });
    for (const member of game.scene.getPlayerParty()) {
      session.ownership.set(member.id, "host");
    }

    await evolveNincada();

    expect(game.scene.getPlayerParty().some(member => member.species.speciesId === SpeciesId.SHEDINJA)).toBe(false);
    expect(game.scene.getPlayerParty()).toHaveLength(3);
  });
});
