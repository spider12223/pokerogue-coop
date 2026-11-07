/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * The title screen's "Players Online" in co-op (DECISIONS D46): the website's relay counts the players connected to it (in a
 * game, in a lobby, or searching for a partner). A self-hosted relay (the Windows pack, Docker) is not asked: it would only
 * ever count the few people using it, so the label keeps the game's "?" there.
 *
 * @module
 */

import { onlineUrlFor } from "#coop/transport/relay-url";

/** How long the title screen waits for the count before it gives up (it asks again a minute later) */
const ONLINE_TIMEOUT_MS = 10_000;

/**
 * The relay whose count the title screen shows: the one built into the website, none without one
 * @param configured - `VITE_COOP_RELAY_URL`
 */
export function playersOnlineRelay(configured: string | undefined): string | null {
  const relay = configured?.trim() ?? "";
  return relay === "" ? null : relay;
}

/** The count in the relay's answer, or `null` for anything that is not a whole number of players */
export function parsePlayersOnline(body: unknown): number | null {
  const players = typeof body === "object" && body !== null ? (body as { players?: unknown }).players : undefined;
  return typeof players === "number" && Number.isSafeInteger(players) && players >= 0 ? players : null;
}

/**
 * Ask the relay how many players are connected to it
 * @param relayUrl - The relay's URL (`wss://.../coop`)
 * @param fetcher - `fetch`
 * @returns The count, or `null` when the relay has none or did not answer
 */
export async function fetchPlayersOnline(relayUrl: string, fetcher: typeof fetch = fetch): Promise<number | null> {
  try {
    const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ONLINE_TIMEOUT_MS) : null;
    const response = await fetcher(onlineUrlFor(relayUrl), { signal });
    return response.ok ? parsePlayersOnline(await response.json()) : null;
  } catch {
    return null;
  }
}
