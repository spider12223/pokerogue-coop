/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { speciesDataRegistry } from "#app/global-species-data-registry";
import { type AccountSnapshot, type CoopAccountSnapshot, isAccountSnapshot } from "#coop/account-snapshot";
import { endCoopSession, startCoopSession } from "#coop/session";
import { captureAccountSnapshot, ownerSeat, simAccount } from "#coop/sim-account";
import { getCriticalCaptureChance } from "#data/pokeball";
import { getSpeciesDependentFormChangeCondition } from "#data/pokemon-forms";
import { DexAttr } from "#enums/dex-attr";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { Unlockables } from "#enums/unlockables";
import { modifierPool } from "#modifiers/modifier-pools";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const BUILD = { protocolVersion: 1, gitSha: "x", dirtyHash: "clean", buildMode: "test", overridesHash: "0" } as const;

function account(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    trainerId: 1,
    secretId: 2,
    unlocked: { eviolite: false, miniBlackHole: false },
    caught: {},
    eggMoves: {},
    ...overrides,
  };
}

function startSession(snapshot: CoopAccountSnapshot) {
  return startCoopSession({ seat: "host", runSeed: "seed", build: BUILD, accountSnapshot: snapshot });
}

/** Every value the simulation reads from the account, as `simAccount()` answers it. */
function readEverything(species: SpeciesId[]) {
  const a = simAccount();
  return {
    ids: a.getTrainerAndSecretId(),
    eviolite: a.isUnlocked(Unlockables.EVIOLITE),
    miniBlackHole: a.isUnlocked(Unlockables.MINI_BLACK_HOLE),
    dexCount: a.getSpeciesCaughtCount(),
    starterCount: a.getStarterCaughtCount(),
    caught: species.map(s => a.getCaughtAttr(s, "host")),
    eggMoves: species.map(s => a.getEggMoves(s, "host")),
  };
}

describe("Co-op: account snapshot (DECISIONS D4)", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override.moveset([MoveId.SPLASH]).enemyMoveset(MoveId.SPLASH);
  });

  afterEach(() => {
    endCoopSession();
  });

  describe("captureAccountSnapshot", () => {
    it("is valid JSON-able snapshot data, and answers exactly like the live data does", () => {
      const { gameData } = game.scene;
      gameData.trainerId = 4321;
      gameData.secretId = 8765;
      gameData.unlocks[Unlockables.EVIOLITE] = true;
      gameData.unlocks[Unlockables.MINI_BLACK_HOLE] = false;
      gameData.dexData[SpeciesId.BULBASAUR].caughtAttr = DexAttr.NON_SHINY | DexAttr.SHINY | DexAttr.MALE;
      gameData.dexData[SpeciesId.PIKACHU].caughtAttr = DexAttr.NON_SHINY;
      gameData.dexData[SpeciesId.MEW].caughtAttr = DexAttr.NON_SHINY;
      gameData.starterData[SpeciesId.BULBASAUR].eggMoves = 0b1011;

      const species = [SpeciesId.BULBASAUR, SpeciesId.PIKACHU, SpeciesId.MEW, SpeciesId.CHARMANDER];
      const live = readEverything(species);

      const snapshot = captureAccountSnapshot();
      expect(isAccountSnapshot(JSON.parse(JSON.stringify(snapshot)))).toBe(true);
      startSession({ host: snapshot, guest: snapshot });
      expect(readEverything(species)).toEqual(live);

      expect(live.ids).toEqual([4321, 8765]);
      expect(live.eviolite).toBe(true);
      expect(live.dexCount).toBeGreaterThanOrEqual(3); // a new account already owns the default starters
      expect(live.eggMoves).toEqual([0b1011, 0, 0, 0]);
    });
  });

  describe("in co-op the simulation never reads the live account", () => {
    it("answers from the snapshot, whatever the live data says", () => {
      const { gameData } = game.scene;
      startSession({
        host: account({
          trainerId: 111,
          secretId: 222,
          unlocked: { eviolite: true, miniBlackHole: true },
          caught: { [SpeciesId.BULBASAUR]: DexAttr.NON_SHINY.toString() },
          eggMoves: { [SpeciesId.BULBASAUR]: 3 },
        }),
        guest: account(),
      });

      // a very different live account
      gameData.trainerId = 9;
      gameData.secretId = 8;
      gameData.unlocks[Unlockables.EVIOLITE] = false;
      gameData.unlocks[Unlockables.MINI_BLACK_HOLE] = false;
      gameData.dexData[SpeciesId.PIKACHU].caughtAttr = DexAttr.NON_SHINY;
      gameData.starterData[SpeciesId.BULBASAUR].eggMoves = 15;

      expect(readEverything([SpeciesId.BULBASAUR, SpeciesId.PIKACHU])).toEqual({
        ids: [111, 222],
        eviolite: true,
        miniBlackHole: true,
        dexCount: 1,
        starterCount: 1,
        caught: [DexAttr.NON_SHINY, 0n],
        eggMoves: [3, 0],
      });
    });

    it("has no snapshot, no answer: it does not fall back to the live data", () => {
      startCoopSession({ seat: "host", runSeed: "seed", build: BUILD });
      expect(() => simAccount()).toThrow("no account snapshot");
    });

    it("the shiny roll uses the host's TID/SID, not the live ones", async () => {
      await game.classicMode.runToSummon(SpeciesId.BULBASAUR);
      const pokemon = game.field.getPlayerPokemon();
      const rand1 = (pokemon.id & 0xffff0000) >>> 16;
      const rand2 = pokemon.id & 0x0000ffff;
      const F = rand1 ^ rand2;

      // Host: E == F, so E ^ F == 0 < the threshold: shiny. Live account: the opposite.
      startSession({ host: account({ trainerId: F, secretId: 0 }), guest: account({ trainerId: F ^ 0xffff }) });
      game.scene.gameData.trainerId = F ^ 0xffff;
      game.scene.gameData.secretId = 0;
      expect(pokemon.trySetShiny(100)).toBe(true);

      endCoopSession();
      startSession({ host: account({ trainerId: F ^ 0xffff, secretId: 0 }), guest: account({ trainerId: F }) });
      game.scene.gameData.trainerId = F;
      expect(pokemon.trySetShiny(100)).toBe(false);
    });
  });

  describe("host snapshot (world-level) vs owner snapshot (Pokémon-level)", () => {
    const host = account({
      caught: { [SpeciesId.RESHIRAM]: DexAttr.NON_SHINY.toString() },
      eggMoves: { [SpeciesId.BULBASAUR]: 0b0001 },
    });
    const guest = account({
      caught: { [SpeciesId.ZEKROM]: DexAttr.NON_SHINY.toString() },
      eggMoves: { [SpeciesId.BULBASAUR]: 0b1000 },
    });

    it("dex conditions follow the owner of the Pokémon", async () => {
      await game.classicMode.runToSummon(SpeciesId.KYUREM);
      const pokemon = game.field.getPlayerPokemon();
      const session = startSession({ host, guest });
      const needsReshiram = getSpeciesDependentFormChangeCondition(SpeciesId.RESHIRAM).predicate;
      const needsZekrom = getSpeciesDependentFormChangeCondition(SpeciesId.ZEKROM).predicate;

      // a Pokémon nobody owns is read as the host's
      expect(ownerSeat(pokemon)).toBe("host");
      expect(needsReshiram(pokemon)).toBe(true);
      expect(needsZekrom(pokemon)).toBe(false);

      session.ownership.set(pokemon.id, "guest");
      expect(ownerSeat(pokemon)).toBe("guest");
      expect(needsReshiram(pokemon)).toBe(false);
      expect(needsZekrom(pokemon)).toBe(true);
    });

    it("egg moves follow the owner of the Pokémon", async () => {
      await game.classicMode.runToSummon(SpeciesId.BULBASAUR);
      const pokemon = game.field.getPlayerPokemon();
      const session = startSession({ host, guest });
      const unlockedEggMoves = () => (pokemon as unknown as { getUnlockedEggMoves(): MoveId[] }).getUnlockedEggMoves();

      const asHost = unlockedEggMoves();
      session.ownership.set(pokemon.id, "guest");
      const asGuest = unlockedEggMoves();

      expect(asHost).toHaveLength(1);
      expect(asGuest).toHaveLength(1);
      expect(asHost).not.toEqual(asGuest);
    });

    it("the critical capture chance counts the host's dex", () => {
      const bigDex = Object.fromEntries(
        speciesDataRegistry.getAllStarters().map(s => [s, DexAttr.NON_SHINY.toString()]),
      );
      const rate = 30;

      startSession({ host: account({ caught: bigDex }), guest: account() });
      const withBigDex = getCriticalCaptureChance(rate);
      endCoopSession();

      startSession({ host: account(), guest: account({ caught: bigDex }) });
      expect(getCriticalCaptureChance(rate)).toBeLessThan(withBigDex);
    });

    it("the Eviolite and Mini Black Hole entries of the reward pool follow the host's unlocks", async () => {
      await game.classicMode.runToSummon(SpeciesId.PIKACHU);
      const party = game.scene.getPlayerParty();
      const weightOf = (id: string): number => {
        const entry = Object.values(modifierPool)
          .flat()
          .find(m => m.modifierType.id === id)!;
        return typeof entry.weight === "function" ? entry.weight(party, 0) : entry.weight;
      };
      game.scene.gameData.unlocks[Unlockables.EVIOLITE] = false;
      game.scene.gameData.unlocks[Unlockables.MINI_BLACK_HOLE] = false;

      startSession({ host: account({ unlocked: { eviolite: true, miniBlackHole: true } }), guest: account() });
      expect(weightOf("EVIOLITE")).toBeGreaterThan(0);
      expect(weightOf("MINI_BLACK_HOLE")).toBeGreaterThan(0);
      endCoopSession();

      game.scene.gameData.unlocks[Unlockables.EVIOLITE] = true;
      game.scene.gameData.unlocks[Unlockables.MINI_BLACK_HOLE] = true;
      startSession({ host: account(), guest: account({ unlocked: { eviolite: true, miniBlackHole: true } }) });
      expect(weightOf("EVIOLITE")).toBe(0);
      expect(weightOf("MINI_BLACK_HOLE")).toBe(0);
    });
  });
});
