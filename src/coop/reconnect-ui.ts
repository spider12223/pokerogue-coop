/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { showOverlayMenu } from "#coop/overlay";
import { coopText } from "#coop/text";
import { UiMode } from "#enums/ui-mode";

/**
 * The screen of a player whose partner is away (DECISIONS D20): "Waiting for {partner} to reconnect" with the room code, and
 * after a while the choice to end the session. It is the message box, nothing else: a reload follows when the partner is back,
 * and that replaces whatever was on screen.
 *
 * @module
 */

/** How long the player waits before they are offered to end the session (D20) */
export const END_SESSION_AFTER_MS = 60_000;

export interface ReconnectScreen {
  /** Who is away, as the player knows them */
  partner: string;
  /** The room code, so the partner can be told */
  code: string;
  /** The partner is back and the reload is on its way */
  back: boolean;
  /** The player chose to end the session */
  onEnd(): void;
  /** Dev and test builds can shorten the wait */
  endAfterMs?: number;
}

interface Shown {
  text: string;
  closeMenu: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
}

let shown: Shown | null = null;

function textOf(screen: ReconnectScreen): string {
  return screen.back
    ? coopText("partnerBack", "{{partner}} is back. Getting the game ready…", { partner: screen.partner })
    : coopText("waitingForReconnect", "Waiting for {{partner}} to reconnect…\nRoom code: {{code}}", {
        partner: screen.partner,
        code: screen.code,
      });
}

/** @returns What the screen says, or `null` while it is not up (for the debug API) */
export function reconnectScreenText(): string | null {
  return shown?.text ?? null;
}

/** @returns Whether the choice to end the session is on screen */
export function isEndSessionOffered(): boolean {
  return shown?.closeMenu != null;
}

function clearShown(): void {
  if (shown?.timer != null) {
    clearTimeout(shown.timer);
  }
  shown?.closeMenu?.();
}

/** After the wait, offer to end the session (or to keep waiting, which asks again after the same wait) */
function offerEnd(screen: ReconnectScreen): void {
  const current = shown;
  if (current === null) {
    return;
  }
  current.timer = setTimeout(() => {
    current.timer = null;
    current.closeMenu = showOverlayMenu([
      {
        label: coopText("endSession", "End session"),
        handler: () => {
          hideReconnectScreen();
          screen.onEnd();
          return true;
        },
      },
      {
        label: coopText("keepWaiting", "Keep waiting"),
        handler: () => {
          current.closeMenu = null;
          offerEnd(screen);
          return true;
        },
      },
    ]);
  }, screen.endAfterMs ?? END_SESSION_AFTER_MS);
}

/** Show the screen, or update it if it is up already (the text changes when the partner is back) */
export function showReconnectScreen(screen: ReconnectScreen): void {
  const text = textOf(screen);
  if (shown?.text === text) {
    return;
  }
  clearShown();
  shown = { text, closeMenu: null, timer: null };
  const { ui } = globalScene;
  // Every screen the player had open closes; the line waits for the message box, or it would be written into the closing
  // screen's own box (the party's) and go with it
  ui.clearScreensUnder();
  void ui.setMode(UiMode.MESSAGE).then(() => {
    if (shown?.text === text) {
      ui.showText(text, null, undefined, null, false);
    }
  });
  // (the partner is back but their reload does not come: the same offer, after a longer wait)
  offerEnd(screen.back ? { ...screen, endAfterMs: (screen.endAfterMs ?? END_SESSION_AFTER_MS) * 3 } : screen);
}

/** Take the screen down (the partner is back, the reload started, or the session ended) */
export function hideReconnectScreen(): void {
  clearShown();
  shown = null;
}
