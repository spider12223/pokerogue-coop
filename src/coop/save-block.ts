/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { type CoopAccountSnapshot, isCoopAccountSnapshot } from "#coop/account-snapshot";
import { isOwnerRecord } from "#coop/ownership";
import { isTimedEventNames, type Seat } from "#coop/protocol";

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
  accountIds: Record<Seat, string>;
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
  return (
    block["version"] === COOP_SAVE_VERSION
    && typeof ids === "object"
    && ids !== null
    && typeof ids["host"] === "string"
    && typeof ids["guest"] === "string"
    && isOwnerRecord(block["owners"])
    && Number.isInteger(block["rewardPickCount"])
    && (block["rewardPickCount"] as number) >= 0
    && Number.isInteger(block["trades"])
    && (block["trades"] as number) >= 0
    && isCoopAccountSnapshot(block["accounts"])
    && (block["events"] === undefined || isTimedEventNames(block["events"]))
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
export function checkSaveBlock(block: unknown, session: { accountIds: Record<Seat, string> | null } | null): void {
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
    && (block.accountIds.host !== session.accountIds.host || block.accountIds.guest !== session.accountIds.guest)
  ) {
    throw new CoopSaveRefusedError("different-accounts", "This co-op run belongs to two other players.");
  }
}
