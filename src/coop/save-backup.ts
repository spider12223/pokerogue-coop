/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { KeyValueStore } from "#coop/seat-store";

/**
 * When to offer a backup of a local account. The website and the Windows pack keep the account in this browser's storage
 * only (`bypassLogin`): clearing cookies or site data deletes it, and no server has a copy. The title screen offers the
 * menu's Export Data file once there is progress that only this browser has (`save-backup-offer.ts`).
 *
 * `Storage` is injected: this module has no game imports and runs in plain Node.
 *
 * @module
 */

export const BACKUP_KEY = "coopBackup";
/** Play time (s) since the last backup that is worth one */
export const BACKUP_AFTER_PLAY_S = 20 * 60;
/** How long a backup is recent enough (ms), whatever was played since */
export const BACKUP_EVERY_MS = 3 * 24 * 60 * 60 * 1000;
/** How long "No" puts the offer off (ms) */
export const BACKUP_SNOOZE_MS = 24 * 60 * 60 * 1000;

export interface BackupState {
  /** When the last backup was made (ms since the epoch); `null` if never */
  backedUpAt: number | null;
  /** The account's play time (s) at that backup */
  playTimeAtBackup: number;
  /** Until when the offer is put off (ms since the epoch) */
  snoozedUntil: number;
}

/** What is stored; an unreadable entry reads as no backup */
export function readBackupState(storage: Pick<KeyValueStore, "getItem"> | null): BackupState {
  const state: BackupState = { backedUpAt: null, playTimeAtBackup: 0, snoozedUntil: 0 };
  try {
    const stored: unknown = JSON.parse(storage?.getItem(BACKUP_KEY) ?? "null");
    if (typeof stored === "object" && stored !== null) {
      const { backedUpAt, playTimeAtBackup, snoozedUntil } = stored as Record<string, unknown>;
      state.backedUpAt = typeof backedUpAt === "number" ? backedUpAt : null;
      state.playTimeAtBackup = typeof playTimeAtBackup === "number" ? playTimeAtBackup : 0;
      state.snoozedUntil = typeof snoozedUntil === "number" ? snoozedUntil : 0;
    }
  } catch {
    // Unreadable or storage off: no backup known
  }
  return state;
}

function writeBackupState(storage: Pick<KeyValueStore, "setItem"> | null, state: BackupState): void {
  try {
    storage?.setItem(BACKUP_KEY, JSON.stringify(state));
  } catch {
    // Storage full or off: the offer comes again
  }
}

/**
 * Whether a backup is offered: enough play since the last one, and the last one is old enough or there is none
 * @param now - ms since the epoch
 * @param playTime - The account's play time (s)
 */
export function backupDue(state: BackupState, now: number, playTime: number): boolean {
  if (now < state.snoozedUntil) {
    return false;
  }
  // An account imported with less play time than at the last backup counts from zero
  const playedSince = playTime >= state.playTimeAtBackup ? playTime - state.playTimeAtBackup : playTime;
  if (playedSince < BACKUP_AFTER_PLAY_S) {
    return false;
  }
  return state.backedUpAt === null || now - state.backedUpAt >= BACKUP_EVERY_MS;
}

/** The account was exported (the menu's Export Data, or the title screen's offer) */
export function noteBackup(storage: Pick<KeyValueStore, "setItem"> | null, now: number, playTime: number): void {
  writeBackupState(storage, { backedUpAt: now, playTimeAtBackup: playTime, snoozedUntil: 0 });
}

/** The player said "No": the offer comes again after {@linkcode BACKUP_SNOOZE_MS} */
export function snoozeBackup(storage: Pick<KeyValueStore, "getItem" | "setItem"> | null, now: number): void {
  writeBackupState(storage, { ...readBackupState(storage), snoozedUntil: now + BACKUP_SNOOZE_MS });
}
