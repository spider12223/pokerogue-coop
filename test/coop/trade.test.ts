/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { AccountSnapshot } from "#coop/account-snapshot";
import { OwnerMap } from "#coop/ownership";
import type { BuildIdentity, Seat } from "#coop/protocol";
import { type RejectReason, Sequencer } from "#coop/sequencer";
import { endCoopSession, startCoopSession } from "#coop/session";
import {
  applyTrade,
  checkTradeProposal,
  isTradeDonePayload,
  isTradeProposePayload,
  TradeState,
  tradeDoneKey,
  tradeKey,
} from "#coop/trade";
import { afterEach, describe, expect, it } from "vitest";
import { createManualLink } from "./manual-link";

/**
 * The rules and the state machine of trading (DECISIONS D11): who may offer what, the gift rule, and the window of
 * decisions that both clients run in the same order.
 */

function owners(map: Record<number, Seat>): OwnerMap {
  const owned = new OwnerMap();
  for (const [id, seat] of Object.entries(map)) {
    owned.set(Number(id), seat);
  }
  return owned;
}

/** Three each: host 1, 2, 3; guest 4, 5, 6 */
const EVEN = { 1: "host", 2: "host", 3: "host", 4: "guest", 5: "guest", 6: "guest" } as const;

describe("what may be proposed", () => {
  it("allows a 1-for-1 trade: one of the proposer's for one of the partner's", () => {
    expect(checkTradeProposal("host", { give: 1, want: 4 }, owners(EVEN))).toBeNull();
    expect(checkTradeProposal("guest", { give: 6, want: 2 }, owners(EVEN))).toBeNull();
  });

  it("refuses to give what is not the proposer's, and to want what is not the partner's", () => {
    expect(checkTradeProposal("host", { give: 4, want: 1 }, owners(EVEN))).toBe("notYours");
    expect(checkTradeProposal("host", { give: 1, want: 2 }, owners(EVEN))).toBe("notTheirs");
    expect(checkTradeProposal("host", { give: 99, want: null }, owners(EVEN))).toBe("notYours");
    expect(checkTradeProposal("host", { give: 1, want: 99 }, owners(EVEN))).toBe("notTheirs");
  });

  it("allows a gift whatever the counts, as long as the giver keeps one of their own", () => {
    // three each: either may give one away, and the other then has four
    expect(checkTradeProposal("host", { give: 1, want: null }, owners(EVEN))).toBeNull();
    expect(checkTradeProposal("guest", { give: 4, want: null }, owners(EVEN))).toBeNull();
    // the one who has fewer may give too
    const lopsided = owners({ 1: "host", 2: "host", 3: "host", 7: "host", 4: "guest", 5: "guest" });
    expect(checkTradeProposal("guest", { give: 4, want: null }, lopsided)).toBeNull();
    // ... but not their last one: they would have nothing to play
    const threeToOne = owners({ 1: "host", 2: "host", 3: "host", 4: "guest" });
    expect(checkTradeProposal("guest", { give: 4, want: null }, threeToOne)).toBe("lastOne");
    // a 1-for-1 trade of a last one is fine: the count stays
    expect(checkTradeProposal("guest", { give: 4, want: 1 }, threeToOne)).toBeNull();
  });

  it("checks the shape of the payloads", () => {
    expect(isTradeProposePayload({ give: 1, want: 2 })).toBe(true);
    expect(isTradeProposePayload({ give: 1, want: null })).toBe(true);
    expect(isTradeProposePayload({ give: 1 })).toBe(false);
    expect(isTradeProposePayload({ give: -1, want: null })).toBe(false);
    expect(isTradeProposePayload({ give: 1.5, want: null })).toBe(false);
    expect(isTradeProposePayload(null)).toBe(false);
    expect(isTradeDonePayload({ done: true })).toBe(true);
    expect(isTradeDonePayload({ done: "yes" })).toBe(false);
  });
});

describe("an accepted trade", () => {
  it("swaps the owners of the two Pokémon and changes nothing else", () => {
    const map = owners(EVEN);
    applyTrade(map, "host", { give: 1, want: 4 });
    expect(map.toJSON()).toEqual({ "1": "guest", "2": "host", "3": "host", "4": "host", "5": "guest", "6": "guest" });
    expect(map.countBySeat()).toEqual({ host: 3, guest: 3 });
  });

  it("hands over a gift", () => {
    const map = owners({ 1: "host", 2: "host", 3: "host", 4: "guest" });
    applyTrade(map, "host", { give: 1, want: null });
    expect(map.toJSON()).toEqual({ "1": "guest", "2": "host", "3": "host", "4": "guest" });
    expect(map.countBySeat()).toEqual({ host: 2, guest: 2 });
  });
});

describe("the trade window", () => {
  const WAVE = 12;

  it("opens with the proposal and both seats' done", () => {
    const state = new TradeState();
    expect(state.window(WAVE).map(entry => `${entry.key.kind}:${entry.key.ref}:${entry.authors ?? "both"}`)).toEqual([
      "TRADE_PROPOSE:0:both",
      "TRADE_DONE:0:host:host",
      "TRADE_DONE:0:guest:guest",
    ]);
  });

  it("asks the other seat for an answer once a proposal is sequenced; the proposer may withdraw", () => {
    const state = new TradeState();
    state.apply({ key: tradeKey(WAVE, "TRADE_PROPOSE", 0), author: "host", payload: { give: 1, want: 4 } });
    expect(state.pending).toEqual({ proposer: "host", give: 1, want: 4 });
    expect(state.window(WAVE).map(entry => `${entry.key.kind}:${entry.key.ref}:${entry.authors}`)).toEqual([
      "TRADE_ACCEPT:1:guest",
      "TRADE_DECLINE:1:guest",
      "TRADE_CANCEL:1:host",
    ]);
  });

  it("accepts: the trade is reported for the caller to apply, and the window goes back", () => {
    const state = new TradeState();
    state.apply({ key: tradeKey(WAVE, "TRADE_PROPOSE", 0), author: "guest", payload: { give: 5, want: null } });
    const effect = state.apply({ key: tradeKey(WAVE, "TRADE_ACCEPT", 1), author: "host", payload: null });
    expect(effect).toEqual({ t: "accepted", trade: { proposer: "guest", give: 5, want: null } });
    expect(state.pending).toBeNull();
    expect(state.accepted).toHaveLength(1);
    expect(state.step).toBe(2);
    expect(state.window(WAVE)[0].key.ref).toBe("2");
  });

  it("declines, and the proposer's withdrawal, leave nothing accepted", () => {
    const state = new TradeState();
    state.apply({ key: tradeKey(WAVE, "TRADE_PROPOSE", 0), author: "host", payload: { give: 1, want: 4 } });
    expect(state.apply({ key: tradeKey(WAVE, "TRADE_DECLINE", 1), author: "guest", payload: null }).t).toBe("declined");
    state.apply({ key: tradeKey(WAVE, "TRADE_PROPOSE", 2), author: "host", payload: { give: 1, want: 4 } });
    expect(state.apply({ key: tradeKey(WAVE, "TRADE_CANCEL", 3), author: "host", payload: null }).t).toBe("cancelled");
    expect(state.accepted).toHaveLength(0);
    expect(state.pending).toBeNull();
  });

  it("is over when both are done; a new proposal takes the done back", () => {
    const state = new TradeState();
    state.apply({ key: tradeDoneKey(WAVE, 0, "host"), author: "host", payload: { done: true } });
    expect(state.finished).toBe(false);
    // the guest proposes: the host is not done any more
    state.apply({ key: tradeKey(WAVE, "TRADE_PROPOSE", 1), author: "guest", payload: { give: 4, want: 1 } });
    expect(state.done).toEqual({ host: false, guest: false });
    state.apply({ key: tradeKey(WAVE, "TRADE_DECLINE", 2), author: "host", payload: null });
    state.apply({ key: tradeDoneKey(WAVE, 3, "guest"), author: "guest", payload: { done: true } });
    expect(state.finished).toBe(false);
    state.apply({ key: tradeDoneKey(WAVE, 4, "host"), author: "host", payload: { done: true } });
    expect(state.finished).toBe(true);
    // done can be taken back
    state.apply({ key: tradeDoneKey(WAVE, 5, "guest"), author: "guest", payload: { done: false } });
    expect(state.finished).toBe(false);
  });

  describe("run by both clients through the sequencer", () => {
    function setup() {
      const link = createManualLink();
      const host = new Sequencer({ role: "host", transport: link.host });
      const guest = new Sequencer({ role: "guest", transport: link.guest });
      const rejections: RejectReason[] = [];
      const hostRejections: RejectReason[] = [];
      guest.onProposalRejected(({ reason }) => rejections.push(reason));
      host.onProposalRejected(({ reason }) => hostRejections.push(reason));
      const settle = (): void => {
        for (let round = 0; round < 10 && (link.host.outbox.length > 0 || link.guest.outbox.length > 0); round++) {
          link.guest.deliverFromPeer();
          link.host.deliverFromPeer();
        }
      };
      return { host, guest, settle, rejections, hostRejections };
    }

    /** One step on one client: wait for a decision of the window and feed it to the state */
    async function step(sequencer: Sequencer, state: TradeState, map: OwnerMap): Promise<void> {
      const decision = await sequencer.awaitOneOf(state.window(WAVE));
      const effect = state.apply(decision);
      if (effect.t === "accepted") {
        applyTrade(map, effect.trade.proposer, effect.trade);
      }
    }

    it("ends with the same owners on both clients", async () => {
      const { host, guest, settle, hostRejections } = setup();
      const onHost = { state: new TradeState(), map: owners(EVEN) };
      const onGuest = { state: new TradeState(), map: owners(EVEN) };
      const both = async (): Promise<void> => {
        const steps = [step(host, onHost.state, onHost.map), step(guest, onGuest.state, onGuest.map)];
        settle();
        await Promise.all(steps);
      };

      // the host offers its 1 for the guest's 4; the guest agrees
      host.propose(tradeKey(WAVE, "TRADE_PROPOSE", 0), { give: 1, want: 4 });
      await both();
      guest.propose(tradeKey(WAVE, "TRADE_ACCEPT", 1), null);
      await both();
      expect(onHost.map.toJSON()).toEqual(onGuest.map.toJSON());
      expect(onHost.map.get(1)).toBe("guest");
      expect(onHost.map.get(4)).toBe("host");

      // the host cannot answer its own proposal, nor can the guest withdraw the host's
      guest.propose(tradeKey(WAVE, "TRADE_PROPOSE", 2), { give: 5, want: 2 });
      await both();
      host.propose(tradeKey(WAVE, "TRADE_CANCEL", 3), null);
      host.propose(tradeKey(WAVE, "TRADE_ACCEPT", 3), null);
      await both();
      expect(hostRejections).toEqual(["authorNotAllowed"]);

      // both done
      host.propose(tradeDoneKey(WAVE, 4, "host"), { done: true });
      await both();
      guest.propose(tradeDoneKey(WAVE, 5, "guest"), { done: true });
      await both();
      expect(onHost.state.finished).toBe(true);
      expect(onGuest.state.finished).toBe(true);
      expect(onHost.map.toJSON()).toEqual(onGuest.map.toJSON());
      expect(onHost.state.accepted).toEqual(onGuest.state.accepted);
    });

    it("rejects what a step that is over still had on offer, and what was already used", async () => {
      const { host, guest, settle, rejections } = setup();
      const onHost = { state: new TradeState(), map: owners(EVEN) };
      const onGuest = { state: new TradeState(), map: owners(EVEN) };
      const steps = [step(host, onHost.state, onHost.map), step(guest, onGuest.state, onGuest.map)];
      host.propose(tradeKey(WAVE, "TRADE_PROPOSE", 0), { give: 1, want: 4 });
      settle();
      await Promise.all(steps);
      // the guest proposes in step 0 again, and says it is done in step 0, as if the window had not moved on
      guest.propose(tradeKey(WAVE, "TRADE_PROPOSE", 0), { give: 4, want: 1 });
      guest.propose(tradeDoneKey(WAVE, 0, "guest"), { done: true });
      settle();
      expect(rejections).toEqual(["duplicate", "closed"]);
    });
  });
});

describe("the save block after a trade", () => {
  afterEach(() => {
    endCoopSession();
  });

  const build: BuildIdentity = {
    protocolVersion: 3,
    gitSha: "a6995c571a092e762ea036589bb6f3a8fa4f5dbd",
    dirtyHash: "clean",
    buildMode: "test",
    overridesHash: "0",
  };
  const account = (trainerId: number): AccountSnapshot => ({
    trainerId,
    secretId: 7,
    unlocked: { eviolite: false, miniBlackHole: false },
    caught: {},
    eggMoves: {},
  });
  const snapshot = { host: account(1), guest: account(2) };

  it("keeps the new owners and the number of trades through a save and a load", () => {
    const saving = startCoopSession({ seat: "host", runSeed: "s", build, accountSnapshot: snapshot });
    for (const [id, seat] of Object.entries(EVEN)) {
      saving.ownership.set(Number(id), seat);
    }
    applyTrade(saving.ownership, "host", { give: 1, want: 4 });
    applyTrade(saving.ownership, "guest", { give: 5, want: 2 });
    saving.trades = 2;

    const saved = JSON.parse(JSON.stringify(saving.toSaveBlock([1, 2, 3, 4, 5, 6])));
    expect(saved.owners).toEqual({ "1": "guest", "2": "guest", "3": "host", "4": "host", "5": "host", "6": "guest" });
    expect(saved.trades).toBe(2);
    endCoopSession();

    const loading = startCoopSession({ seat: "guest", runSeed: "s", build, accountSnapshot: snapshot });
    loading.restoreFromSaveBlock(saved);
    expect(loading.ownership.toJSON()).toEqual(saved.owners);
    expect(loading.trades).toBe(2);
    expect(loading.ownership.countBySeat()).toEqual({ host: 3, guest: 3 });
  });
});
