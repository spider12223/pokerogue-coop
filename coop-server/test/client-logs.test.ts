/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLIENT_LOG_PATH,
  type ClientLogEntry,
  type ClientLogHandler,
  type ClientLogOptions,
  ClientLogSink,
  createClientLogHandler,
  parseClientLogBatch,
} from "../src/client-logs.ts";
import { ipTag } from "../src/limits.ts";

/**
 * The client diagnostics log (`POST /coop/log`) against a real HTTP server on a free port: the gates (off, method, Origin,
 * rate, size, shape), what is written and what is not, and the log directory with its cap.
 */

const TEST_IP = "203.0.113.7";
const NOW = Date.UTC(2026, 2, 4, 10, 0, 0);
const TEXT = { "content-type": "text/plain;charset=UTF-8" };

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "coop-client-logs-"));
  dirs.push(dir);
  return dir;
}

interface Harness {
  port: number;
  /** Every line the handler wrote to its `write` */
  lines: string[];
  handler: ClientLogHandler;
}

/** A server whose only route is the handler. The "client IP" is the `x-test-ip` header, so that a test can be several IPs. */
async function start(options: ClientLogOptions = {}): Promise<Harness> {
  const lines: string[] = [];
  const handler = createClientLogHandler({ enabled: true, write: line => lines.push(line), ...options });
  const server = createServer((request, response) =>
    handler(request, response, String(request.headers["x-test-ip"] ?? TEST_IP)),
  );
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, lines, handler };
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

interface SendInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | undefined;
  /** Sent as separate writes with no Content-Length (chunked) */
  chunks?: Buffer[];
}

function send(port: number, init: SendInit = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let replied = false;
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: CLIENT_LOG_PATH,
        method: init.method ?? "POST",
        headers: init.headers,
        agent: false,
      },
      response => {
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        const finish = (): void => {
          if (!replied) {
            replied = true;
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              text: Buffer.concat(parts).toString(),
            });
          }
        };
        response.on("end", finish);
        response.on("close", finish);
      },
    );
    // The server may close while a big upload is still going out: that is an error after the answer, not instead of it
    request.on("error", error => {
      if (!replied) {
        reject(error);
      }
    });
    if (init.chunks === undefined) {
      request.end(init.body);
    } else {
      for (const chunk of init.chunks) {
        request.write(chunk);
      }
      request.end();
    }
  });
}

const entry = (extra: Partial<ClientLogEntry> = {}): ClientLogEntry => ({
  at: "2026-03-04T09:59:58.123Z",
  n: 0,
  level: "info",
  kind: "net",
  msg: "hello",
  ...extra,
});

const batch = (extra: Record<string, unknown> = {}, entries: unknown[] = [entry()]): Record<string, unknown> => ({
  v: 1,
  session: "s-1",
  room: "ABCDEF",
  seat: "host",
  name: "Sam",
  build: "abc1234",
  ua: "UA/1.0",
  entries,
  ...extra,
});

const post = (h: Harness, value: unknown, headers: Record<string, string> = TEXT): Promise<Reply> =>
  send(h.port, { headers, body: JSON.stringify(value) });

type Line = Record<string, unknown>;
const written = (h: Harness): Line[] => h.lines.map(line => JSON.parse(line) as Line);

describe("a client log that is off", () => {
  it("answers 404 to every method, and writes nothing", async () => {
    for (const enabled of [false, undefined]) {
      const h = await start({ enabled });
      for (const method of ["POST", "GET", "OPTIONS", "PUT", "DELETE"]) {
        const body = method === "POST" ? JSON.stringify(batch()) : undefined;
        const reply = await send(h.port, { method, headers: TEXT, body });
        expect([method, reply.status]).toEqual([method, 404]);
      }
      expect(h.lines).toEqual([]);
    }
  });

  it("lets a page on an allowed origin read the 404 (so that its client can stop), and no other", async () => {
    const h = await start({ enabled: false, allowedOrigins: ["https://play.example"] });
    const allowed = await send(h.port, { headers: { ...TEXT, origin: "https://play.example" }, body: "{}" });
    expect(allowed.status).toBe(404);
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://play.example");
    const other = await send(h.port, { headers: { ...TEXT, origin: "https://evil.example" }, body: "{}" });
    expect(other.status).toBe(404);
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("an accepted batch", () => {
  it("answers 204 and writes one line per entry, with the ip as its tag and the user agent on the first line only", async () => {
    const h = await start({ now: () => NOW });
    const body = batch({ token: "TOP-LEVEL-SECRET" }, [
      entry({ n: 0 }),
      { ...entry({ n: 1, level: "warn", kind: "seq", msg: "gap", data: { from: 3, to: 5 } }), secret: "ENTRY-SECRET" },
      entry({ n: 2, level: "error", data: null }),
    ]);
    const reply = await post(h, body, { ...TEXT, cookie: "sid=COOKIE-SECRET", authorization: "Bearer TOKEN-SECRET" });
    expect(reply.status).toBe(204);
    expect(reply.text).toBe("");

    const lines = written(h);
    expect(lines).toHaveLength(3);
    const common = {
      t: new Date(NOW).toISOString(),
      src: "client",
      ip: ipTag(TEST_IP),
      session: "s-1",
      room: "ABCDEF",
      seat: "host",
      name: "Sam",
      build: "abc1234",
    };
    expect(lines[0]).toEqual({
      ...common,
      ua: "UA/1.0",
      at: "2026-03-04T09:59:58.123Z",
      n: 0,
      level: "info",
      kind: "net",
      msg: "hello",
    });
    expect(Object.keys(lines[0]!)).toEqual([
      ...["t", "src", "ip", "session", "room", "seat", "name", "build", "ua"],
      ...["at", "n", "level", "kind", "msg"],
    ]);
    expect(lines[1]).toEqual({
      ...common,
      at: "2026-03-04T09:59:58.123Z",
      n: 1,
      level: "warn",
      kind: "seq",
      msg: "gap",
      data: { from: 3, to: 5 },
    });
    expect(lines[2]).toMatchObject({ n: 2, level: "error", data: null });
    expect(lines[2]).not.toHaveProperty("ua");

    // Nothing of the request but the batch's own fields: no raw ip, no headers, no fields the shape does not have
    const all = h.lines.join("\n");
    for (const secret of [TEST_IP, "127.0.0.1", "COOKIE-SECRET", "TOKEN-SECRET", "TOP-LEVEL-SECRET", "ENTRY-SECRET"]) {
      expect(all).not.toContain(secret);
    }
  });

  it("takes application/json as well as text/plain, nulls for room, seat and name, and 500 entries", async () => {
    const h = await start();
    const json = await post(h, batch({ room: null, seat: null, name: null }, [entry({ msg: "line one\nline two" })]), {
      "content-type": "application/json",
    });
    expect(json.status).toBe(204);
    expect(h.lines).toHaveLength(1); // a newline in a message does not make a second line
    expect(written(h)[0]).toMatchObject({ room: null, seat: null, name: null, msg: "line one\nline two" });

    const many = await post(
      h,
      batch(
        {},
        Array.from({ length: 500 }, (_, n) => entry({ n })),
      ),
    );
    expect(many.status).toBe(204);
    expect(h.lines).toHaveLength(501);
  });

  it("keeps a batch whose strings are too long, cut to their maximum", async () => {
    const h = await start();
    const cut = "a".repeat(100);
    const reply = await post(
      h,
      batch({ session: cut, room: cut, name: cut, build: cut, ua: "u".repeat(500) }, [
        entry({ at: cut, kind: cut, msg: "m".repeat(5000), data: "d".repeat(10_000) }),
        entry({ n: 1, data: "e".repeat(3998) }), // its JSON is 4000 characters: kept
        entry({ n: 2, data: "e".repeat(3999) }), // 4001: replaced
        entry({ n: 3, data: { list: Array.from({ length: 2000 }, (_, i) => i) } }),
      ]),
    );
    expect(reply.status).toBe(204);
    const [first, kept, replaced, object] = written(h);
    expect(first).toMatchObject({
      session: "a".repeat(64),
      room: "a".repeat(16),
      name: "a".repeat(40),
      build: "a".repeat(40),
      ua: "u".repeat(200),
      at: "a".repeat(40),
      kind: "a".repeat(40),
      msg: "m".repeat(2000),
      data: { truncated: true, preview: JSON.stringify("d".repeat(10_000)).slice(0, 500) },
    });
    expect(kept?.["data"]).toBe("e".repeat(3998));
    expect(replaced?.["data"]).toEqual({ truncated: true, preview: JSON.stringify("e".repeat(3999)).slice(0, 500) });
    const objectData = object?.["data"] as { truncated: boolean; preview: string } | undefined;
    expect(objectData?.truncated).toBe(true);
    expect(objectData?.preview).toHaveLength(500);
    expect(objectData?.preview.startsWith('{"list":[0,1,2,')).toBe(true);
  });

  it("replaces data that is nested too deep to measure, instead of failing", async () => {
    const h = await start();
    const deep = `${"[".repeat(30_000)}${"]".repeat(30_000)}`;
    const raw = `{"v":1,"session":"s","room":null,"seat":null,"name":null,"build":"b","ua":"u","entries":[{"at":"t","n":0,"level":"info","kind":"k","msg":"m","data":${deep}}]}`;
    const reply = await send(h.port, { headers: TEXT, body: raw });
    expect(reply.status).toBe(204);
    expect(written(h)[0]?.["data"]).toMatchObject({ truncated: true });
  });
});

describe("what is refused", () => {
  it("answers 413 to a body over the cap, declared or streamed, and does not wait for the rest of the upload", async () => {
    const h = await start({ maxBodyBytes: 4096 });
    const declared = await send(h.port, {
      headers: TEXT,
      body: JSON.stringify(batch({}, [entry({ msg: "x".repeat(5000) })])),
    });
    expect(declared.status).toBe(413);

    const big = await send(h.port, { headers: TEXT, body: Buffer.alloc(300_000, 120) });
    expect(big.status).toBe(413);

    const streamed = await send(h.port, {
      headers: TEXT,
      chunks: Array.from({ length: 8 }, () => Buffer.alloc(1024, 120)),
    });
    expect(streamed.status).toBe(413);

    // An upload that never ends: the answer comes anyway, as soon as the cap is passed
    const status = await new Promise<number>(resolve => {
      const request = httpRequest(
        { host: "127.0.0.1", port: h.port, path: CLIENT_LOG_PATH, method: "POST", headers: TEXT, agent: false },
        response => {
          response.resume();
          resolve(response.statusCode ?? 0);
          request.destroy();
        },
      );
      request.on("error", () => {});
      request.write(Buffer.alloc(3000, 120));
      request.write(Buffer.alloc(3000, 120));
    });
    expect(status).toBe(413);

    expect(h.lines).toEqual([]);
    expect((await post(h, batch())).status).toBe(204); // still serving
  });

  it("answers 400 to a body that is not JSON, and to bytes that are not UTF-8", async () => {
    const h = await start();
    const bodies: (string | Buffer)[] = [
      "{not json",
      "",
      '{"v":1',
      "undefined",
      Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]),
    ];
    for (const body of bodies) {
      const reply = await send(h.port, { headers: TEXT, body });
      expect([String(body), reply.status, reply.text]).toEqual([String(body), 400, "bad json"]);
    }
    expect(h.lines).toEqual([]);
  });

  const shapes: [string, unknown, string][] = [
    ["an array", [], "body is not an object"],
    ["a string", "hello", "body is not an object"],
    ["null", null, "body is not an object"],
    ["a version other than 1", batch({ v: 2 }), "v"],
    ["no version", batch({ v: undefined }), "v"],
    ["a session that is not a string", batch({ session: 5 }), "session"],
    ["no room", batch({ room: undefined }), "room"],
    ["a room that is a number", batch({ room: 5 }), "room"],
    ["a seat that is neither", batch({ seat: "spectator" }), "seat"],
    ["a name that is a number", batch({ name: 7 }), "name"],
    ["no build", batch({ build: undefined }), "build"],
    ["a user agent that is null", batch({ ua: null }), "ua"],
    ["no entries", batch({}, []), "entries (1..500)"],
    ["entries that are not an array", batch({ entries: {} }), "entries (1..500)"],
    [
      "501 entries",
      batch(
        {},
        Array.from({ length: 501 }, (_, n) => entry({ n })),
      ),
      "entries (1..500)",
    ],
    ["an entry that is a string", batch({}, ["x"]), "entries[0]: not an object"],
    ["an unknown level", batch({}, [entry(), entry({ level: "fatal" as never })]), "entries[1]: level"],
    ["a negative counter", batch({}, [entry({ n: -1 })]), "entries[0]: n"],
    ["a counter with a fraction", batch({}, [entry({ n: 1.5 })]), "entries[0]: n"],
    ["a counter that is a string", batch({}, [entry({ n: "1" as never })]), "entries[0]: n"],
    ["a time that is a number", batch({}, [entry({ at: 5 as never })]), "entries[0]: at"],
    ["no kind", batch({}, [{ ...entry(), kind: undefined }]), "entries[0]: kind"],
    ["a message that is a number", batch({}, [entry({ msg: 5 as never })]), "entries[0]: msg"],
  ];

  it.each(shapes)("answers 400 to %s, and names the field", async (_what, value, reason) => {
    const h = await start();
    const reply = await post(h, value);
    expect([reply.status, reply.text]).toEqual([400, `bad batch: ${reason}`]);
    expect(h.lines).toEqual([]);
  });

  it("answers 405 to a method other than POST and OPTIONS", async () => {
    const h = await start();
    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE"]) {
      const reply = await send(h.port, { method, headers: TEXT });
      expect([method, reply.status, reply.headers["allow"]]).toEqual([method, 405, "POST, OPTIONS"]);
    }
    expect(h.lines).toEqual([]);
  });
});

describe("the Origin rule of the relay", () => {
  it("answers 403 to another origin by default, for POST and for the preflight, and writes nothing", async () => {
    const h = await start();
    const origin = "https://evil.example";
    const posted = await send(h.port, { headers: { ...TEXT, origin }, body: JSON.stringify(batch()) });
    expect(posted.status).toBe(403);
    expect(posted.headers["access-control-allow-origin"]).toBeUndefined();
    const preflight = await send(h.port, {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST" },
    });
    expect(preflight.status).toBe(403);
    expect(h.lines).toEqual([]);
  });

  it("takes the page's own origin and a client that sends none", async () => {
    const h = await start();
    const own = await send(h.port, {
      headers: { ...TEXT, origin: `http://127.0.0.1:${h.port}` },
      body: JSON.stringify(batch()),
    });
    expect(own.status).toBe(204);
    const none = await post(h, batch());
    expect(none.status).toBe(204);
    expect(none.headers["access-control-allow-origin"]).toBeUndefined();
    expect(h.lines).toHaveLength(2);
  });

  it("echoes an origin of ALLOWED_ORIGINS, and refuses the others", async () => {
    const h = await start({ allowedOrigins: ["https://play.example"] });
    const ok = await send(h.port, {
      headers: { ...TEXT, origin: "https://play.example" },
      body: JSON.stringify(batch()),
    });
    expect(ok.status).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe("https://play.example");
    expect(ok.headers["vary"]).toBe("Origin");
    const refused = await send(h.port, {
      headers: { ...TEXT, origin: "https://other.example" },
      body: JSON.stringify(batch()),
    });
    expect(refused.status).toBe(403);
    expect(h.lines).toHaveLength(1);
  });

  it("echoes any origin when ALLOWED_ORIGINS is *, not the star", async () => {
    const h = await start({ allowedOrigins: ["*"] });
    const reply = await send(h.port, {
      headers: { ...TEXT, origin: "https://anywhere.example" },
      body: JSON.stringify(batch()),
    });
    expect(reply.status).toBe(204);
    expect(reply.headers["access-control-allow-origin"]).toBe("https://anywhere.example");
    expect(reply.headers["vary"]).toBe("Origin");
  });

  it("answers the preflight of an allowed origin with 204 and what it may send", async () => {
    const h = await start({ allowedOrigins: ["https://play.example"] });
    const reply = await send(h.port, {
      method: "OPTIONS",
      headers: {
        origin: "https://play.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(reply.status).toBe(204);
    expect(reply.text).toBe("");
    expect(reply.headers["access-control-allow-origin"]).toBe("https://play.example");
    expect(reply.headers["vary"]).toBe("Origin");
    expect(reply.headers["access-control-allow-methods"]).toBe("POST");
    expect(reply.headers["access-control-allow-headers"]).toBe("content-type");
    expect(h.lines).toEqual([]);
  });
});

describe("the rate limit", () => {
  it("answers 429 past the burst, per IP, and lets the bucket refill", async () => {
    const clock = { t: NOW };
    const h = await start({ now: () => clock.t, limits: { burst: 3, requestsPerMinute: 60 } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await post(h, batch())).status);
    }
    expect(statuses).toEqual([204, 204, 204, 429, 429]);
    expect(h.lines).toHaveLength(3);

    // Another IP has its own bucket
    const other = await send(h.port, {
      headers: { ...TEXT, "x-test-ip": "198.51.100.9" },
      body: JSON.stringify(batch()),
    });
    expect(other.status).toBe(204);

    // A preflight costs nothing: a client that sends application/json is not halved
    for (let i = 0; i < 5; i++) {
      expect((await send(h.port, { method: "OPTIONS" })).status).toBe(204);
    }

    clock.t += 1000; // 60 a minute: one token a second
    expect((await post(h, batch())).status).toBe(204);
    expect((await post(h, batch())).status).toBe(429);
  });

  it("answers 429 to a request over the rate before it reads the body", async () => {
    const clock = { t: NOW };
    const h = await start({ now: () => clock.t, limits: { burst: 1 } });
    expect((await post(h, batch())).status).toBe(204);
    const refused = await send(h.port, { headers: TEXT, body: Buffer.alloc(300_000, 120) });
    expect(refused.status).toBe(429);
  });

  it("forgets the IPs whose bucket is full again", async () => {
    const clock = { t: NOW };
    const h = await start({ now: () => clock.t });
    for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) {
      await send(h.port, { headers: { ...TEXT, "x-test-ip": ip }, body: JSON.stringify(batch()) });
    }
    expect(h.handler.trackedIps).toBe(3);
    clock.t += 2 * 60_000;
    await post(h, batch());
    expect(h.handler.trackedIps).toBe(1);
  });
});

describe("LOG_DIR", () => {
  it("appends the same lines to a file named for the UTC date, in a directory it makes, and starts a new file at midnight", async () => {
    const dir = join(tempDir(), "logs", "deeper");
    const clock = { t: Date.UTC(2026, 2, 4, 23, 59, 0) };
    const h = await start({ dir, now: () => clock.t });

    expect((await post(h, batch({}, [entry({ n: 0 }), entry({ n: 1 })]))).status).toBe(204);
    const first = join(dir, "client-2026-03-04.jsonl");
    expect(readFileSync(first, "utf8")).toBe(`${h.lines.join("\n")}\n`);

    clock.t += 2 * 60_000;
    expect((await post(h, batch({}, [entry({ n: 2 })]))).status).toBe(204);
    expect(readdirSync(dir).sort()).toEqual(["client-2026-03-04.jsonl", "client-2026-03-05.jsonl"]);
    expect(readFileSync(join(dir, "client-2026-03-05.jsonl"), "utf8")).toBe(`${h.lines.at(-1)}\n`);
    expect(readFileSync(first, "utf8").trimEnd().split("\n")).toHaveLength(2);
  });

  it.each([
    [8000, ["client-2026-01-02.jsonl", "client-2026-01-03.jsonl", "client-keep.jsonl", "notes.txt"]],
    [3000, ["client-2026-01-03.jsonl", "client-keep.jsonl", "notes.txt"]],
  ])(
    "deletes the oldest client files until the directory is under %i bytes, and leaves other files alone",
    async (cap, left) => {
      const dir = tempDir();
      writeFileSync(join(dir, "client-2026-01-01.jsonl"), "a".repeat(5000));
      writeFileSync(join(dir, "client-2026-01-02.jsonl"), "b".repeat(5000));
      writeFileSync(join(dir, "client-keep.jsonl"), "c".repeat(5000));
      writeFileSync(join(dir, "notes.txt"), "d".repeat(5000));
      const h = await start({ dir, maxDirBytes: cap, now: () => Date.UTC(2026, 0, 3, 12) });
      expect((await post(h, batch())).status).toBe(204);
      expect(readdirSync(dir).sort()).toEqual(left);
    },
  );

  it("writes no more to the file than the cap allows, and never deletes the file of the day, while stdout gets everything", async () => {
    const dir = tempDir();
    const h = await start({ dir, maxDirBytes: 2000, now: () => NOW });
    for (let i = 0; i < 10; i++) {
      expect((await post(h, batch({}, [entry({ n: i })]))).status).toBe(204);
    }
    const size = statSync(join(dir, "client-2026-03-04.jsonl")).size;
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(2000);
    expect(h.lines).toHaveLength(10);
  });

  it("answers 204 and keeps writing to stdout when the directory cannot be used", async () => {
    const blocker = join(tempDir(), "blocker");
    writeFileSync(blocker, "a file where a directory should be");
    const messages: string[] = [];
    const h = await start({ dir: join(blocker, "logs"), log: message => messages.push(message) });
    expect((await post(h, batch())).status).toBe(204);
    expect((await post(h, batch())).status).toBe(204);
    expect(h.lines).toHaveLength(2);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("stdout only");
  });
});

describe("ClientLogSink", () => {
  it("looks at the size of the directory on the first write, then every 100 lines or 30 s, not on every write", () => {
    const dir = tempDir();
    const clock = { t: NOW };
    const sink = new ClientLogSink({ write: () => {}, dir, maxDirBytes: 1000, now: () => clock.t });
    const old = join(dir, "client-2020-01-01.jsonl");

    sink.write(["x"]); // the first write looks: nothing to delete yet
    writeFileSync(old, "o".repeat(5000));
    sink.write(["x"]);
    expect(existsSync(old)).toBe(true); // it did not look again

    clock.t += 31_000;
    sink.write(["x"]);
    expect(existsSync(old)).toBe(false); // 30 s: it looked

    writeFileSync(old, "o".repeat(5000));
    sink.write(Array.from({ length: 100 }, () => "x"));
    expect(existsSync(old)).toBe(true);
    sink.write(["x"]);
    expect(existsSync(old)).toBe(false); // 100 lines: it looked
  });

  it("counts a file error, goes on with stdout, and tries the file again after 30 s", () => {
    const base = tempDir();
    const blocker = join(base, "blocker");
    writeFileSync(blocker, "a file where a directory should be");
    const dir = join(blocker, "logs");
    const clock = { t: NOW };
    const lines: string[] = [];
    const messages: string[] = [];
    const sink = new ClientLogSink({
      write: line => lines.push(line),
      dir,
      now: () => clock.t,
      log: message => messages.push(message),
    });

    expect(() => sink.write(["one"])).not.toThrow();
    expect(sink.fileErrors).toBe(1);
    sink.write(["two"]); // within the 30 s: no new try
    expect(sink.fileErrors).toBe(1);
    expect(lines).toEqual(["one", "two"]);
    expect(sink.fileDropped).toBe(2);

    rmSync(blocker);
    clock.t += 31_000;
    sink.write(["three"]);
    expect(readFileSync(join(dir, "client-2026-03-04.jsonl"), "utf8")).toBe("three\n");
    expect(lines).toEqual(["one", "two", "three"]);
    expect(messages).toHaveLength(2); // it failed, it works again
  });

  it("does not let a write that throws (a closed pipe) fail the caller", () => {
    const sink = new ClientLogSink({
      write: () => {
        throw new Error("EPIPE");
      },
    });
    expect(() => sink.write(["x"])).not.toThrow();
  });
});

describe("parseClientLogBatch", () => {
  it("returns the batch with its strings cut, and a reason that does not quote the value", () => {
    const ok = parseClientLogBatch(batch({ session: "s".repeat(80) }));
    expect(ok.ok && ok.batch.session).toBe("s".repeat(64));
    const bad = parseClientLogBatch(batch({ seat: "PASSWORD-123" }));
    expect(bad).toEqual({ ok: false, reason: "seat" });
  });

  it("does not leave half a surrogate pair at a cut", () => {
    const result = parseClientLogBatch(batch({ name: `${"n".repeat(39)}😀` }));
    expect(result.ok && result.batch.name).toBe("n".repeat(39));
  });
});
