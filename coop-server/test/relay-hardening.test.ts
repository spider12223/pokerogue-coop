/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { RelayLimits } from "../src/limits.ts";
import type { RelayControlMessage } from "../src/relay-protocol.ts";
import { type RelayServer, type RelayServerOptions, startRelayServer } from "../src/relay-server.ts";

/**
 * The relay's hardening (DECISIONS D22, D23) against a real server and real `ws` clients: every limit, the Origin check, the
 * path, the health check, the files, and what the logs may say.
 */

type Control = RelayControlMessage;

/** The outcome of a connection attempt: a socket that opened, or the HTTP status the upgrade was refused with */
type Attempt = { socket: WebSocket; messages: string[]; status?: undefined } | { socket?: undefined; status: number };

const servers: RelayServer[] = [];
const sockets: WebSocket[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function start(
  options: Partial<RelayServerOptions> & { limits?: Partial<RelayLimits> } = {},
): Promise<RelayServer> {
  const server = await startRelayServer({ port: 0, host: "127.0.0.1", sweepIntervalMs: 20, ...options });
  servers.push(server);
  return server;
}

/** Try to open a socket; resolves with the socket, or the status the server refused the upgrade with */
function attempt(
  server: RelayServer,
  query: string,
  headers: Record<string, string> = {},
  path = "/coop",
): Promise<Attempt> {
  return new Promise(resolve => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}${path}?${query}`, { headers });
    const messages: string[] = [];
    socket.on("message", data => messages.push(data.toString()));
    socket.on("error", () => {});
    socket.once("open", () => {
      sockets.push(socket);
      resolve({ socket, messages });
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0 });
    });
  });
}

async function open(server: RelayServer, query: string, headers: Record<string, string> = {}) {
  const result = await attempt(server, query, headers);
  if (result.socket === undefined) {
    throw new Error(`refused with ${result.status}`);
  }
  return result;
}

async function waitFor(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  for (let i = 0; i < ms / 10; i++) {
    if (condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const controls = (messages: string[]): Control[] =>
  messages.filter(text => text.startsWith('{"t":"relay:')).map(text => JSON.parse(text) as Control);

const closeOf = (socket: WebSocket): Promise<{ code: number; reason: string }> =>
  new Promise(resolve => socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Send `request` as it is over a plain TCP socket; resolves with what the server answered once it closed (or 2 s passed) */
function raw(server: RelayServer, request: string): Promise<string> {
  return new Promise(resolve => {
    let text = "";
    const socket = connect(server.port, "127.0.0.1");
    const done = (): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(text);
    };
    const timer = setTimeout(done, 2000);
    socket.setEncoding("latin1");
    socket.on("data", chunk => {
      text += chunk;
    });
    socket.on("error", done);
    socket.on("close", done);
    socket.write(request, "latin1");
  });
}

/** A WebSocket upgrade request for `target`; `headers` replace the usual ones */
function upgradeRequest(target: string, headers: Record<string, string> = {}, method = "GET"): string {
  const all: Record<string, string> = {
    Host: "127.0.0.1",
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    ...headers,
  };
  const lines = Object.entries(all).map(([name, value]) => `${name}: ${value}\r\n`);
  return `${method} ${target} HTTP/1.1\r\n${lines.join("")}\r\n`;
}

/** How many more sockets the limiter would let 127.0.0.1 open now (it gives them back at once) */
function freeSlots(server: RelayServer): number {
  let free = 0;
  while (free < 1000 && server.limiter.admit("127.0.0.1") === "ok") {
    free++;
  }
  for (let i = 0; i < free; i++) {
    server.limiter.release("127.0.0.1");
  }
  return free;
}

/** A host and a guest paired in a room */
async function pairedRoom(server: RelayServer) {
  const host = await open(server, "role=host");
  await waitFor(() => controls(host.messages).length > 0, "the room");
  const code = (controls(host.messages)[0] as Extract<Control, { t: "relay:created" }>).code;
  const guest = await open(server, `code=${code}`);
  await waitFor(() => controls(guest.messages).some(m => m.t === "relay:paired"), "the pairing");
  return { host, guest, code };
}

describe("the limits of the relay (D23)", () => {
  it("answers 429 to the connection that is over the sockets one IP may hold, and takes the next one once one closes", async () => {
    const server = await start({ limits: { maxConnectionsPerIp: 2 } });
    const a = await open(server, "role=host");
    await open(server, "role=host");
    expect((await attempt(server, "role=host")).status).toBe(429);
    const closed = closeOf(a.socket);
    a.socket.close();
    await closed;
    await waitFor(() => server.limiter.admit("127.0.0.1") === "ok", "the slot to be free");
    server.limiter.release("127.0.0.1");
  });

  it("answers 429 to the IP that connects too often: guessing room codes does not get far", async () => {
    const server = await start({ limits: { connectionsPerMinute: 4, maxConnectionsPerIp: 100 } });
    const statuses: (number | string)[] = [];
    for (let i = 0; i < 6; i++) {
      const result = await attempt(server, "code=ABCDEF"); // a code that does not exist
      statuses.push(result.status ?? "open");
      result.socket?.terminate();
    }
    expect(statuses).toEqual(["open", "open", "open", "open", 429, 429]);
  });

  it("refuses the room that is over what one IP may create, in the protocol's own words", async () => {
    const server = await start({ limits: { roomsPerMinute: 2 } });
    const first = await open(server, "role=host");
    const second = await open(server, "role=host");
    await waitFor(() => controls(first.messages).length > 0 && controls(second.messages).length > 0, "two rooms");
    const third = await open(server, "role=host");
    await waitFor(() => controls(third.messages).length > 0, "an answer");
    expect(controls(third.messages)).toEqual([{ t: "relay:error", reason: "rateLimited" }]);
    expect((await closeOf(third.socket)).code).toBe(4002);
    expect(server.registry.size).toBe(2);
  });

  it("holds a global cap of rooms: 'busy' at the cap, and a room again once one is gone", async () => {
    const server = await start({ limits: { maxRooms: 2, roomsPerMinute: 100 } });
    const a = await open(server, "role=host");
    await open(server, "role=host");
    await waitFor(() => server.registry.size === 2, "two rooms");
    const refused = await open(server, "role=host");
    await waitFor(() => controls(refused.messages).length > 0, "an answer");
    expect(controls(refused.messages)).toEqual([{ t: "relay:error", reason: "busy" }]);

    // the host ends its session: the room is gone and there is room
    await waitFor(() => controls(a.messages).length > 0, "the host's room");
    a.socket.close(4003, "leave");
    await waitFor(() => server.registry.size === 1, "the room to go");
    const again = await open(server, "role=host");
    await waitFor(() => controls(again.messages).length > 0, "an answer");
    expect(controls(again.messages)[0]?.t).toBe("relay:created");
  });

  it("drops the messages over the rate of an IP, and closes a socket that keeps sending", async () => {
    const server = await start({
      limits: { messagesPerSecond: 1, messageBurst: 5, maxDropsPerSocket: 3, connectionsPerMinute: 100 },
    });
    const host = await open(server, "role=host");
    await waitFor(() => controls(host.messages).length > 0, "the room");
    const code = (controls(host.messages)[0] as Extract<Control, { t: "relay:created" }>).code;
    const guest = await open(server, `code=${code}`);
    await waitFor(() => controls(guest.messages).some(m => m.t === "relay:paired"), "the pairing");

    const closed = closeOf(guest.socket);
    for (let i = 0; i < 20; i++) {
      guest.socket.send(`frame ${i}`);
    }
    expect((await closed).code).toBe(1008);
    const arrived = host.messages.filter(text => text.startsWith("frame "));
    // the burst got through, in order; the rest was dropped, not queued
    expect(arrived.length).toBeGreaterThan(0);
    expect(arrived.length).toBeLessThanOrEqual(6);
    expect(arrived).toEqual(arrived.map((_, i) => `frame ${i}`));
  });

  it("drops the bytes over the rate of an IP the same way: a few large frames count as much as many small ones", async () => {
    const server = await start({
      limits: { bytesPerSecond: 1, byteBurst: 10_000, maxDropsPerSocket: 3, connectionsPerMinute: 100 },
    });
    const { host, guest } = await pairedRoom(server);
    const closed = closeOf(guest.socket);
    for (let i = 0; i < 20; i++) {
      guest.socket.send(`frame ${i} ${"x".repeat(1000)}`);
    }
    expect((await closed).code).toBe(1008);
    const arrived = host.messages.filter(text => text.startsWith("frame "));
    expect(arrived.length).toBeGreaterThan(0);
    expect(arrived.length).toBeLessThanOrEqual(10);
  });

  it("closes a room that was silent for the idle time, and tells both players; a room with traffic stays", async () => {
    const server = await start({ limits: { idleRoomMs: 250 } });
    const room = async () => {
      const host = await open(server, "role=host");
      await waitFor(() => controls(host.messages).length > 0, "the room");
      const code = (controls(host.messages)[0] as Extract<Control, { t: "relay:created" }>).code;
      const guest = await open(server, `code=${code}`);
      await waitFor(() => controls(guest.messages).some(m => m.t === "relay:paired"), "the pairing");
      return { host, guest, code };
    };
    const silent = await room();
    const busy = await room();

    const hostClosed = closeOf(silent.host.socket);
    const guestClosed = closeOf(silent.guest.socket);
    const timer = setInterval(() => busy.guest.socket.send("still playing"), 50);
    try {
      expect((await hostClosed).code).toBe(4001);
      expect((await guestClosed).code).toBe(4001);
      expect(controls(silent.host.messages).at(-1)).toEqual({ t: "relay:closed", reason: "idle" });
      expect(controls(silent.guest.messages).at(-1)).toEqual({ t: "relay:closed", reason: "idle" });
      expect(server.registry.has(silent.code)).toBe(false);
      expect(server.registry.has(busy.code)).toBe(true);
    } finally {
      clearInterval(timer);
    }
  });

  it("takes the IP from the proxy when one is trusted, so the limits count the player and not the proxy", async () => {
    const server = await start({ trustProxy: 1, limits: { maxConnectionsPerIp: 1, connectionsPerMinute: 100 } });
    const first = await attempt(server, "role=host", { "x-forwarded-for": "6.6.6.6, 203.0.113.1" });
    expect(first.status).toBeUndefined();
    const other = await attempt(server, "role=host", { "x-forwarded-for": "6.6.6.6, 203.0.113.2" });
    expect(other.status).toBeUndefined();
    // the same player again, whatever it claims to be at the left
    const same = await attempt(server, "role=host", { "x-forwarded-for": "7.7.7.7, 203.0.113.1" });
    expect(same.status).toBe(429);
  });

  it("finds the player behind the proxy of a deploy by itself: a proxy is what connects from this machine or a private network", async () => {
    // (the default; every test client here comes from 127.0.0.1)
    const server = await start({ limits: { maxConnectionsPerIp: 1, connectionsPerMinute: 100 } });
    expect((await attempt(server, "role=host", { "x-forwarded-for": "203.0.113.1" })).status).toBeUndefined();
    expect((await attempt(server, "role=host", { "x-forwarded-for": "203.0.113.2" })).status).toBeUndefined();
    expect((await attempt(server, "role=host", { "x-forwarded-for": "203.0.113.1" })).status).toBe(429);
    // and with the header turned off, they are one player
    const direct = await start({ trustProxy: 0, limits: { maxConnectionsPerIp: 1, connectionsPerMinute: 100 } });
    expect((await attempt(direct, "role=host", { "x-forwarded-for": "203.0.113.1" })).status).toBeUndefined();
    expect((await attempt(direct, "role=host", { "x-forwarded-for": "203.0.113.2" })).status).toBe(429);
  });

  it("keeps the frame cap of 1 MiB", async () => {
    const server = await start({ maxPayloadBytes: 1024 });
    const host = await open(server, "role=host");
    const closed = closeOf(host.socket);
    host.socket.send("x".repeat(2048));
    expect((await closed).code).toBe(1009);
  });
});

describe("who may connect (D22, D23)", () => {
  it("answers only at /coop (and /coop/): another path is 404", async () => {
    const server = await start();
    expect((await attempt(server, "role=host", {}, "/")).status).toBe(404);
    expect((await attempt(server, "role=host", {}, "/other")).status).toBe(404);
    expect((await attempt(server, "role=host", {}, "/coop/")).status).toBeUndefined();
    expect((await attempt(server, "role=host", {}, "/coop")).status).toBeUndefined();
  });

  it("accepts the page's own origin and a client without one, and refuses another origin", async () => {
    const server = await start({ limits: { connectionsPerMinute: 100 } });
    const own = `http://127.0.0.1:${server.port}`;
    expect((await attempt(server, "role=host", { origin: own })).status).toBeUndefined();
    expect((await attempt(server, "role=host")).status).toBeUndefined();
    expect((await attempt(server, "role=host", { origin: "https://evil.example" })).status).toBe(403);
  });

  it("follows ALLOWED_ORIGINS: a listed origin is in, an unlisted one out, and * lets all", async () => {
    const listed = await start({ allowedOrigins: ["http://localhost:8000"], limits: { connectionsPerMinute: 100 } });
    expect((await attempt(listed, "role=host", { origin: "http://localhost:8000" })).status).toBeUndefined();
    expect((await attempt(listed, "role=host", { origin: "http://localhost:9000" })).status).toBe(403);
    // a list replaces the same-origin rule
    expect((await attempt(listed, "role=host", { origin: `http://127.0.0.1:${listed.port}` })).status).toBe(403);

    const all = await start({ allowedOrigins: ["*"] });
    expect((await attempt(all, "role=host", { origin: "https://anything.example" })).status).toBeUndefined();
  });
});

describe("the logs (D23)", () => {
  it("name rooms, seats and reasons, and never a message, a token or an address", async () => {
    const lines: string[] = [];
    const server = await start({ log: line => lines.push(line), limits: { roomsPerMinute: 1 } });
    const host = await open(server, "role=host");
    await waitFor(() => controls(host.messages).length > 0, "the room");
    const created = controls(host.messages)[0] as Extract<Control, { t: "relay:created" }>;
    const guest = await open(server, `code=${created.code}`);
    await waitFor(() => controls(guest.messages).some(m => m.t === "relay:joined"), "the join");
    const joined = controls(guest.messages).find(m => m.t === "relay:joined") as Extract<
      Control,
      { t: "relay:joined" }
    >;

    host.socket.send('{"secret":"MESSAGE-CONTENTS-ONLY-THE-PARTNER-MAY-SEE"}');
    await waitFor(() => guest.messages.some(text => text.includes("MESSAGE-CONTENTS")), "the frame");
    // a rejected room (the second of the minute) and a bad token are logged too
    const refused = await open(server, "role=host");
    await waitFor(() => controls(refused.messages).length > 0, "the refusal");
    const wrong = await open(server, `code=${created.code}&seat=host&token=${"0".repeat(32)}`);
    await waitFor(() => controls(wrong.messages).length > 0, "the bad token");
    guest.socket.close();
    await waitFor(() => lines.some(line => line.includes("guest left")), "the leave");

    const log = lines.join("\n");
    expect(log).toContain(created.code);
    expect(log).toContain("rateLimited");
    expect(log).not.toContain("MESSAGE-CONTENTS");
    expect(log).not.toContain(created.token);
    expect(log).not.toContain(joined.token);
    expect(log).not.toContain("127.0.0.1");
  });

  it("write nothing a client sent as it is: a code that is not a code, an Origin with control characters", async () => {
    const lines: string[] = [];
    const server = await start({ log: line => lines.push(line), limits: { connectionsPerMinute: 100 } });
    // a line break in the code would forge a line of its own, an escape sequence would reach the operator's terminal
    const forged = "AB\n2026-01-01T00:00:00.000Z coop relay: room FAKE99 created\u001b[2J";
    const refused = await open(server, `code=${encodeURIComponent(forged)}`);
    await waitFor(() => controls(refused.messages).length > 0, "the refusal");
    const origin = `https://evil.example/\u009b2J{"src":"client","msg":"forged"}${"x".repeat(2000)}`;
    expect((await attempt(server, "role=host", { origin })).status).toBe(403);
    await waitFor(() => lines.length >= 2, "both lines");

    const log = lines.join("\n");
    expect(
      lines.every(line => /^[\x20-\x7e]*$/.test(line)),
      log,
    ).toBe(true);
    expect(log).not.toContain("FAKE99");
    expect(log).toContain("(invalid)");
    expect(log).not.toContain("{");
    expect(log).toContain("evil.example");
    expect(Math.max(...lines.map(line => line.length))).toBeLessThan(400);
  });

  it("log so many refusals a minute one by one, and count the rest", async () => {
    let time = 1_000_000;
    const lines: string[] = [];
    const server = await start({
      now: () => time,
      log: line => lines.push(line),
      limits: { connectionsPerMinute: 1000, maxConnectionsPerIp: 1000 },
    });
    const refuse = async () => {
      const result = await open(server, "code=ABCDEF"); // no such room
      await waitFor(() => controls(result.messages).length > 0, "the refusal");
    };
    for (let i = 0; i < 30; i++) {
      await refuse();
    }
    expect(lines.filter(line => line.includes("rejected ABCDEF: notFound"))).toHaveLength(20);
    time += 60_000;
    await refuse();
    expect(lines.some(line => line.includes("10 more refusals") && line.includes("notFound 10"))).toBe(true);
    expect(lines.filter(line => line.includes("rejected ABCDEF: notFound"))).toHaveLength(21);
  });
});

describe("a request target that `new URL(target, base)` cannot read (D23)", () => {
  // Each of these threw inside the request or upgrade listener: one anonymous request took the process and every room down
  const targets = ["//", "///", "//:", "//:99999", "//[", "http://", "http://["];
  const get = (target: string): string => `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`;

  it("is answered (400, or 404 for a path that is not there) as a request and as an upgrade, and the rooms go on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coop-dist-"));
    dirs.push(dir);
    writeFileSync(join(dir, "index.html"), "<!doctype html>");
    for (const server of [await start({ limits: { connectionsPerMinute: 1000 } }), await start({ staticDir: dir })]) {
      const room = await pairedRoom(server);
      for (const target of targets) {
        expect(await raw(server, get(target)), target).toMatch(/^HTTP\/1\.1 40[04] /);
        expect(await raw(server, upgradeRequest(target)), `upgrade ${target}`).toMatch(/^HTTP\/1\.1 40[04] /);
      }
      const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(health.status).toBe(200);
      // the room is still there and still forwards
      room.host.socket.send("still here");
      await waitFor(() => room.guest.messages.includes("still here"), "the frame");
    }
  });

  it("is answered 400 when it is no URL at all", async () => {
    const server = await start();
    for (const target of ["http://", "http://[", "*"]) {
      expect(await raw(server, get(target)), target).toMatch(/^HTTP\/1\.1 400 /);
      expect(await raw(server, upgradeRequest(target)), `upgrade ${target}`).toMatch(/^HTTP\/1\.1 400 /);
    }
  });
});

describe("a partner that does not read (D23)", () => {
  const frame = (i: number): string => `${String(i).padStart(6, "0")}${"x".repeat(64 * 1024)}`;
  const isFrame = (text: string): boolean => /^\d{6}x/.test(text);

  /** A paired room whose guest has stopped reading its socket */
  async function stalledRoom(limits: Partial<RelayLimits>) {
    const server = await start({
      limits: { messagesPerSecond: 100_000, messageBurst: 100_000, bytesPerSecond: 1e10, byteBurst: 1e10, ...limits },
    });
    const room = await pairedRoom(server);
    room.guest.socket.pause();
    return { server, ...room };
  }

  it("drops the frames for it over the cap instead of keeping them without bound; what gets through is in order", async () => {
    const { host, guest } = await stalledRoom({ maxBufferedBytes: 256 * 1024, maxDropsPerSocket: 1_000_000 });
    const total = 512; // 32 MiB: far more than the cap and what the system's socket buffers hold
    for (let i = 0; i < total; i++) {
      host.socket.send(frame(i));
    }
    await waitFor(() => host.socket.bufferedAmount === 0, "the host's frames to leave", 10_000);
    await sleep(300);
    guest.socket.resume();
    let seen = -1;
    await waitFor(
      () => {
        const now = guest.messages.length;
        const settled = now === seen;
        seen = now;
        return settled;
      },
      "the guest to have read everything",
      10_000,
    );
    const numbers = guest.messages.filter(isFrame).map(text => Number(text.slice(0, 6)));
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers.length).toBeLessThan(total);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  it("cuts it once frames keep being dropped for it; its seat is kept for it to take back", async () => {
    const { server, host, code } = await stalledRoom({ maxBufferedBytes: 256 * 1024, maxDropsPerSocket: 20 });
    for (let i = 0; i < 512; i++) {
      host.socket.send(frame(i));
    }
    await waitFor(() => controls(host.messages).some(m => m.t === "relay:peerLeft"), "the guest to be cut", 10_000);
    expect(server.stats().sockets).toBe(1);
    expect(server.registry.isReserved(code, "guest")).toBe(true);
  });
});

describe("the IP's count of sockets (D23)", () => {
  it("gets the slot back when the handshake fails after the IP was counted", async () => {
    const server = await start({ limits: { maxConnectionsPerIp: 2, connectionsPerMinute: 1000 } });
    for (let i = 0; i < 4; i++) {
      expect(await raw(server, upgradeRequest("/coop?role=host", { "Sec-WebSocket-Key": "not-a-key" }))).toMatch(
        /^HTTP\/1\.1 400 /,
      );
      expect(await raw(server, upgradeRequest("/coop?role=host", { "Sec-WebSocket-Version": "7" }))).toMatch(
        /^HTTP\/1\.1 400 /,
      );
      expect(await raw(server, upgradeRequest("/coop?role=host", {}, "POST"))).toMatch(/^HTTP\/1\.1 405 /);
    }
    await waitFor(() => freeSlots(server) === 2, "both slots");
    await open(server, "role=host");
    await open(server, "role=host");
    expect((await attempt(server, "role=host")).status).toBe(429);
  });

  it("gives back one slot for a socket that closes, not two", async () => {
    const server = await start({ limits: { maxConnectionsPerIp: 2, connectionsPerMinute: 1000 } });
    const a = await open(server, "role=host");
    await open(server, "role=host");
    expect(freeSlots(server)).toBe(0);
    const closed = closeOf(a.socket);
    a.socket.close();
    await closed;
    await waitFor(() => freeSlots(server) === 1, "the slot");
    await sleep(100);
    expect(freeSlots(server)).toBe(1);
  });
});

describe("GET /healthz (D22)", () => {
  it("says it is up, and how many rooms and sockets there are", async () => {
    const server = await start({ limits: { roomsPerMinute: 100 } });
    const host = await open(server, "role=host");
    await waitFor(() => controls(host.messages).length > 0, "the room");
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ok: true, rooms: 1, sockets: 1 });
  });

  it("is not a game: a server without files answers 404 to everything else", async () => {
    const server = await start();
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(response.status).toBe(404);
  });
});

describe("the files of the production build (D22)", () => {
  const hashed = "export const x = 1;\n".repeat(200);

  function site(): string {
    const dir = mkdtempSync(join(tmpdir(), "coop-dist-"));
    dirs.push(dir);
    mkdirSync(join(dir, "assets"));
    mkdirSync(join(dir, "images"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>game</title>");
    writeFileSync(join(dir, "assets", "main-AbCd1234.js"), hashed);
    writeFileSync(join(dir, "assets", "plain.js"), hashed);
    writeFileSync(join(dir, "images", "icon.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    return dir;
  }

  const get = (server: RelayServer, path: string, headers: Record<string, string> = {}, method = "GET") =>
    fetch(`http://127.0.0.1:${server.port}${path}`, { headers, method, redirect: "manual" });

  it("serves index.html at / without a cache, and answers 304 while it has not changed", async () => {
    const server = await start({ staticDir: site() });
    const first = await get(server, "/");
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(first.headers.get("cache-control")).toBe("no-cache");
    expect(await first.text()).toContain("<title>game</title>");
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const second = await get(server, "/index.html", { "if-none-match": etag });
    expect(second.status).toBe(304);
  });

  it("keeps a file whose name carries the content hash for a year, and checks every other file", async () => {
    const server = await start({ staticDir: site() });
    const hashedFile = await get(server, "/assets/main-AbCd1234.js");
    expect(hashedFile.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(hashedFile.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect((await get(server, "/assets/plain.js")).headers.get("cache-control")).toBe("no-cache");
    const image = await get(server, "/images/icon.png");
    expect(image.headers.get("cache-control")).toBe("no-cache");
    expect(image.headers.get("content-type")).toBe("image/png");
  });

  it("sends text gzipped when the browser accepts it, and as it is when it does not", async () => {
    const server = await start({ staticDir: site() });
    // `fetch` unpacks a gzipped body by itself: read the bytes as they come
    const packed = await new Promise<{ headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      httpGet(
        `http://127.0.0.1:${server.port}/assets/main-AbCd1234.js`,
        { headers: { "accept-encoding": "gzip" } },
        response => {
          const chunks: Buffer[] = [];
          response.on("data", chunk => chunks.push(chunk as Buffer));
          response.on("end", () => resolve({ headers: response.headers, body: Buffer.concat(chunks) }));
        },
      ).on("error", reject);
    });
    expect(packed.headers["content-encoding"]).toBe("gzip");
    expect(packed.headers["vary"]).toBe("Accept-Encoding");
    expect(packed.body.length).toBeLessThan(hashed.length / 4);
    expect(gunzipSync(packed.body).toString()).toBe(hashed);
    const raw = await get(server, "/assets/main-AbCd1234.js", { "accept-encoding": "identity" });
    expect(raw.headers.get("content-encoding")).toBeNull();
    expect(await raw.text()).toBe(hashed);
  });

  it("does not leave the directory: a path that climbs out of it is refused", async () => {
    const server = await start({ staticDir: site() });
    for (const path of [
      "/..%2f..%2fpackage.json",
      "/%2e%2e/%2e%2e/package.json",
      "/assets/..%5c..%5cpackage.json",
      "/%00",
    ]) {
      const response = await get(server, path);
      expect([400, 404]).toContain(response.status);
    }
  });

  it("answers 404 to what is not there, 405 to a method that is not GET or HEAD, and HEAD without a body", async () => {
    const server = await start({ staticDir: site() });
    expect((await get(server, "/nope.js")).status).toBe(404);
    expect((await get(server, "/assets")).status).toBe(404); // a directory
    expect((await get(server, "/", {}, "POST")).status).toBe(405);
    const head = await get(server, "/index.html", {}, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("closes the file of a download the browser gave up on", async () => {
    const dir = site();
    writeFileSync(join(dir, "big.bin"), Buffer.alloc(32 * 1_048_576)); // more than the socket buffers take at once
    const server = await start({ staticDir: dir });
    const during = await new Promise<number>((resolve, reject) => {
      const request = httpGet(`http://127.0.0.1:${server.port}/big.bin`, response => {
        response.on("error", () => {});
        response.once("data", () => {
          const open = server.stats().downloads;
          request.destroy();
          resolve(open);
        });
      });
      request.on("error", error => (request.destroyed ? undefined : reject(error)));
    });
    expect(during).toBe(1);
    await waitFor(() => server.stats().downloads === 0, "the file to be closed");
  });

  it("serves the game and the relay on one port", async () => {
    const server = await start({ staticDir: site() });
    expect((await get(server, "/")).status).toBe(200);
    const host = await open(server, "role=host");
    await waitFor(() => controls(host.messages).length > 0, "the room");
    expect(controls(host.messages)[0]?.t).toBe("relay:created");
  });
});
