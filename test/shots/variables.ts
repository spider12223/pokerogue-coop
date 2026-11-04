/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * The variables of `pnpm shot`: every one is defined here once, with its values and default, and a scenario says which it
 * takes (`Scenario.vars`). The common ones (`COMMON`) apply to every scenario.
 *
 * To add one: an entry in `VARIABLES`, a check in `checkVars` if it depends on another, then use `vars.<name>` in the
 * scenarios that take it.
 *
 * @module
 */

export const SEATS = ["host", "guest", "guest2"] as const;
export type Seat = (typeof SEATS)[number];

interface ChoiceVariable {
  kind: "choice";
  values: readonly string[];
  default: string;
  describe: string;
}

interface NumberVariable {
  kind: "number";
  min: number;
  max: number;
  default: number;
  describe: string;
}

interface TextVariable {
  kind: "text";
  default: string;
  describe: string;
}

export type Variable = ChoiceVariable | NumberVariable | TextVariable;

export const VARIABLES = {
  players: {
    kind: "choice",
    values: ["2", "3"],
    default: "2",
    describe: "players in the room (3 turns 3-Player Co-op (Beta) on for the host, D40)",
  },
  mode: {
    kind: "choice",
    values: ["classic", "endless"],
    default: "classic",
    describe: "the kind of run the host picks (D39)",
  },
  speed: {
    kind: "choice",
    values: ["normal", "fast"],
    default: "normal",
    describe:
      "normal: a new player's settings (a line that goes on by itself stays up long enough to be shot); fast: game speed 5, no move animations",
  },
  level: { kind: "number", min: 1, max: 200, default: 20, describe: "the starting level of every player Pokémon" },
  party: {
    kind: "number",
    min: 0,
    max: 3,
    default: 1,
    describe: "Pokémon each player starts with; 0: as many as a player may hold (3, or 2 in a game of three)",
  },
  wave: { kind: "number", min: 1, max: 200, default: 1, describe: "the wave the run starts at" },
  money: {
    kind: "number",
    min: 0,
    max: 10_000_000,
    default: 0,
    describe: "the money the run starts with (0: the game's own)",
  },
  seat: {
    kind: "choice",
    values: SEATS,
    default: "host",
    describe: "the player who acts (picks the reward, buys, throws the ball, asks for the trade, ...)",
  },
  to: {
    kind: "choice",
    values: ["next", ...SEATS],
    default: "next",
    describe: "the other player of a trade (next: the seat after --seat)",
  },
  option: { kind: "number", min: 1, max: 4, default: 1, describe: "the encounter option chosen (1: the first)" },
  goer: {
    kind: "choice",
    values: SEATS,
    default: "host",
    describe: "who goes, in an encounter only one Pokémon takes part in (D29)",
  },
  pick: {
    kind: "number",
    min: 1,
    max: 3,
    default: 1,
    describe: "which of the chooser's Pokémon is picked when the game asks for one (1: the first allowed)",
  },
  item: {
    kind: "text",
    default: "",
    describe: "the first reward of the reward screen, by its key in modifier-type.ts (e.g. TM_COMMON, RARE_CANDY)",
  },
} as const satisfies Record<string, Variable>;

export type VariableName = keyof typeof VARIABLES;

/** The variables every scenario takes */
export const COMMON: readonly VariableName[] = ["players", "mode", "speed", "level", "party", "money"];

/** The value of each variable a run has: a choice or text as a string, a number as a number */
export type Vars = {
  [K in VariableName]: (typeof VARIABLES)[K] extends { kind: "number" } ? number : string;
} & {
  players: "2" | "3";
  mode: "classic" | "endless";
  speed: "fast" | "normal";
  seat: Seat;
  to: Seat | "next";
  goer: Seat;
};

/** The seats of a room of this many players, host first */
export function seatsOf(players: "2" | "3"): Seat[] {
  return players === "3" ? ["host", "guest", "guest2"] : ["host", "guest"];
}

/**
 * The run's variables: each variable's default, then the scenario's defaults, then what was typed.
 * @param allowed - The variables the scenario takes (with `COMMON`)
 * @param defaults - The scenario's own defaults
 * @param typed - What was typed, `--name value`
 * @throws An `Error` that says what is wrong, for a variable the scenario does not take or a value that is not one
 */
export function resolveVars(
  allowed: readonly VariableName[],
  defaults: Partial<Record<VariableName, string | number>>,
  typed: Record<string, string>,
): Vars {
  const vars: Record<string, string | number> = {};
  for (const [name, variable] of Object.entries(VARIABLES) as [VariableName, Variable][]) {
    vars[name] = defaults[name] ?? variable.default;
  }
  for (const [name, raw] of Object.entries(typed)) {
    if (!(name in VARIABLES)) {
      throw new Error(`there is no variable --${name}; the variables: ${Object.keys(VARIABLES).join(", ")}`);
    }
    const variableName = name as VariableName;
    if (!allowed.includes(variableName)) {
      throw new Error(`this scenario does not take --${name}; it takes: ${allowed.map(v => `--${v}`).join(" ")}`);
    }
    vars[name] = parseValue(variableName, raw);
  }
  checkVars(vars as Vars);
  return vars as Vars;
}

function parseValue(name: VariableName, raw: string): string | number {
  const variable: Variable = VARIABLES[name];
  switch (variable.kind) {
    case "choice":
      if (!variable.values.includes(raw)) {
        throw new Error(`--${name} is one of ${variable.values.join(", ")}, not "${raw}"`);
      }
      return raw;
    case "number": {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < variable.min || value > variable.max) {
        throw new Error(`--${name} is a whole number from ${variable.min} to ${variable.max}, not "${raw}"`);
      }
      return value;
    }
    case "text":
      return raw;
  }
}

/** The rules between variables: the seats that are in the room, and how many Pokémon a player may hold */
function checkVars(vars: Vars): void {
  const seats = seatsOf(vars.players);
  for (const name of ["seat", "to", "goer"] as const) {
    const seat = vars[name];
    if (seat !== "next" && !seats.includes(seat)) {
      throw new Error(`--${name} ${seat} needs --players 3`);
    }
  }
  const most = vars.players === "3" ? 2 : 3;
  if (vars.party > most) {
    throw new Error(`--party is at most ${most} in a game of ${vars.players}`);
  }
  if (vars.to === vars.seat) {
    throw new Error(`--to is the other player: not --seat ${vars.seat} again`);
  }
}

/** The other player of a trade: `--to`, or the seat after `--seat` */
export function partnerOf(vars: Vars): Seat {
  if (vars.to !== "next") {
    return vars.to;
  }
  const seats = seatsOf(vars.players);
  return seats[(seats.indexOf(vars.seat) + 1) % seats.length];
}

/** The variables that differ from the scenario's defaults, as `name-value`, for the name of the output folder */
export function varsLabel(
  vars: Vars,
  allowed: readonly VariableName[],
  defaults: Partial<Record<VariableName, string | number>>,
): string {
  return allowed
    .filter(name => vars[name] !== (defaults[name] ?? VARIABLES[name].default))
    .map(name => `${name}-${vars[name]}`)
    .join("_");
}
