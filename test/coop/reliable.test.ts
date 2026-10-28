/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Envelope } from "#coop/protocol";
import { createLoopbackPair } from "#coop/transport/loopback";
import { MAX_FRAME_CHARS, ReliableTransport } from "#coop/transport/reliable";
import type { RawTransport } from "#coop/transport/transport";
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

  describe("a partner that floods it", () => {
    /** A connection whose frames the test hands over itself */
    class StubRaw implements RawTransport {
      readonly isOpen = true;
      readonly sent: string[] = [];
      private readonly listeners = new Set<(frame: string) => void>();
      send(frame: string): void {
        this.sent.push(frame);
      }
      onFrame(listener: (frame: string) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      }
      onClose(): () => void {
        return () => undefined;
      }
      close(): void {}
      push(frame: string): void {
        for (const listener of [...this.listeners]) {
          listener(frame);
        }
      }
    }
    const data = (n: number): string => JSON.stringify({ n, b: message(n) });

    it("holds back only frames close enough to the next one in order, and gets the rest when they come again", () => {
      const raw = new StubRaw();
      const transport = new ReliableTransport(raw, { maxHeld: 8 });
      const received = collect(transport);
      for (let n = 2; n <= 30; n++) {
        raw.push(data(n));
      }
      // 2..8 are within 8 of the next one (1); the others are dropped, unacknowledged
      expect(transport.stats.heldBack).toBe(7);
      expect(transport.stats.tooFarAhead).toBe(22);
      raw.push(data(1));
      expect(received).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      // the sender sends again what was not acknowledged
      for (let n = 9; n <= 30; n++) {
        raw.push(data(n));
      }
      expect(received).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    });

    it("holds back at most 256 frames by default, whatever numbers they carry", () => {
      const raw = new StubRaw();
      const transport = new ReliableTransport(raw);
      collect(transport);
      for (let n = 2; n <= 2000; n++) {
        raw.push(data(n));
      }
      raw.push(data(10_000_000));
      expect(transport.stats.heldBack).toBe(255);
      expect(transport.stats.tooFarAhead).toBe(2000 - 1 - 255 + 1);
    });

    it("drops a frame longer than the relay forwards", () => {
      const raw = new StubRaw();
      const transport = new ReliableTransport(raw);
      const received = collect(transport);
      raw.push(JSON.stringify({ n: 1, b: { ...message(1), payload: "x".repeat(MAX_FRAME_CHARS) } }));
      expect(transport.stats.malformed).toBe(1);
      expect(received).toEqual([]);
      raw.push(data(1));
      expect(received).toEqual([1]);
    });
  });

  it("refuses to send after close", () => {
    const [rawA] = createLoopbackPair();
    const a = new ReliableTransport(rawA);
    a.close();
    expect(() => a.send(message(1))).toThrow(/closed/);
  });

  describe("fewer relay messages", () => {
    /** Two ends whose frames take `delayMs` each way, and that count what they send */
    class DelayedEnd implements RawTransport {
      readonly isOpen = true;
      readonly sent: string[] = [];
      peer!: DelayedEnd;
      private readonly listeners = new Set<(frame: string) => void>();
      constructor(private readonly delayMs: number) {}
      send(frame: string): void {
        this.sent.push(frame);
        setTimeout(() => {
          for (const listener of [...this.peer.listeners]) {
            listener(frame);
          }
        }, this.delayMs);
      }
      onFrame(listener: (frame: string) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      }
      onClose(): () => void {
        return () => undefined;
      }
      close(): void {}
    }
    function delayedPair(delayMs: number): [DelayedEnd, DelayedEnd] {
      const a = new DelayedEnd(delayMs);
      const b = new DelayedEnd(delayMs);
      a.peer = b;
      b.peer = a;
      return [a, b];
    }
    const acksIn = (raw: DelayedEnd): number =>
      raw.sent.filter(frame => !frame.includes('"n"') && !frame.includes('"v"')).length;

    it("acks a burst once, after a short wait", async () => {
      const [rawA, rawB] = delayedPair(0);
      const a = new ReliableTransport(rawA);
      const b = new ReliableTransport(rawB);
      const received = collect(b);
      for (let i = 0; i < 5; i++) {
        a.send(message(i));
      }
      await vi.advanceTimersByTimeAsync(10);
      expect(received).toEqual([0, 1, 2, 3, 4]);
      expect(acksIn(rawB)).toBe(0);
      await vi.advanceTimersByTimeAsync(60);
      expect(acksIn(rawB)).toBe(1);
      expect(a.pending).toBe(0);
    });

    it("an ack rides on a frame going the other way, data or volatile", async () => {
      const [rawA, rawB] = delayedPair(0);
      const a = new ReliableTransport(rawA);
      const b = new ReliableTransport(rawB);
      const atA = collect(a);
      a.send(message(1));
      await vi.advanceTimersByTimeAsync(5);
      b.send(message(2));
      await vi.advanceTimersByTimeAsync(5);
      a.send(message(3));
      await vi.advanceTimersByTimeAsync(5);
      b.sendVolatile(message(4));
      await runUntil(() => a.pending === 0 && b.pending === 0);
      // b's data frame carried the ack of 1, its volatile frame the ack of 3: b sent no ack of its own
      expect(acksIn(rawB)).toBe(0);
      expect(JSON.parse(rawB.sent[0]!)).toMatchObject({ n: 1, a: 1 });
      expect(JSON.parse(rawB.sent[1]!)).toMatchObject({ a: 2 });
      expect(atA).toEqual([2, 4]);
      expect(a.stats.malformed + b.stats.malformed).toBe(0);
    });

    it("learns a slow round trip: a link that loses nothing is not sent anything twice", async () => {
      // 150 ms each way, plus the ack's wait: well over the shortest resend delay of 200 ms
      const [rawA, rawB] = delayedPair(150);
      const a = new ReliableTransport(rawA);
      const b = new ReliableTransport(rawB);
      const received = collect(b);
      for (let i = 0; i < 100; i++) {
        a.send(message(i));
        await vi.advanceTimersByTimeAsync(100);
      }
      await runUntil(() => a.pending === 0);
      expect(received).toHaveLength(100);
      expect(a.stats.resent).toBe(0);
      expect(a.retransmitTimeoutMs).toBeGreaterThan(350);
    });

    it("a frame the relay dropped still comes again on a slow link", async () => {
      const [rawA, rawB] = delayedPair(150);
      const a = new ReliableTransport(rawA);
      const b = new ReliableTransport(rawB);
      const received = collect(b);
      a.send(message(1));
      await runUntil(() => a.pending === 0);
      // the next frame never arrives the first time
      const send = rawA.send.bind(rawA);
      let dropped = false;
      rawA.send = frame => {
        if (!dropped && frame.includes('"n":2')) {
          dropped = true;
          rawA.sent.push(frame);
          return;
        }
        send(frame);
      };
      a.send(message(2));
      await runUntil(() => a.pending === 0);
      expect(received).toEqual([1, 2]);
      expect(a.stats.resent).toBe(1);
    });
  });
});
