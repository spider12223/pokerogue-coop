/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { timedEventManager } from "#app/global-event-manager";
import { globalScene } from "#app/global-scene";
import type { AccountSnapshot } from "#coop/account-snapshot";
import { endCoopSession, startCoopSession } from "#coop/session";
import { applyCoopRunSeed, simRandInt } from "#coop/sim-rng";
import { Egg } from "#data/egg";
import { getRandomStatus, Status } from "#data/status-effect";
import { EggSourceType } from "#enums/egg-source-types";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { StatusEffect } from "#enums/status-effect";
import { TrainerType } from "#enums/trainer-type";
import { TrainerVariant } from "#enums/trainer-variant";
import { Trainer } from "#field/trainer";
import { EggLapsePhase } from "#phases/egg-lapse-phase";
import { TrainerVictoryPhase } from "#phases/trainer-victory-phase";
import { EggData } from "#system/egg-data";
import { vouchers } from "#system/voucher";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const BUILD = {
  protocolVersion: 1,
  gitSha: "x",
  dirtyHash: "clean",
  buildMode: "test",
  overridesHash: "0",
} as const;

const ACCOUNT: AccountSnapshot = {
  trainerId: 1,
  secretId: 2,
  unlocked: { eviolite: false, miniBlackHole: false },
  caught: {},
  eggMoves: {},
};

/** A co-op session: creating a Pokémon in co-op needs the account snapshot (the shiny roll reads the host's TID/SID). */
function startSession(runSeed = "run-seed-A") {
  return startCoopSession({
    seat: "host",
    runSeed,
    build: BUILD,
    accountSnapshot: { host: ACCOUNT, guest: ACCOUNT },
  });
}

describe("Co-op: unseeded sites (DECISIONS D3)", () => {
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
    vi.useRealTimers();
    timedEventManager.disable(); // the timed-event test turns events on
  });

  describe("simRandInt", () => {
    it("is the unseeded draw in solo play", () => {
      const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
      expect(simRandInt("trainerGender", "x", 2)).toBe(1);
      expect(simRandInt("gruntDouble", "x", 3)).toBe(2);
      expect(random).toHaveBeenCalledTimes(2);
    });

    it("is deterministic in co-op, does not touch Math.random and leaves the shared stream alone", async () => {
      await game.classicMode.runToSummon(SpeciesId.BULBASAUR);
      const random = vi.spyOn(Math, "random");
      startSession();
      const before = Phaser.Math.RND.state();

      const first = Array.from({ length: 20 }, (_, i) => simRandInt("gruntDouble", `wave${i}`, 3));
      const again = Array.from({ length: 20 }, (_, i) => simRandInt("gruntDouble", `wave${i}`, 3));

      expect(again).toEqual(first);
      expect(new Set(first).size).toBeGreaterThan(1);
      expect(random).not.toHaveBeenCalled();
      expect(Phaser.Math.RND.state()).toBe(before);
    });

    it("depends on the run seed, the site and the discriminator, and nothing else", async () => {
      await game.classicMode.runToSummon(SpeciesId.BULBASAUR);
      const draw = (seed: string, site: "trainerGender" | "gruntDouble", discriminator: string) => {
        const session = startSession(seed);
        const values = Array.from({ length: 32 }, (_, i) => simRandInt(site, `${discriminator}${i}`, 1000));
        session.end();
        return values;
      };
      const base = draw("seed-1", "gruntDouble", "w");
      expect(draw("seed-1", "gruntDouble", "w")).toEqual(base);
      expect(draw("seed-2", "gruntDouble", "w")).not.toEqual(base);
      expect(draw("seed-1", "trainerGender", "w")).not.toEqual(base);
      expect(draw("seed-1", "gruntDouble", "v")).not.toEqual(base);
    });

    it("gives the same value whatever the shared stream did before", async () => {
      await game.classicMode.runToSummon(SpeciesId.BULBASAUR);
      startSession();
      const a = simRandInt("fusionStatus", "1:2", 1000);
      Phaser.Math.RND.sow(["something else entirely"]);
      Phaser.Math.RND.integerInRange(0, 100);
      expect(simRandInt("fusionStatus", "1:2", 1000)).toBe(a);
    });
  });

  describe("fusion status (pokemon.ts fuse -> getRandomStatus)", () => {
    const poison = new Status(StatusEffect.POISON);
    const burn = new Status(StatusEffect.BURN);

    it("is deterministic per pair of Pokémon in co-op", async () => {
      await game.classicMode.runToSummon(SpeciesId.BULBASAUR);
      const random = vi.spyOn(Math, "random");
      startSession();
      const picks = Array.from({ length: 40 }, (_, i) => getRandomStatus(poison, burn, `${i}:${i + 1}`)?.effect);
      const again = Array.from({ length: 40 }, (_, i) => getRandomStatus(poison, burn, `${i}:${i + 1}`)?.effect);
      expect(again).toEqual(picks);
      expect(new Set(picks)).toEqual(new Set([StatusEffect.POISON, StatusEffect.BURN]));
      expect(random).not.toHaveBeenCalled();
    });

    it("still returns the only status when one side has none", () => {
      startSession();
      expect(getRandomStatus(null, burn, "1:2")).toBe(burn);
      expect(getRandomStatus(poison, new Status(StatusEffect.NONE), "1:2")).toBe(poison);
    });
  });

  describe("eggs (D30) and what is off in co-op (D12)", () => {
    it("a new egg can be made in co-op (an encounter's, for this client's account) without moving the shared RNG", () => {
      startSession();
      const before = Phaser.Math.RND.state();
      const egg = new Egg({ sourceType: EggSourceType.EVENT, tier: 1 });
      expect(egg.tier).toBe(1);
      expect(Phaser.Math.RND.state()).toBe(before);
    });

    it("an existing egg is rebuilt from its data in co-op (system data load, resume) without touching the shared RNG", () => {
      const egg = new Egg({ sourceType: EggSourceType.GACHA_MOVE, tier: 0, species: SpeciesId.PIKACHU, hatchWaves: 7 });
      const data = new EggData(egg);
      startSession();
      const before = Phaser.Math.RND.state();

      const rebuilt = data.toEgg();

      expect(rebuilt).toMatchObject({ id: egg.id, species: egg.species, tier: egg.tier, hatchWaves: 7 });
      expect(Phaser.Math.RND.state()).toBe(before);
    });

    it("EggLapsePhase in co-op ages this client's eggs and always queues the summary: the same phases on both clients", async () => {
      await game.classicMode.runToSummon(SpeciesId.BULBASAUR);
      const egg = new Egg({ sourceType: EggSourceType.GACHA_MOVE, tier: 0, species: SpeciesId.PIKACHU, hatchWaves: 3 });
      game.scene.gameData.eggs = [egg];
      startSession();
      const unshift = vi.spyOn(game.scene.phaseManager, "unshiftNew").mockImplementation(() => undefined as never);

      const phase = new EggLapsePhase();
      const end = vi.spyOn(phase, "end").mockImplementation(() => undefined);
      phase.start();

      expect(egg.hatchWaves).toBe(2);
      // nothing hatched here, and still the summary (it ends at once with nothing to show); no question, no message
      expect(unshift.mock.calls.map(([name]) => name)).toEqual(["EggSummaryPhase"]);
      expect(unshift.mock.calls[0][1]).toEqual([]);
      expect(end).toHaveBeenCalledTimes(1);
    });

    it("EggLapsePhase in co-op hatches the eggs that are due without their animation, into the summary", async () => {
      await game.classicMode.runToSummon(SpeciesId.BULBASAUR);
      const eggs = [1, 1, 5].map(
        hatchWaves =>
          new Egg({ sourceType: EggSourceType.GACHA_MOVE, tier: 0, species: SpeciesId.PIKACHU, hatchWaves }),
      );
      game.scene.gameData.eggs = [...eggs];
      startSession();
      const unshift = vi.spyOn(game.scene.phaseManager, "unshiftNew").mockImplementation(() => undefined as never);
      const before = Phaser.Math.RND.state();

      const phase = new EggLapsePhase();
      vi.spyOn(phase, "end").mockImplementation(() => undefined);
      phase.start();

      expect(game.scene.gameData.eggs).toEqual([eggs[2]]);
      expect(unshift.mock.calls.map(([name]) => name)).toEqual(["EggSummaryPhase"]);
      expect(unshift.mock.calls[0][1]).toHaveLength(2);
      // the hatches are drawn apart from the run's stream
      expect(Phaser.Math.RND.state()).toBe(before);
    });

    it("a boss's voucher comes through the reward phase on both clients, whatever each account has unlocked (D30)", async () => {
      await game.classicMode.runToSummon(SpeciesId.BULBASAUR);
      startSession();
      const { gameData } = game.scene;
      const brock = vouchers[TrainerType[TrainerType.BROCK]];
      game.scene.currentBattle.trainer = new Trainer(TrainerType.BROCK, TrainerVariant.DEFAULT);
      const rewardsQueued = (): number => {
        const unshift = vi.spyOn(game.scene.phaseManager, "unshiftNew").mockImplementation(() => undefined as never);
        const phase = new TrainerVictoryPhase();
        vi.spyOn(phase, "end").mockImplementation(() => undefined);
        phase.start();
        const count = unshift.mock.calls.filter(([name]) => name === "ModifierRewardPhase").length;
        unshift.mockRestore();
        return count;
      };
      const counts = { ...gameData.voucherCounts };

      // the first win: unlocked now, and the voucher still comes through the phase (only once)
      delete gameData.voucherUnlocks[brock.id];
      const first = rewardsQueued();
      expect(Object.hasOwn(gameData.voucherUnlocks, brock.id)).toBe(true);
      expect(gameData.voucherCounts).toEqual(counts);
      // a later win: the same phases
      expect(rewardsQueued()).toBe(first);
      expect(first).toBe(game.scene.currentBattle.trainer.config.modifierRewardFuncs.length + 1);
    });

    it("EggLapsePhase ages eggs in solo play", async () => {
      await game.classicMode.runToSummon(SpeciesId.BULBASAUR);
      const egg = new Egg({ sourceType: EggSourceType.GACHA_MOVE, tier: 0, species: SpeciesId.PIKACHU, hatchWaves: 3 });
      game.scene.gameData.eggs = [egg];

      const phase = new EggLapsePhase();
      vi.spyOn(phase, "end").mockImplementation(() => undefined);
      phase.start();

      expect(egg.hatchWaves).toBe(2);
    });

    it("timed events are never active in co-op, whatever the clock says", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.UTC(2025, 10, 5))); // inside a listed event
      timedEventManager["disabled"] = false;
      expect(timedEventManager.isEventActive()).toBe(true);

      startSession();
      expect(timedEventManager.isEventActive()).toBe(false);
      expect(timedEventManager.activeEvent()).toBeUndefined();
      expect(timedEventManager.getShinyEncounterMultiplier()).toBe(1);
    });
  });

  describe("run seed", () => {
    it("is the host's seed after applyCoopRunSeed", async () => {
      await game.classicMode.runToSummon(SpeciesId.BULBASAUR);
      startSession("the-hosts-seed");
      applyCoopRunSeed();
      expect(globalScene.seed).toBe("the-hosts-seed");
      expect(globalScene.waveSeed).toBeTruthy();
    });

    it("is kept by reset() while a co-op session is active", async () => {
      startSession("kept-seed");
      game.scene.reset(false, false);
      expect(globalScene.seed).toBe("kept-seed");
    });
  });

  describe("pokemon.id", () => {
    it("is redrawn deterministically when it collides with a Pokémon already in a party", async () => {
      await game.classicMode.runToSummon(SpeciesId.BULBASAUR, SpeciesId.CHARMANDER);
      const taken = game.scene.getPlayerParty()[0].id;
      startSession();

      const integerInRange = vi.spyOn(Phaser.Math.RND, "integerInRange");
      integerInRange.mockReturnValueOnce(taken).mockReturnValueOnce(taken);
      const mon = game.scene.addPlayerPokemon(game.scene.getPlayerParty()[0].species, 5);

      expect(mon.id).not.toBe(taken);
      expect(integerInRange.mock.calls.length).toBeGreaterThanOrEqual(3);
      const ids = [...game.scene.getPlayerParty(), ...game.scene.getEnemyParty()].map(p => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
