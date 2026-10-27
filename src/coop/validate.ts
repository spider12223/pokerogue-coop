/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { isMeChoice } from "#coop/me-choice";
import { isPartyEdit, pokemonOfEdit } from "#coop/party-edit";
import { isCatchReleasePayload } from "#coop/prompt-payloads";
import type { DecisionKey, Seat } from "#coop/protocol";
import { isRetryPayload } from "#coop/retry";
import { isValidRewardProposal } from "#coop/reward-actions";
import { getCoopSession } from "#coop/session";
import { checkTradeProposal, isTradeDonePayload, isTradeProposePayload } from "#coop/trade";
import { isSidePickPayload } from "#coop/turn-commands";

/**
 * The host's check of what a proposal carries (the sequencer's `validatePayload`). A proposal that fails is never
 * sequenced; its author is told it was `invalid`.
 * - the reward screen: an action of the key's kind, and an item moved only from the author's own Pokémon (D9)
 * - a release for a catch: only one of the author's own Pokémon (D10)
 * - a trade (D11): a proposal gives one of the author's own Pokémon, wants one of the partner's, and a gift makes the
 *   counts more equal; the answers carry nothing; "done" says which
 * - a party edit (D28): only of the author's own Pokémon
 * - the retry after a wipe (D4a): a yes or a no
 *
 * @module
 */
export function validateProposal(key: DecisionKey, payload: unknown, author: Seat): boolean {
  const ownership = getCoopSession()?.ownership;
  const ownerOf = (pokemonId: number): Seat | undefined => ownership?.get(pokemonId);
  if (key.kind === "CATCH_RELEASE") {
    return isCatchReleasePayload(payload) && (payload.release === null || ownerOf(payload.release) === author);
  }
  switch (key.kind) {
    case "TRADE_REQUEST":
    case "TRADE_ACCEPT":
    case "TRADE_DECLINE":
    case "TRADE_CANCEL":
      return payload === null;
    case "TRADE_PROPOSE":
      return (
        ownership !== undefined
        && isTradeProposePayload(payload)
        && checkTradeProposal(author, payload, ownership) === null
      );
    case "TRADE_DONE":
      return isTradeDonePayload(payload);
    case "PARTY_EDIT":
      return isPartyEdit(payload) && pokemonOfEdit(payload).every(id => ownerOf(id) === author);
    case "ME_CHOICE":
      // what it may be is the open question's, which both clients check before they apply it (D24)
      return isMeChoice(payload);
    case "SIDE_PICK":
      // which Pokémon may be picked is the turn's, which both clients check before they apply it (D24)
      return isSidePickPayload(payload);
    case "RETRY":
      return isRetryPayload(payload);
    default:
      break;
  }
  return isValidRewardProposal(key, payload, author, ownerOf);
}
