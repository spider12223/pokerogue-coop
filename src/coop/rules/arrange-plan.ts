/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Seat } from "#coop/protocol";

/**
 * The wave-start arrange step as a pure function (DECISIONS D7). The game applies it in `src/coop/rules/arrange.ts`.
 *
 * Slot 0 is the host's (P1), slot 1 the guest's (P2), slot 2 the second guest's in a game of three (P3, D40): at the start
 * of a wave each takes the first legal Pokémon it owns, in party order. A seat with none is covered by the next seat in
 * order (after the last comes the host) that still has a legal Pokémon: its next one takes the slot. Everything else keeps
 * its relative order behind them. Deterministic: the result depends only on the party order, who owns what and which
 * Pokémon are legal.
 *
 * No game imports.
 *
 * @module
 */

export interface ArrangeMember {
  id: number;
  /** Alive and allowed in battle */
  legal: boolean;
  owner: Seat;
}

/**
 * @param party - The party in its current order
 * @param seats - The seats of the game, one slot each, in slot order
 * @returns The `id`s in the order the party should have: [slot 0, slot 1, ...the rest in their previous order]. With a
 * single legal Pokémon it is alone in front; with none the order is unchanged.
 */
export function arrangeOrder(party: readonly ArrangeMember[], seats: readonly Seat[] = ["host", "guest"]): number[] {
  const legal = seats.map(seat => party.filter(member => member.legal && member.owner === seat));
  // Each seat's first legal Pokémon takes its slot
  const taken = legal.map(list => (list.length > 0 ? 1 : 0));
  const inSlot: (ArrangeMember | undefined)[] = legal.map(list => list[0]);
  // A seat without one is covered by the next seat in order that still has one (its next, as its first is in its slot)
  for (let slot = 0; slot < seats.length; slot++) {
    if (inSlot[slot] !== undefined) {
      continue;
    }
    for (let step = 1; step < seats.length; step++) {
      const next = (slot + step) % seats.length;
      if (taken[next] < legal[next].length) {
        inSlot[slot] = legal[next][taken[next]++];
        break;
      }
    }
  }

  const slots = inSlot.filter((member): member is ArrangeMember => member !== undefined);
  const inSlots = new Set(slots.map(member => member.id));
  return [...slots, ...party.filter(member => !inSlots.has(member.id))].map(member => member.id);
}
