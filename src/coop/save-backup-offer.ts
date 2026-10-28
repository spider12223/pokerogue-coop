/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { bypassLogin } from "#constants/app-constants";
import { backupDue, noteBackup, readBackupState, snoozeBackup } from "#coop/save-backup";
import { coopText } from "#coop/text";
import { GameDataType } from "#enums/game-data-type";
import { UiMode } from "#enums/ui-mode";

/**
 * The title screen's offer to back up a local account (`save-backup.ts` decides when). "Yes" downloads the menu's Export
 * Data file; Manage Data > Import Data restores it.
 * @module
 */

/** When a backup was made, or put off: the account's own record, never read by a run */
function clock(): number {
  return Date.now();
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Ask the browser not to evict this site's storage by itself (under low disk space, say). It does not stop the player
 * clearing it: that is what the backup is for.
 */
function keepStorage(): void {
  try {
    void navigator.storage?.persist?.().catch(() => false);
  } catch {
    // No storage manager (a page served over plain http): nothing to ask
  }
}

/**
 * The account was exported from the menu (Export Data): the offer counts from it
 * @param playTime - The account's play time (s)
 */
export function noteAccountExported(playTime: number): void {
  if (bypassLogin) {
    noteBackup(browserStorage(), clock(), playTime);
  }
}

/**
 * Offer a backup of the account before the title menu, when one is due
 * @param localSaves - Whether the account lives only in this browser (default: `bypassLogin`)
 * @returns Resolves once the player answered; at once when nothing is offered
 */
export function offerSaveBackup(localSaves = bypassLogin): Promise<void> {
  const { gameData, ui } = globalScene;
  const storage = browserStorage();
  if (!localSaves || !backupDue(readBackupState(storage), clock(), gameData.gameStats.playTime)) {
    return Promise.resolve();
  }
  return new Promise<void>(resolve => {
    const close = (): void => {
      ui.clearText();
      resolve();
    };
    ui.showText(
      coopText(
        "backupOffer",
        "Your save is only in this browser: clearing cookies or site data deletes it. Download a backup?",
      ),
      null,
      () =>
        ui.setModeWithoutClear(UiMode.CONFIRM, {
          yesHandler: () => {
            keepStorage();
            void ui.setMode(UiMode.MESSAGE).then(async () => {
              const saved = await gameData.tryExportData(GameDataType.SYSTEM);
              if (saved) {
                noteBackup(storage, clock(), gameData.gameStats.playTime);
              }
              ui.showText(
                saved
                  ? coopText("backupSaved", "Saved to your downloads. To restore it: Manage Data > Import Data.")
                  : coopText("backupFailed", "The backup could not be made. Try Manage Data > Export Data."),
                null,
                close,
                null,
                true,
              );
            });
          },
          noHandler: () => {
            snoozeBackup(storage, clock());
            void ui.setMode(UiMode.MESSAGE).then(close);
          },
        }),
    );
  });
}
