import type { BattleSnapshot } from "#app/multiplayer/network/snapshot";

export interface StoredSnapshot {
  snapshot: BattleSnapshot;
  turn: number;
}

export class SnapshotStore {
  private current: StoredSnapshot | null = null;

  setSnapshot(snapshot: BattleSnapshot, turn: number): void {
    this.current = { snapshot, turn };
  }

  getCurrent(): StoredSnapshot | null {
    return this.current;
  }

  clear(): void {
    this.current = null;
  }
}
