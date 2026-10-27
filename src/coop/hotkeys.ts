/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { isLinked } from "#coop/bridge";
import type { CosmeticTarget } from "#coop/cosmetic";
import { EMOTE_COUNT } from "#coop/cosmetic";
import { emoteLabel, sendEmote, sendPing } from "#coop/cosmetic-view";
import { showOverlayMenu } from "#coop/overlay";
import { BattlerIndex } from "#enums/battler-index";
import { UiMode } from "#enums/ui-mode";
import type { ModifierSelectUiHandler } from "#ui/modifier-select-ui-handler";
import i18next from "i18next";

/**
 * The two hotkeys of the cosmetic channel (DECISIONS D16): one pings what the player's cursor is on (`P` at first),
 * one opens the emote wheel (`Q` at first). They are buttons of the game like any other, so the player moves them in the
 * keyboard settings (they are the last two rows), and there is a button for them on a touch screen. They only do something in
 * a linked co-op run, and only where a cursor or a message is on screen: never over a form where the player types.
 *
 * @module
 */

/** The screens where a hotkey does something */
const SCREENS: readonly UiMode[] = [
  UiMode.MESSAGE,
  UiMode.COMMAND,
  UiMode.FIGHT,
  UiMode.TARGET_SELECT,
  UiMode.PARTY,
  UiMode.MODIFIER_SELECT,
];

/** @returns What the player's cursor is on, for a ping; a nudge (nothing in particular) where it is on nothing */
export function pingTargetOfCursor(): CosmeticTarget {
  const { ui } = globalScene;
  switch (ui.mode) {
    case UiMode.TARGET_SELECT: {
      const cursor = ui.getHandler().getCursor();
      if (cursor >= BattlerIndex.ENEMY) {
        return { k: "enemy", index: cursor - BattlerIndex.ENEMY };
      }
      return { k: "ally", index: cursor };
    }
    case UiMode.PARTY: {
      const member = globalScene.getPlayerParty()[ui.getHandler().getCursor()];
      return member === undefined ? { k: "none" } : { k: "party", pokemonId: member.id };
    }
    case UiMode.MODIFIER_SELECT:
      return (ui.getHandler() as ModifierSelectUiHandler).getPingTarget() ?? { k: "none" };
    default:
      return { k: "none" };
  }
}

/** Ping what the cursor is on. @returns Whether the ping was sent */
export function pingNow(): boolean {
  if (!isLinked() || !SCREENS.includes(globalScene.ui.mode)) {
    return false;
  }
  return sendPing(pingTargetOfCursor());
}

/** Open the emote wheel: the six emotes in a menu over whatever is on screen. @returns Whether it opened */
export function openEmoteWheel(): boolean {
  const { ui } = globalScene;
  if (!isLinked() || !SCREENS.includes(ui.mode)) {
    return false;
  }
  const options = Array.from({ length: EMOTE_COUNT }, (_, id) => ({
    label: emoteLabel(id),
    handler: () => {
      sendEmote(id);
      return true;
    },
  }));
  options.push({ label: i18next.t("menu:cancel"), handler: () => true });
  showOverlayMenu(options);
  return true;
}
