/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { otherSeat, type Seat } from "#coop/protocol";

/**
 * Who owns which Pokémon (DECISIONS D7): `pokemon.id -> seat`. Ownership changes only through a trade or a catch.
 * Control of a field slot follows the owner of the Pokémon that is in it, never the slot itself.
 *
 * No game imports: the map is plain data that goes into the save block and the state hash.
 *
 * @module
 */

/** How many starters each seat brings (D7). */
export const STARTERS_PER_SEAT = 3;

/**
 * The party order of a run that starts with each seat's starters (D7): the seats alternate, the host first, until both
 * lists are used up. Both clients build the same party from the same two lists.
 * @returns The starters in party order, and who owns each
 */
export function interleaveStarters<T>(host: readonly T[], guest: readonly T[]): { starters: T[]; owners: Seat[] } {
  const starters: T[] = [];
  const owners: Seat[] = [];
  for (let i = 0; i < Math.max(host.length, guest.length); i++) {
    if (i < host.length) {
      starters.push(host[i]);
      owners.push("host");
    }
    if (i < guest.length) {
      starters.push(guest[i]);
      owners.push("guest");
    }
  }
  return { starters, owners };
}

/**
 * The seats of the starters of a run, in party order: the host's starters, then the guest's.
 * Tests script ownership with this; the lobby will send the real picks.
 */
export function defaultStarterOwners(perSeat = STARTERS_PER_SEAT): Seat[] {
  return [...new Array(perSeat).fill("host"), ...new Array(perSeat).fill("guest")];
}

export class OwnerMap {
  private readonly owners = new Map<number, Seat>();

  /** @returns The owner, or `undefined` if the Pokémon has none (an enemy, or one that was never assigned) */
  public get(pokemonId: number): Seat | undefined {
    return this.owners.get(pokemonId);
  }

  public has(pokemonId: number): boolean {
    return this.owners.has(pokemonId);
  }

  /**
   * @returns The owner
   * @throws If the Pokémon has none: a player Pokémon without an owner would let two clients decide differently
   */
  public require(pokemonId: number): Seat {
    const owner = this.owners.get(pokemonId);
    if (owner === undefined) {
      throw new Error(`Pokémon ${pokemonId} has no owner`);
    }
    return owner;
  }

  /** Give a Pokémon an owner, or hand it to the other seat (a trade, a catch). */
  public set(pokemonId: number, seat: Seat): void {
    this.owners.set(pokemonId, seat);
  }

  public delete(pokemonId: number): void {
    this.owners.delete(pokemonId);
  }

  public get size(): number {
    return this.owners.size;
  }

  /** How many of these Pokémon a seat owns */
  public countOwned(pokemonIds: Iterable<number>, seat: Seat): number {
    let count = 0;
    for (const id of pokemonIds) {
      if (this.owners.get(id) === seat) {
        count++;
      }
    }
    return count;
  }

  /** How many Pokémon each seat owns (D11: a gift must make these more equal) */
  public countBySeat(): Record<Seat, number> {
    const counts: Record<Seat, number> = { host: 0, guest: 0 };
    for (const seat of this.owners.values()) {
      counts[seat]++;
    }
    return counts;
  }

  /** @returns The other seat's id for a Pokémon this seat owns; `undefined` if it has no owner */
  public partnerOf(pokemonId: number): Seat | undefined {
    const owner = this.owners.get(pokemonId);
    return owner === undefined ? undefined : otherSeat(owner);
  }

  /** Keep only the Pokémon that are still in the party (released, fused or traded-away ones are dropped). */
  public retain(pokemonIds: Iterable<number>): void {
    const keep = new Set(pokemonIds);
    for (const id of [...this.owners.keys()]) {
      if (!keep.has(id)) {
        this.owners.delete(id);
      }
    }
  }

  /** Replace the contents (a save is loaded). */
  public load(owners: Readonly<Record<string, Seat>>): void {
    this.owners.clear();
    for (const [id, seat] of Object.entries(owners)) {
      this.owners.set(Number(id), seat);
    }
  }

  /** @returns Plain data with the ids in ascending order, so equal maps serialize identically */
  public toJSON(): Record<string, Seat> {
    const out: Record<string, Seat> = {};
    for (const id of [...this.owners.keys()].sort((a, b) => a - b)) {
      out[String(id)] = this.owners.get(id)!;
    }
    return out;
  }
}

export function isOwnerRecord(value: unknown): value is Record<string, Seat> {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.entries(value).every(
      ([id, seat]) => Number.isInteger(Number(id)) && Number(id) >= 0 && (seat === "host" || seat === "guest"),
    )
  );
}
