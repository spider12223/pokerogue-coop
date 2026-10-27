/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * The link to the source of this build (DECISIONS D25): where the title screen sends a player who wants it, as the AGPL asks of
 * a service that runs a modified version.
 * @param configured - `VITE_SOURCE_URL`
 * @returns The address, or `null` where there is none (a development build) or it is not a web address
 */
export function sourceUrlOf(configured: string | undefined): string | null {
  if (configured === undefined || configured.trim() === "") {
    return null;
  }
  try {
    const url = new URL(configured.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
