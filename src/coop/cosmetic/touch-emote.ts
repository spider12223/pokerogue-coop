/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * The emote and ping buttons of a touch screen (DECISIONS D16): two small buttons of the on-screen pad
 * (`#coopEmoteTouch` and `#coopPingTouch` in `index.html`, bound to `Button.COOP_EMOTE` and `Button.COOP_PING` like the
 * others) that open the emote wheel and ping. A touch screen has no key for them. They are in the page all the time and
 * shown only while a co-op run is linked, and only where the pad itself is shown.
 *
 * @module
 */

/** The class of `#touchControls` while a co-op run is linked; `index.css` shows the button for it */
export const TOUCH_EMOTE_CLASS = "coop-linked";

/** Show the emote button (a co-op run is linked) or take it away (it is over) */
export function setTouchEmoteVisible(visible: boolean): void {
  if (typeof document === "undefined") {
    return;
  }
  document.getElementById("touchControls")?.classList.toggle(TOUCH_EMOTE_CLASS, visible);
}
