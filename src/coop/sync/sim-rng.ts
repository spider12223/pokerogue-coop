/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { isCoop, requireCoopSession } from "#coop/session";
import type { MoveId } from "#enums/move-id";
import type { Pokemon } from "#field/pokemon";
import type { RandomTargetPick } from "#moves/move-utils";
import { randInt, randSeedInt } from "#utils/common";

/**
 * Simulation sites that upstream draws from the unseeded `Math.random` (DECISIONS D3).
 * In solo play they keep drawing from it; in co-op each gets its own dedicated seeded stream, so both clients draw the
 * same value and the shared RNG stream is not touched (what comes after the site is not shifted).
 *
 * Every site has its own `executeWithSeedOffset` offset: the value is added to each char code of the seed string, so
 * keep it small and distinct. The seed string additionally names the site and a per-occurrence discriminator.
 */
export const COOP_RNG_SITES = {
  /** `getRandomTrainerFunc`: whether an evil-team grunt is female (`src/battle.ts`) */
  trainerGender: 0x11,
  /** `getRandomTrainerFunc`: whether an evil-team grunt battle is a double (`src/battle.ts`) */
  gruntDouble: 0x12,
  /** `Pokemon.fuse`: which of the two statuses the fusion keeps (`src/data/status-effect.ts`) */
  fusionStatus: 0x13,
  /** The random target a move like Outrage gets when it is chosen (`commandTargetPick`) */
  randomTarget: 0x14,
} as const;

export type CoopRngSite = keyof typeof COOP_RNG_SITES;

/**
 * Draw an integer for a simulation site that is unseeded upstream.
 * @param site - The site; it names the dedicated stream
 * @param discriminator - What tells this occurrence from the others of the same site, and that both clients know
 * (e.g. the wave's seed offset, or the ids of the two Pokémon). Ignored in solo play.
 * @param range - How large a range of numbers to choose from; see {@linkcode randInt}
 * @param min - The lowest number
 * @returns In solo play `randInt(range, min)` (unseeded); in co-op the draw from the site's dedicated stream
 */
export function simRandInt(site: CoopRngSite, discriminator: string | number, range: number, min = 0): number {
  if (!isCoop()) {
    return randInt(range, min);
  }
  let value = min;
  globalScene.executeWithSeedOffset(
    () => {
      value = randSeedInt(range, min);
    },
    COOP_RNG_SITES[site],
    `${requireCoopSession().runSeed}|${site}|${discriminator}`,
  );
  return value;
}

/**
 * How the target of a move with a random target (Outrage, Thrash, Struggle, ...) is drawn when the move is chosen.
 *
 * Upstream draws it from the battle's stream in the command phase. With a network only the client of the player who
 * chooses runs that phase for the Pokémon (the other takes the target from the command), so that draw would move one
 * client's battle stream and not the other's, and every roll after it would differ. In co-op the target comes from its own
 * stream instead, keyed by the turn, the Pokémon and the move; the battle's stream is not touched.
 * @returns `"battle"` in solo play (upstream), else the co-op draw
 */
export function commandTargetPick(pokemon: Pokemon, moveId: MoveId): RandomTargetPick {
  if (!isCoop()) {
    return "battle";
  }
  const { waveIndex, turn } = globalScene.currentBattle;
  return count => simRandInt("randomTarget", `${waveIndex}:${turn}:${pokemon.id}:${moveId}`, count);
}

/**
 * The discriminator of a site that is drawn inside an `executeWithSeedOffset` block (`newBattle` generates the trainer
 * inside one): the block's offset, which names the wave.
 */
export function currentSeedBlockId(): string {
  return `${globalScene.rngSeedOverride}@${globalScene.rngOffset}`;
}

/**
 * Give the scene the run seed the host sent in `START` (D3). The phase trace starts here: what came before ran on the
 * client's own random seed, which the two clients do not share.
 */
export function applyCoopRunSeed(): void {
  const session = requireCoopSession();
  globalScene.setSeed(session.runSeed);
  globalScene.resetSeed();
  session.trace.clear();
}
