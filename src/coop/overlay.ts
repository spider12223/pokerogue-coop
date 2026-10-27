/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { UiMode } from "#enums/ui-mode";
import type { OptionSelectItem } from "#types/ui-types";

/**
 * A small menu over whatever is on screen: the offer to take over, the take over menus, the emote wheel (DECISIONS D16,
 * D17). Choosing an option closes the menu, and so does the returned function.
 *
 * The UI cannot go back from an overlay that was opened over the message box by itself: the message box is the mode `0`,
 * which the mode chain does not keep. This puts the message box back instead, and goes back for any other mode.
 *
 * @module
 */

/**
 * Show a menu.
 * @param options - What can be chosen; each handler runs after the menu is closed
 * @returns A function that closes the menu if it is still open
 */
export function showOverlayMenu(options: OptionSelectItem[], maxOptions = options.length): () => void {
  const { ui } = globalScene;
  const base = ui.mode;
  let open = true;
  const close = (): void => {
    if (!open) {
      return;
    }
    open = false;
    if (ui.mode !== UiMode.OPTION_SELECT) {
      return;
    }
    if (base === UiMode.MESSAGE) {
      void ui.setMode(UiMode.MESSAGE);
    } else {
      void ui.revertMode();
    }
  };
  const wrapped = options.map(option => ({
    ...option,
    handler: () => {
      close();
      return option.handler();
    },
  }));
  void ui.setOverlayMode(UiMode.OPTION_SELECT, { options: wrapped, yOffset: 48, maxOptions });
  return close;
}
