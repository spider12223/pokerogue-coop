/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { gameSnapshot } from "#coop/coop-diagnostics";
import { coopLog } from "#coop/coop-log";
import { coopText } from "#coop/text";

/**
 * "Report a problem" (DECISIONS D26): a small button of the page (`#coopReport` in `index.html`), outside the game's
 * canvas, so that it works when the game does not answer any more. It asks what went wrong, writes that and a snapshot of
 * the game into the co-op log, sends the log to the server at once, and saves it as a file as well. It is shown while a
 * co-op session is on; the co-op menu of the title screen has the same entry, for after a reload.
 *
 * @module
 */

const BUTTON_ID = "coopReport";
/** How long the button says what happened before it reads "Report a problem" again */
const RESULT_MS = 4000;
/** How long a report waits for the server to take it; past that, the saved file is what to send */
export const SEND_TIMEOUT_MS = 6000;

/** What a report did: the server has it (`sent`), or only the file was saved (`saved`) */
export type ReportResult = "sent" | "saved";

/** Save the co-op log as a file, with a snapshot of the game and the player's note */
export function downloadCoopLog(note: string | null): void {
  if (typeof document === "undefined") {
    return;
  }
  const log = coopLog();
  const file = log.exportFile({ note, snapshot: gameSnapshot(true) });
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `coop-log-${log.sessionId}-${String(file["exportedAt"]).replace(/[:.]/g, "-")}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Report a problem: the note and a snapshot go into the log, a file is saved, and the log goes to the server now.
 * @param note - What the player says went wrong (`null` or empty: nothing)
 * @param saveFile - Also save the file (the end-to-end test does not)
 * @returns `sent` only if the server took this report (and everything before it) within {@linkcode SEND_TIMEOUT_MS}
 */
export async function reportProblem(note: string | null, saveFile = true): Promise<ReportResult> {
  const log = coopLog();
  const text = note?.trim() ?? "";
  log.report(text === "" ? "a problem was reported" : text.slice(0, 500), gameSnapshot(true));
  // The file first: it is what the player sends when the server does not get the report, and a slow network must not hold
  // it up
  if (saveFile) {
    downloadCoopLog(note);
  }
  return (await within(log.flush(), SEND_TIMEOUT_MS, false)) ? "sent" : "saved";
}

/** @returns What `promise` gives, or `fallback` if it takes longer than `ms` or fails */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Ask the player what went wrong, then report it; nothing happens if they cancel */
export async function askAndReport(): Promise<ReportResult | null> {
  const note =
    typeof window === "undefined"
      ? ""
      : window.prompt(coopText("reportPrompt", "What went wrong? (optional, it helps a lot)"), "");
  if (note === null) {
    return null;
  }
  return reportProblem(note);
}

let installed = false;

function install(button: HTMLElement): void {
  if (installed) {
    return;
  }
  installed = true;
  const label = coopText("reportButton", "Report a problem");
  button.textContent = label;
  button.addEventListener("click", () => {
    // The game's keys go to the page: a focused button would take the next Enter for itself
    button.blur();
    void askAndReport().then(result => {
      if (result === null) {
        return;
      }
      button.textContent =
        result === "sent"
          ? coopText("reportSent", "Report sent, and saved to your downloads")
          : coopText("reportSaved", "Saved to your downloads: please send the file");
      setTimeout(() => {
        button.textContent = label;
      }, RESULT_MS);
    });
  });
}

/** Show the button (a co-op session is on) or take it away */
export function setReportButtonVisible(visible: boolean): void {
  if (typeof document === "undefined") {
    return;
  }
  const button = document.getElementById(BUTTON_ID);
  if (button === null) {
    return;
  }
  install(button);
  button.hidden = !visible;
}
