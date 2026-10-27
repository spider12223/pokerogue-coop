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
});
