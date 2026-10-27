/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EpochChangedError, EpochTransport, MAX_HELD_NEWER } from "#coop/epoch";
import type { DecisionKey, Envelope, MessageKind } from "#coop/protocol";
import { DesyncError, Sequencer } from "#coop/sequencer";
import { describe, expect, it } from "vitest";
import { createManualLink } from "./manual-link";

/**
 * Epochs (DECISIONS D18): every envelope carries one, a message of an older epoch is dropped, `seq` never resets, and a
 * reload gives the sequencer a clean world.
 */

const k = (turn: number, ref = 0, kind: DecisionKey["kind"] = "TURN_COMMANDS", wave = 1): DecisionKey => ({
  wave,
  turn,
  kind,
  ref,
});

function setup() {
  const link = createManualLink();
  const hostChannel = new EpochTransport(link.host);
  const guestChannel = new EpochTransport(link.guest);
  const host = new Sequencer({ role: "host", transport: hostChannel });
  const guest = new Sequencer({ role: "guest", transport: guestChannel });
  const settle = (): void => {
    for (let round = 0; round < 10 && (link.host.outbox.length > 0 || link.guest.outbox.length > 0); round++) {
      link.guest.deliverFromPeer();
      link.host.deliverFromPeer();
    }
  };
  return { hostEnd: link.host, guestEnd: link.guest, hostChannel, guestChannel, host, guest, settle };
}

function envelope(kind: MessageKind, epoch: number | undefined, key: DecisionKey | null = k(1)): Envelope {
  return {
    ...(kind === "SEQUENCED" || kind === "RESYNC" ? { seq: 1 } : {}),
    key: kind === "RESYNC" || kind === "CHECKPOINT" || kind === "COSMETIC" ? null : key,
    author: "host",
    kind,
    payload: null,
    ...(epoch === undefined ? {} : { epoch }),
  };
}

describe("EpochTransport", () => {
  it("stamps its epoch on every envelope it sends", () => {
    const s = setup();
    s.hostChannel.setEpoch(3);
    void s.host.awaitDecision(k(1));
    s.host.propose(k(1), "a");
    expect(s.hostEnd.outbox.map(message => [message.kind, message.epoch])).toEqual([["SEQUENCED", 3]]);
  });

  it("puts the epoch on volatile frames too", () => {
    const s = setup();
    s.hostChannel.setEpoch(4);
    s.guestChannel.setEpoch(4);
    const got: Envelope[] = [];
    s.guestChannel.onMessage(message => got.push(message));
    void s.host.awaitDecision(k(1));
    s.host.propose(k(1), "a");
    s.hostChannel.sendVolatile({ key: null, author: "host", kind: "COSMETIC", payload: { t: "x" } });
    s.settle();
    expect(got.map(message => [message.kind, message.epoch])).toEqual([
      ["SEQUENCED", 4],
      ["COSMETIC", 4],
    ]);
  });

  it("drops what an older epoch sent, kind by kind, and counts it", () => {
    const link = createManualLink();
    const guestChannel = new EpochTransport(link.guest);
    const guestEnd = link.guest;
    guestChannel.setEpoch(2);
    const got: MessageKind[] = [];
    guestChannel.onMessage(message => got.push(message.kind));
    for (const kind of [
      "PROPOSE",
      "SEQUENCED",
      "REJECT",
      "CHECKPOINT",
      "COSMETIC",
      "RESYNC_REQUEST",
      "REPORT",
    ] as const) {
      guestEnd.receive(envelope(kind, 1));
      guestEnd.receive(envelope(kind, undefined)); // no epoch is epoch 0
    }
    expect(got).toEqual([]);
    expect(guestChannel.stats.droppedOlder).toBe(14);
  });

  it("lets the pre-run traffic through whatever the epoch", () => {
    const link = createManualLink();
    const channel = new EpochTransport(link.guest);
    channel.setEpoch(2);
    const got: MessageKind[] = [];
    channel.onMessage(message => got.push(message.kind));
    for (const kind of ["HELLO", "HELLO_ACK", "HELLO_OK", "REFUSE", "START", "LOBBY", "BYE"] as const) {
      link.guest.receive(envelope(kind, undefined, null));
    }
    expect(got).toEqual(["HELLO", "HELLO_ACK", "HELLO_OK", "REFUSE", "START", "LOBBY", "BYE"]);
  });

  it("holds no more than its cap of a newer epoch's messages: junk stamped with a future epoch is dropped", () => {
    const link = createManualLink();
    const channel = new EpochTransport(link.guest);
    channel.onMessage(() => undefined);
    for (let i = 0; i < MAX_HELD_NEWER + 10; i++) {
      link.guest.receive(envelope("SEQUENCED", 5));
    }
    expect(channel.heldCount).toBe(MAX_HELD_NEWER);
    expect(channel.stats.droppedNewer).toBe(10);
  });

  it("holds what a newer epoch sent until the epoch gets there, then hands it on in order", () => {
    const link = createManualLink();
    const channel = new EpochTransport(link.guest);
    const got: [MessageKind, number | undefined][] = [];
    channel.onMessage(message => got.push([message.kind, message.epoch]));
    // the host is in its new world and talks, while the guest has not applied the RESYNC yet
    link.guest.receive(envelope("RESYNC", 1)); // the way the epoch arrives: it comes through at once
    link.guest.receive(envelope("SEQUENCED", 1));
    link.guest.receive(envelope("CHECKPOINT", 1));
    link.guest.receive(envelope("COSMETIC", 1)); // cosmetic: not worth keeping
    link.guest.receive(envelope("PROPOSE", 2)); // a world after the next one
    expect(got).toEqual([["RESYNC", 1]]);
    expect(channel.heldCount).toBe(3);

    channel.setEpoch(1);
    expect(got).toEqual([
      ["RESYNC", 1],
      ["SEQUENCED", 1],
      ["CHECKPOINT", 1],
    ]);
    expect(channel.stats).toEqual({ droppedOlder: 0, heldNewer: 3, releasedNewer: 2 });
    expect(channel.heldCount).toBe(1); // the epoch 2 message waits for its own epoch

    channel.setEpoch(3); // passed it: it is dropped
    expect(channel.heldCount).toBe(0);
    expect(channel.stats.droppedOlder).toBe(1);

    // and a RESYNC that is not newer than the epoch is a leftover
    link.guest.receive(envelope("RESYNC", 3));
    expect(got).toHaveLength(3);
    expect(channel.stats.droppedOlder).toBe(2);
  });

  it("hands a held message to every listener", () => {
    const link = createManualLink();
    const channel = new EpochTransport(link.guest);
    const first: MessageKind[] = [];
    const second: MessageKind[] = [];
    channel.onMessage(message => first.push(message.kind));
    channel.onMessage(message => second.push(message.kind));
    link.guest.receive(envelope("SEQUENCED", 1));
    channel.setEpoch(1);
    expect(first).toEqual(["SEQUENCED"]);
    expect(second).toEqual(["SEQUENCED"]);
  });

  it("never goes back", () => {
    const channel = new EpochTransport(createManualLink().host);
    channel.setEpoch(2);
    expect(() => channel.setEpoch(1)).toThrow(RangeError);
    expect(() => channel.setEpoch(2.5)).toThrow(RangeError);
    channel.setEpoch(2);
    expect(channel.epoch).toBe(2);
  });
});

describe("Sequencer across a reload (D18)", () => {
  it("a proposal sent in the old epoch never reaches the new world", async () => {
    const s = setup();
    // the guest proposes at epoch 0 ...
    s.guest.propose(k(2, 1), "stale");
    // ... but the host has reloaded by the time it arrives
    s.host.resetForEpoch(10);
    s.hostChannel.setEpoch(1);
    s.settle();
    expect(s.host.parkedCount).toBe(0);
    expect(s.hostChannel.stats.droppedOlder).toBe(1);
    // the same key, proposed in the new epoch, is sequenced as usual
    s.guest.resetForEpoch(10);
    s.guestChannel.setEpoch(1);
    const onHost = s.host.awaitDecision(k(2, 1));
    const onGuest = s.guest.awaitDecision(k(2, 1));
    s.guest.propose(k(2, 1), "fresh");
    s.settle();
    expect(await onHost).toMatchObject({ seq: 10, payload: "fresh" });
    expect(await onGuest).toMatchObject({ seq: 10, payload: "fresh" });
  });

  it("seq never resets: the reload takes the next seq and both carry on from there", async () => {
    const s = setup();
    const first = [s.host.awaitDecision(k(1)), s.guest.awaitDecision(k(1))];
    s.host.propose(k(1), "a");
    s.settle();
    expect((await Promise.all(first)).map(d => d.seq)).toEqual([1, 1]);

    const resyncSeq = s.host.reserveSeq();
    expect(resyncSeq).toBe(2);
    s.host.resetForEpoch(resyncSeq + 1);
    s.guest.resetForEpoch(resyncSeq + 1);
    s.hostChannel.setEpoch(1);
    s.guestChannel.setEpoch(1);

    const after = [s.host.awaitDecision(k(1)), s.guest.awaitDecision(k(1))]; // the same key again: a replayed wave
    s.host.propose(k(1), "b");
    s.settle();
    expect((await Promise.all(after)).map(d => [d.seq, d.payload])).toEqual([
      [3, "b"],
      [3, "b"],
    ]);
    expect(s.host.lastApplied).toBe(3);
  });

  it("a host that was reopened from its slot is older than the guest: the guest takes the seq of the RESYNC as it is", async () => {
    const s = setup();
    // the guest has seen a whole wave (seqs 1 to 5) ...
    for (let turn = 1; turn <= 5; turn++) {
      const seen = [s.host.awaitDecision(k(turn)), s.guest.awaitDecision(k(turn))];
      s.host.propose(k(turn), `t${turn}`);
      s.settle();
      await Promise.all(seen);
    }
    expect(s.guest.nextExpected).toBe(6);
    // ... and the host comes back as a new sequencer, from the slot of the wave start, which was written at seq 1
    s.host.close();
    const reopened = new Sequencer({ role: "host", transport: s.hostChannel });
    reopened.ensureSeqAtLeast(2);
    const resyncSeq = reopened.reserveSeq();
    expect(resyncSeq).toBe(2);
    reopened.resetForEpoch(resyncSeq + 1);
    s.guest.resetForEpoch(resyncSeq + 1);
    s.hostChannel.setEpoch(1);
    s.guestChannel.setEpoch(1);
    expect(s.guest.nextExpected).toBe(3);

    const again = [reopened.awaitDecision(k(1)), s.guest.awaitDecision(k(1))];
    reopened.propose(k(1), "again");
    s.settle();
    expect((await Promise.all(again)).map(d => [d.seq, d.payload])).toEqual([
      [3, "again"],
      [3, "again"],
    ]);
    // the host itself never goes back: a seq it already assigned is not assigned twice
    reopened.resetForEpoch(1);
    expect(reopened.nextExpected).toBe(4);
  });

  it("what waited for a decision is told, without it being a failure; windows and parked proposals are forgotten", async () => {
    const s = setup();
    const waiting = s.host.awaitDecision(k(1));
    const waitingAll = s.host.awaitOneOf([{ key: k(2, 0, "REWARD_PICK") }, { key: k(2, 0, "REROLL") }]);
    s.guest.propose(k(9), "parked"); // nobody asked for it yet
    s.settle();
    expect(s.host.parkedCount).toBe(1);

    s.host.resetForEpoch(5);
    await expect(waiting).rejects.toBeInstanceOf(EpochChangedError);
    await expect(waitingAll).rejects.toBeInstanceOf(EpochChangedError);
    expect(s.host.parkedCount).toBe(0);
    expect(s.host.readyCount).toBe(0);
  });

  it("recovers from a desync: the failure is forgotten, new decisions are accepted", async () => {
    const s = setup();
    // the guest simulation waits for turn 1, the host sequences turn 2: the sequence does not fit
    const stuck = s.guest.awaitDecision(k(1));
    void s.host.awaitDecision(k(2));
    s.host.propose(k(2), "x");
    s.settle();
    await expect(stuck).rejects.toBeInstanceOf(DesyncError);
    expect(s.guest.desync).not.toBeNull();
    expect(() => s.guest.propose(k(3), "y")).toThrow(DesyncError);

    s.guest.resetForEpoch(10);
    s.host.resetForEpoch(10);
    s.guestChannel.setEpoch(1);
    s.hostChannel.setEpoch(1);
    expect(s.guest.desync).toBeNull();
    const again = s.guest.awaitDecision(k(1));
    void s.host.awaitDecision(k(1));
    s.host.propose(k(1), "z");
    s.settle();
    expect(await again).toMatchObject({ seq: 10, payload: "z" });
  });
});
