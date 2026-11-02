/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { endCoopSession } from "#coop/session";
import { BattlerIndex } from "#enums/battler-index";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { advanceTo, queueTurnCommands } from "#test/helpers/coop-harness";
import { controllers, type LinkedRunOfThree, openLinkedRunOfThree } from "#test/helpers/coop-linked";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * A linked battle of a game of three (DECISIONS D40): the real client is the host, the two guests are scripted on a hub of
 * one channel each; every decision goes through the sequencer, which has three seats.
 */

const SIX = [
  SpeciesId.BULBASAUR,
  SpeciesId.SQUIRTLE,
  SpeciesId.CHARMANDER,
  SpeciesId.PIKACHU,
  SpeciesId.MACHOP,
  SpeciesId.GEODUDE,
];

describe("Co-op: a linked battle of three (D40)", () => {
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

  async function start(): Promise<LinkedRunOfThree> {
    run = await openLinkedRunOfThree(phaserGame, {
      species: SIX,
      starterOwners: ["host", "host", "guest", "guest", "guest2", "guest2"],
      policy: { auto: ["TURN_COMMANDS", "FAINT_SWITCH", "LEARN_MOVE", "EVOLUTION_CANCEL"] },
      configure: game => game.override.startingLevel(20),
    });
    return run;
  }

  it("each player commands the Pokémon of their own slot, and all three act in the turn", async () => {
    const r = await start();
    await advanceTo(r.ctx, ["CommandPhase"]);
    expect(controllers()).toEqual(["host", "guest", "guest2"]);
    const field = r.ctx.game.scene.getPlayerField();
    expect(field.map(pokemon => pokemon.getBattlerIndex())).toEqual([
      BattlerIndex.PLAYER,
      BattlerIndex.PLAYER_2,
      BattlerIndex.PLAYER_3,
    ]);

    queueTurnCommands(r.ctx);
    await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);
    // the host's own command and each guest's sequenced one were all used
    for (const pokemon of field) {
      expect(pokemon.getLastXMoves(1)[0]?.move, `${pokemon.name} acted`).toBe(MoveId.BITE);
    }
    // nobody's command went to an enemy's place: the enemies chose their own
    expect(r.session.link?.players).toBe(3);
  });
});
