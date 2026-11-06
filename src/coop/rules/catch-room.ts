/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PLAYER_PARTY_MAX_SIZE } from "#app/constants";
import { globalScene } from "#app/global-scene";
import { type Seat, startersPerSeat } from "#coop/protocol";
import { getCoopSession } from "#coop/session";
import { coopText } from "#coop/ui/text";
import i18next from "i18next";

/**
 * The question of a catch there is no room for: release one, or let it go. "The party is full" when it is; in co-op, when
 * the party has room but the player who gets the catch has all a player may keep (3, or 2 in a game of three: D10, D40),
 * it says so. The party was called full with five in it.
 * @param seat - Who gets the catch (the thrower, or an encounter's chooser); `null` in solo play
 * @param partySize - How many Pokémon the party has
 */
export function noRoomQuestion(
  seat: Seat | null,
  pokemonName: string,
  partySize = globalScene.getPlayerParty().length,
): string {
  const session = getCoopSession();
  if (seat === null || session === null || partySize >= PLAYER_PARTY_MAX_SIZE) {
    return i18next.t("battle:partyFull", { pokemonName });
  }
  return coopText(
    "seatFull",
    "You already have {{count}} Pokémon of your own.\nRelease one to make room for {{pokemonName}}?",
    {
      count: startersPerSeat(session.players),
      pokemonName,
    },
  );
}
