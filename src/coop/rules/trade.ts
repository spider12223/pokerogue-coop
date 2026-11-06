/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { WindowEntry } from "#coop/decisions/sequencer";
import {
  type DecisionKey,
  isSeat,
  ofSeat,
  otherSeat,
  type PlayerCount,
  type Seat,
  type SeatRecord,
} from "#coop/protocol";
import type { OwnerMap } from "#coop/rules/ownership";

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

/**
 * `TRADE_PROPOSE`: the proposer's Pokémon to give, and optionally the partner's they want (`pokemon.id`s). In a game of
 * three it names the player it is with (`to`, D40); a game of two leaves it out: it is with the partner.
 */
export interface TradeProposePayload {
  give: number;
  want: number | null;
  to?: Seat;
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
    && (payload["to"] === undefined || isSeat(payload["to"]))
  );
}

/**
 * Who a proposal is with: the player it names, or the partner in a game of two
 * @returns The counterpart, or `null` if there is none (a game of three that names nobody, or the proposer itself)
 */
export function counterpartOf(proposer: Seat, proposal: TradeProposePayload, players: PlayerCount = 2): Seat | null {
  if (proposal.to !== undefined) {
    return proposal.to === proposer ? null : proposal.to;
  }
  return players === 3 || proposer === "guest2" ? null : otherSeat(proposer);
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
export function checkTradeProposal(
  author: Seat,
  proposal: TradeProposePayload,
  owners: OwnerMap,
  players: PlayerCount = 2,
): TradeRefusal | null {
  if (owners.get(proposal.give) !== author) {
    return "notYours";
  }
  const other = counterpartOf(author, proposal, players);
  if (other === null) {
    return "notTheirs";
  }
  if (proposal.want !== null) {
    return owners.get(proposal.want) === other ? null : "notTheirs";
  }
  // A gift (amended) is free, whatever the counts, as long as the giver keeps one of their own: a player with
  // none would have nothing to play
  return ofSeat(owners.countBySeat(), author) >= 2 ? null : "lastOne";
}

/**
 * Carry out an accepted trade: the owners change, nothing else.
 * @param proposer - Who proposed it
 */
export function applyTrade(owners: OwnerMap, proposer: Seat, proposal: TradeProposePayload): void {
  const other = counterpartOf(proposer, proposal);
  if (other === null) {
    return;
  }
  owners.set(proposal.give, other);
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
  public readonly done: SeatRecord<boolean>;
  /** The trades that were accepted, in order */
  public readonly accepted: PendingTrade[] = [];

  /** @param seats - The game's seats (three in a game of three, D40) */
  constructor(private readonly seats: readonly Seat[] = ["host", "guest"]) {
    this.done = { host: false, guest: false };
    for (const seat of seats) {
      this.done[seat] = false;
    }
  }

  /** @returns Whether every player is done: the phase ends */
  public get finished(): boolean {
    return this.seats.every(seat => this.done[seat] === true);
  }

  /** @returns The keys of the open step and who may propose each (see {@linkcode tradeKey}) */
  public window(wave: number): WindowEntry[] {
    const { step } = this;
    if (this.pending !== null) {
      const answerer = counterpartOf(this.pending.proposer, this.pending, this.seats.length === 3 ? 3 : 2) ?? "host";
      return [
        { key: tradeKey(wave, "TRADE_ACCEPT", step), authors: [answerer] },
        { key: tradeKey(wave, "TRADE_DECLINE", step), authors: [answerer] },
        { key: tradeKey(wave, "TRADE_CANCEL", step), authors: [this.pending.proposer] },
      ];
    }
    return [
      { key: tradeKey(wave, "TRADE_PROPOSE", step) },
      ...this.seats.map(seat => ({ key: tradeDoneKey(wave, step, seat), authors: [seat] })),
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
        // a new proposal clears every player's "done"
        for (const seat of this.seats) {
          this.done[seat] = false;
        }
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
        // Whose "done" it is: the seat in the key, which is the absent player's when the partner took over for them (D17)
        const named = String(decision.key.ref).split(":")[1];
        const seat: Seat = isSeat(named) ? named : decision.author;
        this.done[seat] = done;
        return { t: "done", seat, done };
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
