/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { addPatchNotesLink, closePatchNotes, hasUnseenPatchNotes, openPatchNotes } from "#coop/ui/patch-notes";
import { PATCH_NOTES } from "#coop/ui/patch-notes-list";
import { TextStyle } from "#enums/text-style";
import { GameManager } from "#test/framework/game-manager";
import { MockText } from "#test/mocks/mocks-container/mock-text";
import { getTextColor } from "#ui/text";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Patch Notes (D50): an entry per update, newest first, and the title screen's line that opens them */
describe("Co-op: Patch Notes (D50)", () => {
  it("has an entry per update, newest first, each with a line at least", () => {
    expect(PATCH_NOTES.length).toBeGreaterThan(0);
    let previous = "9999-12-31";
    for (const note of PATCH_NOTES) {
      expect(note.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${note.date}T00:00:00Z`)), note.date).toBe(false);
      expect(note.date < previous, `${note.date} comes after ${previous}`).toBe(true);
      previous = note.date;
      const lines = [...(note.new ?? []), ...(note.changed ?? []), ...(note.fixed ?? [])];
      expect(lines.length, note.date).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.length, note.date).toBeGreaterThan(0);
        expect(line.trim(), note.date).toBe(line);
      }
    }
  });

  describe("the list", () => {
    beforeEach(() => {
      localStorage.removeItem("coopPatchNotesSeen");
    });

    afterEach(() => {
      closePatchNotes();
      localStorage.removeItem("coopPatchNotesSeen");
    });

    it("shows the updates, newest first; opening them marks the newest read", () => {
      expect(hasUnseenPatchNotes()).toBe(true);
      openPatchNotes();

      const first = document.getElementById("coopPatchNotesPanel")?.querySelector("section");
      for (const line of [...(PATCH_NOTES[0].new ?? []), ...(PATCH_NOTES[0].fixed ?? [])]) {
        expect(first?.textContent).toContain(line);
      }
      expect(hasUnseenPatchNotes()).toBe(false);
    });

    it("keeps the keys from the game while it is open; Escape closes it", () => {
      const game = vi.fn();
      window.addEventListener("keydown", game);
      const press = (key: string): void => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      };
      try {
        openPatchNotes();
        press("Enter");
        expect(game).not.toHaveBeenCalled();

        press("Escape");
        expect(document.getElementById("coopPatchNotesPanel")).toBeNull();
        press("Enter");
        expect(game).toHaveBeenCalledOnce();
      } finally {
        window.removeEventListener("keydown", game);
      }
    });
  });

  describe("the title screen's line", () => {
    let phaserGame: Phaser.Game;

    beforeAll(() => {
      phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
    });

    beforeEach(() => {
      new GameManager(phaserGame);
      localStorage.removeItem("coopPatchNotesSeen");
    });

    afterEach(() => {
      closePatchNotes();
      localStorage.removeItem("coopPatchNotesSeen");
      vi.restoreAllMocks();
    });

    it("says Patch Notes in pale gold while the newest update is unread; a click opens the list and turns it white", () => {
      // (the mock text keeps no listener: the click is caught here)
      let click: (() => void) | undefined;
      vi.spyOn(MockText.prototype, "on").mockImplementation((event: string | symbol, listener: () => void) => {
        if (event === "pointerup") {
          click = listener;
        }
      });
      const container = globalScene.add.container(0, 0);
      // (and keeps no text it is made with: the label is read from the call)
      const made = vi.spyOn(globalScene.add, "text");

      const link = addPatchNotesLink(container, 2, 158) as unknown as MockText;

      expect(made).toHaveBeenCalledWith(2, 158, "Patch Notes", expect.anything());
      expect(link.color).toBe(getTextColor(TextStyle.MONEY));
      click?.();
      expect(document.getElementById("coopPatchNotesPanel")).not.toBeNull();
      expect(link.color).toBe(getTextColor(TextStyle.MESSAGE));
    });
  });
});
