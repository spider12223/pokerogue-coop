/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Seat } from "#coop/protocol";
import {
  isRewardAction,
  isValidRewardProposal,
  kindOfAction,
  type RewardAction,
  rewardKey,
  rewardWindow,
} from "#coop/reward-actions";
import { type RejectReason, Sequencer } from "#coop/sequencer";
import { describe, expect, it } from "vitest";
import { createManualLink } from "./manual-link";

/**
 * The reward screen as an open window (DECISIONS D9): several ways out, who may propose each, and the keys that were not
 * used are closed, so a late proposal is rejected and its author told.
 */

function setup(validatePayload?: ConstructorParameters<typeof Sequencer>[0]["validatePayload"]) {
  const link = createManualLink();
  const host = new Sequencer({ role: "host", transport: link.host, ...(validatePayload ? { validatePayload } : {}) });
  const guest = new Sequencer({ role: "guest", transport: link.guest });
  const settle = (): void => {
    for (let round = 0; round < 10 && (link.host.outbox.length > 0 || link.guest.outbox.length > 0); round++) {
      link.guest.deliverFromPeer();
      link.host.deliverFromPeer();
    }
  };
  // What the guest is told about its own proposals (the host's own throw instead)
  const rejections: { key: string; reason: RejectReason }[] = [];
  guest.onProposalRejected(({ key, reason }) => rejections.push({ key: `${key.kind}:${key.ref}`, reason }));
  return { host, guest, settle, rejections };
}

const WAVE = 4;
const SCREEN = 2;
const owners = new Map<number, Seat>([
  [10, "host"],
  [20, "guest"],
]);
const ownerOf = (id: number): Seat | undefined => owners.get(id);

describe("the reward window (D9)", () => {
  it("resolves with the first decision of any of its keys, on both clients", async () => {
    const { host, guest, settle } = setup();
    const onHost = host.awaitOneOf(rewardWindow(WAVE, SCREEN, 0, "host"));
    const onGuest = guest.awaitOneOf(rewardWindow(WAVE, SCREEN, 0, "host"));
    guest.propose(rewardKey(WAVE, "SHOP_BUY", SCREEN, 0), { t: "buy", index: 1, target: 20 });
    settle();
    expect(await onHost).toMatchObject({ seq: 1, author: "guest", payload: { t: "buy", index: 1 } });
    expect(await onGuest).toMatchObject({ seq: 1, author: "guest" });
  });

  it("lets only the picker pick, reroll and lock; both may buy and transfer", async () => {
    const { host, guest, settle, rejections } = setup();
    void host.awaitOneOf(rewardWindow(WAVE, SCREEN, 0, "host"));
    void guest.awaitOneOf(rewardWindow(WAVE, SCREEN, 0, "host"));

    // the guest is not the picker of this screen
    guest.propose(rewardKey(WAVE, "REWARD_PICK", SCREEN, 0), { t: "pick", index: 0 });
    guest.propose(rewardKey(WAVE, "REROLL", SCREEN, 0), { t: "reroll" });
    guest.propose(rewardKey(WAVE, "REWARD_LOCK", SCREEN, 0), { t: "lock" });
    settle();

    expect(rejections.map(r => [r.key, r.reason])).toEqual([
      [`REWARD_PICK:${SCREEN}:0`, "authorNotAllowed"],
      [`REROLL:${SCREEN}:0`, "authorNotAllowed"],
      [`REWARD_LOCK:${SCREEN}:0`, "authorNotAllowed"],
    ]);
    expect(host.lastApplied).toBe(0);
  });

  it("rejects a buy that arrives after the pick closed the step, and tells its author", async () => {
    const { host, guest, settle, rejections } = setup();
    const onHost = host.awaitOneOf(rewardWindow(WAVE, SCREEN, 0, "host"));
    void guest.awaitOneOf(rewardWindow(WAVE, SCREEN, 0, "host"));

    host.propose(rewardKey(WAVE, "REWARD_PICK", SCREEN, 0), { t: "pick", index: 0 });
    expect((await onHost).payload).toEqual({ t: "pick", index: 0 });
    // the guest's buy was on its way: it arrives at the host after the pick
    guest.propose(rewardKey(WAVE, "SHOP_BUY", SCREEN, 0), { t: "buy", index: 0, target: 20 });
    settle();

    expect(rejections).toEqual([{ key: `SHOP_BUY:${SCREEN}:0`, reason: "closed" }]);
    expect(host.lastApplied).toBe(1);
  });

  it("rejects the host's own late proposal too, by throwing", async () => {
    const { host, guest, settle } = setup();
    const onHost = host.awaitOneOf(rewardWindow(WAVE, SCREEN, 0, "guest"));
    void guest.awaitOneOf(rewardWindow(WAVE, SCREEN, 0, "guest"));
    guest.propose(rewardKey(WAVE, "REWARD_PICK", SCREEN, 0), { t: "skip" });
    settle();
    await onHost;
    expect(() => host.propose(rewardKey(WAVE, "SHOP_BUY", SCREEN, 0), { t: "buy", index: 0 })).toThrow("closed");
  });

  it("rejects a proposal that is parked when its step closes", async () => {
    const { host, guest, settle, rejections } = setup();
    // the guest is ahead: it proposes for step 1 while the host is still in step 0
    guest.propose(rewardKey(WAVE, "SHOP_BUY", SCREEN, 1), { t: "buy", index: 0 });
    settle();
    expect(host.parkedCount).toBe(1);

    // step 0 ends, and step 1 never has that key open (the host's window for step 1 is not the guest's)
    const step0 = host.awaitOneOf(rewardWindow(WAVE, SCREEN, 0, "host"));
    host.propose(rewardKey(WAVE, "REWARD_PICK", SCREEN, 0), { t: "skip" });
    await step0;
    host.closeKeys([rewardKey(WAVE, "SHOP_BUY", SCREEN, 1)]);
    settle();

    expect(host.parkedCount).toBe(0);
    expect(rejections).toEqual([{ key: `SHOP_BUY:${SCREEN}:1`, reason: "closed" }]);
  });

  it("goes on with the next step under new keys", async () => {
    const { host, guest, settle } = setup();
    for (const step of [0, 1, 2]) {
      const onHost = host.awaitOneOf(rewardWindow(WAVE, SCREEN, step, "host"));
      const onGuest = guest.awaitOneOf(rewardWindow(WAVE, SCREEN, step, "host"));
      const author = step === 1 ? guest : host;
      author.propose(rewardKey(WAVE, "SHOP_BUY", SCREEN, step), { t: "buy", index: step });
      settle();
      expect(await onHost).toMatchObject({ seq: step + 1 });
      expect(await onGuest).toMatchObject({ seq: step + 1 });
    }
  });

  it("rejects a payload the host's check refuses, and never sequences it", async () => {
    const { host, guest, settle, rejections } = setup((key, payload, author) =>
      isValidRewardProposal(key, payload, author, ownerOf),
    );
    void host.awaitOneOf(rewardWindow(WAVE, SCREEN, 0, "host"));
    void guest.awaitOneOf(rewardWindow(WAVE, SCREEN, 0, "host"));
    // the guest takes an item from the host's Pokémon
    guest.propose(rewardKey(WAVE, "REWARD_TRANSFER", SCREEN, 0), {
      t: "transfer",
      from: 10,
      to: 20,
      items: [{ index: 0, quantity: 1 }],
    });
    settle();
    expect(rejections).toEqual([{ key: `REWARD_TRANSFER:${SCREEN}:0`, reason: "invalid" }]);
    expect(host.lastApplied).toBe(0);

    // from its own Pokémon it is fine
    guest.propose(rewardKey(WAVE, "REWARD_TRANSFER", SCREEN, 0), {
      t: "transfer",
      from: 20,
      to: 10,
      items: [{ index: 0, quantity: 1 }],
    });
    settle();
    expect(host.lastApplied).toBe(1);
  });
});

describe("reward actions", () => {
  const actions: RewardAction[] = [
    { t: "pick", index: 2, target: 10, option: 1 },
    { t: "skip" },
    { t: "reroll" },
    { t: "lock" },
    { t: "buy", index: 3, target: 10, target2: 20 },
    { t: "transfer", from: 10, to: 20, items: [{ index: 0, quantity: 2 }] },
  ];

  it("survive JSON and name the kind of decision they are", () => {
    expect(actions.map(action => kindOfAction(JSON.parse(JSON.stringify(action))))).toEqual([
      "REWARD_PICK",
      "REWARD_PICK",
      "REROLL",
      "REWARD_LOCK",
      "SHOP_BUY",
      "REWARD_TRANSFER",
    ]);
    expect(actions.every(isRewardAction)).toBe(true);
  });

  it.each([
    ["no kind", {}],
    ["a pick with no index", { t: "pick" }],
    ["a negative index", { t: "buy", index: -1 }],
    ["a target that is no id", { t: "buy", index: 0, target: "x" }],
    ["a transfer of nothing", { t: "transfer", from: 1, to: 2, items: [] }],
    ["a transfer of zero items", { t: "transfer", from: 1, to: 2, items: [{ index: 0, quantity: 0 }] }],
    ["null", null],
  ])("reject %s", (_name, value) => {
    expect(isRewardAction(value)).toBe(false);
  });

  it("must fit the key they are proposed under", () => {
    expect(isValidRewardProposal(rewardKey(1, "REROLL", 0, 0), { t: "reroll" }, "host", ownerOf)).toBe(true);
    expect(isValidRewardProposal(rewardKey(1, "REROLL", 0, 0), { t: "lock" }, "host", ownerOf)).toBe(false);
    expect(isValidRewardProposal(rewardKey(1, "SHOP_BUY", 0, 0), { t: "skip" }, "guest", ownerOf)).toBe(false);
    // a fusion (DNA Splicer) is of two of the author's own: the host may not fuse the guest's 20 into its 10
    const fuse = (target: number, target2: number): RewardAction => ({ t: "buy", index: 0, target, target2 });
    expect(isValidRewardProposal(rewardKey(1, "SHOP_BUY", 0, 0), fuse(10, 20), "host", ownerOf)).toBe(false);
    expect(isValidRewardProposal(rewardKey(1, "SHOP_BUY", 0, 0), fuse(20, 10), "host", ownerOf)).toBe(false);
    // other keys are none of its business
    expect(
      isValidRewardProposal({ wave: 1, turn: 1, kind: "TURN_COMMANDS", ref: 1 }, "anything", "guest", ownerOf),
    ).toBe(true);
  });
});
