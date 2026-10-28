/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  BACKUP_AFTER_PLAY_S,
  BACKUP_EVERY_MS,
  BACKUP_KEY,
  BACKUP_SNOOZE_MS,
  type BackupState,
  backupDue,
  noteBackup,
  readBackupState,
  snoozeBackup,
} from "#coop/save-backup";
import { describe, expect, it } from "vitest";

/** A `Storage` in a Map */
class MapStore {
  readonly data = new Map<string, string>();
  /** Make writes fail, as a full or private-mode store does */
  failWrites = false;
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new Error("QuotaExceededError");
    }
    this.data.set(key, value);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 28, 12);
const never: BackupState = { backedUpAt: null, playTimeAtBackup: 0, snoozedUntil: 0 };

describe("Co-op: when a local account's backup is offered", () => {
  it("not for an account with little play yet", () => {
    expect(backupDue(never, NOW, BACKUP_AFTER_PLAY_S - 1)).toBe(false);
    expect(backupDue(never, NOW, BACKUP_AFTER_PLAY_S)).toBe(true);
  });

  it("after a backup: once it is old enough and there was play since", () => {
    const state: BackupState = { backedUpAt: NOW, playTimeAtBackup: 5000, snoozedUntil: 0 };
    // recent, whatever was played
    expect(backupDue(state, NOW + DAY, 5000 + 10 * BACKUP_AFTER_PLAY_S)).toBe(false);
    // old, but nothing new to lose
    expect(backupDue(state, NOW + BACKUP_EVERY_MS, 5000 + BACKUP_AFTER_PLAY_S - 1)).toBe(false);
    expect(backupDue(state, NOW + BACKUP_EVERY_MS, 5000 + BACKUP_AFTER_PLAY_S)).toBe(true);
  });

  it("an account imported with less play time than at the last backup counts from zero", () => {
    const state: BackupState = { backedUpAt: NOW - BACKUP_EVERY_MS, playTimeAtBackup: 90_000, snoozedUntil: 0 };
    expect(backupDue(state, NOW, BACKUP_AFTER_PLAY_S)).toBe(true);
  });

  it("No puts it off for a day", () => {
    const store = new MapStore();
    snoozeBackup(store, NOW);
    expect(backupDue(readBackupState(store), NOW + BACKUP_SNOOZE_MS - 1, 10 * BACKUP_AFTER_PLAY_S)).toBe(false);
    expect(backupDue(readBackupState(store), NOW + BACKUP_SNOOZE_MS, 10 * BACKUP_AFTER_PLAY_S)).toBe(true);
  });

  it("a backup is stored, and clears a put-off offer", () => {
    const store = new MapStore();
    snoozeBackup(store, NOW);
    noteBackup(store, NOW + 1, 1234);
    expect(readBackupState(store)).toEqual({ backedUpAt: NOW + 1, playTimeAtBackup: 1234, snoozedUntil: 0 });
  });

  it("an unreadable entry or no storage reads as no backup; a failed write throws nothing", () => {
    const store = new MapStore();
    store.data.set(BACKUP_KEY, "{not json");
    expect(readBackupState(store)).toEqual(never);
    store.data.set(BACKUP_KEY, JSON.stringify({ backedUpAt: "yesterday", playTimeAtBackup: null }));
    expect(readBackupState(store)).toEqual(never);
    expect(readBackupState(null)).toEqual(never);
    store.failWrites = true;
    expect(() => noteBackup(store, NOW, 1)).not.toThrow();
    expect(() => snoozeBackup(null, NOW)).not.toThrow();
  });
});
