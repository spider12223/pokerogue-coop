/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Envelope } from "#coop/protocol";
import { createLoopbackPair } from "#coop/transport/loopback";
import { ReliableTransport } from "#coop/transport/reliable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function message(n: number): Envelope {
  return { key: null, author: "host", kind: "START", payload: n };
}

function collect(transport: ReliableTransport): number[] {
  const received: number[] = [];
  transport.onMessage(m => received.push(m.payload as number));
  return received;
}

/** Advance virtual time until `done`, in small steps so resends interleave with deliveries. */
async function runUntil(done: () => boolean, stepMs = 5, maxSteps = 200_000): Promise<void> {
  for (let step = 0; step < maxSteps && !done(); step++) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  expect(done(), "did not finish in the allowed virtual time").toBe(true);
}

describe("ReliableTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers in order over a perfect link and settles all acks", async () => {
    const [rawA, rawB] = createLoopbackPair();
    const a = new ReliableTransport(rawA);
    const b = new ReliableTransport(rawB);
    const received = collect(b);
    for (let i = 0; i < 100; i++) {
      a.send(message(i));
    }
    await runUntil(() => a.pending === 0);
    expect(received).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(a.stats.resent).toBe(0);
  });

  it("delivers exactly once and in order despite loss, duplication and reordering, in both directions", async () => {
    const [rawA, rawB] = createLoopbackPair({ dropRate: 0.1, duplicateRate: 0.1, reorderRate: 0.2, seed: 7 });
    const options = { rtoMs: 30, tickMs: 10 };
    const a = new ReliableTransport(rawA, options);
    const b = new ReliableTransport(rawB, options);
    const atA = collect(a);
    const atB = collect(b);
    const count = 1500;
    for (let i = 0; i < count; i++) {
      a.send(message(i));
      b.send(message(100_000 + i));
    }
    await runUntil(() => atB.length === count && atA.length === count && a.pending === 0 && b.pending === 0);
    expect(atB).toEqual(Array.from({ length: count }, (_, i) => i));
    expect(atA).toEqual(Array.from({ length: count }, (_, i) => 100_000 + i));
    expect(a.stats.resent + b.stats.resent).toBeGreaterThan(0);
    expect(a.stats.duplicatesDropped + b.stats.duplicatesDropped).toBeGreaterThan(0);
    expect(a.stats.heldBack + b.stats.heldBack).toBeGreaterThan(0);
  });

  it("keeps messages that arrive before the first listener and hands them over in order", async () => {
    const [rawA, rawB] = createLoopbackPair();
    const a = new ReliableTransport(rawA);
    const b = new ReliableTransport(rawB);
    a.send(message(1));
    a.send(message(2));
    await vi.advanceTimersByTimeAsync(10);
    expect(b.stats.delivered).toBe(2);
    const received = collect(b);
    expect(received).toEqual([1, 2]);
    a.send(message(3));
    await vi.advanceTimersByTimeAsync(10);
    expect(received).toEqual([1, 2, 3]);
  });

  it("ignores garbage frames without losing its place", async () => {
    const [rawA, rawB] = createLoopbackPair();
    const b = new ReliableTransport(rawB);
    const received = collect(b);
    rawA.send("not json");
    rawA.send(JSON.stringify({ unknown: true }));
    rawA.send(JSON.stringify({ n: 1, b: { kind: "NOPE" } })); // numbered, but not an envelope
    rawA.send(JSON.stringify({ n: 2, b: message(42) }));
    await vi.advanceTimersByTimeAsync(10);
    expect(received).toEqual([42]);
    expect(b.stats.malformed).toBe(3);
  });

  it("re-attaches to a new connection and resends what was never acknowledged, once", async () => {
    const [rawA1, rawB1] = createLoopbackPair();
    const a = new ReliableTransport(rawA1, { rtoMs: 30, tickMs: 10 });
    const b = new ReliableTransport(rawB1, { rtoMs: 30, tickMs: 10 });
    const received = collect(b);
    a.send(message(1));
    await runUntil(() => a.pending === 0);

    // The connection dies; a keeps sending into the void.
    rawA1.close();
    expect(a.connected).toBe(false);
    a.send(message(2));
    a.send(message(3));
    expect(a.pending).toBe(2);
    expect(received).toEqual([1]);

    // A new connection: both sides attach it.
    const [rawA2, rawB2] = createLoopbackPair();
    a.attach(rawA2);
    b.attach(rawB2);
    await runUntil(() => a.pending === 0);
    a.send(message(4));
    await runUntil(() => a.pending === 0);
    expect(received).toEqual([1, 2, 3, 4]);
  });

  it("refuses to send after close", () => {
    const [rawA] = createLoopbackPair();
    const a = new ReliableTransport(rawA);
    a.close();
    expect(() => a.send(message(1))).toThrow(/closed/);
  });
});
