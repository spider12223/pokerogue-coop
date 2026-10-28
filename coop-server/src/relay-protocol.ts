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
  | { t: "relay:error"; reason: RelayErrorReason }
  | MatchControlMessage;

/**
 * Matchmaking (D37), on its own connection: `?match=<build>` waits in the queue of that build (players of another build could
 * not pair, D1). Two players of a build are matched in the order they came: the first creates a room as usual and sends its
 * code ({@linkcode MatchCodeMessage}), which goes to the second, who joins it; then both connections close ("matched", 1000).
 * The game itself goes through a room, as for players who share a code.
 *
 * A pair that breaks before the code went: the guest goes back in the queue in its place (`relay:matchLost`), and the host's
 * connection is closed ({@linkcode CLOSE_CODE_MATCH_LOST}): its room has nobody to come, it searches again. A guest whose
 * host has not sent its code after a while says so ({@linkcode MatchStaleMessage}); the relay drops a host that has had
 * {@linkcode MATCH_STALE_MS} and pairs the guest again.
 */
export type MatchControlMessage =
  /** In the queue */
  | { t: "relay:queued" }
  /** A partner was found: create a room and send its code */
  | { t: "relay:matchHost" }
  /** A partner was found: their room's code follows */
  | { t: "relay:matched" }
  /** The partner's room: join it */
  | { t: "relay:matchGuest"; code: string }
  /** The partner left before their room was made: back in the queue, in this player's place */
  | { t: "relay:matchLost" };

/** What a matched host sends on its matchmaking connection: the code of the room it created */
export interface MatchCodeMessage {
  t: "match:code";
  code: string;
}

/** What a matched guest sends when its host's code does not come */
export interface MatchStaleMessage {
  t: "match:stale";
}

/** How long a matched host has to send its code before its guest may have it dropped */
export const MATCH_STALE_MS = 10_000;

/** WebSocket close code for a matched host whose partner left before the code went: search again */
export const CLOSE_CODE_MATCH_LOST = 4004;

/** A keepalive on the matchmaking connection, answered by the relay without anything else (a sleeping queue stays asleep) */
export const MATCH_PING = '{"t":"match:ping"}';
export const MATCH_PONG = '{"t":"relay:pong"}';

/** A build as the queue takes it: a short hash of the game's build identity */
export const MATCH_BUILD = /^[A-Za-z0-9._+-]{1,64}$/;

/** How many players may wait in a queue at once (all builds together) */
export const MATCH_QUEUE_MAX = 1000;

/** How many queue connections one address may have at once */
export const MATCH_PER_ADDRESS = 4;

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
