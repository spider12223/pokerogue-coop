/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import i18next from "i18next";

/**
 * Text of the co-op UI (the leaf that the bridge, the waiting clock and the hotkeys all read, so none of them imports another
 * for a string).
 * @module
 */

/** Text of the co-op UI. The locales are upstream's, so these have English defaults and no translations yet. */
export function coopText(key: string, defaultValue: string, vars: Record<string, string | number> = {}): string {
  return i18next.t(`coop:${key}`, { defaultValue, ...vars });
}

/**
 * What a waiting player is told they can do (D17)
 * @param key - The key that pings, as the player set it; `null` if none
 */
export function pingHint(key: string | null = "P"): string {
  return key === null
    ? coopText("pingHintUnbound", "Give Ping a key in the keyboard settings to nudge them.")
    : coopText("pingHint", "Press {{key}} to nudge them.", { key });
}
