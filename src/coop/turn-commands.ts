/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { TurnCommand } from "#app/battle";
import { Command } from "#enums/command";
import type { MoveUseMode } from "#enums/move-use-mode";

/**
 * A turn command on the wire (DECISIONS D2, D8): what one player decided for one of their Pokémon, as plain JSON.
 * The deciding client builds it from the command its own `CommandPhase` produced; the other client rebuilds an
 * equivalent {@linkcode TurnCommand} from it, so `TurnStartPhase` plays the same turn on both.
 *
 * `TurnCommand.args` is the one loose field upstream: only `args[0]` of a switch command is read (Baton Pass), so only
 * that is carried (as {@linkcode WireTurnCommand.baton}).
 *
 * @module
 */

export interface WireTurnMove {
  move: number;
  targets: number[];
  useMode: number;
}

export interface WireTurnCommand {
  command: number;
  cursor?: number;
  move?: WireTurnMove;
  targets?: number[];
  skip?: boolean;
  /** A switch command: whether it passes the baton */
  baton?: boolean;
}

/**
 * The `TURN_COMMANDS` decision of one Pokémon: its command and the pre-turn command (Terastallization) of the turn.
 * `command` is `null` for a Pokémon that has no command this turn (it cannot act).
 */
export interface TurnCommandsPayload {
  command: WireTurnCommand | null;
  pre: WireTurnCommand | null;
}

/** The answer to a side action (Ball, Run) proposed by the partner (D8). */
export interface SideActionPayload {
  accept: boolean;
}

/** Both players chose a side action in the same turn: the host's pick of the one that happens, by `pokemon.id` (D8) */
export interface SidePickPayload {
  pokemonId: number;
}

function toWireMove(move: NonNullable<TurnCommand["move"]>): WireTurnMove {
  return { move: move.move, targets: [...move.targets], useMode: move.useMode };
}

/** @returns The wire form of a command, or `null` for no command */
export function commandToWire(command: TurnCommand | null | undefined): WireTurnCommand | null {
  if (command == null) {
    return null;
  }
  const wire: WireTurnCommand = { command: command.command };
  if (command.cursor !== undefined) {
    wire.cursor = command.cursor;
  }
  if (command.move !== undefined) {
    wire.move = toWireMove(command.move);
  }
  if (command.targets !== undefined) {
    wire.targets = [...command.targets];
  }
  if (command.skip !== undefined) {
    wire.skip = command.skip;
  }
  if (command.command === Command.POKEMON) {
    wire.baton = !!command.args?.[0];
  }
  return wire;
}

/** @returns The command the wire form describes, as upstream's `CommandPhase` would have stored it */
export function commandFromWire(wire: WireTurnCommand): TurnCommand {
  const command: TurnCommand = { command: wire.command as Command };
  if (wire.cursor !== undefined) {
    command.cursor = wire.cursor;
  }
  if (wire.move !== undefined) {
    command.move = { move: wire.move.move, targets: [...wire.move.targets], useMode: wire.move.useMode as MoveUseMode };
  }
  if (wire.targets !== undefined) {
    command.targets = [...wire.targets];
  }
  if (wire.skip !== undefined) {
    command.skip = wire.skip;
  }
  if (wire.command === Command.POKEMON) {
    command.args = [wire.baton === true];
  }
  return command;
}

/**
 * Battler indices: at most the four battlers of a double battle, each `BattlerIndex.ATTACKER` (-1, a counter-attack) or
 * one of the four field positions
 */
function isBattlerList(value: unknown): value is number[] {
  return (
    Array.isArray(value)
    && value.length <= 4
    && value.every(entry => Number.isInteger(entry) && entry >= -1 && entry <= 3)
  );
}

function isWireMove(value: unknown): value is WireTurnMove {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const move = value as Record<string, unknown>;
  return Number.isInteger(move["move"]) && isBattlerList(move["targets"]) && Number.isInteger(move["useMode"]);
}

export function isWireCommand(value: unknown): value is WireTurnCommand {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const command = value as Record<string, unknown>;
  return (
    Number.isInteger(command["command"])
    && (command["command"] as number) >= Command.FIGHT
    && (command["command"] as number) <= Command.TERA
    && (command["cursor"] === undefined || Number.isInteger(command["cursor"]))
    && (command["move"] === undefined || isWireMove(command["move"]))
    && (command["targets"] === undefined || isBattlerList(command["targets"]))
    && (command["skip"] === undefined || typeof command["skip"] === "boolean")
    && (command["baton"] === undefined || typeof command["baton"] === "boolean")
  );
}

export function isTurnCommandsPayload(value: unknown): value is TurnCommandsPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  return (
    (payload["command"] === null || isWireCommand(payload["command"]))
    && (payload["pre"] === null || isWireCommand(payload["pre"]))
  );
}

export function isSideActionPayload(value: unknown): value is SideActionPayload {
  return (
    typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)["accept"] === "boolean"
  );
}

export function isSidePickPayload(value: unknown): value is SidePickPayload {
  return (
    typeof value === "object"
    && value !== null
    && Number.isInteger((value as Record<string, unknown>)["pokemonId"])
    && ((value as Record<string, unknown>)["pokemonId"] as number) >= 0
  );
}

/** @returns Whether a command ends the whole turn for the side (upstream: the ally's command is skipped) */
export function isSideAction(command: { command: number } | null | undefined): boolean {
  return command != null && (command.command === Command.BALL || command.command === Command.RUN);
}
