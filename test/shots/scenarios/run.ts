/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { MoveId } from "../../../src/enums/move-id.ts";
import { type ClientState, choose } from "../engine.ts";
import type { Scenario } from "../scenario.ts";

/** The run around the battles: the menu's Save and Quit (D20), the end of a run (D35) */

/** The menu's entry (`menuUiHandler:saveAndQuit`) */
const SAVE_AND_QUIT = "Save and Quit";

const atTitle = (state: ClientState): boolean => state.phase === "TitlePhase" && state.ui === "TITLE";

const saveAndQuit: Scenario = {
  id: "run:save-quit",
  area: "Run",
  summary: "--seat opens the menu in a battle and saves and quits: what each player sees, back to the title",
  vars: { seat: null },
  async play(run, vars) {
    await run.toRun();
    await run.drive({ until: states => states.every(state => state.ui === "COMMAND"), shoot: () => false });
    await run.pressFor(vars.seat, "MENU", "MENU");
    await run.shot("menu");
    await run.act(vars.seat, choose(await run.state(vars.seat), SAVE_AND_QUIT));
    await run.drive({ until: states => states.every(atTitle), maxSteps: 30 });
  },
};

/** Strong foes against every player's only Pokémon, at level 5 */
const LOSE = { ENEMY_LEVEL_OVERRIDE: 100, ENEMY_MOVESET_OVERRIDE: [MoveId.TACKLE] };
/** The host's question after a lost wave (D4a) */
const RETRY = "Retry the wave";
const END = "End the run";

const gameOver: Scenario = {
  id: "run:game-over",
  area: "Run",
  summary: "every player's only Pokémon faints; the host ends the run: the shared game over, to the title",
  vars: { level: 5 },
  async play(run) {
    await run.toRun(LOSE);
    await run.drive({
      until: states => states.every(atTitle),
      answer: state => (state.menu.includes(END) ? choose(state, END) : undefined),
      maxSteps: 60,
    });
  },
};

const retry: Scenario = {
  id: "run:retry",
  area: "Run",
  summary: "every player's only Pokémon faints; the host retries the wave (D4a): everyone back at its start",
  vars: { level: 5 },
  async play(run) {
    await run.toRun(LOSE);
    let retried = false;
    await run.drive({
      until: states => retried && states.every(state => state.ui === "COMMAND"),
      answer: state => {
        if (!state.menu.includes(RETRY)) {
          return;
        }
        retried = true;
        return choose(state, RETRY);
      },
    });
  },
};

export const runScenarios: Scenario[] = [saveAndQuit, gameOver, retry];
