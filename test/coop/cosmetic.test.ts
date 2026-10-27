/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  COSMETIC_LIMITS,
  type CosmeticMessage,
  CosmeticReceiver,
  CosmeticSender,
  isCosmeticMessage,
} from "#coop/cosmetic";
import { CoopLink } from "#coop/link";
import type { DecisionKey } from "#coop/protocol";
import { createLoopbackPair } from "#coop/transport/loopback";
import { ReliableTransport } from "#coop/transport/reliable";
import { afterEach, describe, expect, it } from "vitest";
import { FakeScheduler } from "./fake-scheduler";

/**
 * The cosmetic channel (DECISIONS D16): well-formed or dropped, rate-limited on both ends, and never in the way of a
 * decision.
 */

const intent = (pokemonId: number, ready = false, move: number | null = 33): CosmeticMessage => ({
  t: "intent",
  pokemonId,
  move,
  target: 2,
  ready,
});

describe("cosmetic messages", () => {
  it.each<[string, CosmeticMessage]>([
    ["an intent", intent(12)],
    ["an intent with nothing chosen", { t: "intent", pokemonId: 12, move: null, target: null, ready: false }],
    ["a cursor", { t: "cursor", screen: 3, row: 1, col: 2 }],
    ["an encounter cursor", { t: "meCursor", step: 2, index: 4 }],
    ["a ping at an enemy", { t: "ping", at: { k: "enemy", index: 1 } }],
    ["a ping at a party Pokémon", { t: "ping", at: { k: "party", pokemonId: 7 } }],
    ["a ping at a reward", { t: "ping", at: { k: "reward", index: 2 } }],
    ["a ping at a shop item", { t: "ping", at: { k: "shop", index: 5 } }],
    ["a nudge", { t: "ping", at: { k: "none" } }],
    ["an emote", { t: "emote", id: 5 }],
  ])("accepts %s", (_name, message) => {
    expect(isCosmeticMessage(message)).toBe(true);
    expect(isCosmeticMessage(JSON.parse(JSON.stringify(message)))).toBe(true);
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["a string", "intent"],
    ["no kind", { pokemonId: 1 }],
    ["an unknown kind", { t: "paint", x: 1 }],
    ["an intent with a fractional id", { t: "intent", pokemonId: 1.5, move: null, target: null, ready: false }],
    ["an intent with a negative id", { t: "intent", pokemonId: -1, move: null, target: null, ready: false }],
    ["an intent with a text move", { t: "intent", pokemonId: 1, move: "tackle", target: null, ready: false }],
    ["an intent with a target out of range", { t: "intent", pokemonId: 1, move: 1, target: 9, ready: false }],
    ["an intent without the ready flag", { t: "intent", pokemonId: 1, move: 1, target: 1 }],
    ["a cursor with a huge column", { t: "cursor", screen: 0, row: 0, col: 1e9 }],
    ["a cursor with NaN", { t: "cursor", screen: Number.NaN, row: 0, col: 0 }],
    ["an encounter cursor past the options", { t: "meCursor", step: 0, index: 9 }],
    ["an encounter cursor without its question", { t: "meCursor", index: 1 }],
    ["a ping at nothing known", { t: "ping", at: { k: "moon" } }],
    ["a ping at a field slot that is not there", { t: "ping", at: { k: "enemy", index: 2 } }],
    ["a ping without a target", { t: "ping" }],
    ["an emote that does not exist", { t: "emote", id: 6 }],
    ["an emote with text", { t: "emote", id: "hi" }],
  ])("drops %s", (_name, message) => {
    expect(isCosmeticMessage(message)).toBe(false);
  });
});

describe("the receiver", () => {
  it("drops what is malformed and counts it", () => {
    const receiver = new CosmeticReceiver(new FakeScheduler());
    expect(receiver.accept({ t: "emote", id: 99 })).toBeNull();
    expect(receiver.accept("hello")).toBeNull();
    expect(receiver.accept({ t: "emote", id: 1 })).toEqual({ t: "emote", id: 1 });
    expect(receiver.stats.malformed).toBe(2);
    expect(receiver.stats.accepted.emote).toBe(1);
  });

  it("keeps to the limit of each kind when the sender floods: a burst, then the sustained rate", () => {
    const clock = new FakeScheduler();
    const receiver = new CosmeticReceiver(clock);
    const accepted = (message: CosmeticMessage): number => {
      let count = 0;
      for (let i = 0; i < 1000; i++) {
        if (receiver.accept(message) !== null) {
          count++;
        }
      }
      return count;
    };

    // 1000 at one instant: only the burst (the sender's, plus the slack for messages the network bunched up)
    expect(accepted(intent(1))).toBe(COSMETIC_LIMITS.intent.burst + 1);
    expect(accepted({ t: "cursor", screen: 0, row: 1, col: 1 })).toBe(COSMETIC_LIMITS.cursor.burst + 1);
    expect(accepted({ t: "ping", at: { k: "none" } })).toBe(COSMETIC_LIMITS.ping.burst + 1);
    expect(accepted({ t: "emote", id: 0 })).toBe(COSMETIC_LIMITS.emote.burst + 1);

    // and during the next second, no more than the sustained rate (with the same slack)
    clock.advance(1000);
    expect(accepted(intent(1))).toBeLessThanOrEqual(Math.ceil(COSMETIC_LIMITS.intent.perSecond * 1.25));
    expect(accepted({ t: "ping", at: { k: "none" } })).toBeLessThanOrEqual(2);
    expect(receiver.stats.limited.intent).toBeGreaterThan(1900);
    expect(receiver.stats.limited.emote).toBeGreaterThan(900);
  });

  it("limits each kind on its own: a flood of intents does not take a ping's place", () => {
    const receiver = new CosmeticReceiver(new FakeScheduler());
    for (let i = 0; i < 100; i++) {
      receiver.accept(intent(1));
    }
    expect(receiver.accept({ t: "ping", at: { k: "none" } })).not.toBeNull();
  });
});

describe("the sender", () => {
  function sender() {
    const clock = new FakeScheduler();
    const sent: CosmeticMessage[] = [];
    return { clock, sent, send: new CosmeticSender(message => sent.push(message), clock) };
  }

  it("sends a state at once while it is within the limit, and holds the rest", () => {
    const { clock, sent, send } = sender();
    for (let i = 0; i < 50; i++) {
      send.send(intent(1, false, 100 + i));
    }
    expect(sent).toHaveLength(COSMETIC_LIMITS.intent.burst);
    clock.advance(1000);
    // the held ones went out at the sustained rate: the latest state is what is left, not all 45
    expect(sent.length).toBeLessThanOrEqual(COSMETIC_LIMITS.intent.burst + COSMETIC_LIMITS.intent.perSecond + 1);
    expect(sent.at(-1)).toMatchObject({ move: 149 });
  });

  it("never loses the last state: the ready badge arrives", () => {
    const { clock, sent, send } = sender();
    for (let i = 0; i < 30; i++) {
      send.send(intent(1, false, i));
    }
    send.send(intent(1, true, 7));
    clock.advance(5000);
    expect(sent.at(-1)).toEqual(intent(1, true, 7));
  });

  it("keeps a held state of each Pokémon", () => {
    const { clock, sent, send } = sender();
    for (let i = 0; i < 20; i++) {
      send.send(intent(1, false, i));
      send.send(intent(2, false, 500 + i));
    }
    clock.advance(10_000);
    expect(sent.filter(message => message.t === "intent" && message.pokemonId === 1).at(-1)).toMatchObject({
      move: 19,
    });
    expect(sent.filter(message => message.t === "intent" && message.pokemonId === 2).at(-1)).toMatchObject({
      move: 519,
    });
  });

  it("refuses a ping or an emote over the limit instead of holding it", () => {
    const { clock, sent, send } = sender();
    const results = Array.from({ length: 10 }, () => send.send({ t: "ping", at: { k: "none" } }));
    expect(results.filter(Boolean)).toHaveLength(COSMETIC_LIMITS.ping.burst);
    clock.advance(10_000);
    expect(sent).toHaveLength(COSMETIC_LIMITS.ping.burst);
    expect(send.send({ t: "emote", id: 1 })).toBe(true);
    expect(send.send({ t: "emote", id: 2 })).toBe(true);
    expect(send.send({ t: "emote", id: 3 })).toBe(false);
    clock.advance(1500);
    expect(send.send({ t: "emote", id: 3 })).toBe(true);
  });

  it("does not send what is malformed, and sends nothing after it is closed", () => {
    const { sent, send } = sender();
    expect(send.send({ t: "emote", id: 40 })).toBe(false);
    send.close();
    expect(send.send({ t: "emote", id: 1 })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("can drop what it holds", () => {
    const { clock, sent, send } = sender();
    for (let i = 0; i < 30; i++) {
      send.send(intent(1, false, i));
    }
    const before = sent.length;
    send.clearHeld();
    clock.advance(10_000);
    expect(sent).toHaveLength(before);
  });
});

/** The loopback delivers on a later tick */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 10));

describe("on a link", () => {
  const links: CoopLink[] = [];
  afterEach(() => {
    for (const link of links.splice(0)) {
      link.close();
    }
  });

  function pair() {
    const [a, b] = createLoopbackPair({ seed: 3 });
    const clock = new FakeScheduler();
    const host = new CoopLink({ seat: "host", reliable: new ReliableTransport(a), scheduler: clock });
    const guest = new CoopLink({ seat: "guest", reliable: new ReliableTransport(b), scheduler: clock });
    links.push(host, guest);
    return { host, guest, clock };
  }

  it("delivers the partner's messages and not its own", async () => {
    const { host, guest } = pair();
    const onGuest: CosmeticMessage[] = [];
    const onHost: CosmeticMessage[] = [];
    guest.onCosmetic(message => onGuest.push(message));
    host.onCosmetic(message => onHost.push(message));
    host.sendCosmetic({ t: "emote", id: 2 });
    await flush();
    expect(onGuest).toEqual([{ t: "emote", id: 2 }]);
    expect(onHost).toEqual([]);
  });

  it("drops a flood at the receiver even if the sender does not keep to the limits", async () => {
    const { host, guest } = pair();
    const received: CosmeticMessage[] = [];
    guest.onCosmetic(message => received.push(message));
    // a client that does not throttle: the frames go straight to the wire
    const raw = (host as unknown as { reliable: ReliableTransport }).reliable;
    for (let i = 0; i < 500; i++) {
      raw.sendVolatile({
        key: null,
        author: "host",
        kind: "COSMETIC",
        payload: { t: "cursor", screen: 0, row: 1, col: i % 8 },
      });
    }
    await flush();
    expect(received.length).toBeLessThanOrEqual(COSMETIC_LIMITS.cursor.burst + 1);
    expect(guest.cosmeticReceiver.stats.limited.cursor).toBeGreaterThan(400);
  });

  it("drops malformed payloads and survives a listener that throws", async () => {
    const { host, guest } = pair();
    const received: CosmeticMessage[] = [];
    guest.onCosmetic(() => {
      throw new Error("a broken renderer");
    });
    guest.onCosmetic(message => received.push(message));
    const raw = (host as unknown as { reliable: ReliableTransport }).reliable;
    raw.sendVolatile({ key: null, author: "host", kind: "COSMETIC", payload: { t: "emote", id: 77 } });
    raw.sendVolatile({ key: null, author: "host", kind: "COSMETIC", payload: { t: "emote", id: 1 } });
    await flush();
    expect(received).toEqual([{ t: "emote", id: 1 }]);
    expect(guest.cosmeticReceiver.stats.malformed).toBe(1);
  });

  it("is not in the way of a decision: a cosmetic message does not wait for a lost frame before it", async () => {
    // every frame of the host's reliable stream is lost, but volatile ones are not numbered, so they are not held back
    const [a, b] = createLoopbackPair({ dropRate: 0 });
    const hostReliable = new ReliableTransport(a, { rtoMs: 1e9, maxRtoMs: 1e9 });
    const guestReliable = new ReliableTransport(b);
    const guest = new CoopLink({ seat: "guest", reliable: guestReliable });
    links.push(guest);
    const decisions: unknown[] = [];
    guestReliable.onMessage(message => message.kind === "SEQUENCED" && decisions.push(message));
    const received: CosmeticMessage[] = [];
    guest.onCosmetic(message => received.push(message));

    // frame 1 of the stream vanishes on the way (the frame is dropped by closing the guest's side of it)...
    const key: DecisionKey = { wave: 1, turn: 1, kind: "TURN_COMMANDS", ref: 1 };
    const originalSend = a.send.bind(a);
    let dropNext = true;
    a.send = frame => {
      if (dropNext && frame.includes('"n":1')) {
        dropNext = false;
        return;
      }
      originalSend(frame);
    };
    hostReliable.send({ seq: 1, key, author: "host", kind: "SEQUENCED", payload: null });
    hostReliable.send({ seq: 2, key: { ...key, ref: 2 }, author: "host", kind: "SEQUENCED", payload: null });
    hostReliable.sendVolatile({ key: null, author: "host", kind: "COSMETIC", payload: { t: "emote", id: 4 } });

    // ...so the second decision is held back, while the emote is already there
    await flush();
    expect(decisions).toHaveLength(0);
    expect(received).toEqual([{ t: "emote", id: 4 }]);
    hostReliable.close();
  });
});
