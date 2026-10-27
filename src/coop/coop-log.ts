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
/** A string longer than this in an entry's data is cut */
const MAX_DATA_CHARS = 3000;
const STORAGE_KEY = "coopLog";

interface Persisted {
  next: number;
  sentUpTo: number;
  entries: CoopLogEntry[];
}

/** The data of an entry as plain JSON, short enough for the server: an `Error` becomes its message and the top of its stack */
export function toLogData(value: unknown): unknown {
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
    return json.length > MAX_DATA_CHARS ? { truncated: true, preview: json.slice(0, 500) } : JSON.parse(json);
  } catch {
    return String(value);
  }
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
  private sending = false;
  private retryMs = RETRY_MIN_MS;
  private persistTimer: unknown = null;

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

  add(level: CoopLogLevel, kind: string, msg: string, data?: unknown): CoopLogEntry {
    const entry: CoopLogEntry = { at: this.env.now().toISOString(), n: this.next++, level, kind, msg };
    const plain = toLogData(data);
    if (plain !== undefined) {
      entry.data = plain;
    }
    this.entries.push(entry);
    if (this.entries.length > LOG_BUFFER) {
      this.entries.splice(0, this.entries.length - LOG_BUFFER);
    }
    this.schedulePersist(level === "error" ? 0 : 2000);
    this.scheduleSend(level === "warn" || level === "error" ? SEND_SOON_MS : SEND_LATER_MS);
    return entry;
  }

  /** Send what is pending now (a report does), and resolve when that try is over */
  async flush(): Promise<void> {
    if (this.sendTimer !== null) {
      this.env.clearTimer(this.sendTimer);
      this.sendTimer = null;
      this.sendAt = Number.POSITIVE_INFINITY;
    }
    await this.send();
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
    this.next = 0;
    this.sentUpTo = 0;
    this.env.storage?.removeItem(STORAGE_KEY);
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

  private async send(): Promise<void> {
    if (this.sending || this.url === null || this.refused) {
      return;
    }
    this.sending = true;
    try {
      for (;;) {
        const batch = this.nextBatch();
        if (batch === null) {
          break;
        }
        let status: number;
        try {
          status = await this.env.post(this.url, JSON.stringify(batch.body), true);
        } catch {
          // Offline, or the tunnel blinked: try again later, the entries stay pending
          this.scheduleSend(this.retryMs);
          this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
          return;
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
        this.sentUpTo = batch.upTo;
        this.retryMs = RETRY_MIN_MS;
        this.schedulePersist(2000);
      }
    } finally {
      this.sending = false;
    }
  }

  private schedulePersist(ms: number): void {
    if (this.env.storage === null) {
      return;
    }
    if (ms === 0) {
      this.persist();
      return;
    }
    if (this.persistTimer !== null) {
      return;
    }
    this.persistTimer = this.env.setTimer(() => {
      this.persistTimer = null;
      this.persist();
    }, ms);
  }

  private persist(): void {
    if (this.persistTimer !== null) {
      this.env.clearTimer(this.persistTimer);
      this.persistTimer = null;
    }
    const storage = this.env.storage;
    if (storage === null) {
      return;
    }
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
