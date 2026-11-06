/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { EvolutionItem } from "#balance/pokemon-evolutions";
import { tmPoolTiers } from "#balance/tm-pool-tiers";
import { itemId, parseItemId } from "#coop/debug/item-id";
import { coopText } from "#coop/ui/text";
import { allMoves, modifierTypes } from "#data/data-lists";
import { BerryType } from "#enums/berry-type";
import { FormChangeItem } from "#enums/form-change-item";
import { ModifierTier } from "#enums/modifier-tier";
import type { MoveId } from "#enums/move-id";
import { Nature } from "#enums/nature";
import { PokemonType } from "#enums/pokemon-type";
import { PERMANENT_STATS, TEMP_BATTLE_STATS } from "#enums/stat";
import type { PlayerPokemon, Pokemon } from "#field/pokemon";
import { PersistentModifier } from "#modifiers/modifier";
import {
  AddPokeballModifierType,
  FormChangeItemModifierType,
  type ModifierType,
  ModifierTypeGenerator,
  PokemonHeldItemModifierType,
  PokemonModifierType,
  SpeciesStatBoosterModifierTypeGenerator,
  TempStatStageBoosterModifierType,
} from "#modifiers/modifier-type";
import { getEnumValues } from "#utils/enums";
import Phaser from "phaser";

/**
 * Every item of the game, one by one, for the host's debug menu (DECISIONS D42, amended): the items the game makes as they
 * are, and each item of a family the game picks from at random (every evolution item, Mega Stone, TM, berry, mint...),
 * named by an exact item id (`debug/item-id.ts`). A family's key alone stays in the list as "the game picks".
 * @module
 */

/** The groups the debug window shows */
export type ItemFamily =
  | "balls"
  | "pokemon"
  | "berries"
  | "held"
  | "boosters"
  | "evolution"
  | "forms"
  | "tms"
  | "mints"
  | "tera"
  | "battle"
  | "team"
  | "other"
  | "random";

export const ITEM_FAMILIES: readonly ItemFamily[] = [
  "balls",
  "pokemon",
  "berries",
  "held",
  "boosters",
  "evolution",
  "forms",
  "tms",
  "mints",
  "tera",
  "battle",
  "team",
  "other",
  "random",
];

export interface CatalogItem {
  /** Its exact item id */
  id: string;
  name: string;
  family: ItemFamily;
  /** A Pokémon holds it: it can be given to one */
  held: boolean;
  /** It is the whole team's (a charm, a lure, the Mega Bracelet): it can be given to the team */
  team: boolean;
}

/** Which ones of a random family there are, and the group they show in */
interface Expansion {
  family: ItemFamily;
  args: () => readonly (number | string)[];
}

const types = (): PokemonType[] =>
  getEnumValues(PokemonType).filter(type => type >= PokemonType.NORMAL && type <= PokemonType.FAIRY);
const tms = (tier: ModifierTier) => (): MoveId[] =>
  Object.entries(tmPoolTiers)
    .filter(([move, moveTier]) => moveTier === tier && !allMoves[Number(move)]?.isUnimplemented)
    .map(([move]) => Number(move) as MoveId);
// (the game's own rarity splits: an evolution item above 50 is rare, a form change item below 150 is)
const evolutionItems = (rare: boolean) => (): EvolutionItem[] =>
  getEnumValues(EvolutionItem).filter(item => item > 0 && item > 50 === rare);
const formItems = (rare: boolean) => (): FormChangeItem[] =>
  getEnumValues(FormChangeItem).filter(item => item > 0 && item < 150 === rare);
const speciesBoosters = (rare: boolean) => (): string[] =>
  Object.entries(SpeciesStatBoosterModifierTypeGenerator.items)
    .filter(([, item]) => item.rare === rare)
    .map(([key]) => key);

const EXPANSIONS: Readonly<Record<string, Expansion>> = {
  ATTACK_TYPE_BOOSTER: { family: "boosters", args: types },
  BASE_STAT_BOOSTER: { family: "held", args: () => PERMANENT_STATS },
  TEMP_STAT_STAGE_BOOSTER: { family: "battle", args: () => TEMP_BATTLE_STATS },
  SPECIES_STAT_BOOSTER: { family: "held", args: speciesBoosters(false) },
  RARE_SPECIES_STAT_BOOSTER: { family: "held", args: speciesBoosters(true) },
  TM_COMMON: { family: "tms", args: tms(ModifierTier.COMMON) },
  TM_GREAT: { family: "tms", args: tms(ModifierTier.GREAT) },
  TM_ULTRA: { family: "tms", args: tms(ModifierTier.ULTRA) },
  EVOLUTION_ITEM: { family: "evolution", args: evolutionItems(false) },
  RARE_EVOLUTION_ITEM: { family: "evolution", args: evolutionItems(true) },
  FORM_CHANGE_ITEM: { family: "forms", args: formItems(false) },
  RARE_FORM_CHANGE_ITEM: { family: "forms", args: formItems(true) },
  MINT: { family: "mints", args: () => getEnumValues(Nature) },
  TERA_SHARD: { family: "tera", args: () => [...types(), PokemonType.STELLAR] },
  BERRY: { family: "berries", args: () => getEnumValues(BerryType) },
  MYSTERY_ENCOUNTER_SHUCKLE_JUICE: { family: "pokemon", args: () => [10, -15] },
};

/** The families whose items are for some Pokémon only: the window says which of the team */
const FITTING: readonly ItemFamily[] = ["evolution", "forms", "tms"];

let catalog: CatalogItem[] | null = null;
let byId: Map<string, CatalogItem> | null = null;

function titleOf(key: string): string {
  return key
    .toLowerCase()
    .split("_")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function nameOf(type: ModifierType, key: string): string {
  try {
    const name = type.name;
    return typeof name === "string" && name !== "" && !name.includes("modifierType:") ? name : titleOf(key);
  } catch {
    return titleOf(key);
  }
}

function familyOf(type: ModifierType, key: string): ItemFamily {
  if (type instanceof AddPokeballModifierType) {
    return "balls";
  }
  if (type instanceof TempStatStageBoosterModifierType || key === "DIRE_HIT") {
    return "battle";
  }
  if (type instanceof PokemonHeldItemModifierType) {
    return "held";
  }
  if (type instanceof PokemonModifierType) {
    return "pokemon";
  }
  return isTeamItem(type) ? "team" : "other";
}

function isHeld(type: ModifierType): boolean {
  return type instanceof PokemonHeldItemModifierType || type instanceof FormChangeItemModifierType;
}

function isTeamItem(type: ModifierType): boolean {
  if (type instanceof PokemonModifierType) {
    return false;
  }
  try {
    return type.newModifier() instanceof PersistentModifier;
  } catch {
    return false;
  }
}

function build(): CatalogItem[] {
  const items: CatalogItem[] = [];
  // Making the items draws nothing at random, and the battle's random numbers stay as they are on every client
  const random = Phaser.Math.RND.state();
  try {
    for (const key of Object.keys(modifierTypes)) {
      let type: ModifierType;
      try {
        type = modifierTypes[key as keyof typeof modifierTypes]();
      } catch {
        continue;
      }
      if (!(type instanceof ModifierTypeGenerator)) {
        items.push({
          id: key,
          name: nameOf(type, key),
          family: familyOf(type, key),
          held: isHeld(type),
          team: isTeamItem(type),
        });
        continue;
      }
      items.push({
        id: key,
        name: `${titleOf(key)} (${coopText("debugGamePicks", "the game picks")})`,
        family: "random",
        held: false,
        team: false,
      });
      const expansion = EXPANSIONS[key];
      if (expansion === undefined) {
        continue;
      }
      for (const arg of expansion.args()) {
        let made: ModifierType | null = null;
        try {
          made = type.generateType([], [arg]);
        } catch {
          made = null;
        }
        if (made === null) {
          continue;
        }
        items.push({
          id: itemId(key, arg),
          name: nameOf(made, key),
          family: expansion.family,
          held: isHeld(made),
          team: false,
        });
      }
    }
  } finally {
    Phaser.Math.RND.state(random);
  }
  // By group; among the form change items, the Mega Stones (the rare ones) first
  const rank = (item: CatalogItem): number =>
    ITEM_FAMILIES.indexOf(item.family) * 2 + (item.id.startsWith("FORM_CHANGE_ITEM:") ? 1 : 0);
  return items.sort((a, b) => rank(a) - rank(b));
}

/** @returns Every item of the game, one by one (made once) */
export function itemCatalog(): readonly CatalogItem[] {
  if (catalog === null) {
    catalog = build();
    byId = new Map(catalog.map(item => [item.id, item]));
  }
  return catalog;
}

/** @returns The item of the catalog with this id, if there is one */
export function catalogItem(id: string): CatalogItem | undefined {
  itemCatalog();
  return byId?.get(id);
}

/** @returns Whether the id is an item of the game: one of the catalog, or a key of the game's items */
export function isKnownItem(id: string): boolean {
  const item = parseItemId(id);
  if (item === null) {
    return false;
  }
  return item.arg === null ? Object.hasOwn(modifierTypes, item.key) : catalogItem(id) !== undefined;
}

/**
 * The game's item of an id. An exact item of a family draws nothing at random; a family's key alone lets the game pick
 * with the battle's random numbers, alike on every client.
 * @param party - The party a random pick is for
 * @returns Its type, with the id of its key; `null` if the id is no item, or the family has nothing to pick
 */
export function makeItemType(id: string, party?: readonly Pokemon[]): ModifierType | null {
  if (!isKnownItem(id)) {
    return null;
  }
  const item = parseItemId(id)!;
  const func = modifierTypes[item.key as keyof typeof modifierTypes];
  let type: ModifierType | null = func();
  if (type instanceof ModifierTypeGenerator) {
    type = type.generateType(party ?? globalScene.getPlayerParty(), item.arg === null ? undefined : [item.arg]);
  }
  return type?.withIdFromFunc(func) ?? null;
}

/** @returns The Pokémon of the party an item is for (an evolution item, a Mega Stone, a TM); none for any other item */
export function partyMembersFor(id: string, party: readonly PlayerPokemon[]): PlayerPokemon[] {
  const item = catalogItem(id);
  if (item === undefined || !FITTING.includes(item.family)) {
    return [];
  }
  const type = makeItemType(id, party);
  if (!(type instanceof PokemonModifierType) || type.selectFilter === undefined) {
    return [];
  }
  const filter = type.selectFilter;
  return party.filter(pokemon => {
    try {
      return filter(pokemon) === null;
    } catch {
      return false;
    }
  });
}
