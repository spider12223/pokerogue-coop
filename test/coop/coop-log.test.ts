/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  BATCH_ENTRIES,
  CoopLog,
  type CoopLogBatch,
  type CoopLogEnvironment,
  LOG_BUFFER,
  LOG_PERSISTED,
  MAX_DATA_CHARS,
  REPORT_MAX_PARTS,
  splitLogData,
  toLogData,
} from "#coop/coop-log";
import { describe, expect, it } from "vitest";

/** A browser of its own: a clock that only moves when told, a storage, and a server that answers what the test says */
function fakeBrowser(answer: (batch: CoopLogBatch) => number | Error = () => 204) {
  const store = new Map<string, string>();
  const timers: { at: number; callback: () => void; id: number }[] = [];
  const posts: CoopLogBatch[] = [];
  const beacons: CoopLogBatch[] = [];
  let clock = Date.parse("2026-10-26T12:00:00Z");
  let ids = 0;
  const env: CoopLogEnvironment = {
    storage: {
      getItem: key => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
      removeItem: key => void store.delete(key),
    },
    now: () => new Date(clock),
    post: (_url, body) => {
      const batch = JSON.parse(body) as CoopLogBatch;
      const result = answer(batch);
      if (result instanceof Error) {
        return Promise.reject(result);
      }
      posts.push(batch);
      return Promise.resolve(result);
    },
    beacon: (_url, body) => {
      beacons.push(JSON.parse(body) as CoopLogBatch);
      return true;
    },
    setTimer: (callback, ms) => {
      const id = ++ids;
      timers.push({ at: clock + ms, callback, id });
      return id;
    },
    clearTimer: id => {
      const index = timers.findIndex(timer => timer.id === id);
      if (index >= 0) {
        timers.splice(index, 1);
      }
    },
    sessionId: () => "tab1",
    userAgent: "test-browser",
  };
  /** Move the clock and run the timers that are due, and the sends they start */
  const advance = async (ms: number): Promise<void> => {
    clock += ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (due === undefined || due.at > clock) {
        break;
      }
      timers.shift();
      due.callback();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  };
  return { env, store, posts, beacons, advance };
}

describe("the co-op log (D26)", () => {
  it("numbers the entries, keeps the newest, and turns data into short plain JSON", () => {
    const { env } = fakeBrowser();
    const log = new CoopLog(env);
    log.info("session", "begin", { seat: "host" });
    log.error("error", "boom", new Error("it broke"));
    expect(log.all.map(entry => [entry.n, entry.level, entry.kind])).toEqual([
      [0, "info", "session"],
      [1, "error", "error"],
    ]);
    expect(log.all[1].data).toMatchObject({ error: "Error", message: "it broke" });
    expect(log.all[0].at).toBe("2026-10-26T12:00:00.000Z");

    for (let i = 0; i < LOG_BUFFER + 10; i++) {
      log.debug("x", `entry ${i}`);
    }
    expect(log.all).toHaveLength(LOG_BUFFER);
    expect(log.all.at(-1)!.n).toBe(LOG_BUFFER + 11);

    expect(toLogData({ big: "y".repeat(10_000) })).toMatchObject({ truncated: true });
    expect(toLogData(undefined)).toBeUndefined();
  });

  it("survives a reload: the newest entries and the count come back from storage", async () => {
    const browser = fakeBrowser();
    const first = new CoopLog(browser.env);
    for (let i = 0; i < LOG_PERSISTED + 20; i++) {
      first.info("decision", `#${i}`);
    }
    first.error("error", "the last thing before the crash");
    const second = new CoopLog(browser.env);
    expect(second.all).toHaveLength(LOG_PERSISTED);
    expect(second.all.at(-1)!.msg).toBe("the last thing before the crash");
    second.info("session", "after the reload");
    expect(second.all.at(-1)!.n).toBe(LOG_PERSISTED + 21);
  });

  it("sends nothing until it has a server, then the entries in batches, and each one once", async () => {
    const { env, posts, advance } = fakeBrowser();
    const log = new CoopLog(env);
    log.setContext({ room: "ABCD12", seat: "guest", name: "Alex", build: "abc1234+clean" });
    for (let i = 0; i < BATCH_ENTRIES + 50; i++) {
      log.info("decision", `#${i}`);
    }
    await advance(60_000);
    expect(posts).toHaveLength(0);

    log.setServer("/coop/log");
    await advance(1000);
    expect(posts.map(batch => batch.entries.length)).toEqual([BATCH_ENTRIES, 50]);
    expect(posts[0]).toMatchObject({
      v: 1,
      session: "tab1",
      room: "ABCD12",
      seat: "guest",
      name: "Alex",
      ua: "test-browser",
    });
    expect(posts.flatMap(batch => batch.entries.map(entry => entry.n))).toEqual(
      Array.from({ length: BATCH_ENTRIES + 50 }, (_, i) => i),
    );

    // an info entry waits for the next batch; an error goes within a second
    log.info("link", "partner back");
    await advance(1000);
    expect(posts).toHaveLength(2);
    log.error("error", "a decision failed");
    await advance(1000);
    expect(posts).toHaveLength(3);
    expect(posts[2].entries.map(entry => entry.msg)).toEqual(["partner back", "a decision failed"]);
  });

  it("stops sending to a server that does not collect logs, and tries again later when the network fails", async () => {
    let status: number | Error = 404;
    const { env, posts, advance } = fakeBrowser(() => status);
    const log = new CoopLog(env);
    log.setServer("/coop/log");
    log.error("error", "one");
    await advance(1000);
    expect(posts).toHaveLength(1);
    expect(log.serverCollects).toBe(false);
    log.error("error", "two");
    await advance(60_000);
    expect(posts).toHaveLength(1);

    // another server, which is offline for a while
    status = new Error("offline");
    log.setServer("/other/log");
    await advance(1000);
    expect(posts).toHaveLength(1);
    status = 204;
    await advance(5000);
    expect(posts).toHaveLength(2);
    expect(posts[1].entries.map(entry => entry.msg)).toEqual(["one", "two"]);
    expect(log.serverCollects).toBe(true);
  });

  it("sends what is left with a beacon when the page is left, and a reload does not send it again", async () => {
    const browser = fakeBrowser();
    const log = new CoopLog(browser.env);
    log.setServer("/coop/log");
    log.info("decision", "#1");
    log.info("decision", "#2");
    log.flushOnLeave();
    expect(browser.beacons.flatMap(batch => batch.entries.map(entry => entry.msg))).toEqual(["#1", "#2"]);

    const reloaded = new CoopLog(browser.env);
    reloaded.setServer("/coop/log");
    reloaded.info("session", "after the reload");
    await browser.advance(10_000);
    expect(browser.posts.flatMap(batch => batch.entries.map(entry => entry.msg))).toEqual(["after the reload"]);
  });

  it("exports everything for a file, with what the caller adds", () => {
    const { env } = fakeBrowser();
    const log = new CoopLog(env);
    log.setContext({ room: "ABCD12", seat: "host", name: "Sam", build: "abc+clean" });
    log.warn("stall", "no phase for 60 s");
    const file = log.exportFile({ note: "the menu froze" });
    expect(file).toMatchObject({ v: 1, room: "ABCD12", seat: "host", name: "Sam", note: "the menu froze" });
    expect((file.entries as unknown[]).length).toBe(1);
  });

  describe("a report", () => {
    /** A snapshot of a long run: far more than one entry takes */
    const bigSnapshot = () => ({
      phase: "CommandPhase",
      wave: 37,
      message: "a line of the message box ".repeat(300),
      party: Array.from({ length: 6 }, (_, id) => ({ id, species: "Bulbasaur", moves: [33, 45, 73, 22] })),
      trace: Array.from({ length: 120 }, (_, i) => `${i}:37:4:MoveEffectPhase`),
      checkpoints: Array.from({ length: 20 }, (_, wave) => ({ wave, hash: "f".repeat(64), fields: ["a".repeat(150)] })),
    });

    /** Put the parts back together: the keys as they are, a cut array or string from its parts in order */
    function rebuild(parts: unknown[]): Record<string, unknown> {
      const merged = Object.assign({}, ...parts) as Record<string, unknown>;
      const whole: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(merged)) {
        const cut = /^(\w+)(\[\d+\.\.\d+\]|@\d+)$/.exec(key);
        if (cut === null) {
          whole[key] = value;
        } else if (typeof value === "string") {
          whole[cut[1]] = ((whole[cut[1]] as string | undefined) ?? "") + value;
        } else {
          whole[cut[1]] = [...((whole[cut[1]] as unknown[] | undefined) ?? []), ...(value as unknown[])];
        }
      }
      return whole;
    }

    it("is one entry with the whole snapshot when it is short", () => {
      const { env } = fakeBrowser();
      const log = new CoopLog(env);
      log.report("the menu froze", { phase: "CommandPhase", wave: 3 });
      expect(log.all).toEqual([
        expect.objectContaining({
          level: "warn",
          kind: "report",
          msg: "the menu froze",
          data: { phase: "CommandPhase", wave: 3 },
        }),
      ]);
    });

    it("goes on in more entries when it is long, each short enough to be kept whole, and all of it is there", async () => {
      const { env, posts, advance } = fakeBrowser();
      const log = new CoopLog(env);
      log.setServer("/coop/log");
      const snapshot = bigSnapshot();
      log.report("it froze again", snapshot);
      const parts = log.all;
      expect(parts.length).toBeGreaterThan(3);
      expect(parts.length).toBeLessThanOrEqual(REPORT_MAX_PARTS);
      expect(parts[0]).toMatchObject({
        kind: "report",
        msg: "it froze again",
        data: { phase: "CommandPhase", wave: 37 },
      });
      parts.forEach((entry, i) => {
        expect(entry).toMatchObject({ level: "warn", kind: "report" });
        expect(JSON.stringify(entry.data).length).toBeLessThanOrEqual(MAX_DATA_CHARS);
        expect(JSON.stringify(entry.data)).not.toContain("truncated");
        if (i > 0) {
          expect(entry.msg).toBe(`snapshot, part ${i + 1} of ${parts.length}`);
        }
      });
      expect(rebuild(parts.map(entry => entry.data))).toEqual(snapshot);

      // and that is what the server gets
      await advance(1000);
      expect(rebuild(posts.flatMap(batch => batch.entries.map(entry => entry.data)))).toEqual(snapshot);
    });

    it("is cut at a number of entries, and says so", () => {
      const { env } = fakeBrowser();
      const log = new CoopLog(env);
      log.report("huge", { trace: Array.from({ length: 20_000 }, (_, i) => `entry ${i}`) });
      expect(log.all).toHaveLength(REPORT_MAX_PARTS);
      expect(log.all.at(-1)!.data).toMatchObject({ truncated: expect.stringContaining("more parts") });
    });

    it("cuts nested values and long strings too", () => {
      const data = { deep: { inner: { text: '"quoted" '.repeat(1000) } }, list: [{ big: "y".repeat(5000) }] };
      const pieces = splitLogData(data, 1000);
      for (const piece of pieces) {
        expect(JSON.stringify(piece).length).toBeLessThanOrEqual(1000);
      }
      const merged = Object.assign({}, ...pieces) as Record<string, string>;
      const text = Object.keys(merged)
        .filter(key => key.startsWith("deep.inner.text@"))
        .map(key => merged[key])
        .join("");
      expect(text).toBe(data.deep.inner.text);
      expect(splitLogData({ a: 1, b: "two" })).toEqual([{ a: 1, b: "two" }]);
    });
  });

  it("counts an entry that comes again within a second on the first one, as long as it was not sent", async () => {
    const { env, posts, advance } = fakeBrowser();
    const log = new CoopLog(env);
    for (let i = 0; i < 5; i++) {
      log.error("page", "boom", { line: 3 });
    }
    // other data: an entry of its own; the first one still counts the repeats that come after it
    log.error("page", "boom", { line: 4 });
    log.error("page", "boom", { line: 3 });
    expect(log.all.map(entry => [entry.n, entry.msg])).toEqual([
      [0, "boom (x6)"],
      [1, "boom"],
    ]);

    // a second after the first, it is an entry of its own again
    await advance(999);
    log.error("page", "boom", { line: 3 });
    expect(log.all).toHaveLength(2);
    await advance(1);
    log.error("page", "boom", { line: 3 });
    expect(log.all.map(entry => entry.msg)).toEqual(["boom (x7)", "boom", "boom"]);

    // once an entry went to the server, a repeat is a new entry (the server would never see the count change)
    log.setServer("/coop/log");
    expect(await log.flush()).toBe(true);
    expect(posts.flatMap(batch => batch.entries.map(entry => entry.msg))).toEqual(["boom (x7)", "boom", "boom"]);
    log.error("page", "boom", { line: 3 });
    expect(log.all.map(entry => entry.msg)).toEqual(["boom (x7)", "boom", "boom", "boom"]);
  });

  it("writes the storage at most once a second, in a flood of errors too", async () => {
    const browser = fakeBrowser();
    let writes = 0;
    const storage = browser.env.storage!;
    const setItem = storage.setItem;
    storage.setItem = (key, value) => {
      writes++;
      setItem(key, value);
    };
    const log = new CoopLog(browser.env);
    for (let i = 0; i < 100; i++) {
      log.error("error", `#${i}`);
    }
    // the first error at once, the rest together a second later
    expect(writes).toBe(1);
    expect(new CoopLog(browser.env).all).toHaveLength(1);
    await browser.advance(1000);
    expect(writes).toBe(2);
    expect(new CoopLog(browser.env).all).toHaveLength(100);
    // a quiet second later, an error goes at once again
    await browser.advance(5000);
    log.error("error", "later");
    expect(writes).toBe(3);
  });

  it("says whether a flush got everything to the server", async () => {
    let status: number | Error = 204;
    const { env } = fakeBrowser(() => status);
    const log = new CoopLog(env);
    log.warn("report", "no server yet");
    expect(await log.flush()).toBe(false);

    log.setServer("/coop/log");
    log.warn("report", "one");
    expect(await log.flush()).toBe(true);

    status = new Error("offline");
    log.warn("report", "two");
    expect(await log.flush()).toBe(false);
    // (the log reached this server before: that is not this report)
    expect(log.serverCollects).toBe(true);

    // refused for good: it is not sent again, and it did not get there
    status = 413;
    expect(await log.flush()).toBe(false);
    status = 204;
    log.warn("report", "three");
    expect(await log.flush()).toBe(true);

    status = 404;
    log.warn("report", "four");
    expect(await log.flush()).toBe(false);
  });

  it("a flush waits for the send under way, and sends what came meanwhile", async () => {
    const { env, advance } = fakeBrowser();
    const posts: string[][] = [];
    const answers: ((status: number) => void)[] = [];
    env.post = (_url, body) => {
      posts.push((JSON.parse(body) as CoopLogBatch).entries.map(entry => entry.msg));
      return new Promise(resolve => answers.push(resolve));
    };
    const log = new CoopLog(env);
    log.setServer("/coop/log");
    log.error("error", "first");
    await advance(1000);
    expect(posts).toEqual([["first"]]);

    log.warn("report", "the report");
    let done: boolean | null = null;
    void log.flush().then(result => {
      done = result;
    });
    answers[0](204);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(posts).toEqual([["first"], ["the report"]]);
    expect(done).toBeNull();
    answers[1](204);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(done).toBe(true);
  });
});
