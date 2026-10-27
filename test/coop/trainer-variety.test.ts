/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { endCoopSession, startCoopSession } from "#coop/session";
import { noteTrainerMet, unmetTrainerPool } from "#coop/trainer-variety";
import { BiomePoolTier } from "#enums/biome-pool-tier";
import { TrainerType } from "#enums/trainer-type";
import type { TrainerPools } from "#types/biomes";
import { afterEach, describe, expect, it } from "vitest";

/** A co-op run's next trainer is one it has not met while the biome has one (DECISIONS D34) */

const BUILD = { protocolVersion: 1, gitSha: "x", dirtyHash: "clean", buildMode: "test", overridesHash: "0" } as const;

// A cave: two common trainers, four uncommon ones, three gym leaders
const CAVE: TrainerPools = {
  [BiomePoolTier.COMMON]: [TrainerType.BACKPACKER, TrainerType.HIKER],
  [BiomePoolTier.UNCOMMON]: [
    TrainerType.ACE_TRAINER,
    TrainerType.BLACK_BELT,
    TrainerType.COLLECTOR,
    TrainerType.RUIN_MANIAC,
  ],
  [BiomePoolTier.RARE]: [],
  [BiomePoolTier.SUPER_RARE]: [],
  [BiomePoolTier.ULTRA_RARE]: [],
  [BiomePoolTier.BOSS]: [TrainerType.BROCK, TrainerType.ROXANNE, TrainerType.ROARK],
  [BiomePoolTier.BOSS_RARE]: [],
  [BiomePoolTier.BOSS_SUPER_RARE]: [],
  [BiomePoolTier.BOSS_ULTRA_RARE]: [],
};

describe("Co-op: trainers the run has met (D34)", () => {
  afterEach(() => {
    endCoopSession();
  });

  it("changes nothing in solo play", () => {
    noteTrainerMet(TrainerType.HIKER);
    expect(unmetTrainerPool(CAVE, BiomePoolTier.COMMON)).toBeNull();
  });

  it("leaves out the trainers the run has met", () => {
    startCoopSession({ seat: "host", runSeed: "seed", build: BUILD });
    expect(unmetTrainerPool(CAVE, BiomePoolTier.COMMON)).toEqual([TrainerType.BACKPACKER, TrainerType.HIKER]);
    noteTrainerMet(TrainerType.HIKER);
    expect(unmetTrainerPool(CAVE, BiomePoolTier.COMMON)).toEqual([TrainerType.BACKPACKER]);
    noteTrainerMet(TrainerType.BLACK_BELT);
    expect(unmetTrainerPool(CAVE, BiomePoolTier.UNCOMMON)).toEqual([
      TrainerType.ACE_TRAINER,
      TrainerType.COLLECTOR,
      TrainerType.RUIN_MANIAC,
    ]);
  });

  it("goes down a tier when the run has met all of the tier drawn, and repeats only when it met them all", () => {
    startCoopSession({ seat: "guest", runSeed: "seed", build: BUILD });
    for (const type of CAVE[BiomePoolTier.UNCOMMON]) {
      noteTrainerMet(type);
    }
    expect(unmetTrainerPool(CAVE, BiomePoolTier.UNCOMMON)).toEqual([TrainerType.BACKPACKER, TrainerType.HIKER]);
    noteTrainerMet(TrainerType.BACKPACKER);
    noteTrainerMet(TrainerType.HIKER);
    // the caller then picks from the whole tier, as upstream
    expect(unmetTrainerPool(CAVE, BiomePoolTier.UNCOMMON)).toBeNull();
  });

  it("gives a gym leader for a gym leader", () => {
    startCoopSession({ seat: "host", runSeed: "seed", build: BUILD });
    noteTrainerMet(TrainerType.BROCK);
    expect(unmetTrainerPool(CAVE, BiomePoolTier.BOSS)).toEqual([TrainerType.ROXANNE, TrainerType.ROARK]);
    noteTrainerMet(TrainerType.ROXANNE);
    noteTrainerMet(TrainerType.ROARK);
    // never a common trainer in a gym leader's place
    expect(unmetTrainerPool(CAVE, BiomePoolTier.BOSS)).toBeNull();
  });
});
