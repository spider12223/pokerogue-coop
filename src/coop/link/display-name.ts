/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { cleanName, DEFAULT_NAME } from "#coop/protocol";

/**
 * This player's display name (DECISIONS D1): typed in the co-op menu, kept in the browser, sent in the handshake and
 * shown wherever the game says "{partner}". It is cosmetic: nothing in the simulation reads it.
 *
 * @module
 */

const STORAGE_KEY = "coopDisplayName";

/** @returns The saved name, or "Player" if none was set or the browser keeps nothing */
export function getCoopName(): string {
  try {
    return cleanName(localStorage.getItem(STORAGE_KEY) ?? DEFAULT_NAME);
  } catch {
    return DEFAULT_NAME;
  }
}

/**
 * Save a name.
 * @returns The name as it is kept: cleaned, and "Player" if nothing printable was typed
 */
export function setCoopName(name: string): string {
  const cleaned = cleanName(name);
  try {
    localStorage.setItem(STORAGE_KEY, cleaned);
  } catch {
    // The browser keeps nothing: the name lasts until the page is closed
  }
  return cleaned;
}
