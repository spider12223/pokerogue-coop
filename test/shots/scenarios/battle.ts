/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { MoveId } from "../../../src/enums/move-id.ts";
import { PokeballType } from "../../../src/enums/pokeball.ts";
import type { Action, ClientState } from "../engine.ts";
import type { Scenario } from "../scenario.ts";

/** In a battle: the commands of a turn, and what a player can do instead of a move */

const won = (state: ClientState): boolean => state.ui === "MODIFIER_SELECT";

const turn: Scenario = {
  id: "battle:turn",
  area: "Battle",
  summary: "one turn of a double battle: every player's command menu, move and target, the waiting screen, the turn",
  vars: { wave: null },
  async play(run) {
    await run.toRun();
    await run.drive({
      until: states => states.every(state => (state.turn >= 2 && state.ui === "COMMAND") || won(state)),
    });
  },
};

/** The command menu's entries (`Command` of `src/enums/command.ts`) */
const FIGHT = 0;
const BALL = 1;
const POKEMON = 2;
/** `BattlerIndex.ENEMY`: the target select's first foe */
const FIRST_FOE = 2;

const nextTurn = (states: ClientState[]) =>
  states.some(state => (state.turn >= 2 && state.ui === "COMMAND") || won(state));

const switchOut: Scenario = {
  id: "battle:switch",
  area: "Battle",
  summary: "--seat switches its Pokémon out (the party, the switch, the new one on the field); the others fight",
  vars: { seat: null, party: 2 },
  async play(run, vars) {
    await run.toRun();
    let done = false;
    await run.drive({
      until: nextTurn,
      answer: (state): Action | undefined => {
        if (state.seat !== vars.seat || done) {
          return undefined;
        }
        if (state.ui === "COMMAND") {
          return { cursor: POKEMON, press: "ACTION" };
        }
        if (state.ui === "PARTY") {
          // the seat's second Pokémon: the first is on the field
          const member = state.party.map((m, i) => ({ ...m, i })).filter(m => m.owner === state.seat)[1];
          if (member === undefined) {
            throw new Error(`${state.seat} has one Pokémon: --party 2`);
          }
          done = true;
          return { member: member.i };
        }
        return undefined;
      },
    });
  },
};

const catchOne: Scenario = {
  id: "battle:catch",
  area: "Battle",
  summary: "one foe is knocked out, then --seat throws a Poké Ball at the other: the throw, the catch if it holds",
  vars: { seat: null, level: 40 },
  async play(run, vars) {
    // Tackle knocks a wave-1 foe out; Growl does nothing to it. (The ball override cannot be used: a run's balls are
    // counted when it is made, before the players link.)
    await run.toRun({ MOVESET_OVERRIDE: [MoveId.TACKLE, MoveId.GROWL] });
    await run.drive({
      // caught (the wave is won), or the turn of the throw is over
      until: states =>
        states.some(state => won(state) || state.wave > 1 || (state.turn >= 3 && state.ui === "COMMAND")),
      answer: (state): Action | undefined => {
        const thrower = state.seat === vars.seat;
        switch (state.ui) {
          case "COMMAND":
            // turn 1: the seat knocks the first foe out, the others do nothing to it; turn 2: the seat throws
            return { cursor: thrower && state.turn >= 2 ? BALL : FIGHT, press: "ACTION" };
          case "FIGHT":
            return { cursor: thrower ? 0 : 1, press: "ACTION" };
          case "TARGET_SELECT":
            return { cursor: FIRST_FOE, press: "ACTION" };
          case "BALL":
            return { cursor: PokeballType.POKEBALL, press: "ACTION" };
          default:
            return undefined;
        }
      },
    });
  },
};

/**
 * --seat catches until it has all a player may keep while the party has room (3 each, 2 in a game of three: D10, D40): the
 * next catch asks it to release one of its own. A player's report: the game called the party full with five in it.
 * A ball can be thrown at one foe only: on the first turn of a wave the others knock one foe out, then --seat throws. One
 * catch a wave, the reward screen is skipped in between.
 */
const catchAtCap: Scenario = {
  id: "battle:catch-cap",
  area: "Battle",
  summary: "--seat catches one a wave until it has its share, with room in the party: the question of the next catch",
  vars: { seat: null, level: 40, party: 2 },
  async play(run, vars) {
    await run.toRun({
      MOVESET_OVERRIDE: [MoveId.TACKLE, MoveId.GROWL],
      DISABLE_STANDARD_TRAINERS_OVERRIDE: true,
      MYSTERY_ENCOUNTER_RATE_OVERRIDE: 0,
    });
    await run.drive({
      until: states =>
        states.some(
          state => (state.seat === vars.seat && state.ui === "OPTION_SELECT") || state.wave > 4 || state.turn >= 10,
        ),
      answer: (state): Action | null | undefined => {
        const thrower = state.seat === vars.seat;
        switch (state.ui) {
          case "COMMAND":
            // turn 1: one foe is knocked out (by the others; Growl does nothing); then --seat throws
            return { cursor: thrower && state.turn >= 2 ? BALL : FIGHT, press: "ACTION" };
          case "FIGHT":
            return { cursor: thrower || state.turn >= 2 ? 1 : 0, press: "ACTION" };
          case "TARGET_SELECT":
            return { cursor: FIRST_FOE, press: "ACTION" };
          case "BALL":
            return { cursor: PokeballType.POKEBALL, press: "ACTION" };
          case "MODIFIER_SELECT":
            // the picker skips the reward screen ("yes" is the bot's); the others wait
            return state.reward?.ready && state.reward.picker === state.seat ? { press: "CANCEL" } : null;
          default:
            return undefined;
        }
      },
    });
  },
};

const faint: Scenario = {
  id: "battle:faint",
  area: "Battle",
  summary: "strong foes knock every player's Pokémon out: the faint, and each player's choice of who comes in",
  vars: { party: 2, level: 5 },
  async play(run) {
    await run.toRun({ ENEMY_LEVEL_OVERRIDE: 100, ENEMY_MOVESET_OVERRIDE: [MoveId.TACKLE] });
    await run.drive({
      until: states => states.some(state => state.turn >= 2 && state.ui === "COMMAND"),
    });
  },
};

export const battleScenarios: Scenario[] = [turn, switchOut, catchOne, catchAtCap, faint];
