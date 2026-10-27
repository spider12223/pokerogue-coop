/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { DecisionKey, DecisionKind } from "#coop/protocol";
import type { Scheduler } from "#coop/transport/transport";
import { systemScheduler } from "#coop/transport/transport";

/**
 * AFK and take over (DECISIONS D17). While a client waits for its partner's decision, a clock runs: at the first mark
 * it says the partner is still choosing, at the second it offers to take over, which means to make that one decision for
 * the partner. The takeover is an ordinary proposal with `takeover: true`; the sequencer accepts whichever arrives first.
 *
 * What the taker decides for each kind of decision is {@linkcode takeoverPlan}.
 *
 * No game imports, so it runs in Node.
 *
 * @module
 */

export interface AfkTimers {
  /** After this long a waiting player is told the partner is still choosing (and can ping), in ms */
  hintMs: number;
  /** After this long a waiting player can take over, in ms */
  takeoverMs: number;
  /** How long "Keep waiting" holds the offer back, in ms (default {@linkcode KEEP_WAITING_MS}) */
  keepWaitingMs?: number;
}

export const DEFAULT_AFK_TIMERS: Readonly<AfkTimers> = { hintMs: 30_000, takeoverMs: 90_000 };

/** How long "Keep waiting" holds the offer back, in ms */
export const KEEP_WAITING_MS = 30_000;

/**
 * What taking over a decision means (D17):
 * - `payload`: nobody chooses: the taker proposes this payload
 * - `ask`: the taker is asked the same question the partner would have been, with the same screen
 * - `custom`: the phase that waits has its own way (the command screen, the reward screen, the trade screen)
 */
export type TakeoverPlan =
  | {
      mode: "payload";
      payload: unknown /** The kind to propose it under, if not the waited one */;
      kind?: DecisionKind;
    }
  | { mode: "ask" }
  | { mode: "custom" };

const ASK: TakeoverPlan = { mode: "ask" };
const CUSTOM: TakeoverPlan = { mode: "custom" };

/**
 * @returns What a player who takes over the decision with this key does. Exhaustive over {@linkcode DecisionKind}: a new
 * kind does not compile until its takeover is decided.
 */
export function takeoverPlan(key: Pick<DecisionKey, "kind" | "ref">): TakeoverPlan {
  switch (key.kind) {
    case "TURN_COMMANDS":
      // the command screen of that Pokémon
      return CUSTOM;
    case "FAINT_SWITCH":
    case "PIVOT_SWITCH":
    case "BIOME":
      return ASK;
    case "SIDE_ACTION":
      // the taker is the one who wanted the Ball or the Run: they let themselves
      return { mode: "payload", payload: { accept: true } };
    case "SIDE_PICK":
    case "RETRY":
      // the taker picks with the host's menu
      return ASK;
    case "REWARD_PICK":
    case "REWARD_TARGET":
    case "REROLL":
    case "REWARD_LOCK":
    case "SHOP_BUY":
    case "REWARD_TRANSFER":
    case "TRADE_REQUEST":
      // the reward screen: the taker takes the picker's place
      return CUSTOM;
    case "LEARN_MOVE":
      // keep the old moves
      return { mode: "payload", payload: { replaceIndex: null } };
    case "EVOLUTION_CANCEL":
      // allow it: no cancel, and no pause after a cancel
      return {
        mode: "payload",
        payload: String(key.ref).endsWith(":pause") ? { pause: false } : { cancel: false },
      };
    case "CATCH_RELEASE":
      // decline the catch
      return { mode: "payload", payload: { release: null } };
    case "TRADE_PROPOSE":
    case "TRADE_CANCEL":
      // nobody takes over a proposal: it is not the partner's turn to make it
      return { mode: "payload", payload: null };
    case "TRADE_ACCEPT":
    case "TRADE_DECLINE":
      // the answer to a proposal: a taker declines it
      return { mode: "payload", payload: null, kind: "TRADE_DECLINE" };
    case "TRADE_DONE":
      return { mode: "payload", payload: { done: true } };
    case "PARTY_EDIT":
      // a player changes their own Pokémon when they want to: nobody waits for it
      return { mode: "payload", payload: null };
    case "ME_CHOICE":
      // the taker chooses with the same screens the chooser had (D29)
      return ASK;
  }
}

/** @returns Whether a player may take over this kind of decision at all */
export function canTakeOver(kind: DecisionKind): boolean {
  return kind !== "TRADE_PROPOSE" && kind !== "TRADE_CANCEL" && kind !== "TRADE_REQUEST" && kind !== "PARTY_EDIT";
}

export interface AfkClockCallbacks {
  /** The first mark: the partner is still choosing */
  onHint(): void;
  /** The second mark, and again after each "Keep waiting": offer to take over */
  onOffer(): void;
}

/**
 * The clock of one wait. Start it when the wait starts, stop it when the decision comes (or the wait ends otherwise).
 */
export class AfkClock {
  private hintTimer: unknown = null;
  private offerTimer: unknown = null;
  private running = false;

  constructor(
    private readonly callbacks: AfkClockCallbacks,
    private readonly timers: Readonly<AfkTimers> = DEFAULT_AFK_TIMERS,
    private readonly scheduler: Scheduler = systemScheduler,
  ) {}

  public get isRunning(): boolean {
    return this.running;
  }

  public start(): void {
    this.stop();
    this.running = true;
    this.hintTimer = this.scheduler.setTimeout(() => {
      this.hintTimer = null;
      this.callbacks.onHint();
    }, this.timers.hintMs);
    this.offerTimer = this.scheduler.setTimeout(() => {
      this.offerTimer = null;
      this.callbacks.onOffer();
    }, this.timers.takeoverMs);
  }

  /** The player chose to keep waiting: offer again later */
  public offerAgainLater(): void {
    if (!this.running) {
      return;
    }
    if (this.offerTimer !== null) {
      this.scheduler.clearTimeout(this.offerTimer);
    }
    this.offerTimer = this.scheduler.setTimeout(() => {
      this.offerTimer = null;
      this.callbacks.onOffer();
    }, this.timers.keepWaitingMs ?? KEEP_WAITING_MS);
  }

  public stop(): void {
    this.running = false;
    if (this.hintTimer !== null) {
      this.scheduler.clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    if (this.offerTimer !== null) {
      this.scheduler.clearTimeout(this.offerTimer);
      this.offerTimer = null;
    }
  }
}
