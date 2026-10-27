/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Structure adapted from SunghoLee98/pokerogue `coop-server/src/relay-protocol.ts` (AGPL-3.0-only).
 */

/**
 * Control messages between the relay and a client. Everything else a client sends is forwarded verbatim to the
 * partner and never interpreted. Control frames are JSON objects whose `t` starts with {@linkcode RELAY_PREFIX};
 * clients cannot forge them (the relay drops any client frame that looks like one).
 *
 * NB: `src/coop/transport/relay-ws.ts` in the game declares the client side of this protocol. The two are kept in
 * sync by `test/coop/relay-stack.test.ts`, which runs the real client against the real server.
 */

export const RELAY_PREFIX = "relay:";

/** The two seats of a room. The host is the sequencer. */
export type Seat = "host" | "guest";

export type RelayErrorReason = "notFound" | "full" | "badRequest" | "badToken" | "busy" | "rateLimited";

/**
 * Why the relay closed a room under a player: the host's seat expired, the partner left for good (D20), or nothing happened
 * in the room for the idle time (D23)
 */
export type RelayClosedReason = "hostGone" | "partnerLeft" | "idle";

export type RelayControlMessage =
  /** A room was created for the host. `token` proves seat ownership for {@linkcode RelayRejoinRequest}. */
  | { t: "relay:created"; code: string; seat: "host"; token: string }
  /** The guest took the free seat of an existing room. */
  | { t: "relay:joined"; code: string; seat: "guest"; token: string }
  /** A seat was taken back with its token. `peerPresent` tells whether the partner is connected right now. */
  | { t: "relay:rejoined"; code: string; seat: Seat; peerPresent: boolean }
  /** Both seats are connected. Sent to both players each time that becomes true again. */
  | { t: "relay:paired" }
  /**
   * The partner's connection dropped. Their seat is kept for as long as this player stays; `holdMs` is how long it is kept
   * once this player is gone too, so a client can say when the room closes ("D20"). `null`: there is no limit now.
   */
  | { t: "relay:peerLeft"; holdMs: number | null }
  /** The partner took their seat back. */
  | { t: "relay:peerBack" }
  /** The partner's seat hold expired: they can no longer rejoin. */
  | { t: "relay:peerGone" }
  /** The room is closed and the connection is about to be closed. */
  | { t: "relay:closed"; reason: RelayClosedReason }
  | { t: "relay:error"; reason: RelayErrorReason };

/**
 * Connection request, carried in the WebSocket URL query:
 * - create a room: `?role=host`
 * - join a room as guest: `?code=ABC234`
 * - take a seat back: `?code=ABC234&seat=host&token=...`
 */
export interface RelayRejoinRequest {
  code: string;
  seat: Seat;
  token: string;
}

/** WebSocket close code used when a seat is taken over by a newer connection with the same token. */
export const CLOSE_CODE_REPLACED = 4000;
/** WebSocket close code used when the relay closes the room. */
export const CLOSE_CODE_ROOM_CLOSED = 4001;
/** WebSocket close code used when a request is rejected. */
export const CLOSE_CODE_REJECTED = 4002;
/** WebSocket close code a client uses to leave for good ("End session", D20): the relay closes the room at once. */
export const CLOSE_CODE_LEAVE = 4003;

/** WebSocket close code (policy violation) for a socket that keeps sending past its limit (D23). */
export const CLOSE_CODE_POLICY = 1008;

/** The path of the relay on the server's origin (D22) */
export const RELAY_PATH = "/coop";

/** Default time a disconnected seat stays reserved. */
export const DEFAULT_HOLD_MS = 60_000;

/** The letters of a room code. No 0/O or 1/I: they look alike in the game font. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;
