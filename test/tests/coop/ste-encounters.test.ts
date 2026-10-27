/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MeChoice, MeQuestion } from "#coop/me-choice";
import { isOnePokemonEncounter, setMeAutoAnswers } from "#coop/me-run";
import type { CheckpointMessage, Seat } from "#coop/protocol";
import { requireCoopSession } from "#coop/session";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { allMysteryEncounters } from "#mystery-encounters/mystery-encounter-biomes";
import { WaveRangeRequirement } from "#mystery-encounters/mystery-encounter-requirements";
import { advanceTo, openUi, queueTurnCommands } from "#test/helpers/coop-harness";
import { describeStall, type LinkedRun, openLinkedRun, pickerSkips, restorePp } from "#test/helpers/coop-linked";
import { getEnumValues } from "#utils/enums";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * The encounter tour (DECISIONS D29, with the STE legs: `pnpm test:ste`). Every Mystery Encounter, every option of it, is
 * played twice: with the real client as the host (it chooses) and as the guest (the scripted host chooses, the real client
 * waits and carries out). Both runs must pass the same state-hash checkpoints and start the same phases between them (D27):
 * the chooser's code path and the waiting player's must come to the same game, whatever the encounter does.
 *
 * The choices are the same in both runs: the option of the run (or the first that can be chosen, then the last one if the
 * encounter keeps coming back to its options), the chooser's first Pokémon the encounter allows, the first entry of a
 * menu, "yes", a catch at the cap is declined. An encounter for one Pokémon is played once with each player going.
 */

const STE = process.env.COOP_STE === "1" || import.meta.env.MODE === "ste";

const SIX = [
  SpeciesId.BULBASAUR,
  SpeciesId.SQUIRTLE,
  SpeciesId.CHARMANDER,
  SpeciesId.PIKACHU,
  SpeciesId.MACHOP,
  SpeciesId.GEODUDE,
];

interface TourRun {
  checkpoints: CheckpointMessage[];
  segments: number[];
  desync: string | null;
  end: string;
  /** The party at the end, for the message of a failure */
  party: string[];
}

/**
 * The answers of a tour run: the same in both seats' runs
 * @param who - Who goes in an encounter for one Pokémon, if they can
 */
function tourAnswers(option: number, who: Seat): (question: MeQuestion) => MeChoice {
  let optionAsks = 0;
  return question => {
    const first = (flags?: readonly boolean[]): number => flags?.findIndex(Boolean) ?? -1;
    switch (question.k) {
      case "option": {
        const enabled = question.enabled ?? [];
        optionAsks++;
        // back at the options again: the last one, usually the way out
        const wanted = optionAsks === 1 ? option : optionAsks === 2 ? first(enabled) : enabled.lastIndexOf(true);
        return { k: "option", index: enabled[wanted] ? wanted : first(enabled) };
      }
      case "pokemon":
        return { k: "pokemon", pokemonId: question.pokemon?.[0] ?? null };
      case "sub": {
        const index = first(question.enabled);
        return { k: "sub", index: index < 0 ? null : index };
      }
      case "optionPokemon": {
        const index = first(question.enabled);
        const pokemonId = question.pokemon?.[0] ?? null;
        return index < 0 || pokemonId === null
          ? { k: "optionPokemon", index: null, pokemonId: null }
          : { k: "optionPokemon", index, pokemonId };
      }
      case "confirm":
        return { k: "confirm", yes: true };
      case "who":
        return { k: "who", seat: question.seats?.includes(who) ? who : (question.seats?.[0] ?? null) };
    }
  };
}

/** A wave inside the encounter's range, that is neither the first of a ten nor a boss wave */
function tourWave(type: MysteryEncounterType): number {
  const range = allMysteryEncounters[type]?.requirements.find(
    (requirement): requirement is WaveRangeRequirement => requirement instanceof WaveRangeRequirement,
  )?.waveRange ?? [10, 180];
  let wave = Math.max(range[0], 12);
  while (wave % 10 === 0 || wave % 10 === 1) {
    wave++;
  }
  return Math.min(wave, range[1]);
}

async function tour(
  phaserGame: Phaser.Game,
  type: MysteryEncounterType,
  option: number,
  who: Seat,
  me: Seat,
): Promise<TourRun> {
  const wave = tourWave(type);
  const answer = tourAnswers(option, who);
  const other: Seat = me === "host" ? "guest" : "host";
  const r: LinkedRun = await openLinkedRun(phaserGame, {
    seat: me,
    species: SIX,
    starterOwners: ["host", "guest", "host", "guest", "host", "guest"],
    configure: game =>
      game.override
        .startingLevel(30)
        .startingWave(wave)
        .mysteryEncounterChance(100)
        .mysteryEncounter(type)
        .disableTrainerWaves(),
    policy: {
      auto: [
        "TURN_COMMANDS",
        "SIDE_ACTION",
        "FAINT_SWITCH",
        "PIVOT_SWITCH",
        "LEARN_MOVE",
        "EVOLUTION_CANCEL",
        "CATCH_RELEASE",
        "BIOME",
        "ME_CHOICE",
      ],
      catchRelease: () => null,
      other: key => {
        const session = requireCoopSession();
        if (key.kind !== "ME_CHOICE" || session.meChooser !== other || session.meQuestion === null) {
          return;
        }
        return answer(session.meQuestion);
      },
    },
  });
  const { ctx, partner, session } = r;
  setMeAutoAnswers({ choose: answer, release: () => null });
  // Enough money for any option that costs some (an encounter that is made to appear did not check it)
  ctx.game.scene.money = 1_000_000;
  const result = (end: string): TourRun => ({
    checkpoints: [...partner.checkpointsSeen],
    segments: [...session.pace.segments],
    desync: session.desyncMessage,
    end,
    party: ctx.game.scene
      .getPlayerParty()
      .map(
        p =>
          `${p.id} ${p.species.speciesId} L${p.level} ${p.nature} ${p.ivs.join(",")} ${p.moveset.map(m => m.moveId).join(",")} ${p.passive} ${p.hp}`,
      ),
  });
  try {
    for (let step = 0; step < 60; step++) {
      const reached = await advanceTo(ctx, ["CommandPhase", "SelectModifierPhase", "NewBattlePhase", "GameOverPhase"]);
      if (reached === "GameOverPhase") {
        return result("game over");
      }
      if (reached === "NewBattlePhase") {
        return result(`wave ${ctx.game.scene.currentBattle.waveIndex} over`);
      }
      if (reached === "SelectModifierPhase") {
        await openUi(ctx, "SelectModifierPhase");
        pickerSkips(r);
        await advanceTo(ctx, [
          "NewBattlePhase",
          "CommandPhase",
          "GameOverPhase",
          "SelectModifierPhase",
          "EncounterPhase",
        ]);
        continue;
      }
      restorePp(ctx.game);
      queueTurnCommands(ctx);
      await advanceTo(ctx, ["TurnInitPhase", "SelectModifierPhase", "NewBattlePhase", "GameOverPhase"]);
    }
    throw new Error(`the encounter did not end: ${describeStall(ctx.game)}`);
  } catch (error) {
    const window = session.openWindow.map(k => `${k.kind}:${k.ref}`).join(",");
    throw new Error(
      `${MysteryEncounterType[type]} option ${option + 1} (${who} goes) as the ${me}: ${(error as Error).message} at ${describeStall(ctx.game)}; window ${window}`,
      { cause: error },
    );
  } finally {
    setMeAutoAnswers(null);
    r.close();
  }
}

describe.runIf(STE)("The encounter tour: every Mystery Encounter, chosen and waited for (D29)", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    setMeAutoAnswers(null);
  });

  const types = getEnumValues(MysteryEncounterType);

  it.each(types.map(type => [MysteryEncounterType[type], type] as const))(
    "%s: the chooser's run and the waiting player's run come to the same game",
    async (_name, type) => {
      const options = allMysteryEncounters[type]?.options.length ?? 2;
      // An encounter for one Pokémon is played by each player in turn: the one who goes commands the battle's lead
      const goers: Seat[] = isOnePokemonEncounter(type) ? ["host", "guest"] : ["host"];
      for (let option = 0; option < options; option++) {
        for (const who of goers) {
          const host = await tour(phaserGame, type, option, who, "host");
          const guest = await tour(phaserGame, type, option, who, "guest");
          const where = `${MysteryEncounterType[type]} option ${option + 1} (${who} goes)`;
          expect(host.desync, `${where}: the host's run`).toBeNull();
          expect(guest.desync, `${where}: the guest's run`).toBeNull();
          expect(guest.end, where).toBe(host.end);
          expect(guest.party, `${where}: the party`).toEqual(host.party);
          expect(
            guest.checkpoints.map(c => `${c.kind}@${c.wave}:${c.turn} ${c.hash}`),
            where,
          ).toEqual(host.checkpoints.map(c => `${c.kind}@${c.wave}:${c.turn} ${c.hash}`));
          expect(guest.segments.slice(1), `${where}: the phases between checkpoints (D27)`).toEqual(
            host.segments.slice(1),
          );
        }
      }
    },
    600_000,
  );
});
