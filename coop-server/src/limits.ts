/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { normalizeIp } from "./untrusted.ts";

/**
 * The relay's per-IP limits (DECISIONS D23). Memory only: nothing here outlives the process, and nothing keeps a message.
 * The clock is injected so the tests do not wait.
 */

export interface RelayLimits {
  /** Sockets one IP may hold open at once */
  maxConnectionsPerIp: number;
  /** Connection attempts one IP may make per minute (a join with a wrong code counts: guessing a code is pointless) */
  connectionsPerMinute: number;
  /** Rooms one IP may create per minute */
  roomsPerMinute: number;
  /** Messages per second one IP may send, over all of its sockets (a steady rate) */
  messagesPerSecond: number;
  /** How many messages one IP may send at once before the steady rate applies */
  messageBurst: number;
  /** Bytes per second one IP may send, over all of its sockets (a steady rate) */
  bytesPerSecond: number;
  /** How many bytes one IP may send at once before the steady rate applies */
  byteBurst: number;
  /**
   * Dropped messages of one socket after which it is closed (1008), and frames dropped in a row for a socket that does not
   * read (see `maxBufferedBytes`) after which it is cut
   */
  maxDropsPerSocket: number;
  /** Bytes that may wait to be sent to one socket: a frame for a socket with more waiting is dropped */
  maxBufferedBytes: number;
  /** Rooms the relay holds in all */
  maxRooms: number;
  /** A room without a game frame for this long is closed */
  idleRoomMs: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  maxConnectionsPerIp: 16,
  connectionsPerMinute: 60,
  roomsPerMinute: 10,
  messagesPerSecond: 120,
  messageBurst: 400,
  bytesPerSecond: 2 * 1_048_576,
  byteBurst: 16 * 1_048_576,
  maxDropsPerSocket: 200,
  maxBufferedBytes: 4 * 1_048_576,
  maxRooms: 1000,
  idleRoomMs: 30 * 60_000,
};

/** A bucket that refills at a steady rate up to a capacity: one `take` per event */
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

  /**
   * @param amount - The tokens the event costs; one that costs more than the capacity costs the capacity, so it can pass
   * @returns Whether the event is allowed (enough tokens were left)
   */
  take(now: number, amount = 1): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.perMs);
    this.last = now;
    const cost = Math.min(amount, this.capacity);
    if (this.tokens < cost) {
      return false;
    }
    this.tokens -= cost;
    return true;
  }

  /** Whether the bucket is full again, so that its owner can be forgotten */
  idle(now: number): boolean {
    return this.tokens + (now - this.last) * this.perMs >= this.capacity;
  }
}

interface IpState {
  sockets: number;
  connect: TokenBucket;
  rooms: TokenBucket;
  messages: TokenBucket;
  bytes: TokenBucket;
}

export type AdmitResult = "ok" | "tooManySockets" | "tooManyAttempts";

/** What the relay knows about each IP: how many sockets, and how fast it connects, creates rooms and sends */
export class IpLimiter {
  readonly limits: RelayLimits;
  private readonly ips = new Map<string, IpState>();
  private readonly now: () => number;

  constructor(limits: RelayLimits = DEFAULT_LIMITS, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
  }

  get trackedIps(): number {
    return this.ips.size;
  }

  private state(ip: string): IpState {
    let state = this.ips.get(ip);
    if (state === undefined) {
      const now = this.now();
      state = {
        sockets: 0,
        connect: new TokenBucket(this.limits.connectionsPerMinute, this.limits.connectionsPerMinute / 60_000, now),
        rooms: new TokenBucket(this.limits.roomsPerMinute, this.limits.roomsPerMinute / 60_000, now),
        messages: new TokenBucket(this.limits.messageBurst, this.limits.messagesPerSecond / 1000, now),
        bytes: new TokenBucket(this.limits.byteBurst, this.limits.bytesPerSecond / 1000, now),
      };
      this.ips.set(ip, state);
    }
    return state;
  }

  /** A connection attempt. On `ok` the socket is counted until {@linkcode release}. */
  admit(ip: string): AdmitResult {
    const state = this.state(ip);
    if (!state.connect.take(this.now())) {
      return "tooManyAttempts";
    }
    if (state.sockets >= this.limits.maxConnectionsPerIp) {
      return "tooManySockets";
    }
    state.sockets++;
    return "ok";
  }

  release(ip: string): void {
    const state = this.ips.get(ip);
    if (state !== undefined && state.sockets > 0) {
      state.sockets--;
    }
  }

  /** @returns Whether this IP may create a room now */
  allowRoom(ip: string): boolean {
    return this.state(ip).rooms.take(this.now());
  }

  /**
   * @param bytes - The size of the message
   * @returns Whether this IP may send one more message of this size now
   */
  allowMessage(ip: string, bytes = 0): boolean {
    const state = this.state(ip);
    const now = this.now();
    return state.messages.take(now) && (bytes === 0 || state.bytes.take(now, bytes));
  }

  /** Forget the IPs that hold no socket and whose buckets are full again */
  sweep(): void {
    const now = this.now();
    for (const [ip, state] of this.ips) {
      if (
        state.sockets === 0
        && state.connect.idle(now)
        && state.rooms.idle(now)
        && state.messages.idle(now)
        && state.bytes.idle(now)
      ) {
        this.ips.delete(ip);
      }
    }
  }
}

/** Whether an address is the machine itself or a private network: where a proxy of a deploy stands */
export function isPrivateAddress(address: string): boolean {
  const text = address.replace(/^::ffff:/i, "").toLowerCase();
  if (text === "::1" || text.startsWith("127.") || text === "localhost") {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(text);
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127)
    );
  }
  return text.startsWith("fc") || text.startsWith("fd") || text.startsWith("fe80:");
}

/**
 * The IP of the client (DECISIONS D23).
 * - `0`: the socket's address, whatever the headers say;
 * - `n`: the n-th entry from the right of `X-Forwarded-For`: a proxy appends the address it saw, so the entries to its left
 *   are the client's own claims;
 * - `"private"` (the default): the same as a count, but worked out from the addresses: a connection that comes from the
 *   machine itself or a private network is a proxy of the deploy (the platform's, a tunnel's, nginx), and the client is the
 *   first address from the right that is not private. A client on the internet cannot pass itself off as another this way.
 *
 * The address comes out as {@linkcode normalizeIp} makes it (an IPv6 client is its /64), before any limit or log tag sees it.
 */
export function clientIp(request: IncomingMessage, trustProxy: number | "private"): string {
  return normalizeIp(clientAddress(request, trustProxy));
}

function clientAddress(request: IncomingMessage, trustProxy: number | "private"): string {
  if (trustProxy === "private") {
    const socket = request.socket.remoteAddress ?? "unknown";
    const header = request.headers["x-forwarded-for"];
    const text = Array.isArray(header) ? header.join(",") : header;
    if (text === undefined || !isPrivateAddress(socket)) {
      return socket;
    }
    const hops = text
      .split(",")
      .map(hop => hop.trim())
      .filter(hop => hop.length > 0);
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!isPrivateAddress(hops[i]!)) {
        return hops[i]!;
      }
    }
    return hops[0] ?? socket;
  }
  if (trustProxy > 0) {
    const header = request.headers["x-forwarded-for"];
    const text = Array.isArray(header) ? header.join(",") : header;
    if (text !== undefined) {
      const hops = text
        .split(",")
        .map(hop => hop.trim())
        .filter(hop => hop.length > 0);
      const hop = hops.at(-trustProxy);
      if (hop !== undefined) {
        return hop;
      }
    }
  }
  return request.socket.remoteAddress ?? "unknown";
}

const SALT = randomBytes(8);

/** A short stand-in for an IP in the logs: stable while the process runs, and not the address */
export function ipTag(ip: string): string {
  return createHash("sha256").update(SALT).update(ip).digest("hex").slice(0, 8);
}

/**
 * Whether a browser's `Origin` is allowed (DECISIONS D23).
 * @param origin - The `Origin` header, if any: a client that is not a browser sends none and is allowed
 * @param host - The `Host` header of the request: by default only the page's own origin may connect
 * @param allowed - `ALLOWED_ORIGINS`: `["*"]` allows all; `null` is the default (the same origin)
 */
export function originAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowed: readonly string[] | null,
): boolean {
  if (origin === undefined || origin === "") {
    return true;
  }
  if (allowed !== null) {
    return allowed.includes("*") || allowed.includes(origin);
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
