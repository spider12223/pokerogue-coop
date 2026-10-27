/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Seat } from "#coop/protocol";

/**
 * The wave-start arrange step as a pure function (DECISIONS D7). The game applies it in `src/coop/arrange.ts`.
 *
 * Slot 0 is the host's (P1), slot 1 the guest's (P2): at the start of a wave each takes the first legal Pokémon it owns,
 * in party order. A seat with none is covered by its partner: the partner's next legal Pokémon takes the slot. Everything
 * else keeps its relative order behind the two. Deterministic: the result depends only on the party order, who owns what
 * and which Pokémon are legal.
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
 * @returns The `id`s in the order the party should have: [slot 0, slot 1, ...the rest in their previous order]. With a
 * single legal Pokémon it is alone in front; with none the order is unchanged.
 */
export function arrangeOrder(party: readonly ArrangeMember[]): number[] {
  const hostLegal = party.filter(member => member.legal && member.owner === "host");
  const guestLegal = party.filter(member => member.legal && member.owner === "guest");

  // A seat without a legal Pokémon is covered by the partner's next one (the partner's first is in the partner's slot)
  const slot0 = hostLegal[0] ?? guestLegal[1];
  const slot1 = guestLegal[0] ?? hostLegal[1];

  const slots = [slot0, slot1].filter((member): member is ArrangeMember => member !== undefined);
  const inSlots = new Set(slots.map(member => member.id));
  return [...slots, ...party.filter(member => !inSlots.has(member.id))].map(member => member.id);
}
