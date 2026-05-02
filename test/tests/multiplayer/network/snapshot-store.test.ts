import type { BattleSnapshot } from "#app/multiplayer/network/snapshot";
import { SnapshotStore } from "#app/multiplayer/network/snapshot-store";
import { describe, expect, it } from "vitest";

function emptySnapshot(): BattleSnapshot {
  return {
    field: { slot0: null, slot1: null, foe0: null, foe1: null },
    weather: null,
    recentLog: [],
  };
}

describe("SnapshotStore", () => {
  it("getCurrent returns null before any setSnapshot", () => {
    const store = new SnapshotStore();
    expect(store.getCurrent()).toBeNull();
  });

  it("setSnapshot then getCurrent returns the same snapshot and turn", () => {
    const store = new SnapshotStore();
    const snap = emptySnapshot();
    store.setSnapshot(snap, 7);
    const current = store.getCurrent();
    expect(current).not.toBeNull();
    expect(current?.snapshot).toBe(snap);
    expect(current?.turn).toBe(7);
  });

  it("only the latest setSnapshot persists", () => {
    const store = new SnapshotStore();
    const a = emptySnapshot();
    const b = emptySnapshot();
    store.setSnapshot(a, 1);
    store.setSnapshot(b, 2);
    expect(store.getCurrent()?.snapshot).toBe(b);
    expect(store.getCurrent()?.turn).toBe(2);
  });

  it("clear() resets to null", () => {
    const store = new SnapshotStore();
    store.setSnapshot(emptySnapshot(), 1);
    store.clear();
    expect(store.getCurrent()).toBeNull();
  });
});
