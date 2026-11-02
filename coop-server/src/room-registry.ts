/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Room code alphabet and registry shape adapted from SunghoLee98/pokerogue `coop-server/src/room-registry.ts`
 * (AGPL-3.0-only). Seat tokens and per-seat hold expiry are new.
 */

import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { CODE_ALPHABET, CODE_LENGTH, DEFAULT_HOLD_MS, type RoomSeats, roomSeats, type Seat } from "./relay-protocol.ts";

interface SeatState {
  /** Secret that proves ownership of the seat; `null` while the seat is free. */
  token: string | null;
  connected: boolean;
  /** When a disconnected seat stops being reserved; `null` while connected or free. */
  heldUntil: number | null;
}

interface Room {
  /** 2, or 3 with a second guest (D40) */
  size: RoomSeats;
  seats: Partial<Record<Seat, SeatState>>;
  /** When something last happened in the room: a connection, a seat change, a game frame (D23: idle rooms are closed) */
  lastActivity: number;
}

export type JoinResult = { seat: "guest" | "guest2"; token: string } | "notFound" | "full";
export type RejoinResult = { seat: Seat; wasConnected: boolean } | "notFound" | "badToken";

/** What a {@linkcode RoomRegistry.sweep} did, for the relay to act on. */
export type SweepEvent =
  /** A held seat ran out of time and is free again. */
  | { type: "seatExpired"; code: string; seat: Seat; size: RoomSeats }
  /** The room was removed: its host seat expired, or nothing happened in it for the idle time (D23). */
  | { type: "roomClosed"; code: string; reason: "hostGone" | "idle" };

export interface RoomRegistryOptions {
  /** How long a disconnected seat stays reserved. */
  holdMs?: number;
  /** A room without any activity for this long is closed (D23). Default: never. */
  idleMs?: number;
  /** Injected for tests. */
  now?: () => number;
  /** Returns a float in [0, 1). Injected for tests; defaults to a CSPRNG. */
  random?: () => number;
}

export function otherSeat(seat: Seat): Seat {
  return seat === "host" ? "guest" : "host";
}

function newToken(): string {
  return randomBytes(16).toString("hex");
}

function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Tracks rooms, seats and seat tokens. Holds no sockets, so it can be tested with an injected clock.
 *
 * Lifecycle of a seat: free -> connected (token issued) -> held (connection dropped) -> connected again (rejoin with
 * the token) or free (hold expired).
 * A held seat is reserved without a limit while the other seat is connected (D20): the player who stayed waits as long as
 * they like. The clock of `holdMs` only runs when both seats are gone, for both of them.
 * A room lives while at least one seat has a token. If the host seat expires the room is closed: the host is the
 * sequencer, so a room without it cannot continue.
 */
export class RoomRegistry {
  readonly holdMs: number;
  readonly idleMs: number;
  private readonly rooms = new Map<string, Room>();
  private readonly now: () => number;
  private readonly random: (() => number) | undefined;

  constructor(options: RoomRegistryOptions = {}) {
    this.holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
    this.idleMs = options.idleMs ?? Number.POSITIVE_INFINITY;
    this.now = options.now ?? Date.now;
    this.random = options.random;
  }

  get size(): number {
    return this.rooms.size;
  }

  /** Create a room with the host already in it: of two seats, or of three (D40) */
  createRoom(size: RoomSeats = 2): { code: string; token: string } {
    let code: string;
    do {
      code = this.generateCode();
    } while (this.rooms.has(code));
    const token = newToken();
    const seats: Partial<Record<Seat, SeatState>> = {};
    for (const seat of roomSeats(size)) {
      seats[seat] = { token: null, connected: false, heldUntil: null };
    }
    seats.host = { token, connected: true, heldUntil: null };
    this.rooms.set(code, { size, seats, lastActivity: this.now() });
    return { code, token };
  }

  /** The seats of a room, host first; none if there is no such room */
  seatsOf(code: string): readonly Seat[] {
    const room = this.rooms.get(code);
    return room === undefined ? [] : roomSeats(room.size);
  }

  /** How many seats a room has */
  sizeOf(code: string): RoomSeats | undefined {
    return this.rooms.get(code)?.size;
  }

  /** Something happened in the room (a game frame went through): it is not idle */
  touch(code: string): void {
    const room = this.rooms.get(code);
    if (room !== undefined) {
      room.lastActivity = this.now();
    }
  }

  /** Take the first free guest seat of a room. The host seat can only be taken back with its token. */
  join(code: string): JoinResult {
    const room = this.rooms.get(code);
    if (!room) {
      return "notFound";
    }
    const seat = roomSeats(room.size).find(candidate => candidate !== "host" && room.seats[candidate]?.token === null);
    const guest = seat === undefined ? undefined : room.seats[seat];
    if (seat === undefined || seat === "host" || guest === undefined) {
      return "full";
    }
    const token = newToken();
    guest.token = token;
    guest.connected = true;
    guest.heldUntil = null;
    room.lastActivity = this.now();
    return { seat, token };
  }

  /**
   * Take a seat back. Works while the seat is held and also while it is still marked connected (the relay has not
   * noticed the old connection died yet): the newer connection wins.
   */
  rejoin(code: string, seat: Seat, token: string): RejoinResult {
    const room = this.rooms.get(code);
    if (!room) {
      return "notFound";
    }
    const state = room.seats[seat];
    if (state === undefined || state.token === null || !tokensMatch(state.token, token)) {
      return "badToken";
    }
    const wasConnected = state.connected;
    state.connected = true;
    state.heldUntil = null;
    room.lastActivity = this.now();
    // This player is here again: the seats of the others who are still away are kept for as long as they stay (D20)
    for (const other of Object.values(room.seats)) {
      other.heldUntil = null;
    }
    return { seat, wasConnected };
  }

  /**
   * A seat's connection dropped. The seat stays reserved: without a limit while the other seat is connected, and for `holdMs`
   * once both are gone (the other seat's clock starts then too, if it was reserved).
   */
  disconnect(code: string, seat: Seat): void {
    const room = this.rooms.get(code);
    const state = room?.seats[seat];
    if (!room || !state || !state.connected) {
      return;
    }
    state.connected = false;
    room.lastActivity = this.now();
    if (Object.values(room.seats).some(other => other.connected)) {
      state.heldUntil = null;
      return;
    }
    this.holdAll(room);
  }

  /** Nobody is connected any more: every reserved seat gets `holdMs` from now */
  private holdAll(room: Room): void {
    const until = this.now() + this.holdMs;
    for (const other of Object.values(room.seats)) {
      if (other.token !== null) {
        other.heldUntil = until;
      }
    }
  }

  /** A player ended the session for good: the room goes at once and its tokens stop working. */
  leave(code: string): void {
    this.rooms.delete(code);
  }

  /**
   * A player ended the session for good. The host's leaving, and anyone's in a room of two, ends the room; a guest's frees
   * its seat in a room of three, whose other two go on (D40)
   */
  leaveSeat(code: string, seat: Seat): void {
    const room = this.rooms.get(code);
    const state = room?.seats[seat];
    if (room === undefined || state === undefined || seat === "host" || room.size === 2) {
      this.rooms.delete(code);
      return;
    }
    state.token = null;
    state.connected = false;
    state.heldUntil = null;
    room.lastActivity = this.now();
    if (!Object.values(room.seats).some(other => other.connected)) {
      // The last one connected left: the seats still reserved run the clock, as on a disconnect
      this.holdAll(room);
    }
  }

  /** Whether the seat belongs to a player who is away right now (with or without a clock running) */
  isReserved(code: string, seat: Seat): boolean {
    const state = this.rooms.get(code)?.seats[seat];
    return state !== undefined && state.token !== null && !state.connected;
  }

  isConnected(code: string, seat: Seat): boolean {
    return this.rooms.get(code)?.seats[seat]?.connected ?? false;
  }

  /** Whether the seat is reserved for a player who is currently away, with a clock running */
  isHeld(code: string, seat: Seat): boolean {
    return this.rooms.get(code)?.seats[seat]?.heldUntil != null;
  }

  /** Milliseconds left on a seat's hold, or `null` if it is not held or has no limit now. */
  holdRemaining(code: string, seat: Seat): number | null {
    const until = this.rooms.get(code)?.seats[seat]?.heldUntil;
    return until == null ? null : Math.max(0, until - this.now());
  }

  /** Free the seats whose hold ran out and drop rooms that cannot continue. */
  sweep(): SweepEvent[] {
    const now = this.now();
    const events: SweepEvent[] = [];
    for (const [code, room] of this.rooms) {
      for (const seat of roomSeats(room.size)) {
        const state = room.seats[seat];
        if (state !== undefined && state.heldUntil !== null && now >= state.heldUntil) {
          state.token = null;
          state.connected = false;
          state.heldUntil = null;
          events.push({ type: "seatExpired", code, seat, size: room.size });
        }
      }
      if (room.seats.host?.token == null) {
        this.rooms.delete(code);
        events.push({ type: "roomClosed", code, reason: "hostGone" });
      } else if (now - room.lastActivity >= this.idleMs) {
        this.rooms.delete(code);
        events.push({ type: "roomClosed", code, reason: "idle" });
      }
    }
    return events;
  }

  /** Remove a room outright (the relay closed it). */
  delete(code: string): void {
    this.rooms.delete(code);
  }

  has(code: string): boolean {
    return this.rooms.has(code);
  }

  private generateCode(): string {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      const index = this.random ? Math.floor(this.random() * CODE_ALPHABET.length) : randomInt(CODE_ALPHABET.length);
      code += CODE_ALPHABET[index];
    }
    return code;
  }
}
