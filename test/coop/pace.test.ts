/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { COSMETIC_LIMITS, type CosmeticMessage, CosmeticSender, isCosmeticMessage } from "#coop/cosmetic";
import { comparePositions, PaceTracker } from "#coop/pace";
import { describe, expect, it } from "vitest";
import { FakeScheduler } from "./fake-scheduler";

/**
 * Pacing (DECISIONS D27): where each client is in the text of the run, when the guest's screen follows the host's, and the
 * two messages that carry it.
 */

/** A tracker past the first checkpoint of an epoch, in a phase where lines are shared */
function inBattle(): PaceTracker {
  const pace = new PaceTracker();
  pace.phaseStarted("EncounterPhase");
  pace.checkpointTaken();
  pace.phaseStarted("MessagePhase");
  return pace;
}

describe("positions", () => {
  it("are ordered by checkpoint, then phase, then prompt", () => {
    expect(comparePositions([1, 0, 0], [0, 9, 9])).toBeGreaterThan(0);
    expect(comparePositions([1, 2, 0], [1, 1, 5])).toBeGreaterThan(0);
    expect(comparePositions([1, 2, 1], [1, 2, 2])).toBeLessThan(0);
    expect(comparePositions([3, 4, 5], [3, 4, 5])).toBe(0);
  });

  it("count phases from the last checkpoint and prompts from the phase's start", () => {
    const pace = inBattle();
    expect(pace.position).toEqual([1, 1, 0]);
    const ticket = pace.promptOpened("A wild Rattata appeared!")!;
    expect(ticket.at).toEqual([1, 1, 0]);
    pace.promptClosed(ticket);
    expect(pace.position).toEqual([1, 1, 1]);
    pace.phaseStarted("SummonPhase");
    expect(pace.position).toEqual([1, 2, 0]);
    pace.checkpointTaken();
    expect(pace.position).toEqual([2, 0, 0]);
    // Two stretches: the one before the first checkpoint (1 phase), and the one of the battle (2 phases)
    expect(pace.segments).toEqual([1, 2]);
  });

  it("closing a line twice, or after its phase is over, counts it once", () => {
    const pace = inBattle();
    const ticket = pace.promptOpened("line")!;
    pace.promptClosed(ticket);
    pace.promptClosed(ticket);
    expect(pace.position).toEqual([1, 1, 1]);
    const late = pace.promptOpened("another")!;
    pace.phaseStarted("NextPhase");
    pace.promptClosed(late);
    expect(pace.position).toEqual([1, 2, 0]);
  });
});

describe("shared and private lines", () => {
  it("nothing is shared before the first checkpoint of an epoch: the clients run different phases there", () => {
    const pace = new PaceTracker();
    pace.phaseStarted("TitlePhase");
    expect(pace.isPrivate).toBe(true);
    expect(pace.promptOpened("Welcome")).toBeNull();
  });

  it("the command menus are each player's own, and not counted: how many there are is the player's doing", () => {
    const pace = inBattle();
    pace.phaseStarted("CommandPhase");
    expect(pace.promptOpened("No PP left for this move!")).toBeNull();
    // A move with a target, and a cancel that opens the menu again: on this client only
    pace.phaseStarted("SelectTargetPhase");
    pace.phaseStarted("CommandPhase");
    expect(pace.position).toEqual([1, 1, 0]);
    pace.phaseStarted("CoopTurnSyncPhase");
    expect(pace.position).toEqual([1, 2, 0]);
    expect(pace.isPrivate).toBe(false);
  });

  it("the lines of a player's own question are not counted, so both screens stay on the same count", () => {
    const owner = inBattle();
    const partner = inBattle();
    const leave = owner.enterPrivate();
    // Only the owner sees these two
    expect(owner.promptOpened("Bulbasaur wants to learn Razor Leaf.")).toBeNull();
    expect(owner.promptOpened("But it already knows four moves.")).toBeNull();
    leave();
    // The line after the answer is shared, at the same place on both
    expect(owner.promptOpened("Bulbasaur did not learn Razor Leaf.")!.at).toEqual(
      partner.promptOpened("Bulbasaur did not learn Razor Leaf.")!.at,
    );
  });

  it("leaving a question twice, or after a reset, does no harm", () => {
    const pace = inBattle();
    const leave = pace.enterPrivate();
    const other = pace.enterPrivate();
    leave();
    leave();
    expect(pace.isPrivate).toBe(true);
    other();
    expect(pace.isPrivate).toBe(false);
    const stale = pace.enterPrivate();
    pace.reset();
    stale();
    pace.phaseStarted("EncounterPhase");
    pace.checkpointTaken();
    expect(pace.isPrivate).toBe(false);
  });

  it("keeps the latest shared lines, for the tests that compare both screens", () => {
    const pace = inBattle();
    for (let i = 0; i < 250; i++) {
      pace.promptClosed(pace.promptOpened(`line ${i}`)!);
    }
    expect(pace.prompts).toHaveLength(200);
    expect(pace.prompts.at(-1)).toEqual({ at: [1, 1, 249], text: "line 249" });
  });
});

describe("the guest follows the host", () => {
  it("is behind once the host is past the line it shows, not while the host is on it", () => {
    const guest = inBattle();
    guest.promptOpened("Go! Bulbasaur!");
    guest.setLeader([1, 1, 0]);
    expect(guest.behind).toBe(false);
    guest.setLeader([1, 1, 1]);
    expect(guest.behind).toBe(true);
  });

  it("a panel of its own gives way once the host is in a later phase", () => {
    const guest = inBattle();
    guest.promptClosed(guest.promptOpened("Bulbasaur grew to Lv. 6!")!);
    // The stats panel is up; the host has no panel and closed the same line
    guest.setLeader([1, 1, 1]);
    expect(guest.behind).toBe(false);
    guest.setLeader([1, 2, 0]);
    expect(guest.behind).toBe(true);
  });

  it("never while the guest answers a question of its own, nor before the host's first checkpoint", () => {
    const guest = inBattle();
    guest.setLeader([5, 0, 0]);
    const leave = guest.enterPrivate();
    expect(guest.behind).toBe(false);
    leave();
    expect(guest.behind).toBe(true);
    const fresh = new PaceTracker();
    fresh.setLeader([0, 40, 0]);
    expect(fresh.isPast([0, 1, 0])).toBe(false);
  });

  it("the host's position only goes forward, and a new epoch forgets it", () => {
    const guest = inBattle();
    guest.setLeader([2, 3, 0]);
    guest.setLeader([1, 9, 9]);
    expect(guest.leader).toEqual([2, 3, 0]);
    guest.reset();
    expect(guest.leader).toBeNull();
    expect(guest.position).toEqual([0, 0, 0]);
    expect(guest.segments).toEqual([]);
  });
});

describe("a press of the guest on the host's screen", () => {
  it("closes the line the host waits on, if it is that same line", () => {
    const host = inBattle();
    host.promptOpened("The wild Rattata fainted!");
    expect(host.pressFits([1, 1, 0])).toBe(true);
  });

  it("does nothing for a line the host has not reached, or has passed", () => {
    const host = inBattle();
    expect(host.pressFits([1, 1, 0])).toBe(false);
    host.promptClosed(host.promptOpened("first")!);
    host.promptOpened("second");
    expect(host.pressFits([1, 1, 0])).toBe(false);
    expect(host.pressFits([1, 1, 2])).toBe(false);
    expect(host.pressFits([1, 1, 1])).toBe(true);
  });

  it("does nothing while the host answers a question of its own", () => {
    const host = inBattle();
    host.promptOpened("shared");
    host.enterPrivate();
    expect(host.pressFits([1, 1, 0])).toBe(false);
  });
});

describe("the pace and press messages", () => {
  const pace: CosmeticMessage = {
    t: "pace",
    at: [3, 12, 1],
    game: 3,
    exp: 0,
    hp: 2,
    iv: false,
    anim: true,
    stats: false,
  };

  it("are well-formed or dropped", () => {
    expect(isCosmeticMessage(pace)).toBe(true);
    expect(isCosmeticMessage({ t: "press", at: [3, 12, 1] })).toBe(true);
    for (const bad of [
      { t: "press", at: [3, 12] },
      { t: "press", at: [3, 12, -1] },
      { t: "press", at: [3, 12, 1.5] },
      { t: "press", at: "3,12,1" },
      { ...pace, game: 0 },
      { ...pace, exp: 4 },
      { ...pace, hp: "fast" },
      { ...pace, iv: 1 },
      { ...pace, anim: "on" },
      { ...pace, stats: undefined },
      { t: "pace", at: [3, 12, 1] },
    ]) {
      expect(isCosmeticMessage(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("the sender holds the pace back to its limit and sends the latest; it refuses presses over theirs", () => {
    const clock = new FakeScheduler();
    const sent: CosmeticMessage[] = [];
    const sender = new CosmeticSender(message => sent.push(message), clock);
    for (let phase = 0; phase < 100; phase++) {
      expect(sender.send({ ...pace, at: [3, phase, 0] })).toBe(true);
    }
    expect(sent).toHaveLength(COSMETIC_LIMITS.pace.burst);
    clock.advance(1000);
    expect(sent.at(-1)).toEqual({ ...pace, at: [3, 99, 0] });

    const presses = Array.from({ length: 10 }, () => sender.send({ t: "press", at: [3, 99, 0] }));
    expect(presses.filter(Boolean)).toHaveLength(COSMETIC_LIMITS.press.burst);
  });
});
