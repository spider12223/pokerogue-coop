/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { DecisionKey, DecisionKind, Seat } from "#coop/protocol";
import type { WindowEntry } from "#coop/sequencer";

/**
 * The reward screen as sequenced decisions (DECISIONS D9). The screen is a window with several ways out that stays open
 * until the picker picks or skips: each action of either player is one decision, numbered by the step it happens in.
 *
 * | Action | Kind | Who |
 * |---|---|---|
 * | free pick, skip | `REWARD_PICK` | the picker; closes the screen |
 * | reroll | `REROLL` | the picker |
 * | Lock Capsule | `REWARD_LOCK` | the picker |
 * | shop buy | `SHOP_BUY` | either |
 * | item transfer | `REWARD_TRANSFER` | either, from their own Pokémon only |
 *
 * Every step opens all of these keys at once (`ref = "${screen}:${step}"`); the first one sequenced closes the step, and a
 * proposal for a key of a closed step is rejected (`closed`) and its author told.
 *
 * @module
 */

/** A Pokémon is named by its `pokemon.id`, never by a party slot. */
export interface RewardTarget {
  /** The Pokémon the item is for */
  target?: number;
  /** A second Pokémon, for a fusion */
  target2?: number;
  /** A move slot (PP Up, Ether, ...) or the move to remember */
  option?: number;
}

export type RewardAction =
  | ({ t: "pick"; index: number } & RewardTarget)
  | { t: "skip" }
  | { t: "reroll" }
  | { t: "lock" }
  | ({ t: "buy"; index: number } & RewardTarget)
  | { t: "transfer"; from: number; to: number; items: { index: number; quantity: number }[] };

export const REWARD_KINDS = [
  "REWARD_PICK",
  "REROLL",
  "REWARD_LOCK",
  "SHOP_BUY",
  "REWARD_TRANSFER",
] as const satisfies readonly DecisionKind[];

export type RewardKind = (typeof REWARD_KINDS)[number];

export function isRewardKind(kind: string): kind is RewardKind {
  return (REWARD_KINDS as readonly string[]).includes(kind);
}

/** The kind of decision an action is */
export function kindOfAction(action: RewardAction): RewardKind {
  switch (action.t) {
    case "pick":
    case "skip":
      return "REWARD_PICK";
    case "reroll":
      return "REROLL";
    case "lock":
      return "REWARD_LOCK";
    case "buy":
      return "SHOP_BUY";
    case "transfer":
      return "REWARD_TRANSFER";
  }
}

/** @returns The key of a kind of action in step `step` of reward screen `screen` of wave `wave` */
export function rewardKey(wave: number, kind: RewardKind, screen: number, step: number): DecisionKey {
  return { wave, turn: 0, kind, ref: `${screen}:${step}` };
}

/**
 * @param picker - Who picks on this screen
 * @returns Every way out of step `step`: the picker's actions, and the ones both players have. The trade request (D11) and
 * a party edit (D28) are among the latter: either player may ask for a trade phase after this screen, or change one of their
 * own Pokémon. Neither is a {@linkcode RewardAction}: they do not change the screen's options, but like a shop buy they
 * take a step.
 */
export function rewardWindow(wave: number, screen: number, step: number, picker: Seat): WindowEntry[] {
  const pickerOnly = [picker] as const;
  return [
    { key: rewardKey(wave, "REWARD_PICK", screen, step), authors: pickerOnly },
    { key: rewardKey(wave, "REROLL", screen, step), authors: pickerOnly },
    { key: rewardKey(wave, "REWARD_LOCK", screen, step), authors: pickerOnly },
    { key: rewardKey(wave, "SHOP_BUY", screen, step) },
    { key: rewardKey(wave, "REWARD_TRANSFER", screen, step) },
    { key: { wave, turn: 0, kind: "TRADE_REQUEST", ref: `${screen}:${step}` } },
    // A player's change to their own Pokémon (D28): reorder, release, rename, ...
    { key: { wave, turn: 0, kind: "PARTY_EDIT", ref: `${screen}:${step}` } },
  ];
}

const isIndex = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const isOptional = (value: unknown): boolean => value === undefined || Number.isInteger(value);

function isTargets(action: Record<string, unknown>): boolean {
  return isOptional(action["target"]) && isOptional(action["target2"]) && isOptional(action["option"]);
}

export function isRewardAction(value: unknown): value is RewardAction {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const action = value as Record<string, unknown>;
  switch (action["t"]) {
    case "skip":
    case "reroll":
    case "lock":
      return true;
    case "pick":
    case "buy":
      return isIndex(action["index"]) && isTargets(action);
    case "transfer":
      return (
        Number.isInteger(action["from"])
        && Number.isInteger(action["to"])
        && Array.isArray(action["items"])
        && action["items"].length > 0
        && action["items"].every(
          (item: unknown) =>
            typeof item === "object"
            && item !== null
            && isIndex((item as Record<string, unknown>)["index"])
            && Number.isInteger((item as Record<string, unknown>)["quantity"])
            && ((item as Record<string, unknown>)["quantity"] as number) > 0,
        )
      );
    default:
      return false;
  }
}

/**
 * The host's check of a proposal for the reward screen (the sequencer's `validatePayload`): the payload is an action of
 * the key's kind, and a transfer takes from a Pokémon of its author.
 * @param ownerOf - Who owns a Pokémon, by `pokemon.id`
 */
export function isValidRewardProposal(
  key: DecisionKey,
  payload: unknown,
  author: Seat,
  ownerOf: (pokemonId: number) => Seat | undefined,
): boolean {
  if (!isRewardKind(key.kind)) {
    return true;
  }
  if (!isRewardAction(payload) || kindOfAction(payload) !== key.kind) {
    return false;
  }
  if (payload.t === "transfer") {
    return ownerOf(payload.from) === author;
  }
  // A fusion (a DNA Splicer) takes two of the author's own Pokémon: the partner's are not theirs to give up
  if ((payload.t === "pick" || payload.t === "buy") && payload.target2 !== undefined) {
    return payload.target !== undefined && ownerOf(payload.target) === author && ownerOf(payload.target2) === author;
  }
  return true;
}
