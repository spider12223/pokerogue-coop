/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { speciesDataRegistry } from "#app/global-species-data-registry";
import type { PlayerCount } from "#coop/protocol";
import { endCoopSession, requireCoopSession, startCoopSession } from "#coop/session";
import { BattlerIndex } from "#enums/battler-index";
import { FieldPosition } from "#enums/field-position";
import { MoveId } from "#enums/move-id";
import { PlayerGender } from "#enums/player-gender";
import { SpeciesId } from "#enums/species-id";
import { Stat } from "#enums/stat";
import { GameManager } from "#test/framework/game-manager";
import {
  accountWith,
  advanceTo,
  type ClientConfig,
  Decider,
  describeWave,
  openCoopRun,
  playClient,
  queueTurnCommands,
  type Scenario,
  type SharedRun,
} from "#test/helpers/coop-harness";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/** The battle of a game of three (DECISIONS D40): 3 of ours against 2, enemies made tougher */

const BUILD = { protocolVersion: 1, gitSha: "x", dirtyHash: "clean", buildMode: "test", overridesHash: "0" };

const ACCOUNT = accountWith({});

const SHARED_THREE: SharedRun = {
  runSeed: "three-battle-wild",
  snapshot: { host: ACCOUNT, guest: ACCOUNT, guest2: ACCOUNT },
  hostPlayerGender: PlayerGender.MALE,
};

const HOST: ClientConfig = {
  seat: "host",
  liveAccount: ACCOUNT,
  localSettings: {},
  applyOverlay: true,
  bypassSnapshot: false,
  stallMs: 20_000,
};

const THREE: Scenario = {
  players: 3,
  species: [
    SpeciesId.BULBASAUR,
    SpeciesId.SQUIRTLE,
    SpeciesId.CHARMANDER,
    SpeciesId.PIKACHU,
    SpeciesId.MACHOP,
    SpeciesId.GEODUDE,
  ],
  waves: 1,
  moveset: [MoveId.BITE, MoveId.MEMENTO, MoveId.SAND_ATTACK, MoveId.TAIL_WHIP],
  faints: [],
  faintMove: MoveId.MEMENTO,
};

function openSession(players: PlayerCount): void {
  startCoopSession({
    seat: "host",
    runSeed: "three-battle",
    build: BUILD,
    players,
    accountSnapshot: { host: ACCOUNT, guest: ACCOUNT, ...(players === 3 ? { guest2: ACCOUNT } : {}) },
  });
}

describe("Co-op: the battle of a game of three (D40)", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
  });

  afterEach(() => {
    endCoopSession();
  });

  it("the session knows how many players the game has; 2 by default", () => {
    openSession(3);
    expect(requireCoopSession().players).toBe(3);
    endCoopSession();
    startCoopSession({ seat: "host", runSeed: "three-battle", build: BUILD });
    expect(requireCoopSession().players).toBe(2);
  });

  it("enemies get HP x1.5 and Attack and Sp. Atk x1.15 in a game of three, not in a game of two", async () => {
    game.override.battleStyle("single").enemySpecies(SpeciesId.SNORLAX).enemyLevel(50);
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    const enemy = game.field.getEnemyPokemon();
    openSession(2);
    enemy.calculateStats();
    const two = [...enemy.stats];
    const hpOfTwo = enemy.hp;
    endCoopSession();

    openSession(3);
    enemy.hp = undefined as unknown as number;
    enemy.calculateStats();
    const three = enemy.stats;
    expect(three[Stat.HP]).toBe(Math.floor(two[Stat.HP] * 1.5));
    expect(three[Stat.ATK]).toBe(Math.floor(two[Stat.ATK] * 1.15));
    expect(three[Stat.SPATK]).toBe(Math.floor(two[Stat.SPATK] * 1.15));
    expect([three[Stat.DEF], three[Stat.SPDEF], three[Stat.SPD]]).toEqual([
      two[Stat.DEF],
      two[Stat.SPDEF],
      two[Stat.SPD],
    ]);
    expect(enemy.hp).toBe(three[Stat.HP]);
    expect(hpOfTwo).toBe(two[Stat.HP]);
  });

  it("a wild wave: three of ours (left, centre, right) against two, each commanded by its owner", async () => {
    const run = await openCoopRun(phaserGame, SHARED_THREE, HOST, Decider.recording(), THREE);
    const { ctx } = run;
    try {
      await advanceTo(ctx, ["CommandPhase"]);
      const field = game.scene.getPlayerField();
      expect(field.map(p => p.getBattlerIndex())).toEqual([
        BattlerIndex.PLAYER,
        BattlerIndex.PLAYER_2,
        BattlerIndex.PLAYER_3,
      ]);
      expect(field.map(p => p.fieldPosition)).toEqual([FieldPosition.LEFT, FieldPosition.CENTER, FieldPosition.RIGHT]);
      expect(game.scene.getField()[BattlerIndex.PLAYER_3]).toBe(field[2]);
      const wave = describeWave(ctx);
      expect(wave.controllers).toEqual(["host", "guest", "guest2"]);
      expect(wave.enemyField).toBe(2);
      const enemyHp = game.scene.getEnemyField().map(p => p.hp);

      queueTurnCommands(ctx);
      await advanceTo(ctx, ["TurnInitPhase", "SelectModifierPhase"]);
      // all three acted: each hit an enemy (or the wave is already won)
      const enemiesAfter = game.scene.getEnemyField().map(p => p.hp);
      expect(enemiesAfter.some((hp, i) => hp < enemyHp[i]) || game.scene.getEnemyField().length === 0).toBe(true);
    } finally {
      run.close();
    }
  });

  it(
    "five waves of three: each of the three replays the host's log to the same hashes",
    async () => {
      const scenario: Scenario = {
        ...THREE,
        waves: 5,
        // the second guest's lead faints on purpose: its own second Pokémon takes the slot
        faints: [{ wave: 2, turn: 1, slots: [2] }],
      };
      const recorded = await playClient(phaserGame, SHARED_THREE, HOST, Decider.recording(), scenario);
      expect(recorded.stalledIn).toBeNull();
      expect(recorded.waves.map(w => w.wave)).toEqual([1, 2, 3, 4, 5]);
      expect(recorded.waves.every(w => w.controllers.length === 3)).toBe(true);
      expect(recorded.waves[0].controllers).toEqual(["host", "guest", "guest2"]);
      // every seat commanded its own Pokémon
      const commanders = new Set(recorded.decisions.filter(d => d.key.kind === "TURN_COMMANDS").map(d => d.by));
      expect(commanders).toEqual(new Set(["host", "guest", "guest2"]));
      expect(recorded.decisions.filter(d => d.key.kind === "FAINT_SWITCH").map(d => d.by)).toEqual(["guest2"]);

      for (const seat of ["guest", "guest2"] as const) {
        const replayed = await playClient(
          phaserGame,
          SHARED_THREE,
          { ...HOST, seat },
          Decider.replaying(recorded.decisions),
          scenario,
          recorded.checkpoints,
        );
        expect(replayed.stalledIn, seat).toBeNull();
        expect(replayed.divergence, seat).toBeNull();
        expect(
          replayed.checkpoints.map(c => c.hash),
          seat,
        ).toEqual(recorded.checkpoints.map(c => c.hash));
        expect(replayed.partyIds, seat).toEqual(recorded.partyIds);
      }
    },
    5 * 60_000,
  );

  it(
    "a run of three continued with two: 2 of ours against 2, no buff, the absent player's two on the others' benches (D40)",
    async () => {
      const scenario: Scenario = {
        ...THREE,
        players: 2,
        waves: 3,
        // the host's lead faints in the first turn: its replacement may be the absent player's, commanded by the host
        faints: [{ wave: 1, turn: 1, slots: [0] }],
        starterOwners: ["host", "host", "guest", "guest", "guest2", "guest2"],
      };
      const recorded = await playClient(phaserGame, SHARED_THREE, HOST, Decider.recording(), scenario);
      expect(recorded.stalledIn).toBeNull();
      expect(recorded.waves.every(w => w.controllers.length === 2)).toBe(true);
      expect(recorded.waves[0].controllers).toEqual(["host", "guest"]);
      // nobody decides as the absent player
      expect(recorded.decisions.some(d => d.by === "guest2")).toBe(false);
      const replayed = await playClient(
        phaserGame,
        SHARED_THREE,
        { ...HOST, seat: "guest" },
        Decider.replaying(recorded.decisions),
        scenario,
        recorded.checkpoints,
      );
      expect(replayed.divergence).toBeNull();
      expect(replayed.checkpoints.map(c => c.hash)).toEqual(recorded.checkpoints.map(c => c.hash));
    },
    5 * 60_000,
  );

  it("a player's Pokémon is not made tougher in a game of three", () => {
    openSession(2);
    const ours = game.scene.addPlayerPokemon(speciesDataRegistry.getSpecies(SpeciesId.SNORLAX), 50);
    ours.calculateStats();
    const two = [...ours.stats];
    endCoopSession();
    openSession(3);
    ours.calculateStats();
    expect(ours.stats).toEqual(two);
  });
});
