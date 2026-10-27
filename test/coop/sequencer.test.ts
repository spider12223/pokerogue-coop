/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { DecisionKey, Envelope } from "#coop/protocol";
import { DesyncError, ProposalRejectedError, type RejectReason, Sequencer } from "#coop/sequencer";
import { describe, expect, it } from "vitest";
import { createManualLink } from "./manual-link";

const k = (turn: number, ref = 0, kind: DecisionKey["kind"] = "TURN_COMMANDS", wave = 1): DecisionKey => ({
  wave,
  turn,
  kind,
  ref,
});

function setup() {
  const link = createManualLink();
  const host = new Sequencer({ role: "host", transport: link.host });
  const guest = new Sequencer({ role: "guest", transport: link.guest });
  /** Deliver everything pending in both directions until quiet. */
  const settle = (): void => {
    for (let round = 0; round < 10 && (link.host.outbox.length > 0 || link.guest.outbox.length > 0); round++) {
      link.guest.deliverFromPeer();
      link.host.deliverFromPeer();
    }
  };
  return { ...link, hostSeq: host, guestSeq: guest, settle };
}

function sequenced(seq: number, key: DecisionKey, payload: unknown = null): Envelope {
  return { seq, key, author: "host", kind: "SEQUENCED", payload };
}

describe("Sequencer: sequencing", () => {
  it("host decisions get consecutive seqs and both clients consume them in order", async () => {
    const { hostSeq, guestSeq, settle } = setup();
    const hostGot = [hostSeq.awaitDecision(k(1)), hostSeq.awaitDecision(k(2)), hostSeq.awaitDecision(k(3))];
    const guestGot = [guestSeq.awaitDecision(k(1)), guestSeq.awaitDecision(k(2)), guestSeq.awaitDecision(k(3))];
    hostSeq.propose(k(1), "a");
    hostSeq.propose(k(2), "b");
    hostSeq.propose(k(3), "c");
    settle();

    const onHost = await Promise.all(hostGot);
    const onGuest = await Promise.all(guestGot);
    expect(onHost.map(d => [d.seq, d.payload])).toEqual([
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ]);
    expect(onGuest).toEqual(onHost);
    expect(hostSeq.lastApplied).toBe(3);
    expect(guestSeq.lastApplied).toBe(3);
  });

  it("a guest proposal is validated by the host, sequenced, and applied by both", async () => {
    const { hostSeq, guestSeq, settle } = setup();
    const onHost = hostSeq.awaitDecision(k(1, 1));
    const onGuest = guestSeq.awaitDecision(k(1, 1));
    guestSeq.propose(k(1, 1), { move: 7 });
    settle();
    const decision = await onHost;
    expect(decision).toEqual({ seq: 1, key: k(1, 1), author: "guest", payload: { move: 7 } });
    expect(await onGuest).toEqual(decision);
  });

  it("buffers a decision that arrives before the simulation asks for it", async () => {
    const { hostSeq, guestSeq, settle } = setup();
    void hostSeq.awaitDecision(k(1)); // the host sim is at the decision, the guest sim is not yet
    hostSeq.propose(k(1), "early");
    settle();
    expect(guestSeq.readyCount).toBe(1);
    expect(await guestSeq.awaitDecision(k(1))).toMatchObject({ seq: 1, payload: "early" });
    expect(guestSeq.readyCount).toBe(0);
  });

  it("parks a guest proposal until the host simulation opens the expectation", async () => {
    const { hostSeq, guestSeq, settle } = setup();
    guestSeq.propose(k(5, 1), "ahead"); // the guest is ahead of the host
    settle();
    expect(hostSeq.parkedCount).toBe(1);
    expect(hostSeq.lastApplied).toBe(0);

    const onHost = hostSeq.awaitDecision(k(5, 1));
    expect(hostSeq.parkedCount).toBe(0);
    settle();
    expect((await onHost).payload).toBe("ahead");
    expect(await guestSeq.awaitDecision(k(5, 1))).toMatchObject({ seq: 1, author: "guest" });
  });
});

describe("Sequencer: delivery", () => {
  it("applies decisions in seq order when they arrive out of order", async () => {
    const { host, guest, hostSeq, guestSeq } = setup();
    for (const turn of [1, 2, 3]) {
      void hostSeq.awaitDecision(k(turn));
      hostSeq.propose(k(turn), turn);
    }
    expect(host.outbox).toHaveLength(3);

    guest.deliverFromPeer(pending => [pending[2]!, pending[0]!, pending[1]!]);
    expect(guestSeq.earlyCount).toBe(0);
    expect(guestSeq.readyCount).toBe(3);
    const got = [
      await guestSeq.awaitDecision(k(1)),
      await guestSeq.awaitDecision(k(2)),
      await guestSeq.awaitDecision(k(3)),
    ];
    expect(got.map(d => d.seq)).toEqual([1, 2, 3]);
  });

  it("holds a decision that arrives ahead of a gap until the gap is filled", async () => {
    const { guest, guestSeq } = setup();
    guest.receive(sequenced(2, k(2)));
    guest.receive(sequenced(3, k(3)));
    expect(guestSeq.earlyCount).toBe(2);
    expect(guestSeq.readyCount).toBe(0);
    guest.receive(sequenced(1, k(1)));
    expect(guestSeq.earlyCount).toBe(0);
    expect(guestSeq.readyCount).toBe(3);
    expect((await guestSeq.awaitDecision(k(1))).seq).toBe(1);
  });

  it("consumes a duplicated decision once", async () => {
    const { host, guest, hostSeq, guestSeq } = setup();
    void hostSeq.awaitDecision(k(1));
    hostSeq.propose(k(1), "x");
    void hostSeq.awaitDecision(k(2));
    hostSeq.propose(k(2), "y");
    guest.deliverFromPeer(undefined, true);
    guest.deliverFromPeer(undefined, true); // the same two messages again
    expect(host.outbox).toHaveLength(2);
    expect(guestSeq.readyCount).toBe(2);
    expect((await guestSeq.awaitDecision(k(1))).payload).toBe("x");
    expect((await guestSeq.awaitDecision(k(2))).payload).toBe("y");
    expect(guestSeq.desync).toBeNull();
  });

  it("ignores a duplicate of an already consumed decision", async () => {
    const { guest, guestSeq } = setup();
    guest.receive(sequenced(1, k(1)));
    await guestSeq.awaitDecision(k(1));
    guest.receive(sequenced(1, k(1)));
    expect(guestSeq.readyCount).toBe(0);
    expect(guestSeq.desync).toBeNull();
  });

  it("treats the same seq with another key as a desync", async () => {
    const { guest, guestSeq } = setup();
    guest.receive(sequenced(1, k(1)));
    await guestSeq.awaitDecision(k(1));
    const pending = guestSeq.awaitDecision(k(2));
    guest.receive(sequenced(1, k(9)));
    await expect(pending).rejects.toBeInstanceOf(DesyncError);
    expect(guestSeq.desync?.seq).toBe(1);
  });

  it("detects two different early decisions for one seq", async () => {
    const { guest, guestSeq } = setup();
    const pending = guestSeq.awaitDecision(k(1));
    guest.receive(sequenced(2, k(2)));
    guest.receive(sequenced(2, k(3)));
    await expect(pending).rejects.toBeInstanceOf(DesyncError);
  });
});

describe("Sequencer: key assertion", () => {
  it("rejects with DesyncError when the next sequenced key is not the expected one", async () => {
    const { hostSeq, guestSeq, settle } = setup();
    void hostSeq.awaitDecision(k(1));
    hostSeq.propose(k(1));
    settle();
    // The guest simulation believes it is at turn 2, the sequence says turn 1.
    const pending = guestSeq.awaitDecision(k(2));
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DesyncError);
    expect((error as DesyncError).expected).toEqual([k(2)]);
    expect((error as DesyncError).actual).toEqual(k(1));
    expect((error as DesyncError).seq).toBe(1);
  });

  it("notices a mismatch that arrives while the simulation is already waiting", async () => {
    const { guest, guestSeq } = setup();
    const pending = guestSeq.awaitDecision(k(4, 0, "REWARD_PICK"));
    guest.receive(sequenced(1, k(4, 0, "REWARD_TARGET")));
    await expect(pending).rejects.toBeInstanceOf(DesyncError);
  });

  it("is sticky: after a desync nothing more is delivered or accepted", async () => {
    const { guest, guestSeq } = setup();
    const pending = guestSeq.awaitDecision(k(1));
    guest.receive(sequenced(1, k(2)));
    await expect(pending).rejects.toBeInstanceOf(DesyncError);
    await expect(guestSeq.awaitDecision(k(2))).rejects.toBeInstanceOf(DesyncError);
    expect(() => guestSeq.propose(k(3))).toThrow(DesyncError);
    let notified = 0;
    guestSeq.onDesync(() => notified++);
    guest.receive(sequenced(2, k(3)));
    expect(notified).toBe(0);
  });

  it("calls desync listeners once", async () => {
    const { guest, guestSeq } = setup();
    const seen: DesyncError[] = [];
    guestSeq.onDesync(error => seen.push(error));
    const pending = guestSeq.awaitDecision(k(1));
    guest.receive(sequenced(1, k(2)));
    await pending.catch(() => {});
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(guestSeq.desync);
  });

  it("supports simultaneous commands: several open awaits accept their decisions in either order", async () => {
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      const { hostSeq, guestSeq, settle } = setup();
      const hostBoth = hostSeq.awaitAll([k(1, 0), k(1, 1)]);
      const guestSlot0 = guestSeq.awaitDecision(k(1, 0));
      const guestSlot1 = guestSeq.awaitDecision(k(1, 1));
      for (const ref of order) {
        if (ref === 0) {
          hostSeq.propose(k(1, 0), "p1");
        } else {
          guestSeq.propose(k(1, 1), "p2");
          settle();
        }
      }
      settle();
      const decisions = await hostBoth;
      expect(decisions.map(d => d.payload)).toEqual(["p1", "p2"]); // in the order of the keys asked
      expect((await guestSlot0).payload).toBe("p1");
      expect((await guestSlot1).payload).toBe("p2");
      expect(decisions.map(d => d.seq).sort()).toEqual([1, 2]);
    }
  });

  it("awaitDecision with an array accepts any of the keys", async () => {
    const { hostSeq } = setup();
    const pending = hostSeq.awaitDecision([k(1, 0), k(1, 1)]);
    hostSeq.propose(k(1, 1), "slot1");
    expect((await pending).key).toEqual(k(1, 1));
  });

  it("rejects awaits that are not decision keys", async () => {
    const { guestSeq } = setup();
    await expect(guestSeq.awaitDecision([])).rejects.toBeInstanceOf(TypeError);
    await expect(guestSeq.awaitDecision({ wave: 1 } as unknown as DecisionKey)).rejects.toBeInstanceOf(TypeError);
  });
});

describe("Sequencer: host validation", () => {
  async function rejectionOf(
    sequencer: Sequencer,
    act: () => void,
  ): Promise<{ key: DecisionKey; reason: RejectReason }> {
    return await new Promise(resolve => {
      sequencer.onProposalRejected(resolve);
      act();
    });
  }

  it("refuses an author the expectation does not allow, and tells the guest", async () => {
    const { hostSeq, guestSeq, settle } = setup();
    void hostSeq.awaitDecision(k(1, 0), { authors: ["host"] }); // slot 0 belongs to the host's player
    const rejected = rejectionOf(guestSeq, () => {
      guestSeq.propose(k(1, 0));
      settle();
    });
    expect(await rejected).toEqual({ key: k(1, 0), reason: "authorNotAllowed" });
    expect(hostSeq.lastApplied).toBe(0);
    // The owner can still decide it.
    hostSeq.propose(k(1, 0), "mine");
    expect(hostSeq.lastApplied).toBe(1);
  });

  it("refuses the host's own proposal when the policy gives the decision to the guest", () => {
    const link = createManualLink();
    const host = new Sequencer({ role: "host", transport: link.host, allowedAuthors: () => ["guest"] });
    expect(() => host.propose(k(1))).toThrow(ProposalRejectedError);
    expect(host.lastApplied).toBe(0);
  });

  it("refuses a guest proposal the policy forbids", async () => {
    const link = createManualLink();
    const host = new Sequencer({
      role: "host",
      transport: link.host,
      allowedAuthors: key => (key.kind === "REROLL" ? ["host"] : ["host", "guest"]),
    });
    const guest = new Sequencer({ role: "guest", transport: link.guest });
    void host.awaitDecision(k(1, 0, "REROLL"));
    const rejected = rejectionOf(guest, () => {
      guest.propose(k(1, 0, "REROLL"));
      link.host.deliverFromPeer();
      link.guest.deliverFromPeer();
    });
    expect((await rejected).reason).toBe("authorNotAllowed");
  });

  it("refuses a key that was already sequenced", async () => {
    const { hostSeq, guestSeq, settle } = setup();
    void hostSeq.awaitDecision(k(1));
    hostSeq.propose(k(1));
    expect(() => hostSeq.propose(k(1))).toThrow(ProposalRejectedError);
    const rejected = rejectionOf(guestSeq, () => {
      guestSeq.propose(k(1));
      settle();
    });
    expect((await rejected).reason).toBe("duplicate");
  });

  it("refuses malformed or mis-attributed proposals that come over the wire", () => {
    const { host, guest, hostSeq } = setup();
    const rejections: RejectReason[] = [];
    hostSeq.onProposalRejected(info => rejections.push(info.reason));
    host.receive({
      key: { wave: 1, turn: 1, kind: "NOPE", ref: 0 } as unknown as DecisionKey,
      author: "guest",
      kind: "PROPOSE",
      payload: null,
    });
    host.receive({ key: k(1), author: "host", kind: "PROPOSE", payload: null }); // claims to be the host's
    expect(rejections).toEqual(["badKey", "authorMismatch"]);
    expect(guest.outbox.length).toBe(0);
    expect(host.outbox.map(m => m.kind)).toEqual(["REJECT", "REJECT"]);
  });

  it("refuses proposals that pile up for decisions the simulation never opens, without stopping the run", () => {
    const link = createManualLink();
    const host = new Sequencer({ role: "host", transport: link.host, maxParked: 2 });
    const rejections: RejectReason[] = [];
    host.onProposalRejected(({ reason }) => rejections.push(reason));
    void host.awaitDecision(k(99));
    for (const turn of [1, 2, 3]) {
      link.host.receive({ key: k(turn), author: "guest", kind: "PROPOSE", payload: null });
    }
    expect(rejections).toEqual(["full"]);
    expect(host.parkedCount).toBe(2);
    expect(host.desync).toBeNull();
    expect(link.host.outbox.map(m => [m.kind, (m.payload as { reason?: string } | null)?.reason])).toEqual([
      ["REJECT", "full"],
    ]);
  });

  it("refuses a proposal that is too big, and parked ones that are too big together", () => {
    const link = createManualLink();
    const host = new Sequencer({ role: "host", transport: link.host });
    const rejections: RejectReason[] = [];
    host.onProposalRejected(({ reason }) => rejections.push(reason));
    link.host.receive({ key: k(1), author: "guest", kind: "PROPOSE", payload: "x".repeat(20_000) });
    expect(rejections).toEqual(["invalid"]);
    for (let turn = 2; turn < 40; turn++) {
      link.host.receive({ key: k(turn), author: "guest", kind: "PROPOSE", payload: "x".repeat(15_000) });
    }
    // 17 of them fill the room of the parked proposals (256 K characters), the others are refused
    expect(host.parkedCount).toBe(17);
    expect(rejections.filter(reason => reason === "full")).toHaveLength(38 - 17);
    expect(host.desync).toBeNull();
  });
});

describe("Sequencer: legality before sequencing (D24)", () => {
  function legalSetup() {
    const s = setup();
    const check = (_key: DecisionKey, payload: unknown): string | null => (payload === "bad" ? "a bad payload" : null);
    s.hostSeq.setLegality(check);
    s.guestSeq.setLegality(check);
    const rejections: RejectReason[] = [];
    s.guestSeq.onProposalRejected(({ reason }) => rejections.push(reason));
    return { ...s, rejections };
  }

  it("refuses an illegal proposal of the guest as invalid instead of sequencing it: nobody reloads", async () => {
    const { hostSeq, guestSeq, settle, rejections } = legalSetup();
    const onHost = hostSeq.awaitDecision(k(1));
    const onGuest = guestSeq.awaitDecision(k(1));
    guestSeq.propose(k(1), "bad");
    settle();
    expect(rejections).toEqual(["invalid"]);
    expect(hostSeq.lastApplied).toBe(0);
    expect(hostSeq.desync).toBeNull();
    expect(guestSeq.desync).toBeNull();

    // the window is still open: a legal answer goes through
    guestSeq.propose(k(1), "good");
    settle();
    expect((await onHost).payload).toBe("good");
    expect((await onGuest).payload).toBe("good");
  });

  it("checks a parked proposal of the guest when its decision opens", () => {
    const { hostSeq, guestSeq, settle, rejections } = legalSetup();
    guestSeq.propose(k(1), "bad");
    settle();
    expect(hostSeq.parkedCount).toBe(1);
    void hostSeq.awaitDecision(k(1));
    settle();
    expect(rejections).toEqual(["invalid"]);
    expect(hostSeq.parkedCount).toBe(0);
    expect(hostSeq.desync).toBeNull();
  });

  it("still stops at an illegal decision of the host's own (its state is what is wrong: a reload)", async () => {
    const { hostSeq, settle } = legalSetup();
    const onHost = hostSeq.awaitDecision(k(1));
    hostSeq.propose(k(1), "bad");
    settle();
    await expect(onHost).rejects.toBeInstanceOf(DesyncError);
  });
});

describe("Sequencer: a decision is made once", () => {
  it("stops both clients when a key that was already used is awaited again, instead of waiting forever", async () => {
    const { hostSeq, guestSeq, settle } = setup();
    const first = [hostSeq.awaitDecision(k(1)), guestSeq.awaitDecision(k(1))];
    hostSeq.propose(k(1), "a");
    settle();
    await Promise.all(first);

    await expect(hostSeq.awaitDecision(k(1))).rejects.toBeInstanceOf(DesyncError);
    await expect(guestSeq.awaitDecision([k(2), k(1)])).rejects.toThrow(/already made is awaited again/);
    expect(hostSeq.desync).not.toBeNull();
    expect(guestSeq.desync).not.toBeNull();
  });

  it("still hands over a decision that came before it was awaited (a late proposal is dropped, the decision is not)", async () => {
    const { hostSeq, guestSeq, settle } = setup();
    void hostSeq.awaitDecision(k(1));
    hostSeq.propose(k(1), "a");
    settle();
    // the guest's simulation has not asked yet: it knows the decision, and its own late proposal would be a duplicate
    expect(guestSeq.hasDecision(k(1))).toBe(true);
    expect((await guestSeq.awaitDecision(k(1))).payload).toBe("a");
    expect(guestSeq.desync).toBeNull();
  });

  it("lets a key be used again in a new epoch (the wave is played again)", async () => {
    const { hostSeq, guestSeq, settle } = setup();
    const first = [hostSeq.awaitDecision(k(1)), guestSeq.awaitDecision(k(1))];
    hostSeq.propose(k(1), "a");
    settle();
    await Promise.all(first);
    hostSeq.resetForEpoch(3);
    guestSeq.resetForEpoch(3);
    const again = [hostSeq.awaitDecision(k(1)), guestSeq.awaitDecision(k(1))];
    hostSeq.propose(k(1), "b");
    settle();
    expect((await Promise.all(again)).map(d => d.payload)).toEqual(["b", "b"]);
  });
});

describe("Sequencer: decisions ahead of a gap", () => {
  it("stops when too many decisions wait for a gap that never closes", async () => {
    const link = createManualLink();
    const guest = new Sequencer({ role: "guest", transport: link.guest, maxEarly: 3 });
    const pending = guest.awaitDecision(k(1));
    for (const seq of [2, 3, 4]) {
      link.guest.receive(sequenced(seq, k(seq)));
    }
    expect(guest.earlyCount).toBe(3);
    expect(guest.desync).toBeNull();
    link.guest.receive(sequenced(5, k(5)));
    await expect(pending).rejects.toThrow(/ahead of a gap/);
  });

  it("stops at a decision that is far ahead of the next one", async () => {
    const link = createManualLink();
    const guest = new Sequencer({ role: "guest", transport: link.guest, maxEarly: 3 });
    const pending = guest.awaitDecision(k(1));
    link.guest.receive(sequenced(1_000_000, k(2)));
    await expect(pending).rejects.toThrow(/ahead of a gap/);
    expect(guest.earlyCount).toBe(0);
  });
});

describe("Sequencer: lifecycle", () => {
  it("close rejects pending awaits and ignores later messages", async () => {
    const { guest, guestSeq } = setup();
    const pending = guestSeq.awaitDecision(k(1));
    guestSeq.close();
    await expect(pending).rejects.toThrow(/closed/);
    guest.receive(sequenced(1, k(1)));
    expect(guestSeq.readyCount).toBe(0);
    await expect(guestSeq.awaitDecision(k(1))).rejects.toThrow(/closed/);
  });

  it("starts at firstSeq so a resumed run keeps its numbering", async () => {
    const link = createManualLink();
    const host = new Sequencer({ role: "host", transport: link.host, firstSeq: 41 });
    const guest = new Sequencer({ role: "guest", transport: link.guest, firstSeq: 41 });
    void host.awaitDecision(k(1));
    host.propose(k(1));
    link.guest.deliverFromPeer();
    expect((await guest.awaitDecision(k(1))).seq).toBe(41);
  });
});
