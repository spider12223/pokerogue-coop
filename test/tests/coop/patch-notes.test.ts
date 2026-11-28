/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { closePatchNotes, hasUnseenPatchNotes, installPatchNotes, openPatchNotes } from "#coop/ui/patch-notes";
import { PATCH_NOTES } from "#coop/ui/patch-notes-list";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Patch Notes (D50): an entry per update, newest first, and the page's button that opens them */
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

  describe("the button", () => {
    let button: HTMLButtonElement;

    beforeEach(() => {
      localStorage.removeItem("coopPatchNotesSeen");
      button = document.createElement("button");
      button.id = "coopPatchNotes";
      button.hidden = true;
      document.body.append(button);
      installPatchNotes();
    });

    afterEach(() => {
      closePatchNotes();
      button.remove();
      localStorage.removeItem("coopPatchNotesSeen");
    });

    it("says Patch Notes, and is marked while the newest update has not been opened", () => {
      expect(button.hidden).toBe(false);
      expect(button.textContent).toBe("Patch Notes");
      expect(hasUnseenPatchNotes()).toBe(true);
      expect(button.classList.contains("coop-patch-notes-unseen")).toBe(true);
    });

    it("opens the updates, newest first; opening them takes the mark away", () => {
      button.click();

      const first = document.getElementById("coopPatchNotesPanel")?.querySelector("section");
      for (const line of [...(PATCH_NOTES[0].new ?? []), ...(PATCH_NOTES[0].fixed ?? [])]) {
        expect(first?.textContent).toContain(line);
      }
      expect(hasUnseenPatchNotes()).toBe(false);
      expect(button.classList.contains("coop-patch-notes-unseen")).toBe(false);
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
});
