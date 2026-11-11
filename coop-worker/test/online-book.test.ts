/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, it, vi } from "vitest";
import {
  countOnline,
  noteOnline,
  ONLINE_MEMO_MS,
  ONLINE_NAME,
  ONLINE_STALE_MS,
  type OnlineBook,
  OnlineMemo,
  reportOnline,
} from "../src/online-book.ts";
import { DEFAULTS, type Env } from "../src/shared.ts";

describe("The relay's players-online count (D46)", () => {
  it("keeps the latest word of each room, and forgets a room with nobody connected", () => {
    const book: OnlineBook = {};
    noteOnline(book, "room-a", 2, 1000);
    noteOnline(book, "room-b", 1, 2000);
    noteOnline(book, "room-a", 3, 3000);
    expect(book).toEqual({ "room-a": { players: 3, at: 3000 }, "room-b": { players: 1, at: 2000 } });
    noteOnline(book, "room-b", 0, 4000);
    expect(book).toEqual({ "room-a": { players: 3, at: 3000 } });
  });

  it("takes a whole number of players: a negative or broken one is nobody", () => {
    const book: OnlineBook = {};
    noteOnline(book, "a", 2.7, 0);
    noteOnline(book, "b", -1, 0);
    noteOnline(book, "c", Number.NaN, 0);
    noteOnline(book, "d", Number.POSITIVE_INFINITY, 0);
    expect(book).toEqual({ a: { players: 2, at: 0 } });
  });

  it("counts the players of every room and of the queue", () => {
    const book: OnlineBook = {};
    noteOnline(book, "room-a", 2, 0);
    noteOnline(book, "room-b", 3, 0);
    noteOnline(book, "queue", 1, 0);
    expect(countOnline(book, 1000)).toBe(6);
    expect(countOnline({}, 1000)).toBe(0);
  });

  it("drops a room not heard from in 40 minutes, so one that vanished without a word cannot stay counted", () => {
    const book: OnlineBook = {};
    noteOnline(book, "old", 2, 0);
    noteOnline(book, "new", 2, ONLINE_STALE_MS - 1);
    expect(countOnline(book, ONLINE_STALE_MS - 1)).toBe(4);
    expect(countOnline(book, ONLINE_STALE_MS)).toBe(2);
    expect(Object.keys(book)).toEqual(["new"]);
    expect(ONLINE_STALE_MS).toBe(40 * 60_000);
  });

  it("a room whose game goes on is counted between two of its alarms (they come at most the idle time apart)", () => {
    // (a room says it again from its alarm, not after each wake: every report is a whole request of the daily quota)
    expect(ONLINE_STALE_MS).toBeGreaterThan(DEFAULTS.idleRoomMs);
  });

  it("a Worker reuses the count it read for 5 minutes, and so does the browser (the title screen asks every minute)", () => {
    const memo = new OnlineMemo();
    expect(memo.get(0)).toBeUndefined();
    memo.set(7, 1000);
    expect(memo.get(1000 + ONLINE_MEMO_MS - 1)).toBe(7);
    expect(memo.get(1000 + ONLINE_MEMO_MS)).toBeUndefined();
    expect(ONLINE_MEMO_MS).toBe(5 * 60_000);
  });

  it("a report goes to the one object that keeps the count", async () => {
    const report = vi.fn(async () => undefined);
    const idFromName = vi.fn((name: string) => `id:${name}`);
    const get = vi.fn(() => ({ report }));
    await reportOnline({ ONLINE: { idFromName, get } } as unknown as Env, "room-a", 2);
    expect(idFromName).toHaveBeenCalledWith(ONLINE_NAME);
    expect(get).toHaveBeenCalledWith(`id:${ONLINE_NAME}`);
    expect(report).toHaveBeenCalledWith("room-a", 2);
  });

  it("a report that fails never fails the room", async () => {
    const down = {
      ONLINE: {
        idFromName: () => "id",
        get: () => ({
          report: async () => {
            throw new Error("down");
          },
        }),
      },
    };
    await expect(reportOnline(down as unknown as Env, "room-a", 2)).resolves.toBeUndefined();
    const unbound = {
      ONLINE: {
        idFromName: () => {
          throw new Error("no binding");
        },
      },
    };
    await expect(reportOnline(unbound as unknown as Env, "room-a", 2)).resolves.toBeUndefined();
  });
});
