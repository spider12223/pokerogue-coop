/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Seat } from "#coop/protocol";
import { resyncNotice } from "#phases/coop-resync-phase";
import { describe, expect, it } from "vitest";

/**
 * The line a reload shows after a return (D20): the player who came back is told so, the others are told who it was (by
 * seat in a game of three, D40).
 */

const NAMES: Record<Seat, string> = { host: "Sam", guest: "Alex", guest2: "Kim" };
const as = (seat: Seat, partnerName: string) => ({ seat, partnerName, nameOf: (of: Seat) => NAMES[of] });

describe("Co-op: what a reload says about who came back (D20)", () => {
  const rejoin = { reason: "rejoin" as const, wave: 3 };

  it("tells the player who came back that they are back, not that the partner is", () => {
    expect(resyncNotice(rejoin, false, ["guest"], as("guest", "Sam"))).toBe(
      "You're back. Resuming wave 3 from its start.",
    );
    expect(resyncNotice(rejoin, true, ["guest"], as("guest", "Sam"))).toBe(
      "You're back. Back to the rewards of wave 3.",
    );
  });

  it("tells the others who came back", () => {
    expect(resyncNotice(rejoin, false, ["guest"], as("host", "Alex"))).toBe(
      "Alex is back. Resuming wave 3 from its start.",
    );
    expect(resyncNotice(rejoin, true, ["host"], as("guest", "Sam"))).toBe(
      "Sam is back. Back to the rewards of wave 3.",
    );
  });

  it("names the one who came back in a game of three, not the first partner (D40)", () => {
    expect(resyncNotice(rejoin, false, ["guest2"], as("guest", "Sam"))).toBe(
      "Kim is back. Resuming wave 3 from its start.",
    );
    expect(resyncNotice(rejoin, false, ["guest", "guest2"], as("host", "Alex & Kim"))).toBe(
      "Alex & Kim are back. Resuming wave 3 from its start.",
    );
  });

  it("says only where the run goes on when nobody is known to have come back", () => {
    expect(resyncNotice(rejoin, false, [], as("host", "Alex"))).toBe("Resuming wave 3 from its start.");
    expect(resyncNotice(rejoin, true, [], as("host", "Alex"))).toBe("Back to the rewards of wave 3.");
  });
});
