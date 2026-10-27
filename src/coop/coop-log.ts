/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * The co-op log (DECISIONS D26): what happened in this browser's co-op sessions, for whoever looks after the game. It records
 * the session and the lobby, every sequenced decision, the link (the partner leaving and coming back), the resyncs and their
 * reasons, the errors and warnings of the co-op code and of the page, and a note when nothing moved for a long time.
 *
 * - It is kept in memory and in `localStorage`, so a reload or a crash does not lose it.
 * - It is sent in batches to the server the page came from (`POST /coop/log`), when that server collects client logs
 *   (`CLIENT_LOGS=1`): a server that does not answers 404, and the log stops sending to it.
 * - "Report a problem" (`report-button.ts`) adds a snapshot of the game, sends at once, and saves a file as well.
 *
 * It holds display names, the room code, the seat and what the decisions were; never a seat token or an address. It never
 * touches the simulation: nothing reads it back.
 *
 * No game imports: every co-op module may log without an import cycle.
 *
 * @module
 */

export type CoopLogLevel = "debug" | "info" | "warn" | "error";

export interface CoopLogEntry {
  /** When, as the browser's clock has it (ISO) */
  at: string;
  /** Counts every entry this browser wrote, across reloads: the lines of the server and of a saved file line up by it */
  n: number;
  level: CoopLogLevel;
  /** What kind of thing happened: `session`, `lobby`, `decision`, `link`, `resync`, `error`, `stall`, `report`, ... */
  kind: string;
  msg: string;
  data?: unknown;
}

/** Who and where, sent with every batch */
export interface CoopLogContext {
  room: string | null;
  seat: "host" | "guest" | null;
  name: string | null;
  /** The build identity, short (`<sha>+<dirty>`) */
  build: string;
}

/** What a batch to the server looks like (the server checks the same shape) */
export interface CoopLogBatch extends CoopLogContext {
  v: 1;
  /** One per page load: the lines of one tab in the server's log */
  session: string;
  ua: string;
  entries: CoopLogEntry[];
}

/** What the log needs from the browser; a test passes its own */
export interface CoopLogEnvironment {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  now(): Date;
  /** Sends a batch; resolves with the HTTP status, or rejects when the request did not get through */
  post(url: string, body: string, keepalive: boolean): Promise<number>;
  /** Sends a last batch while the page is being left (`navigator.sendBeacon`); `false` if it could not */
  beacon(url: string, body: string): boolean;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  sessionId(): string;
  userAgent: string;
}

/** Entries kept in memory */
export const LOG_BUFFER = 4000;
/** Entries kept in `localStorage`, and at most this many characters of them */
export const LOG_PERSISTED = 1500;
export const LOG_PERSISTED_MAX_CHARS = 600_000;
/** A batch holds at most this many entries, and at most this many characters (the server takes 64 KiB) */
export const BATCH_ENTRIES = 200;
export const BATCH_MAX_CHARS = 56_000;
/** How long an entry waits before it is sent: an error goes soon, the rest goes together */
const SEND_SOON_MS = 1000;
const SEND_LATER_MS = 10_000;
/** After a failed send, the next try waits this long (doubling up to the cap) */
const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 120_000;
/** An entry's data whose JSON is longer than this is cut (the server keeps 4000) */
export const MAX_DATA_CHARS = 3000;
/** A report's snapshot goes in at most this many entries */
export const REPORT_MAX_PARTS = 40;
/** The same entry again within this time of the first (same level, kind, message and data) is counted on the first one */
const REPEAT_MS = 1000;
/** How many of the newest entries a repeat is looked for among */
const REPEAT_LOOKBACK = 8;
/** `localStorage` is written at most once in this time, an error's write too (it goes at once otherwise) */
const PERSIST_MIN_GAP_MS = 1000;
const STORAGE_KEY = "coopLog";

interface Persisted {
  next: number;
  sentUpTo: number;
  entries: CoopLogEntry[];
}

/** One of the newest entries, which a repeat is counted on */
interface RecentEntry {
  entry: CoopLogEntry;
  /** Level, kind, message and data: what an entry must have to be the same */
  same: string;
  /** Its message without the count */
  msg: string;
  /** When it was written first (the log's clock) */
  at: number;
  /** How many times it came */
  count: number;
}

/**
 * The data of an entry as plain JSON, short enough for the server: an `Error` becomes its message and the top of its stack
 * @param max - Longer JSON than this is replaced by its start
 */
export function toLogData(value: unknown, max = MAX_DATA_CHARS): unknown {
  if (value instanceof Error) {
    return { error: value.name, message: value.message, stack: value.stack?.split("\n").slice(0, 6).join("\n") };
  }
  if (value === undefined) {
    return undefined;
  }
  try {
    const json = JSON.stringify(value);
    if (json === undefined) {
      return String(value);
    }
    return json.length > max ? { truncated: true, preview: json.slice(0, 500) } : JSON.parse(json);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const jsonLength = (value: unknown): number => JSON.stringify(value)?.length ?? 4;

/**
 * Plain JSON data too long for one entry (a report's snapshot), cut into pieces whose JSON fits in `max` characters each.
 * Keys go together while they fit; a value too long for a piece of its own is cut again, its parts keyed by where they are
 * in it (`trace[0..59]`, `party[2].moves`, `message@1400`). Merged back in order, the pieces are the data.
 */
export function splitLogData(data: Record<string, unknown>, max = MAX_DATA_CHARS): Record<string, unknown>[] {
  const pieces: Record<string, unknown>[] = [];
  let current: Record<string, unknown> = {};
  /** The JSON length of `current`, `{}` and a comma per key included */
  let size = 2;
  const close = (): void => {
    if (size > 2) {
      pieces.push(current);
      current = {};
      size = 2;
    }
  };
  const put = (key: string, value: unknown, depth: number): void => {
    const extra = jsonLength(key) + 1 + jsonLength(value) + 1;
    if (size + extra > max) {
      close();
      if (2 + extra > max) {
        for (const [part, partValue] of cutValue(key, value, max, depth)) {
          put(part, partValue, depth + 1);
        }
        return;
      }
    }
    current[key] = value;
    size += extra;
  };
  for (const [key, value] of Object.entries(data)) {
    put(key, value, 0);
  }
  close();
  return pieces;
}

/** A value too long for a piece of its own, in parts that are each shorter, keyed by where they are in it */
function cutValue(key: string, value: unknown, max: number, depth: number): [string, unknown][] {
  // What a part may take: the piece's braces, the key and the index added to it take the rest
  const room = max - jsonLength(key) - 16;
  if (depth >= 6 || room < 100) {
    return [[key.slice(0, 100), { truncated: true }]];
  }
  if (Array.isArray(value)) {
    const parts: [string, unknown][] = [];
    let start = 0;
    let run: unknown[] = [];
    let runSize = 2;
    const flush = (end: number): void => {
      if (run.length > 0) {
        parts.push([`${key}[${start}..${end - 1}]`, run]);
      }
      run = [];
      runSize = 2;
      start = end;
    };
    value.forEach((item, index) => {
      const itemSize = jsonLength(item) + 1;
      if (runSize + itemSize > room) {
        flush(index);
        if (2 + itemSize > room) {
          // Cut again on its own
          parts.push([`${key}[${index}]`, item]);
          start = index + 1;
          return;
        }
      }
      run.push(item);
      runSize += itemSize;
    });
    flush(value.length);
    return parts;
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([subKey, subValue]) => [`${key}.${subKey}`, subValue]);
  }
  if (typeof value === "string") {
    const parts: [string, unknown][] = [];
    let at = 0;
    while (at < value.length) {
      let length = Math.min(value.length - at, room);
      // An escaped character takes more than one
      while (length > 1 && jsonLength(value.slice(at, at + length)) > room) {
        length = Math.max(1, Math.floor(length * 0.75));
      }
      parts.push([`${key}@${at}`, value.slice(at, at + length)]);
      at += length;
    }
    return parts;
  }
  // A number, a boolean or null is short: only a key too long is left, which the depth stops
  return [[key, value]];
}

export class CoopLog {
  private readonly env: CoopLogEnvironment;
  private entries: CoopLogEntry[] = [];
  private next = 0;
  /** Every entry with `n` below this reached the server */
  private sentUpTo = 0;
  private context: CoopLogContext = { room: null, seat: null, name: null, build: "unknown" };
  private readonly session: string;
  private url: string | null = null;
  /** The server said it does not collect client logs */
  private refused = false;
  private sendTimer: unknown = null;
  private sendAt = Number.POSITIVE_INFINITY;
  /** The sends under way (one at a time) */
  private sendingNow: Promise<void> | null = null;
  /** The batch under way holds the entries below this (`0`: none): they are not changed any more */
  private sendingUpTo = 0;
  /** Counts the batches the server refused for good (they are not sent again) */
  private dropped = 0;
  private retryMs = RETRY_MIN_MS;
  private persistTimer: unknown = null;
  /** When the persist timer goes off, and when the log was last written (the log's clock) */
  private persistAt = Number.POSITIVE_INFINITY;
  private lastPersist = Number.NEGATIVE_INFINITY;
  /** The newest entries, for a repeat to be counted on */
  private recent: RecentEntry[] = [];

  constructor(env: CoopLogEnvironment) {
    this.env = env;
    this.session = env.sessionId();
    this.load();
  }

  /** What is in the log now, oldest first */
  get all(): readonly CoopLogEntry[] {
    return this.entries;
  }

  get sessionId(): string {
    return this.session;
  }

  /** The log's clock, in milliseconds (what the stall watch measures with) */
  now(): number {
    return this.env.now().getTime();
  }

  /** Whether the server takes the log (`null`: not asked yet, or no server set) */
  get serverCollects(): boolean | null {
    if (this.url === null) {
      return null;
    }
    return this.refused ? false : this.sentUpTo > 0 ? true : null;
  }

  setContext(context: Partial<CoopLogContext>): void {
    this.context = { ...this.context, ...context };
  }

  getContext(): CoopLogContext {
    return { ...this.context };
  }

  /** Where the batches go (`null`: nowhere); entries that were not sent yet (also from before a reload) go first */
  setServer(url: string | null): void {
    if (url === this.url) {
      return;
    }
    this.url = url;
    this.refused = false;
    if (url !== null && this.pending().length > 0) {
      this.scheduleSend(SEND_SOON_MS);
    }
  }

  debug(kind: string, msg: string, data?: unknown): void {
    this.add("debug", kind, msg, data);
  }

  info(kind: string, msg: string, data?: unknown): void {
    this.add("info", kind, msg, data);
  }

  warn(kind: string, msg: string, data?: unknown): void {
    this.add("warn", kind, msg, data);
  }

  error(kind: string, msg: string, data?: unknown): void {
    this.add("error", kind, msg, data);
  }

  /**
   * Write an entry. The same entry again within a second of the first (same level, kind, message and data: an error in a
   * loop) is counted on the first one, `msg (x5)`, while that one has not gone to the server yet.
   * @returns The entry
   */
  add(level: CoopLogLevel, kind: string, msg: string, data?: unknown): CoopLogEntry {
    const now = this.env.now();
    const plain = toLogData(data);
    const same = `${level}\n${kind}\n${msg}\n${plain === undefined ? "" : JSON.stringify(plain)}`;
    const repeat = this.findRepeat(same, now.getTime());
    let entry: CoopLogEntry;
    if (repeat === null) {
      entry = { at: now.toISOString(), n: this.next++, level, kind, msg };
      if (plain !== undefined) {
        entry.data = plain;
      }
      this.entries.push(entry);
      if (this.entries.length > LOG_BUFFER) {
        this.entries.splice(0, this.entries.length - LOG_BUFFER);
      }
      this.recent.push({ entry, same, msg, at: now.getTime(), count: 1 });
      if (this.recent.length > REPEAT_LOOKBACK) {
        this.recent.shift();
      }
    } else {
      repeat.count++;
      repeat.entry.msg = `${repeat.msg} (x${repeat.count})`;
      entry = repeat.entry;
    }
    this.schedulePersist(level === "error" ? 0 : 2000);
    this.scheduleSend(level === "warn" || level === "error" ? SEND_SOON_MS : SEND_LATER_MS);
    return entry;
  }

  /**
   * A problem report (`report-button.ts`): the note, with a snapshot of the game as its data. A snapshot too long for one
   * entry goes on in the entries right after it (same kind, "snapshot, part 2 of 3"), each short enough for the server, so
   * that the server gets all of it.
   * @returns The report's own entry
   */
  report(msg: string, snapshot: Record<string, unknown>): CoopLogEntry {
    const plain = toLogData(snapshot, Number.POSITIVE_INFINITY);
    if (!isRecord(plain)) {
      return this.add("warn", "report", msg, plain);
    }
    const parts = splitLogData(plain);
    if (parts.length > REPORT_MAX_PARTS) {
      const left = parts.length - REPORT_MAX_PARTS + 1;
      parts.splice(REPORT_MAX_PARTS - 1, left, { truncated: `${left} more parts of the snapshot were left out` });
    }
    const first = this.add("warn", "report", msg, parts[0] ?? {});
    for (let i = 1; i < parts.length; i++) {
      this.add("warn", "report", `snapshot, part ${i + 1} of ${parts.length}`, parts[i]);
    }
    return first;
  }

  /**
   * Send what is pending now (a report does), after the send under way if there is one.
   * @returns Whether everything written before the call reached the server and was taken: `false` without a server, with one
   * that does not collect logs, when a send failed (it is tried again later) or when the server refused a batch for good
   */
  async flush(): Promise<boolean> {
    const upTo = this.next;
    const dropped = this.dropped;
    while (this.sendingNow !== null) {
      await this.sendingNow;
    }
    if (this.sendTimer !== null) {
      this.env.clearTimer(this.sendTimer);
      this.sendTimer = null;
      this.sendAt = Number.POSITIVE_INFINITY;
    }
    await this.send();
    return this.url !== null && !this.refused && this.sentUpTo >= upTo && this.dropped === dropped;
  }

  /** The page is being left: what is pending goes in one last request that outlives the page */
  flushOnLeave(): void {
    this.persist();
    if (this.url === null || this.refused) {
      return;
    }
    const batch = this.nextBatch();
    if (batch !== null && this.env.beacon(this.url, JSON.stringify(batch.body))) {
      this.sentUpTo = batch.upTo;
      this.persist();
    }
  }

  /** Everything, for a file the player saves: the log, who and where, and what the caller adds */
  exportFile(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      v: 1,
      exportedAt: this.env.now().toISOString(),
      session: this.session,
      ...this.context,
      ua: this.env.userAgent,
      ...extra,
      entries: this.entries,
    };
  }

  /** Forget everything (tests) */
  clear(): void {
    this.entries = [];
    this.recent = [];
    this.next = 0;
    this.sentUpTo = 0;
    this.env.storage?.removeItem(STORAGE_KEY);
  }

  /** An entry of the last second that `same` repeats, and that can still change: not sent, nor on its way */
  private findRepeat(same: string, ms: number): RecentEntry | null {
    const floor = Math.max(this.sentUpTo, this.sendingUpTo);
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const recent = this.recent[i];
      if (recent.same === same && ms >= recent.at && ms - recent.at < REPEAT_MS && recent.entry.n >= floor) {
        return recent;
      }
    }
    return null;
  }

  private pending(): CoopLogEntry[] {
    return this.entries.filter(entry => entry.n >= this.sentUpTo);
  }

  private scheduleSend(ms: number): void {
    if (this.url === null || this.refused) {
      return;
    }
    // An earlier time wins: an error does not wait for the batch it joins
    if (this.sendTimer !== null && this.sendAt <= ms) {
      return;
    }
    if (this.sendTimer !== null) {
      this.env.clearTimer(this.sendTimer);
    }
    this.sendAt = ms;
    this.sendTimer = this.env.setTimer(() => {
      this.sendTimer = null;
      this.sendAt = Number.POSITIVE_INFINITY;
      void this.send();
    }, ms);
  }

  /** The next batch to send: the oldest pending entries, as many as fit */
  private nextBatch(): { body: CoopLogBatch; upTo: number } | null {
    const pending = this.pending();
    if (pending.length === 0) {
      return null;
    }
    const entries: CoopLogEntry[] = [];
    let chars = 500;
    for (const entry of pending.slice(0, BATCH_ENTRIES)) {
      const size = JSON.stringify(entry).length + 1;
      if (entries.length > 0 && chars + size > BATCH_MAX_CHARS) {
        break;
      }
      entries.push(entry);
      chars += size;
    }
    const body: CoopLogBatch = {
      v: 1,
      session: this.session,
      ...this.context,
      ua: this.env.userAgent,
      entries,
    };
    return { body, upTo: entries.at(-1)!.n + 1 };
  }

  /** Send the pending entries, batch after batch; while a send is under way, that one (it sends what came meanwhile too) */
  private send(): Promise<void> {
    if (this.sendingNow !== null) {
      return this.sendingNow;
    }
    if (this.url === null || this.refused) {
      return Promise.resolve();
    }
    const sending = this.sendBatches(this.url).finally(() => {
      this.sendingNow = null;
    });
    this.sendingNow = sending;
    return sending;
  }

  private async sendBatches(url: string): Promise<void> {
    for (;;) {
      const batch = this.nextBatch();
      if (batch === null) {
        return;
      }
      let status: number;
      this.sendingUpTo = batch.upTo;
      try {
        status = await this.env.post(url, JSON.stringify(batch.body), true);
      } catch {
        // Offline, or the tunnel blinked: try again later, the entries stay pending
        this.scheduleSend(this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
        return;
      } finally {
        this.sendingUpTo = 0;
      }
      if (status === 404 || status === 405) {
        // This server does not collect client logs: the log stays in this browser
        this.refused = true;
        return;
      }
      if (status === 429 || status >= 500) {
        this.scheduleSend(this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
        return;
      }
      // Accepted, or refused for good (too big, a shape the server does not take): either way it is not sent again
      if (status < 200 || status >= 300) {
        this.dropped++;
      }
      this.sentUpTo = batch.upTo;
      this.retryMs = RETRY_MIN_MS;
      this.schedulePersist(2000);
    }
  }

  /**
   * Write the log to storage in `ms` (`0`: now), but not twice within a second: a flood of errors does not write 1500
   * entries each time. An earlier time wins over a later one.
   */
  private schedulePersist(ms: number): void {
    if (this.env.storage === null) {
      return;
    }
    const now = this.now();
    // (a clock that went back does not hold the writes off)
    const at = Math.max(now + ms, Math.min(this.lastPersist, now) + PERSIST_MIN_GAP_MS);
    if (at <= now) {
      this.persist();
      return;
    }
    if (this.persistTimer !== null) {
      if (this.persistAt <= at) {
        return;
      }
      this.env.clearTimer(this.persistTimer);
    }
    this.persistAt = at;
    this.persistTimer = this.env.setTimer(() => {
      this.persistTimer = null;
      this.persistAt = Number.POSITIVE_INFINITY;
      this.persist();
    }, at - now);
  }

  private persist(): void {
    if (this.persistTimer !== null) {
      this.env.clearTimer(this.persistTimer);
      this.persistTimer = null;
      this.persistAt = Number.POSITIVE_INFINITY;
    }
    const storage = this.env.storage;
    if (storage === null) {
      return;
    }
    this.lastPersist = this.now();
    let kept = this.entries.slice(-LOG_PERSISTED);
    let text = JSON.stringify({ next: this.next, sentUpTo: this.sentUpTo, entries: kept } satisfies Persisted);
    while (text.length > LOG_PERSISTED_MAX_CHARS && kept.length > 1) {
      kept = kept.slice(Math.ceil(kept.length / 4));
      text = JSON.stringify({ next: this.next, sentUpTo: this.sentUpTo, entries: kept } satisfies Persisted);
    }
    try {
      storage.setItem(STORAGE_KEY, text);
    } catch {
      // Storage full or off: the log goes on in memory
    }
  }

  private load(): void {
    try {
      const text = this.env.storage?.getItem(STORAGE_KEY);
      if (text == null) {
        return;
      }
      const persisted = JSON.parse(text) as Partial<Persisted>;
      if (!Array.isArray(persisted.entries) || typeof persisted.next !== "number") {
        return;
      }
      this.entries = persisted.entries.slice(-LOG_BUFFER);
      this.next = persisted.next;
      this.sentUpTo = typeof persisted.sentUpTo === "number" ? persisted.sentUpTo : 0;
    } catch {
      // An unreadable log is started again
    }
  }
}

function browserEnvironment(): CoopLogEnvironment {
  const hasWindow = typeof window !== "undefined";
  let storage: CoopLogEnvironment["storage"] = null;
  try {
    storage = hasWindow ? window.localStorage : null;
  } catch {
    storage = null;
  }
  return {
    storage,
    // the log's clock: when a line was written, for a person to read; the simulation never sees it
    now: () => new Date(),
    post: async (url, body, keepalive) => {
      const response = await fetch(url, {
        method: "POST",
        // a "simple" request: no preflight when the relay is on another origin (the dev server)
        headers: { "content-type": "text/plain" },
        body,
        keepalive,
      });
      return response.status;
    },
    beacon: (url, body) =>
      typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
        ? navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }))
        : false,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    // one id per page load, to tell the tabs apart in the server's log
    sessionId: () =>
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().slice(0, 8)
        : "nocrypto",
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
  };
}

let log: CoopLog | null = null;

/** The log of this page (made on first use) */
export function coopLog(): CoopLog {
  log ??= new CoopLog(browserEnvironment());
  return log;
}

/** Use another log (tests) */
export function setCoopLog(replacement: CoopLog | null): void {
  log = replacement;
}

let pageHooked = false;

/**
 * Record the page's own errors (anything that was not caught, in the game or in co-op code) and send the rest of the log
 * when the page is left. Once per page; only a page that played co-op calls it, so solo play is untouched.
 */
export function hookPageIntoCoopLog(): void {
  if (pageHooked || typeof window === "undefined") {
    return;
  }
  pageHooked = true;
  window.addEventListener("error", event => {
    coopLog().error("page", event.message || "error", {
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      error: toLogData(event.error),
    });
  });
  window.addEventListener("unhandledrejection", event => {
    const reason: unknown = event.reason;
    coopLog().error("page", reason instanceof Error ? reason.message : "unhandled rejection", toLogData(reason));
  });
  window.addEventListener("pagehide", () => coopLog().flushOnLeave());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      coopLog().flushOnLeave();
    }
  });
}
