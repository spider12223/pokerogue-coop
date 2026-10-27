/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { DecisionKey, Seat } from "#coop/protocol";

/**
 * Party edits on the reward screen (DECISIONS D28): each player changes their own Pokémon, as in solo play, and both
 * clients carry the change out at the same point. An edit is a decision of the reward window (`PARTY_EDIT`, either seat,
 * `ref = "${screen}:${step}"`); like a shop buy it takes a step.
 *
 * | Edit | What it does | Rule |
 * |---|---|---|
 * | `swap` | two Pokémon change places in the party (the order decides who leads the next wave, D7) | both are the author's |
 * | `release` | the Pokémon leaves the run, with its items | the author's, and not their last one |
 * | `rename` | a nickname (as the rename form stores it: base64 of the UTF-8 text) | the author's |
 * | `evolution` | its evolutions are paused or not | the author's, and it has an evolution |
 * | `formItem` | a form change item it holds is switched on or off | the author's, and it holds that item |
 * | `unsplice` | a fusion is undone | the author's, and it is fused |
 *
 * No game imports, so it runs in Node.
 *
 * @module
 */

export type PartyEdit =
  | { k: "swap"; a: number; b: number }
  | { k: "release"; pokemonId: number }
  | { k: "rename"; pokemonId: number; nickname: string }
  | { k: "evolution"; pokemonId: number; paused: boolean }
  | { k: "formItem"; pokemonId: number; item: number; active: boolean }
  | { k: "unsplice"; pokemonId: number };

/** A nickname as the rename form stores it, with room for the longest the form takes */
const NICKNAME = /^[A-Za-z0-9+/=]{0,96}$/;

const isId = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/** @returns Whether this is a well-formed party edit: plain values of the right kinds, nothing else */
export function isPartyEdit(value: unknown): value is PartyEdit {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const edit = value as Record<string, unknown>;
  switch (edit["k"]) {
    case "swap":
      return isId(edit["a"]) && isId(edit["b"]);
    case "release":
    case "unsplice":
      return isId(edit["pokemonId"]);
    case "rename":
      return isId(edit["pokemonId"]) && typeof edit["nickname"] === "string" && NICKNAME.test(edit["nickname"]);
    case "evolution":
      return isId(edit["pokemonId"]) && typeof edit["paused"] === "boolean";
    case "formItem":
      return isId(edit["pokemonId"]) && isId(edit["item"]) && typeof edit["active"] === "boolean";
    default:
      return false;
  }
}

/** @returns The Pokémon an edit changes, by `pokemon.id` */
export function pokemonOfEdit(edit: PartyEdit): number[] {
  return edit.k === "swap" ? [edit.a, edit.b] : [edit.pokemonId];
}

/** @returns The key of a party edit in step `step` of reward screen `screen` of wave `wave` */
export function partyEditKey(wave: number, screen: number, step: number): DecisionKey {
  return { wave, turn: 0, kind: "PARTY_EDIT", ref: `${screen}:${step}` };
}

/** One Pokémon of the party, as an edit is checked against it */
export interface PartyMemberView {
  id: number;
  owner: Seat | undefined;
  fused: boolean;
  /** The form change items it holds (`FormChangeItem`) */
  formItems: readonly number[];
  /** Whether it has an evolution that could be paused */
  evolves: boolean;
}

/**
 * Whether a party edit may be made by `author` (the host's check before it sequences one, and both clients' check before
 * they carry it out, D24).
 * @param party - The party, in order
 * @returns The reason it may not, or `null`
 */
export function checkPartyEdit(edit: unknown, author: Seat, party: readonly PartyMemberView[]): string | null {
  if (!isPartyEdit(edit)) {
    return "a party edit that cannot be read";
  }
  for (const id of pokemonOfEdit(edit)) {
    const member = party.find(candidate => candidate.id === id);
    if (member === undefined) {
      return "a party edit of a Pokémon that is not in the party";
    }
    if (member.owner !== author) {
      return "a party edit of the partner's Pokémon";
    }
  }
  const member = party.find(candidate => candidate.id === pokemonOfEdit(edit)[0])!;
  switch (edit.k) {
    case "swap":
      return edit.a === edit.b ? "a swap of a Pokémon with itself" : null;
    case "release":
      return party.filter(candidate => candidate.owner === author).length > 1
        ? null
        : "the release of the player's last Pokémon";
    case "unsplice":
      return member.fused ? null : "an unsplice of a Pokémon that is not fused";
    case "formItem":
      return member.formItems.includes(edit.item) ? null : "a form change item the Pokémon does not hold";
    case "evolution":
      return member.evolves ? null : "a pause of evolutions for a Pokémon that has none";
    case "rename":
      return null;
  }
}
