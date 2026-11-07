/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Env } from "./shared.ts";

/**
 * The players-online count (D46): how many players are connected to the relay now, in a room or searching for a partner, for
 * the game's title screen. Each room, and the matchmaking queue, tells one object (`online.ts`) how many of its players are
 * connected whenever that changes, and again while a game goes on; what was not heard from in a while is dropped, so a room
 * that vanished without a word (a deploy) cannot stay counted. Only numbers: no room code, address or name.
 */

/** The name of the one object that keeps the count (`idFromName`) */
export const ONLINE_NAME = "count";
/** The matchmaking queue's place in the count (a room's is its object's id) */
export const ONLINE_QUEUE_KEY = "queue";
/** What was not said again for this long is dropped: as long as a room may go without a game frame before it closes */
export const ONLINE_STALE_MS = 30 * 60_000;
/** A room with players says it again at least this often while its game goes on */
export const ONLINE_REFRESH_MS = 10 * 60_000;
/** How long a Worker answers with the count it read (and a browser may keep it) */
export const ONLINE_MEMO_MS = 20_000;

/** What one room (or the queue) said: how many of its players are connected, and when */
export interface OnlineEntry {
  players: number;
  at: number;
}

/** Per room (its object's id) or the queue, what it last said */
export type OnlineBook = Record<string, OnlineEntry>;

/** Note what a room or the queue says; one with nobody connected is removed */
export function noteOnline(book: OnlineBook, key: string, players: number, now: number): void {
  const count = Number.isFinite(players) ? Math.max(0, Math.floor(players)) : 0;
  if (count === 0) {
    delete book[key];
  } else {
    book[key] = { players: count, at: now };
  }
}

/** The players connected now: of everyone heard from in the last `staleMs` (the others are removed from the book) */
export function countOnline(book: OnlineBook, now: number, staleMs: number = ONLINE_STALE_MS): number {
  let players = 0;
  for (const [key, entry] of Object.entries(book)) {
    if (now - entry.at >= staleMs) {
      delete book[key];
    } else {
      players += entry.players;
    }
  }
  return players;
}

/** Whether a room should say its count again: it last did at `last` (0: not since it woke) */
export function onlineDue(last: number, now: number): boolean {
  return last === 0 || now - last >= ONLINE_REFRESH_MS;
}

/** The count a Worker read, answered again for {@linkcode ONLINE_MEMO_MS} so that title screens do not each wake the object */
export class OnlineMemo {
  private value: { players: number; until: number } | null = null;

  get(now: number): number | undefined {
    return this.value !== null && now < this.value.until ? this.value.players : undefined;
  }

  set(players: number, now: number): void {
    this.value = { players, until: now + ONLINE_MEMO_MS };
  }
}

/** Tell the count how many players of a room (or of the queue) are connected now. It never fails the one who tells. */
export async function reportOnline(env: Env, key: string, players: number): Promise<void> {
  try {
    await env.ONLINE.get(env.ONLINE.idFromName(ONLINE_NAME)).report(key, players);
  } catch {
    // The count is for the title screen only: a room goes on without it
  }
}
