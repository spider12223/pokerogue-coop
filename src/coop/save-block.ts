/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { type CoopAccountSnapshot, isCoopAccountSnapshot } from "#coop/account-snapshot";
import { isOwnerRecord } from "#coop/ownership";
import { isTimedEventNames, type Seat, type SeatRecord } from "#coop/protocol";

/**
 * The `coop` block of a session save (DECISIONS D4, D7, D9, D13). A save with this block is a co-op run: it can only be
 * continued inside a co-op session with the same two accounts, never as a solo run. A save without it is solo.
 *
 * It is seat-neutral (no "my seat"): the host's wave-start save is what both clients reload (D13).
 *
 * No game imports.
 *
 * @module
 */

export const COOP_SAVE_VERSION = 2;

export interface CoopSaveBlock {
  version: typeof COOP_SAVE_VERSION;
  /** Who the two players are; a saved run can be rejoined only with the same two accounts (D4) */
  accountIds: SeatRecord<string>;
  /** `pokemon.id -> seat` for the party (D7) */
  owners: Record<string, Seat>;
  /** Reward screens started so far; the picker alternates with it (D9) */
  rewardPickCount: number;
  /** Trades accepted so far (D11); the owner map above already has their result */
  trades: number;
  /** Both accounts as of run start (D4) */
  accounts: CoopAccountSnapshot;
  /** The timed events of the run (D33); a save of an earlier version has none, and its run has no event */
  events?: string[];
  /** The trainer types the run has met (D34); a save of an earlier version has none */
  trainers?: number[];
  /** A save taken when a reward screen opened (D19): a reload goes back to that screen, not to the wave start */
  resumeAt?: RewardResume;
}

/**
 * The same save with its two guests' seats exchanged (D40): when the players of a run of three come back the other way
 * round (the second guest takes the first guest's seat), what each owns, their account and their id follow them
 */
export function swapGuestSeats(block: CoopSaveBlock): CoopSaveBlock {
  const swap = (seat: Seat): Seat => (seat === "guest" ? "guest2" : seat === "guest2" ? "guest" : seat);
  const swapRecord = <T>(record: SeatRecord<T>): SeatRecord<T> => {
    const out: SeatRecord<T> = { host: record.host, guest: (record.guest2 ?? record.guest) as T };
    if (record.guest2 !== undefined) {
      out.guest2 = record.guest;
    }
    return out;
  };
  return {
    ...block,
    accountIds: swapRecord(block.accountIds),
    accounts: swapRecord(block.accounts) as CoopAccountSnapshot,
    owners: Object.fromEntries(Object.entries(block.owners).map(([id, seat]) => [id, swap(seat)])),
  };
}

/** Where a reward-screen save resumes (D19): the screen, with the wave's fixed settings or none, and the phases after it */
export interface RewardResume {
  at: "rewards";
  fixedSettings: boolean;
  after: string[];
  /** The battle's turn counter at the screen: a save does not keep it, and the state hash counts it (D13) */
  turn: number;
}

/** The phases a reward-screen save may queue after the screen */
const RESUME_PHASES: readonly string[] = ["SelectBiomePhase", "NewBattlePhase"];

/** @returns Whether `value` is a reward-screen save's plan (D19) */
export function isRewardResume(value: unknown): value is RewardResume {
  const resume = value as Record<string, unknown> | null;
  return (
    typeof resume === "object"
    && resume !== null
    && resume["at"] === "rewards"
    && typeof resume["fixedSettings"] === "boolean"
    && Array.isArray(resume["after"])
    && resume["after"].length <= RESUME_PHASES.length
    && resume["after"].every(name => RESUME_PHASES.includes(name as string))
    && Number.isInteger(resume["turn"])
    && (resume["turn"] as number) >= 0
  );
}

/** At most this many trainer types are saved (D34): more than the game has */
const MET_TRAINERS_MAX = 1000;

/** @returns Whether `value` is a saved list of the trainer types a run has met (D34) */
export function isTrainerTypeList(value: unknown): value is number[] {
  return (
    Array.isArray(value)
    && value.length <= MET_TRAINERS_MAX
    && value.every(type => Number.isInteger(type) && (type as number) >= 0)
  );
}

/** Why a co-op save cannot be used here. The message is for the player. */
export class CoopSaveRefusedError extends Error {
  constructor(
    public readonly reason: "coop-save-in-solo" | "solo-save-in-coop" | "different-accounts" | "bad-block",
    message: string,
  ) {
    super(message);
    this.name = "CoopSaveRefusedError";
  }
}

export function isCoopSaveBlock(value: unknown): value is CoopSaveBlock {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const block = value as Record<string, unknown>;
  const ids = block["accountIds"] as Record<string, unknown> | null;
  // A game of three has a third account (D40)
  const three = typeof ids === "object" && ids !== null && ids["guest2"] !== undefined;
  return (
    block["version"] === COOP_SAVE_VERSION
    && typeof ids === "object"
    && ids !== null
    && typeof ids["host"] === "string"
    && typeof ids["guest"] === "string"
    && (!three || typeof ids["guest2"] === "string")
    && isOwnerRecord(block["owners"])
    && Number.isInteger(block["rewardPickCount"])
    && (block["rewardPickCount"] as number) >= 0
    && Number.isInteger(block["trades"])
    && (block["trades"] as number) >= 0
    && isCoopAccountSnapshot(block["accounts"], three ? ["host", "guest", "guest2"] : ["host", "guest"])
    && (block["events"] === undefined || isTimedEventNames(block["events"]))
    && (block["trainers"] === undefined || isTrainerTypeList(block["trainers"]))
    && (block["resumeAt"] === undefined || isRewardResume(block["resumeAt"]))
  );
}

/**
 * Decide whether a saved session may be loaded here.
 * @param block - The `coop` block of the save, if it has one
 * @param session - The active co-op session (`accountIds` is `null` while it does not know who the players are), or
 * `null` in solo play
 * @throws {@linkcode CoopSaveRefusedError} A co-op save in solo play, a solo save in a co-op session, a malformed
 * block, or a block of another pair of accounts
 */
export function checkSaveBlock(block: unknown, session: { accountIds: SeatRecord<string> | null } | null): void {
  if (block === undefined || block === null) {
    if (session !== null) {
      throw new CoopSaveRefusedError("solo-save-in-coop", "This is a solo run. It can't be continued in a co-op room.");
    }
    return;
  }
  if (session === null) {
    throw new CoopSaveRefusedError(
      "coop-save-in-solo",
      "This is a co-op run. It can only be continued from a co-op room with the same two players.",
    );
  }
  if (!isCoopSaveBlock(block)) {
    throw new CoopSaveRefusedError("bad-block", "The co-op data of this run is damaged or from another version.");
  }
  if (
    session.accountIds !== null
    && (block.accountIds.host !== session.accountIds.host
      || block.accountIds.guest !== session.accountIds.guest
      // (a run of three continued with two: the absent player's account is not asked for, D40)
      || (session.accountIds.guest2 !== undefined && block.accountIds.guest2 !== session.accountIds.guest2)
      || (block.accountIds.guest2 === undefined && session.accountIds.guest2 !== undefined))
  ) {
    throw new CoopSaveRefusedError("different-accounts", "This co-op run belongs to two other players.");
  }
}
