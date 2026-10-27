/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import type { AccountSnapshot } from "#coop/account-snapshot";
import type { Seat } from "#coop/protocol";
import { getCoopSession } from "#coop/session";
import type { SpeciesId } from "#enums/species-id";
import { Unlockables } from "#enums/unlockables";
import type { GameData } from "#system/game-data";

/**
 * Every account value the simulation reads (DECISIONS D4). Simulation code asks `simAccount()` instead of
 * `globalScene.gameData`: in solo play the answer is the live data (the same expressions as before, so solo play is
 * unchanged); in co-op it comes from the snapshot frozen at run start.
 *
 * Which account a read uses follows D4: world-level values come from the host's account, Pokémon-level values from
 * the account of the Pokémon's owner (`ownerSeat`).
 */
export interface SimAccountData {
  /** Host. The shiny roll's `E = trainerId ^ secretId` (`Pokemon.trySetShiny`) */
  getTrainerAndSecretId(): readonly [trainerId: number, secretId: number];
  /** Host. Eviolite / Mini Black Hole in the reward pools; no other unlockable is read by the simulation */
  isUnlocked(unlockable: Unlockables.EVIOLITE | Unlockables.MINI_BLACK_HOLE): boolean;
  /** Host. The dex count of the critical capture chance (`getCriticalCaptureChance`) */
  getSpeciesCaughtCount(): number;
  /** Host. How many starters are caught (`checkCanUseBall`) */
  getStarterCaughtCount(): number;
  /**
   * `dexData[species].caughtAttr`
   * @param owner - Which account: the owner of the Pokémon for evolution/form conditions and starter luck, the host
   * for `checkCanUseBall`
   */
  getCaughtAttr(species: SpeciesId, owner: Seat): bigint;
  /** Owner. `starterData[rootSpecies].eggMoves`, a bitmask of the unlocked egg moves */
  getEggMoves(rootSpecies: SpeciesId, owner: Seat): number;
}

/** Solo play: the live `gameData`, read exactly as the simulation did before co-op existed. */
class LiveAccountData implements SimAccountData {
  private get gameData(): GameData {
    return globalScene.gameData;
  }

  public getTrainerAndSecretId(): readonly [number, number] {
    return [this.gameData.trainerId, this.gameData.secretId];
  }

  public isUnlocked(unlockable: Unlockables.EVIOLITE | Unlockables.MINI_BLACK_HOLE): boolean {
    return this.gameData.isUnlocked(unlockable);
  }

  public getSpeciesCaughtCount(): number {
    return this.gameData.getSpeciesCount(d => !!d.caughtAttr);
  }

  public getStarterCaughtCount(): number {
    return this.gameData.getStarterCount(d => !!d.caughtAttr);
  }

  public getCaughtAttr(species: SpeciesId, _owner: Seat): bigint {
    return this.gameData.dexData[species].caughtAttr;
  }

  public getEggMoves(rootSpecies: SpeciesId, _owner: Seat): number {
    return this.gameData.starterData[rootSpecies].eggMoves;
  }
}

/** Co-op: the snapshot of run start; never the live data. */
class SnapshotAccountData implements SimAccountData {
  constructor(private readonly accounts: Record<Seat, AccountSnapshot>) {}

  public getTrainerAndSecretId(): readonly [number, number] {
    const { trainerId, secretId } = this.accounts.host;
    return [trainerId, secretId];
  }

  public isUnlocked(unlockable: Unlockables.EVIOLITE | Unlockables.MINI_BLACK_HOLE): boolean {
    const { unlocked } = this.accounts.host;
    switch (unlockable) {
      case Unlockables.EVIOLITE:
        return unlocked.eviolite;
      case Unlockables.MINI_BLACK_HOLE:
        return unlocked.miniBlackHole;
      default:
        throw new Error(`Unlockable ${unlockable} is not part of the account snapshot`);
    }
  }

  public getSpeciesCaughtCount(): number {
    return Object.keys(this.accounts.host.caught).length;
  }

  public getStarterCaughtCount(): number {
    const { caught } = this.accounts.host;
    return speciesDataRegistry.getAllStarters().filter(starter => starter in caught).length;
  }

  public getCaughtAttr(species: SpeciesId, owner: Seat): bigint {
    return BigInt(this.accounts[owner].caught[species] ?? "0");
  }

  public getEggMoves(rootSpecies: SpeciesId, owner: Seat): number {
    return this.accounts[owner].eggMoves[rootSpecies] ?? 0;
  }
}

const liveAccountData = new LiveAccountData();

/** @returns The account data the simulation reads: the live data in solo play, the run-start snapshot in co-op */
export function simAccount(): SimAccountData {
  const session = getCoopSession();
  return session === null ? liveAccountData : new SnapshotAccountData(session.accountSnapshot);
}

/**
 * @returns The solo-play implementation, which reads the live `gameData`. Tests only: it is what co-op would do if the
 * snapshot were bypassed, which the replay tests use to show that this is caught.
 */
export function liveSimAccount(): SimAccountData {
  return liveAccountData;
}

/**
 * Whether this client writes account data (dex, candy, achievements) for something owned by `seat` (DECISIONS D4a): each
 * client writes only for its own Pokémon, and the Pokémon of the partner are only "seen". Always true in solo play.
 */
export function writesForSeat(seat: Seat): boolean {
  const session = getCoopSession();
  return session === null || session.seat === seat;
}

/** @returns Whether this client writes account data for this Pokémon (see {@linkcode writesForSeat}) */
export function writesForPokemon(pokemon: { readonly id: number }): boolean {
  return getCoopSession() === null || writesForSeat(ownerSeat(pokemon));
}

/**
 * @returns The player whose account a Pokémon-level read uses (D4): the owner of the Pokémon in the co-op session's owner
 * map. Solo play has no owner: the answer is unused there. A Pokémon that is not in the map yet (an enemy, a preview)
 * reads as the host's, the world-level account.
 */
export function ownerSeat(pokemon: { readonly id: number }): Seat {
  return getCoopSession()?.ownerOf(pokemon.id) ?? "host";
}

/**
 * Freeze the live account data into a snapshot (run start, D4).
 * @param gameData - The account's data; the global `gameData` by default
 */
export function captureAccountSnapshot(gameData: GameData = globalScene.gameData): AccountSnapshot {
  const caught: Record<number, string> = {};
  for (const [species, entry] of Object.entries(gameData.dexData)) {
    if (entry.caughtAttr) {
      caught[Number(species)] = entry.caughtAttr.toString();
    }
  }
  const eggMoves: Record<number, number> = {};
  for (const [species, entry] of Object.entries(gameData.starterData)) {
    if (entry.eggMoves) {
      eggMoves[Number(species)] = entry.eggMoves;
    }
  }
  return {
    trainerId: gameData.trainerId,
    secretId: gameData.secretId,
    unlocked: {
      eviolite: gameData.isUnlocked(Unlockables.EVIOLITE),
      miniBlackHole: gameData.isUnlocked(Unlockables.MINI_BLACK_HOLE),
    },
    caught,
    eggMoves,
  };
}
