/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { BACKUP_AFTER_PLAY_S, BACKUP_KEY, readBackupState } from "#coop/save/save-backup";
import { offerSaveBackup } from "#coop/save/save-backup-offer";
import { Button } from "#enums/buttons";
import { GameDataType } from "#enums/game-data-type";
import { GameModes } from "#enums/game-modes";
import { UiMode } from "#enums/ui-mode";
import type { TitlePhase } from "#phases/title-phase";
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
    await vi.waitFor(() => expect(confirm).toBeDefined());
    expect(shown[0]).toContain("only in this browser");
    confirm!.yesHandler();
    await offered;

    expect(exportData).toHaveBeenCalledWith(GameDataType.SYSTEM);
    expect(persist).toHaveBeenCalled();
    expect(shown[1]).toContain("Import Data");
    // The account's play time at the backup (the game's clock goes on while the question is up)
    const { playTimeAtBackup } = readBackupState(localStorage);
    expect(playTimeAtBackup).toBeGreaterThanOrEqual(2 * BACKUP_AFTER_PLAY_S);
    expect(playTimeAtBackup).toBeLessThanOrEqual(game.scene.gameData.gameStats.playTime);
    // not asked again right after
    await offerSaveBackup(true);
    expect(shown).toHaveLength(2);
  });

  it("No puts it off, and the menu comes as usual", async () => {
    const offered = offerSaveBackup(true);
    await vi.waitFor(() => expect(confirm).toBeDefined());
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
    await vi.waitFor(() => expect(confirm).toBeDefined());
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

/**
 * A player's report (2026-11-13): the partner left the co-op starter select; back at the title, the offer came over the
 * starter select, which stayed drawn under the title menu. The title screen comes straight from the screen that was on.
 */
describe("Co-op: the backup offer right after another screen", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    localStorage.removeItem(BACKUP_KEY);
    vi.restoreAllMocks();
  });

  it("takes the starter select off before it asks", async () => {
    const game = new GameManager(phaserGame);
    const { ui, gameData } = game.scene;
    await game.runToTitle();
    game.onNextPrompt("TitlePhase", UiMode.TITLE, () => {
      const title = game.scene.phaseManager.getCurrentPhase() as TitlePhase;
      title.gameMode = GameModes.CLASSIC;
      title.end();
    });
    game.onNextPrompt("SelectStarterPhase", UiMode.STARTER_SELECT, () => {});
    await game.phaseInterceptor.to("SelectStarterPhase");
    await vi.waitUntil(() => ui.mode === UiMode.STARTER_SELECT, { timeout: 5000, interval: 10 });
    localStorage.removeItem(BACKUP_KEY);
    gameData.gameStats.playTime = 2 * BACKUP_AFTER_PLAY_S;
    const starterSelect = ui.getHandler();
    expect(starterSelect.active).toBe(true);

    const offered = offerSaveBackup(true);
    await vi.waitUntil(() => ui.mode === UiMode.CONFIRM, { timeout: 5000, interval: 10 });
    expect(starterSelect.active).toBe(false);
    expect(ui.modeChain).not.toContain(UiMode.STARTER_SELECT);

    // No: the offer is put off, and the title menu comes next
    ui.processInput(Button.CANCEL);
    await offered;
    expect(readBackupState(localStorage).snoozedUntil).toBeGreaterThan(Date.now());
  });
});
