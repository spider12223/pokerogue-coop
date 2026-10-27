/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Seat } from "#coop/protocol";

/**
 * Seat tokens in local storage (DECISIONS D20). The relay hands each player a token when they take a seat; with it a tab
 * that was reloaded or reopened takes the seat back, in the same room, without a code. One entry per room, keyed by the
 * room code, so a stale one for another room never blocks a new game.
 *
 * `Storage` is injected: this module has no game imports and runs in plain Node.
 *
 * @module
 */

/** The part of `Storage` this module reads and writes */
export interface KeyValueStore {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A seat in a room, as the relay gave it */
export interface SeatRecord {
  code: string;
  seat: Seat;
  /** The secret that takes the seat back */
  token: string;
  /** The relay the room is on (a player may move between relays; a token only works on its own) */
  relayUrl: string;
  /** When it was stored (ms since the epoch), to pick the newest */
  savedAt: number;
  /** What the partner is called (D1), to say who is awaited before the handshake tells it again */
  partnerName?: string;
}

export const SEAT_KEY_PREFIX = "coopSeat:";

function keyOf(code: string): string {
  return `${SEAT_KEY_PREFIX}${code}`;
}

export function isSeatRecord(value: unknown): value is SeatRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["code"] === "string"
    && record["code"].length > 0
    && (record["seat"] === "host" || record["seat"] === "guest")
    && typeof record["token"] === "string"
    && record["token"].length > 0
    && typeof record["relayUrl"] === "string"
    && typeof record["savedAt"] === "number"
    && (record["partnerName"] === undefined || typeof record["partnerName"] === "string")
  );
}

/** Remember a seat. Storage that refuses (full, private mode) is not an error: the player just cannot rejoin by themselves. */
export function saveSeat(store: KeyValueStore, record: SeatRecord): boolean {
  try {
    store.setItem(keyOf(record.code), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** Forget the seat of a room (the room is over, the relay refused the token, or the player left) */
export function forgetSeat(store: KeyValueStore, code: string): void {
  try {
    store.removeItem(keyOf(code));
  } catch {
    // nothing to forget
  }
}

/** Forget every seat */
export function forgetAllSeats(store: KeyValueStore): void {
  for (const record of listSeats(store)) {
    forgetSeat(store, record.code);
  }
}

/** @returns Every well-formed seat in the store, newest first. Damaged entries are removed. */
export function listSeats(store: KeyValueStore): SeatRecord[] {
  const records: SeatRecord[] = [];
  const damaged: string[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key === null || !key.startsWith(SEAT_KEY_PREFIX)) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(store.getItem(key) ?? "null");
        if (isSeatRecord(parsed) && keyOf(parsed.code) === key) {
          records.push(parsed);
        } else {
          damaged.push(key);
        }
      } catch {
        damaged.push(key);
      }
    }
    for (const key of damaged) {
      store.removeItem(key);
    }
  } catch {
    // an unreadable store has no seats
  }
  return records.sort((a, b) => b.savedAt - a.savedAt);
}

/** @returns The seat to rejoin at boot: the newest one, or `null` */
export function newestSeat(store: KeyValueStore): SeatRecord | null {
  return listSeats(store)[0] ?? null;
}
