/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { FighterView, LegalityView, RewardOptionView, RewardView } from "#coop/legal";
import { OwnerMap } from "#coop/ownership";
import type { DecisionKey, DecisionKind } from "#coop/protocol";

/**
 * A small game for the legality tests (DECISIONS D24): four Pokémon of the host and the guest, two on the field, a reward
 * screen with a shop, and what each of them can do.
 */

export const HOST_MON = 1;
export const GUEST_MON = 2;

export function owners(): OwnerMap {
  const map = new OwnerMap();
  for (const [id, seat] of [
    [1, "host"],
    [2, "guest"],
    [3, "host"],
    [4, "guest"],
    [5, "host"],
    [6, "host"],
  ] as const) {
    map.set(id, seat);
  }
  return map;
}

export const TACKLE = 33;
export const GROWL = 45;
export const SAND_ATTACK = 28;
export const STRUGGLE = 165;

export function fighter(over: Partial<FighterView> = {}): FighterView {
  return {
    fieldIndex: 0,
    controller: "host",
    moves: [
      { id: TACKLE, usable: true },
      { id: GROWL, usable: true },
      { id: SAND_ATTACK, usable: false },
    ],
    queuedMove: null,
    trapped: false,
    canTera: true,
    switchTargets: [2, 3],
    targetsOf: moveId =>
      moveId === GROWL ? { targets: [2, 3], multiple: true } : { targets: [1, 2, 3], multiple: false },
    ...over,
  };
}

export const option = (target: RewardOptionView["target"], cost = 0): RewardOptionView => ({ target, cost });

export function reward(over: Partial<RewardView> = {}): RewardView {
  return {
    options: [option("none"), option("pokemon"), option("fuse"), option("move")],
    shop: [option("none", 100), option("pokemon", 500)],
    money: 300,
    rerollCost: 250,
    waived: false,
    ...over,
  };
}

export function view(over: Partial<LegalityView> = {}): LegalityView {
  const map = owners();
  return {
    ownerOf: id => map.get(id),
    fighter: id =>
      id === HOST_MON
        ? fighter()
        : id === GUEST_MON
          ? fighter({ fieldIndex: 1, controller: "guest", canTera: false, trapped: true })
          : null,
    canCatch: true,
    canRun: true,
    ballCount: type => (type === 0 ? 5 : 0),
    replacements: () => [2, 3],
    reward: () => reward(),
    transferable: id => (id === GUEST_MON ? [2, 1] : []),
    moveCount: id => (id === HOST_MON ? 4 : id === GUEST_MON ? 3 : null),
    biomeChoices: () => [10, 11],
    ownership: () => map,
    // Pokémon 3 is fused, 4 holds form change item 7, every one evolves but 6
    partyMembers: () =>
      [1, 2, 3, 4, 5, 6].map(id => ({
        id,
        owner: map.get(id),
        fused: id === 3,
        formItems: id === 4 ? [7] : [],
        evolves: id !== 6,
      })),
    meQuestion: () => null,
    sidePick: () => null,
    ...over,
  };
}

export const key = (kind: DecisionKind, ref: DecisionKey["ref"] = 0, turn = 0): DecisionKey => ({
  wave: 2,
  turn,
  kind,
  ref,
});
export const turnKey = (pokemonId: number): DecisionKey => key("TURN_COMMANDS", pokemonId, 3);

/** A command of the wire, with a fight's target chosen the way the target screen stores it */
export const fight = (cursor: number, move: number, targets: number[], extra: Record<string, unknown> = {}) => ({
  command: { command: 0, cursor, move: { move, targets: [], useMode: 0 }, targets, ...extra },
  pre: null,
});
