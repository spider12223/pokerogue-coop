/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { TurnCommand } from "#app/battle";
import {
  evolutionCancelKey,
  evolutionPauseKey,
  faintSwitchKey,
  learnMoveKey,
  pivotSwitchKey,
  sideActionKey,
  turnCommandsKey,
} from "#coop/decision-keys";
import { interleaveStarters } from "#coop/ownership";
import { isLearnMovePayload } from "#coop/prompt-payloads";
import { isDecisionKey, keyId } from "#coop/protocol";
import {
  commandFromWire,
  commandToWire,
  isSideAction,
  isTurnCommandsPayload,
  isWireCommand,
} from "#coop/turn-commands";
import { Command } from "#enums/command";
import { MoveUseMode } from "#enums/move-use-mode";
import { describe, expect, it } from "vitest";

/** Over the wire as JSON, the way the transport carries it */
const overTheWire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe("turn commands on the wire (D2, D8)", () => {
  const fight: TurnCommand = {
    command: Command.FIGHT,
    cursor: 2,
    move: { move: 33, targets: [2, 3], useMode: MoveUseMode.NORMAL },
    args: [MoveUseMode.NORMAL, undefined],
  };

  it("carries a fight command and rebuilds the command upstream would have stored", () => {
    const wire = overTheWire(commandToWire(fight)!);
    expect(isWireCommand(wire)).toBe(true);
    const rebuilt = commandFromWire(wire);
    expect(rebuilt).toMatchObject({ command: Command.FIGHT, cursor: 2, move: fight.move });
    // targets and cursor survive; the loose `args` of a fight command are not read by the turn
    expect(rebuilt.move?.targets).toEqual([2, 3]);
  });

  it("carries the target of the move chosen later (`SelectTargetPhase`), the skip flag and the pre-turn command", () => {
    const withTargets: TurnCommand = { ...fight, targets: [3] };
    expect(commandFromWire(overTheWire(commandToWire(withTargets)!)).targets).toEqual([3]);
    const pre: TurnCommand = { command: Command.FIGHT, targets: [0], skip: true };
    expect(commandFromWire(overTheWire(commandToWire(pre)!))).toEqual(pre);
  });

  it("carries a switch with its party index and whether it passes the baton", () => {
    const plain: TurnCommand = { command: Command.POKEMON, cursor: 4, args: [false] };
    const baton: TurnCommand = { command: Command.POKEMON, cursor: 5, args: [true] };
    expect(commandFromWire(overTheWire(commandToWire(plain)!))).toEqual(plain);
    expect(commandFromWire(overTheWire(commandToWire(baton)!))).toEqual(baton);
  });

  it("carries a ball with its ball type and target, and a run", () => {
    const ball: TurnCommand = { command: Command.BALL, cursor: 1, targets: [2] };
    expect(commandFromWire(overTheWire(commandToWire(ball)!))).toEqual(ball);
    const run: TurnCommand = { command: Command.RUN };
    expect(commandFromWire(overTheWire(commandToWire(run)!))).toEqual(run);
    expect(isSideAction(ball)).toBe(true);
    expect(isSideAction(run)).toBe(true);
    expect(isSideAction(fight)).toBe(false);
    expect(isSideAction(null)).toBe(false);
  });

  it("has no command for a Pokémon that has none", () => {
    expect(commandToWire(null)).toBeNull();
    expect(commandToWire(undefined)).toBeNull();
    expect(isTurnCommandsPayload({ command: null, pre: null })).toBe(true);
  });

  it("checks what arrives", () => {
    expect(isTurnCommandsPayload({ command: commandToWire(fight), pre: null })).toBe(true);
    expect(isTurnCommandsPayload({ command: { command: 99 }, pre: null })).toBe(false);
    expect(isTurnCommandsPayload({ command: { command: Command.FIGHT, targets: "x" }, pre: null })).toBe(false);
    expect(isTurnCommandsPayload({ pre: null })).toBe(false);
    expect(isTurnCommandsPayload(null)).toBe(false);
  });
});

describe("decision keys of the battle (D2)", () => {
  it("are valid keys, and a retry of a declined side action has its own", () => {
    const keys = [
      turnCommandsKey(3, 2, 77),
      turnCommandsKey(3, 2, 77, 1),
      sideActionKey(3, 2, 77, 0),
      sideActionKey(3, 2, 77, 1),
      faintSwitchKey(3, 3, 77),
      pivotSwitchKey(3, 2, 77),
      learnMoveKey(3, 77, 33),
      evolutionCancelKey(3, 77, 5),
      evolutionPauseKey(3, 77, 5),
    ];
    expect(keys.every(isDecisionKey)).toBe(true);
    expect(new Set(keys.map(keyId)).size).toBe(keys.length);
  });

  it("carry the turn only on commands and switches; a prompt uses turn 0", () => {
    expect(turnCommandsKey(1, 4, 9).turn).toBe(4);
    expect(faintSwitchKey(1, 5, 9).turn).toBe(5);
    expect(pivotSwitchKey(1, 4, 9).turn).toBe(4);
    expect(learnMoveKey(1, 9, 33).turn).toBe(0);
    expect(evolutionCancelKey(1, 9, 5).turn).toBe(0);
  });

  it("key a command by the Pokémon, never by the slot", () => {
    expect(turnCommandsKey(1, 1, 123456).ref).toBe(123456);
    expect(learnMoveKey(1, 12, 34).ref).toBe("12:34");
  });
});

describe("prompt payloads", () => {
  it("accept a move slot or null", () => {
    for (const replaceIndex of [0, 1, 2, 3, null]) {
      expect(isLearnMovePayload({ replaceIndex })).toBe(true);
    }
    for (const replaceIndex of [4, -1, 1.5, "1", undefined]) {
      expect(isLearnMovePayload({ replaceIndex })).toBe(false);
    }
  });
});

describe("party order of a co-op run (D7)", () => {
  it("alternates the seats, the host first", () => {
    expect(interleaveStarters(["h1", "h2", "h3"], ["g1", "g2", "g3"])).toEqual({
      starters: ["h1", "g1", "h2", "g2", "h3", "g3"],
      owners: ["host", "guest", "host", "guest", "host", "guest"],
    });
  });

  it("goes on with the seat that has more when the other runs out", () => {
    expect(interleaveStarters(["h1", "h2", "h3"], ["g1"])).toEqual({
      starters: ["h1", "g1", "h2", "h3"],
      owners: ["host", "guest", "host", "host"],
    });
    expect(interleaveStarters(["h1"], ["g1", "g2"])).toEqual({
      starters: ["h1", "g1", "g2"],
      owners: ["host", "guest", "guest"],
    });
  });
});
