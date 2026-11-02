/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { settings } from "#app/global-settings-manager";
import { coopLog } from "#coop/coop-log";
import type { CosmeticMessage, PaceAt } from "#coop/cosmetic";
import type { CoopLink } from "#coop/link";
import type { PacePosition, PromptRecord, PromptTicket } from "#coop/pace";
import { type CoopSession, getCoopSession } from "#coop/session";
import type { ExpGainsSpeed } from "#enums/exp-gains-speed";
import { GameSpeed } from "#enums/game-speed";
import type { HpBarSpeed } from "#enums/hp-bar-speed";
import { UiMode } from "#enums/ui-mode";
import type { DisplaySettings, GeneralSettings } from "#types/settings";
import type { AwaitableUiHandler } from "#ui/awaitable-ui-handler";

/**
 * The game's side of pacing (DECISIONS D27): the faster player leads the run's text.
 * - Each client tells the other where it is (the host's `pace` with its speeds, the guest's `at`), and closes a line by
 *   itself once the partner is past it (showing it at once while behind), so a player who looks away is never what the
 *   other waits for. A press on a line closes the partner's same line too. The guest follows the host's game speed.
 *
 * `MessageUiHandler.showPrompt` reports the lines that wait for a press ({@linkcode coopPromptOpened}); the tracker in the
 * session (`src/coop/pace.ts`) says whether they are shared and where they are.
 *
 * @module
 */

/** How often the guest looks whether it is behind (a level-up panel has no event of its own) */
const FOLLOW_MS = 250;
/**
 * How long the host goes without saying where it is. Every move says it at once, and so does the partner coming back, so
 * this only repairs a `pace` the relay dropped: it is rare, and a quiet screen costs no messages.
 */
const REPEAT_MS = 10_000;
/**
 * The phases of a move start in bursts: the host says where it is at once, then at most once per this many ms, with the
 * latest position (the guest looks whether it is behind every {@linkcode FOLLOW_MS} anyway)
 */
const COALESCE_MS = 150;

/** The settings the guest takes from the host while the run lasts */
const FOLLOWED_SETTINGS = [
  "gameSpeed",
  "expGainsSpeed",
  "hpBarSpeed",
  "hideIvScanner",
] as const satisfies readonly (keyof GeneralSettings)[];
const FOLLOWED_DISPLAY = [
  "enableMoveAnimations",
  "showStatsOnLevelUp",
] as const satisfies readonly (keyof DisplaySettings)[];

const GAME_SPEEDS: readonly number[] = Object.values(GameSpeed);

/** The modes whose message box shows the run's text: the battle's and the evolution scene's */
const TEXT_MODES: ReadonlySet<UiMode> = new Set([UiMode.MESSAGE, UiMode.EVOLUTION_SCENE]);

interface PaceStats {
  /** Lines and panels this client closed because the partner was past them */
  followed: number;
  /** Presses sent, and presses of the partner that closed this client's line */
  presses: number;
}

interface Pacer {
  readonly session: CoopSession;
  readonly link: CoopLink;
  /** The handler each open shared line is on */
  readonly handlers: Map<number, AwaitableUiHandler>;
  /** A question of this screen alone that gives way when this player is behind (the IV Scanner's) */
  onBehind: (() => void) | null;
  followsSettings: boolean;
  readonly stats: PaceStats;
  stop(): void;
}

let pacer: Pacer | null = null;
/** A line is being closed because the screen follows, not by a press of this player */
let following = false;

function activePacer(): Pacer | null {
  return pacer !== null && pacer.session === getCoopSession() ? pacer : null;
}

/**
 * `MessageUiHandler.showPrompt`: a line waits for a press.
 * @param handler - The handler that shows it
 * @param text - What it says
 * @returns Its ticket if both screens show it (pass it to {@linkcode coopPromptClosed}), else `null` (solo play too)
 */
export function coopPromptOpened(handler: AwaitableUiHandler, text: string): PromptTicket | null {
  const active = activePacer();
  if (active === null || globalScene.ui.getHandler() !== handler || !TEXT_MODES.has(globalScene.ui.mode)) {
    return null;
  }
  const ticket = active.session.pace.promptOpened(text);
  if (ticket !== null) {
    active.handlers.set(ticket.id, handler);
  }
  return ticket;
}

/** The line of `ticket` closed: by a press of this player, or because the screen follows */
export function coopPromptClosed(ticket: PromptTicket | null): void {
  const active = activePacer();
  if (ticket === null || active === null) {
    return;
  }
  active.handlers.delete(ticket.id);
  active.session.pace.promptClosed(ticket);
  // A press on a line the partner waits on moves the partner's too
  if (!following && active.link.sendCosmetic({ t: "press", at: atOf(ticket.at) })) {
    active.stats.presses++;
  }
}

/** This player is behind the partner: the next line comes at once instead of letter by letter */
export function coopTextAtOnce(): boolean {
  const active = activePacer();
  return active !== null && active.session.pace.behind;
}

/**
 * A question that only this screen asks and that the run does not wait for (the IV Scanner's): `action` answers it once
 * the partner is past it. The action must do nothing if the player answered already.
 */
export function whenCoopBehind(action: () => void): void {
  const active = activePacer();
  if (active !== null) {
    active.onBehind = action;
  }
}

function atOf(position: PacePosition): PaceAt {
  return [position[0], position[1], position[2]];
}

/** Close what the handler waits on, as the screen follows */
function follow(active: Pacer, handler: unknown): boolean {
  const closable = handler as Partial<Pick<AwaitableUiHandler, "closeAwaited">> | null;
  if (typeof closable?.closeAwaited !== "function") {
    return false;
  }
  following = true;
  try {
    const closed = closable.closeAwaited();
    if (closed) {
      active.stats.followed++;
    }
    return closed;
  } finally {
    following = false;
  }
}

/** The partner is past what this screen shows; close it (a shared line, or a panel of its own: level-up stats, IVs) */
function catchUp(active: Pacer): void {
  if (!active.session.pace.behind) {
    return;
  }
  const { ui } = globalScene;
  if (TEXT_MODES.has(ui.mode)) {
    // A panel of more than one step (the level-up stats, then their totals) closes in one go, instead of showing each
    // step for a tick; a shared line moves the guest's position, so the loop ends there by itself
    for (let step = 0; step < 3 && active.session.pace.behind && follow(active, ui.getHandler()); step++) {
      // closed one step
    }
    return;
  }
  const action = active.onBehind;
  if (action !== null) {
    active.onBehind = null;
    action();
  }
}

/** Host: where it is, and the settings the guest follows */
function sendPace(active: Pacer): void {
  const { general } = settings;
  active.link.sendCosmetic({
    t: "pace",
    at: atOf(active.session.pace.position),
    game: general.gameSpeed,
    exp: general.expGainsSpeed,
    hp: general.hpBarSpeed,
    iv: general.hideIvScanner,
    anim: settings.display.enableMoveAnimations,
    stats: settings.display.showStatsOnLevelUp,
  });
}

/** Guest: take the host's speeds, as a co-op overlay (they come off when the run ends) */
function followSettings(active: Pacer, message: Extract<CosmeticMessage, { t: "pace" }>): void {
  if (!GAME_SPEEDS.includes(message.game)) {
    return;
  }
  const wanted = {
    gameSpeed: message.game as GameSpeed,
    expGainsSpeed: message.exp as ExpGainsSpeed,
    hpBarSpeed: message.hp as HpBarSpeed,
    hideIvScanner: message.iv,
  } satisfies Pick<GeneralSettings, (typeof FOLLOWED_SETTINGS)[number]>;
  const wantedDisplay = {
    enableMoveAnimations: message.anim,
    showStatsOnLevelUp: message.stats,
  } satisfies Pick<DisplaySettings, (typeof FOLLOWED_DISPLAY)[number]>;
  const { general, display } = settings;
  if (
    FOLLOWED_SETTINGS.every(key => general[key] === wanted[key])
    && FOLLOWED_DISPLAY.every(key => display[key] === wantedDisplay[key])
  ) {
    return;
  }
  settings.applyOverlay(wanted);
  settings.applyDisplayOverlay(wantedDisplay);
  active.followsSettings = true;
  coopLog().info("pace", "following the host's speed", { ...wanted, ...wantedDisplay });
}

/** Guest: where it is, so that the host follows it when the guest is ahead */
function sendAt(active: Pacer): void {
  active.link.sendCosmetic({ t: "at", at: atOf(active.session.pace.position) });
}

function onMessage(active: Pacer, message: CosmeticMessage): void {
  const { session } = active;
  if (message.t === "pace" && session.seat === "guest") {
    session.pace.setLeader(message.at);
    followSettings(active, message);
    catchUp(active);
    return;
  }
  // The faster player leads (D27): the host follows a guest who is ahead, as the guest follows the host
  if (message.t === "at" && session.seat === "host") {
    session.pace.setLeader(message.at);
    catchUp(active);
    return;
  }
  if (message.t === "press") {
    const open = session.pace.openPrompt;
    const handler = open === null ? undefined : active.handlers.get(open.id);
    // Only the line this screen shows now: a press on a line this client has not reached does not skip it
    if (
      open !== null
      && session.pace.pressFits(message.at)
      && handler === globalScene.ui.getHandler()
      && follow(active, handler)
    ) {
      active.stats.presses++;
    }
  }
}

/** Start pacing a linked session (D27); what it returns stops it again */
export function startPacer(session: CoopSession, link: CoopLink): () => void {
  stopPacer();
  const unsubscribes: (() => void)[] = [];
  const active: Pacer = {
    session,
    link,
    handlers: new Map(),
    onBehind: null,
    followsSettings: false,
    stats: { followed: 0, presses: 0 },
    stop() {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      if (session.pace.onMove !== null) {
        session.pace.onMove = null;
      }
      if (this.followsSettings) {
        settings.removeOverlay(FOLLOWED_SETTINGS);
        settings.removeDisplayOverlay(FOLLOWED_DISPLAY);
      }
    },
  };
  unsubscribes.push(link.onCosmetic(message => safely(() => onMessage(active, message))));
  {
    // Each player says where it is (the host with its speeds), and follows the partner when the partner is ahead
    const send = session.seat === "host" ? sendPace : sendAt;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** Say where this client is now, and again after {@linkcode REPEAT_MS} without a move */
    const say = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      safely(() => send(active));
      timer = setTimeout(say, REPEAT_MS);
    };
    let cooling: ReturnType<typeof setTimeout> | null = null;
    let movedWhileCooling = false;
    const moved = (): void => {
      if (cooling !== null) {
        movedWhileCooling = true;
        return;
      }
      say();
      cooling = setTimeout(() => {
        cooling = null;
        if (movedWhileCooling) {
          movedWhileCooling = false;
          moved();
        }
      }, COALESCE_MS);
    };
    session.pace.onMove = moved;
    // A partner who is back (a rejoin, a new socket) missed what was said meanwhile
    let present = link.partnerPresent;
    unsubscribes.push(
      link.onChange(() => {
        if (link.partnerPresent && !present) {
          say();
        }
        present = link.partnerPresent;
      }),
      () => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        if (cooling !== null) {
          clearTimeout(cooling);
        }
      },
    );
    timer = setTimeout(say, REPEAT_MS);
    const follower = setInterval(() => safely(() => catchUp(active)), FOLLOW_MS);
    unsubscribes.push(() => clearInterval(follower));
  }
  pacer = active;
  return stopPacer;
}

/** Pacing must never take the game down */
function safely(action: () => void): void {
  try {
    action();
  } catch (error) {
    console.error("co-op: pacing failed:", error);
  }
}

export function stopPacer(): void {
  pacer?.stop();
  pacer = null;
}

/** What the debug API shows of pacing */
export interface PaceInfo {
  position: PacePosition;
  /** The host's position, as the guest knows it */
  leader: PacePosition | null;
  behind: boolean;
  private: boolean;
  open: PacePosition | null;
  /** The phases of each checkpoint's stretch in this epoch */
  segments: readonly number[];
  /** The latest shared lines */
  prompts: readonly PromptRecord[];
  stats: PaceStats;
  /** The game speed in effect (the guest's is the host's) */
  gameSpeed: number;
}

export function paceInfo(): PaceInfo | null {
  const active = activePacer();
  if (active === null) {
    return null;
  }
  const { pace } = active.session;
  return {
    position: pace.position,
    leader: pace.leader,
    behind: pace.behind,
    private: pace.isPrivate,
    open: pace.openPrompt?.at ?? null,
    segments: [...pace.segments],
    prompts: [...pace.prompts],
    stats: { ...active.stats },
    gameSpeed: settings.general.gameSpeed,
  };
}
