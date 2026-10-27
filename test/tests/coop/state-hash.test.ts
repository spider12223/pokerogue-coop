/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { settings } from "#app/global-settings-manager";
import type { AccountSnapshot } from "#coop/account-snapshot";
import { coopCheckpoint, tracePhaseStart } from "#coop/checkpoints";
import { endCoopSession, startCoopSession } from "#coop/session";
import {
  captureStateSnapshot,
  computeStateHash,
  describeModifierType,
  describeRewardOption,
  registerOpenRewardOptions,
} from "#coop/state-hash";
import { MoveId } from "#enums/move-id";
import { PokemonType } from "#enums/pokemon-type";
import { SpeciesId } from "#enums/species-id";
import { AttackTypeBoosterModifierType, ModifierTypeOption, TmModifierType } from "#modifiers/modifier-type";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ACCOUNT: AccountSnapshot = {
  trainerId: 1,
  secretId: 2,
  unlocked: { eviolite: false, miniBlackHole: false },
  caught: {},
  eggMoves: {},
};

function startSession() {
  return startCoopSession({
    seat: "host",
    runSeed: "hash-seed",
    build: { protocolVersion: 1, gitSha: "x", dirtyHash: "clean", buildMode: "test", overridesHash: "0" },
    accountSnapshot: { host: ACCOUNT, guest: ACCOUNT },
  });
}

describe("Co-op: state hash, checkpoints and phase trace (DECISIONS D13)", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override.battleStyle("double").moveset([MoveId.SPLASH]).enemyMoveset(MoveId.SPLASH);
  });

  afterEach(() => {
    endCoopSession();
    settings.update("general", "enableTutorials", false);
  });

  describe("what the hash covers", () => {
    it("is stable for the same state and changes with the state", async () => {
      await game.classicMode.startBattle(SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE);
      const base = computeStateHash();
      expect(computeStateHash()).toBe(base);

      const pokemon = game.field.getPlayerPokemon();
      pokemon.hp -= 1;
      expect(computeStateHash()).not.toBe(base);
      pokemon.hp += 1;
      expect(computeStateHash()).toBe(base);

      game.scene.money += 1;
      expect(computeStateHash()).not.toBe(base);
      game.scene.money -= 1;

      pokemon.shiny = !pokemon.shiny;
      expect(computeStateHash()).not.toBe(base);
      pokemon.shiny = !pokemon.shiny;

      game.scene.waveSeed = `${game.scene.waveSeed}x`;
      expect(computeStateHash()).not.toBe(base);
    });

    it("leaves out the wall clock: timestamp and playTime do not matter", async () => {
      await game.classicMode.startBattle(SpeciesId.BULBASAUR);
      const base = computeStateHash();
      game.scene.gameData.gameStats.playTime += 1000;
      game.scene.gameData.gameStats.battles += 5;
      expect(computeStateHash()).toBe(base);
      expect(JSON.stringify(captureStateSnapshot())).not.toMatch(/timestamp|playTime/);
    });

    it("covers the pinned settings, so a client that does not run with them fails its first checkpoint", async () => {
      await game.classicMode.startBattle(SpeciesId.BULBASAUR);
      const base = computeStateHash();
      settings.update("general", "enableTutorials", true);
      expect(computeStateHash()).not.toBe(base);
      settings.update("general", "enableTutorials", false);
      expect(computeStateHash()).toBe(base);
      // a setting that is local only does not matter
      settings.update("general", "gameSpeed", 3);
      expect(computeStateHash()).toBe(base);
      settings.update("general", "gameSpeed", 5);
    });
  });

  describe("reward options are hashed by type and generated arguments (D9)", () => {
    function tm(moveId: MoveId) {
      const type = new TmModifierType(moveId);
      type.id = "TM_COMMON";
      return new ModifierTypeOption(type, 0, 100);
    }

    function booster(pokemonType: PokemonType) {
      const type = new AttackTypeBoosterModifierType(pokemonType, 20);
      type.id = "ATTACK_TYPE_BOOSTER";
      return new ModifierTypeOption(type, 0, 100);
    }

    it("tells the same type with different generated arguments apart", () => {
      expect(describeRewardOption(tm(MoveId.TACKLE))).toMatchObject({
        id: "TM_COMMON",
        args: { moveId: MoveId.TACKLE },
      });
      expect(describeRewardOption(tm(MoveId.TACKLE))).not.toEqual(describeRewardOption(tm(MoveId.SPLASH)));
      expect(describeRewardOption(booster(PokemonType.FIRE))).toMatchObject({
        id: "ATTACK_TYPE_BOOSTER",
        args: { moveType: PokemonType.FIRE, boostPercent: 20 },
      });
      expect(describeRewardOption(booster(PokemonType.FIRE))).not.toEqual(
        describeRewardOption(booster(PokemonType.WATER)),
      );
      expect(describeModifierType(booster(PokemonType.FIRE).type).args).not.toHaveProperty("localeKey");
    });

    it("counts in the hash only while its reward screen is the current phase", async () => {
      await game.classicMode.startBattle(SpeciesId.BULBASAUR);
      const base = computeStateHash();
      const phase = game.scene.phaseManager.getCurrentPhase();

      registerOpenRewardOptions(phase, [tm(MoveId.TACKLE)]);
      const withTackle = computeStateHash();
      expect(withTackle).not.toBe(base);
      expect(captureStateSnapshot().rewardOptions).toHaveLength(1);

      registerOpenRewardOptions(phase, [tm(MoveId.SPLASH)]);
      expect(computeStateHash()).not.toBe(withTackle);

      registerOpenRewardOptions({}, [tm(MoveId.TACKLE)]); // some other phase's options
      expect(computeStateHash()).toBe(base);
    });
  });

  describe("hooks", () => {
    it("do nothing in solo play", async () => {
      await game.classicMode.startBattle(SpeciesId.BULBASAUR);
      expect(coopCheckpoint("turn", "TurnInitPhase")).toBeNull();
      expect(() => tracePhaseStart({ phaseName: "TurnInitPhase" })).not.toThrow();
    });

    it("take a checkpoint with the state hash, log it and tell the listener", async () => {
      await game.classicMode.startBattle(SpeciesId.BULBASAUR);
      const session = startSession();
      const told: string[] = [];
      session.onCheckpoint = checkpoint => told.push(`${checkpoint.index}:${checkpoint.kind}`);

      const first = coopCheckpoint("turn", "TurnInitPhase")!;
      expect(first).toMatchObject({ index: 0, kind: "turn", phaseName: "TurnInitPhase", hash: computeStateHash() });
      expect(first.wave).toBe(game.scene.currentBattle.waveIndex);
      game.scene.money += 1;
      const second = coopCheckpoint("waveEnd", "BattleEndPhase")!;

      expect(second.index).toBe(1);
      expect(second.hash).not.toBe(first.hash);
      expect(session.checkpoints.entries.map(c => c.kind)).toEqual(["turn", "waveEnd"]);
      expect(told).toEqual(["0:turn", "1:waveEnd"]);
    });

    it("record every phase start in the phase trace, with the RNG state", async () => {
      await game.classicMode.startBattle(SpeciesId.BULBASAUR);
      const session = startSession();

      tracePhaseStart({ phaseName: "MovePhase" });
      Phaser.Math.RND.integerInRange(0, 1000);
      tracePhaseStart({ phaseName: "MoveEndPhase" });

      const [a, b] = session.trace.dump();
      expect([a.phaseName, b.phaseName]).toEqual(["MovePhase", "MoveEndPhase"]);
      expect(a.wave).toBe(game.scene.currentBattle.waveIndex);
      expect(a.rng).not.toBe(b.rng);
    });
  });
});
