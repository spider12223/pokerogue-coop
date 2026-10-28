/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  CLOSE_CODE_MATCH_LOST,
  CODE_ALPHABET,
  CODE_LENGTH,
  MATCH_PING,
  MATCH_PONG,
  MATCH_QUEUE_MAX,
  MATCH_STALE_MS,
  type MatchControlMessage,
} from "./relay-protocol.ts";

/**
 * The matchmaking queue of the Node relay (D37). Players of one build are matched in the order they came: the one who waited
 * longer creates the room and sends its code, which goes to the other; then both connections close. A pair that breaks before
 * that puts the guest back in the queue, in its old place, and closes the host's connection (its room has nobody to come: it
 * searches again). A guest whose host does not send its code has the host dropped. The Worker keeps the same rules in its
 * Durable Object (`coop-worker/src/matchmaker.ts`).
 */

/** The part of a WebSocket the queue uses */
export interface MatchSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
  /** 1 while open (`ws`); a socket without it counts as open */
  readonly readyState?: number;
}

interface Entry {
  socket: MatchSocket;
  build: string;
  /** Place in the queue: lower came first */
  place: number;
  state: "waiting" | "host" | "guest";
  partner: Entry | null;
  /** When it was matched (ms) */
  pairedAt: number;
  /** Frames other than an honest keepalive: a client sends one code, or one "stale", at most */
  frames: number;
  /** When its last keepalive came: a ping sooner than {@linkcode PING_GAP_MS} after it counts as a frame */
  lastPing: number;
}

/** Frames other than pings a queued client may send before it is cut off */
const MAX_FRAMES = 5;
/** The client pings every 30 s: closer pings are a flood */
const PING_GAP_MS = 5000;

/** WebSocket close codes: done, over its limit, and a frame of the wrong kind */
const CLOSE_MATCHED = 1000;
const CLOSE_POLICY = 1008;

function isRoomCode(value: unknown): value is string {
  return typeof value === "string" && value.length === CODE_LENGTH && [...value].every(c => CODE_ALPHABET.includes(c));
}

function isOpen(socket: MatchSocket): boolean {
  return socket.readyState === undefined || socket.readyState === 1;
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
  private readonly now: () => number;

  constructor(max = MATCH_QUEUE_MAX, now: () => number = Date.now) {
    this.max = max;
    this.now = now;
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
    const entry: Entry = {
      socket,
      build,
      place: this.nextPlace++,
      state: "waiting",
      partner: null,
      pairedAt: 0,
      frames: 0,
      lastPing: 0,
    };
    this.entries.set(socket, entry);
    send(socket, { t: "relay:queued" });
    this.pair(entry);
    return true;
  }

  /** A frame from a queued player: a keepalive, a matched host's room code, or a matched guest's "no code yet" */
  message(socket: MatchSocket, text: string): void {
    const entry = this.entries.get(socket);
    if (entry === undefined) {
      return;
    }
    if (text === MATCH_PING) {
      const now = this.now();
      const early = now - entry.lastPing < PING_GAP_MS;
      entry.lastPing = now;
      if (!early) {
        try {
          socket.send(MATCH_PONG);
        } catch {
          // closing
        }
        return;
      }
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
    if (frame?.t === "match:code") {
      this.code(entry, frame.code);
    } else if (frame?.t === "match:stale") {
      this.stale(entry);
    }
  }

  /** A matched host's room code: it goes to the guest, and both leave the queue */
  private code(host: Entry, code: unknown): void {
    const guest = host.partner;
    if (host.state !== "host" || guest === null || !isRoomCode(code)) {
      return;
    }
    if (!isOpen(guest.socket)) {
      // The guest is leaving: the code would go nowhere, and the host searches again
      this.left(guest.socket);
      return;
    }
    send(guest.socket, { t: "relay:matchGuest", code });
    this.entries.delete(host.socket);
    this.entries.delete(guest.socket);
    host.socket.close(CLOSE_MATCHED, "matched");
    guest.socket.close(CLOSE_MATCHED, "matched");
  }

  /** A matched guest whose host's code has not come: a host that had its time is dropped, and the guest is paired again */
  private stale(guest: Entry): void {
    const host = guest.partner;
    if (guest.state !== "guest" || host === null || this.now() - guest.pairedAt < MATCH_STALE_MS) {
      return;
    }
    this.entries.delete(host.socket);
    host.socket.close(CLOSE_CODE_MATCH_LOST, "no code");
    this.requeue(guest);
  }

  /** A queued player's connection closed (they cancelled, or their page went away) */
  left(socket: MatchSocket): void {
    const entry = this.entries.get(socket);
    if (entry === undefined) {
      return;
    }
    this.entries.delete(socket);
    const partner = entry.partner;
    if (partner === null || !this.entries.has(partner.socket)) {
      return;
    }
    if (partner.state === "guest") {
      this.requeue(partner);
    } else {
      // A host whose guest left may be making its room already: nobody will come to it, so it searches again
      this.entries.delete(partner.socket);
      send(partner.socket, { t: "relay:matchLost" });
      partner.socket.close(CLOSE_CODE_MATCH_LOST, "partner left");
    }
  }

  /** A guest whose host is gone: back in the queue in its old place, and paired again if it can be */
  private requeue(guest: Entry): void {
    guest.state = "waiting";
    guest.partner = null;
    send(guest.socket, { t: "relay:matchLost" });
    this.pair(guest);
  }

  /** Match this waiting player with the one of their build who came first, if any */
  private pair(entry: Entry): void {
    if (!isOpen(entry.socket)) {
      return;
    }
    let other: Entry | null = null;
    for (const candidate of this.entries.values()) {
      if (
        candidate !== entry
        && candidate.state === "waiting"
        && candidate.build === entry.build
        && isOpen(candidate.socket)
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
    const now = this.now();
    host.state = "host";
    guest.state = "guest";
    host.partner = guest;
    guest.partner = host;
    host.pairedAt = now;
    guest.pairedAt = now;
    send(host.socket, { t: "relay:matchHost" });
    send(guest.socket, { t: "relay:matched" });
  }
}
