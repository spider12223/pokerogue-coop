/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { type RoomSeats, roomSeats, type Seat } from "../../coop-server/src/relay-protocol.ts";

/**
 * The relay's room counter (D43): how many rooms of two and of three were opened, and how many had every seat taken. A count
 * is the event and the room's size, nothing else: no address, room code, token or game data.
 */
export type RoomEvent = "created" | "filled";

/** One count, as Workers Analytics Engine takes it */
export interface StatsPoint {
  indexes: string[];
  blobs: string[];
  doubles: number[];
}

/** The part of a Workers Analytics Engine dataset the counter uses */
export interface StatsSink {
  writeDataPoint(point: StatsPoint): void;
}

/** What the counter reads of a room: its size and whose seats are taken */
export interface CountedRoom {
  /** None on a room stored before D40: a room of two */
  size?: RoomSeats;
  seats: Partial<Record<Seat, { token: string | null }>>;
  /** Set once every seat was taken, so a room is counted as filled once (a seat freed and taken again does not count) */
  filled?: boolean;
}

/** Count a room event. A relay without the `STATS` dataset (`wrangler dev`, a copy someone hosts) counts nothing. */
export function countRoom(sink: StatsSink | undefined, event: RoomEvent, size: RoomSeats): void {
  sink?.writeDataPoint({ indexes: [event], blobs: [event, String(size)], doubles: [size] });
}

/** Whether every seat of the room is now taken for the first time; marks the room so (save it after) */
export function noteFilled(room: CountedRoom): boolean {
  if (room.filled || !roomSeats(room.size ?? 2).every(seat => room.seats[seat]?.token != null)) {
    return false;
  }
  room.filled = true;
  return true;
}
