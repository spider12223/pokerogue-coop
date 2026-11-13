/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { eventBus } from "#app/event-bus";
import { globalScene } from "#app/global-scene";
import { settings } from "#app/global-settings-manager";
import { drawPixels, MARK_COLORS } from "#coop/cosmetic/cosmetic-tag";
import { isCoop } from "#coop/session";
import type { Pokemon } from "#field/pokemon";
import type { SettingsUpdateEventArgs } from "#types/event-bus-types";
import type { BattleInfo } from "#ui/battle-info";

/**
 * The hide button of the HP boxes (DECISIONS D44): a small eye on every box (an enemy's on its level's row, before its type
 * badge; ours next to its name). It slides its box off the screen's edge until only the type and the eye, closed, are left
 * there (ours goes before our type icons then); pressed again, the box comes back. A place of the field stays hidden for
 * the next Pokémon there, and in this browser. Only this client's screen changes.
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
/** The eye, open (the box is there) and closed (it is away): rows of pixels, `#` on */
const OPEN_EYE = ["..###..", ".#####.", "###.###", ".#####.", "..###.."];
const CLOSED_EYE = [".......", "#.....#", ".#####.", "..#.#..", "......."];
const EYE_WIDTH = 7;
const EYE_COLOR = 0xf8f8f8;
/** What a press of the eye hits: a little more than the eye */
const HIT_WIDTH = 11;
const HIT_HEIGHT = 9;
/** Our type icons are 20 wide (`pbinfo_player_type`); they move with the box's size (`PlayerBattleInfo.setMini`) */
const PLAYER_TYPE_WIDTH = 20;
/** How far an enemy's eye stands from the screen's edge once its box is away (our type icons end at the edge) */
const EDGE_GAP = 1;
/** What our name's row leaves after it in co-op for the eye: 1 apart, then the eye and its outline */
export const HIDE_EYE_ROOM = 1 + EYE_WIDTH + 2;
const SLIDE_MS = 250;

let hidden = readHidden();
/** How far each box is moved now (0: in its place) */
const shifts = new WeakMap<BattleInfo, number>();
const handles = new WeakMap<BattleInfo, Handle>();

interface Handle {
  container: Phaser.GameObjects.Container;
  eye: Phaser.GameObjects.Graphics;
  player: boolean;
  /** Whether the box is away (as last put) */
  away: boolean;
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
  return isCoop() && settings.coop.boxHandles && hidden.has(placeOf(pokemon));
}

/** @returns How far the box is moved off its place now (an enemy's to the left, ours to the right); 0 in its place */
export function boxShiftOf(info: BattleInfo): number {
  return shifts.get(info) ?? 0;
}

/** @returns The box's hide eye, `null` if it has none (solo play) */
export function hideButtonOf(info: BattleInfo): Phaser.GameObjects.Container | null {
  return handles.get(info)?.container ?? null;
}

/** The box's type icons (its own, protected) */
type TypeIcons = Record<"type1Icon" | "type2Icon" | "type3Icon", Phaser.GameObjects.Sprite>;

function typeIcon(info: BattleInfo, n: 1 | 2 | 3): Phaser.GameObjects.Sprite {
  return (info as unknown as TypeIcons)[`type${n}Icon`];
}

/** Our name's row: the name, its gender sign and the icons after them (tera, fusion, shiny); the level is on it too */
type NameRow = Record<"genderText", Phaser.GameObjects.Text> &
  Record<"teraIcon" | "splicedIcon" | "shinyIcon", Phaser.GameObjects.Sprite> &
  Record<"levelContainer", Phaser.GameObjects.Container>;

/** @returns Where what our name's row has ends: the gender sign after the name, or the last icon after it */
function nameRowEnd(info: BattleInfo): number {
  const row = info as unknown as NameRow;
  let end = row.genderText.x + row.genderText.displayWidth;
  for (const icon of [row.teraIcon, row.splicedIcon, row.shinyIcon]) {
    if (icon.visible) {
      end = Math.max(end, icon.x + icon.displayWidth);
    }
  }
  return end;
}

/**
 * Where the eye is in the box (its middle): an enemy's on its level's row, between the level and the type badge (which
 * starts at -15; the type effectiveness window goes to its right). Ours next to the name, on its row (the level's middle),
 * 1 past what the row has; while the box is away, at the screen's edge with our type icons, the only part of it left
 * there: just before them (a third type's is left of the others), by the lower one (its art is rows 1 to 13)
 */
function eyePlace(info: BattleInfo, player: boolean, away: boolean): [number, number] {
  if (!player) {
    return [-22, -5];
  }
  if (away) {
    const first = typeIcon(info, typeIcon(info, 3).visible ? 3 : 1);
    return [first.x - 6, typeIcon(info, 2).y + 7];
  }
  const row = info as unknown as NameRow;
  return [Math.ceil(nameRowEnd(info)) + 1 + 1 + Math.floor(EYE_WIDTH / 2), Math.round(row.levelContainer.y)];
}

function drawEye(eye: Phaser.GameObjects.Graphics, open: boolean): void {
  const rows = open ? OPEN_EYE : CLOSED_EYE;
  const left = -Math.floor(EYE_WIDTH / 2);
  const top = -Math.floor(rows.length / 2);
  eye.clear();
  // a dark outline, so it reads on the box and on the sky
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]) {
    drawPixels(eye, rows, left + dx, top + dy, MARK_COLORS.shadow);
  }
  drawPixels(eye, rows, left, top, EYE_COLOR);
  if (open) {
    // the pupil
    eye.fillStyle(MARK_COLORS.shadow, 1);
    eye.fillRect(left + 3, top + 2, 1, 1);
  }
}

/**
 * How far the box goes so that only the eye and the type are left, at the screen's edge: an enemy's from its eye on, ours up
 * to the end of our type icons' art (in the small box our name starts right after it)
 * @param eyeX - Where the eye's middle is in the box
 * @param arriving - How much further the game will move the box as it shows it
 */
function hiddenShift(info: BattleInfo, player: boolean, eyeX: number, arriving: number): number {
  const rest = info.x - boxShiftOf(info) + arriving;
  const scale = info.scaleX || 1;
  if (player) {
    const typesEnd = typeIcon(info, 1).x + PLAYER_TYPE_WIDTH;
    return Math.round(globalScene.scaledCanvas.width - (rest + typesEnd * scale));
  }
  return Math.round(EDGE_GAP - (rest + (eyeX - (EYE_WIDTH + 1) / 2) * scale));
}

function makeHandle(info: BattleInfo, pokemon: Pokemon): Handle {
  // (the press is caught a little around the eye: it is only 7 by 5)
  const hit = globalScene.add.rectangle(0, 0, HIT_WIDTH, HIT_HEIGHT, 0x000000, 0.001).setOrigin(0.5);
  const eye = globalScene.add.graphics();
  const container = globalScene.add.container(0, 0, [hit, eye]).setName("coop_hide");
  hit.setInteractive({ useHandCursor: true }).on("pointerdown", () => {
    const owner = pokemonOf(info) ?? pokemon;
    toggleBoxHidden(owner);
  });
  info.add(container);
  const handle = { container, eye, player: pokemon.isPlayer(), away: false };
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
  // (the Co-op settings can take the buttons off: every box is then shown, D47)
  const away = settings.coop.boxHandles && hidden.has(placeOf(pokemon));
  handle.away = away;
  handle.container.setVisible(settings.coop.boxHandles);
  const [x, y] = eyePlace(info, player, away);
  handle.container.setPosition(x, y);
  // open while the box is there, closed while it is away
  drawEye(handle.eye, !away);
  // (a box on screen that is sliding has no rest position to measure from: it keeps the shift it has)
  if (instant && info.visible && globalScene.tweens.getTweensOf(info).length > 0) {
    return;
  }
  // a boss's box comes in 48 further right than it went out (`Pokemon.showInfo`)
  const arriving = !info.visible && !player && pokemon.isBoss() ? 48 : 0;
  moveBox(info, away ? hiddenShift(info, player, x, arriving) : 0, instant);
}

/**
 * The box changed size (`PlayerBattleInfo.setMini`: doubles' small box, the full one for a Pokémon alone in the middle) and
 * its type icons moved: the eye follows them, and so does a box that is away. A box not shown yet waits for its showing.
 */
export function boxResized(pokemon: Pokemon): void {
  const info = pokemon.getBattleInfo();
  if (info !== undefined && handles.has(info)) {
    syncHideButton(pokemon);
  }
}

/** The box laid its name's row out again (`Pokemon.updateInfo`: a name, a tera, a shiny's star): the eye follows it */
export function placeHideEye(info: BattleInfo): void {
  const handle = handles.get(info);
  if (handle !== undefined) {
    const [x, y] = eyePlace(info, handle.player, handle.away);
    handle.container.setPosition(x, y);
  }
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
  if (instant) {
    info.x += delta;
    return;
  }
  globalScene.tweens.add({ targets: info, x: `+=${delta}`, duration: SLIDE_MS, ease: "Sine.easeInOut" });
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

// What this player sees follows the Co-op settings at once (D47)
eventBus.on("settings/update/success", ({ category, key }: SettingsUpdateEventArgs) => {
  if (category === "coop" && key === "boxHandles" && isCoop() && globalScene?.currentBattle != null) {
    for (const pokemon of globalScene.getField(true)) {
      syncHideButton(pokemon, false);
    }
  }
});
