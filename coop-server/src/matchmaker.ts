/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  CODE_ALPHABET,
  CODE_LENGTH,
  MATCH_PING,
  MATCH_PONG,
  MATCH_QUEUE_MAX,
  type MatchControlMessage,
} from "./relay-protocol.ts";

/**
 * The matchmaking queue of the Node relay (D37). Players of one build are matched in the order they came: the one who waited
 * longer creates the room and sends its code, which goes to the other; then both connections close. A partner who leaves
 * before that puts the other back in the queue, in their old place. The Worker keeps the same rules in its Durable Object
 * (`coop-worker/src/matchmaker.ts`).
 */

/** The part of a WebSocket the queue uses */
export interface MatchSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}

interface Entry {
  socket: MatchSocket;
  build: string;
  /** Place in the queue: lower came first */
  place: number;
  state: "waiting" | "host" | "guest";
  partner: Entry | null;
  /** Frames other than pings: a client sends one code at most */
  frames: number;
}

/** Frames other than pings a queued client may send before it is cut off */
const MAX_FRAMES = 5;

/** WebSocket close codes: done, and over its limit */
const CLOSE_MATCHED = 1000;
const CLOSE_POLICY = 1008;

function isRoomCode(value: unknown): value is string {
  return typeof value === "string" && value.length === CODE_LENGTH && [...value].every(c => CODE_ALPHABET.includes(c));
}

function send(socket: MatchSocket, message: MatchControlMessage): void {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The socket is closing: its close takes it out of the queue
  }
}

export class MatchQueue {
  private readonly entries = new Map<MatchSocket, Entry>();
  private nextPlace = 0;
  private readonly max: number;

  constructor(max = MATCH_QUEUE_MAX) {
    this.max = max;
  }

  /** Players in the queue, matched or not */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Put a player in the queue of their build
   * @returns `false` if the queue is full (the caller refuses the socket)
   */
  join(socket: MatchSocket, build: string): boolean {
    if (this.entries.size >= this.max) {
      return false;
    }
    const entry: Entry = { socket, build, place: this.nextPlace++, state: "waiting", partner: null, frames: 0 };
    this.entries.set(socket, entry);
    send(socket, { t: "relay:queued" });
    this.pair(entry);
    return true;
  }

  /** A frame from a queued player: a keepalive, or a matched host's room code */
  message(socket: MatchSocket, text: string): void {
    const entry = this.entries.get(socket);
    if (entry === undefined) {
      return;
    }
    if (text === MATCH_PING) {
      try {
        socket.send(MATCH_PONG);
      } catch {
        // closing
      }
      return;
    }
    if (++entry.frames > MAX_FRAMES) {
      socket.close(CLOSE_POLICY, "too many frames");
      return;
    }
    let frame: { t?: unknown; code?: unknown } | null;
    try {
      frame = JSON.parse(text) as { t?: unknown; code?: unknown } | null;
    } catch {
      return;
    }
    const code = frame?.t === "match:code" ? frame.code : null;
    const guest = entry.partner;
    if (entry.state !== "host" || guest === null || !isRoomCode(code)) {
      return;
    }
    send(guest.socket, { t: "relay:matchGuest", code });
    this.entries.delete(socket);
    this.entries.delete(guest.socket);
    socket.close(CLOSE_MATCHED, "matched");
    guest.socket.close(CLOSE_MATCHED, "matched");
  }

  /** A queued player's connection closed (they cancelled, or their page went away) */
  left(socket: MatchSocket): void {
    const entry = this.entries.get(socket);
    if (entry === undefined) {
      return;
    }
    this.entries.delete(socket);
    const partner = entry.partner;
    if (partner !== null && this.entries.has(partner.socket)) {
      partner.state = "waiting";
      partner.partner = null;
      send(partner.socket, { t: "relay:matchLost" });
      this.pair(partner);
    }
  }

  /** Match this waiting player with the one of their build who came first, if any */
  private pair(entry: Entry): void {
    let other: Entry | null = null;
    for (const candidate of this.entries.values()) {
      if (
        candidate !== entry
        && candidate.state === "waiting"
        && candidate.build === entry.build
        && (other === null || candidate.place < other.place)
      ) {
        other = candidate;
      }
    }
    if (other === null) {
      return;
    }
    // The one who waited longer creates the room
    const [host, guest] = other.place < entry.place ? [other, entry] : [entry, other];
    host.state = "host";
    guest.state = "guest";
    host.partner = guest;
    guest.partner = host;
    send(host.socket, { t: "relay:matchHost" });
    send(guest.socket, { t: "relay:matched" });
  }
}
