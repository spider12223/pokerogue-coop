/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DECISION_KINDS, type DecisionKey, type Seat } from "#coop/protocol";
import { type Decision, Sequencer } from "#coop/sequencer";
import { createLoopbackPair } from "#coop/transport/loopback";
import { ReliableTransport } from "#coop/transport/reliable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DECISIONS = 10_000;

/** A key the simulations of both clients would derive on their own for step `i`. */
function keyFor(i: number): DecisionKey {
  return {
    wave: 1 + Math.floor(i / 50),
    turn: i % 50,
    kind: DECISION_KINDS[i % DECISION_KINDS.length]!,
    ref: i % 2,
  };
}

/** Both players make decisions, a third of them the guest's. */
function authorFor(i: number): Seat {
  return i % 3 === 1 ? "guest" : "host";
}

/**
 * What a simulation does at every step: open the expectation, let the owning player decide, wait for the sequenced
 * decision.
 */
async function play(sequencer: Sequencer, log: Decision[]): Promise<void> {
  for (let i = 0; i < DECISIONS; i++) {
    const key = keyFor(i);
    const pending = sequencer.awaitDecision(key);
    if (authorFor(i) === sequencer.role) {
      sequencer.propose(key, i);
    }
    log.push(await pending);
  }
}

describe("Sequencer over a lossy transport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sequences 10k decisions identically on both clients with 10% drop and 10% reorder", async () => {
    const [rawHost, rawGuest] = createLoopbackPair({
      dropRate: 0.1,
      reorderRate: 0.1,
      duplicateRate: 0.02,
      maxReorderDelayMs: 20,
      seed: 20261022,
    });
    const options = { rtoMs: 40, tickMs: 10 };
    const hostTransport = new ReliableTransport(rawHost, options);
    const guestTransport = new ReliableTransport(rawGuest, options);
    const host = new Sequencer({ role: "host", transport: hostTransport });
    const guest = new Sequencer({ role: "guest", transport: guestTransport });

    const hostLog: Decision[] = [];
    const guestLog: Decision[] = [];
    let finished = false;
    const done = Promise.all([play(host, hostLog), play(guest, guestLog)]).then(() => {
      finished = true;
    });

    for (let step = 0; step < 1_000_000 && !finished; step++) {
      await vi.advanceTimersByTimeAsync(5);
    }
    await done;

    expect(hostLog).toHaveLength(DECISIONS);
    expect(guestLog).toEqual(hostLog);
    for (let i = 0; i < DECISIONS; i++) {
      const decision = hostLog[i]!;
      expect(decision.seq).toBe(i + 1);
      expect(decision.key).toEqual(keyFor(i));
      expect(decision.author).toBe(authorFor(i));
      expect(decision.payload).toBe(i);
    }
    expect(host.desync).toBeNull();
    expect(guest.desync).toBeNull();
    expect(host.lastApplied).toBe(DECISIONS);
    expect(guest.lastApplied).toBe(DECISIONS);

    // The lossy link really was exercised.
    expect(hostTransport.stats.resent + guestTransport.stats.resent).toBeGreaterThan(100);
    expect(hostTransport.stats.duplicatesDropped + guestTransport.stats.duplicatesDropped).toBeGreaterThan(0);
    expect(hostTransport.stats.heldBack + guestTransport.stats.heldBack).toBeGreaterThan(0);
  });
});
