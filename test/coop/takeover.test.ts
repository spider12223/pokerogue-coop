/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DECISION_KINDS, type DecisionKey } from "#coop/protocol";
import { ProposalRejectedError, type RejectReason, Sequencer } from "#coop/sequencer";
import { AfkClock, canTakeOver, DEFAULT_AFK_TIMERS, KEEP_WAITING_MS, takeoverPlan } from "#coop/takeover";
import { describe, expect, it } from "vitest";
import { FakeScheduler } from "./fake-scheduler";
import { createManualLink } from "./manual-link";

/**
 * AFK and take over (DECISIONS D17): the waiting player decides for the partner. The sequencer accepts whichever proposal
 * arrives first; the one that comes later is rejected.
 */

type HostOptions = Omit<ConstructorParameters<typeof Sequencer>[0], "role" | "transport">;

/**
 * @param options - The host's sequencer; by default a take over of the guest needs no wait (the tests of the wait pass
 * their own clock)
 */
function setup(
  validatePayload?: ConstructorParameters<typeof Sequencer>[0]["validatePayload"],
  options: HostOptions = { takeoverAfterMs: () => 0 },
) {
  const link = createManualLink();
  const host = new Sequencer({
    role: "host",
    transport: link.host,
    ...options,
    ...(validatePayload ? { validatePayload } : {}),
  });
  const guest = new Sequencer({ role: "guest", transport: link.guest });
  const settle = (): void => {
    for (let round = 0; round < 10 && (link.host.outbox.length > 0 || link.guest.outbox.length > 0); round++) {
      link.guest.deliverFromPeer();
      link.host.deliverFromPeer();
    }
  };
  const rejections: RejectReason[] = [];
  guest.onProposalRejected(({ reason }) => rejections.push(reason));
  return { host, guest, settle, rejections };
}

const learnKey: DecisionKey = { wave: 5, turn: 0, kind: "LEARN_MOVE", ref: "12:33" };
const commandKey: DecisionKey = { wave: 5, turn: 2, kind: "TURN_COMMANDS", ref: 12 };

describe("take over (D17)", () => {
  describe("the sequencer", () => {
    it("accepts a takeover for a key the other seat decides, and tells both clients", async () => {
      const { host, guest, settle } = setup();
      const onHost = host.awaitDecision(learnKey, { authors: ["host"] });
      const onGuest = guest.awaitDecision(learnKey, { authors: ["host"] });

      guest.propose(learnKey, { replaceIndex: null }, { takeover: true });
      settle();

      expect(await onHost).toMatchObject({ seq: 1, author: "guest", takeover: true, payload: { replaceIndex: null } });
      expect(await onGuest).toMatchObject({ seq: 1, author: "guest", takeover: true });
    });

    it("rejects the same proposal without the flag: only the decider may decide", () => {
      const { host, guest, settle, rejections } = setup();
      void host.awaitDecision(learnKey, { authors: ["host"] });
      void guest.awaitDecision(learnKey, { authors: ["host"] });

      guest.propose(learnKey, { replaceIndex: null });
      settle();

      expect(rejections).toEqual(["authorNotAllowed"]);
      expect(host.lastApplied).toBe(0);
    });

    it("rejects the original decider's late answer, and tells it (the guest takes over for the host)", async () => {
      const { host, guest, settle } = setup();
      const onHost = host.awaitDecision(learnKey, { authors: ["host"] });
      void guest.awaitDecision(learnKey, { authors: ["host"] });
      guest.propose(learnKey, { replaceIndex: null }, { takeover: true });
      settle();
      await onHost;

      // the host's player answers after all
      expect(() => host.propose(learnKey, { replaceIndex: 2 })).toThrow(ProposalRejectedError);
      try {
        host.propose(learnKey, { replaceIndex: 2 });
      } catch (error) {
        expect((error as ProposalRejectedError).reason).toBe("duplicate");
      }
      expect(host.lastApplied).toBe(1);
    });

    it("rejects the original decider's late answer, and tells it (the host takes over for the guest)", async () => {
      const { host, guest, settle, rejections } = setup();
      void host.awaitDecision(commandKey, { authors: ["guest"] });
      const onGuest = guest.awaitDecision(commandKey, { authors: ["guest"] });
      host.propose(commandKey, { command: null, pre: null }, { takeover: true });
      settle();
      expect(await onGuest).toMatchObject({ author: "host", takeover: true });

      // the guest's player returns and chooses: the host answers with a rejection
      guest.propose(commandKey, { command: { command: 0 }, pre: null });
      settle();
      expect(rejections).toEqual(["duplicate"]);
      expect(host.lastApplied).toBe(1);
    });

    it("sequences whichever of the two proposals arrives first", async () => {
      // the decider is first: the takeover is the late one
      const first = setup();
      const decided = first.host.awaitDecision(learnKey, { authors: ["host"] });
      void first.guest.awaitDecision(learnKey, { authors: ["host"] });
      first.host.propose(learnKey, { replaceIndex: 1 });
      first.guest.propose(learnKey, { replaceIndex: null }, { takeover: true });
      first.settle();
      expect(await decided).toMatchObject({ author: "host", payload: { replaceIndex: 1 } });
      expect(first.rejections).toEqual(["duplicate"]);

      // the takeover is first: the decider's is the late one
      const second = setup();
      const taken = second.host.awaitDecision(learnKey, { authors: ["host"] });
      void second.guest.awaitDecision(learnKey, { authors: ["host"] });
      second.guest.propose(learnKey, { replaceIndex: null }, { takeover: true });
      second.settle();
      expect(await taken).toMatchObject({ author: "guest", takeover: true });
      expect(() => second.host.propose(learnKey, { replaceIndex: 1 })).toThrow(ProposalRejectedError);
    });

    it("still checks the payload of a takeover", () => {
      const { host, guest, settle, rejections } = setup((_key, payload) => payload === null);
      void host.awaitDecision(learnKey, { authors: ["host"] });
      void guest.awaitDecision(learnKey, { authors: ["host"] });

      guest.propose(learnKey, { replaceIndex: 9 }, { takeover: true });
      settle();

      expect(rejections).toEqual(["invalid"]);
      expect(host.lastApplied).toBe(0);
    });

    it("parks a takeover for a key the host has not opened yet, and sequences it when it opens", async () => {
      const { host, guest, settle } = setup();
      void guest.awaitDecision(learnKey, { authors: ["host"] });
      guest.propose(learnKey, { replaceIndex: null }, { takeover: true });
      settle();
      expect(host.parkedCount).toBe(1);

      const onHost = host.awaitDecision(learnKey, { authors: ["host"] });
      settle();
      expect(await onHost).toMatchObject({ author: "guest", takeover: true });
      expect(host.parkedCount).toBe(0);
    });

    it("knows which decisions reached it", async () => {
      const { host, guest, settle } = setup();
      void host.awaitDecision(learnKey, { authors: ["host"] });
      void guest.awaitDecision(learnKey, { authors: ["host"] });
      expect(guest.hasDecision(learnKey)).toBe(false);
      host.propose(learnKey, { replaceIndex: 0 });
      settle();
      expect(host.hasDecision(learnKey)).toBe(true);
      expect(guest.hasDecision(learnKey)).toBe(true);
      expect(guest.hasDecision(commandKey)).toBe(false);
    });
  });

  describe("what the host lets the guest take over (a guest that is not what it says it is)", () => {
    const tradeKey = (kind: "TRADE_ACCEPT" | "TRADE_PROPOSE" | "TRADE_DECLINE"): DecisionKey => ({
      wave: 5,
      turn: 0,
      kind,
      ref: "0:1",
    });

    it.each([
      ["TRADE_ACCEPT", tradeKey("TRADE_ACCEPT"), null],
      ["TRADE_PROPOSE", tradeKey("TRADE_PROPOSE"), { give: 3, want: 4 }],
      ["PARTY_EDIT", { wave: 5, turn: 0, kind: "PARTY_EDIT", ref: "0:1" } as DecisionKey, { t: "x" }],
      ["TRADE_REQUEST", { wave: 5, turn: 0, kind: "TRADE_REQUEST", ref: "0:1" } as DecisionKey, null],
    ] as const)("refuses a take over of %s", (_name, key, payload) => {
      const { host, guest, settle, rejections } = setup();
      void host.awaitDecision(key, { authors: ["host"] });
      void guest.awaitDecision(key, { authors: ["host"] });
      guest.propose(key, payload, { takeover: true });
      settle();
      expect(rejections).toEqual(["authorNotAllowed"]);
      expect(host.lastApplied).toBe(0);
    });

    it("lets the taker decline a trade proposal, with nothing in the answer", async () => {
      const { host, guest, settle } = setup();
      const decline = tradeKey("TRADE_DECLINE");
      const onHost = host.awaitDecision(decline, { authors: ["host"] });
      void guest.awaitDecision(decline, { authors: ["host"] });
      guest.propose(decline, null, { takeover: true });
      settle();
      expect(await onHost).toMatchObject({ author: "guest", takeover: true, payload: null });
    });

    it.each([
      ["a move forgotten for the host's Pokémon", learnKey, { replaceIndex: 1 }],
      ["a cancel of the host's evolution", { ...learnKey, kind: "EVOLUTION_CANCEL" } as DecisionKey, { cancel: true }],
      [
        "a release of the host's Pokémon",
        { ...learnKey, kind: "CATCH_RELEASE", ref: 9 } as DecisionKey,
        { release: 3 },
      ],
      ["a declined side action", { ...learnKey, kind: "SIDE_ACTION", ref: "4:0" } as DecisionKey, { accept: false }],
      ["something more", learnKey, { replaceIndex: null, extra: 1 }],
    ] as const)("refuses %s: a take over with a default proposes the default", (_name, key, payload) => {
      const { host, guest, settle, rejections } = setup();
      void host.awaitDecision(key, { authors: ["host"] });
      void guest.awaitDecision(key, { authors: ["host"] });
      guest.propose(key, payload, { takeover: true });
      settle();
      expect(rejections).toEqual(["invalid"]);
      expect(host.lastApplied).toBe(0);
    });

    describe("the wait (D17): the host must have waited for the decision", () => {
      const HINT = 30_000;

      function timed() {
        const scheduler = new FakeScheduler();
        return { scheduler, ...setup(undefined, { scheduler, takeoverAfterMs: () => HINT }) };
      }

      it("holds a take over that comes before the host waited the hint time, and sequences it then", async () => {
        const { scheduler, host, guest, settle, rejections } = timed();
        const onHost = host.awaitDecision(learnKey, { authors: ["host"] });
        void guest.awaitDecision(learnKey, { authors: ["host"] });
        scheduler.advance(1000);
        guest.propose(learnKey, { replaceIndex: null }, { takeover: true });
        settle();
        expect(host.lastApplied).toBe(0);
        expect(host.parkedCount).toBe(1);
        expect(rejections).toEqual([]);

        scheduler.advance(HINT - 1001);
        expect(host.lastApplied).toBe(0);
        scheduler.advance(1);
        settle();
        expect(await onHost).toMatchObject({ seq: 1, author: "guest", takeover: true });
        expect(host.parkedCount).toBe(0);
      });

      it("sequences a take over at once when the host has waited long enough", async () => {
        const { scheduler, host, guest, settle } = timed();
        const onHost = host.awaitDecision(learnKey, { authors: ["host"] });
        void guest.awaitDecision(learnKey, { authors: ["host"] });
        scheduler.advance(HINT);
        guest.propose(learnKey, { replaceIndex: null }, { takeover: true });
        settle();
        expect(await onHost).toMatchObject({ author: "guest", takeover: true });
      });

      it("lets the host's player answer meanwhile: the answer wins, the guest is told its take over is late", async () => {
        const { scheduler, host, guest, settle, rejections } = timed();
        const onHost = host.awaitDecision(learnKey, { authors: ["host"] });
        const onGuest = guest.awaitDecision(learnKey, { authors: ["host"] });
        guest.propose(learnKey, { replaceIndex: null }, { takeover: true });
        settle();
        host.propose(learnKey, { replaceIndex: 2 });
        settle();
        expect(await onHost).toMatchObject({ seq: 1, author: "host", payload: { replaceIndex: 2 } });
        expect(await onGuest).toMatchObject({ seq: 1, author: "host" });
        expect(rejections).toEqual(["duplicate"]);
        scheduler.advance(HINT * 2);
        settle();
        expect(host.lastApplied).toBe(1);
        expect(host.parkedCount).toBe(0);
      });

      it("holds a take over for a decision the host has not opened, and counts the wait from when it opens", async () => {
        const { scheduler, host, guest, settle } = timed();
        void guest.awaitDecision(learnKey, { authors: ["host"] });
        guest.propose(learnKey, { replaceIndex: null }, { takeover: true });
        settle();
        scheduler.advance(HINT * 3);
        expect(host.parkedCount).toBe(1);

        const onHost = host.awaitDecision(learnKey, { authors: ["host"] });
        scheduler.advance(HINT - 1);
        expect(host.lastApplied).toBe(0);
        scheduler.advance(1);
        settle();
        expect(await onHost).toMatchObject({ author: "guest", takeover: true });
      });

      it("lets a taker go on deciding for the host's player step by step, until the host's player decides again", async () => {
        const { scheduler, host, guest, settle } = timed();
        const step = (n: number): DecisionKey => ({ wave: 5, turn: 0, kind: "REWARD_PICK", ref: `1:${n}` });
        void host.awaitDecision(step(0), { authors: ["host"] });
        void guest.awaitDecision(step(0), { authors: ["host"] });
        scheduler.advance(HINT);
        guest.propose(step(0), { t: "reroll" }, { takeover: true });
        settle();
        expect(host.lastApplied).toBe(1);

        // the next step opens: the taker is still in the host's player's place
        void host.awaitDecision(step(1), { authors: ["host"] });
        void guest.awaitDecision(step(1), { authors: ["host"] });
        guest.propose(step(1), { t: "skip" }, { takeover: true });
        settle();
        expect(host.lastApplied).toBe(2);

        // the host's player is back: the next take over waits again
        void host.awaitDecision(step(2), { authors: ["host"] });
        void guest.awaitDecision(step(2), { authors: ["host"] });
        host.propose(step(2), { t: "skip" });
        settle();
        void host.awaitDecision(step(3), { authors: ["host"] });
        void guest.awaitDecision(step(3), { authors: ["host"] });
        guest.propose(step(3), { t: "skip" }, { takeover: true });
        settle();
        expect(host.lastApplied).toBe(3);
        expect(host.parkedCount).toBe(1);
      });

      it("does not wait for the host's own take over", async () => {
        const { host, guest, settle } = timed();
        void host.awaitDecision(commandKey, { authors: ["guest"] });
        const onGuest = guest.awaitDecision(commandKey, { authors: ["guest"] });
        host.propose(commandKey, { command: null, pre: null }, { takeover: true });
        settle();
        expect(await onGuest).toMatchObject({ author: "host", takeover: true });
      });

      it("forgets a held take over and its timer when the run is reloaded", () => {
        const { scheduler, host, guest, settle } = timed();
        void host.awaitDecision(learnKey, { authors: ["host"] }).catch(() => undefined);
        void guest.awaitDecision(learnKey, { authors: ["host"] }).catch(() => undefined);
        guest.propose(learnKey, { replaceIndex: null }, { takeover: true });
        settle();
        expect(scheduler.pending).toBe(1);
        host.resetForEpoch(5);
        expect(host.parkedCount).toBe(0);
        expect(scheduler.pending).toBe(0);
      });
    });
  });

  describe("what the taker decides for each kind of decision", () => {
    it("has a plan for every kind of decision", () => {
      for (const kind of DECISION_KINDS) {
        expect(takeoverPlan({ kind, ref: 1 })).toBeDefined();
      }
    });

    it.each([
      ["LEARN_MOVE", "12:33", { replaceIndex: null }],
      ["EVOLUTION_CANCEL", "12:44", { cancel: false }],
      ["EVOLUTION_CANCEL", "12:44:pause", { pause: false }],
      ["CATCH_RELEASE", 12, { release: null }],
      ["SIDE_ACTION", "12:0", { accept: true }],
      ["TRADE_DONE", "3:guest", { done: true }],
    ] as const)("%s (%s) has the default %j", (kind, ref, payload) => {
      expect(takeoverPlan({ kind, ref })).toEqual({ mode: "payload", payload });
    });

    it("answers a trade proposal by declining it", () => {
      for (const kind of ["TRADE_ACCEPT", "TRADE_DECLINE"] as const) {
        expect(takeoverPlan({ kind, ref: "2" })).toEqual({ mode: "payload", payload: null, kind: "TRADE_DECLINE" });
      }
    });

    it.each(["FAINT_SWITCH", "PIVOT_SWITCH", "BIOME"] as const)(
      "%s asks the taker, with the partner's own screen",
      kind => {
        expect(takeoverPlan({ kind, ref: 1 })).toEqual({ mode: "ask" });
      },
    );

    it.each([
      "TURN_COMMANDS",
      "REWARD_PICK",
      "REWARD_TARGET",
      "REROLL",
      "REWARD_LOCK",
      "SHOP_BUY",
      "REWARD_TRANSFER",
    ] as const)("%s is the phase's own: the command screen, or the picker's place on the reward screen", kind => {
      expect(takeoverPlan({ kind, ref: 1 })).toEqual({ mode: "custom" });
    });

    it("cannot be taken over where nobody waits for the partner's turn to propose", () => {
      expect(canTakeOver("TRADE_PROPOSE")).toBe(false);
      expect(canTakeOver("TRADE_CANCEL")).toBe(false);
      expect(canTakeOver("TRADE_REQUEST")).toBe(false);
      expect(canTakeOver("LEARN_MOVE")).toBe(true);
      expect(canTakeOver("TURN_COMMANDS")).toBe(true);
    });
  });

  describe("the AFK clock", () => {
    function clock(timers = DEFAULT_AFK_TIMERS) {
      const scheduler = new FakeScheduler();
      const events: string[] = [];
      const afk = new AfkClock(
        { onHint: () => events.push("hint"), onOffer: () => events.push("offer") },
        timers,
        scheduler,
      );
      return { scheduler, events, afk };
    }

    it("hints at 30 s and offers at 90 s", () => {
      const { scheduler, events, afk } = clock();
      afk.start();
      scheduler.advance(29_999);
      expect(events).toEqual([]);
      scheduler.advance(1);
      expect(events).toEqual(["hint"]);
      scheduler.advance(59_999);
      expect(events).toEqual(["hint"]);
      scheduler.advance(1);
      expect(events).toEqual(["hint", "offer"]);
    });

    it("can be shortened for tests", () => {
      const { scheduler, events, afk } = clock({ hintMs: 3000, takeoverMs: 6000 });
      afk.start();
      scheduler.advance(6000);
      expect(events).toEqual(["hint", "offer"]);
    });

    it("offers again after Keep waiting", () => {
      const { scheduler, events, afk } = clock();
      afk.start();
      scheduler.advance(90_000);
      afk.offerAgainLater();
      scheduler.advance(KEEP_WAITING_MS - 1);
      expect(events).toEqual(["hint", "offer"]);
      scheduler.advance(1);
      expect(events).toEqual(["hint", "offer", "offer"]);
    });

    it("says nothing once the decision came", () => {
      const { scheduler, events, afk } = clock();
      afk.start();
      scheduler.advance(10_000);
      afk.stop();
      scheduler.advance(200_000);
      expect(events).toEqual([]);
      expect(afk.isRunning).toBe(false);
      expect(scheduler.pending).toBe(0);
    });
  });
});
