/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createCoopGameMode } from "#app/game-mode";
import { Challenges } from "#enums/challenges";
import { GameModes } from "#enums/game-modes";
import { PokemonType } from "#enums/pokemon-type";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Co-op challenge runs (DECISIONS D41): a co-op Classic run with the host's challenges on, on every client.
 */

describe("Co-op challenge runs (D41)", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    new GameManager(phaserGame);
  });

  it("is a co-op Classic run with the challenges the host chose", () => {
    const mode = createCoopGameMode(GameModes.CHALLENGE, [
      { id: Challenges.SINGLE_TYPE, value: PokemonType.FIRE + 1, severity: 0 },
      { id: Challenges.INVERSE_BATTLE, value: 1, severity: 0 },
    ]);
    expect(mode.modeId).toBe(GameModes.CHALLENGE);
    expect(mode).toMatchObject({ isCoop: true, isClassic: true, isChallenge: true, hasTrainers: true });
    expect(mode.hasChallenge(Challenges.SINGLE_TYPE)).toBe(true);
    expect(mode.hasChallenge(Challenges.INVERSE_BATTLE)).toBe(true);
    expect(mode.hasChallenge(Challenges.FRESH_START)).toBe(false);
    expect(mode.challenges.find(c => c.id === Challenges.SINGLE_TYPE)?.value).toBe(PokemonType.FIRE + 1);
  });

  it("keeps a value within the challenge's range, whatever came over the wire", () => {
    const mode = createCoopGameMode(GameModes.CHALLENGE, [
      { id: Challenges.INVERSE_BATTLE, value: 200, severity: 0 },
      { id: 250, value: 1, severity: 0 },
    ]);
    const inverse = mode.challenges.find(c => c.id === Challenges.INVERSE_BATTLE)!;
    expect(inverse.value).toBe(inverse.maxValue);
  });

  it("without challenges (a save restores them itself) is a challenge run with none on yet", () => {
    const mode = createCoopGameMode(GameModes.CHALLENGE);
    expect(mode.modeId).toBe(GameModes.CHALLENGE);
    expect(mode.isChallenge).toBe(true);
    expect(mode.challenges.some(c => c.value !== 0)).toBe(false);
  });
});
