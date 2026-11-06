/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as buildInfo from "#coop/link/build-info";
import { localAccountId, registerContinueHandler, showCoopTitleMenu } from "#coop/link/lobby";
import { COOP_SLOT_FILES, COOP_SLOT_VERSION, type CoopSlot, readCoopSlot, writeCoopSlot } from "#coop/save/coop-slot";
import { hostContinue } from "#coop/save/rejoin";
import { coopSaveFiles, pickCoopFile } from "#coop/save/save-files";
import { removeCoopSlot } from "#coop/save/wave-save";
import { endCoopSession } from "#coop/session";
import { Button } from "#enums/buttons";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { GameManager } from "#test/framework/game-manager";
import type { OptionSelectUiHandler } from "#ui/option-select-ui-handler";
import i18next from "i18next";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The host's five co-op save files (DECISIONS D19, amended): the co-op menu's Continue and a new game pick a file on the
 * save screen of the solo slots, which then shows the co-op files; Delete removes one file's run; no solo slot is touched.
 */

const CALLBACKS = { onConnected: () => undefined, onCancel: () => undefined };

describe("Co-op: the save files (D19)", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;
  let texts: string[];
  /** A real session save, as a co-op file keeps it */
  let session: string;

  const tick = () => new Promise(resolve => setTimeout(resolve, 20));

  const slot = (wave: number, guest = "Alex"): CoopSlot => ({
    version: COOP_SLOT_VERSION,
    savedAt: 1,
    wave,
    epoch: 0,
    seq: 0,
    names: { host: "Sam", guest },
    accountIds: { host: localAccountId(), guest: "1:2" },
    session,
  });

  /** The labels of the option menu that is open */
  function labels(): string[] {
    const handler = game.scene.ui.getHandler() as unknown as { config: { options: { label: string }[] } | null };
    return handler.config?.options.map(option => option.label) ?? [];
  }

  async function until(done: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 100 && !done(); i++) {
      await tick();
    }
    expect(done(), what).toBe(true);
  }

  async function choose(label: string): Promise<void> {
    await until(() => labels().includes(label), `a menu with "${label}" (it has: ${labels().join(" | ")})`);
    const menu = game.scene.ui.getHandler() as OptionSelectUiHandler;
    menu.setCursor(labels().indexOf(label));
    (menu as unknown as { unblockInput(): void }).unblockInput();
    menu.processInput(Button.ACTION);
  }

  /** The save screen's slots as it drew them: whether each has a run */
  function files(): { hasData: boolean }[] {
    const handler = game.scene.ui.handlers[UiMode.SAVE_SLOT] as unknown as { sessionSlots: { hasData: boolean }[] };
    return handler.sessionSlots.map(file => ({ hasData: file.hasData }));
  }

  /** On the save screen: put the cursor on file `n` and press */
  function pressFile(n: number): void {
    const handler = game.scene.ui.getHandler();
    for (let i = 1; i < n; i++) {
      handler.processInput(Button.DOWN);
    }
    handler.processInput(Button.ACTION);
  }

  /** Answer the confirm that is open */
  async function confirm(yes: boolean): Promise<void> {
    await until(() => game.scene.ui.mode === UiMode.CONFIRM, "the confirm");
    const handler = game.scene.ui.getHandler() as OptionSelectUiHandler;
    (handler as unknown as { unblockInput(): void }).unblockInput();
    handler.setCursor(yes ? 0 : 1);
    handler.processInput(Button.ACTION);
  }

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(async () => {
    game = new GameManager(phaserGame);
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    session = JSON.stringify(game.scene.gameData.getSessionSaveData());
    texts = [];
    vi.spyOn(game.scene.ui, "showText").mockImplementation((text, _delay, callback) => {
      texts.push(text);
      callback?.();
    });
  });

  afterEach(() => {
    endCoopSession();
    for (let file = 1; file <= COOP_SLOT_FILES; file++) {
      removeCoopSlot(file);
    }
    registerContinueHandler((callbacks, file) => void hostContinue(callbacks, file));
    vi.restoreAllMocks();
  });

  it("says how many runs are saved, and Continue opens the save screen on the co-op files, not the solo slots", async () => {
    const solo = Object.keys(localStorage).filter(key => key.startsWith("sessionData"));
    writeCoopSlot(localStorage, slot(12), 1);
    writeCoopSlot(localStorage, slot(30, "Kim"), 3);
    const continued: number[] = [];
    registerContinueHandler((_callbacks, file) => continued.push(file));
    showCoopTitleMenu(CALLBACKS);
    await choose("Continue (2 saved runs)");

    await until(() => game.scene.ui.mode === UiMode.SAVE_SLOT, "the save screen");
    await until(() => files()[0]?.hasData && files()[2]?.hasData, "the two files with a run drawn");
    expect(files().map(file => file.hasData)).toEqual([true, false, true, false, false]);
    // (the test's text objects keep no text: the title line is what the screen is given)
    expect(coopSaveFiles().title(0)).toBe("With Alex");
    expect(coopSaveFiles().title(2)).toBe("With Kim");
    // the third file: its menu, then Continue
    pressFile(3);
    await choose("Continue");
    expect(continued).toEqual([3]);
    expect(Object.keys(localStorage).filter(key => key.startsWith("sessionData"))).toEqual(solo);
  });

  it("deletes one file's run, and only that one", async () => {
    writeCoopSlot(localStorage, slot(12), 1);
    writeCoopSlot(localStorage, slot(30), 3);
    pickCoopFile(
      "continue",
      () => undefined,
      () => undefined,
    );
    await until(() => game.scene.ui.mode === UiMode.SAVE_SLOT, "the save screen");
    pressFile(1);
    await choose(i18next.t("saveSlotSelectUiHandler:deleteRun"));
    await confirm(true);
    await until(() => readCoopSlot(localStorage, 1) === null, "file 1 deleted");
    expect(readCoopSlot(localStorage, 3)?.wave).toBe(30);
  });

  it("puts a new game in the first file without asking when no file has a run", async () => {
    const opened = vi.spyOn(game.scene.ui, "setOverlayMode");
    showCoopTitleMenu(CALLBACKS);
    await choose("Host a game");
    await choose(i18next.t("gameMode:classic"));
    await tick();
    expect(opened.mock.calls.some(([mode]) => mode === UiMode.SAVE_SLOT)).toBe(false);
  });

  it("asks a new game which file it goes in when one has a run", async () => {
    writeCoopSlot(localStorage, slot(12), 1);
    showCoopTitleMenu(CALLBACKS);
    await choose("Host a game");
    await choose(i18next.t("gameMode:classic"));
    await until(() => game.scene.ui.mode === UiMode.SAVE_SLOT, "the save screen");
  });

  it("takes an empty file for a new game at once", async () => {
    writeCoopSlot(localStorage, slot(12), 1);
    const picked: number[] = [];
    pickCoopFile(
      "new",
      file => picked.push(file),
      () => undefined,
    );
    await until(() => game.scene.ui.mode === UiMode.SAVE_SLOT && files()[0].hasData, "the save screen");
    pressFile(2);
    expect(picked).toEqual([2]);
    // the screen goes back to the message window (what a new game shows next)
    await until(() => game.scene.ui.mode === UiMode.MESSAGE, "the message window");
  });

  it("asks before a new game takes a file with a run, which keeps its run until the new one saves", async () => {
    writeCoopSlot(localStorage, slot(12), 1);
    const picked: number[] = [];
    pickCoopFile(
      "new",
      file => picked.push(file),
      () => undefined,
    );
    await until(() => game.scene.ui.mode === UiMode.SAVE_SLOT && files()[0].hasData, "the save screen");
    pressFile(1);
    await confirm(true);
    expect(texts).toContain("Replace this file's run with the new game?");
    expect(picked).toEqual([1]);
    expect(readCoopSlot(localStorage, 1)?.wave).toBe(12);
    await until(() => game.scene.ui.mode === UiMode.MESSAGE, "the message window");
  });

  it("goes back to the co-op menu from the save screen", async () => {
    writeCoopSlot(localStorage, slot(12), 1);
    showCoopTitleMenu(CALLBACKS);
    await choose("Continue (wave 12)");
    await until(() => game.scene.ui.mode === UiMode.SAVE_SLOT, "the save screen");
    game.scene.ui.getHandler().processInput(Button.CANCEL);
    await until(() => labels().includes("Host a game"), "the co-op menu");
  });

  it("clears the save screen it leaves: opened again, it has the five files once (they were drawn twice)", async () => {
    writeCoopSlot(localStorage, slot(12), 1);
    for (let time = 1; time <= 2; time++) {
      showCoopTitleMenu(CALLBACKS);
      await choose("Continue (wave 12)");
      await until(() => game.scene.ui.mode === UiMode.SAVE_SLOT && files()[0]?.hasData, "the save screen");
      expect(files(), `opened ${time} time(s)`).toHaveLength(5);
      game.scene.ui.getHandler().processInput(Button.CANCEL);
      await until(() => labels().includes("Host a game"), "the co-op menu");
    }
  });

  it("continues the run of the file picked: file 3 is read, not file 1", async () => {
    vi.spyOn(buildInfo, "overridesAreDefaults").mockReturnValue(true);
    writeCoopSlot(localStorage, slot(12), 1);
    writeCoopSlot(localStorage, { ...slot(30), accountIds: { host: "9:9", guest: "1:2" } }, 3);
    await hostContinue(CALLBACKS, 3);
    await until(() => texts.some(text => text.includes("saved with another account")), "the account refusal");
  });
});
