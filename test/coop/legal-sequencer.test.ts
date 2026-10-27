/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EpochTransport } from "#coop/epoch";
import { safeLegality } from "#coop/legal";
import type { DecisionKey, DecisionKind, Seat } from "#coop/protocol";
import { DesyncError, Sequencer } from "#coop/sequencer";
import { describe, expect, it } from "vitest";
import { fight, GUEST_MON, HOST_MON, key, TACKLE, turnKey, view } from "./legal-fixtures";
import { createManualLink } from "./manual-link";

/**
 * Two clients, one decision that is not legal (DECISIONS D24): neither applies it, both raise the same desync at the same
 * place, nothing throws out of the sequencer, and after the reload the run goes on with a decision that is.
 */

function pair() {
  const link = createManualLink();
  const hostChannel = new EpochTransport(link.host);
  const guestChannel = new EpochTransport(link.guest);
  const host = new Sequencer({ role: "host", transport: hostChannel });
  const guest = new Sequencer({ role: "guest", transport: guestChannel });
  // both clients look at the same state, as they do at a decision point
  const check = safeLegality(
    () => view(),
    error => {
      throw error;
    },
  );
  host.setLegality(check);
  guest.setLegality(check);
  const settle = (): void => {
    for (let round = 0; round < 10 && (link.host.outbox.length > 0 || link.guest.outbox.length > 0); round++) {
      link.guest.deliverFromPeer();
      link.host.deliverFromPeer();
    }
  };
  return { host, guest, hostChannel, guestChannel, settle };
}

const rewardKey = (kind: DecisionKind): DecisionKey => key(kind, "0:0");
const tradeKey = (kind: DecisionKind): DecisionKey => key(kind, "0:1");

/** One illegal decision of every kind that a client can make, and who makes it */
const ILLEGAL: { name: string; key: DecisionKey; payload: unknown; author: Seat }[] = [
  { name: "a move the Pokémon does not know", key: turnKey(HOST_MON), payload: fight(0, 999, [2]), author: "host" },
  { name: "a target the move cannot have", key: turnKey(HOST_MON), payload: fight(0, TACKLE, [0]), author: "host" },
  { name: "commands that cannot be read", key: turnKey(GUEST_MON), payload: "attack", author: "guest" },
  {
    name: "an answer to a side action that is not one",
    key: key("SIDE_ACTION", "1:0", 3),
    payload: { accept: 1 },
    author: "guest",
  },
  {
    name: "a replacement that may not come in",
    key: key("FAINT_SWITCH", 1, 4),
    payload: { partyIndex: 5, baton: false },
    author: "host",
  },
  {
    name: "a pivot to nowhere that exists",
    key: key("PIVOT_SWITCH", 1, 4),
    payload: { partyIndex: 9, baton: false },
    author: "guest",
  },
  {
    name: "a reward that is not on the screen",
    key: rewardKey("REWARD_PICK"),
    payload: { t: "pick", index: 40 },
    author: "host",
  },
  {
    name: "a purchase that cannot be afforded",
    key: rewardKey("SHOP_BUY"),
    payload: { t: "buy", index: 1, target: 1 },
    author: "guest",
  },
  {
    name: "a reroll under the key of a purchase",
    key: rewardKey("SHOP_BUY"),
    payload: { t: "reroll" },
    author: "host",
  },
  {
    name: "a Lock Capsule under the key of a reroll",
    key: rewardKey("REROLL"),
    payload: { t: "lock" },
    author: "host",
  },
  {
    name: "a transfer of items that are not there",
    key: rewardKey("REWARD_TRANSFER"),
    payload: { t: "transfer", from: GUEST_MON, to: 1, items: [{ index: 7, quantity: 1 }] },
    author: "guest",
  },
  {
    name: "a move to forget that does not exist",
    key: key("LEARN_MOVE", `${HOST_MON}:70`),
    payload: { replaceIndex: 4 },
    author: "host",
  },
  {
    name: "an evolution answered with a number",
    key: key("EVOLUTION_CANCEL", `${HOST_MON}:5`),
    payload: { cancel: 1 },
    author: "host",
  },
  { name: "a biome that was not offered", key: key("BIOME", -1), payload: { biome: 99 }, author: "guest" },
  {
    name: "a release of a Pokémon that is not there",
    key: key("CATCH_RELEASE", 40),
    payload: { release: 99 },
    author: "guest",
  },
  {
    name: "a request for a trade that carries something",
    key: tradeKey("TRADE_REQUEST"),
    payload: { x: 1 },
    author: "host",
  },
  {
    name: "a trade of a Pokémon that is not the giver's",
    key: tradeKey("TRADE_PROPOSE"),
    payload: { give: 2, want: 1 },
    author: "host",
  },
  { name: "an accept that carries something", key: tradeKey("TRADE_ACCEPT"), payload: true, author: "guest" },
  {
    name: "an end of the trade that cannot be read",
    key: tradeKey("TRADE_DONE"),
    payload: { done: 3 },
    author: "host",
  },
];

describe("an illegal decision on both clients (D24)", () => {
  it.each(ILLEGAL)(
    "$name: both raise the same desync, and neither applies it",
    async ({ key: decisionKey, payload, author }) => {
      const { host, guest, settle } = pair();
      const onHost = host.awaitDecision(decisionKey);
      const onGuest = guest.awaitDecision(decisionKey);
      const failures: { client: Seat; error: DesyncError }[] = [];
      host.onDesync(error => failures.push({ client: "host", error }));
      guest.onDesync(error => failures.push({ client: "guest", error }));

      // the author proposes it; the host sequences it (it does not check what the state has, only the shape) and both get it
      (author === "host" ? host : guest).propose(decisionKey, payload);
      settle();

      const [a, b] = await Promise.allSettled([onHost, onGuest]);
      expect(a.status).toBe("rejected");
      expect(b.status).toBe("rejected");
      const [hostError, guestError] = [(a as PromiseRejectedResult).reason, (b as PromiseRejectedResult).reason];
      expect(hostError).toBeInstanceOf(DesyncError);
      expect(guestError).toBeInstanceOf(DesyncError);
      // the same words, at the same seq, about the same key
      expect(guestError.message).toBe(hostError.message);
      expect(hostError.message).toMatch(/illegal decision: /);
      expect(guestError.seq).toBe(hostError.seq);
      expect(guestError.actual).toEqual(hostError.actual);
      expect(hostError.actual).toEqual(decisionKey);

      // each client logged it once, and holds it as its failure
      expect(failures.map(failure => failure.client).sort()).toEqual(["guest", "host"]);
      expect(host.desync?.message).toBe(guest.desync?.message);
      // nothing was applied: the decision was not handed over
      expect(host.lastApplied).toBe(0);
      expect(guest.lastApplied).toBe(0);
    },
  );

  it("goes on after the reload: the next legal decision is applied by both, and an illegal one is caught again", async () => {
    const { host, guest, hostChannel, guestChannel, settle } = pair();
    const legal = turnKey(HOST_MON);
    void host.awaitDecision(legal).catch(() => undefined);
    void guest.awaitDecision(legal).catch(() => undefined);
    host.propose(legal, fight(0, 999, [2]));
    settle();
    expect(host.desync).not.toBeNull();
    expect(guest.desync).not.toBeNull();

    // the RESYNC took seq 2: both carry on from 3, in epoch 1
    host.resetForEpoch(3);
    guest.resetForEpoch(3);
    hostChannel.setEpoch(1);
    guestChannel.setEpoch(1);
    expect(host.desync).toBeNull();
    expect(guest.desync).toBeNull();

    const onHost = host.awaitDecision(legal);
    const onGuest = guest.awaitDecision(legal);
    host.propose(legal, fight(0, TACKLE, [2]));
    settle();
    const [a, b] = await Promise.all([onHost, onGuest]);
    expect(a.seq).toBe(3);
    expect(b.seq).toBe(3);
    expect(a.payload).toEqual(b.payload);

    // and the check is still on
    const again = turnKey(GUEST_MON);
    void host.awaitDecision(again).catch(() => undefined);
    void guest.awaitDecision(again).catch(() => undefined);
    guest.propose(again, "attack");
    settle();
    expect(host.desync?.message).toMatch(/illegal decision/);
    expect(guest.desync?.message).toMatch(/illegal decision/);
  });

  it("checks a decision that arrives before the simulation asks for it at the moment it asks", async () => {
    const { host, guest, settle } = pair();
    const decisionKey = turnKey(HOST_MON);
    const onHost = host.awaitDecision(decisionKey);
    host.propose(decisionKey, fight(0, 999, [2]));
    settle();
    // the host's simulation was waiting: it stops at once. The guest's has not asked yet, and nothing has happened to it
    await expect(onHost).rejects.toBeInstanceOf(DesyncError);
    expect(guest.desync).toBeNull();
    expect(guest.readyCount).toBe(1);
    // when it asks, it gets the same answer
    await expect(guest.awaitDecision(decisionKey)).rejects.toBeInstanceOf(DesyncError);
    expect(guest.desync?.message).toBe(host.desync?.message);
  });

  it("lets a legal decision of every kind through unchanged", async () => {
    const { host, guest, settle } = pair();
    const legal: { key: DecisionKey; payload: unknown }[] = [
      { key: turnKey(HOST_MON), payload: fight(0, TACKLE, [2]) },
      { key: key("SIDE_ACTION", "1:0", 3), payload: { accept: true } },
      { key: key("FAINT_SWITCH", 1, 4), payload: { partyIndex: 2, baton: false } },
      { key: rewardKey("REWARD_PICK"), payload: { t: "pick", index: 0 } },
      { key: key("LEARN_MOVE", `${HOST_MON}:70`), payload: { replaceIndex: 2 } },
      { key: key("BIOME", -1), payload: { biome: 10 } },
      { key: tradeKey("TRADE_REQUEST"), payload: null },
    ];
    for (const { key: decisionKey, payload } of legal) {
      const onHost = host.awaitDecision(decisionKey);
      const onGuest = guest.awaitDecision(decisionKey);
      host.propose(decisionKey, payload);
      settle();
      const [a, b] = await Promise.all([onHost, onGuest]);
      expect(a.payload).toEqual(payload);
      expect(b.payload).toEqual(payload);
    }
    expect(host.desync).toBeNull();
    expect(guest.desync).toBeNull();
  });
});
