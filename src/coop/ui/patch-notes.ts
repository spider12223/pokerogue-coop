/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PATCH_NOTES, type PatchNote } from "#coop/ui/patch-notes-list";
import { coopText } from "#coop/ui/text";

/**
 * Patch Notes (D50): a button of the page (`#coopPatchNotes` in `index.html`), at the bottom left of the title screen,
 * that opens what each update brought, newest first. It is yellow while this browser has not opened the newest update.
 * While the list is open the game hears no key.
 * @module
 */

const BUTTON_ID = "coopPatchNotes";
const PANEL_ID = "coopPatchNotesPanel";
/** The newest update as this browser last opened it (its text: lines added to it on the same day make it new again) */
const SEEN_KEY = "coopPatchNotesSeen";
const UNSEEN_CLASS = "coop-patch-notes-unseen";
const KEY_EVENTS = ["keydown", "keyup", "keypress"] as const;

const SECTIONS = [
  ["new", "patchNotesNew", "New"],
  ["changed", "patchNotesChanged", "Changed"],
  ["fixed", "patchNotesFixed", "Fixed"],
] as const;

/** The open list (its backdrop), if any */
let panel: HTMLElement | null = null;

const newestKey = (): string => JSON.stringify(PATCH_NOTES[0] ?? null);

/** @returns Whether this browser has not opened the newest update yet (`false` without storage) */
export function hasUnseenPatchNotes(): boolean {
  if (PATCH_NOTES.length === 0) {
    return false;
  }
  try {
    return localStorage.getItem(SEEN_KEY) !== newestKey();
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, newestKey());
  } catch {
    // (no storage: nothing to remember)
  }
  document.getElementById(BUTTON_ID)?.classList.remove(UNSEEN_CLASS);
}

/** Wire the page's button (once, at start) */
export function installPatchNotes(): void {
  const button = document.getElementById(BUTTON_ID);
  if (button === null || button.dataset.ready === "1") {
    return;
  }
  button.dataset.ready = "1";
  button.textContent = coopText("patchNotes", "Patch Notes");
  button.classList.toggle(UNSEEN_CLASS, hasUnseenPatchNotes());
  button.addEventListener("click", openPatchNotes);
  button.hidden = false;
}

/** Open the list; a second call does nothing */
export function openPatchNotes(): void {
  if (panel !== null) {
    return;
  }
  const title = coopText("patchNotes", "Patch Notes");
  const backdrop = document.createElement("div");
  backdrop.id = PANEL_ID;
  const box = document.createElement("div");
  box.className = "coop-patch-notes-box";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", title);

  const header = document.createElement("div");
  header.className = "coop-patch-notes-header";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = coopText("patchNotesClose", "Close");
  close.addEventListener("click", closePatchNotes);
  header.append(heading, close);

  const list = document.createElement("div");
  list.className = "coop-patch-notes-list";
  list.tabIndex = 0;
  list.append(...PATCH_NOTES.map(noteElement));

  box.append(header, list);
  backdrop.append(box);
  // a click beside the window closes it
  backdrop.addEventListener("click", event => {
    if (event.target === backdrop) {
      closePatchNotes();
    }
  });
  document.body.append(backdrop);
  panel = backdrop;
  for (const type of KEY_EVENTS) {
    window.addEventListener(type, holdKeys, true);
  }
  close.focus();
  markSeen();
}

/** Close the list, if it is open: the keys go to the game again */
export function closePatchNotes(): void {
  if (panel === null) {
    return;
  }
  for (const type of KEY_EVENTS) {
    window.removeEventListener(type, holdKeys, true);
  }
  panel.remove();
  panel = null;
}

/** While the list is open no key reaches the game (it listens on the window, after this); Escape closes the list */
function holdKeys(event: KeyboardEvent): void {
  event.stopPropagation();
  if (event.type === "keydown" && event.key === "Escape") {
    event.preventDefault();
    closePatchNotes();
  }
}

function noteElement(note: PatchNote): HTMLElement {
  const section = document.createElement("section");
  const date = document.createElement("h3");
  date.textContent = formatDate(note.date);
  section.append(date);
  for (const [field, key, fallback] of SECTIONS) {
    const lines = note[field] ?? [];
    if (lines.length === 0) {
      continue;
    }
    const label = document.createElement("h4");
    label.className = `coop-patch-notes-label-${field}`;
    label.textContent = coopText(key, fallback);
    const items = document.createElement("ul");
    for (const line of lines) {
      const item = document.createElement("li");
      item.textContent = line;
      items.append(item);
    }
    section.append(label, items);
  }
  return section;
}

/** `2026-11-28` → "November 28, 2026", in the browser's language (that day, whatever the time zone; no clock is read) */
function formatDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const time = Date.UTC(year, month - 1, day);
  return Number.isNaN(time)
    ? date
    : new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(
        time,
      );
}
