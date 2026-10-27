/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { arrangeOrder } from "#coop/arrange-plan";
import { requireOwnerOf } from "#coop/control";
import { coopLog } from "#coop/coop-log";
import type { PhaseString } from "#types/phase-types";

/**
 * Phases that carry a party or field index: they would act on the wrong Pokémon if the party were reordered under them.
 * The arrange step requires that none of them is queued.
 */
export const INDEX_BAKED_PHASES: readonly PhaseString[] = [
  "ExpPhase",
  "LevelUpPhase",
  "LearnMovePhase",
  "ShowPartyExpBarPhase",
  "SummonPhase",
  "SummonMissingPhase",
  "SwitchSummonPhase",
  "ReturnPhase",
  "SwitchPhase",
  "CheckSwitchPhase",
];

export interface ArrangeResult {
  /** The party's `pokemon.id`s as they are now: slot 0, slot 1, then the rest */
  order: number[];
  /** Whether the party order changed */
  changed: boolean;
}

/**
 * The wave-start arrange step (D7): put the Pokémon of the two seats into the two field slots, the only reorder the co-op
 * layer makes. Called where the next wave's battle is set up, before the party is sent out:
 * - for the first wave, as the starters are put together (nothing is on the field yet);
 * - for the others, in `BattleScene.doPostBattleCleanup` right before `PartyReorderSwitchPhase`, which recalls the
 *   Pokémon that the new order displaces and sends out the ones that take their place.
 *
 * @throws If an index-baked phase is queued (the point is not quiescent), or a party member has no owner
 */
/**
 * Drop the faint replacements left over from a wave that is won. A Pokémon that fainted after the last enemy (recoil, Life
 * Orb, Explosion, Rough Skin) leaves its replacement queued behind the next wave's set-up (FaintPhase pushes it to the back of
 * the queue). Upstream's switch then ends by itself, once the reorder of the new wave has put a healthy Pokémon in that slot;
 * in co-op the arrange step is that reorder, so the replacement has nothing to do. Both clients drop it alike, and before
 * anything that needs the queue free of index-baked phases (the trade screen, the arrange step). Found by the
 * start-to-Eternatus run (a faint on the last turn of a wave stopped the run) and the bug hunt after it (a trade asked for
 * on that wave's reward screen).
 * @param where - What the queue is freed for, for the log
 */
export function dropLeftoverFaintReplacements(where: string): void {
  let dropped = 0;
  while (globalScene.phaseManager.tryRemovePhase("SwitchPhase", phase => phase.isFaintReplacement)) {
    dropped++;
  }
  if (dropped > 0) {
    coopLog().info(where, `dropped ${dropped} faint replacement(s) left over from the wave that was won`);
  }
}

export function arrangeCoopParty(): ArrangeResult {
  const { phaseManager } = globalScene;
  dropLeftoverFaintReplacements("arrange");
  for (const name of INDEX_BAKED_PHASES) {
    if (phaseManager.hasPhaseOfType(name)) {
      throw new Error(`The party cannot be arranged with a ${name} queued`);
    }
  }

  const party = globalScene.getPlayerParty();
  const before = party.map(pokemon => pokemon.id);
  const order = arrangeOrder(
    party.map(pokemon => ({ id: pokemon.id, legal: pokemon.isAllowedInBattle(), owner: requireOwnerOf(pokemon) })),
  );
  const changed = order.some((id, index) => id !== before[index]);
  if (changed) {
    const byId = new Map(party.map(pokemon => [pokemon.id, pokemon]));
    // in place: other code holds the array
    party.splice(0, party.length, ...order.map(id => byId.get(id)!));
  }
  return { order, changed };
}
