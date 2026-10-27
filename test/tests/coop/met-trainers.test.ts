/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { endCoopSession, startCoopSession } from "#coop/session";
import { computeStateHash } from "#coop/state-hash";
import { BiomeId } from "#enums/biome-id";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { TrainerType } from "#enums/trainer-type";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/** The biome's trainer pick of a co-op run leaves out the trainers the run has met (DECISIONS D34) */

const BUILD = { protocolVersion: 1, gitSha: "x", dirtyHash: "clean", buildMode: "test", overridesHash: "0" } as const;

describe("Co-op: the trainer pick of a run (D34)", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override
      .battleStyle("double")
      .startingBiome(BiomeId.CAVE)
      .startingWave(12)
      .moveset([MoveId.SPLASH])
      .enemyMoveset(MoveId.SPLASH);
  });

  afterEach(() => {
    endCoopSession();
  });

  /** The trainers of twenty picks of the cave at this wave */
  function picks(): TrainerType[] {
    const { arena } = game.scene;
    return Array.from({ length: 20 }, () => arena.randomTrainerType(12));
  }

  it("picks a trainer the run has not met while the biome has one; solo play picks as upstream", async () => {
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    game.scene.resetSeed(12);
    const solo = picks();
    expect(solo).toContain(TrainerType.HIKER);

    const session = startCoopSession({ seat: "host", runSeed: "seed", build: BUILD });
    session.noteTrainer(TrainerType.HIKER);
    game.scene.resetSeed(12);
    const coop = picks();
    expect(coop).not.toContain(TrainerType.HIKER);
    // the same draws: where solo play had another trainer, the run has it too
    for (const [i, type] of solo.entries()) {
      if (type !== TrainerType.HIKER) {
        expect(coop[i]).toBe(type);
      }
    }
  });

  it("is part of the state hash, so two clients that disagree on it are caught", async () => {
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    const session = startCoopSession({ seat: "host", runSeed: "seed", build: BUILD });
    const base = computeStateHash();
    session.noteTrainer(TrainerType.HIKER);
    expect(computeStateHash()).not.toBe(base);
  });
});
