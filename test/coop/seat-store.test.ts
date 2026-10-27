/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { COOP_SLOT_KEY, type CoopSlot, clearCoopSlot, readCoopSlot, writeCoopSlot } from "#coop/coop-slot";
import {
  forgetAllSeats,
  forgetSeat,
  type KeyValueStore,
  listSeats,
  newestSeat,
  SEAT_KEY_PREFIX,
  type SeatRecord,
  saveSeat,
} from "#coop/seat-store";
import { describe, expect, it } from "vitest";

/** A `Storage` in a Map, with the order and `length` of the real one */
class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  /** Make writes fail, as a full or private-mode store does */
  failWrites = false;

  get length(): number {
    return this.data.size;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new Error("QuotaExceededError");
    }
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

const seat = (code: string, savedAt: number, seatName: SeatRecord["seat"] = "guest"): SeatRecord => ({
  code,
  seat: seatName,
  token: `token-${code}`,
  relayUrl: "ws://localhost:8787",
  savedAt,
});

describe("seat tokens in local storage (D20)", () => {
  it("keeps one entry per room and gives the newest back", () => {
    const store = new MemoryStore();
    expect(saveSeat(store, seat("AAAAAA", 100))).toBe(true);
    expect(saveSeat(store, seat("BBBBBB", 300, "host"))).toBe(true);
    expect(saveSeat(store, seat("CCCCCC", 200))).toBe(true);
    expect(listSeats(store).map(record => record.code)).toEqual(["BBBBBB", "CCCCCC", "AAAAAA"]);
    expect(newestSeat(store)).toEqual(seat("BBBBBB", 300, "host"));
    // the same room again replaces its entry
    saveSeat(store, { ...seat("AAAAAA", 400), token: "newer" });
    expect(newestSeat(store)?.token).toBe("newer");
    expect(listSeats(store)).toHaveLength(3);
  });

  it("forgets a room, or every room", () => {
    const store = new MemoryStore();
    saveSeat(store, seat("AAAAAA", 1));
    saveSeat(store, seat("BBBBBB", 2));
    forgetSeat(store, "BBBBBB");
    expect(listSeats(store).map(record => record.code)).toEqual(["AAAAAA"]);
    forgetAllSeats(store);
    expect(newestSeat(store)).toBeNull();
  });

  it("leaves other keys alone and removes damaged entries", () => {
    const store = new MemoryStore();
    store.setItem("sessionData_Guest", "solo save");
    store.setItem(`${SEAT_KEY_PREFIX}BROKEN`, "{not json");
    store.setItem(`${SEAT_KEY_PREFIX}WRONGKEY`, JSON.stringify(seat("OTHER", 5)));
    store.setItem(`${SEAT_KEY_PREFIX}NOSEAT`, JSON.stringify({ ...seat("NOSEAT", 5), seat: "spectator" }));
    saveSeat(store, seat("GOODGO", 9));
    expect(listSeats(store).map(record => record.code)).toEqual(["GOODGO"]);
    expect(store.getItem("sessionData_Guest")).toBe("solo save");
    expect([...store.data.keys()].sort()).toEqual([`${SEAT_KEY_PREFIX}GOODGO`, "sessionData_Guest"].sort());
  });

  it("does not fail where the storage refuses", () => {
    const store = new MemoryStore();
    store.failWrites = true;
    expect(saveSeat(store, seat("AAAAAA", 1))).toBe(false);
    expect(newestSeat(store)).toBeNull();
  });
});

describe("the co-op slot of the host (D19)", () => {
  const slot: CoopSlot = {
    version: 1,
    savedAt: 1234,
    wave: 12,
    epoch: 3,
    seq: 77,
    names: { host: "Sam", guest: "Alex" },
    accountIds: { host: "1:2", guest: "3:4" },
    session: JSON.stringify({ waveIndex: 12, coop: { version: 2 } }),
  };

  it("round-trips", () => {
    const store = new MemoryStore();
    expect(readCoopSlot(store)).toBeNull();
    expect(writeCoopSlot(store, slot)).toBe(true);
    expect(readCoopSlot(store)).toEqual(slot);
    clearCoopSlot(store);
    expect(readCoopSlot(store)).toBeNull();
  });

  it("lives under a key no solo slot has", () => {
    expect(COOP_SLOT_KEY.startsWith("sessionData")).toBe(false);
    expect(COOP_SLOT_KEY).not.toMatch(/^(data_|sessionData|settings|runHistory)/);
  });

  it("writing it never touches another key", () => {
    const store = new MemoryStore();
    store.setItem("sessionData_Guest", "solo 0");
    store.setItem("sessionData1_Guest", "solo 1");
    const before = [...store.data.entries()];
    writeCoopSlot(store, slot);
    clearCoopSlot(store);
    expect([...store.data.entries()]).toEqual(before);
  });

  it("drops a damaged slot instead of offering it", () => {
    const store = new MemoryStore();
    store.setItem(COOP_SLOT_KEY, "{broken");
    expect(readCoopSlot(store)).toBeNull();
    expect(store.getItem(COOP_SLOT_KEY)).toBeNull();
    store.setItem(COOP_SLOT_KEY, JSON.stringify({ ...slot, session: "" }));
    expect(readCoopSlot(store)).toBeNull();
    store.setItem(COOP_SLOT_KEY, JSON.stringify({ ...slot, version: 99 }));
    expect(readCoopSlot(store)).toBeNull();
  });

  it("does not fail where the storage is full", () => {
    const store = new MemoryStore();
    store.failWrites = true;
    expect(writeCoopSlot(store, slot)).toBe(false);
  });
});
