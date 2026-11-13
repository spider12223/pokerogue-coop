/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { settings } from "#app/global-settings-manager";
import { isCoop } from "#coop/session";

/**
 * Each player's zoom of the battlefield (DECISIONS D44): out to 60% in steps of 10%, with the mouse wheel over the battle or
 * two keys (numpad minus and plus at first). The field (the Pokémon, their bases, the trainers) shrinks towards the bottom
 * centre, as the game's own zoom for a big Pokémon does, and the two multiply. Only this client's screen changes; it is
 * kept in this browser. Solo play has none.
 *
 * @module
 */

/** Where the zoom is kept in this browser */
export const FIELD_ZOOM_KEY = "coopFieldZoom";
/** The furthest out a player can zoom */
export const MIN_FIELD_ZOOM = 0.6;
const STEP = 0.1;
/** A burst of wheel events (a touchpad) is one step */
const WHEEL_GAP_MS = 150;

let zoom = readZoom();
let lastWheel = Number.NEGATIVE_INFINITY;

function clampZoom(value: number): number {
  return Math.round(Math.min(1, Math.max(MIN_FIELD_ZOOM, value)) * 10) / 10;
}

function readZoom(): number {
  try {
    const value = Number.parseFloat(localStorage.getItem(FIELD_ZOOM_KEY) ?? "");
    return Number.isFinite(value) ? clampZoom(value) : 1;
  } catch {
    return 1;
  }
}

/** Read the zoom from this browser again */
export function loadFieldZoom(): void {
  zoom = readZoom();
  lastWheel = Number.NEGATIVE_INFINITY;
}

/** @returns This player's zoom of the battlefield: 1 (none) in solo play */
export function coopFieldZoom(): number {
  return isCoop() ? zoom : 1;
}

/**
 * One step out or in, and the field follows.
 * @param out - Zoom out (further away), or in
 * @returns Whether the zoom changed (not in solo play, outside a battle, or past either end)
 */
export function stepFieldZoom(out: boolean): boolean {
  if (!isCoop() || globalScene.currentBattle == null) {
    return false;
  }
  const next = clampZoom(zoom + (out ? -STEP : STEP));
  if (next === zoom) {
    return false;
  }
  zoom = next;
  try {
    localStorage.setItem(FIELD_ZOOM_KEY, String(zoom));
  } catch {
    // a browser that keeps nothing: this page only
  }
  globalScene.tweens.killTweensOf(globalScene.field);
  void globalScene.setFieldScale(globalScene.fieldScaleRequest);
  return true;
}

/**
 * The wheel turned over the game: down zooms out, up zooms in.
 * @param deltaY - The wheel's vertical movement
 * @param timeStamp - When it turned, in ms (the event's own time)
 * @returns Whether it took a step
 */
export function onFieldWheel(deltaY: number, timeStamp: number): boolean {
  if (deltaY === 0 || !isCoop() || timeStamp - lastWheel < WHEEL_GAP_MS) {
    return false;
  }
  if (!stepFieldZoom(deltaY > 0)) {
    return false;
  }
  lastWheel = timeStamp;
  return true;
}

let listening = false;

/** Listen to the wheel over the game (once: the listener does nothing outside a linked battle) */
export function listenForFieldWheel(): void {
  if (listening || globalScene.input == null) {
    return;
  }
  listening = true;
  globalScene.input.on("wheel", (pointer: Phaser.Input.Pointer, _over: unknown, _deltaX: number, deltaY: number) => {
    // (the Co-op settings can turn the wheel off; the zoom keys still work, D47)
    if (settings.coop.wheelZoom) {
      void onFieldWheel(deltaY, pointer.event?.timeStamp ?? 0);
    }
  });
}
