/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { saveKey } from "#app/constants";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import * as appConstants from "#constants/app-constants";
import { COOP_SLOT_VERSION, writeCoopSlot } from "#coop/coop-slot";
import { importInCoopText, systemImportNotes } from "#coop/import-account";
import { localAccountId, showCoopTitleMenu } from "#coop/lobby";
import { endCoopSession, startCoopSession } from "#coop/session";
import { removeCoopSlot } from "#coop/wave-save";
import { Button } from "#enums/buttons";
import { DexAttr } from "#enums/dex-attr";
import { GameDataType } from "#enums/game-data-type";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { version } from "#package.json";
import { GameData } from "#system/game-data";
import { GameManager } from "#test/framework/game-manager";
import type { MenuUiHandler } from "#ui/menu-ui-handler";
import type { OptionSelectUiHandler } from "#ui/option-select-ui-handler";
import { compareVersions } from "#utils/migrator-utils";
import fs from "node:fs";
import { AES, enc } from "crypto-js";
import i18next from "i18next";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Importing an account exported from pokerogue.net: Menu → Manage Data → Export Data there gives the account's system data,
 * AES-encrypted with `saveKey` and with short keys. The import reads it in one step (`GameData.readSystemImport`); a save from a
 * newer version is made into one of this version; the co-op menu offers it; a co-op session refuses it (it reloads the page).
 */

const BUILD = { protocolVersion: 1, gitSha: "x", dirtyHash: "clean", buildMode: "test", overridesHash: "0" } as const;

/** A species id this build does not have */
const UNKNOWN_SPECIES = 99_999;
/** A move id this build does not have */
const UNKNOWN_MOVE = 99_999;

type SaveJson = Record<string, any>;

describe("Co-op: importing a pokerogue.net account", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;
  let gameData: GameData;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    gameData = game.scene.gameData;
  });

  afterEach(() => {
    endCoopSession();
    removeCoopSlot();
    document.getElementById("saveFile")?.remove();
  });

  /** This account's system data as plain JSON, as `saveSystem` writes it */
  function accountJson(): SaveJson {
    return JSON.parse(
      JSON.stringify(gameData.getSystemSaveData(), (_k, v) =>
        typeof v === "bigint" ? (v <= 0x80000000n ? Number(v) : v.toString()) : v,
      ),
    );
  }

  /** The file Export Data gives: short keys, AES with `saveKey` (`GameData.tryExportData`) */
  function exportFile(data: SaveJson): string {
    const short = (
      gameData as unknown as { convertSystemDataStr(s: string, shorten: boolean): string }
    ).convertSystemDataStr(JSON.stringify(data), true);
    return AES.encrypt(short, saveKey).toString();
  }

  function accepted(text: string) {
    const result = gameData.readSystemImport(text);
    if (!result.ok) {
      throw new Error(`refused: ${result.reason}`);
    }
    return { result, data: GameData.parseSystemData(result.dataStr) };
  }

  /** A starter that is not one of the default ones */
  const OTHER_STARTER = SpeciesId.CATERPIE;

  describe("the file", () => {
    it("an exported (encrypted) account of this version is read as it is", () => {
      const json = accountJson();
      json["gameVersion"] = version;
      json["dexData"][OTHER_STARTER]["caughtAttr"] = Number(
        DexAttr.NON_SHINY | DexAttr.MALE | DexAttr.DEFAULT_VARIANT | DexAttr.DEFAULT_FORM,
      );
      json["dexData"][OTHER_STARTER]["caughtCount"] = 3;
      json["starterData"][OTHER_STARTER]["candyCount"] = 42;

      const { result, data } = accepted(exportFile(json));

      expect(result).toMatchObject({ ok: true, fromVersion: version, newer: false, droppedSpecies: 0, droppedEggs: 0 });
      expect(data.gameVersion).toBe(version);
      expect(data.dexData[OTHER_STARTER].caughtCount).toBe(3);
      expect(data.dexData[OTHER_STARTER].caughtAttr).toBe(
        DexAttr.NON_SHINY | DexAttr.MALE | DexAttr.DEFAULT_VARIANT | DexAttr.DEFAULT_FORM,
      );
      expect(data.starterData[OTHER_STARTER].candyCount).toBe(42);
      expect(Object.keys(data.starterData).length).toBe(speciesDataRegistry.getAllStarters().length);
    });

    it.each(["everything.prsv", "data_new.prsv", "full_unlocks_sanitized.prsv", "data_pokedex_tests.prsv"])(
      "a real exported file (%s) is read, and loads",
      file => {
        const { result } = accepted(fs.readFileSync(`./test/utils/saves/${file}`, "utf8"));
        expect(result.newer).toBe(false);
        expect(() => GameData.fromRawSystem(result.dataStr)).not.toThrow();
      },
    );

    it("a real exported file, as if from a newer version, is made into one of this version and loads", () => {
      const plain = AES.decrypt(
        fs.readFileSync("./test/utils/saves/data_pokedex_tests.prsv", "utf8"),
        saveKey,
      ).toString(enc.Utf8);
      const newer = plain.replace(/"gameVersion":"[^"]+"/, '"gameVersion":"99.0.0"');
      const { result, data } = accepted(AES.encrypt(newer, saveKey).toString());
      expect(result.newer).toBe(true);
      expect(data.gameVersion).toBe(version);
      const loaded = GameData.fromRawSystem(result.dataStr);
      for (const starter of speciesDataRegistry.getAllStarters()) {
        expect(loaded.starterData[starter], `starter ${starter}`).toBeDefined();
      }
    });

    it("plain JSON (long keys) is read too", () => {
      const json = accountJson();
      json["gameVersion"] = version;
      const { result } = accepted(JSON.stringify(json));
      expect(result.newer).toBe(false);
    });

    it("keeps this browser's trainer and secret IDs, also when the file's are written another way", () => {
      const json = accountJson();
      json["gameVersion"] = version;
      json["trainerId"] = (gameData.trainerId + 1) % 65536;
      json["secretId"] = (gameData.secretId + 1) % 65536;
      // pretty-printed: `"trainerId": 5`, which the key conversion does not match
      const { data } = accepted(JSON.stringify(json, null, 2));
      expect(`${data.trainerId}:${data.secretId}`).toBe(localAccountId());
    });

    it("refuses what is not an account", () => {
      const reason = (text: string) => {
        const result = gameData.readSystemImport(text);
        return result.ok ? "accepted" : result.reason;
      };
      expect(reason("")).toBe("unreadable");
      expect(reason("not a save at all")).toBe("unreadable");
      expect(reason(AES.encrypt("hello", saveKey).toString())).toBe("unreadable");
      expect(reason(AES.encrypt(JSON.stringify(accountJson()), "another key").toString())).toBe("unreadable");
      expect(reason(JSON.stringify({ hello: 1 }))).toBe("notSystemData");
      expect(reason(JSON.stringify({ ...accountJson(), starterData: undefined }))).toBe("notSystemData");
      expect(reason(JSON.stringify({ ...accountJson(), gameVersion: "next" }))).toBe("notSystemData");
    });

    it("refuses an account the next save would throw away (starter data without a dex entry)", () => {
      const json = accountJson();
      json["gameVersion"] = version;
      json["starterData"][OTHER_STARTER]["abilityAttr"] = 1;
      json["dexData"][OTHER_STARTER] = {
        ...json["dexData"][OTHER_STARTER],
        caughtAttr: 0,
        caughtCount: 0,
        hatchedCount: 0,
      };
      const result = gameData.readSystemImport(exportFile(json));
      expect(result).toEqual({ ok: false, reason: "corrupt" });
    });

    it("leaves an older save as it is: the migrations bring it up to date when it loads", () => {
      const json = accountJson();
      json["gameVersion"] = "1.12.0.0";
      const { result, data } = accepted(exportFile(json));
      expect(result).toMatchObject({ newer: false, fromVersion: "1.12.0.0" });
      expect(data.gameVersion).toBe("1.12.0.0");
    });
  });

  describe("a save from a newer version", () => {
    /** The species whose dex says it was caught only in a form this build does not have */
    const FORM_SPECIES = SpeciesId.CATERPIE;
    /** The starter whose moveset has a move this build does not have */
    const MOVESET_SPECIES = SpeciesId.WEEDLE;
    /** A starter the newer save does not have an entry for */
    const MISSING_STARTER = SpeciesId.PIDGEY;

    function newerSave(): SaveJson {
      const json = accountJson();
      json["gameVersion"] = "99.0.0";
      json["dexData"][UNKNOWN_SPECIES] = { ...json["dexData"][SpeciesId.BULBASAUR] };
      json["starterData"][UNKNOWN_SPECIES] = { ...json["starterData"][SpeciesId.BULBASAUR], candyCount: 5 };
      const egg = {
        id: 1,
        tier: 0,
        sourceType: 0,
        hatchWaves: 10,
        timestamp: 1,
        variantTier: 0,
        isShiny: false,
        eggMoveIndex: 0,
        overrideHiddenAbility: false,
      };
      json["eggs"] = [
        { ...egg, species: UNKNOWN_SPECIES },
        { ...egg, id: 2, species: SpeciesId.CATERPIE },
      ];
      const forms = Math.max(speciesDataRegistry.getSpecies(FORM_SPECIES).forms.length, 1);
      const unknownForm = 2 ** (7 + forms);
      json["dexData"][FORM_SPECIES] = {
        ...json["dexData"][FORM_SPECIES],
        seenAttr: Number(DexAttr.NON_SHINY | DexAttr.MALE | DexAttr.DEFAULT_VARIANT) + unknownForm,
        caughtAttr: Number(DexAttr.NON_SHINY | DexAttr.MALE | DexAttr.DEFAULT_VARIANT) + unknownForm,
        caughtCount: 1,
      };
      json["dexData"][MOVESET_SPECIES] = {
        ...json["dexData"][MOVESET_SPECIES],
        caughtAttr: Number(DexAttr.NON_SHINY | DexAttr.MALE | DexAttr.DEFAULT_VARIANT | DexAttr.DEFAULT_FORM),
        caughtCount: 1,
      };
      json["starterData"][MOVESET_SPECIES]["moveset"] = [MoveId.TACKLE, UNKNOWN_MOVE];
      delete json["starterData"][MISSING_STARTER];
      return json;
    }

    it("as it is, it does not load here: refused as out of date, and an unknown egg throws", () => {
      const json = newerSave();
      // `initSystem` refuses an account from a newer version and keeps the default one
      expect(compareVersions(json["gameVersion"], version)).toBe(1);
      expect(() => GameData.fromRawSystem(JSON.stringify(json))).toThrow();
    });

    it("is made into one of this version: what this build lacks is left out, and it loads", () => {
      expect(speciesDataRegistry.getSpeciesData(UNKNOWN_SPECIES as SpeciesId)).toBeUndefined();

      const { result, data } = accepted(exportFile(newerSave()));

      expect(result).toMatchObject({ ok: true, fromVersion: "99.0.0", newer: true, droppedSpecies: 1, droppedEggs: 1 });
      expect(data.gameVersion).toBe(version);
      expect(data.dexData[UNKNOWN_SPECIES]).toBeUndefined();
      expect(data.starterData[UNKNOWN_SPECIES]).toBeUndefined();
      expect(data.eggs.map(egg => egg.species)).toEqual([SpeciesId.CATERPIE]);
      // only a form it does not have: its first form instead, so it stays caught
      const kept = DexAttr.NON_SHINY | DexAttr.MALE | DexAttr.DEFAULT_VARIANT | DexAttr.DEFAULT_FORM;
      expect(data.dexData[FORM_SPECIES].caughtAttr).toBe(kept);
      expect(data.dexData[FORM_SPECIES].seenAttr).toBe(kept);
      expect(data.starterData[MOVESET_SPECIES].moveset).toBeNull();
      expect(data.starterData[MISSING_STARTER]).toMatchObject({ candyCount: 0, abilityAttr: 0, moveset: null });
      expect(`${data.trainerId}:${data.secretId}`).toBe(localAccountId());

      // and it loads as an account: the eggs, the dex, the starters
      const loaded = GameData.fromRawSystem(result.dataStr);
      expect(loaded.eggs.map(egg => egg.species)).toEqual([SpeciesId.CATERPIE]);
      expect(loaded.getSpeciesDefaultDexAttrProps(FORM_SPECIES).formIndex).toBe(0);
      expect(loaded.starterData[MISSING_STARTER]).toBeDefined();
      for (const starter of speciesDataRegistry.getAllStarters()) {
        expect(loaded.starterData[starter], `starter ${starter}`).toBeDefined();
      }
    });

    it("counts as left out only the species the player had something of: a newer save has an entry for every species", () => {
      const json = newerSave();
      const empty = UNKNOWN_SPECIES + 1;
      expect(speciesDataRegistry.getSpeciesData(empty as SpeciesId)).toBeUndefined();
      json["dexData"][empty] = {
        seenAttr: 0,
        caughtAttr: 0,
        natureAttr: 0,
        seenCount: 0,
        caughtCount: 0,
        hatchedCount: 0,
        ivs: [0, 0, 0, 0, 0, 0],
      };
      const { result, data } = accepted(exportFile(json));
      expect(result).toMatchObject({ droppedSpecies: 1 });
      expect(data.dexData[empty]).toBeUndefined();
    });

    it("tells the player the versions and what was left out before the question", () => {
      const { result } = accepted(exportFile(newerSave()));
      const notes = systemImportNotes(result);
      expect(notes).toHaveLength(2);
      expect(notes[0]).toContain("99.0.0");
      expect(notes[0]).toContain(version);
      expect(notes[1]).toContain("1 of its Pokémon");
      expect(notes[1]).toContain("1 of its eggs");
    });

    it("the chosen file goes through the notes to the import's question", async () => {
      const texts: string[] = [];
      const prompts: (boolean | null | undefined)[] = [];
      vi.spyOn(game.scene.ui, "showText").mockImplementation((text, _delay, callback, _callbackDelay, prompt) => {
        texts.push(text);
        prompts.push(prompt);
        callback?.();
      });
      const setOverlayMode = vi.spyOn(game.scene.ui, "setOverlayMode").mockImplementation(async () => undefined);
      const createElement = vi.spyOn(document, "createElement");

      gameData.importData(GameDataType.SYSTEM);
      const at = createElement.mock.calls.findIndex(([tag]) => tag === "input");
      const input = createElement.mock.results[at].value as HTMLInputElement;
      Object.defineProperty(input, "files", { value: [new File([exportFile(newerSave())], "data_Guest.prsv")] });
      input.dispatchEvent(new Event("change"));
      await vi.waitFor(() => expect(setOverlayMode).toHaveBeenCalled());

      expect(setOverlayMode.mock.calls[0][0]).toBe(UiMode.CONFIRM);
      expect(texts).toHaveLength(3);
      expect(texts[0]).toContain("99.0.0");
      expect(texts[1]).toContain("left out");
      expect(texts[2]).toBe(i18next.t("menuUiHandler:confirmImport", { dataName: i18next.t("gameData:system") }));
      // the notes go on by themselves: a key prompt would be taken by the menu the import was asked from
      expect(prompts.slice(0, 2).some(Boolean)).toBe(false);
    });
  });

  describe("a saved co-op run", () => {
    it("stays: the import keeps this browser's IDs, which the run is found again by (D21), and the player is told", () => {
      const json = accountJson();
      json["gameVersion"] = version;
      writeCoopSlot(localStorage, {
        version: COOP_SLOT_VERSION,
        savedAt: 1,
        wave: 7,
        epoch: 0,
        seq: 0,
        names: { host: "Sam", guest: "Alex" },
        accountIds: { host: localAccountId(), guest: "1:2" },
        session: "{}",
      });
      const { result, data } = accepted(exportFile(json));
      expect(`${data.trainerId}:${data.secretId}`).toBe(localAccountId());
      const notes = systemImportNotes(result);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("wave 7");
    });

    it("an account of this version and no co-op slot: nothing to tell, the question comes at once (as upstream)", () => {
      const json = accountJson();
      json["gameVersion"] = version;
      expect(systemImportNotes(accepted(exportFile(json)).result)).toEqual([]);
    });
  });

  describe("where it is offered", () => {
    const tick = () => new Promise(resolve => setTimeout(resolve, 20));

    function coopMenuLabels(): string[] {
      const handler = game.scene.ui.getHandler() as unknown as { config: { options: { label: string }[] } | null };
      return handler.config?.options.map(option => option.label) ?? [];
    }

    it("the co-op menu has it: it explains where the file comes from, opens the import, and comes back", async () => {
      const texts: string[] = [];
      vi.spyOn(game.scene.ui, "showText").mockImplementation((text, _delay, callback) => {
        texts.push(text);
        callback?.();
      });
      const importData = vi.spyOn(gameData, "importData").mockImplementation(() => undefined);

      showCoopTitleMenu({ onConnected: () => undefined, onCancel: () => undefined });
      await tick();
      const labels = coopMenuLabels();
      const index = labels.indexOf("Import PokéRogue data");
      expect(index, labels.join(" | ")).toBeGreaterThanOrEqual(0);

      const menu = game.scene.ui.getHandler() as OptionSelectUiHandler;
      menu.setCursor(index);
      (menu as unknown as { unblockInput(): void }).unblockInput();
      menu.processInput(Button.ACTION);
      await tick();

      expect(texts[0]).toContain("Menu > Manage Data > Export Data");
      expect(importData).toHaveBeenCalledExactlyOnceWith(GameDataType.SYSTEM);
      expect(game.scene.ui.mode).toBe(UiMode.OPTION_SELECT);
      expect(coopMenuLabels()).toContain("Import PokéRogue data");
    });

    it("not in a build with a server account (as upstream)", async () => {
      vi.spyOn(appConstants, "bypassLogin", "get").mockReturnValue(false);
      showCoopTitleMenu({ onConnected: () => undefined, onCancel: () => undefined });
      await tick();
      expect(coopMenuLabels()).not.toContain("Import PokéRogue data");
      expect(coopMenuLabels()).toContain("Host a game");
    });

    it("Manage Data has Import Data with local accounts, and not with a server account (as upstream)", () => {
      const handler = game.scene.ui.handlers[UiMode.MENU] as MenuUiHandler;
      const labels = (): string[] => {
        (handler as unknown as { initManageDataOptions(): void }).initManageDataOptions();
        return (
          handler as unknown as { manageDataConfig: { options: { label: string }[] } }
        ).manageDataConfig.options.map(option => option.label);
      };
      const importLabel = i18next.t("menuUiHandler:importData");

      vi.spyOn(appConstants, "bypassLogin", "get").mockReturnValue(true);
      expect(labels()).toContain(importLabel);
      vi.spyOn(appConstants, "bypassLogin", "get").mockReturnValue(false);
      expect(labels()).not.toContain(importLabel);
      expect(labels()).toContain(i18next.t("menuUiHandler:exportData"));
    });

    it("a co-op session refuses it: the import reloads the page", () => {
      const texts: string[] = [];
      vi.spyOn(game.scene.ui, "showText").mockImplementation(text => {
        texts.push(text);
      });

      const createElement = vi.spyOn(document, "createElement");
      const filePickers = () => createElement.mock.calls.filter(([tag]) => tag === "input").length;

      startCoopSession({ seat: "host", runSeed: "seed", build: BUILD });
      gameData.importData(GameDataType.SYSTEM);
      gameData.importData(GameDataType.SESSION, 1);
      expect(texts).toEqual([importInCoopText(), importInCoopText()]);
      expect(filePickers()).toBe(0);

      // solo: the file picker
      endCoopSession();
      gameData.importData(GameDataType.SYSTEM);
      expect(filePickers()).toBe(1);
    });
  });
});
