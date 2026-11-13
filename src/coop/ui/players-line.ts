/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { eventBus } from "#app/event-bus";
import { globalScene } from "#app/global-scene";
import { settings } from "#app/global-settings-manager";
import { TextStyle } from "#enums/text-style";
import type { SettingsUpdateEventArgs } from "#types/event-bus-types";
import { addBBCodeTextObject } from "#ui/text";
import type BBCodeText from "phaser4-rex-plugins/plugins/bbcodetext";

/**
 * The line under the waiting text of a room of three (DECISIONS D40): who is in, each name in its player's colour. The
 * message box draws plain text only, so this line is a text object of its own over the box's second line, there until the
 * waiting ends.
 * @module
 */

/** How far the message box's second line is below its first */
const LINE_HEIGHT = 15;

let line: BBCodeText | null = null;

/** Show (or change) the line; `text` may have colour tags */
export function showPlayersLine(text: string): void {
  // (the Co-op settings can take the line off, D47)
  if (!settings.coop.playersLine) {
    hidePlayersLine();
    return;
  }
  const { message } = globalScene.ui.getMessageHandler();
  if (line === null || !line.active) {
    line = addBBCodeTextObject(message.x, message.y + LINE_HEIGHT, "", TextStyle.MESSAGE);
    message.parentContainer.add(line);
  }
  line.setText(text);
}

/** The waiting is over: the line goes */
export function hidePlayersLine(): void {
  line?.destroy();
  line = null;
}

// What this player sees follows the Co-op settings at once (D47)
eventBus.on("settings/update/success", ({ category, key, value }: SettingsUpdateEventArgs) => {
  if (category === "coop" && key === "playersLine" && value === false) {
    hidePlayersLine();
  }
});
