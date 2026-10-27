/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { keyId } from "#coop/protocol";
import { reconnectScreenText } from "#coop/reconnect-ui";
import { getCoopSession } from "#coop/session";
import { UiMode } from "#enums/ui-mode";

/**
 * Dev-only stall detector (for flaky end-to-end runs). If the phase trace has not advanced for a while, this client
 * writes down where it is: the phase, the UI mode, the open decision window and the last phases. Reading the dumps of
 * both clients says whether a stalled run is the bot or the game: a client that waits for its partner's decision has
 * the key in its window, one that waits for nothing is stuck.
 *
 * Only `src/coop/debug-api.ts` imports this, and that module only exists in dev and test builds, so none of it is in a
 * production build. It reads the game and never changes it.
 *
 * @module
 */

export interface StallDump {
  /**
   * `no-progress`: nothing happened for {@linkcode StallOptions.noProgressMs} and no decision is pending, so the game waits for
   * nothing; `pending`: it waits for a decision for {@linkcode StallOptions.pendingMs} (the partner's, or this player's own
   * screen that does not move on)
   */
  kind: "no-progress" | "pending";
  stalledMs: number;
  seat: string;
  phase: string | null;
  wave: number;
  turn: number;
  ui: string;
  /** The text box waits for a button */
  messageAwaiting: boolean;
  /** ... and has what to do when it gets one (a prompt that is armed but dead has `messageAwaiting` and no handler) */
  messageHasHandler: boolean;
  /** What the text box shows */
  messageText: string;
  /** The typing of the text: `null` if there is none, else how far it got (a paused or removed timer never finishes the prompt) */
  textTimer: { paused: boolean; repeatCount: number; repeat: number; removed: boolean } | null;
  pendingPrompt: boolean;
  /** The UI blocks input: a fade that was started and never finished */
  overlayActive: boolean;
  /** A tutorial window takes the input */
  tutorialActive: boolean;
  /** The class of the handler of the current mode, and the modes the UI would go back to */
  handler: string;
  modeChain: string[];
  /** The last calls that showed text or changed the mode, newest last: `ms since the stall detector started: what` */
  uiCalls: string[];
  /** Whether the game loop runs: the frame it is at and its rate, and whether the page counts as visible */
  loop: { frame: number; fps: number; visibility: string };
  /** The open decision window, as `wave:turn:KIND:ref` */
  window: string[];
  /** The last phases that started, as `index:wave:turn:phase` */
  trace: string[];
}

export interface StallOptions {
  /** How often the trace is looked at. Default 1 s. */
  intervalMs?: number;
  /** No progress and no pending decision for this long is a stall. Default 20 s. */
  noProgressMs?: number;
  /** No progress with a decision pending for this long is worth a dump too. Default 45 s. */
  pendingMs?: number;
  /** How many phases the dump keeps. Default 30. */
  traceLength?: number;
}

/** What the detector found, for the debug API and the end-to-end report */
export const stalls: StallDump[] = [];

/** The last calls of `ui.showText`, `ui.setMode` and the like (dev builds): what a dead prompt was shown and replaced by */
const uiCalls: string[] = [];
const UI_CALLS_KEPT = 24;
let wrapped = false;
const startedAt = Date.now();

function note(what: string): void {
  uiCalls.push(`${Date.now() - startedAt}: ${what}`);
  if (uiCalls.length > UI_CALLS_KEPT) {
    uiCalls.shift();
  }
}

/** Wrap the UI methods that decide what the text box and the mode do, once the UI exists. They only write down the call. */
function wrapUi(): void {
  const ui = globalScene?.ui as unknown as Record<string, unknown> | undefined;
  if (wrapped || ui === undefined) {
    return;
  }
  wrapped = true;
  const modeName = (mode: unknown): string => UiMode[mode as number] ?? String(mode);
  for (const name of ["setMode", "setModeWithoutClear", "setOverlayMode", "setModeForceTransition", "revertMode"]) {
    const original = ui[name] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof original !== "function") {
      continue;
    }
    ui[name] = function (this: unknown, ...args: unknown[]) {
      note(
        `${name}(${typeof args[0] === "number" ? modeName(args[0]) : ""}) from ${modeName((ui as { mode?: unknown }).mode)}`,
      );
      return original.apply(this, args);
    };
  }
  for (const name of ["fadeOut", "fadeIn"]) {
    const original = ui[name] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof original === "function") {
      ui[name] = function (this: unknown, ...args: unknown[]) {
        note(`${name}(${String(args[0])}) overlayActive=${String((ui as { overlayActive?: unknown }).overlayActive)}`);
        return original.apply(this, args);
      };
    }
  }
  const showText = ui["showText"] as ((...args: unknown[]) => unknown) | undefined;
  if (typeof showText === "function") {
    ui["showText"] = function (this: unknown, ...args: unknown[]) {
      note(`showText(prompt=${String(args[4])}, cb=${typeof args[2] === "function"}) ${String(args[0]).slice(0, 60)}`);
      return showText.apply(this, args);
    };
  }
  const clearText = ui["clearText"] as ((...args: unknown[]) => unknown) | undefined;
  if (typeof clearText === "function") {
    ui["clearText"] = function (this: unknown, ...args: unknown[]) {
      note("clearText()");
      return clearText.apply(this, args);
    };
  }
}

function describeNow(kind: StallDump["kind"], stalledMs: number, traceLength: number): StallDump | null {
  const session = getCoopSession();
  if (session === null || globalScene?.phaseManager == null) {
    return null;
  }
  const phase = globalScene.phaseManager.getCurrentPhase();
  const ui = globalScene.ui as unknown as { overlayActive?: boolean; _modeChain?: number[] } | undefined;
  const messageHandler = globalScene.ui?.getMessageHandler?.() as unknown as
    | {
        awaitingActionInput?: boolean;
        onActionInput?: unknown;
        message?: { text?: string };
        textTimer?: { paused?: boolean; repeatCount?: number; repeat?: number; hasDispatched?: boolean } | null;
        pendingPrompt?: boolean;
      }
    | undefined;
  const timer = messageHandler?.textTimer;
  const handler = globalScene.ui?.getHandler?.() as unknown as { tutorialActive?: boolean } | undefined;
  return {
    kind,
    stalledMs: Math.round(stalledMs),
    seat: session.seat,
    phase: phase?.phaseName ?? null,
    wave: globalScene.currentBattle?.waveIndex ?? 0,
    turn: globalScene.currentBattle?.turn ?? 0,
    ui: globalScene.ui == null ? "NONE" : (UiMode[globalScene.ui.mode] ?? String(globalScene.ui.mode)),
    messageAwaiting: messageHandler?.awaitingActionInput === true,
    messageHasHandler: typeof messageHandler?.onActionInput === "function",
    messageText: String(messageHandler?.message?.text ?? "").slice(0, 200),
    textTimer:
      timer == null
        ? null
        : {
            paused: timer.paused === true,
            repeatCount: timer.repeatCount ?? -1,
            repeat: timer.repeat ?? -1,
            removed: timer.hasDispatched === true,
          },
    pendingPrompt: messageHandler?.pendingPrompt === true,
    overlayActive: ui?.overlayActive === true,
    tutorialActive: handler?.tutorialActive === true,
    handler: handler?.constructor?.name ?? "none",
    modeChain: (ui?._modeChain ?? []).map(mode => UiMode[mode] ?? String(mode)),
    uiCalls: [...uiCalls],
    loop: {
      frame: (globalScene.game as unknown as { loop?: { frame?: number } }).loop?.frame ?? -1,
      fps: Math.round((globalScene.game as unknown as { loop?: { actualFps?: number } }).loop?.actualFps ?? -1),
      visibility: typeof document === "undefined" ? "none" : document.visibilityState,
    },
    window: session.openWindow.map(keyId),
    trace: session.trace
      .dump()
      .slice(-traceLength)
      .map(entry => `${entry.index}:${entry.wave}:${entry.turn}:${entry.phaseName}`),
  };
}

/**
 * Start watching. Each stall is dumped once (to {@linkcode stalls} and the console) until the trace moves again.
 * @returns A function that stops the watch
 */
export function startStallDetector(options: StallOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? 1000;
  const noProgressMs = options.noProgressMs ?? 20_000;
  const pendingMs = options.pendingMs ?? 45_000;
  const traceLength = options.traceLength ?? 30;
  let lastTotal = -1;
  let lastMoved = Date.now();
  const reported = new Set<StallDump["kind"]>();
  wrapUi();
  const timer = setInterval(() => {
    wrapUi();
    const session = getCoopSession();
    const now = Date.now();
    if (session === null) {
      lastTotal = -1;
      return;
    }
    const total = session.trace.total;
    if (total !== lastTotal || reconnectScreenText() !== null) {
      // (a game that waits for its partner to come back, on the waiting screen, is not stalled)
      lastTotal = total;
      lastMoved = now;
      reported.clear();
      return;
    }
    const stalledMs = now - lastMoved;
    const pending = session.openWindow.length > 0;
    const kind = pending ? "pending" : "no-progress";
    const limit = pending ? pendingMs : noProgressMs;
    if (stalledMs < limit || reported.has(kind)) {
      return;
    }
    const dump = describeNow(kind, stalledMs, traceLength);
    if (dump !== null) {
      reported.add(kind);
      stalls.push(dump);
      console.warn(`co-op stall: ${JSON.stringify(dump)}`);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
