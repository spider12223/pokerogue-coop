/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { type CatalogItem, type ItemFamily, itemCatalog, partyMembersFor } from "#coop/debug/catalog";
import { type Choice, t } from "#coop/debug/dom";
import { titleOf } from "#coop/debug/live";
import { allAbilities, allMoves } from "#data/data-lists";
import { getNatureName } from "#data/nature";
import { BiomeId } from "#enums/biome-id";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { Nature } from "#enums/nature";
import { PokemonType } from "#enums/pokemon-type";
import { TrainerType } from "#enums/trainer-type";
import type { PlayerPokemon } from "#field/pokemon";
import { getBiomeName } from "#utils/common";

/**
 * What the sections of the host's debug window (DECISIONS D42) pick from: the game's lists (species, moves, abilities,
 * natures, trainers, encounters, biomes, types), made once; the catalog's items of a kind; and the helpers that find a
 * box again after the window is drawn again.
 * @module
 */

const lists = new Map<string, Choice[]>();

export function enumChoices(values: Record<string, string | number>, skip: readonly number[] = []): Choice[] {
  return Object.entries(values)
    .filter(([, value]) => typeof value === "number" && !skip.includes(value))
    .map(([key, value]) => ({ label: titleOf(key), value: value as number }));
}

export function list(name: string): Choice[] {
  const known = lists.get(name);
  if (known !== undefined) {
    return known;
  }
  let made: Choice[];
  switch (name) {
    case "species":
      made = speciesDataRegistry.getAllSpecies().map(species => ({ label: species.name, value: species.speciesId }));
      break;
    case "moves":
      made = allMoves
        .slice(1)
        .map(move => ({ label: move.name, value: move.id, note: titleOf(PokemonType[move.type]) }));
      break;
    case "abilities":
      made = allAbilities.slice(1).map(ability => ({ label: ability.name, value: ability.id }));
      break;
    case "natures":
      made = enumChoices(Nature as unknown as Record<string, number>).map(choice => ({
        ...choice,
        label: getNatureName(choice.value as Nature, true, false, true),
      }));
      break;
    case "trainers":
      made = enumChoices(TrainerType as unknown as Record<string, number>, [TrainerType.UNKNOWN]);
      break;
    case "encounters":
      made = enumChoices(MysteryEncounterType as unknown as Record<string, number>);
      break;
    case "biomes":
      made = enumChoices(BiomeId as unknown as Record<string, number>).map(choice => ({
        ...choice,
        label: getBiomeName(choice.value as BiomeId),
      }));
      break;
    case "types":
      made = enumChoices(PokemonType as unknown as Record<string, number>, [PokemonType.UNKNOWN]);
      break;
    default:
      made = [];
  }
  // (two entries with one name: the second says its number)
  const seen = new Set<string>();
  for (const choice of made) {
    if (seen.has(choice.label)) {
      choice.label = `${choice.label} #${choice.value}`;
    }
    seen.add(choice.label);
  }
  lists.set(name, made);
  return made;
}

export const labelOf = (name: string, value: number | null): string =>
  value === null ? "" : (list(name).find(choice => choice.value === value)?.label ?? String(value));

export function currentWave(): number {
  return globalScene.currentBattle?.waveIndex ?? 0;
}

/** The number a picker and a number box are found by again after the window is drawn again */
export function keep<T extends HTMLElement>(node: T, id: string): T {
  const input = node.matches("input, select") ? node : node.querySelector<HTMLElement>("input, select");
  if (input !== null) {
    input.dataset["keep"] = id;
  }
  return node;
}

export function familyName(family: ItemFamily): string {
  return {
    balls: t("FamBalls", "Poké Balls"),
    pokemon: t("FamPokemon", "Pokémon items"),
    berries: t("FamBerries", "Berries"),
    held: t("FamHeld", "Held items"),
    boosters: t("FamBoosters", "Type boosters"),
    evolution: t("FamEvolution", "Evolution items"),
    forms: t("FamForms", "Mega Stones & forms"),
    tms: t("FamTms", "TMs"),
    mints: t("FamMints", "Mints"),
    tera: t("FamTera", "Tera Shards"),
    battle: t("FamBattle", "Battle items"),
    team: t("FamTeam", "Team items"),
    other: t("FamOther", "Other"),
    random: t("FamRandom", "Game picks"),
  }[family];
}

/** The catalog's items of a kind, as a list to pick from; the ones for our team first */
export function itemChoices(
  keepItem: (item: CatalogItem) => boolean,
  members: readonly PlayerPokemon[] = [],
): Choice[] {
  const choices: Choice[] = [];
  for (const item of itemCatalog()) {
    if (!keepItem(item)) {
      continue;
    }
    const fits = members.length === 0 ? [] : partyMembersFor(item.id, members);
    choices.push({
      label: item.name,
      value: item.id,
      note:
        fits.length > 0
          ? t("Fits", "fits {{who}}", { who: fits.map(p => p.name).join(", ") })
          : familyName(item.family),
      fits: fits.length > 0,
    });
  }
  return choices.sort((a, b) => Number(b.fits ?? false) - Number(a.fits ?? false));
}
