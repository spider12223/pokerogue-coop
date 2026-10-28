/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Connection/heartbeat structure adapted from SunghoLee98/pokerogue `coop-server/src/relay-server.ts`
 * (AGPL-3.0-only). Seat tokens, per-seat hold, the rejoin flow, the static files and the limits are new.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { type ClientLogOptions, createClientLogHandler } from "./client-logs.ts";
import { clientIp, DEFAULT_LIMITS, IpLimiter, ipTag, originAllowed, type RelayLimits } from "./limits.ts";
import { MatchQueue } from "./matchmaker.ts";
import {
  CLOSE_CODE_LEAVE,
  CLOSE_CODE_POLICY,
  CLOSE_CODE_REJECTED,
  CLOSE_CODE_REPLACED,
  CLOSE_CODE_ROOM_CLOSED,
  CODE_ALPHABET,
  CODE_LENGTH,
  MATCH_BUILD,
  RELAY_PATH,
  RELAY_PREFIX,
  type RelayControlMessage,
  type RelayErrorReason,
  type Seat,
} from "./relay-protocol.ts";
import { otherSeat, RoomRegistry } from "./room-registry.ts";
import { createStaticHandler, type StaticHandler } from "./static.ts";
import { logField, requestUrl } from "./untrusted.ts";

const OPEN = 1; // WebSocket.OPEN

/** How many refusals a minute are logged one by one; the rest are counted, and the count is logged once a minute */
const REFUSALS_LOGGED_PER_MINUTE = 20;
const ROOM_CODE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** A code from a client, as the logs may show it: a code if it looks like one, never the client's text */
function codeForLog(code: string | null): string {
  if (code === null) {
    return "(no code)";
  }
  return ROOM_CODE.test(code) ? code : "(invalid)";
}

/** The size of a frame as `ws` hands it over */
function frameBytes(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((sum, chunk) => sum + chunk.length, 0);
  }
  return data.byteLength;
}

export interface RelayServerOptions {
  port: number;
  host?: string;
  /** How long a disconnected seat stays reserved once both players are gone. Default 60 s. */
  holdMs?: number;
  /** How often seat holds are checked. Default 1 s. */
  sweepIntervalMs?: number;
  /** Ping every socket this often; one that has not answered the previous ping is dropped. Default 30 s. */
  heartbeatIntervalMs?: number;
  /** Largest frame accepted from a client. Default 1 MiB. */
  maxPayloadBytes?: number;
  /** The production build to serve next to the relay (D22). Without it the server is only a relay. */
  staticDir?: string;
  /** Per-IP and global limits (D23); what is not given keeps its default. */
  limits?: Partial<RelayLimits>;
  /** `ALLOWED_ORIGINS` (D23): `["*"]` allows every origin; `null` or none: only the page's own origin. */
  allowedOrigins?: readonly string[] | null;
  /**
   * How the client's IP is found behind a proxy (D23): a number of proxies (that entry from the right of `X-Forwarded-For`),
   * `0` for none, or `"private"` (the default): a proxy is whatever connects from this machine or a private network.
   */
  trustProxy?: number | "private";
  /** Where the relay answers. Default `/coop` (D22). */
  path?: string;
  /** The client diagnostics log (D26, `POST <path>/log`); off unless `enabled` */
  clientLogs?: ClientLogOptions;
  /** Injected for tests. */
  now?: () => number;
  log?: (message: string) => void;
}

export interface RelayStats {
  rooms: number;
  sockets: number;
  trackedIps: number;
  /** Files being sent right now (each holds an open file) */
  downloads: number;
  /** Players in the matchmaking queue (D37) */
  matching: number;
}

export interface RelayServer {
  port: number;
  registry: RoomRegistry;
  limiter: IpLimiter;
  stats(): RelayStats;
  close(): Promise<void>;
}

type RoomSockets = Partial<Record<Seat, WebSocket>>;

function send(socket: WebSocket | undefined, message: RelayControlMessage): void {
  if (socket && socket.readyState === OPEN) {
    socket.send(JSON.stringify(message));
  }
}

/** Whether a client frame pretends to be a relay control message. Such frames are never forwarded. */
function isControlFrame(text: string): boolean {
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

function isSeat(value: string | null): value is Seat {
  return value === "host" || value === "guest";
}

/** Refuse an upgrade before it becomes a WebSocket */
function refuseUpgrade(socket: Duplex, status: 400 | 403 | 404 | 429, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * Start the server of a co-op deploy (DECISIONS D22, D23): the relay that pairs two sockets by join code and forwards text
 * frames between them, at `/coop`; `GET /healthz`; and, if asked, the files of the production build.
 * The relay never interprets game messages. A dropped player keeps their seat and can take it back with the seat token they
 * were given when they joined. Everything is in memory.
 */
export function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const limiter = new IpLimiter(limits, now);
  const registry = new RoomRegistry({
    ...(options.holdMs === undefined ? {} : { holdMs: options.holdMs }),
    idleMs: limits.idleRoomMs,
    now,
  });
  const path = options.path ?? RELAY_PATH;
  const allowedOrigins = options.allowedOrigins ?? null;
  const trustProxy = options.trustProxy ?? "private";
  const startedAt = now();
  const files: StaticHandler | null =
    options.staticDir === undefined ? null : createStaticHandler({ root: options.staticDir });
  const clientLog = createClientLogHandler({ ...options.clientLogs, allowedOrigins, now, log });

  const sockets = new Map<string, RoomSockets>();
  /** The matchmaking queue (D37): its players have their own connections, outside the rooms */
  const matches = new MatchQueue();
  /** Sockets that answered the last heartbeat ping. */
  const alive = new WeakSet<WebSocket>();
  /** Frames dropped in a row for a socket that does not read what it is sent. */
  const stalled = new WeakMap<WebSocket, number>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: options.maxPayloadBytes ?? 1_048_576 });

  const stats = (): RelayStats => ({
    rooms: registry.size,
    sockets: wss.clients.size,
    trackedIps: limiter.trackedIps,
    downloads: files?.downloads ?? 0,
    matching: matches.size,
  });

  // #region Refusals in the log

  // Anyone can make the relay refuse something as often as it likes: the first refusals of a minute are logged one by one,
  // the rest only counted, so a flood of them cannot flood the log.
  const refusals = { since: now(), shown: 0, hidden: new Map<string, number>() };
  const rollRefusals = (): void => {
    if (now() - refusals.since < 60_000) {
      return;
    }
    if (refusals.hidden.size > 0) {
      const total = [...refusals.hidden.values()].reduce((sum, count) => sum + count, 0);
      const byReason = [...refusals.hidden].map(([reason, count]) => `${reason} ${count}`).join(", ");
      log(`coop relay: ${total} more refusals not shown (${byReason})`);
    }
    refusals.since = now();
    refusals.shown = 0;
    refusals.hidden.clear();
  };
  /** @param line - Fixed text and values that passed {@linkcode codeForLog}, {@linkcode ipTag} or {@linkcode logField} */
  const refused = (reason: string, line: string): void => {
    rollRefusals();
    if (refusals.shown < REFUSALS_LOGGED_PER_MINUTE) {
      refusals.shown++;
      log(`coop relay: ${line}`);
    } else {
      refusals.hidden.set(reason, (refusals.hidden.get(reason) ?? 0) + 1);
    }
  };

  // #endregion

  // #region HTTP: health and files

  const handleHttp = (request: IncomingMessage, response: ServerResponse): void => {
    const url = requestUrl(request.url);
    if (url === null) {
      response.writeHead(400, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        connection: "close",
      });
      response.end("Bad request");
      return;
    }
    const pathname = url.pathname;
    if (pathname === "/healthz") {
      const usage = process.cpuUsage();
      const body = JSON.stringify({
        ok: true,
        ...stats(),
        clientLogs: options.clientLogs?.enabled === true,
        uptimeS: Math.round((now() - startedAt) / 1000),
        rssMb: Math.round(process.memoryUsage().rss / 1_048_576),
        cpuMs: Math.round((usage.user + usage.system) / 1000),
      });
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    if (pathname === `${path}/log`) {
      clientLog(request, response, clientIp(request, trustProxy));
      return;
    }
    if (files === null) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("coop relay: the game is not served here");
      return;
    }
    files.handle(request, response).catch(() => response.destroy());
  };

  const server = createServer(
    {
      // A client that sends its request slowly, or never ends it, does not hold a connection for long
      headersTimeout: 15_000,
      requestTimeout: 30_000,
      connectionsCheckingInterval: 5_000,
    },
    handleHttp,
  );
  // Platforms put a proxy in front that keeps connections for about a minute: do not close first
  server.keepAliveTimeout = 65_000;
  // A request the HTTP parser refuses (or one that timed out) is dropped, whatever it is
  server.on("clientError", (_error: Error, socket: Duplex) => socket.destroy());

  // #endregion

  // #region WebSocket: rooms

  const peerOf = (code: string, seat: Seat): WebSocket | undefined => sockets.get(code)?.[otherSeat(seat)];

  const attach = (socket: WebSocket, code: string, seat: Seat, ip: string): void => {
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
    const room = sockets.get(code) ?? {};
    sockets.set(code, room);
    const previous = room[seat];
    room[seat] = socket;
    if (previous && previous !== socket) {
      // The newer connection wins: the old one is a half-open leftover.
      previous.close(CLOSE_CODE_REPLACED, "replaced");
    }

    let dropped = 0;
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (!limiter.allowMessage(ip, frameBytes(data))) {
        // The reliable layer of the clients sends it again; a socket that keeps going is not a game
        dropped++;
        if (dropped === limits.maxDropsPerSocket) {
          log(`coop relay: ${code} ${seat} sends too much (ip ${ipTag(ip)}): closing`);
          socket.close(CLOSE_CODE_POLICY, "rate");
        }
        return;
      }
      const peer = peerOf(code, seat);
      if (isBinary || !peer || peer.readyState !== OPEN) {
        return;
      }
      const text = data.toString();
      if (isControlFrame(text)) {
        return;
      }
      registry.touch(code);
      if (peer.bufferedAmount > limits.maxBufferedBytes) {
        // The partner does not read what it is sent: what waits for it stays bounded, and the reliable layer of the sender
        // sends the frame again. A partner that stays stuck is cut; its seat is kept, so it can come back.
        const inARow = (stalled.get(peer) ?? 0) + 1;
        stalled.set(peer, inARow);
        if (inARow === limits.maxDropsPerSocket) {
          log(`coop relay: ${code} ${otherSeat(seat)} does not read what it is sent: cutting it`);
          peer.terminate();
        }
        return;
      }
      stalled.delete(peer);
      peer.send(text);
    });

    socket.on("close", (closeCode: number) => {
      const current = sockets.get(code);
      if (current?.[seat] !== socket) {
        return; // replaced by a newer connection, or the room is gone
      }
      if (closeCode === CLOSE_CODE_LEAVE) {
        // "End session" (D20): the room is over for both
        log(`coop relay: ${seat} ended ${code}`);
        const partner = current[otherSeat(seat)];
        sockets.delete(code);
        registry.leave(code);
        if (partner) {
          send(partner, { t: "relay:closed", reason: "partnerLeft" });
          partner.close(CLOSE_CODE_ROOM_CLOSED, "partnerLeft");
        }
        return;
      }
      log(`coop relay: ${seat} left ${code} (close ${closeCode})`);
      delete current[seat];
      registry.disconnect(code, seat);
      // The partner stays: this seat is kept as long as they do (D20)
      send(current[otherSeat(seat)], { t: "relay:peerLeft", holdMs: null });
    });
  };

  const reject = (socket: WebSocket, reason: RelayErrorReason, code: string | null, ip: string): void => {
    refused(reason, `rejected ${codeForLog(code)}: ${reason} (ip ${ipTag(ip)})`);
    send(socket, { t: "relay:error", reason });
    socket.close(CLOSE_CODE_REJECTED, reason);
  };

  /** Tell both players the room is complete (again). */
  const announcePaired = (code: string): void => {
    const room = sockets.get(code);
    send(room?.host, { t: "relay:paired" });
    send(room?.guest, { t: "relay:paired" });
  };

  /** A socket that completed its handshake at the relay's path, with the query of its URL */
  const connected = (socket: WebSocket, ip: string, params: URLSearchParams): void => {
    // `ws` emits "error" for protocol violations (an oversized frame, bad UTF-8, ...) and then closes the socket.
    // Without a listener that error would be thrown and take the whole relay down.
    socket.on("error", error => log(`coop relay: socket error: ${logField(error.message)}`));
    const role = params.get("role");
    const code = params.get("code");
    const seatParam = params.get("seat");
    const token = params.get("token");

    // Wait in the matchmaking queue (D37)
    const build = params.get("match");
    if (build !== null) {
      if (!MATCH_BUILD.test(build)) {
        reject(socket, "badRequest", null, ip);
        return;
      }
      if (!matches.join(socket, build)) {
        reject(socket, "busy", null, ip);
        return;
      }
      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (!isBinary) {
          matches.message(socket, String(data));
        }
      });
      socket.on("close", () => matches.left(socket));
      return;
    }

    // Create a room.
    if (role === "host" && code === null) {
      if (registry.size >= limits.maxRooms) {
        reject(socket, "busy", null, ip);
        return;
      }
      if (!limiter.allowRoom(ip)) {
        reject(socket, "rateLimited", null, ip);
        return;
      }
      const created = registry.createRoom();
      attach(socket, created.code, "host", ip);
      send(socket, { t: "relay:created", code: created.code, seat: "host", token: created.token });
      log(`coop relay: room ${created.code} created`);
      return;
    }

    if (code === null) {
      reject(socket, "badRequest", null, ip);
      return;
    }

    // Take a seat back.
    if (seatParam !== null || token !== null) {
      if (!isSeat(seatParam) || token === null || token === "") {
        reject(socket, "badRequest", code, ip);
        return;
      }
      const result = registry.rejoin(code, seatParam, token);
      if (result === "notFound" || result === "badToken") {
        reject(socket, result, code, ip);
        return;
      }
      log(`coop relay: ${seatParam} rejoined ${code}`);
      attach(socket, code, seatParam, ip);
      const peer = peerOf(code, seatParam);
      send(socket, { t: "relay:rejoined", code, seat: seatParam, peerPresent: peer !== undefined });
      if (peer) {
        send(peer, { t: "relay:peerBack" });
        announcePaired(code);
      } else if (registry.isReserved(code, otherSeat(seatParam))) {
        // The partner is away too; this player is here, so their seat is kept as long as this player stays (D20)
        send(socket, { t: "relay:peerLeft", holdMs: null });
      }
      return;
    }

    // Join as guest.
    const joined = registry.join(code);
    if (joined === "notFound" || joined === "full") {
      reject(socket, joined, code, ip);
      return;
    }
    log(`coop relay: guest joined ${code}`);
    attach(socket, code, "guest", ip);
    send(socket, { t: "relay:joined", code, seat: "guest", token: joined.token });
    if (peerOf(code, "guest")) {
      announcePaired(code);
    } else if (registry.isReserved(code, "host")) {
      send(socket, { t: "relay:peerLeft", holdMs: null });
    }
  };

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const url = requestUrl(request.url);
    if (url === null) {
      refuseUpgrade(socket, 400, "Bad Request");
      return;
    }
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    if (pathname !== path) {
      refuseUpgrade(socket, 404, "Not Found");
      return;
    }
    const origin = request.headers.origin;
    if (!originAllowed(origin, request.headers.host, allowedOrigins)) {
      refused("origin", `origin refused: ${logField(origin ?? "")}`);
      refuseUpgrade(socket, 403, "Forbidden");
      return;
    }
    const ip = clientIp(request, trustProxy);
    const admitted = limiter.admit(ip);
    if (admitted !== "ok") {
      refused(admitted, `refused ip ${ipTag(ip)}: ${admitted}`);
      refuseUpgrade(socket, 429, "Too Many Requests");
      return;
    }
    // The socket counts for its IP until the connection is gone, whether the handshake below completes or not (a bad key,
    // a method that is not GET, a client that left): `ws` closes this same socket when the WebSocket ends.
    socket.once("close", () => limiter.release(ip));
    wss.handleUpgrade(request, socket, head, ws => connected(ws, ip, url.searchParams));
  });

  // #endregion

  const sweepTimer = setInterval(() => {
    for (const event of registry.sweep()) {
      if (event.type === "seatExpired") {
        log(`coop relay: ${event.seat} seat of ${event.code} expired`);
        send(peerOf(event.code, event.seat), { t: "relay:peerGone" });
      } else {
        log(`coop relay: room ${event.code} closed (${event.reason})`);
        const room = sockets.get(event.code);
        sockets.delete(event.code);
        for (const socket of [room?.host, room?.guest]) {
          if (socket) {
            send(socket, { t: "relay:closed", reason: event.reason });
            socket.close(CLOSE_CODE_ROOM_CLOSED, event.reason);
          }
        }
      }
    }
  }, options.sweepIntervalMs ?? 1000);
  sweepTimer.unref();

  const limiterTimer = setInterval(() => {
    limiter.sweep();
    rollRefusals();
  }, 60_000);
  limiterTimer.unref();

  // Without traffic, a connection that died on the way (a phone losing signal) never closes on its own,
  // and the room would keep that player's seat marked as connected.
  const heartbeatTimer = setInterval(() => {
    for (const client of wss.clients) {
      if (!alive.has(client)) {
        client.terminate();
        continue;
      }
      alive.delete(client);
      client.ping();
    }
  }, options.heartbeatIntervalMs ?? 30_000);
  heartbeatTimer.unref();

  const close = (): Promise<void> => {
    clearInterval(sweepTimer);
    clearInterval(limiterTimer);
    clearInterval(heartbeatTimer);
    for (const client of wss.clients) {
      client.terminate();
    }
    return new Promise((resolve, rejectClose) => {
      wss.close(() => {
        server.closeAllConnections();
        server.close(error => (error ? rejectClose(error) : resolve()));
      });
    });
  };

  return new Promise((resolve, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(options.port, options.host, () => {
      server.off("error", rejectStart);
      server.on("error", error => log(`coop relay: server error: ${logField(error.message)}`));
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      resolve({ port, registry, limiter, stats, close });
    });
  });
}
