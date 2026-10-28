/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { SettingKeyboard } from "#system/settings-keyboard";

/**
 * What the co-op hotkeys are called, for the keyboard settings and for the hint of a waiting player (a leaf: `afk.ts` and the
 * settings screen read it, and neither may import `hotkeys.ts`, which reads them).
 *
 * @module
 */

/**
 * The rows of the keyboard settings that are not upstream's have no translation: they say what they are in English.
 * @param i18nKey - The key of the row in `settings:` (`buttonCoopPing`)
 * @returns The options of `i18next.t` for it
 */
export function coopSettingLabel(i18nKey: string): { defaultValue: string } | Record<string, never> {
  switch (i18nKey) {
    case "buttonCoopPing":
      return { defaultValue: "Co-op: ping" };
    case "buttonCoopEmote":
      return { defaultValue: "Co-op: emote" };
    case "buttonCoopChat":
      return { defaultValue: "Co-op: chat" };
    default:
      return {};
  }
}

/**
 * A keyboard mapping that a player saved before the co-op keys existed has them nowhere, and P and Q are unbound in it: the two
 * keys the game used to ping and emote with are given back to them (DECISIONS D16). A key the player has bound to something
 * else is left alone, and so is a mapping that already has the buttons (they were moved on purpose).
 * @param custom - The saved mapping, `KEY_P` to a setting name or `-1`; changed in place
 * @param isDev - A development build keeps Q for its own button
 * @returns Whether it changed
 */
export function bindCoopHotkeys(custom: Record<string, unknown>, isDev: boolean): boolean {
  if (!("KEY_P" in custom)) {
    return false; // not a keyboard mapping
  }
  const values = Object.values(custom);
  let changed = false;
  if (!values.includes(SettingKeyboard.BUTTON_COOP_PING) && custom["KEY_P"] === -1) {
    custom["KEY_P"] = SettingKeyboard.BUTTON_COOP_PING;
    changed = true;
  }
  if (!isDev && !values.includes(SettingKeyboard.BUTTON_COOP_EMOTE) && custom["KEY_Q"] === -1) {
    custom["KEY_Q"] = SettingKeyboard.BUTTON_COOP_EMOTE;
    changed = true;
  }
  // The chat box (D38) came later: H, if it is free
  if (!values.includes(SettingKeyboard.BUTTON_COOP_CHAT) && custom["KEY_H"] === -1) {
    custom["KEY_H"] = SettingKeyboard.BUTTON_COOP_CHAT;
    changed = true;
  }
  return changed;
}

/** @returns The name of the key that opens the chat box (D38), as the player set it, or `null` if it is bound to none */
export function chatKeyName(): string | null {
  try {
    const key = globalScene.inputController?.getKeyboardKeyOf(SettingKeyboard.BUTTON_COOP_CHAT);
    return key === undefined ? null : key.replace(/^KEY_/, "").replaceAll("_", " ");
  } catch {
    return "H";
  }
}

/**
 * @returns The name of the key that pings now, as the player set it ("P", "ARROW UP"), or `null` if it is bound to none; the
 * hint of a waiting player says which key to press
 */
export function pingKeyName(): string | null {
  try {
    const key = globalScene.inputController?.getKeyboardKeyOf(SettingKeyboard.BUTTON_COOP_PING);
    return key === undefined ? null : key.replace(/^KEY_/, "").replaceAll("_", " ");
  } catch {
    return "P";
  }
}
