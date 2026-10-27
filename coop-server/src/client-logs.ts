/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { ipTag, originAllowed, TokenBucket } from "./limits.ts";

/**
 * The client diagnostics log: `POST /coop/log` takes a batch of log entries from a client and writes one JSON line per
 * entry to stdout and, if asked, to a dated file in a directory that is kept under a size.
 * - Off unless enabled: every method answers 404, so a client can tell and stop sending.
 * - The body is JSON sent as `text/plain` (a "simple" cross-origin request: no preflight) or `application/json`.
 * - Nothing of the request is logged except the validated, truncated fields of the batch and {@linkcode ipTag} of the IP:
 *   never the raw body, the headers (cookies, tokens) or the address itself.
 *
 * @module
 */

/** Where the client posts, next to the relay's own path (`/coop`) */
export const CLIENT_LOG_PATH = "/coop/log";

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_MAX_DIR_BYTES = 200 * 1024 * 1024;

export interface ClientLogLimits {
  /** Requests per minute one IP may post (a steady rate) */
  requestsPerMinute: number;
  /** How many requests one IP may post at once before the steady rate applies */
  burst: number;
}

export const DEFAULT_CLIENT_LOG_LIMITS: ClientLogLimits = { requestsPerMinute: 60, burst: 20 };

/** What is kept of a batch: a longer string is cut, not refused. Entries are the only count that is refused. */
export const CLIENT_LOG_FIELD_MAX = {
  session: 64,
  room: 16,
  name: 40,
  build: 40,
  ua: 200,
  at: 40,
  kind: 40,
  msg: 2000,
  /** Length of the JSON of an entry's `data`; over it, `data` is replaced by a preview */
  data: 4000,
  /** Length of that preview */
  dataPreview: 500,
  entries: 500,
} as const;

export type ClientLogLevel = "debug" | "info" | "warn" | "error";

export interface ClientLogEntry {
  /** The client's own clock, ISO 8601 */
  at: string;
  /** The client's own counter of entries, to see what was lost */
  n: number;
  level: ClientLogLevel;
  kind: string;
  msg: string;
  data?: unknown;
}

/** A batch as the client sends it and as the server keeps it (validated, strings cut to their maximum) */
export interface ClientLogBatch {
  v: 1;
  session: string;
  room: string | null;
  seat: "host" | "guest" | null;
  name: string | null;
  build: string;
  ua: string;
  entries: ClientLogEntry[];
}

export type ClientLogParseResult = { ok: true; batch: ClientLogBatch } | { ok: false; reason: string };

// #region Validation

const LEVELS: ReadonlySet<string> = new Set<ClientLogLevel>(["debug", "info", "warn", "error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Cut a string to at most `max` UTF-16 units without leaving half a surrogate pair at the end */
function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** `data` as it is when its JSON is short enough, else a stand-in with the start of the JSON */
function clipData(data: unknown): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(data);
  } catch {
    // Nested so deep that the serializer gives up
    return { truncated: true, preview: "" };
  }
  if (json === undefined || json.length <= CLIENT_LOG_FIELD_MAX.data) {
    return data;
  }
  return { truncated: true, preview: clip(json, CLIENT_LOG_FIELD_MAX.dataPreview) };
}

function parseEntry(raw: unknown): ClientLogEntry | string {
  if (!isRecord(raw)) {
    return "not an object";
  }
  if (typeof raw["at"] !== "string") {
    return "at";
  }
  const n = raw["n"];
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    return "n";
  }
  const level = raw["level"];
  if (typeof level !== "string" || !LEVELS.has(level)) {
    return "level";
  }
  if (typeof raw["kind"] !== "string") {
    return "kind";
  }
  if (typeof raw["msg"] !== "string") {
    return "msg";
  }
  const entry: ClientLogEntry = {
    at: clip(raw["at"], CLIENT_LOG_FIELD_MAX.at),
    n,
    level: level as ClientLogLevel,
    kind: clip(raw["kind"], CLIENT_LOG_FIELD_MAX.kind),
    msg: clip(raw["msg"], CLIENT_LOG_FIELD_MAX.msg),
  };
  if (Object.hasOwn(raw, "data")) {
    entry.data = clipData(raw["data"]);
  }
  return entry;
}

/**
 * Check the parsed JSON of a request against the batch shape. Strings that are too long are cut; a field of the wrong type,
 * an unknown version, an entry of the wrong shape or a count of entries outside 1..500 is refused. The reason names the
 * field and never quotes the value.
 */
export function parseClientLogBatch(value: unknown): ClientLogParseResult {
  if (!isRecord(value)) {
    return { ok: false, reason: "body is not an object" };
  }
  if (value["v"] !== 1) {
    return { ok: false, reason: "v" };
  }
  const { session, room, seat, name, build, ua, entries } = value;
  if (typeof session !== "string") {
    return { ok: false, reason: "session" };
  }
  if (room !== null && typeof room !== "string") {
    return { ok: false, reason: "room" };
  }
  if (seat !== null && seat !== "host" && seat !== "guest") {
    return { ok: false, reason: "seat" };
  }
  if (name !== null && typeof name !== "string") {
    return { ok: false, reason: "name" };
  }
  if (typeof build !== "string") {
    return { ok: false, reason: "build" };
  }
  if (typeof ua !== "string") {
    return { ok: false, reason: "ua" };
  }
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > CLIENT_LOG_FIELD_MAX.entries) {
    return { ok: false, reason: `entries (1..${CLIENT_LOG_FIELD_MAX.entries})` };
  }
  const kept: ClientLogEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = parseEntry(entries[i]);
    if (typeof entry === "string") {
      return { ok: false, reason: `entries[${i}]: ${entry}` };
    }
    kept.push(entry);
  }
  return {
    ok: true,
    batch: {
      v: 1,
      session: clip(session, CLIENT_LOG_FIELD_MAX.session),
      room: room === null ? null : clip(room, CLIENT_LOG_FIELD_MAX.room),
      seat,
      name: name === null ? null : clip(name, CLIENT_LOG_FIELD_MAX.name),
      build: clip(build, CLIENT_LOG_FIELD_MAX.build),
      ua: clip(ua, CLIENT_LOG_FIELD_MAX.ua),
      entries: kept,
    },
  };
}

/**
 * One JSON line per entry. The user agent is on the first line of a batch only, to keep the others short.
 * @param serverTime - ISO time the batch arrived
 * @param tag - {@linkcode ipTag} of the sender
 */
export function formatClientLogLines(batch: ClientLogBatch, serverTime: string, tag: string): string[] {
  return batch.entries.map((entry, index) =>
    JSON.stringify({
      t: serverTime,
      src: "client",
      ip: tag,
      session: batch.session,
      room: batch.room,
      seat: batch.seat,
      name: batch.name,
      build: batch.build,
      ...(index === 0 ? { ua: batch.ua } : {}),
      at: entry.at,
      n: entry.n,
      level: entry.level,
      kind: entry.kind,
      msg: entry.msg,
      ...(Object.hasOwn(entry, "data") ? { data: entry.data } : {}),
    }),
  );
}

// #endregion

// #region Sink

/** The files the sink writes and, with them, the only ones it counts and deletes */
const FILE_NAME = /^client-\d{4}-\d{2}-\d{2}\.jsonl$/;
const CHECK_EVERY_LINES = 100;
const CHECK_EVERY_MS = 30_000;

export interface ClientLogSinkOptions {
  /** Where every line goes. Default: stdout. */
  write?: ((line: string) => void) | undefined;
  /** `LOG_DIR`: also append the lines to `<dir>/client-YYYY-MM-DD.jsonl` (UTC date). Default: stdout only. */
  dir?: string | undefined;
  /** The `client-*.jsonl` files of `dir` are kept under this many bytes by deleting the oldest. Default 200 MiB. */
  maxDirBytes?: number | undefined;
  now?: (() => number) | undefined;
  /** Told when the file fails and when it works again (once each, not for every line) */
  log?: ((message: string) => void) | undefined;
}

/**
 * Writes lines to stdout (or the injected `write`) and, if there is a directory, to a dated file in it.
 * The file is best effort: an error (no space, no permission, the directory gone) is counted and the lines go to stdout only;
 * the file is tried again 30 s later. Nothing here throws.
 * The size of the directory is looked at on the first write and then every 100 lines or 30 s, not on every write; between
 * looks, what is written is added to the last size. A line that would take the directory over its size is not written to the
 * file (the file of the day is never deleted to make room: that is the newest data).
 */
export class ClientLogSink {
  /** File operations that failed */
  fileErrors = 0;
  /** Lines that stayed out of the file: the directory is full, or the file was failing */
  fileDropped = 0;

  private readonly out: (line: string) => void;
  private readonly dir: string | undefined;
  private readonly maxDirBytes: number;
  private readonly now: () => number;
  private readonly log: ((message: string) => void) | undefined;
  private ready = false;
  private failing = false;
  private retryAt = Number.NEGATIVE_INFINITY;
  private lastCheck = Number.NEGATIVE_INFINITY;
  private linesSinceCheck = 0;
  private dirBytes = 0;

  constructor(options: ClientLogSinkOptions = {}) {
    this.out =
      options.write
      ?? ((line: string): void => {
        process.stdout.write(`${line}\n`);
      });
    this.dir = options.dir === "" ? undefined : options.dir;
    this.maxDirBytes = options.maxDirBytes ?? DEFAULT_MAX_DIR_BYTES;
    this.now = options.now ?? Date.now;
    this.log = options.log;
  }

  write(lines: readonly string[]): void {
    if (lines.length === 0) {
      return;
    }
    for (const line of lines) {
      try {
        this.out(line);
      } catch {
        // A closed pipe is not a reason to fail the request
      }
    }
    if (this.dir !== undefined) {
      this.toFile(this.dir, lines);
    }
  }

  private toFile(dir: string, lines: readonly string[]): void {
    const time = this.now();
    if (time < this.retryAt) {
      this.fileDropped += lines.length;
      return;
    }
    try {
      if (!this.ready) {
        mkdirSync(dir, { recursive: true });
        this.ready = true;
      }
      const name = `client-${new Date(time).toISOString().slice(0, 10)}.jsonl`;
      if (this.linesSinceCheck >= CHECK_EVERY_LINES || time - this.lastCheck >= CHECK_EVERY_MS) {
        this.enforceCap(dir, name);
        this.lastCheck = time;
        this.linesSinceCheck = 0;
      }
      this.linesSinceCheck += lines.length;
      const text = `${lines.join("\n")}\n`;
      const bytes = Buffer.byteLength(text);
      if (this.dirBytes + bytes > this.maxDirBytes) {
        this.fileDropped += lines.length;
        return;
      }
      appendFileSync(join(dir, name), text);
      this.dirBytes += bytes;
      if (this.failing) {
        this.failing = false;
        this.log?.(`coop client logs: writing to ${dir} again`);
      }
    } catch (error) {
      this.ready = false;
      this.fileErrors++;
      this.fileDropped += lines.length;
      this.retryAt = time + CHECK_EVERY_MS;
      if (!this.failing) {
        this.failing = true;
        this.log?.(
          `coop client logs: cannot write to ${dir} (${(error as NodeJS.ErrnoException).code ?? "error"}): stdout only`,
        );
      }
    }
  }

  /** Delete the oldest `client-*.jsonl` files until the rest fit; `current` (the file being written) stays */
  private enforceCap(dir: string, current: string): void {
    const files = readdirSync(dir)
      .filter(name => FILE_NAME.test(name))
      .sort() // the names carry the UTC date: the oldest first
      .map(name => {
        try {
          return { name, size: statSync(join(dir, name)).size };
        } catch {
          return { name, size: 0 };
        }
      });
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (total <= this.maxDirBytes) {
        break;
      }
      if (file.name === current) {
        continue;
      }
      try {
        unlinkSync(join(dir, file.name));
        total -= file.size;
      } catch {
        this.fileErrors++;
      }
    }
    this.dirBytes = total;
  }
}

// #endregion

// #region Handler

export interface ClientLogOptions {
  /** `CLIENT_LOGS=1`. Default off: every method answers 404. */
  enabled?: boolean | undefined;
  /** `ALLOWED_ORIGINS`, as the relay reads it: `["*"]` allows all; `null` (the default): only the page's own origin */
  allowedOrigins?: readonly string[] | null | undefined;
  /** Largest body accepted (413 beyond). Default 64 KiB. */
  maxBodyBytes?: number | undefined;
  /** Per-IP rate; what is not given keeps its default (60 a minute, a burst of 20) */
  limits?: Partial<ClientLogLimits> | undefined;
  /** `LOG_DIR`: also keep the lines in dated files here */
  dir?: string | undefined;
  /** Size the files of `dir` are kept under. Default 200 MiB. */
  maxDirBytes?: number | undefined;
  /** Where the lines go. Default: stdout. */
  write?: ((line: string) => void) | undefined;
  /** Injected for tests. */
  now?: (() => number) | undefined;
  /** The server's own log: told when the files fail, never about requests. */
  log?: ((message: string) => void) | undefined;
}

/** Answers `POST` and `OPTIONS` to the client log path; the caller routes the path and finds the IP (`clientIp`) */
export interface ClientLogHandler {
  (request: IncomingMessage, response: ServerResponse, ip: string): void;
  /** IPs with a rate limit state right now (idle ones are dropped) */
  readonly trackedIps: number;
}

const SWEEP_EVERY_MS = 60_000;
const PREFLIGHT_MAX_AGE_S = 600;

function respond(response: ServerResponse, status: number, text: string, headers: Record<string, string>): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(text);
}

/** How much of an upload that was refused early is read and thrown away, and for how long, before the socket is cut */
const DRAIN_MAX_BYTES = 1_048_576;
const DRAIN_MAX_MS = 5000;

/**
 * Refused before the body was read (429, 413): read the rest of it and throw it away, up to a cap, so that the client gets
 * to read the answer. Closing a socket the client is still writing to resets it, and on some systems the client then sees
 * the reset instead of the answer. An upload past the cap or the time is cut off.
 */
function drain(request: IncomingMessage): void {
  let drained = 0;
  const timer = setTimeout(() => request.destroy(), DRAIN_MAX_MS);
  timer.unref();
  request.on("data", (chunk: Buffer) => {
    drained += chunk.length;
    if (drained > DRAIN_MAX_BYTES) {
      clearTimeout(timer);
      request.destroy();
    }
  });
  request.on("end", () => clearTimeout(timer));
  request.on("close", () => clearTimeout(timer));
  request.resume();
}

type Body = { ok: true; body: Buffer } | { ok: false; reason: "tooLarge" | "aborted" };

/**
 * Read a body, counting bytes. Past `maxBytes` it stops keeping them at once: the caller answers 413 with `Connection: close`
 * and the server drops the rest of the upload when the answer is out (answering first, so that the client sees it).
 */
function readBody(request: IncomingMessage, maxBytes: number): Promise<Body> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (result: Body): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("close", onClose);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
        chunks.length = 0;
        done({ ok: false, reason: "tooLarge" });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => done({ ok: true, body: Buffer.concat(chunks) });
    const onClose = (): void => done({ ok: false, reason: "aborted" });
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("close", onClose);
  });
}

/**
 * Build the handler of `POST /coop/log` (and `OPTIONS` for its preflight). In the order a request is judged:
 * disabled: 404 (any method); not POST/OPTIONS: 405; `Origin` refused (the relay's rule, {@linkcode originAllowed}): 403;
 * OPTIONS: 204; over the IP's rate: 429; body over the cap: 413; not UTF-8 JSON of the batch shape: 400; else 204.
 * An allowed `Origin` is echoed in `Access-Control-Allow-Origin` (with `Vary: Origin`) on every answer, so that a page on
 * another origin can read the 404 that tells it to stop.
 */
export function createClientLogHandler(options: ClientLogOptions = {}): ClientLogHandler {
  const enabled = options.enabled ?? false;
  const allowedOrigins = options.allowedOrigins ?? null;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const limits: ClientLogLimits = { ...DEFAULT_CLIENT_LOG_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const sink = new ClientLogSink({
    write: options.write,
    dir: options.dir,
    maxDirBytes: options.maxDirBytes,
    now,
    log: options.log,
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const buckets = new Map<string, TokenBucket>();
  let lastSweep = now();

  /** Forget the IPs whose bucket is full again, like the relay's limiter does (here on a request, so there is no timer) */
  const sweep = (time: number): void => {
    if (time - lastSweep < SWEEP_EVERY_MS) {
      return;
    }
    lastSweep = time;
    for (const [ip, bucket] of buckets) {
      if (bucket.idle(time)) {
        buckets.delete(ip);
      }
    }
  };

  const allow = (ip: string): boolean => {
    const time = now();
    sweep(time);
    let bucket = buckets.get(ip);
    if (bucket === undefined) {
      bucket = new TokenBucket(limits.burst, limits.requestsPerMinute / 60_000, time);
      buckets.set(ip, bucket);
    }
    return bucket.take(time);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse, ip: string): Promise<void> => {
    // An upload that is cut off emits 'error' on the request; without a listener that would be thrown
    request.on("error", () => {});
    const origin = request.headers.origin;
    const originOk = originAllowed(origin, request.headers.host, allowedOrigins);
    const cors: Record<string, string> =
      originOk && origin !== undefined && origin !== ""
        ? { "access-control-allow-origin": origin, vary: "Origin" }
        : {};

    if (!enabled) {
      respond(response, 404, "client logs are off", cors);
      return;
    }
    if (request.method !== "POST" && request.method !== "OPTIONS") {
      respond(response, 405, "method not allowed", { ...cors, allow: "POST, OPTIONS" });
      return;
    }
    if (!originOk) {
      respond(response, 403, "origin not allowed", {});
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        ...cors,
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": String(PREFLIGHT_MAX_AGE_S),
        "cache-control": "no-store",
      });
      response.end();
      return;
    }
    if (!allow(ip)) {
      respond(response, 429, "too many requests", { ...cors, connection: "close" });
      drain(request);
      return;
    }

    const tooLarge = (): void => {
      respond(response, 413, "body too large", { ...cors, connection: "close" });
      drain(request);
    };
    if (Number(request.headers["content-length"]) > maxBodyBytes) {
      tooLarge();
      return;
    }
    const read = await readBody(request, maxBodyBytes);
    if (!read.ok) {
      if (read.reason === "tooLarge") {
        tooLarge();
      }
      return; // aborted: nobody is left to answer
    }

    let value: unknown;
    try {
      value = JSON.parse(decoder.decode(read.body));
    } catch {
      respond(response, 400, "bad json", cors);
      return;
    }
    const parsed = parseClientLogBatch(value);
    if (!parsed.ok) {
      respond(response, 400, `bad batch: ${parsed.reason}`, cors);
      return;
    }

    sink.write(formatClientLogLines(parsed.batch, new Date(now()).toISOString(), ipTag(ip)));
    response.writeHead(204, { ...cors, "cache-control": "no-store" });
    response.end();
  };

  const handler = (request: IncomingMessage, response: ServerResponse, ip: string): void => {
    handle(request, response, ip).catch(() => {
      if (response.writableEnded) {
        return;
      }
      if (response.headersSent) {
        response.destroy();
      } else {
        respond(response, 500, "server error", {});
      }
    });
  };
  return Object.defineProperty(handler, "trackedIps", {
    get: () => buckets.size,
    enumerable: true,
  }) as ClientLogHandler;
}

// #endregion
