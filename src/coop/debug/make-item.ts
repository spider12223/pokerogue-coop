/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { parseItemId } from "#coop/debug/item-id";
import { modifierTypes } from "#data/data-lists";
import type { Pokemon } from "#field/pokemon";
import type { ModifierType, ModifierTypeGenerator } from "#modifiers/modifier-type";

/**
 * Making the game's item of an exact item id (DECISIONS D42, amended), apart from the catalog: the reward screen makes
 * the host's items with it, and the reward options' module must not import the catalog (it imports them).
 * @module
 */

/** A family the game picks from (`ModifierTypeGenerator`, the only kind of item that generates one) */
function isGenerator(type: ModifierType): type is ModifierTypeGenerator {
  return typeof (type as Partial<ModifierTypeGenerator>).generateType === "function";
}

/**
 * The game's item of an id the catalog knows. An exact item of a family draws nothing at random; a family's key alone
 * lets the game pick with the battle's random numbers, alike on every client.
 * @param party - The party a random pick is for
 * @returns Its type, with the id of its key; `null` if the key is no item of the game, or the family has nothing to pick
 */
export function makeKnownItemType(id: string, party?: readonly Pokemon[]): ModifierType | null {
  const item = parseItemId(id);
  const func = item === null ? undefined : modifierTypes[item.key as keyof typeof modifierTypes];
  if (item === null || func === undefined) {
    return null;
  }
  let type: ModifierType | null = func();
  if (isGenerator(type)) {
    type = type.generateType(party ?? globalScene.getPlayerParty(), item.arg === null ? undefined : [item.arg]);
  }
  return type?.withIdFromFunc(func) ?? null;
}
