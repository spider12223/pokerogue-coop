/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { getCoopSession } from "#coop/session";
import { BiomePoolTier } from "#enums/biome-pool-tier";
import type { TrainerType } from "#enums/trainer-type";
import type { TrainerPools } from "#types/biomes";
import { randSeedInt } from "#utils/common";

/**
 * Trainers the run has met (DECISIONS D34). A co-op run remembers the trainer type of every wave's trainer battle, and a
 * biome's next trainer is one the run has not met yet when the biome has one: at the tier drawn, else at a lower tier of the
 * same kind (a gym leader for a gym leader). Only when all of them were met does one come back. Both clients keep the same
 * list (it is saved with the run and hashed). The pick draws exactly what upstream's does, so the run's stream is the same
 * whatever the run has met: a met trainer drawn is swapped for an unmet one without a draw.
 *
 * Solo play picks as upstream.
 * @module
 */

/**
 * @param pools - The biome's trainer pools
 * @param tier - The tier the trainer was drawn from (a tier that has trainers)
 * @returns The trainers of `tier`, or of the closest lower tier of the same kind, that the run has not met; `null` in solo
 * play or when the run has met all of them
 */
export function unmetTrainerPool(pools: TrainerPools, tier: BiomePoolTier): readonly TrainerType[] | null {
  const session = getCoopSession();
  if (session === null) {
    return null;
  }
  const met = session.metTrainers;
  const lowest = tier >= BiomePoolTier.BOSS ? BiomePoolTier.BOSS : BiomePoolTier.COMMON;
  for (let t = tier; t >= lowest; t--) {
    const unmet = pools[t].filter(type => !met.includes(type));
    if (unmet.length > 0) {
      return unmet;
    }
  }
  return null;
}

/**
 * The trainer of `tier` in a co-op run. The draw is upstream's (`randSeedItem` of the tier), so it moves the stream as much.
 * @param pools - The biome's trainer pools
 * @param tier - The tier drawn; it has trainers
 * @returns The trainer, or `null` in solo play, which then draws as upstream
 */
export function pickCoopTrainer(pools: TrainerPools, tier: BiomePoolTier): TrainerType | null {
  const session = getCoopSession();
  if (session === null) {
    return null;
  }
  const pool = pools[tier];
  // `randSeedItem`: no draw for a single trainer, else one integer in the pool's range
  const index = randSeedInt(pool.length);
  const drawn = pool[index];
  if (!session.metTrainers.includes(drawn)) {
    return drawn;
  }
  const unmet = unmetTrainerPool(pools, tier);
  return unmet === null ? drawn : unmet[index % unmet.length];
}

/** A wave's trainer battle was generated: the run has met this trainer. Nothing in solo play. */
export function noteTrainerMet(type: TrainerType): void {
  getCoopSession()?.noteTrainer(type);
}
