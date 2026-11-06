/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { debugState } from "#coop/debug/hooks";
import { tierOfItem } from "#coop/debug/item-id";
import { makeKnownItemType } from "#coop/debug/make-item";
import { ModifierPoolType } from "#enums/modifier-pool-type";
import type { ModifierTier } from "#enums/modifier-tier";
import type { PlayerPokemon } from "#field/pokemon";
import type { ModifierTypeOption } from "#modifiers/modifier-type";

/**
 * The next reward screen's items as the host chose them (DECISIONS D42, amended), put in their places by the screen
 * itself: an exact item as the game's item override would make it, a tier pick rolled from its tier. Every client makes
 * the same screen: the items are the run's debug state, the rolls the battle's random numbers in the host's order.
 * @module
 */

/**
 * @param options - The options the screen rolled; the host's items take the first places, in its order
 * @param party - The party the items are for
 * @param roll - Rolls an option of a tier, unlike the others (the game's tier-locked roll, no luck upgrade); `null` if
 * it has nothing
 */
export function placeDebugRewards(
  options: ModifierTypeOption[],
  party: PlayerPokemon[],
  roll: (tier: ModifierTier, others: ModifierTypeOption[]) => ModifierTypeOption | null,
): void {
  const rewards = debugState()?.rewards ?? null;
  if (rewards === null) {
    return;
  }
  const places = rewards.slice(0, options.length);
  // The exact items first, then the tier picks: each is rolled against the screen's other options, the host's too
  for (const [index, id] of places.entries()) {
    const type = tierOfItem(id) === null ? makeKnownItemType(id, party) : null;
    if (type !== null) {
      options[index].type = type.withTierFromPool(ModifierPoolType.PLAYER, party);
    }
  }
  for (const [index, id] of places.entries()) {
    const tier = tierOfItem(id);
    if (tier === null) {
      continue;
    }
    const rolled = roll(
      tier,
      options.filter((_, at) => at !== index),
    );
    // (a tier with nothing to offer leaves the option the game rolled)
    if (rolled?.type != null) {
      options[index] = rolled;
    }
  }
}
