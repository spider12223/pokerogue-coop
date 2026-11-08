/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  COOP_SLOT_FILES,
  COOP_SLOT_KEY,
  type CoopSlot,
  clearCoopSlot,
  coopSlotKey,
  debugMenuOnRejoin,
  firstFreeCoopFile,
  readCoopSlot,
  readCoopSlots,
  writeCoopSlot,
} from "#coop/save/coop-slot";
import {
  forgetAllSeats,
  forgetSeat,
  type KeyValueStore,
  listSeats,
  newestSeat,
  SEAT_KEY_PREFIX,
  type SeatRecord,
  saveSeat,
} from "#coop/save/seat-store";
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

describe("the seat of a host remembers its save file (D19, D20)", () => {
  it("keeps the file a reloaded host resumes, and drops a record whose file is not one of the five", () => {
    const store = new MemoryStore();
    const record = { code: "ABC234", seat: "host" as const, token: "t", relayUrl: "ws://r", savedAt: 1, file: 3 };
    saveSeat(store, record);
    expect(newestSeat(store)).toEqual(record);
    store.setItem("coopSeat:XYZ789", JSON.stringify({ ...record, code: "XYZ789", savedAt: 2, file: 9 }));
    expect(newestSeat(store)?.code).toBe("ABC234");
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
    expect(readCoopSlot(store, 1)).toBeNull();
    expect(writeCoopSlot(store, slot, 1)).toBe(true);
    expect(readCoopSlot(store, 1)).toEqual(slot);
    clearCoopSlot(store, 1);
    expect(readCoopSlot(store, 1)).toBeNull();
  });

  it("keeps a run of three: the third seat's name and account, and how many played (D40)", () => {
    const store = new MemoryStore();
    const three: CoopSlot = {
      ...slot,
      names: { host: "Sam", guest: "Alex", guest2: "Kim" },
      accountIds: { host: "1:2", guest: "3:4", guest2: "5:6" },
      players: 3,
    };
    expect(writeCoopSlot(store, three, 1)).toBe(true);
    expect(readCoopSlot(store, 1)).toEqual(three);
    expect(writeCoopSlot(store, { ...three, players: 4 as never }, 1)).toBe(true);
    expect(readCoopSlot(store, 1)).toBeNull();
  });

  it("keeps whether the host's debug menu was on: a host whose page is reloaded in the run keeps it (D42, D20)", () => {
    const store = new MemoryStore();
    expect(writeCoopSlot(store, { ...slot, debug: true }, 1)).toBe(true);
    expect(readCoopSlot(store, 1)?.debug).toBe(true);
    expect(writeCoopSlot(store, { ...slot, debug: "yes" as never }, 1)).toBe(true);
    expect(readCoopSlot(store, 1)).toBeNull();
    // the run's own menu, whatever the setting says by then (the guests kept theirs); a slot from before it said follows
    // the setting
    expect(debugMenuOnRejoin({ ...slot, debug: true }, false)).toBe(true);
    expect(debugMenuOnRejoin({ ...slot, debug: false }, true)).toBe(false);
    expect(debugMenuOnRejoin(slot, true)).toBe(true);
    expect(debugMenuOnRejoin(slot, false)).toBe(false);
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
    writeCoopSlot(store, slot, 1);
    clearCoopSlot(store, 1);
    expect([...store.data.entries()]).toEqual(before);
  });

  it("drops a damaged slot instead of offering it", () => {
    const store = new MemoryStore();
    store.setItem(COOP_SLOT_KEY, "{broken");
    expect(readCoopSlot(store, 1)).toBeNull();
    expect(store.getItem(COOP_SLOT_KEY)).toBeNull();
    store.setItem(COOP_SLOT_KEY, JSON.stringify({ ...slot, session: "" }));
    expect(readCoopSlot(store, 1)).toBeNull();
    store.setItem(COOP_SLOT_KEY, JSON.stringify({ ...slot, version: 99 }));
    expect(readCoopSlot(store, 1)).toBeNull();
  });

  it("does not fail where the storage is full", () => {
    const store = new MemoryStore();
    store.failWrites = true;
    expect(writeCoopSlot(store, slot, 1)).toBe(false);
  });

  describe("five files (D19, amended)", () => {
    const at = (wave: number): CoopSlot => ({ ...slot, wave });

    it("keeps each under its own key; the first under the key of the one slot there was", () => {
      expect(COOP_SLOT_FILES).toBe(5);
      expect([1, 2, 3, 4, 5].map(coopSlotKey)).toEqual([
        "coopSlot",
        "coopSlot2",
        "coopSlot3",
        "coopSlot4",
        "coopSlot5",
      ]);
      const store = new MemoryStore();
      for (const file of [1, 2, 3, 4, 5]) {
        expect(writeCoopSlot(store, at(10 * file), file)).toBe(true);
      }
      expect([1, 2, 3, 4, 5].map(file => readCoopSlot(store, file)?.wave)).toEqual([10, 20, 30, 40, 50]);
    });

    it("finds a run saved before there were files as file 1", () => {
      const store = new MemoryStore();
      store.setItem(COOP_SLOT_KEY, JSON.stringify(slot));
      expect(readCoopSlot(store, 1)).toEqual(slot);
      expect(readCoopSlots(store)).toEqual([slot, null, null, null, null]);
    });

    it("reads every file in order, an empty one as null, and gives the first free one", () => {
      const store = new MemoryStore();
      expect(firstFreeCoopFile(store)).toBe(1);
      writeCoopSlot(store, at(1), 1);
      writeCoopSlot(store, at(3), 3);
      expect(readCoopSlots(store).map(file => file?.wave ?? null)).toEqual([1, null, 3, null, null]);
      expect(firstFreeCoopFile(store)).toBe(2);
      for (const file of [2, 4, 5]) {
        writeCoopSlot(store, at(file), file);
      }
      expect(firstFreeCoopFile(store)).toBeNull();
    });

    it("clears one file and leaves the others", () => {
      const store = new MemoryStore();
      writeCoopSlot(store, at(1), 1);
      writeCoopSlot(store, at(2), 2);
      clearCoopSlot(store, 2);
      expect(readCoopSlots(store).map(file => file?.wave ?? null)).toEqual([1, null, null, null, null]);
    });

    it("drops a damaged file, not the others", () => {
      const store = new MemoryStore();
      writeCoopSlot(store, at(1), 1);
      store.setItem(coopSlotKey(4), "{broken");
      expect(readCoopSlot(store, 4)).toBeNull();
      expect(store.getItem(coopSlotKey(4))).toBeNull();
      expect(readCoopSlot(store, 1)?.wave).toBe(1);
    });

    it("has no file but the five", () => {
      const store = new MemoryStore();
      for (const file of [0, 6, 1.5, -1]) {
        expect(() => coopSlotKey(file)).toThrow(RangeError);
        expect(() => readCoopSlot(store, file)).toThrow(RangeError);
      }
    });
  });
});
