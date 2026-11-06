/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { TurnCommand } from "#app/battle";
import { turnCommandsKey } from "#coop/decisions/decision-keys";
import { checkDecisionLegal } from "#coop/decisions/legal";
import { gameLegalityView } from "#coop/decisions/legal-view";
import { commandToWire } from "#coop/decisions/turn-commands";
import { endCoopSession, requireCoopSession } from "#coop/session";
import { BattlerIndex } from "#enums/battler-index";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { MoveUseMode } from "#enums/move-use-mode";
import { SpeciesId } from "#enums/species-id";
import { getMoveTargets } from "#moves/move-utils";
import { advanceTo } from "#test/helpers/coop-harness";
import { type LinkedRunOfThree, openLinkedRunOfThree } from "#test/helpers/coop-linked";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Every command the game lets a player make in a battle of three must pass the legality check every client runs on it
 * (D24, D40): a choice the game offered and the check refuses is a desync on all three clients at once.
 */

const SIX = [
  SpeciesId.BULBASAUR,
  SpeciesId.SQUIRTLE,
  SpeciesId.CHARMANDER,
  SpeciesId.PIKACHU,
  SpeciesId.MACHOP,
  SpeciesId.GEODUDE,
];

/** Moves of every kind of target */
const MOVESETS: MoveId[][] = [
  [MoveId.TACKLE, MoveId.GROWL, MoveId.HELPING_HAND, MoveId.DEFENSE_CURL],
  [MoveId.EARTHQUAKE, MoveId.ACUPRESSURE, MoveId.RAIN_DANCE, MoveId.SPIKES],
  [MoveId.OUTRAGE, MoveId.HAZE, MoveId.LIGHT_SCREEN, MoveId.AROMATIC_MIST],
  [MoveId.SURF, MoveId.FLING, MoveId.CURSE, MoveId.AFTER_YOU],
];

describe("Co-op: every command the game offers in a battle of three is legal (D24, D40)", () => {
  let phaserGame: Phaser.Game;
  let run: LinkedRunOfThree | null = null;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    run?.close();
    run = null;
    endCoopSession();
  });

  it.each(MOVESETS.map(moves => [moves.map(move => MoveId[move]).join(", "), moves] as const))(
    "moves %s, from each of the three slots, at every target the game offers",
    async (_, moves) => {
      run = await openLinkedRunOfThree(phaserGame, {
        species: SIX,
        starterOwners: ["host", "host", "guest", "guest", "guest2", "guest2"],
        policy: { auto: ["TURN_COMMANDS", "FAINT_SWITCH", "LEARN_MOVE", "EVOLUTION_CANCEL"] },
        configure: game => game.override.startingLevel(20).moveset(moves),
      });
      await advanceTo(run.ctx, ["CommandPhase"]);
      const scene = run.ctx.game.scene;
      const { waveIndex, turn } = scene.currentBattle;
      const session = requireCoopSession();
      const refused: string[] = [];
      for (const pokemon of scene.getPlayerField()) {
        const battler = pokemon.getBattlerIndex();
        const owner = session.ownership.get(pokemon.id)!;
        for (const [cursor, move] of pokemon.getMoveset().entries()) {
          const moveId = move.moveId;
          // what `CommandPhase.handleFightCommand` and the target screen make of it
          const set = getMoveTargets(pokemon, moveId);
          const picks = set.multiple || set.targets.length <= 1 ? [set.targets] : set.targets.map(target => [target]);
          for (const targets of picks) {
            const command: TurnCommand = {
              command: Command.FIGHT,
              cursor,
              move: {
                move: moveId,
                targets: set.multiple || set.targets.length <= 1 ? [...set.targets] : [],
                useMode: MoveUseMode.NORMAL,
              },
              targets: [...targets],
            };
            const pre: TurnCommand = { command: Command.FIGHT, targets: [battler], skip: true };
            const payload = { command: commandToWire(command), pre: commandToWire(pre) };
            const problem = checkDecisionLegal(
              gameLegalityView(),
              turnCommandsKey(waveIndex, turn, pokemon.id),
              payload,
              owner,
            );
            if (problem !== null) {
              refused.push(
                `${BattlerIndex[battler]} ${MoveId[moveId]} at [${targets.map(target => BattlerIndex[target])}]: ${problem}`,
              );
            }
          }
        }
      }
      expect(refused).toEqual([]);
    },
  );
});
