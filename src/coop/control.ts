/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { getPokemonNameWithAffix } from "#app/messages";
import { otherSeat, type Seat } from "#coop/protocol";
import { getCoopSession, requireCoopSession, rewardPickerOf } from "#coop/session";
import { coopText } from "#coop/text";
import type { PlayerPokemon, Pokemon } from "#field/pokemon";
import i18next from "i18next";

/**
 * Who owns, controls and decides what in a co-op run (DECISIONS D7, D9, D10). Functions only: they read the owner map
 * of the session and the current field, and are what the input layer asks before it accepts a decision.
 *
 * Control follows the owner of the Pokémon that is in a slot, never the slot: the host owns slot 0 only while one of
 * its Pokémon is in it.
 *
 * @module
 */

/**
 * @returns The seat that owns a player-side Pokémon; `null` for an enemy. A player Pokémon nobody owns yet is read as
 * the host's, the world-level account (it can only be a Pokémon that was never part of the run, such as a preview).
 */
export function ownerOf(pokemon: Pokemon): Seat | null {
  if (!pokemon.isPlayer()) {
    return null;
  }
  return requireCoopSession().ownerOf(pokemon.id);
}

/**
 * @returns Whether a player-side Pokémon is owned by the partner of this client. `false` in solo play, for an enemy, and
 * for a Pokémon that has no owner (it is nobody's, so it is not marked as the partner's).
 */
export function isPartnersPokemon(pokemon: Pokemon): boolean {
  const session = getCoopSession();
  if (session === null || !pokemon.isPlayer()) {
    return false;
  }
  const owner = session.ownership.get(pokemon.id);
  return owner !== undefined && owner !== session.seat;
}

/** @returns The text for picking the partner's Pokémon where only one's own may be picked, e.g. "Squirtle is Sam's." */
export function notYourPokemonText(pokemon: Pokemon): string {
  return coopText("notYourPokemon", "{{pokemonName}} is {{partner}}'s.", {
    pokemonName: getPokemonNameWithAffix(pokemon, false),
    partner: getCoopSession()?.partnerName ?? "Your partner",
  });
}

/**
 * @returns The seat that owns a party member
 * @throws If it has no owner: a party member without one means the two clients could decide differently
 */
export function requireOwnerOf(pokemon: PlayerPokemon): Seat {
  return requireCoopSession().ownership.require(pokemon.id);
}

/**
 * @returns The seat that commands the Pokémon in this field slot: the owner of the Pokémon that is in it now.
 * `null` if the slot is empty or its Pokémon cannot act (fainted).
 */
export function controllerOf(fieldIndex: number): Seat | null {
  const pokemon = globalScene.getPlayerField()[fieldIndex];
  if (pokemon == null || !pokemon.isActive()) {
    return null;
  }
  return requireOwnerOf(pokemon);
}

/** The party members that can be sent out: legal (alive, challenge-legal) and not in a field slot. */
export function legalBench(): PlayerPokemon[] {
  return globalScene
    .getPlayerParty()
    .slice(globalScene.currentBattle.getBattlerCount())
    .filter(pokemon => pokemon.isAllowedInBattle());
}

/**
 * - `voluntary`: the player switches (the Pokémon command, a move that switches its user out, the post-battle switch)
 * - `faint`: the Pokémon in the slot fainted and has to be replaced
 * - `forced`: the Pokémon in the slot is dragged out by Roar, Whirlwind, Dragon Tail or Red Card (D7, amended); the
 *   replacement is a random pick from the same pool as after a faint
 */
export type SwitchReason = "voluntary" | "faint" | "forced";

/**
 * Who may be sent into a slot (D7):
 * - voluntary: the controller's own bench only
 * - faint, forced: the owner's bench of the Pokémon that left the slot; if it is empty, the partner's bench
 *
 * An empty result means upstream behaviour: with no bench at all nothing is asked, and the field re-centres or the run
 * ends.
 * @param fieldIndex - The slot that gets a new Pokémon
 */
export function switchTargets(fieldIndex: number, reason: SwitchReason): PlayerPokemon[] {
  const bench = legalBench();
  if (reason === "voluntary") {
    const controller = controllerOf(fieldIndex);
    return controller === null ? [] : bench.filter(pokemon => requireOwnerOf(pokemon) === controller);
  }
  const fainted = globalScene.getPlayerParty()[fieldIndex];
  if (fainted == null) {
    return [];
  }
  const owner = requireOwnerOf(fainted);
  const own = bench.filter(pokemon => requireOwnerOf(pokemon) === owner);
  return own.length > 0 ? own : bench.filter(pokemon => requireOwnerOf(pokemon) === otherSeat(owner));
}

/** @returns Whether sending out the party member at `partyIndex` into the slot is allowed */
export function isAllowedSwitch(fieldIndex: number, partyIndex: number, reason: SwitchReason): boolean {
  const target = globalScene.getPlayerParty()[partyIndex];
  return target != null && switchTargets(fieldIndex, reason).includes(target);
}

/** What a decision is about, as far as who may make it. */
export type CoopDecision =
  | { kind: "TURN_COMMANDS"; fieldIndex: number }
  | { kind: "FAINT_SWITCH"; fieldIndex: number }
  | { kind: "PIVOT_SWITCH"; fieldIndex: number }
  | { kind: "SIDE_ACTION"; proposer: Seat }
  | { kind: "SIDE_PICK" }
  | { kind: "RETRY" }
  | { kind: "REWARD_PICK" | "REWARD_TARGET" | "REROLL" }
  | { kind: "SHOP_BUY" }
  | { kind: "LEARN_MOVE" | "EVOLUTION_CANCEL"; pokemonId: number }
  | { kind: "BIOME" }
  | { kind: "CATCH_RELEASE"; fieldIndex: number }
  | { kind: "TRADE_PROPOSE"; proposer: Seat }
  | { kind: "TRADE_ACCEPT"; proposer: Seat }
  | { kind: "TRADE_CANCEL" };

/**
 * @returns The seat that makes the decision; `"either"` if both may (the shop); `null` if nobody has anything to
 * decide (a faint switch with no bench on either side)
 */
export function deciderOf(decision: CoopDecision): Seat | "either" | null {
  const session = requireCoopSession();
  switch (decision.kind) {
    case "TURN_COMMANDS":
      return controllerOf(decision.fieldIndex);
    case "FAINT_SWITCH": {
      const targets = switchTargets(decision.fieldIndex, "faint");
      return targets.length === 0 ? null : requireOwnerOf(targets[0]);
    }
    case "PIVOT_SWITCH":
      // the Pokémon that switches itself out is commanded by its controller, who picks the replacement
      return controllerOf(decision.fieldIndex);
    case "SIDE_ACTION":
      // a Ball or Run needs the partner's accept (D8)
      return otherSeat(decision.proposer);
    case "SIDE_PICK":
      // both chose a Ball or a Run: the host picks the one that happens (D8)
      return "host";
    case "RETRY":
      // the party is wiped: the host chooses to retry the wave or end the run (D4a)
      return "host";
    case "REWARD_PICK":
    case "REWARD_TARGET":
    case "REROLL":
      // the picker of the reward screen that is open: the one started last
      if (session.rewardPickCount === 0) {
        throw new Error("No reward screen has started");
      }
      return rewardPickerOf(session.rewardPickCount - 1);
    case "SHOP_BUY":
      return "either";
    case "LEARN_MOVE":
    case "EVOLUTION_CANCEL":
      return session.ownership.require(decision.pokemonId);
    case "BIOME":
      return session.lastRewardPicker;
    case "CATCH_RELEASE":
      // the thrower owns what it catches (D10)
      return controllerOf(decision.fieldIndex);
    case "TRADE_PROPOSE":
      return decision.proposer;
    case "TRADE_ACCEPT":
      return otherSeat(decision.proposer);
    case "TRADE_CANCEL":
      return "either";
  }
}

/**
 * The select filter for the party screen when a Pokémon is sent into a slot, in co-op: the upstream one (no fainted
 * Pokémon) plus the ownership rules of {@linkcode switchTargets}.
 * @param fieldIndex - The slot that gets a new Pokémon
 * @param upstream - The filter the screen would use in solo play
 */
export function coopSwitchFilter(
  fieldIndex: number,
  reason: SwitchReason,
  upstream: (pokemon: PlayerPokemon) => string | null,
): (pokemon: PlayerPokemon) => string | null {
  return pokemon => {
    const message = upstream(pokemon);
    if (message !== null || !getCoopSession()) {
      return message;
    }
    if (switchTargets(fieldIndex, reason).includes(pokemon)) {
      return null;
    }
    // The usual reason is that it is the partner's; say so rather than "can't be sent out in this slot"
    if (isPartnersPokemon(pokemon)) {
      return notYourPokemonText(pokemon);
    }
    return i18next.t("partyUiHandler:coopNotAvailable", {
      pokemonName: getPokemonNameWithAffix(pokemon, false),
      defaultValue: "{{pokemonName}} can't be sent out in this slot.",
    });
  };
}
