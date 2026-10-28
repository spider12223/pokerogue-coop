/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { BACKUP_AFTER_PLAY_S, BACKUP_KEY, readBackupState } from "#coop/save-backup";
import { offerSaveBackup } from "#coop/save-backup-offer";
import { GameDataType } from "#enums/game-data-type";
import { UiMode } from "#enums/ui-mode";
import { GameManager } from "#test/framework/game-manager";
import type { ConfirmModeConfig } from "#types/ui-types";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

/**
 * The title screen's offer to back up a local account: the co-op website and pack keep the account in this browser only,
 * so clearing site data deletes it (issue: a player lost everything that way).
 */
describe("Co-op: the backup offer on the title screen", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;
  let shown: string[];
  let confirm: ConfirmModeConfig | undefined;
  let exportData: MockInstance;
  let persist: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    localStorage.removeItem(BACKUP_KEY);
    const { ui, gameData } = game.scene;
    gameData.gameStats.playTime = 2 * BACKUP_AFTER_PLAY_S;
    shown = [];
    confirm = undefined;
    vi.spyOn(ui, "showText").mockImplementation((text, _delay, callback) => {
      shown.push(text);
      callback?.();
    });
    vi.spyOn(ui, "setModeWithoutClear").mockImplementation(async (mode, ...args) => {
      if (mode === UiMode.CONFIRM) {
        confirm = args[0] as ConfirmModeConfig;
      }
    });
    vi.spyOn(ui, "setMode").mockResolvedValue();
    exportData = vi.spyOn(gameData, "tryExportData").mockResolvedValue(true);
    persist = vi.fn(async () => true);
    Object.defineProperty(navigator, "storage", { value: { persist }, configurable: true });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "storage");
    localStorage.removeItem(BACKUP_KEY);
  });

  it("asks, and Yes downloads the account and records the backup", async () => {
    const offered = offerSaveBackup(true);
    expect(shown[0]).toContain("only in this browser");
    confirm!.yesHandler();
    await offered;

    expect(exportData).toHaveBeenCalledWith(GameDataType.SYSTEM);
    expect(persist).toHaveBeenCalled();
    expect(shown[1]).toContain("Import Data");
    expect(readBackupState(localStorage).playTimeAtBackup).toBe(2 * BACKUP_AFTER_PLAY_S);
    // not asked again right after
    await offerSaveBackup(true);
    expect(shown).toHaveLength(2);
  });

  it("No puts it off, and the menu comes as usual", async () => {
    const offered = offerSaveBackup(true);
    confirm!.noHandler();
    await offered;

    expect(exportData).not.toHaveBeenCalled();
    expect(readBackupState(localStorage).snoozedUntil).toBeGreaterThan(Date.now());
    await offerSaveBackup(true);
    expect(shown).toHaveLength(1);
  });

  it("a failed download says so and records nothing", async () => {
    exportData.mockResolvedValue(false);
    const offered = offerSaveBackup(true);
    confirm!.yesHandler();
    await offered;

    expect(shown[1]).toContain("Export Data");
    expect(readBackupState(localStorage).backedUpAt).toBeNull();
  });

  it("nothing is asked with server accounts, or before there is progress to lose", async () => {
    await offerSaveBackup(false);
    game.scene.gameData.gameStats.playTime = BACKUP_AFTER_PLAY_S - 1;
    await offerSaveBackup(true);
    expect(shown).toEqual([]);
  });
});
