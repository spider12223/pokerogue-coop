/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createCoopGameMode } from "#app/game-mode";
import { globalScene } from "#app/global-scene";
import { BattleType } from "#enums/battle-type";
import { GameModes } from "#enums/game-modes";
import { MoveId } from "#enums/move-id";
import { PlayerGender } from "#enums/player-gender";
import { SpeciesId } from "#enums/species-id";
import {
  accountWith,
  advanceTo,
  type ClientConfig,
  Decider,
  describeWave,
  expectSameCheckpoints,
  openCoopRun,
  playClient,
  queueTurnCommands,
  type Scenario,
  type SharedRun,
  type WaveInfo,
} from "#test/helpers/coop-harness";
import Phaser from "phaser";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Co-op Endless (DECISIONS D39): solo Endless's rules with every co-op rule. Both clients build the same run, its boss
 * waves are doubles against one boss, and a guest with another account replays the host's endless run to the same hashes.
 */

const SCENARIO: Scenario = {
  species: [SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER, SpeciesId.PIKACHU],
  waves: 12,
  // Bite is Dark: nothing is immune to it
  moveset: [MoveId.BITE, MoveId.MEMENTO, MoveId.GROWL, MoveId.TAIL_WHIP],
  faints: [],
  faintMove: MoveId.MEMENTO,
  starterOwners: ["host", "guest", "host", "guest"],
  endless: true,
};

const HOST_ACCOUNT = accountWith({ trainerId: 3131, secretId: 1313 });
const GUEST_ACCOUNT = accountWith({ trainerId: 7777, secretId: 4242 });

const SHARED: SharedRun = {
  runSeed: "co-op-endless",
  snapshot: { host: HOST_ACCOUNT, guest: GUEST_ACCOUNT },
  hostPlayerGender: PlayerGender.MALE,
};

const HOST: ClientConfig = {
  seat: "host",
  liveAccount: HOST_ACCOUNT,
  localSettings: {},
  applyOverlay: true,
  bypassSnapshot: false,
  stallMs: 20_000,
};

const GUEST: ClientConfig = {
  seat: "guest",
  liveAccount: GUEST_ACCOUNT,
  localSettings: { general: { gameSpeed: 4, playerGender: PlayerGender.FEMALE } },
  applyOverlay: true,
  bypassSnapshot: false,
  stallMs: 20_000,
};

const TEST_MS = 600_000;

describe("Co-op Endless (D39)", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  it("is solo Endless with the co-op flag; anything but Endless is Classic", () => {
    const endless = createCoopGameMode(GameModes.ENDLESS);
    expect(endless.modeId).toBe(GameModes.ENDLESS);
    expect(endless).toMatchObject({ isCoop: true, isEndless: true, hasShortBiomes: true, hasRandomBosses: true });
    // as solo Endless: no trainers and no Mystery Encounters (the flags are left unset there too)
    expect(endless.isClassic).toBeFalsy();
    expect(endless.hasTrainers).toBeFalsy();
    expect(endless.hasMysteryEncounters).toBeFalsy();
    // a save from before D39 has Classic's id, and a co-op run is never Daily or Challenge
    for (const modeId of [undefined, GameModes.CLASSIC, GameModes.DAILY, GameModes.CHALLENGE]) {
      const mode = createCoopGameMode(modeId);
      expect(mode.modeId).toBe(GameModes.CLASSIC);
      expect(mode).toMatchObject({ isCoop: true, isClassic: true, hasTrainers: true });
      expect(mode.isEndless).toBeFalsy();
    }
  });

  /** Start an endless run at `wave`, look at the battle and play one turn of it */
  async function surveyWave(wave: number): Promise<{ info: WaveInfo; failure: string | null }> {
    const run = await openCoopRun(phaserGame, SHARED, HOST, Decider.recording(), {
      ...SCENARIO,
      waves: 0,
      configure: game => {
        game.override.startingWave(wave).battleType(BattleType.WILD);
        // a boss may open with dialogue that waits for input
        vi.spyOn(game.scene.ui, "shouldSkipDialogue").mockReturnValue(true);
      },
    });
    const { ctx } = run;
    let failure: string | null = null;
    let info!: WaveInfo;
    try {
      await advanceTo(ctx, ["CommandPhase"]);
      info = describeWave(ctx);
      expect(globalScene.gameMode.isEndless).toBe(true);
      queueTurnCommands(ctx);
      await advanceTo(ctx, ["TurnInitPhase", "SelectModifierPhase"]);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      info ??= describeWave(ctx);
    } finally {
      run.close();
    }
    return { info, failure };
  }

  it(
    "its boss waves are doubles against one boss; the waves between have two",
    async () => {
      for (const wave of [50, 250, 1000]) {
        const { info, failure } = await surveyWave(wave);
        expect(failure, `wave ${wave}`).toBeNull();
        expect(info, `wave ${wave}`).toMatchObject({ double: true, trainer: false, enemyParty: 1, enemyField: 1 });
        expect(info.boss, `wave ${wave}`).toBe(true);
        expect(info.controllers, `wave ${wave}`).toEqual(["host", "guest"]);
      }
      const { info, failure } = await surveyWave(51);
      expect(failure).toBeNull();
      expect(info).toMatchObject({ double: true, enemyParty: 2, enemyField: 2 });
    },
    TEST_MS,
  );

  it(
    "a guest with another account replays the host's endless run to the same hashes",
    async () => {
      const recorded = await playClient(phaserGame, SHARED, HOST, Decider.recording(), SCENARIO);
      expect(recorded.stalledIn, JSON.stringify(recorded.stalledIn)).toBeNull();
      expect(recorded.waves.map(w => w.wave)).toEqual(Array.from({ length: SCENARIO.waves }, (_, i) => i + 1));
      // every wave a double, and no trainer: Endless has none
      expect(recorded.waves.every(w => w.double)).toBe(true);
      expect(recorded.waves.some(w => w.trainer)).toBe(false);
      // the reward screens alternate between the seats, as in Classic
      const pickers = recorded.decisions.filter(d => d.key.kind === "REWARD_PICK").map(d => d.by);
      expect(pickers.length).toBeGreaterThanOrEqual(5);
      expect(pickers).toEqual(pickers.map((_, i) => (i % 2 === 0 ? "host" : "guest")));

      const replayed = await playClient(
        phaserGame,
        SHARED,
        GUEST,
        Decider.replaying(recorded.decisions),
        SCENARIO,
        recorded.checkpoints,
      );
      expect(replayed.stalledIn).toBeNull();
      expect(replayed.divergence).toBeNull();
      expectSameCheckpoints(recorded, replayed);
      expect(replayed.decisions).toEqual(recorded.decisions);
      expect(replayed.waves).toEqual(recorded.waves);
    },
    TEST_MS,
  );
});
