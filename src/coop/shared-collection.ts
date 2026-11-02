/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  COLLECTION_LIMITS,
  type CollectionData,
  type CollectionDexEntry,
  type CollectionStarterEntry,
} from "#coop/collection-data";
import { type LobbyMessage, otherSeat, type PlayerCount, peers, type Seat } from "#coop/protocol";
import { Passive } from "#enums/passive";
import type { DexData, DexEntry } from "#types/dex-data";
import type { StarterData, StarterDataEntry } from "#types/save-data";

/**
 * The co-op starter select shows the Pokémon of both players (DECISIONS D32). On entering the lobby each player sends
 * their collection; while the lobby is open, the account's `dexData` and `starterData` are replaced by a merge of both,
 * so the whole screen (grid, forms, shinies, IVs, natures, abilities, passives, egg moves, costs) works on it unchanged.
 *
 * Nothing of the partner's reaches this player's save:
 * - the save writes the account's own data while the merge is in place ({@linkcode ownAccountData})
 * - in a merged entry, what the screen changes (candies spent, a passive or cost reduction bought, the custom moveset)
 *   is written through to the account's own entry; a passive only the partner unlocked can be turned on and off, which
 *   is kept in the merge only
 * - the merge comes off when the lobby closes: the run starts, or the players leave
 *
 * The run itself plays with the merge: the account snapshot of `ready` is taken from it (D4), so the egg moves and dex
 * the simulation reads are those the player picked from.
 *
 * @module
 */

/** The bits of a dex attribute the partner's collection may set */
const ATTR_MASK = (1n << BigInt(COLLECTION_LIMITS.attrBits)) - 1n;

/** What of an account the merge replaces: `GameData` has both */
export interface CollectionHolder {
  dexData: DexData;
  starterData: StarterData;
}

/** @returns The collection of an account, as it goes to the partner */
export function captureCollection(account: CollectionHolder): CollectionData {
  const dex: Record<number, CollectionDexEntry> = {};
  for (const [species, entry] of Object.entries(account.dexData)) {
    if (entry.caughtAttr) {
      dex[Number(species)] = {
        caught: entry.caughtAttr.toString(),
        seen: entry.seenAttr.toString(),
        natures: entry.natureAttr,
        ivs: [...entry.ivs],
      };
    }
  }
  const starters: Record<number, CollectionStarterEntry> = {};
  for (const [species, entry] of Object.entries(account.starterData)) {
    const shared: CollectionStarterEntry = {
      abilities: entry.abilityAttr,
      passive: entry.passiveAttr,
      reduction: entry.valueReduction,
      eggMoves: entry.eggMoves,
      wins: entry.classicWinCount,
    };
    if (Object.values(shared).some(value => value > 0)) {
      starters[Number(species)] = shared;
    }
  }
  return { dex, starters };
}

/**
 * A dex entry of both players: every form, shiny, gender and nature either caught, and the better IV of each stat. The
 * counts and ribbons are the player's own.
 * @returns The player's own entry when the partner adds nothing to it
 */
export function mergeDexEntry(own: DexEntry, partner: CollectionDexEntry | undefined): DexEntry {
  if (partner === undefined) {
    return own;
  }
  // The partner's values are clamped to the game's ranges, whatever came over the wire (`COLLECTION_LIMITS`)
  const caughtAttr = own.caughtAttr | (BigInt(partner.caught) & ATTR_MASK);
  const seenAttr = own.seenAttr | (BigInt(partner.seen) & ATTR_MASK) | caughtAttr;
  const natureAttr = own.natureAttr | (partner.natures & COLLECTION_LIMITS.natures);
  const ivs = own.ivs.map((iv, stat) => Math.max(iv, Math.min(31, partner.ivs[stat] ?? 0)));
  if (
    caughtAttr === own.caughtAttr
    && seenAttr === own.seenAttr
    && natureAttr === own.natureAttr
    && ivs.every((iv, stat) => iv === own.ivs[stat])
  ) {
    return own;
  }
  return { ...own, caughtAttr, seenAttr, natureAttr, ivs };
}

function accessor<T>(get: () => T, set: (value: T) => void): PropertyDescriptor {
  return { get, set, enumerable: true, configurable: true };
}

/** A partner's starter entry with nothing unlocked */
const NOTHING_UNLOCKED: CollectionStarterEntry = { abilities: 0, passive: 0, reduction: 0, eggMoves: 0, wins: 0 };

/**
 * @returns Whether the player's own dex has the species: only then may their save hold starter data for it (upstream's
 * check of a system save, `GameData.validateSystemData`, refuses the save otherwise and resets the game)
 */
function ownCaught(dex: DexEntry | undefined): boolean {
  return dex === undefined || dex.caughtCount > 0 || dex.hatchedCount > 0 || dex.caughtAttr !== 0n;
}

/**
 * A starter entry of both players: the abilities, egg moves and passive either unlocked, the bigger cost reduction and win
 * count. Candies, friendship, the egg pity and the custom moveset are the player's own, and so is what the screen buys.
 * On a Pokémon only the partner caught, the custom moveset, a cost reduction and a passive the screen changes are kept for
 * the screen and never reach the player's own entry: their save may not have starter data for a species their dex lacks.
 * @param caught - Whether the player's own dex has the species
 * @returns The player's own entry when the partner adds nothing to it
 */
export function mergeStarterEntry(
  own: StarterDataEntry,
  partner: CollectionStarterEntry | undefined,
  caught = true,
): StarterDataEntry {
  if (partner === undefined) {
    if (caught) {
      return own;
    }
    partner = NOTHING_UNLOCKED;
  }
  // The partner's values are clamped to the game's ranges, whatever came over the wire (`COLLECTION_LIMITS`)
  const partnerReduction = Math.max(0, Math.min(COLLECTION_LIMITS.reduction, partner.reduction));
  const abilityAttr = own.abilityAttr | (partner.abilities & COLLECTION_LIMITS.abilities);
  const eggMoves = own.eggMoves | (partner.eggMoves & COLLECTION_LIMITS.eggMoves);
  const classicWinCount = Math.max(own.classicWinCount, Math.min(COLLECTION_LIMITS.wins, partner.wins));
  const partnerPassive = (partner.passive & Passive.UNLOCKED) !== 0;
  if (
    caught
    && abilityAttr === own.abilityAttr
    && eggMoves === own.eggMoves
    && classicWinCount === own.classicWinCount
    && partnerReduction <= own.valueReduction
    && (!partnerPassive || (own.passiveAttr & Passive.UNLOCKED) !== 0)
  ) {
    return own;
  }
  /** Whether a passive only the partner unlocked is on: the partner's choice until this player changes it */
  let partnerPassiveEnabled = partner.passive & Passive.ENABLED;
  const ownsPassive = (): boolean => caught && ((own.passiveAttr & Passive.UNLOCKED) !== 0 || !partnerPassive);
  // What the screen changes on a Pokémon the player has not caught: shown, not saved
  let screenMoveset = own.moveset;
  let screenReduction = own.valueReduction;
  let screenPassive = own.passiveAttr;
  const merged = { abilityAttr, eggMoves, classicWinCount } as StarterDataEntry;
  Object.defineProperties(merged, {
    candyCount: accessor(
      () => own.candyCount,
      value => {
        own.candyCount = value;
      },
    ),
    friendship: accessor(
      () => own.friendship,
      value => {
        own.friendship = value;
      },
    ),
    pity: accessor(
      () => own.pity,
      value => {
        own.pity = value;
      },
    ),
    moveset: accessor(
      () => (caught ? own.moveset : screenMoveset),
      value => {
        if (caught) {
          own.moveset = value;
        } else {
          screenMoveset = value;
        }
      },
    ),
    // A reduction bought here (the next one after the bigger of the two) is this player's
    valueReduction: accessor(
      () => Math.max(caught ? own.valueReduction : screenReduction, partnerReduction),
      value => {
        if (caught) {
          own.valueReduction = value;
        } else {
          screenReduction = value;
        }
      },
    ),
    passiveAttr: accessor(
      () => {
        if (ownsPassive()) {
          return own.passiveAttr;
        }
        return partnerPassive ? Passive.UNLOCKED | partnerPassiveEnabled : screenPassive;
      },
      value => {
        if (ownsPassive()) {
          own.passiveAttr = value;
        } else if (partnerPassive) {
          partnerPassiveEnabled = value & Passive.ENABLED;
        } else {
          screenPassive = value;
        }
      },
    ),
  });
  return merged;
}

/** The account the merge is on, and the data it replaced */
let pooled: { account: CollectionHolder; own: CollectionHolder } | null = null;

/**
 * Put the merge of this account and the partners' collections in place of the account's dex and starter data: one partner
 * in a game of two, two in a game of three (D40). Each partner is merged into the merge before, so what the screen writes
 * still reaches the player's own entry.
 */
export function poolCollection(account: CollectionHolder, partners: CollectionData | readonly CollectionData[]): void {
  unpoolCollection();
  const own: CollectionHolder = { dexData: account.dexData, starterData: account.starterData };
  const all: readonly CollectionData[] = Array.isArray(partners) ? partners : [partners as CollectionData];
  const dexData: DexData = {};
  for (const [species, entry] of Object.entries(own.dexData)) {
    dexData[Number(species)] = all.reduce(
      (merged, partner) => mergeDexEntry(merged, partner.dex[Number(species)]),
      entry,
    );
  }
  const starterData: StarterData = {};
  for (const [species, entry] of Object.entries(own.starterData)) {
    const caught = ownCaught(own.dexData[Number(species)]);
    starterData[Number(species)] = all.reduce(
      (merged, partner) => mergeStarterEntry(merged, partner.starters[Number(species)], caught),
      entry,
    );
  }
  account.dexData = dexData;
  account.starterData = starterData;
  pooled = { account, own };
}

/** Take the merge off: the account has its own data again. */
export function unpoolCollection(): void {
  if (pooled === null) {
    return;
  }
  pooled.account.dexData = pooled.own.dexData;
  pooled.account.starterData = pooled.own.starterData;
  pooled = null;
}

/** @returns The account's own dex and starter data, which is what is saved: not the merge, while it is in place */
export function ownAccountData(account: CollectionHolder): CollectionHolder {
  return pooled?.account === account ? pooled.own : account;
}

/** What {@linkcode CollectionExchange} needs of the link */
export interface CollectionLink {
  sendLobby(message: LobbyMessage): void;
  /** `from`: the seat it came from (the host forwards a guest's in a game of three, D40) */
  onLobby(listener: (message: LobbyMessage, from: Seat) => void): () => void;
  onEnd(listener: () => void): () => void;
  /** This player's seat; default the host */
  readonly seat?: Seat;
  /** How many players the game has (D40); default 2 */
  readonly players?: PlayerCount;
}

/**
 * Sends this player's collection on entering the lobby and gets the others'. Each side sends its own with `ask`; a
 * collection with `ask` is answered with this player's, so they arrive whichever player enters the lobby first (a message
 * sent before the other listens is lost). Only the first `ask` of each player is answered: a player that asks over and over
 * gets nothing more (each answer is a whole collection).
 *
 * In a game of three the guests do not talk to each other (D40): the host passes each guest's collection on to the other,
 * once when it comes and again in its answer to a guest's ask, with the guest's seat in `seat`.
 */
export class CollectionExchange {
  private readonly collections = new Map<Seat, CollectionData>();
  private readonly answered = new Set<Seat>();
  private ended = false;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribes: (() => void)[];
  private readonly seat: Seat;
  private readonly expected: readonly Seat[];

  constructor(link: CollectionLink, own: CollectionData) {
    const players = link.players ?? 2;
    this.seat = link.seat ?? "host";
    this.expected = peers(this.seat, players);
    const hub = players === 3 && this.seat === "host";
    this.unsubscribes = [
      link.onLobby((message, from = otherSeat(this.seat)) => {
        if (message.t !== "collection") {
          return;
        }
        const about = players === 3 && from === "host" && message.seat !== undefined ? message.seat : from;
        if (about === this.seat || !this.expected.includes(about)) {
          return;
        }
        if (message.ask && !this.answered.has(from)) {
          this.answered.add(from);
          link.sendLobby({ t: "collection", collection: own, ask: false });
          if (hub) {
            for (const [seat, collection] of this.collections) {
              if (seat !== from) {
                link.sendLobby({ t: "collection", collection, ask: false, seat });
              }
            }
          }
        }
        if (!this.collections.has(about)) {
          this.collections.set(about, message.collection);
          if (hub) {
            link.sendLobby({ t: "collection", collection: message.collection, ask: false, seat: about });
          }
          this.notify();
        }
      }),
      link.onEnd(() => {
        this.ended = true;
        this.notify();
      }),
    ];
    link.sendLobby({ t: "collection", collection: own, ask: true });
  }

  /**
   * @returns The partner's collection, once it is here; `null` if the partner left first or it did not come within
   * `timeoutMs` (the starter select then shows this player's own Pokémon only)
   */
  async partnerCollection(timeoutMs: number): Promise<CollectionData | null> {
    return (await this.partnerCollections(timeoutMs))[0] ?? null;
  }

  /**
   * @returns The other players' collections, in seat order, once all are here; those that came if a player left first or
   * the rest did not come within `timeoutMs`
   */
  partnerCollections(timeoutMs: number): Promise<CollectionData[]> {
    const have = (): CollectionData[] =>
      this.expected.flatMap(seat => {
        const collection = this.collections.get(seat);
        return collection === undefined ? [] : [collection];
      });
    return new Promise(resolve => {
      const check = (): boolean => {
        if (this.collections.size < this.expected.length && !this.ended) {
          return false;
        }
        clearTimeout(timer);
        this.listeners.delete(onChange);
        resolve(have());
        return true;
      };
      const onChange = (): void => {
        check();
      };
      const timer = setTimeout(() => {
        this.listeners.delete(onChange);
        resolve(have());
      }, timeoutMs);
      if (!check()) {
        this.listeners.add(onChange);
      }
    });
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe();
    }
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
