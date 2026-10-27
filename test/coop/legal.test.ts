/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { checkDecisionLegal, type LegalityView, safeLegality } from "#coop/legal";
import type { OwnerMap } from "#coop/ownership";
import { DECISION_KINDS, type DecisionKey, type DecisionKind, type Seat } from "#coop/protocol";
import { describe, expect, it } from "vitest";
import {
  fight,
  fighter,
  GROWL,
  GUEST_MON,
  HOST_MON,
  key,
  owners,
  reward,
  SAND_ATTACK,
  STRUGGLE,
  TACKLE,
  turnKey,
  view,
} from "./legal-fixtures";

/**
 * The legality of a decision (DECISIONS D24), kind by kind: one decision that is legal, and the ways a payload can be illegal:
 * a move the Pokémon does not know, a target the move cannot have, a party index that is not there, an item that cannot be
 * afforded. A check never throws, whatever it is handed.
 */

type Case = { name: string; key: DecisionKey; payload: unknown; author?: Seat; view?: LegalityView };

function expectLegal(cases: Case[]): void {
  for (const { name, key: k, payload, author = "host", view: v = view() } of cases) {
    expect(checkDecisionLegal(v, k, payload, author), name).toBeNull();
  }
}

function expectIllegal(cases: Case[]): void {
  for (const { name, key: k, payload, author = "host", view: v = view() } of cases) {
    const reason = checkDecisionLegal(v, k, payload, author);
    expect(reason, name).toEqual(expect.any(String));
    expect(reason, name).not.toBe("");
  }
}

describe("legality: the turn's commands", () => {
  it("accepts what a command phase makes", () => {
    expectLegal([
      { name: "a move at a target", key: turnKey(1), payload: fight(0, TACKLE, [2]) },
      { name: "a spread move, named as the screen does", key: turnKey(1), payload: fight(1, GROWL, [2, 3]) },
      { name: "a spread move with a target the harness picks", key: turnKey(1), payload: fight(1, GROWL, [2]) },
      {
        name: "Tera before the turn",
        key: turnKey(1),
        payload: { ...fight(0, TACKLE, [2]), pre: { command: 4, targets: [0] } },
      },
      {
        name: "the no-Tera marker",
        key: turnKey(1),
        payload: { ...fight(0, TACKLE, [2]), pre: { command: 0, targets: [0], skip: true } },
      },
      { name: "a Ball", key: turnKey(1), payload: { command: { command: 1, cursor: 0, targets: [2] }, pre: null } },
      { name: "a switch", key: turnKey(1), payload: { command: { command: 2, cursor: 3, baton: false }, pre: null } },
      { name: "Run", key: turnKey(1), payload: { command: { command: 3, cursor: 0 }, pre: null } },
      {
        name: "Struggle when nothing can be used",
        key: turnKey(1),
        payload: fight(0, STRUGGLE, [2]),
        view: view({ fighter: () => fighter({ moves: [{ id: TACKLE, usable: false }] }) }),
      },
      {
        name: "a move that was under way",
        key: turnKey(1),
        payload: fight(-1, 291, [2]),
        view: view({ fighter: () => fighter({ queuedMove: 291 }) }),
      },
      {
        name: "no move at all",
        key: turnKey(1),
        payload: { command: { command: 0, cursor: -1, move: { move: 0, targets: [], useMode: 0 } }, pre: null },
      },
      {
        name: "a command that is skipped, whatever it holds",
        key: turnKey(1),
        payload: fight(0, 999, [], { skip: true }),
      },
      { name: "nothing to command", key: turnKey(1), payload: { command: null, pre: null } },
    ]);
  });

  it("refuses a Pokémon that is not on the field, and commands that cannot be read", () => {
    expectIllegal([
      { name: "a Pokémon that is not fighting", key: turnKey(99), payload: fight(0, TACKLE, [2]) },
      { name: "no payload", key: turnKey(1), payload: null },
      { name: "a string", key: turnKey(1), payload: "attack" },
      { name: "an array", key: turnKey(1), payload: [] },
      { name: "an unknown command", key: turnKey(1), payload: { command: { command: 9 }, pre: null } },
      {
        name: "a command that is not a number",
        key: turnKey(1),
        payload: { command: { command: "FIGHT" }, pre: null },
      },
      {
        name: "targets that are not numbers",
        key: turnKey(1),
        payload: { command: { command: 0, targets: ["a"], cursor: 0 }, pre: null },
      },
    ]);
  });

  it("refuses a move it does not have, cannot use, or cannot aim like that", () => {
    expectIllegal([
      { name: "a slot that does not exist", key: turnKey(1), payload: fight(7, TACKLE, [2]) },
      { name: "a slot below -1", key: turnKey(1), payload: fight(-2, TACKLE, [2]) },
      { name: "another move than the slot holds", key: turnKey(1), payload: fight(0, GROWL, [2]) },
      { name: "a move with no PP left", key: turnKey(1), payload: fight(2, SAND_ATTACK, [2]) },
      { name: "a move that is not in the moveset, with no slot", key: turnKey(1), payload: fight(-1, 999, [2]) },
      { name: "Struggle while another move can be used", key: turnKey(1), payload: fight(0, STRUGGLE, [2]) },
      { name: "a target the move cannot have", key: turnKey(1), payload: fight(0, TACKLE, [0]) },
      { name: "two targets for a move at one", key: turnKey(1), payload: fight(0, TACKLE, [2, 3]) },
      { name: "no target for a move at one", key: turnKey(1), payload: fight(0, TACKLE, []) },
      { name: "a target that is not a battler", key: turnKey(1), payload: fight(1, GROWL, [2, 9]) },
      { name: "a fight with no move", key: turnKey(1), payload: { command: { command: 0, cursor: 0 }, pre: null } },
    ]);
  });

  it("refuses a Ball, a switch, a Run and a Tera that the state does not allow", () => {
    expectIllegal([
      {
        name: "a Ball where nothing is caught",
        key: turnKey(1),
        payload: { command: { command: 1, cursor: 0 }, pre: null },
        view: view({ canCatch: false }),
      },
      {
        name: "a Ball that is not in the bag",
        key: turnKey(1),
        payload: { command: { command: 1, cursor: 3 }, pre: null },
      },
      {
        name: "a Ball of a type that does not exist",
        key: turnKey(1),
        payload: { command: { command: 1, cursor: 99 }, pre: null },
      },
      { name: "a Ball with no type", key: turnKey(1), payload: { command: { command: 1 }, pre: null } },
      {
        name: "a switch to a Pokémon that cannot come in",
        key: turnKey(1),
        payload: { command: { command: 2, cursor: 5, baton: false }, pre: null },
      },
      {
        name: "a switch to the field",
        key: turnKey(1),
        payload: { command: { command: 2, cursor: 0, baton: false }, pre: null },
      },
      {
        name: "a switch by a Pokémon that is trapped",
        key: turnKey(GUEST_MON),
        payload: { command: { command: 2, cursor: 3, baton: false }, pre: null },
      },
      {
        name: "a switch with no index",
        key: turnKey(1),
        payload: { command: { command: 2, baton: false }, pre: null },
      },
      {
        name: "a Run where it is not allowed",
        key: turnKey(1),
        payload: { command: { command: 3, cursor: 0 }, pre: null },
        view: view({ canRun: false }),
      },
      {
        name: "Tera when the Pokémon cannot",
        key: turnKey(GUEST_MON),
        payload: { ...fight(0, TACKLE, [2]), pre: { command: 4, targets: [1] } },
        view: view({ fighter: () => fighter({ canTera: false }) }),
      },
      {
        name: "a Ball as the command before the turn",
        key: turnKey(1),
        payload: { ...fight(0, TACKLE, [2]), pre: { command: 1, cursor: 0 } },
      },
      {
        name: "a switch as the command before the turn",
        key: turnKey(1),
        payload: { ...fight(0, TACKLE, [2]), pre: { command: 2, cursor: 3 } },
      },
      { name: "Tera as the command of the turn", key: turnKey(1), payload: { command: { command: 4 }, pre: null } },
    ]);
  });
});

describe("legality: the answers to a prompt", () => {
  it("accepts a side action, a replacement, a move to forget, an evolution, a biome, a release", () => {
    expectLegal([
      { name: "accept", key: key("SIDE_ACTION", "1:0", 3), payload: { accept: false } },
      { name: "a replacement", key: key("FAINT_SWITCH", 1, 4), payload: { partyIndex: 2, baton: false } },
      { name: "nobody", key: key("PIVOT_SWITCH", 1, 4), payload: { partyIndex: null, baton: false } },
      { name: "a move to forget", key: key("LEARN_MOVE", `${HOST_MON}:70`), payload: { replaceIndex: 3 } },
      { name: "no new move", key: key("LEARN_MOVE", `${HOST_MON}:70`), payload: { replaceIndex: null } },
      { name: "an evolution cancelled", key: key("EVOLUTION_CANCEL", `${HOST_MON}:5`), payload: { cancel: true } },
      { name: "evolutions paused", key: key("EVOLUTION_CANCEL", `${HOST_MON}:5:pause`), payload: { pause: true } },
      { name: "a biome that was offered", key: key("BIOME", -1), payload: { biome: 11 } },
      {
        name: "a biome while none is being chosen",
        key: key("BIOME", -1),
        payload: { biome: 11 },
        view: view({ biomeChoices: () => null }),
      },
      { name: "a release", key: key("CATCH_RELEASE", 40), payload: { release: 3 } },
      { name: "no release", key: key("CATCH_RELEASE", 40), payload: { release: null } },
    ]);
  });

  it("refuses answers that cannot be read or do not fit", () => {
    expectIllegal([
      { name: "an answer that is not a boolean", key: key("SIDE_ACTION", "1:0", 3), payload: { accept: "yes" } },
      { name: "no answer", key: key("SIDE_ACTION", "1:0", 3), payload: null },
      {
        name: "a replacement that may not come in",
        key: key("FAINT_SWITCH", 1, 4),
        payload: { partyIndex: 4, baton: false },
      },
      { name: "a replacement by a string", key: key("FAINT_SWITCH", 1, 4), payload: { partyIndex: "2", baton: false } },
      { name: "a replacement without the baton flag", key: key("PIVOT_SWITCH", 1, 4), payload: { partyIndex: 2 } },
      { name: "a replacement of nothing", key: key("PIVOT_SWITCH", 1, 4), payload: null },
      {
        name: "a move to forget that it does not know",
        key: key("LEARN_MOVE", `${GUEST_MON}:70`),
        payload: { replaceIndex: 3 },
      },
      { name: "a move to forget out of range", key: key("LEARN_MOVE", `${HOST_MON}:70`), payload: { replaceIndex: 4 } },
      { name: "a negative move slot", key: key("LEARN_MOVE", `${HOST_MON}:70`), payload: { replaceIndex: -1 } },
      {
        name: "a move for a Pokémon that is not in the party",
        key: key("LEARN_MOVE", "99:70"),
        payload: { replaceIndex: 0 },
      },
      { name: "a cancel that is not a boolean", key: key("EVOLUTION_CANCEL", `${HOST_MON}:5`), payload: { cancel: 1 } },
      {
        name: "a pause answered with a cancel",
        key: key("EVOLUTION_CANCEL", `${HOST_MON}:5:pause`),
        payload: { cancel: true },
      },
      {
        name: "an evolution of a Pokémon that is not in the party",
        key: key("EVOLUTION_CANCEL", "99:5"),
        payload: { cancel: false },
      },
      { name: "a biome that was not offered", key: key("BIOME", -1), payload: { biome: 99 } },
      { name: "a biome that is not a number", key: key("BIOME", -1), payload: { biome: "forest" } },
      {
        name: "a release of a Pokémon that is not in the party",
        key: key("CATCH_RELEASE", 40),
        payload: { release: 99 },
      },
      { name: "a release of the catch itself", key: key("CATCH_RELEASE", 3), payload: { release: 3 } },
      { name: "a release that is not a number", key: key("CATCH_RELEASE", 40), payload: { release: "3" } },
    ]);
  });
});

describe("legality: the reward screen", () => {
  const rewardKey = (kind: DecisionKind) => key(kind, "0:0");

  it("accepts what the screen can do", () => {
    expectLegal([
      { name: "skip", key: rewardKey("REWARD_PICK"), payload: { t: "skip" } },
      { name: "a plain pick", key: rewardKey("REWARD_PICK"), payload: { t: "pick", index: 0 } },
      { name: "an item for a Pokémon", key: rewardKey("REWARD_PICK"), payload: { t: "pick", index: 1, target: 4 } },
      { name: "a fusion", key: rewardKey("REWARD_PICK"), payload: { t: "pick", index: 2, target: 1, target2: 3 } },
      {
        name: "an item for a move",
        key: rewardKey("REWARD_PICK"),
        payload: { t: "pick", index: 3, target: 1, option: 2 },
      },
      { name: "a buy", key: rewardKey("SHOP_BUY"), payload: { t: "buy", index: 0 } },
      {
        name: "a buy for a Pokémon",
        key: rewardKey("SHOP_BUY"),
        payload: { t: "buy", index: 1, target: 1 },
        view: view({ reward: () => reward({ money: 900 }) }),
      },
      { name: "a reroll", key: rewardKey("REROLL"), payload: { t: "reroll" } },
      { name: "the Lock Capsule", key: rewardKey("REWARD_LOCK"), payload: { t: "lock" } },
      {
        name: "a transfer",
        key: rewardKey("REWARD_TRANSFER"),
        payload: {
          t: "transfer",
          from: GUEST_MON,
          to: 1,
          items: [
            { index: 0, quantity: 2 },
            { index: 1, quantity: 1 },
          ],
        },
        author: "guest",
      },
      {
        name: "everything is free with the override",
        key: rewardKey("SHOP_BUY"),
        payload: { t: "buy", index: 1, target: 1 },
        view: view({ reward: () => reward({ money: 0, waived: true }) }),
      },
    ]);
  });

  it("refuses an action that does not fit its key, or a screen that is not open", () => {
    expectIllegal([
      { name: "a skip under a buy key", key: rewardKey("SHOP_BUY"), payload: { t: "skip" } },
      { name: "a pick under a reroll key", key: rewardKey("REROLL"), payload: { t: "pick", index: 0 } },
      { name: "no action", key: rewardKey("REWARD_PICK"), payload: null },
      { name: "an action of no kind", key: rewardKey("REWARD_PICK"), payload: { t: "steal", index: 0 } },
      {
        name: "no screen open",
        key: rewardKey("REWARD_PICK"),
        payload: { t: "skip" },
        view: view({ reward: () => null }),
      },
    ]);
  });

  it("refuses a pick that is not on the screen, or aimed at nobody", () => {
    expectIllegal([
      { name: "an index past the options", key: rewardKey("REWARD_PICK"), payload: { t: "pick", index: 4 } },
      { name: "a negative index", key: rewardKey("REWARD_PICK"), payload: { t: "pick", index: -1 } },
      { name: "a fractional index", key: rewardKey("REWARD_PICK"), payload: { t: "pick", index: 1.5 } },
      {
        name: "an item for a Pokémon with no Pokémon",
        key: rewardKey("REWARD_PICK"),
        payload: { t: "pick", index: 1 },
      },
      {
        name: "an item for a Pokémon that is not in the party",
        key: rewardKey("REWARD_PICK"),
        payload: { t: "pick", index: 1, target: 99 },
      },
      { name: "a fusion with one Pokémon", key: rewardKey("REWARD_PICK"), payload: { t: "pick", index: 2, target: 1 } },
      {
        name: "a fusion of a Pokémon with itself",
        key: rewardKey("REWARD_PICK"),
        payload: { t: "pick", index: 2, target: 1, target2: 1 },
      },
      {
        name: "a fusion with a Pokémon that is not in the party",
        key: rewardKey("REWARD_PICK"),
        payload: { t: "pick", index: 2, target: 1, target2: 99 },
      },
      {
        name: "a fusion that takes the partner's Pokémon",
        key: rewardKey("REWARD_PICK"),
        payload: { t: "pick", index: 2, target: 1, target2: GUEST_MON },
      },
      {
        name: "a fusion into the partner's Pokémon",
        key: rewardKey("REWARD_PICK"),
        payload: { t: "pick", index: 2, target: GUEST_MON, target2: 3 },
      },
      {
        name: "an item for a move that is not a slot",
        key: rewardKey("REWARD_PICK"),
        payload: { t: "pick", index: 3, target: 1, option: 500 },
      },
    ]);
  });

  it("refuses what cannot be paid for", () => {
    expectIllegal([
      { name: "a shop item that is not for sale", key: rewardKey("SHOP_BUY"), payload: { t: "buy", index: 2 } },
      {
        name: "a buy that costs more than the money",
        key: rewardKey("SHOP_BUY"),
        payload: { t: "buy", index: 1, target: 1 },
      },
      {
        name: "a reroll that costs more than the money",
        key: rewardKey("REROLL"),
        payload: { t: "reroll" },
        view: view({ reward: () => reward({ money: 100 }) }),
      },
      {
        name: "a reroll when there are none",
        key: rewardKey("REROLL"),
        payload: { t: "reroll" },
        view: view({ reward: () => reward({ rerollCost: -1 }) }),
      },
      {
        name: "the Lock Capsule when there are no rerolls",
        key: rewardKey("REWARD_LOCK"),
        payload: { t: "lock" },
        view: view({ reward: () => reward({ rerollCost: -1 }) }),
      },
    ]);
  });

  it("refuses a transfer from a Pokémon of the other player, between the same Pokémon, or of items that are not there", () => {
    const transfer = (from: number, to: number, items: { index: number; quantity: number }[]) => ({
      t: "transfer",
      from,
      to,
      items,
    });
    expectIllegal([
      {
        name: "from the partner's Pokémon",
        key: rewardKey("REWARD_TRANSFER"),
        payload: transfer(1, GUEST_MON, [{ index: 0, quantity: 1 }]),
        author: "guest",
      },
      {
        name: "to a Pokémon that is not in the party",
        key: rewardKey("REWARD_TRANSFER"),
        payload: transfer(GUEST_MON, 99, [{ index: 0, quantity: 1 }]),
        author: "guest",
      },
      {
        name: "to itself",
        key: rewardKey("REWARD_TRANSFER"),
        payload: transfer(GUEST_MON, GUEST_MON, [{ index: 0, quantity: 1 }]),
        author: "guest",
      },
      {
        name: "an item that is not there",
        key: rewardKey("REWARD_TRANSFER"),
        payload: transfer(GUEST_MON, 1, [{ index: 2, quantity: 1 }]),
        author: "guest",
      },
      {
        name: "more of an item than there is",
        key: rewardKey("REWARD_TRANSFER"),
        payload: transfer(GUEST_MON, 1, [{ index: 1, quantity: 2 }]),
        author: "guest",
      },
      {
        name: "the same item twice",
        key: rewardKey("REWARD_TRANSFER"),
        payload: transfer(GUEST_MON, 1, [
          { index: 0, quantity: 1 },
          { index: 0, quantity: 1 },
        ]),
        author: "guest",
      },
      { name: "no items", key: rewardKey("REWARD_TRANSFER"), payload: transfer(GUEST_MON, 1, []), author: "guest" },
    ]);
  });
});

describe("legality: trades", () => {
  const tradeKey = (kind: DecisionKind) => key(kind, "0:1");
  /** The fixtures' party, with the guest down to one Pokémon */
  const lastOneOfTheGuest = (): OwnerMap => {
    const map = owners();
    map.delete(4);
    return map;
  };

  it("accepts a request, a proposal that follows the rules, the answers, and the end", () => {
    expectLegal([
      { name: "a request", key: tradeKey("TRADE_REQUEST"), payload: null },
      { name: "a swap", key: tradeKey("TRADE_PROPOSE"), payload: { give: 1, want: 2 }, author: "host" },
      { name: "an accept", key: tradeKey("TRADE_ACCEPT"), payload: null },
      { name: "a decline", key: tradeKey("TRADE_DECLINE"), payload: null },
      { name: "a cancel", key: tradeKey("TRADE_CANCEL"), payload: null },
      {
        name: "a gift that evens the party out",
        key: tradeKey("TRADE_PROPOSE"),
        payload: { give: 1, want: null },
        author: "host",
      },
    ]);
  });

  it("refuses a proposal that breaks the rules, an answer that carries something, and an end that cannot be read", () => {
    expectIllegal([
      {
        name: "a swap of a Pokémon that is not the giver's",
        key: tradeKey("TRADE_PROPOSE"),
        payload: { give: 2, want: 1 },
        author: "host",
      },
      {
        name: "a swap for a Pokémon that is not the partner's",
        key: tradeKey("TRADE_PROPOSE"),
        payload: { give: 1, want: 3 },
        author: "host",
      },
      {
        name: "a gift of the giver's last Pokémon",
        key: tradeKey("TRADE_PROPOSE"),
        payload: { give: GUEST_MON, want: null },
        author: "guest",
        view: view({ ownership: () => lastOneOfTheGuest() }),
      },
      {
        name: "a proposal that cannot be read",
        key: tradeKey("TRADE_PROPOSE"),
        payload: { give: "1" },
        author: "host",
      },
      { name: "a proposal of nothing", key: tradeKey("TRADE_PROPOSE"), payload: null, author: "host" },
      { name: "a request that carries something", key: tradeKey("TRADE_REQUEST"), payload: { x: 1 } },
      { name: "an accept that carries something", key: tradeKey("TRADE_ACCEPT"), payload: true },
      { name: "a decline that carries something", key: tradeKey("TRADE_DECLINE"), payload: 0 },
      { name: "a cancel that carries something", key: tradeKey("TRADE_CANCEL"), payload: "no" },
      { name: "an end that cannot be read", key: tradeKey("TRADE_DONE"), payload: { done: "yes" } },
      {
        name: "a proposal with no ownership to check against",
        key: tradeKey("TRADE_PROPOSE"),
        payload: { give: 1, want: 2 },
        view: view({ ownership: () => undefined }),
      },
    ]);
  });
});

describe("legality never throws", () => {
  const junk: unknown[] = [
    undefined,
    null,
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "",
    "x",
    true,
    [],
    [1, 2, 3],
    {},
    { command: {} },
    { command: { command: {} }, pre: [] },
    { command: { command: 0, move: null }, pre: null },
    { command: { command: 0, cursor: 0, move: { move: "a", targets: "b", useMode: [] } }, pre: null },
    { t: "pick" },
    { t: "transfer", from: null, to: {}, items: "x" },
    { t: "transfer", from: 1, to: 2, items: [null] },
    { partyIndex: {}, baton: [] },
    { replaceIndex: [] },
    { biome: null },
    { release: {} },
    { give: [], want: {} },
    { items: [{ index: "0", quantity: -1 }] },
    JSON.parse('{"__proto__": {"command": 0}}'),
  ];

  it("answers a reason or null for junk of every shape, under every kind", () => {
    for (const kind of DECISION_KINDS) {
      for (const ref of [0, -1, 5, "0:0", "1:70", "1:70:pause", "x", "", "99:1"]) {
        for (const payload of junk) {
          for (const author of ["host", "guest"] as const) {
            const decision = key(kind, ref, 3);
            let reason: string | null = "unset";
            expect(
              () => {
                reason = checkDecisionLegal(view(), decision, payload, author);
              },
              `${kind} ${String(ref)} ${JSON.stringify(payload)}`,
            ).not.toThrow();
            expect(reason === null || typeof reason === "string").toBe(true);
          }
        }
      }
    }
  });

  it("answers about a kind that does not exist", () => {
    expect(
      checkDecisionLegal(view(), { wave: 1, turn: 0, kind: "NOPE" as DecisionKind, ref: 0 }, null, "host"),
    ).toEqual(expect.any(String));
  });

  it("turns an error of the state's own into 'the decision stands', and says so once", () => {
    const errors: unknown[] = [];
    const check = safeLegality(
      () => {
        throw new Error("the scene is gone");
      },
      error => errors.push(error),
    );
    expect(check(turnKey(1), fight(0, TACKLE, [2]), "host")).toBeNull();
    expect(errors).toHaveLength(1);
  });
});
