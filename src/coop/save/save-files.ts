/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { COOP_SLOT_FILES, type CoopSlot, clearCoopSlot, readCoopSlot, readCoopSlots } from "#coop/save/coop-slot";
import { coopStore } from "#coop/save/wave-save";
import { coopText } from "#coop/ui/text";
import { UiMode } from "#enums/ui-mode";
import type { SessionSaveData } from "#types/save-data";
import { SaveSlotUiMode } from "#ui/save-slot-select-ui-handler";

/**
 * The host's co-op save files on the save screen (DECISIONS D19, amended): the solo save screen, with the files of this
 * browser in place of the solo slots. Continue picks a file's run (Continue, Delete, Cancel); a new run picks the file it
 * goes in, an empty one or one whose run it replaces once it saves its first wave.
 *
 * @module
 */

/** What the save screen needs from the co-op files, in place of the solo slots */
export interface CoopSaveFiles {
  /** The run of file `index + 1`, as the screen draws it, or `null` for an empty file. Throws for one that cannot be read */
  load(index: number): SessionSaveData | null;
  /** The title line of file `index + 1`: who its run is with */
  title(index: number): string;
  /** Delete the run of file `index + 1` */
  remove(index: number): void;
  /** The entry that continues a file's run */
  readonly continueLabel: string;
  /** Asked before a new run takes a file that has a run */
  readonly overwriteQuestion: string;
}

/** @returns The run of each save file, file 1 first (`null`: empty), or none where the browser keeps no storage */
export function savedCoopRuns(): (CoopSlot | null)[] {
  const store = coopStore();
  return store === null ? Array.from({ length: COOP_SLOT_FILES }, () => null) : readCoopSlots(store);
}

/** "With Alex", "With Alex & Kim": the other players of a saved run, as the host sees it */
export function savedRunTitle(slot: CoopSlot): string {
  const others = [slot.names.guest, ...(slot.accountIds.guest2 === undefined ? [] : [slot.names.guest2])];
  return coopText("savedRunWith", "With {{names}}", { names: others.filter(name => name !== undefined).join(" & ") });
}

/** The co-op files of this browser, for the save screen */
export function coopSaveFiles(): CoopSaveFiles {
  const slotOf = (index: number): CoopSlot | null => {
    const store = coopStore();
    return store === null ? null : readCoopSlot(store, index + 1);
  };
  return {
    load: index => {
      const slot = slotOf(index);
      return slot === null ? null : globalScene.gameData.parseSessionData(slot.session);
    },
    title: index => {
      const slot = slotOf(index);
      return slot === null ? "" : savedRunTitle(slot);
    },
    remove: index => {
      const store = coopStore();
      if (store !== null) {
        clearCoopSlot(store, index + 1);
      }
    },
    continueLabel: coopText("continueFile", "Continue"),
    overwriteQuestion: coopText("overwriteFile", "Replace this file's run with the new game?"),
  };
}

/**
 * Open the save screen on the co-op files
 * @param purpose - `continue`: pick a saved run; `new`: pick the file a new run goes in
 * @param chosen - With the file picked, `1` to `COOP_SLOT_FILES`
 * @param cancelled - The player went back
 */
export function pickCoopFile(purpose: "continue" | "new", chosen: (file: number) => void, cancelled: () => void): void {
  globalScene.ui.setOverlayMode(
    UiMode.SAVE_SLOT,
    purpose === "continue" ? SaveSlotUiMode.LOAD : SaveSlotUiMode.SAVE,
    (index: number) => {
      if (index >= 0) {
        chosen(index + 1);
        return;
      }
      // The save screen goes (a mode change clears it, as solo's cancel does) before the co-op menu comes back: the menu is
      // an overlay, and over the save screen it would leave the files drawn, and drawn twice the next time it opens
      void globalScene.ui.setMode(UiMode.MESSAGE).then(cancelled);
    },
    coopSaveFiles(),
  );
}
