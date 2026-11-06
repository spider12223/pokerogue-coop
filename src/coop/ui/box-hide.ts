/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { isCoop } from "#coop/session";
import type { Pokemon } from "#field/pokemon";
import type { BattleInfo } from "#ui/battle-info";

/**
 * The hide button of the HP boxes (DECISIONS D44): a small handle at the inner end of every box (enemies' and ours). It
 * slides its box off the screen's edge, until only the handle is left there; pressed again, the box comes back. A place of
 * the field stays hidden for the next Pokémon there, and in this browser. Only this client's screen changes.
 *
 * The box is moved by relative amounts, as the game moves it (`Pokemon.showInfo`, `hideInfo`): the two add up, so a hidden
 * box stays hidden through the game's own slides in and out.
 *
 * @module
 */

/** Where the hidden places are kept in this browser */
export const HIDDEN_BOXES_KEY = "coopHiddenBoxes";

/** A place of the field: whose side, and the field index */
type BoxPlace = `${"player" | "enemy"}:${number}`;

const PLACE = /^(player|enemy):[0-2]$/;
const HANDLE_WIDTH = 9;
const HANDLE_HEIGHT = 13;
/** How far the handle stands from the screen's edge once its box is away */
const EDGE_GAP = 1;
const SLIDE_MS = 250;

let hidden = readHidden();
/** How far each box is moved now (0: in its place) */
const shifts = new WeakMap<BattleInfo, number>();
const handles = new WeakMap<BattleInfo, Handle>();

interface Handle {
  container: Phaser.GameObjects.Container;
  arrow: Phaser.GameObjects.Image;
}

function readHidden(): Set<BoxPlace> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HIDDEN_BOXES_KEY) ?? "[]");
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((entry): entry is BoxPlace => typeof entry === "string" && PLACE.test(entry)));
    }
  } catch {
    // nothing kept, or not ours
  }
  return new Set();
}

function saveHidden(): void {
  try {
    localStorage.setItem(HIDDEN_BOXES_KEY, JSON.stringify([...hidden].sort()));
  } catch {
    // a browser that keeps nothing: hidden for this page only
  }
}

/** Read the hidden places from this browser again */
export function loadHiddenBoxes(): void {
  hidden = readHidden();
}

function placeOf(pokemon: Pokemon): BoxPlace {
  return `${pokemon.isPlayer() ? "player" : "enemy"}:${pokemon.getFieldIndex()}`;
}

/** @returns Whether the box of this Pokémon's place is hidden on this client */
export function isBoxHidden(pokemon: Pokemon): boolean {
  return isCoop() && hidden.has(placeOf(pokemon));
}

/** @returns How far the box is moved off its place now (an enemy's to the left, ours to the right); 0 in its place */
export function boxShiftOf(info: BattleInfo): number {
  return shifts.get(info) ?? 0;
}

/** @returns The box's hide handle, `null` if it has none (solo play) */
export function hideButtonOf(info: BattleInfo): Phaser.GameObjects.Container | null {
  return handles.get(info)?.container ?? null;
}

/**
 * The handle's place in the box: 2 past the type icons at its inner end (an enemy's end 5 past the box, ours start at -139),
 * further for a third type
 */
function handleX(info: BattleInfo, player: boolean): number {
  const third = (info.getByName("icon_type_3") as Phaser.GameObjects.Sprite | null)?.visible ?? false;
  if (player) {
    return third ? -165 : -150;
  }
  return third ? 22 : 7;
}

/**
 * How far the box goes so that only its handle is left, at the screen's edge
 * @param arriving - How much further the game will move the box as it shows it
 */
function hiddenShift(info: BattleInfo, player: boolean, x: number, arriving: number): number {
  const rest = info.x - boxShiftOf(info) + arriving;
  const scale = info.scaleX || 1;
  if (player) {
    const edge = globalScene.scaledCanvas.width - HANDLE_WIDTH * scale - EDGE_GAP;
    return Math.round(edge - (rest + x * scale));
  }
  return Math.round(EDGE_GAP - (rest + x * scale));
}

function makeHandle(info: BattleInfo, pokemon: Pokemon): Handle {
  const frame = globalScene.add
    .rectangle(0, 0, HANDLE_WIDTH, HANDLE_HEIGHT, 0x303048, 0.9)
    .setOrigin(0, 0.5)
    .setStrokeStyle(1, 0xd8d8e0);
  const arrow = globalScene.add
    .image(HANDLE_WIDTH / 2, 0, "cursor")
    .setOrigin(0.5)
    .setScale(0.7);
  const container = globalScene.add.container(0, 0, [frame, arrow]).setName("coop_hide");
  frame.setInteractive({ useHandCursor: true }).on("pointerdown", () => {
    const owner = pokemonOf(info) ?? pokemon;
    toggleBoxHidden(owner);
  });
  info.add(container);
  const handle = { container, arrow };
  handles.set(info, handle);
  return handle;
}

/** The Pokémon a box belongs to now: the field's Pokémon whose box it is */
function pokemonOf(info: BattleInfo): Pokemon | undefined {
  return globalScene.getField(true).find(pokemon => pokemon.getBattleInfo() === info);
}

/**
 * Put the box where its place says (hidden or not), with its handle; the box is shown, or its Pokémon's types changed.
 * Nothing in solo play.
 * @param pokemon - The Pokémon whose box it is
 * @param instant - Move it at once (before the game slides the box in) rather than slide it
 */
export function syncHideButton(pokemon: Pokemon, instant = true): void {
  if (!isCoop()) {
    return;
  }
  const info = pokemon.getBattleInfo();
  if (info === undefined) {
    return;
  }
  const player = pokemon.isPlayer();
  const handle = handles.get(info) ?? makeHandle(info, pokemon);
  const x = handleX(info, player);
  handle.container.setX(x);
  const away = hidden.has(placeOf(pokemon));
  // the arrow says where the box goes: out to its edge, or back in
  handle.arrow.setTexture(player === away ? "cursor_reverse" : "cursor");
  // (a box on screen that is sliding has no rest position to measure from: it keeps the shift it has)
  if (instant && info.visible && globalScene.tweens.getTweensOf(info).length > 0) {
    return;
  }
  // a boss's box comes in 48 further right than it went out (`Pokemon.showInfo`)
  const arriving = !info.visible && !player && pokemon.isBoss() ? 48 : 0;
  moveBox(info, away ? hiddenShift(info, player, x, arriving) : 0, instant);
}

/** The box was put at its place outright (a battle of three moves the enemy boxes, D40): it is moved by nothing now */
export function resetBoxShift(info: BattleInfo): void {
  shifts.delete(info);
}

function moveBox(info: BattleInfo, target: number, instant: boolean): void {
  const delta = target - boxShiftOf(info);
  shifts.set(info, target);
  if (delta === 0) {
    return;
  }
  // (a player's box has the mask of its EXP bar beside it, which the game moves with it)
  const targets = info.expMaskRect ? [info, info.expMaskRect] : [info];
  if (instant) {
    for (const object of targets) {
      object.x += delta;
    }
    return;
  }
  globalScene.tweens.add({ targets, x: `+=${delta}`, duration: SLIDE_MS, ease: "Sine.easeInOut" });
}

/**
 * The hide handle was pressed: the box of this Pokémon's place goes away, or comes back.
 * @returns Whether it did (not in solo play, nor while the box is sliding)
 */
export function toggleBoxHidden(pokemon: Pokemon): boolean {
  const info = pokemon.getBattleInfo();
  if (!isCoop() || info === undefined || !handles.has(info) || globalScene.tweens.getTweensOf(info).length > 0) {
    return false;
  }
  const place = placeOf(pokemon);
  if (!hidden.delete(place)) {
    hidden.add(place);
  }
  saveHidden();
  syncHideButton(pokemon, false);
  return true;
}
