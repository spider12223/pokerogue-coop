/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { MATCH_BUILD, RELAY_PATH } from "../../coop-server/src/relay-protocol.ts";
import { normalizeIp } from "../../coop-server/src/untrusted.ts";
import {
  ACTION_HEADER,
  CODE_HEADER,
  DEFAULTS,
  type Env,
  envNumber,
  isRoomCode,
  newRoomCode,
  rejectSocket,
  TokenBucket,
} from "./shared.ts";

// biome-ignore lint/performance/noBarrelFile: Wrangler finds a Durable Object class among the main module's exports
export { Matchmaker } from "./matchmaker.ts";
export { Room } from "./room.ts";

/**
 * The co-op relay as a Cloudflare Worker, for a game served from somewhere else (GitHub Pages): the same protocol as
 * `coop-server` at `/coop` (`coop-server/README.md`), one Durable Object per room code. The game's files are not served
 * here, and the players' logs (`/coop/log`) are not collected: the games keep theirs.
 */

/** How many codes are tried before creating a room gives up (one in a billion is taken; this never runs out) */
const CREATE_ATTEMPTS = 5;

/**
 * Connection attempts and new rooms per address (an IPv6 client is its /64, as in `coop-server`). One copy per Worker
 * instance, so the limits are rough: they stop a script that guesses codes from one place, which is what they are for. A
 * limit over the whole relay is the platform's (a Rate Limiting rule of the zone on `/coop`).
 */
class AddressLimiter {
  private readonly addresses = new Map<string, { connect: TokenBucket; rooms: TokenBucket }>();

  admit(env: Env, ip: string, wantsRoom: boolean): boolean {
    const now = Date.now();
    if (this.addresses.size > 10_000) {
      for (const [address, state] of this.addresses) {
        if (state.connect.idle(now) && state.rooms.idle(now)) {
          this.addresses.delete(address);
        }
      }
    }
    let state = this.addresses.get(ip);
    if (state === undefined) {
      const connects = envNumber(env.CONNECTIONS_PER_MINUTE, DEFAULTS.connectionsPerMinute);
      const rooms = envNumber(env.ROOMS_PER_MINUTE, DEFAULTS.roomsPerMinute);
      state = {
        connect: new TokenBucket(connects, connects / 60_000, now),
        rooms: new TokenBucket(rooms, rooms / 60_000, now),
      };
      this.addresses.set(ip, state);
    }
    return state.connect.take(now) && (!wantsRoom || state.rooms.take(now));
  }
}

const limiter = new AddressLimiter();

/** Whether a page of `origin` may open the relay (as `coop-server`'s `originAllowed`) */
function originAllowed(origin: string | null, host: string, env: Env): boolean {
  if (origin === null || origin === "") {
    return true; // not a browser
  }
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map(entry => entry.trim())
    .filter(entry => entry !== "");
  if (allowed.length > 0) {
    return allowed.includes("*") || allowed.includes(origin);
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Pass the request on to the room of `code` */
function toRoom(env: Env, request: Request, code: string, action: "create" | "connect"): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set(ACTION_HEADER, action);
  headers.set(CODE_HEADER, code);
  return env.ROOM.get(env.ROOM.idFromName(code)).fetch(new Request(request, { headers }));
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const origin = request.headers.get("origin");

    if (path === "/healthz") {
      return Response.json({ ok: true, relay: "worker" }, { headers: { "cache-control": "no-store" } });
    }
    if (path === `${RELAY_PATH}/log`) {
      // The games stop sending their log on a 404; the CORS header lets a page of another origin read that status
      return new Response(null, {
        status: 404,
        headers: originAllowed(origin, url.host, env) && origin ? { "access-control-allow-origin": origin } : {},
      });
    }
    if (path !== RELAY_PATH) {
      return new Response("pokerogue co-op relay", { status: 404 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("this is a WebSocket relay", { status: 426 });
    }
    if (!originAllowed(origin, url.host, env)) {
      return new Response(null, { status: 403 });
    }

    const params = url.searchParams;
    const code = params.get("code");
    const create = params.get("role") === "host" && code === null;
    const ip = normalizeIp(request.headers.get("cf-connecting-ip") ?? "unknown");
    if (!limiter.admit(env, ip, create)) {
      return create ? rejectSocket("rateLimited") : new Response(null, { status: 429 });
    }

    // The matchmaking queue (D37): one object for everyone, whose sockets sleep while they wait
    const build = params.get("match");
    if (build !== null) {
      if (!MATCH_BUILD.test(build)) {
        return rejectSocket("badRequest");
      }
      return env.MATCH.get(env.MATCH.idFromName("queue")).fetch(request);
    }

    if (create) {
      for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
        const response = await toRoom(env, request, newRoomCode(), "create");
        if (response.status !== 409) {
          return response;
        }
      }
      return rejectSocket("busy");
    }
    if (code === null) {
      return rejectSocket("badRequest");
    }
    if (!isRoomCode(code)) {
      return rejectSocket("notFound");
    }
    return toRoom(env, request, code, "connect");
  },
} satisfies ExportedHandler<Env>;
