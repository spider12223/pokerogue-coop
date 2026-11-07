/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { coopLog } from "#coop/diagnostics/coop-log";
import { type CoopSession, getCoopSession } from "#coop/session";
import { chatNote } from "#coop/ui/chat";
import { coopText } from "#coop/ui/text";

/**
 * A save the browser refuses in a co-op run (DECISIONS D19, amended after a player's report). A full storage first gives
 * the co-op log's copy up (diagnostics: the log goes on in memory and is still sent) to what the player keeps, and the save
 * is tried again. What still cannot be saved is told to the player and written to the co-op log, instead of being lost
 * without a word.
 *
 * @module
 */

/** What a player keeps that their browser can refuse to save: their account, or (the host's) the run */
export type CoopSaveKind = "account" | "run";

/** What each session has told its player already: once per session and kind, as every wave would say it again */
const told = new WeakMap<CoopSession, Set<CoopSaveKind>>();

/** @returns Whether a write failed because the browser's storage is full (the browsers name it their own ways) */
export function isStorageFull(error: unknown): boolean {
  if (typeof DOMException === "undefined" || !(error instanceof DOMException)) {
    return false;
  }
  return (
    error.name === "QuotaExceededError"
    || error.name === "NS_ERROR_DOM_QUOTA_REACHED"
    || error.code === 22
    || error.code === 1014
  );
}

/**
 * Make room in the browser's storage for what the player keeps: the co-op log gives its copy up for the rest of this page.
 * @returns Whether anything was freed: only then is a save worth trying again
 */
export function makeStorageRoom(): boolean {
  return coopLog().releaseStorage();
}

/**
 * @param full - Whether the storage was full (else the browser refused for another reason)
 * @param pageBreak - Between its two sentences: a space in the chat box, `$` (a new page) in the message box, which holds
 * two lines
 * @returns What the player is told when it could not be saved
 */
export function notSavedText(kind: CoopSaveKind, full = true, pageBreak = " "): string {
  if (kind === "run") {
    return [
      coopText("runNotSaved", "This run could not be saved: this browser's storage is full."),
      coopText("runNotSavedLater", "It can't be continued later."),
    ].join(pageBreak);
  }
  return [
    full
      ? coopText("accountNotSavedFull", "Your account could not be saved: this browser's storage is full.")
      : coopText("accountNotSaved", "Your account could not be saved in this browser."),
    coopText("accountNotSavedLost", "Your progress from this run is lost when the game closes."),
  ].join(pageBreak);
}

/**
 * Something the player keeps could not be saved: it goes to the co-op log every time, and to the chat box once per session
 * for each kind (a note does not stop the game, and the partner's game goes on).
 * @param text - What the player is told
 * @param msg - What the co-op log says
 */
export function reportNotSaved(kind: CoopSaveKind, text: string, msg: string, data?: Record<string, unknown>): void {
  coopLog().error("save", msg, data);
  const session = getCoopSession();
  if (session === null) {
    return;
  }
  let kinds = told.get(session);
  if (kinds === undefined) {
    kinds = new Set();
    told.set(session, kinds);
  }
  if (!kinds.has(kind)) {
    kinds.add(kind);
    chatNote(text);
  }
}

/**
 * Save this player's account (D19), never failing the caller: a full storage first makes room, and the save is tried
 * again. What the browser still refuses is reported ({@linkcode reportNotSaved}).
 * @returns Why the browser refused it, `"full"` (the storage is full) or `"refused"`: the chat box says so once per session,
 * and Save and Quit says it in the message box ({@linkcode notSavedText}), as the chat box goes with the session. `null`
 * when it was saved, or when the save's own check failed (upstream says so itself)
 */
export async function saveCoopAccount(): Promise<"full" | "refused" | null> {
  const { gameData } = globalScene;
  let error: unknown;
  try {
    await gameData.saveSystem();
    return null;
  } catch (refused) {
    error = refused;
  }
  if (isStorageFull(error) && makeStorageRoom()) {
    try {
      await gameData.saveSystem();
      coopLog().warn("save", "the account did not fit: the co-op log gave its copy up", { error: String(error) });
      return null;
    } catch (refused) {
      error = refused;
    }
  }
  const full = isStorageFull(error);
  console.warn("co-op: saving the account failed:", error);
  reportNotSaved("account", notSavedText("account", full), "the account could not be saved", { error: String(error) });
  return full ? "full" : "refused";
}
