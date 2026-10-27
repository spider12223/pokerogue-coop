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
 * Show a menu. While a co-op mode change is fading the screen, the menu waits for it and goes over the screen it brings:
 * the screen under the menu, where closing it goes back to, is read when the menu opens.
 * @param options - What can be chosen; each handler runs after the menu is closed
 * @returns A function that closes the menu if it is still open (or that it does not open, if it is still waiting)
 */
export function showOverlayMenu(options: OptionSelectItem[], maxOptions = options.length): () => void {
  const { ui } = globalScene;
  /** The screen under the menu; `null` until the menu is open */
  let base: UiMode | null = null;
  let open = true;
  const close = (): void => {
    if (!open) {
      return;
    }
    open = false;
    if (base === null || ui.mode !== UiMode.OPTION_SELECT) {
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
  const show = (): void => {
    if (!open) {
      return;
    }
    const pending = ui.pendingCoopTransition;
    if (pending !== null) {
      // The mode it lands on may be another fade's start, so this looks again once it is over
      void pending.then(show, show);
      return;
    }
    base = ui.mode;
    void ui.setOverlayMode(UiMode.OPTION_SELECT, { options: wrapped, yOffset: 48, maxOptions });
  };
  show();
  return close;
}
