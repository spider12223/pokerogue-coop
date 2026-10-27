/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  CLOSE_CODE_REJECTED,
  CODE_ALPHABET,
  CODE_LENGTH,
  RELAY_PREFIX,
  type RelayControlMessage,
  type RelayErrorReason,
  type Seat,
} from "../../coop-server/src/relay-protocol.ts";
import type { Room } from "./room.ts";

/** What the Worker and its rooms are given (`wrangler.toml`) */
export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  /** Comma list of the origins whose pages may open the relay (`*`: all). Empty: only pages of the relay's own address */
  ALLOWED_ORIGINS?: string;
  /** How long a seat is kept once both players are gone */
  HOLD_MS?: string;
  /** A room without a game frame for this long is closed */
  IDLE_ROOM_MS?: string;
  CONNECTIONS_PER_MINUTE?: string;
  ROOMS_PER_MINUTE?: string;
  MESSAGES_PER_SECOND?: string;
  MESSAGE_BURST?: string;
  MAX_DROPS_PER_SOCKET?: string;
}

/** The same defaults as `coop-server` (`DEFAULT_LIMITS`, `DEFAULT_HOLD_MS`) */
export const DEFAULTS = {
  holdMs: 60_000,
  idleRoomMs: 30 * 60_000,
  connectionsPerMinute: 60,
  roomsPerMinute: 10,
  messagesPerSecond: 120,
  messageBurst: 400,
  maxDropsPerSocket: 200,
};

/** A number from the environment, or `fallback` when it is missing or not a number */
export function envNumber(value: string | undefined, fallback: number): number {
  const parsed = value === undefined || value.trim() === "" ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** The header the Worker uses to tell a room what to do */
export const ACTION_HEADER = "x-coop-action";
/** The header the Worker uses to tell a room its code */
export const CODE_HEADER = "x-coop-code";

export function isSeat(value: string | null): value is Seat {
  return value === "host" || value === "guest";
}

export function otherSeat(seat: Seat): Seat {
  return seat === "host" ? "guest" : "host";
}

/** Whether `code` could be a room code (anything else is answered without waking a room) */
export function isRoomCode(code: string): boolean {
  return code.length === CODE_LENGTH && [...code].every(letter => CODE_ALPHABET.includes(letter));
}

/** A random room code. 256 is a multiple of the 32 letters, so every letter is as likely */
export function newRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map(byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

/** A seat token: 128 random bits as hex */
export function newToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Compare two tokens in a time that does not depend on where they differ */
export function tokensMatch(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  return bufA.byteLength === bufB.byteLength && crypto.subtle.timingSafeEqual(bufA, bufB);
}

/** Whether a client frame pretends to be a relay control message. Such frames are never forwarded. */
export function isControlFrame(text: string): boolean {
  if (!text.includes(RELAY_PREFIX)) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === "object"
      && parsed !== null
      && typeof (parsed as { t?: unknown }).t === "string"
      && (parsed as { t: string }).t.startsWith(RELAY_PREFIX)
    );
  } catch {
    return false;
  }
}

export function sendControl(socket: WebSocket | undefined, message: RelayControlMessage): void {
  if (socket?.readyState === WebSocket.READY_STATE_OPEN) {
    socket.send(JSON.stringify(message));
  }
}

/** Hand the client its end of a WebSocket */
export function upgradeResponse(client: WebSocket): Response {
  return new Response(null, { status: 101, webSocket: client });
}

/** Refuse a request the way `coop-server` does: a WebSocket that says why, then closes (4002) */
export function rejectSocket(reason: RelayErrorReason): Response {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  sendControl(server, { t: "relay:error", reason });
  server.close(CLOSE_CODE_REJECTED, reason);
  return upgradeResponse(client);
}

/** A bucket that refills at a steady rate up to a capacity: one `take` per event (as `coop-server`'s `TokenBucket`) */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly perMs: number;

  constructor(capacity: number, perMs: number, now: number) {
    this.capacity = capacity;
    this.perMs = perMs;
    this.tokens = capacity;
    this.last = now;
  }

  /** @returns Whether the event is allowed (a token was left) */
  take(now: number): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.perMs);
    this.last = now;
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }

  /** Whether the bucket is full again, so that its owner can be forgotten */
  idle(now: number): boolean {
    return this.tokens + (now - this.last) * this.perMs >= this.capacity;
  }
}
