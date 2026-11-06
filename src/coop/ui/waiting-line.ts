/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { UiMode } from "#enums/ui-mode";

/**
 * The line a waiting player reads in the message box ("Waiting for your partner…", "{partner} is choosing the next biome…",
 * the AFK hints of D17). It goes once the wait is over, unless another line replaced it meanwhile: without that it stayed
 * until the next line of the game, and a line that was still being typed went on typing over what came next.
 *
 * A leaf: the bridge and the AFK watcher both use it.
 * @module
 */

/** The waiting line that was put in the message box last, while it may still be there */
let waitingLine: string | null = null;

/** Show a waiting line once the message box is up (a screen that is fading out would take a line written into it along) */
export function showWaitingLine(text: string): void {
  const { ui } = globalScene;
  waitingLine = text;
  void ui.setMode(UiMode.MESSAGE).then(() => {
    if (waitingLine === text) {
      ui.showText(text, null, undefined, null, false);
    }
  });
}

/** A waiting line was written into the message box that is up */
export function noteWaitingLine(text: string): void {
  waitingLine = text;
}

/** Whitespace as the message box wraps it */
const flat = (text: string): string => text.replace(/\s+/g, " ");

/** The wait is over: its line goes, typed out or not, if it is still the one in the message box */
export function clearWaitingLine(): void {
  const line = waitingLine;
  waitingLine = null;
  const { ui } = globalScene;
  if (line === null || ui?.mode !== UiMode.MESSAGE) {
    return;
  }
  const shown = ui.getMessageHandler().message.text;
  if (flat(line).startsWith(flat(shown))) {
    // A new, empty line: it also stops the typing of the old one
    ui.showText("", 0);
  }
}
