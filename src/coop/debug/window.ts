/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { debugStyles, debugWindowPage } from "#coop/debug/styles";

/**
 * Where the host's debug window (DECISIONS D42) shows: a browser window of its own, which this page opens on the debug key
 * and draws into (the game keeps running beside it), or, when the browser blocks it, a large panel over the game. The
 * window is a page of the same site with nothing of its own: when the game's page goes, it says so, and the debug key of the
 * next page takes it back.
 * @module
 */

const WINDOW_NAME = "pokerogueCoopDebug";
const ROOT_ID = "coopDebug";
const STYLE_ID = "coopDebugStyle";

export interface DebugSurface {
  readonly kind: "window" | "overlay";
  readonly doc: Document;
  /** The element the window is drawn in */
  readonly root: HTMLElement;
  /** Show it in front (the window), or nothing (the panel already is) */
  focus(): void;
  /** Close the window, or hide the panel */
  close(): void;
  /** Whether the player closed it */
  isGone(): boolean;
}

let popup: Window | null = null;
let overlay: HTMLElement | null = null;
let hooked = false;

function fontUrl(): string {
  return new URL("./fonts/pokemon-emerald-pro.ttf", document.baseURI).href;
}

function addStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID) !== null) {
    return;
  }
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = debugStyles(fontUrl());
  doc.head.append(style);
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);

/** The window says it lost the game, and how to get it back */
function leaveMessage(text: string): void {
  if (popup === null || popup.closed) {
    return;
  }
  try {
    const doc = popup.document;
    doc.getElementById(`${ROOT_ID}Gone`)?.remove();
    const box = doc.createElement("div");
    box.id = `${ROOT_ID}Gone`;
    box.className = "cdw-disconnected";
    const line = doc.createElement("div");
    line.textContent = text;
    box.append(line);
    doc.body.append(box);
  } catch {
    // (the window is no longer ours to write to)
  }
}

/** Say in the window that it is no longer connected, e.g. the run is over */
export function disconnectDebugWindow(text: string): void {
  leaveMessage(text);
}

/** The game's page goes (a reload): the window says so */
function hookPageLeave(text: () => string): void {
  if (hooked) {
    return;
  }
  hooked = true;
  window.addEventListener("pagehide", () => leaveMessage(text()));
}

/**
 * Open the debug window: a browser window of its own (a new one, or the one an earlier page of the game left open, drawn
 * anew). Call it from the key press: a browser opens a window only for one.
 * @param title - The window's title
 * @param goneText - What it says once the game's page is gone
 * @returns Where to draw, or `null` if the browser would not open a window
 */
export function openDebugWindow(title: string, goneText: () => string): DebugSurface | null {
  let win: Window | null = null;
  try {
    win = window.open("", WINDOW_NAME, "popup=yes,width=1340,height=900");
  } catch {
    win = null;
  }
  if (win === null || win === undefined) {
    return null;
  }
  const doc = win.document;
  // (a page of its own, written anew: an earlier page of the game may have left one)
  doc.open();
  doc.write(debugWindowPage(escapeHtml(title)));
  doc.close();
  addStyles(doc);
  const root = doc.createElement("div");
  root.id = ROOT_ID;
  root.className = "cdw-root cdw-window";
  doc.body.append(root);
  popup = win;
  hookPageLeave(goneText);
  const opened = win;
  try {
    opened.focus();
  } catch {
    // (some browsers keep the focus where it is)
  }
  return {
    kind: "window",
    doc,
    root,
    focus: () => {
      try {
        opened.focus();
      } catch {
        // as above
      }
    },
    close: () => {
      try {
        opened.close();
      } catch {
        // (already closed)
      }
    },
    isGone: () => opened.closed,
  };
}

/**
 * The panel over the game, for a browser that blocks the window.
 * @param onKey - Every key pressed in it (the game hears none of them)
 */
export function openDebugOverlay(onKey: (event: KeyboardEvent) => void, onFocus: () => void): DebugSurface {
  addStyles(document);
  if (overlay === null) {
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.className = "cdw-root cdw-overlay";
    for (const type of ["keydown", "keyup", "keypress"] as const) {
      root.addEventListener(type, event => {
        if (type === "keydown") {
          onKey(event);
        }
        event.stopPropagation();
      });
    }
    root.addEventListener("focusin", () => onFocus());
    document.body.append(root);
    overlay = root;
  }
  const root = overlay;
  root.hidden = false;
  return {
    kind: "overlay",
    doc: document,
    root,
    focus: () => {},
    close: () => {
      root.hidden = true;
      if (root.contains(document.activeElement)) {
        (document.activeElement as HTMLElement).blur();
      }
    },
    isGone: () => root.hidden === true,
  };
}
