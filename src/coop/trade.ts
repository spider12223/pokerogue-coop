/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { OwnerMap } from "#coop/ownership";
import { type DecisionKey, otherSeat, type Seat } from "#coop/protocol";
import type { WindowEntry } from "#coop/sequencer";

/**
 * Trading Pokémon between the two players (DECISIONS D11, revised).
 *
 * The trade screen is a sequence of sequenced decisions in one window (`CoopTradePhase`): a player proposes a trade, the
 * other answers, and when both are done the phase ends. This module is the state machine and the rules, without a screen:
 *
 * - a trade swaps owners in the owner map and nothing else (the party array stays as it is, and held items stay on their
 *   Pokémon, so they follow it);
 * - a 1-for-1 trade keeps the counts; a gift (nothing wanted back) is allowed only if it makes the counts more equal.
 *
 * No game imports, so it runs in Node.
 *
 * @module
 */

/** `TRADE_PROPOSE`: the proposer's Pokémon to give, and optionally the partner's they want (`pokemon.id`s) */
export interface TradeProposePayload {
  give: number;
  want: number | null;
}

/** `TRADE_DONE`: whether this player is done trading */
export interface TradeDonePayload {
  done: boolean;
}

export function isTradeProposePayload(value: unknown): value is TradeProposePayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  return (
    Number.isInteger(payload["give"])
    && (payload["give"] as number) >= 0
    && (payload["want"] === null || (Number.isInteger(payload["want"]) && (payload["want"] as number) >= 0))
  );
}

export function isTradeDonePayload(value: unknown): value is TradeDonePayload {
  return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)["done"] === "boolean";
}

/** Why a proposal is not allowed */
export type TradeRefusal = "notYours" | "notTheirs" | "lastOne";

/**
 * @param author - Who proposes
 * @param proposal - What they offer and ask for
 * @param owners - Who owns what
 * @returns Why the proposal is not allowed, or `null` if it is
 */
export function checkTradeProposal(author: Seat, proposal: TradeProposePayload, owners: OwnerMap): TradeRefusal | null {
  const other = otherSeat(author);
  if (owners.get(proposal.give) !== author) {
    return "notYours";
  }
  if (proposal.want !== null) {
    return owners.get(proposal.want) === other ? null : "notTheirs";
  }
  // A gift (amended) is free, whatever the counts, as long as the giver keeps one of their own: a player with
  // none would have nothing to play
  return owners.countBySeat()[author] >= 2 ? null : "lastOne";
}

/**
 * Carry out an accepted trade: the owners change, nothing else.
 * @param proposer - Who proposed it
 */
export function applyTrade(owners: OwnerMap, proposer: Seat, proposal: TradeProposePayload): void {
  owners.set(proposal.give, otherSeat(proposer));
  if (proposal.want !== null) {
    owners.set(proposal.want, proposer);
  }
}

/** A proposal that waits for the other player's answer */
export interface PendingTrade extends TradeProposePayload {
  proposer: Seat;
}

/** What a decision of the trade window did */
export type TradeEffect =
  | { t: "proposed"; trade: PendingTrade }
  | { t: "accepted"; trade: PendingTrade }
  | { t: "declined"; trade: PendingTrade }
  | { t: "cancelled"; trade: PendingTrade }
  | { t: "done"; seat: Seat; done: boolean }
  | { t: "none" };

/**
 * The state of the trade window, the same on both clients because both feed it the same sequenced decisions in the same
 * order.
 */
export class TradeState {
  /** How many decisions of the phase were sequenced so far; part of every key's `ref` */
  public step = 0;
  public pending: PendingTrade | null = null;
  public readonly done: Record<Seat, boolean> = { host: false, guest: false };
  /** The trades that were accepted, in order */
  public readonly accepted: PendingTrade[] = [];

  /** @returns Whether both players are done: the phase ends */
  public get finished(): boolean {
    return this.done.host && this.done.guest;
  }

  /** @returns The keys of the open step and who may propose each (see {@linkcode tradeKey}) */
  public window(wave: number): WindowEntry[] {
    const { step } = this;
    if (this.pending !== null) {
      const answerer = otherSeat(this.pending.proposer);
      return [
        { key: tradeKey(wave, "TRADE_ACCEPT", step), authors: [answerer] },
        { key: tradeKey(wave, "TRADE_DECLINE", step), authors: [answerer] },
        { key: tradeKey(wave, "TRADE_CANCEL", step), authors: [this.pending.proposer] },
      ];
    }
    return [
      { key: tradeKey(wave, "TRADE_PROPOSE", step) },
      { key: tradeDoneKey(wave, step, "host"), authors: ["host"] },
      { key: tradeDoneKey(wave, step, "guest"), authors: ["guest"] },
    ];
  }

  /**
   * Take the sequenced decision that closed the open step.
   * @returns What it did; the caller applies an accepted trade to the owner map ({@linkcode applyTrade})
   */
  public apply(decision: { key: DecisionKey; author: Seat; payload: unknown }): TradeEffect {
    this.step++;
    switch (decision.key.kind) {
      case "TRADE_PROPOSE": {
        if (!isTradeProposePayload(decision.payload)) {
          return { t: "none" };
        }
        // a new proposal clears both players' "done"
        this.done.host = false;
        this.done.guest = false;
        this.pending = { ...decision.payload, proposer: decision.author };
        return { t: "proposed", trade: this.pending };
      }
      case "TRADE_ACCEPT":
      case "TRADE_DECLINE":
      case "TRADE_CANCEL": {
        const trade = this.pending;
        this.pending = null;
        if (trade === null) {
          return { t: "none" };
        }
        if (decision.key.kind === "TRADE_ACCEPT") {
          this.accepted.push(trade);
          return { t: "accepted", trade };
        }
        return { t: decision.key.kind === "TRADE_DECLINE" ? "declined" : "cancelled", trade };
      }
      case "TRADE_DONE": {
        const done = isTradeDonePayload(decision.payload) ? decision.payload.done : false;
        this.done[decision.author] = done;
        return { t: "done", seat: decision.author, done };
      }
      default:
        return { t: "none" };
    }
  }
}

/** The key of a trade decision of the phase's step `step`, in wave `wave` */
export function tradeKey(
  wave: number,
  kind: "TRADE_PROPOSE" | "TRADE_ACCEPT" | "TRADE_DECLINE" | "TRADE_CANCEL",
  step: number,
): DecisionKey {
  return { wave, turn: 0, kind, ref: `${step}` };
}

/** The key with which `seat` says it is done (or not) in step `step` */
export function tradeDoneKey(wave: number, step: number, seat: Seat): DecisionKey {
  return { wave, turn: 0, kind: "TRADE_DONE", ref: `${step}:${seat}` };
}

/**
 * The `TRADE_REQUEST` key of the reward window: either player asks for a trade phase after this screen (D11).
 * It is a decision of the reward screen's own window, so it uses the same `ref` as the other keys of that step.
 */
export function tradeRequestKey(wave: number, screen: number, step: number): DecisionKey {
  return { wave, turn: 0, kind: "TRADE_REQUEST", ref: `${screen}:${step}` };
}
