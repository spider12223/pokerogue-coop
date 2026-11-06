/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { el, t } from "#coop/debug/dom";
import { view } from "#coop/debug/view";
import { ownerOf } from "#coop/decisions/control";
import { getCoopSession } from "#coop/session";
import { TerrainType } from "#data/terrain";
import { StatusEffect } from "#enums/status-effect";
import { WeatherType } from "#enums/weather-type";
import type { EnemyPokemon, PlayerPokemon, Pokemon } from "#field/pokemon";
import { getBiomeName } from "#utils/common";

/**
 * The live side of the host's debug window (DECISIONS D42): both teams and the field as the game has them, and the run's
 * wave, biome, money and turn. Read from the game on this client; drawn again whenever what it shows changes.
 * @module
 */

export interface RunInfo {
  wave: number;
  biome: string;
  money: number;
  turn: number;
}

export function titleOf(key: string): string {
  return key
    .toLowerCase()
    .split("_")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function party(): PlayerPokemon[] {
  try {
    return globalScene.getPlayerParty();
  } catch {
    return [];
  }
}

/** The enemies on the field now; none between battles */
export function enemies(): EnemyPokemon[] {
  try {
    return globalScene.getEnemyField().filter(enemy => enemy?.isActive(true));
  } catch {
    return [];
  }
}

export function runInfo(): RunInfo {
  const battle = globalScene.currentBattle;
  let biome = "";
  try {
    biome = getBiomeName(globalScene.arena.biomeId);
  } catch {
    biome = "";
  }
  return { wave: battle?.waveIndex ?? 0, biome, money: globalScene.money ?? 0, turn: battle?.turn ?? 0 };
}

const STATUS_SHORT: Partial<Record<StatusEffect, string>> = {
  [StatusEffect.POISON]: "PSN",
  [StatusEffect.TOXIC]: "TOX",
  [StatusEffect.PARALYSIS]: "PAR",
  [StatusEffect.SLEEP]: "SLP",
  [StatusEffect.FREEZE]: "FRZ",
  [StatusEffect.BURN]: "BRN",
};

const statusOf = (pokemon: Pokemon): string | null => STATUS_SHORT[pokemon.status?.effect ?? StatusEffect.NONE] ?? null;

/** The party icons, cut from the game's atlases once */
const icons = new Map<string, string | null>();

/** The icon of an atlas frame as an image address, cut once; `null` where there is none (or no canvas: tests) */
function atlasIconUrl(key: string, frameName: string): string | null {
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) {
    return null;
  }
  try {
    const cacheKey = `${key}/${frameName}`;
    if (icons.has(cacheKey)) {
      return icons.get(cacheKey) ?? null;
    }
    const texture = globalScene.textures.exists(key) ? globalScene.textures.get(key) : null;
    if (texture === null || !texture.has(frameName)) {
      return null;
    }
    const frame = texture.get(frameName);
    const canvas = document.createElement("canvas");
    canvas.width = frame.cutWidth;
    canvas.height = frame.cutHeight;
    const context = canvas.getContext("2d");
    if (context === null) {
      return null;
    }
    context.drawImage(
      frame.source.image as CanvasImageSource,
      frame.cutX,
      frame.cutY,
      frame.cutWidth,
      frame.cutHeight,
      0,
      0,
      frame.cutWidth,
      frame.cutHeight,
    );
    const url = canvas.toDataURL();
    icons.set(cacheKey, url);
    return url;
  } catch {
    return null;
  }
}

function iconOf(url: string | null, className: string): HTMLElement {
  if (url === null) {
    return el("span", className);
  }
  const image = el("img", className);
  image.src = url;
  image.alt = "";
  return image;
}

export function pokemonIcon(pokemon: Pokemon, className = "cdw-icon"): HTMLElement {
  let url: string | null = null;
  try {
    url = atlasIconUrl(pokemon.getIconAtlasKey(), pokemon.getIconId());
  } catch {
    url = null;
  }
  return iconOf(url, className);
}

/** The icon of a species, its first form (a planned enemy: no Pokémon is made yet) */
export function speciesIcon(speciesId: number, className = "cdw-icon"): HTMLElement {
  let url: string | null = null;
  try {
    const species = speciesDataRegistry.getSpecies(speciesId);
    url = atlasIconUrl(species.getIconAtlasKey(0, false, 0), species.getIconId(false, 0, false, 0));
  } catch {
    url = null;
  }
  return iconOf(url, className);
}

export function hpBar(pokemon: Pokemon): HTMLElement {
  const ratio = pokemon.getMaxHp() > 0 ? pokemon.hp / pokemon.getMaxHp() : 0;
  const fill = el("i", ratio <= 0.25 ? "cdw-low" : ratio <= 0.5 ? "cdw-mid" : "");
  fill.style.width = `${Math.round(ratio * 100)}%`;
  return el("span", "cdw-bar", fill);
}

function bossBars(enemy: EnemyPokemon): HTMLElement | null {
  if (!enemy.isBoss() || enemy.bossSegments <= 1) {
    return null;
  }
  const bars = el("span", "cdw-boss");
  for (let index = 0; index < enemy.bossSegments; index++) {
    bars.append(el("i", index <= enemy.bossSegmentIndex ? "" : "cdw-gone"));
  }
  return bars;
}

/** @returns The name of the player a Pokémon belongs to, and whether it is the host's (this client's) */
export function ownerTag(pokemon: PlayerPokemon): { name: string; mine: boolean } {
  const session = getCoopSession();
  const seat = ownerOf(pokemon);
  if (session === null || seat === null) {
    return { name: "", mine: false };
  }
  return { name: session.nameOf(seat), mine: seat === "host" };
}

function partyCard(pokemon: PlayerPokemon, onPick: (pokemon: PlayerPokemon) => void): HTMLElement {
  const owner = ownerTag(pokemon);
  const tag = el("span", `cdw-tag${owner.mine ? " cdw-me" : ""}${pokemon.isOnField() ? " cdw-field" : ""}`, owner.name);
  const status = statusOf(pokemon);
  const node = el(
    "button",
    `cdw-mon${pokemon.id === view.selected ? " cdw-sel" : ""}${pokemon.isFainted() ? " cdw-fainted" : ""}`,
    pokemonIcon(pokemon),
    el("span", "cdw-name", el("span", "", pokemon.name), el("span", "cdw-lv", `Lv ${pokemon.level}`), tag),
    el(
      "span",
      "cdw-hp",
      hpBar(pokemon),
      `${pokemon.hp}/${pokemon.getMaxHp()}`,
      status === null ? null : el("span", "cdw-status", status),
    ),
  );
  node.type = "button";
  node.title = t("EditHint", "Edit this Pokémon");
  node.addEventListener("click", () => onPick(pokemon));
  return node;
}

function enemyCard(enemy: EnemyPokemon, onPick: () => void): HTMLElement {
  const status = statusOf(enemy);
  const node = el(
    "button",
    "cdw-mon",
    pokemonIcon(enemy),
    el(
      "span",
      "cdw-name",
      el("span", "", enemy.name),
      el("span", "cdw-lv", `Lv ${enemy.level}`),
      enemy.isBoss() ? el("span", "cdw-tag", t("Boss", "boss")) : null,
    ),
    el(
      "span",
      "cdw-hp",
      hpBar(enemy),
      `${Math.round((enemy.hp / Math.max(1, enemy.getMaxHp())) * 100)}%`,
      bossBars(enemy),
      status === null ? null : el("span", "cdw-status", status),
    ),
  );
  node.type = "button";
  node.addEventListener("click", onPick);
  return node;
}

/** @returns What the field has: its weather and terrain, with the turns they have left */
export function fieldInfo(): string[] {
  const lines: string[] = [];
  try {
    const { weather, terrain } = globalScene.arena;
    if (weather != null) {
      lines.push(
        `${titleOf(WeatherType[weather.weatherType])}${weather.turnsLeft > 0 ? ` · ${t("TurnsLeft", "{{n}} turns", { n: weather.turnsLeft })}` : ""}`,
      );
    }
    if (terrain != null && terrain.terrainType !== TerrainType.NONE) {
      lines.push(
        `${titleOf(TerrainType[terrain.terrainType])} ${t("TerrainWord", "terrain")}${terrain.turnsLeft > 0 ? ` · ${t("TurnsLeft", "{{n}} turns", { n: terrain.turnsLeft })}` : ""}`,
      );
    }
  } catch {
    // no battle
  }
  return lines;
}

/** The left column: our team, the enemies, the field */
export function liveColumn(onPokemon: (pokemon: PlayerPokemon) => void, onEnemies: () => void): HTMLElement[] {
  const members = party();
  const foes = enemies();
  const field = fieldInfo();
  return [
    el(
      "div",
      "cdw-group",
      el("div", "cdw-h", t("OurTeam", "Our team"), el("small", "", t("Live", "live"))),
      ...members.map(pokemon => partyCard(pokemon, onPokemon)),
    ),
    el(
      "div",
      "cdw-group",
      el("div", "cdw-h", t("Enemies", "Enemies"), el("small", "", t("Live", "live"))),
      ...(foes.length === 0
        ? [el("div", "cdw-note", t("NoBattle", "No battle right now."))]
        : foes.map(enemy => enemyCard(enemy, onEnemies))),
      field.length === 0
        ? null
        : el("div", "cdw-note", ...field.flatMap((line, index) => (index === 0 ? [line] : [el("br"), line]))),
    ),
  ];
}

/** @returns A string that changes whenever what the live side shows changes */
export function liveSignature(): string {
  const mon = (pokemon: Pokemon) => [
    pokemon.id,
    pokemon.name,
    pokemon.level,
    pokemon.hp,
    pokemon.getMaxHp(),
    pokemon.status?.effect ?? 0,
    pokemon.isOnField(),
    pokemon.getIconId(),
  ];
  try {
    return JSON.stringify([
      runInfo(),
      party().map(pokemon => [...mon(pokemon), ownerOf(pokemon)]),
      enemies().map(enemy => [...mon(enemy), enemy.bossSegmentIndex]),
      fieldInfo(),
      view.selected,
    ]);
  } catch {
    return "";
  }
}
