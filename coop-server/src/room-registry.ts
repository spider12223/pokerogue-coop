/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Room code alphabet and registry shape adapted from SunghoLee98/pokerogue `coop-server/src/room-registry.ts`
 * (AGPL-3.0-only). Seat tokens and per-seat hold expiry are new.
 */

import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { CODE_ALPHABET, CODE_LENGTH, DEFAULT_HOLD_MS, type Seat } from "./relay-protocol.ts";

interface SeatState {
  /** Secret that proves ownership of the seat; `null` while the seat is free. */
  token: string | null;
  connected: boolean;
  /** When a disconnected seat stops being reserved; `null` while connected or free. */
  heldUntil: number | null;
}

interface Room {
  seats: Record<Seat, SeatState>;
  /** When something last happened in the room: a connection, a seat change, a game frame (D23: idle rooms are closed) */
  lastActivity: number;
}

export type JoinResult = { seat: "guest"; token: string } | "notFound" | "full";
export type RejoinResult = { seat: Seat; wasConnected: boolean } | "notFound" | "badToken";

/** What a {@linkcode RoomRegistry.sweep} did, for the relay to act on. */
export type SweepEvent =
  /** A held seat ran out of time and is free again. */
  | { type: "seatExpired"; code: string; seat: Seat }
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

  /** Create a room with the host already in it. */
  createRoom(): { code: string; token: string } {
    let code: string;
    do {
      code = this.generateCode();
    } while (this.rooms.has(code));
    const token = newToken();
    this.rooms.set(code, {
      seats: {
        host: { token, connected: true, heldUntil: null },
        guest: { token: null, connected: false, heldUntil: null },
      },
      lastActivity: this.now(),
    });
    return { code, token };
  }

  /** Something happened in the room (a game frame went through): it is not idle */
  touch(code: string): void {
    const room = this.rooms.get(code);
    if (room !== undefined) {
      room.lastActivity = this.now();
    }
  }

  /** Take the free guest seat of a room. The host seat can only be taken back with its token. */
  join(code: string): JoinResult {
    const room = this.rooms.get(code);
    if (!room) {
      return "notFound";
    }
    const guest = room.seats.guest;
    if (guest.token !== null) {
      return "full";
    }
    const token = newToken();
    guest.token = token;
    guest.connected = true;
    guest.heldUntil = null;
    room.lastActivity = this.now();
    return { seat: "guest", token };
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
    if (state.token === null || !tokensMatch(state.token, token)) {
      return "badToken";
    }
    const wasConnected = state.connected;
    state.connected = true;
    state.heldUntil = null;
    room.lastActivity = this.now();
    // This player is here again: the seat of a partner who is still away is kept for as long as they stay (D20)
    room.seats[otherSeat(seat)].heldUntil = null;
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
    const other = room.seats[otherSeat(seat)];
    if (other.connected) {
      state.heldUntil = null;
      return;
    }
    const until = this.now() + this.holdMs;
    state.heldUntil = until;
    if (other.token !== null) {
      other.heldUntil = until;
    }
  }

  /** A player ended the session for good: the room goes at once and its tokens stop working. */
  leave(code: string): void {
    this.rooms.delete(code);
  }

  /** Whether the seat belongs to a player who is away right now (with or without a clock running) */
  isReserved(code: string, seat: Seat): boolean {
    const state = this.rooms.get(code)?.seats[seat];
    return state !== undefined && state.token !== null && !state.connected;
  }

  isConnected(code: string, seat: Seat): boolean {
    return this.rooms.get(code)?.seats[seat].connected ?? false;
  }

  /** Whether the seat is reserved for a player who is currently away, with a clock running */
  isHeld(code: string, seat: Seat): boolean {
    return this.rooms.get(code)?.seats[seat].heldUntil != null;
  }

  /** Milliseconds left on a seat's hold, or `null` if it is not held or has no limit now. */
  holdRemaining(code: string, seat: Seat): number | null {
    const until = this.rooms.get(code)?.seats[seat].heldUntil;
    return until == null ? null : Math.max(0, until - this.now());
  }

  /** Free the seats whose hold ran out and drop rooms that cannot continue. */
  sweep(): SweepEvent[] {
    const now = this.now();
    const events: SweepEvent[] = [];
    for (const [code, room] of this.rooms) {
      for (const seat of ["host", "guest"] as const) {
        const state = room.seats[seat];
        if (state.heldUntil !== null && now >= state.heldUntil) {
          state.token = null;
          state.connected = false;
          state.heldUntil = null;
          events.push({ type: "seatExpired", code, seat });
        }
      }
      if (room.seats.host.token === null) {
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
