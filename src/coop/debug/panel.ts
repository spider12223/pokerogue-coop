/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import type { DebugAction } from "#coop/debug/actions";
import { button, el, t, useDocument } from "#coop/debug/dom";
import { liveColumn, liveSignature, party, runInfo } from "#coop/debug/live";
import {
  cancelDebugChange,
  type DebugChange,
  debugChanges,
  debugSendsNow,
  onDebugQueue,
  waitingDebug,
} from "#coop/debug/queue";
import { quickBar, SECTION_LABELS, searchBlocks, sectionBlocks } from "#coop/debug/sections";
import { onRedraw, SECTIONS, type SectionId, view } from "#coop/debug/view";
import { type DebugSurface, disconnectDebugWindow, openDebugOverlay, openDebugWindow } from "#coop/debug/window";
import { getCoopSession } from "#coop/session";
import { Button } from "#enums/buttons";
import { Device } from "#enums/devices";
import { UiMode } from "#enums/ui-mode";
import { getButtonWithKeycode } from "#inputs/config-handler";
import { PokemonHeldItemModifier } from "#modifiers/modifier";

/**
 * The host's debug menu (DECISIONS D42, amended): a window of its own that the debug key (F8 at first) opens beside the game,
 * connected to it. Left, both teams and the field, live; in the middle, the quick buttons and five sections whose every
 * control makes its change in one step; right, the change log: what waits for the next turn (it can be taken back) and
 * what was applied, and where. A browser that blocks the window gets the same as a large panel over the game. Only the
 * host of a run with the menu on has it; the guests see no window and no notice, only what changes.
 * @module
 */

interface Parts {
  surface: DebugSurface;
  top: HTMLElement;
  live: HTMLElement;
  search: HTMLInputElement;
  quick: HTMLElement;
  tabs: HTMLElement;
  body: HTMLElement;
  log: HTMLElement;
}

/** How often the live side is read from the game */
const TICK_MS = 400;

let parts: Parts | null = null;
let running = false;
let keyHooked = false;
let timer: ReturnType<typeof setInterval> | null = null;
let stopQueueListener: (() => void) | null = null;
let liveSig = "";
let mainSig = "";
/** The section waits to be drawn again until no box in it has the focus and no button is held down */
let mainDirty = false;
let liveDirty = false;
let pressing = false;
/** The changes the log has shown: a new one flashes once */
const seen = new Set<number>();
/** The roots that already listen for presses (the panel over the game is the same element each time) */
const hookedRoots = new WeakSet<HTMLElement>();

// #region Drawing

const present = (...nodes: (Node | null)[]): Node[] => nodes.filter((node): node is Node => node !== null);

/** @returns A string that changes when what the sections show changes (not each hit point: a battle redraws the live side) */
function mainSignature(): string {
  try {
    const session = getCoopSession();
    const battle = globalScene.currentBattle;
    let field: unknown[] = [];
    try {
      field = globalScene
        .getEnemyField()
        .map(enemy => [enemy?.id, enemy?.level, enemy?.isActive(true), enemy?.bossSegments]);
    } catch {
      field = [];
    }
    return JSON.stringify([
      battle?.waveIndex,
      party().map(pokemon => [
        pokemon.id,
        pokemon.species.speciesId,
        pokemon.fusionSpecies?.speciesId,
        pokemon.level,
        pokemon.nature,
        pokemon.shiny,
        pokemon.variant,
        pokemon.gender,
        pokemon.teraType,
        pokemon.friendship,
        pokemon.ivs,
        pokemon.isOnField(),
        pokemon.moveset.map(move => move?.moveId),
        session?.ownership.get(pokemon.id),
      ]),
      globalScene
        .findModifiers(modifier => modifier instanceof PokemonHeldItemModifier)
        .map(modifier => [modifier.type.id, modifier.stackCount]),
      globalScene.modifiers?.length,
      field,
      session?.debugState,
      globalScene.money,
      globalScene.pokeballCounts,
      globalScene.arena?.weather?.weatherType,
      globalScene.arena?.terrain?.terrainType,
      debugSendsNow(),
    ]);
  } catch {
    return "";
  }
}

function drawTop(): void {
  if (parts === null) {
    return;
  }
  const info = runInfo();
  const waiting = debugChanges().filter(entry => entry.state === "pending").length;
  const pill = el(
    "span",
    `cdw-pill${waiting > 0 ? " cdw-on" : ""}`,
    waiting === 0
      ? t("NothingPending", "Nothing pending")
      : debugSendsNow()
        ? t("PendingNow", "{{n}} pending · sent now", { n: waiting })
        : t("PendingTurn", "{{n}} pending · next turn", { n: waiting }),
  );
  const close = button("×", () => closePanel(), "cdw-close");
  close.title = t("Close", "Close");
  parts.top.replaceChildren(
    ...present(
      el("span", "cdw-brand", t("Brand", "Debug")),
      parts.surface.kind === "window" ? el("span", "cdw-conn", t("Connected", "Connected to your game")) : null,
      el("span", "cdw-stat", t("WaveStat", "Wave "), el("b", "", String(info.wave))),
      info.biome === "" ? null : el("span", "cdw-stat", info.biome),
      el("span", "cdw-stat", "₽ ", el("b", "", info.money.toLocaleString())),
      el("span", "cdw-stat", t("TurnStat", "Turn "), el("b", "", String(info.turn))),
      el("span", "cdw-spacer"),
      pill,
      close,
    ),
  );
}

function drawLive(): void {
  if (parts === null) {
    return;
  }
  if (pressing) {
    liveDirty = true;
    return;
  }
  liveDirty = false;
  parts.live.replaceChildren(
    ...liveColumn(
      pokemon => {
        view.selected = pokemon.id;
        showSection("pokemon");
      },
      () => showSection("enemies"),
    ),
  );
}

function whenText(entry: DebugChange): string {
  if (entry.state === "pending") {
    return debugSendsNow() ? t("WhenNow", "goes now") : t("WhenTurn", "next turn");
  }
  if (entry.state === "sent") {
    return t("WhenSent", "sending…");
  }
  const where = entry.where;
  if (where === null) {
    return "";
  }
  return where.turn === null
    ? t("WhereReward", "wave {{wave}}, reward screen", { wave: where.wave })
    : t("WhereTurn", "wave {{wave}}, turn {{turn}}", { wave: where.wave, turn: where.turn });
}

function describe(actions: readonly DebugAction[]): string {
  return actions.map(action => action.t).join(", ");
}

function logEntry(entry: DebugChange): HTMLElement {
  const icon = entry.state === "applied" ? "✓" : entry.state === "sent" ? "↗" : "⧗";
  const node = el(
    "div",
    `cdw-entry cdw-${entry.state}${seen.has(entry.id * 10 + (entry.state === "applied" ? 1 : 0)) ? "" : " cdw-new"}`,
    el("span", "cdw-ico", icon),
    el("span", "", entry.note === "" ? describe(entry.actions) : entry.note, el("small", "", whenText(entry))),
    entry.state === "pending"
      ? (() => {
          const x = button("×", () => cancelDebugChange(entry.id), "cdw-x");
          x.title = t("Cancel", "Take it back");
          return x;
        })()
      : el("span"),
  );
  seen.add(entry.id * 10 + (entry.state === "applied" ? 1 : 0));
  return node;
}

function drawLog(): void {
  if (parts === null) {
    return;
  }
  const changes = debugChanges();
  const waiting = changes.filter(entry => entry.state !== "applied");
  const applied = changes.filter(entry => entry.state === "applied").reverse();
  parts.log.replaceChildren(
    el("div", "cdw-h", t("PendingHeading", "Pending"), el("small", "", String(waiting.length))),
    el(
      "div",
      "cdw-list",
      ...(waiting.length === 0
        ? [el("div", "cdw-empty", t("NoneWaiting", "Nothing waiting."))]
        : waiting.map(logEntry)),
    ),
    el("div", "cdw-gap"),
    el("div", "cdw-h", t("AppliedHeading", "Applied")),
    el(
      "div",
      "cdw-list",
      ...(applied.length === 0 ? [el("div", "cdw-empty", t("NoneApplied", "Nothing yet."))] : applied.map(logEntry)),
    ),
    el(
      "div",
      "cdw-foot",
      el(
        "div",
        "cdw-note",
        t(
          "LogNote",
          "Changes land at the start of the next turn, or at once on a reward screen. Your partner only sees what changes.",
        ),
      ),
    ),
  );
}

/** The element with the focus in the section, if it is a box someone types in */
function typingIn(container: HTMLElement): HTMLElement | null {
  const active = parts?.surface.doc.activeElement as HTMLElement | null | undefined;
  if (active == null || !container.contains(active)) {
    return null;
  }
  return active.tagName === "INPUT" || active.tagName === "SELECT" || active.tagName === "TEXTAREA" ? active : null;
}

/**
 * Draw the quick buttons, the tabs and the section again.
 * @param force - Even while a box of it has the focus (the box with the same `data-keep` gets it back)
 */
function drawMain(force: boolean): void {
  if (parts === null) {
    return;
  }
  const typing = typingIn(parts.body) ?? typingIn(parts.quick);
  if (!force && (typing !== null || pressing)) {
    mainDirty = true;
    return;
  }
  mainDirty = false;
  mainSig = mainSignature();
  const keep = typing?.dataset["keep"] ?? null;
  const scroll = parts.body.parentElement?.scrollTop ?? 0;
  const labels = SECTION_LABELS();
  try {
    parts.quick.replaceChildren(quickBar());
    parts.tabs.replaceChildren(
      ...SECTIONS.map(id =>
        button(
          labels[id],
          () => {
            view.search = "";
            parts!.search.value = "";
            showSection(id);
          },
          id === view.section && view.search.trim() === "" ? "cdw-on" : "",
        ),
      ),
    );
    parts.body.replaceChildren(
      ...(view.search.trim() === "" ? sectionBlocks(view.section) : searchBlocks(view.search)),
    );
  } catch (error) {
    console.error("co-op debug: the window could not be drawn", error);
    parts.body.replaceChildren(
      el("div", "cdw-note", t("DrawError", "This section could not be drawn: {{e}}", { e: String(error) })),
    );
  }
  if (parts.body.parentElement !== null) {
    parts.body.parentElement.scrollTop = scroll;
  }
  if (keep !== null) {
    const again = parts.body.querySelector<HTMLElement>(`[data-keep="${keep}"]`);
    again?.focus();
  }
}

function flushMain(): void {
  if (mainDirty) {
    drawMain(false);
  }
  if (liveDirty) {
    drawLive();
  }
}

function drawAll(): void {
  drawTop();
  drawLive();
  drawLog();
  drawMain(true);
}

function showSection(section: SectionId): void {
  view.section = section;
  drawMain(true);
  drawLive();
}

// #endregion

// #region The window

function build(surface: DebugSurface): Parts {
  useDocument(surface.doc);
  const root = surface.root;
  const top = el("header", "cdw-top");
  const live = el("aside", "cdw-col cdw-live");
  const search = el("input", "cdw-search");
  search.type = "search";
  search.placeholder = t("Search", "Search everything: try “leftovers”, “level”, “rain”, “wave”");
  search.value = view.search;
  search.addEventListener("input", () => {
    view.search = search.value;
    drawMain(true);
  });
  const quick = el("div", "");
  const tabs = el("nav", "cdw-tabs");
  const body = el("div", "");
  const main = el("main", "cdw-col cdw-main", search, quick, tabs, body);
  const log = el("aside", "cdw-col cdw-log");
  root.replaceChildren(
    ...present(
      top,
      surface.kind === "overlay"
        ? el(
            "div",
            "cdw-blocked",
            t(
              "Blocked",
              "Your browser blocked the debug window, so it opened here. Allow pop-ups for this site to get it as its own window.",
            ),
          )
        : null,
      el("div", "cdw-cols", live, main, log),
    ),
  );
  // What waited for a box to be left, or a button to be let go, is drawn then
  main.addEventListener("focusout", () => setTimeout(flushMain, 0));
  if (!hookedRoots.has(root)) {
    hookedRoots.add(root);
    root.addEventListener("pointerdown", () => {
      pressing = true;
    });
    const release = (): void => {
      pressing = false;
      setTimeout(flushMain, 0);
    };
    root.addEventListener("pointerup", release);
    root.addEventListener("pointercancel", release);
    root.addEventListener("pointerleave", release);
  }
  if (surface.kind === "window") {
    // The debug key in the window brings the game forward (where the browser lets it)
    surface.doc.addEventListener("keydown", event => {
      if (isDebugKey(event)) {
        event.preventDefault();
        try {
          window.focus();
        } catch {
          // (the browser keeps the window in front)
        }
      }
    });
  }
  return { surface, top, live, search, quick, tabs, body, log };
}

function tick(): void {
  if (parts === null) {
    return;
  }
  if (parts.surface.isGone()) {
    // The host closed the window
    stopTimer();
    parts = null;
    return;
  }
  const live = liveSignature();
  if (live !== liveSig) {
    liveSig = live;
    drawTop();
    drawLive();
  }
  const main = mainSignature();
  if (main !== mainSig) {
    mainDirty = true;
  }
  flushMain();
}

function startTimer(): void {
  stopTimer();
  timer = setInterval(tick, TICK_MS);
}

function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Whatever the game thinks is held stays held otherwise: the window takes the keyboard */
function releaseGameKeys(): void {
  try {
    globalScene.inputController?.loseFocus();
  } catch {
    // no game (a test page)
  }
}

function openPanel(): void {
  const surface =
    openDebugWindow(t("WindowTitle", "Debug · PokeRogue Co-op"), () =>
      t("Gone", "Disconnected. Press F8 in the game to reconnect."),
    )
    ?? openDebugOverlay(event => {
      if (event.key === "Escape") {
        closePanel();
      }
    }, releaseGameKeys);
  parts = build(surface);
  releaseGameKeys();
  liveSig = liveSignature();
  drawAll();
  startTimer();
}

function closePanel(): void {
  stopTimer();
  parts?.surface.close();
  parts = null;
}

/** The debug key: open the window (or bring it forward); the panel over the game closes on it */
function pressDebugKey(): void {
  if (!running) {
    return;
  }
  if (parts !== null && !parts.surface.isGone()) {
    if (parts.surface.kind === "window") {
      parts.surface.focus();
    } else {
      closePanel();
    }
    return;
  }
  openPanel();
}

// #endregion

// #region The key

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement
    && (target.isContentEditable
      || target.tagName === "INPUT"
      || target.tagName === "TEXTAREA"
      || target.tagName === "SELECT")
  );
}

/** Whether the key is the one bound to the debug menu ("Co-op: debug menu", F8 at first) */
function isDebugKey(event: KeyboardEvent): boolean {
  try {
    const controller = globalScene.inputController;
    controller?.ensureKeyboardIsInit();
    const config = controller?.getActiveConfig(Device.KEYBOARD);
    return config != null && getButtonWithKeycode(config, event.keyCode) === Button.COOP_DEBUG;
  } catch {
    return false;
  }
}

function onDebugKey(event: KeyboardEvent): void {
  const inPanel =
    event.target instanceof Node && parts?.surface.kind === "overlay" && parts.surface.root.contains(event.target);
  if (
    !running
    || event.type !== "keydown"
    || event.repeat
    || event.ctrlKey
    || event.metaKey
    || event.altKey
    || (isTyping(event.target) && !inPanel)
    || globalScene.ui?.mode === UiMode.KEYBOARD_BINDING
    || !isDebugKey(event)
  ) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  pressDebugKey();
}

// #endregion

/** The host of a run with the menu on: the key opens the window for the whole session */
export function startDebugPanel(): void {
  if (typeof document === "undefined") {
    return;
  }
  stopQueueListener?.();
  running = true;
  if (!keyHooked) {
    keyHooked = true;
    window.addEventListener("keydown", onDebugKey, true);
  }
  view.section = "pokemon";
  view.selected = null;
  view.search = "";
  view.itemSearch = "";
  view.planWave = 0;
  seen.clear();
  onRedraw(() => drawMain(true));
  stopQueueListener = onDebugQueue(() => {
    drawLog();
    drawTop();
    mainDirty = true;
    setTimeout(flushMain, 0);
  });
  if (parts !== null && !parts.surface.isGone()) {
    // (a window still open from before: it shows this run)
    drawAll();
    startTimer();
  }
}

/** The session is over: the window says so, the panel over the game goes */
export function stopDebugPanel(): void {
  stopQueueListener?.();
  stopQueueListener = null;
  running = false;
  stopTimer();
  if (parts !== null) {
    if (parts.surface.kind === "window") {
      disconnectDebugWindow(t("Ended", "The co-op run ended. Press F8 in the next run to connect again."));
    } else {
      parts.surface.close();
    }
    parts = null;
  }
}

/** The debug key, as a press of it */
export function toggleDebugPanel(): void {
  pressDebugKey();
}

/** What the debug API and the tests read */
export function debugPanelInfo(): {
  open: boolean;
  kind: "window" | "overlay" | null;
  section: SectionId;
  waiting: number;
  changes: number;
} | null {
  if (!running) {
    return null;
  }
  const open = parts !== null && !parts.surface.isGone();
  return {
    open,
    kind: open ? parts!.surface.kind : null,
    section: view.section,
    waiting: waitingDebug().length,
    changes: debugChanges().length,
  };
}

/** The tests and the debug API switch sections as a click does */
export function showDebugSection(section: SectionId): void {
  view.search = "";
  if (parts !== null) {
    parts.search.value = "";
  }
  showSection(section);
}
