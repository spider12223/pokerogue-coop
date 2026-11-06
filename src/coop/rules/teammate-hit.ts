/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { getCoopSession } from "#coop/session";
import { type BattlerIndex, fieldIndexOfBattler, isPlayerBattler } from "#enums/battler-index";
import type { Pokemon } from "#field/pokemon";

/**
 * Co-op (DECISIONS D8, amended): a move that could have gone at an enemy is aimed at a teammate's Pokémon. A stray press
 * on the target screen hits someone else's Pokémon, so the player is asked first. A move that only goes to allies (Helping
 * Hand) asks nothing, nor does a player's own Pokémon (a run of three continued with two, where one commands another's).
 * @param fieldIndex - The slot of the Pokémon that uses the move
 * @param target - The target the player picked
 * @param targets - Every target the move may have
 * @returns The teammate's Pokémon and its owner's name; `null` when there is nothing to ask
 */
export function teammateTarget(
  fieldIndex: number,
  target: BattlerIndex,
  targets: readonly BattlerIndex[],
): { pokemon: Pokemon; owner: string } | null {
  const session = getCoopSession();
  if (session?.link == null || !isPlayerBattler(target) || !targets.some(candidate => !isPlayerBattler(candidate))) {
    return null;
  }
  const slot = fieldIndexOfBattler(target);
  if (slot === fieldIndex) {
    return null;
  }
  const pokemon = globalScene.getPlayerField()[slot];
  const owner = pokemon === undefined ? undefined : session.ownership.get(pokemon.id);
  if (pokemon === undefined || owner === undefined || owner === session.seat) {
    return null;
  }
  return { pokemon, owner: session.nameOf(owner) };
}
