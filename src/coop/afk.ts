/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { pingKeyName } from "#coop/hotkey-names";
import { showOverlayMenu } from "#coop/overlay";
import { getCoopSession } from "#coop/session";
import { AfkClock, DEFAULT_AFK_TIMERS } from "#coop/takeover";
import { coopText, pingHint } from "#coop/text";
import { UiMode } from "#enums/ui-mode";
import i18next from "i18next";

/**
 * What a waiting player sees while the partner takes long (DECISIONS D17): after the first mark "{partner} is still
 * choosing" (and the player may ping), after the second the offer to take over, a menu with "Take over" and "Keep waiting".
 *
 * One watcher per wait: start it when the wait starts, stop it when the decision comes. It only shows things and calls
 * back; what a take over proposes is the caller's.
 *
 * @module
 */

/** How long after "Take over" the take over starts, in ms */
const TAKE_OVER_DELAY_MS = 60;

export interface AfkWatcherOptions {
  /** The player chose "Take over" */
  onTakeOver: () => void;
  /** Where the hint and the question are shown. Default: the message box, if that is what is on screen. */
  showText?: (text: string) => void;
  /** The screens the offer may appear over (a player who is in the middle of something else is not interrupted) */
  offerOver?: readonly UiMode[];
}

/** The watchers that are running, so that changing the timers (dev and test builds) reaches the waits that are open now */
const running = new Set<AfkWatcher>();

/** Start the clocks of every open wait again with the timers the session has now */
export function retimeAfkWatchers(): void {
  for (const watcher of running) {
    watcher.retime();
  }
}

/** Stop every running watcher: the run was reloaded (D18), or the partner is away and cannot be taken over for (D20) */
export function stopAllAfkWatchers(): void {
  for (const watcher of [...running]) {
    watcher.stop();
  }
}

export class AfkWatcher {
  private clock: AfkClock;
  /** Closes the offer's menu, or the menu of a take over that the caller opened ({@linkcode markOverlay}) */
  private closeMenu: (() => void) | null = null;
  private offerPending = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private takeOverTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: AfkWatcherOptions) {
    this.clock = this.newClock();
  }

  private newClock(): AfkClock {
    const timers = getCoopSession()?.afkTimers ?? DEFAULT_AFK_TIMERS;
    return new AfkClock({ onHint: () => this.hint(), onOffer: () => this.offer() }, timers);
  }

  public start(): void {
    running.add(this);
    this.clock.start();
  }

  /** The timers changed: the wait counts from now with the new ones (a hint or an offer that is on screen stays) */
  public retime(): void {
    if (!this.clock.isRunning) {
      return;
    }
    this.clock.stop();
    this.clock = this.newClock();
    this.clock.start();
  }

  /** The decision came, or the wait ended otherwise: no more hints, and an open offer closes */
  public stop(): void {
    running.delete(this);
    this.clock.stop();
    this.offerPending = false;
    if (this.retry !== null) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    if (this.takeOverTimer !== null) {
      clearTimeout(this.takeOverTimer);
      this.takeOverTimer = null;
    }
    this.closeOverlay();
  }

  /** The caller opened a menu of its own for the take over (the taker's command menu): it closes when the wait ends */
  public markOverlay(close: (() => void) | null): void {
    this.closeMenu = close;
  }

  /** The player chose to keep waiting: the offer comes again later */
  public keepWaiting(): void {
    this.clock.offerAgainLater();
  }

  private partnerName(): string {
    return getCoopSession()?.partnerName ?? "Your partner";
  }

  private say(text: string): void {
    if (this.options.showText !== undefined) {
      this.options.showText(text);
    } else if (globalScene.ui.mode === UiMode.MESSAGE) {
      globalScene.ui.showText(text, null, undefined, null, false);
    }
  }

  private hint(): void {
    this.say(
      coopText("stillChoosing", "{{partner}} is still choosing. {{hint}}", {
        partner: this.partnerName(),
        // A touch screen has no key: its emote button is what nudges the partner
        hint:
          globalScene.inputMethod === "touch"
            ? coopText("pingHintTouch", "Tap the emote button to nudge them.")
            : pingHint(pingKeyName()),
      }),
    );
  }

  private offer(): void {
    const { ui } = globalScene;
    const over = this.options.offerOver ?? [UiMode.MESSAGE];
    if (!over.includes(ui.mode)) {
      // The player is in the middle of something else: ask again in a moment
      this.offerPending = true;
      this.retry = setTimeout(() => {
        this.retry = null;
        if (this.offerPending) {
          this.offer();
        }
      }, 1000);
      return;
    }
    this.offerPending = false;
    this.say(coopText("takeOverQuestion", "{{partner}} is away. Take over for them?", { partner: this.partnerName() }));
    this.closeMenu = showOverlayMenu([
      {
        label: coopText("takeOver", "Take over"),
        handler: () => {
          this.closeMenu = null;
          this.clock.stop();
          // After the offer's own menu has closed: what a take over shows next (a menu of its own) must not be taken for
          // the one that is closing
          this.takeOverTimer = setTimeout(() => {
            this.takeOverTimer = null;
            this.options.onTakeOver();
          }, TAKE_OVER_DELAY_MS);
          return true;
        },
      },
      {
        label: coopText("keepWaiting", "Keep waiting"),
        handler: () => {
          this.closeMenu = null;
          this.keepWaiting();
          // The question goes with the menu: the line says again who is choosing, and how to nudge them
          this.hint();
          return true;
        },
      },
    ]);
  }

  private closeOverlay(): void {
    const close = this.closeMenu;
    this.closeMenu = null;
    close?.();
  }
}

/** "{partner} took over." for the player whose decision was made for them (D17) */
export function showTookOver(): void {
  const { ui } = globalScene;
  void ui.setMode(UiMode.MESSAGE).then(() => {
    ui.showText(
      coopText("tookOver", "{{partner}} took over for you.", {
        partner: getCoopSession()?.partnerName ?? "Your partner",
      }),
      null,
      undefined,
      1800,
    );
  });
}

/** Text of the take over menus */
export const takeoverCancelLabel = (): string => i18next.t("menu:cancel");
