/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { CollectionData } from "#coop/collection-data";
import { CoopLink } from "#coop/link";
import { isLobbyMessage, type LobbyMessage } from "#coop/protocol";
import {
  CollectionExchange,
  type CollectionHolder,
  type CollectionLink,
  captureCollection,
  mergeDexEntry,
  mergeStarterEntry,
  ownAccountData,
  poolCollection,
  unpoolCollection,
} from "#coop/shared-collection";
import { createLoopbackPair } from "#coop/transport/loopback";
import { ReliableTransport } from "#coop/transport/reliable";
import { Passive } from "#enums/passive";
import type { RibbonData } from "#system/ribbon-data";
import type { DexEntry } from "#types/dex-data";
import type { StarterDataEntry } from "#types/save-data";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The co-op starter select shows the Pokémon of both players (DECISIONS D32): the collection that goes over the wire, the
 * merge, what of it reaches the save, and the exchange on a link.
 */

const ribbons = { ribbons: "sentinel" } as unknown as RibbonData;

function dexEntry(caught: bigint, ivs = [0, 0, 0, 0, 0, 0], natureAttr = 0): DexEntry {
  return {
    seenAttr: caught,
    caughtAttr: caught,
    natureAttr,
    seenCount: caught ? 3 : 0,
    caughtCount: caught ? 2 : 0,
    hatchedCount: 0,
    ivs,
    ribbons,
  };
}

function starterEntry(entry: Partial<StarterDataEntry> = {}): StarterDataEntry {
  return {
    moveset: null,
    eggMoves: 0,
    candyCount: 0,
    friendship: 0,
    abilityAttr: 0,
    passiveAttr: 0,
    valueReduction: 0,
    classicWinCount: 0,
    pity: [0, 0],
    ...entry,
  };
}

/** Bulbasaur caught by both, Mew only by the partner */
function accounts(): { own: CollectionHolder; partner: CollectionHolder } {
  return {
    own: {
      dexData: { 1: dexEntry(0b101n, [31, 10, 10, 10, 10, 10], 0b10), 151: dexEntry(0n) },
      starterData: { 1: starterEntry({ abilityAttr: 1, candyCount: 40 }), 151: starterEntry() },
    },
    partner: {
      dexData: { 1: dexEntry(0b1001n, [5, 20, 10, 10, 10, 31], 0b100), 151: dexEntry(0b1111n) },
      starterData: {
        1: starterEntry({ abilityAttr: 4, eggMoves: 2, candyCount: 99 }),
        151: starterEntry({ abilityAttr: 1, passiveAttr: Passive.UNLOCKED, valueReduction: 1, classicWinCount: 2 }),
      },
    },
  };
}

describe("the collection on the wire", () => {
  it("has the caught species and the starters with something unlocked, and nothing the partner cannot use", () => {
    const { own, partner } = accounts();
    const collection = captureCollection(partner);
    expect(collection.dex).toEqual({
      1: { caught: "9", seen: "9", natures: 0b100, ivs: [5, 20, 10, 10, 10, 31] },
      151: { caught: "15", seen: "15", natures: 0, ivs: [0, 0, 0, 0, 0, 0] },
    });
    expect(collection.starters[151]).toEqual({
      abilities: 1,
      passive: Passive.UNLOCKED,
      reduction: 1,
      eggMoves: 0,
      wins: 2,
    });
    // Candies stay with their owner
    expect(JSON.stringify(collection)).not.toContain("99");
    expect(Object.keys(captureCollection(own).dex)).toEqual(["1"]);
    expect(isLobbyMessage({ t: "collection", collection, ask: true })).toBe(true);
  });

  it("refuses a collection that is not one", () => {
    const valid = captureCollection(accounts().partner);
    const bad: unknown[] = [
      { ...valid, dex: { 1: { ...valid.dex[1], ivs: [32, 0, 0, 0, 0, 0] } } },
      { ...valid, dex: { 1: { ...valid.dex[1], caught: "-1" } } },
      { ...valid, starters: { 1: { abilities: 1 } } },
      { ...valid, dex: Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [i, valid.dex[1]])) },
      { dex: [], starters: {} },
    ];
    for (const collection of bad) {
      expect(isLobbyMessage({ t: "collection", collection, ask: false })).toBe(false);
    }
    expect(isLobbyMessage({ t: "collection", collection: valid })).toBe(false);
  });
});

describe("the merge", () => {
  it("takes every form either caught and the better IV of each stat, and keeps the player's counts and ribbons", () => {
    const { own, partner } = accounts();
    const collection = captureCollection(partner);
    const merged = mergeDexEntry(own.dexData[1], collection.dex[1]);
    expect(merged).toMatchObject({
      caughtAttr: 0b1101n,
      seenAttr: 0b1101n,
      natureAttr: 0b110,
      ivs: [31, 20, 10, 10, 10, 31],
      seenCount: 3,
      caughtCount: 2,
    });
    expect(merged.ribbons).toBe(ribbons);
    // A species only the partner caught
    expect(mergeDexEntry(own.dexData[151], collection.dex[151]).caughtAttr).toBe(0b1111n);
  });

  it("keeps the player's own entry when the partner adds nothing", () => {
    const { own } = accounts();
    expect(mergeDexEntry(own.dexData[1], undefined)).toBe(own.dexData[1]);
    expect(mergeDexEntry(own.dexData[1], captureCollection(own).dex[1])).toBe(own.dexData[1]);
    expect(mergeStarterEntry(own.starterData[1], captureCollection(own).starters[1])).toBe(own.starterData[1]);
  });

  it("writes what the screen changes to the player's own entry: candies, the custom moveset, a bought cost reduction", () => {
    const { own, partner } = accounts();
    const collection = captureCollection(partner);
    const merged = mergeStarterEntry(own.starterData[1], collection.starters[1]);
    expect(merged).toMatchObject({ abilityAttr: 5, eggMoves: 2, candyCount: 40 });

    merged.candyCount -= 15;
    merged.valueReduction++;
    merged.moveset = {};
    merged.moveset[0] = [1, 2, 3, 4];
    expect(own.starterData[1]).toMatchObject({ candyCount: 25, valueReduction: 1, moveset: { 0: [1, 2, 3, 4] } });
    // The partner's part is not written to the player's entry
    expect(own.starterData[1]).toMatchObject({ abilityAttr: 1, eggMoves: 0 });
    // The screen reads its entries through a JSON copy
    expect(JSON.parse(JSON.stringify(merged))).toMatchObject({ candyCount: 25, valueReduction: 1, abilityAttr: 5 });
  });

  it("lets the player turn a passive only the partner unlocked on and off, without unlocking it on their account", () => {
    const { own, partner } = accounts();
    const merged = mergeStarterEntry(own.starterData[151], captureCollection(partner).starters[151]);
    expect(merged.passiveAttr).toBe(Passive.UNLOCKED);
    expect(merged.valueReduction).toBe(1);
    merged.passiveAttr ^= Passive.ENABLED;
    expect(merged.passiveAttr).toBe(Passive.UNLOCKED | Passive.ENABLED);
    expect(own.starterData[151].passiveAttr).toBe(0);
  });

  it("gives the player a passive they buy when neither had it", () => {
    const { own } = accounts();
    const merged = mergeStarterEntry(own.starterData[1], {
      abilities: 4,
      passive: 0,
      reduction: 0,
      eggMoves: 0,
      wins: 0,
    });
    expect(merged.passiveAttr).toBe(0);
    merged.passiveAttr |= Passive.UNLOCKED | Passive.ENABLED;
    expect(own.starterData[1].passiveAttr).toBe(Passive.UNLOCKED | Passive.ENABLED);
  });
});

describe("the merge in place of the account", () => {
  afterEach(() => unpoolCollection());

  it("shows both collections while it is in place, saves the player's own, and comes off", () => {
    const { own, partner } = accounts();
    const { dexData, starterData } = own;
    poolCollection(own, captureCollection(partner));
    expect(own.dexData[151].caughtAttr).toBe(0b1111n);
    expect(own.starterData[151].classicWinCount).toBe(2);
    expect(ownAccountData(own)).toEqual({ dexData, starterData });
    expect(ownAccountData(own).dexData[151].caughtAttr).toBe(0n);
    // Another account (a test's, a new one) is not the merged one
    expect(ownAccountData(partner)).toBe(partner);

    unpoolCollection();
    expect(own.dexData).toBe(dexData);
    expect(own.starterData).toBe(starterData);
    expect(ownAccountData(own)).toBe(own);
  });
});

describe("the exchange on a link", () => {
  const links: CoopLink[] = [];
  const exchanges: CollectionExchange[] = [];
  const reliable = { rtoMs: 40, tickMs: 10 };

  function pair(): { host: CoopLink; guest: CoopLink } {
    const [a, b] = createLoopbackPair();
    const host = new CoopLink({ seat: "host", reliable: new ReliableTransport(a, reliable) });
    const guest = new CoopLink({ seat: "guest", reliable: new ReliableTransport(b, reliable) });
    links.push(host, guest);
    return { host, guest };
  }

  function exchange(link: CoopLink, collection: CollectionData): CollectionExchange {
    const made = new CollectionExchange(link, collection);
    exchanges.push(made);
    return made;
  }

  afterEach(() => {
    for (const made of exchanges.splice(0)) {
      made.dispose();
    }
    for (const link of links.splice(0)) {
      link.close();
    }
  });

  const hostCollection = captureCollection(accounts().partner);
  const guestCollection = captureCollection(accounts().own);

  it("gets both collections when one player enters the lobby before the other listens", async () => {
    const { host, guest } = pair();
    const atHost = exchange(host, hostCollection);
    // The host's collection reaches the guest before the guest's lobby listens: it is lost, and the guest's ask brings it
    await new Promise(resolve => setTimeout(resolve, 100));
    const atGuest = exchange(guest, guestCollection);
    const [fromGuest, fromHost] = await Promise.all([atHost.partnerCollection(5000), atGuest.partnerCollection(5000)]);
    expect(fromGuest).toEqual(guestCollection);
    expect(fromHost).toEqual(hostCollection);
  });

  it("gets both when both enter at once", async () => {
    const { host, guest } = pair();
    const atHost = exchange(host, hostCollection);
    const atGuest = exchange(guest, guestCollection);
    expect(await atGuest.partnerCollection(5000)).toEqual(hostCollection);
    expect(await atHost.partnerCollection(5000)).toEqual(guestCollection);
    // Asked again later, it is still there
    expect(await atHost.partnerCollection(1)).toEqual(guestCollection);
  });

  it("gives up when the partner leaves or takes too long", async () => {
    const { host, guest } = pair();
    const atHost = exchange(host, hostCollection);
    expect(await atHost.partnerCollection(50)).toBeNull();
    guest.close();
    expect(await atHost.partnerCollection(5000)).toBeNull();
  });

  it("answers only the first ask: a partner that asks over and over does not get the collection over and over", () => {
    const sent: LobbyMessage[] = [];
    let listener: ((message: LobbyMessage) => void) | null = null;
    const link: CollectionLink = {
      sendLobby: message => sent.push(message),
      onLobby: l => {
        listener = l;
        return () => undefined;
      },
      onEnd: () => () => undefined,
    };
    const made = new CollectionExchange(link, hostCollection);
    exchanges.push(made);
    for (let i = 0; i < 50; i++) {
      listener!({ t: "collection", collection: guestCollection, ask: true });
    }
    // its own ask, and one answer
    expect(sent.map(message => (message.t === "collection" ? message.ask : null))).toEqual([true, false]);
  });
});

describe("a partner's collection that is out of the game's ranges", () => {
  const valid = captureCollection(accounts().partner);

  it("is refused on the wire", () => {
    const starter = valid.starters[151];
    const bad: unknown[] = [
      // the starter select counts the cost down one reduction at a time: a huge one froze the tab
      { ...valid, starters: { 151: { ...starter, reduction: 2 ** 52 } } },
      { ...valid, starters: { 151: { ...starter, reduction: 3 } } },
      { ...valid, starters: { 151: { ...starter, abilities: 8 } } },
      { ...valid, starters: { 151: { ...starter, passive: 4 } } },
      { ...valid, starters: { 151: { ...starter, eggMoves: 16 } } },
      { ...valid, starters: { 151: { ...starter, wins: 1_000_001 } } },
      { ...valid, dex: { 1: { ...valid.dex[1], natures: 2 ** 26 } } },
      { ...valid, dex: { 1: { ...valid.dex[1], caught: (2n ** 64n).toString() } } },
      { ...valid, dex: { 1: { ...valid.dex[1], seen: "9".repeat(40) } } },
    ];
    for (const collection of bad) {
      expect(isLobbyMessage({ t: "collection", collection, ask: false })).toBe(false);
    }
    const best = {
      ...valid,
      starters: { 151: { abilities: 7, passive: 3, reduction: 2, eggMoves: 15, wins: 1_000_000 } },
      dex: { 1: { ...valid.dex[1], natures: 2 ** 26 - 1, caught: (2n ** 64n - 1n).toString() } },
    };
    expect(isLobbyMessage({ t: "collection", collection: best, ask: false })).toBe(true);
  });

  it("is clamped in the merge, whatever got through", () => {
    const own = starterEntry();
    const merged = mergeStarterEntry(own, {
      abilities: 0xff,
      passive: 0,
      reduction: 2 ** 52,
      eggMoves: 0xff,
      wins: 2 ** 52,
    });
    expect(merged.valueReduction).toBe(2);
    expect(merged.abilityAttr).toBe(7);
    expect(merged.eggMoves).toBe(15);
    expect(merged.classicWinCount).toBe(1_000_000);
    const dex = mergeDexEntry(dexEntry(1n), {
      caught: (2n ** 70n + 2n).toString(),
      seen: "0",
      natures: 2 ** 30 + 4,
      ivs: [99, 0, 0, 0, 0, 0],
    });
    expect(dex.caughtAttr).toBe(3n);
    expect(dex.natureAttr).toBe(4);
    expect(dex.ivs[0]).toBe(31);
  });
});
