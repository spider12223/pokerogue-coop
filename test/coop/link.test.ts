/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { guestHandshake } from "#coop/link/handshake";
import {
  CoopLink,
  createRoom,
  establishGuest,
  establishHost,
  HandshakeRefusedError,
  joinRoom,
  rejoinRoom,
} from "#coop/link/link";
import { StarterLobby } from "#coop/link/starter-lobby";
import {
  type BuildIdentity,
  type CoopStarter,
  hashCanonical,
  type LobbyMessage,
  type PinnedSettings,
  type StartPayload,
} from "#coop/protocol";
import { CoopSession } from "#coop/session";
import type { AccountSnapshot } from "#coop/sync/account-snapshot";
import { attachCheckpointExchange } from "#coop/sync/checkpoint-exchange";
import { FanoutTransport } from "#coop/transport/fanout";
import { createLoopbackPair, createLoopbackRoom } from "#coop/transport/loopback";
import { RelayError, type RelayEvent, type RelayWsTransport } from "#coop/transport/relay-ws";
import { ReliableTransport } from "#coop/transport/reliable";
import { RoutedHub } from "#coop/transport/routed";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RelayServer, startRelayServer } from "../../coop-server/src/relay-server.ts";

/**
 * The link (DECISIONS D1, D2): rooms at the relay, the handshake, and what runs on the link besides the sequencer:
 * the lobby, `START` and the checkpoint exchange. Two clients in one Node process.
 */

const build: BuildIdentity = {
  protocolVersion: 2,
  gitSha: "a6995c571a092e762ea036589bb6f3a8fa4f5dbd",
  dirtyHash: "clean",
  buildMode: "development+bypass",
  overridesHash: "00000000000000",
};

const pinned: PinnedSettings = { battleStyle: 1, enableTutorials: false };
const guestOverlay = { apply: (settings: PinnedSettings) => hashCanonical(settings), remove: () => undefined };

const account = (trainerId: number): AccountSnapshot => ({
  trainerId,
  secretId: 7,
  unlocked: { eviolite: false, miniBlackHole: false },
  caught: { 1: "1" },
  eggMoves: {},
});

const starter = (speciesId: number): CoopStarter => ({
  speciesId,
  shiny: false,
  variant: 0,
  formIndex: 0,
  abilityIndex: 0,
  passive: false,
  nature: 0,
  pokerus: false,
  ivs: [1, 2, 3, 4, 5, 6],
});

/** Wait until a condition holds (the reliable transport delivers on timers) */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Wait until `done` holds (the relay is a real one, over real sockets) */
async function waitFor(done: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** A relay connection whose notices the test sends (D40): what a link of three makes of them */
class FakeRelay {
  private readonly listeners = new Set<(event: RelayEvent) => void>();
  onRelayEvent(listener: (event: RelayEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onClose() {
    return () => {};
  }
  close(): void {}
  leave(): void {}
  emit(event: RelayEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}

/** Three links over a loopback room of three, as the game wires them, with a relay the test speaks for at the host */
function linksOfThree() {
  const room = createLoopbackRoom(3);
  const hub = new RoutedHub(room.host, ["guest", "guest2"]);
  const fanout = new FanoutTransport(
    new Map([
      ["guest", new ReliableTransport(hub.channel("guest"))],
      ["guest2", new ReliableTransport(hub.channel("guest2"))],
    ] as const),
  );
  const relay = new FakeRelay();
  const host = new CoopLink({ seat: "host", fanout, players: 3, relay: relay as unknown as RelayWsTransport });
  const guestReliable = new ReliableTransport(room.guests.get("guest")!);
  const guest = new CoopLink({ seat: "guest", reliable: guestReliable, players: 3 });
  const guest2 = new CoopLink({
    seat: "guest2",
    reliable: new ReliableTransport(room.guests.get("guest2")!),
    players: 3,
  });
  return { room, relay, host, guest, guest2, guestReliable };
}

describe("CoopLink of three (D40)", () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));

  it("shakes hands again with a guest who came back; they come in with the next reload, sent to them again", async () => {
    const room = createLoopbackRoom(3);
    const hub = new RoutedHub(room.host, ["guest", "guest2"]);
    const fanout = new FanoutTransport(
      new Map([
        ["guest", new ReliableTransport(hub.channel("guest"))],
        ["guest2", new ReliableTransport(hub.channel("guest2"))],
      ] as const),
    );
    const relay = new FakeRelay();
    const host = new CoopLink({
      seat: "host",
      fanout,
      hub,
      players: 3,
      relay: relay as unknown as RelayWsTransport,
      context: { build, pinned },
    });
    relay.emit({ t: "relay:peerBack", seat: "guest" });
    relay.emit({ t: "relay:peerBack", seat: "guest2" });
    await settle();
    // present from the start: nobody came back
    expect(host.takeWhoCameBack()).toEqual([]);
    // the second guest drops: it is away, and nothing is sent to it
    relay.emit({ t: "relay:peerLeft", seat: "guest2", holdMs: 60_000 });
    expect(host.present("guest2")).toBe(false);
    expect(host.needsResync).toBe(false);
    // it takes its seat back and shakes hands on a new channel
    relay.emit({ t: "relay:peerBack", seat: "guest2" });
    const result = await guestHandshake(new ReliableTransport(room.guests.get("guest2")!), build, guestOverlay, {
      name: "Kim",
    });
    expect(result.ok).toBe(true);
    await until(() => host.present("guest2"), "the returned guest is present");
    expect(host.needsResync).toBe(true);
    expect(host.reloadWaitsForWaveStart).toBe(true);
    // the reload says who came back: the second guest, not the first (D40)
    expect(host.takeWhoCameBack()).toEqual(["guest2"]);
    // the reload lets them in: nothing waits any more
    host.sendResync({ epoch: 1, seq: 0, wave: 2, reason: "rejoin", save: "{}" });
    expect(host.needsResync).toBe(false);
  });

  it("one chat for all three: a guest's line reaches the host and the other guest, with who said it", async () => {
    const { host, guest, guest2 } = linksOfThree();
    const atHost: [string, string][] = [];
    const atGuest2: [string, string][] = [];
    const atGuest: [string, string][] = [];
    host.onChat((chat, from) => atHost.push([chat.text, from]));
    guest.onChat((chat, from) => atGuest.push([chat.text, from]));
    guest2.onChat((chat, from) => atGuest2.push([chat.text, from]));
    guest.sendChat("hi all");
    host.sendChat("hello");
    await settle();
    expect(atHost).toEqual([["hi all", "guest"]]);
    // (in the order they reach it)
    expect([...atGuest2].sort()).toEqual([
      ["hello", "host"],
      ["hi all", "guest"],
    ]);
    // nobody hears their own line back
    expect(atGuest).toEqual([["hello", "host"]]);
  });

  it("refuses a forged proposal to the guest who sent it only", async () => {
    const { host, guest, guest2, guestReliable } = linksOfThree();
    const atGuest: string[] = [];
    const atGuest2: string[] = [];
    guest.sequencer.onProposalRejected(({ reason }) => atGuest.push(reason));
    guest2.sequencer.onProposalRejected(({ reason }) => atGuest2.push(reason));
    guestReliable.send({
      key: { wave: 1, turn: 1, kind: "TURN_COMMANDS", ref: 2 },
      author: "guest2",
      kind: "PROPOSE",
      payload: 1,
    });
    await settle();
    expect(atGuest).toEqual(["authorMismatch"]);
    expect(atGuest2).toEqual([]);
    for (const link of [host, guest, guest2]) {
      link.close();
    }
  });

  it("stops sending to a guest whose connection dropped, and the other guest still gets everything", async () => {
    const { room, relay, host, guest2 } = linksOfThree();
    const toGuest: string[] = [];
    const send = room.host.send.bind(room.host);
    room.host.send = (frame: string) => {
      if (frame.startsWith("guest\n")) {
        toGuest.push(frame);
      }
      send(frame);
    };
    relay.emit({ t: "relay:peerLeft", holdMs: null, seat: "guest" });
    const key = { wave: 1, turn: 1, kind: "TURN_COMMANDS", ref: 0 } as const;
    const onGuest2 = guest2.sequencer.awaitDecision(key);
    void host.sequencer.awaitDecision(key);
    host.sequencer.propose(key, "go on");
    expect((await onGuest2).payload).toBe("go on");
    await settle();
    expect(toGuest).toEqual([]);
    expect(host.present("guest")).toBe(false);
    host.close();
  });

  it("takes a seat's presence from the notices about it, not from the room being full again", () => {
    const { relay, host } = linksOfThree();
    relay.emit({ t: "relay:peerGone", seat: "guest" });
    relay.emit({ t: "relay:paired" });
    expect(host.present("guest")).toBe(false);
    expect(host.present("guest2")).toBe(true);
    host.close();
  });
});

describe("CoopLink over the relay", () => {
  let server: RelayServer;
  let url: string;
  const links: CoopLink[] = [];
  const reliable = { rtoMs: 40, tickMs: 10 };

  beforeEach(async () => {
    server = await startRelayServer({ port: 0, host: "127.0.0.1", holdMs: 3000, sweepIntervalMs: 50 });
    url = `ws://127.0.0.1:${server.port}/coop`;
  });

  afterEach(async () => {
    for (const link of links.splice(0)) {
      link.close();
    }
    await server.close();
  });

  async function connect(): Promise<{ host: CoopLink; guest: CoopLink; code: string }> {
    const room = await createRoom(url, { reliable });
    const guestRoom = await joinRoom(url, room.identity.code, { reliable });
    await room.partner;
    const [host, guest] = await Promise.all([
      establishHost(room, build, pinned),
      establishGuest(guestRoom, build, guestOverlay),
    ]);
    links.push(host.link, guest.link);
    return { host: host.link, guest: guest.link, code: room.identity.code };
  }

  it("creates a room with a code, the guest joins it, and the handshake gives each a link", async () => {
    const { host, guest, code } = await connect();
    expect(code).toMatch(/^[A-Z0-9]{4,8}$/);
    expect(host.seat).toBe("host");
    expect(guest.seat).toBe("guest");
    expect(host.code).toBe(code);
  });

  describe("three players (D40)", () => {
    it("a guest whose connection drops takes its seat back; the host shakes hands again and lets it in with a reload", async () => {
      const { host, guest } = await connectThree();
      const ends: string[] = [];
      guest.onEnd(end => ends.push(end));
      (guest as unknown as { relay: { close(): void } }).relay.close();
      await waitFor(() => !host.present("guest"));
      // the guest's link reconnects with its seat's token, and the two shake hands again
      await waitFor(() => host.present("guest") && host.needsResync, 15_000);
      expect(host.reloadWaitsForWaveStart).toBe(true);
      expect(ends).not.toContain("closed");
      expect(guest.needsResync).toBe(true);
    });

    it("the host's own connection drops: it takes its seat back and shakes hands again with both guests, who hear it", async () => {
      const { host, guest, guest2 } = await connectThree();
      const ends: string[] = [];
      guest.onEnd(end => ends.push(`guest ${end}`));
      guest2.onEnd(end => ends.push(`guest2 ${end}`));
      (host as unknown as { relay: { close(): void } }).relay.close();
      await waitFor(() => !host.partnerPresent);
      // the host's link takes its seat back and shakes hands again with each guest, over its new connection
      await waitFor(() => host.partnerPresent && host.needsResync, 15_000);
      expect(host.reloadWaitsForWaveStart).toBe(false);
      const atGuest: string[] = [];
      const atGuest2: string[] = [];
      guest.onChat(chat => atGuest.push(chat.text));
      guest2.onChat(chat => atGuest2.push(chat.text));
      host.sendChat("back");
      await waitFor(() => atGuest.includes("back") && atGuest2.includes("back"), 5000);
      // (each guest saw the host away for a moment; neither link ended)
      expect(ends).not.toContain("guest closed");
      expect(ends).not.toContain("guest2 closed");
      expect(guest.present("host") && guest2.present("host")).toBe(true);
    });

    it("tells a guest whose tab came back that the host's debug menu is on, and the challenges (D42, D41)", async () => {
      const challenges = [{ id: 3, value: 1, severity: 1 }];
      const room = await createRoom(url, { reliable, seats: 3 });
      const guestRoom = await joinRoom(url, room.identity.code, { reliable });
      const guest2Room = await joinRoom(url, room.identity.code, { reliable });
      await room.partner;
      const [host, guest, guest2] = await Promise.all([
        establishHost(room, build, pinned, { name: "Sam", runMode: "challenge", challenges, debug: true }),
        establishGuest(guestRoom, build, guestOverlay, { name: "Alex" }),
        establishGuest(guest2Room, build, guestOverlay, { name: "Kim" }),
      ]);
      links.push(host.link, guest.link, guest2.link);
      expect(guest.hello.debug).toBe(true);

      // the guest's tab is reloaded: a new connection with its seat's token, and the handshake again
      guest.link.close();
      await waitFor(() => !host.link.present("guest"));
      const again = await rejoinRoom(
        url,
        { code: room.identity.code, seat: "guest", token: guestRoom.identity.token },
        { reliable },
      );
      await again.paired;
      const back = await establishGuest(again, build, guestOverlay, { name: "Alex" });
      links.push(back.link);
      expect(back.hello.mode).toBe("resume");
      expect(back.hello.debug).toBe(true);
      expect(back.hello.challenges).toEqual(challenges);
    });

    async function connectThree() {
      const room = await createRoom(url, { reliable, seats: 3 });
      const guestRoom = await joinRoom(url, room.identity.code, { reliable });
      const guest2Room = await joinRoom(url, room.identity.code, { reliable });
      await room.partner;
      const [host, guest, guest2] = await Promise.all([
        establishHost(room, build, pinned, { name: "  Sam  " }),
        establishGuest(guestRoom, build, guestOverlay, { name: "Alex" }),
        establishGuest(guest2Room, build, guestOverlay, { name: "Kim\u0007" }),
      ]);
      links.push(host.link, guest.link, guest2.link);
      return { host: host.link, guest: guest.link, guest2: guest2.link };
    }

    it("shakes hands with each guest as it joins, and tells everyone the names (D40)", async () => {
      const room = await createRoom(url, { reliable, seats: 3 });
      const progress: Partial<Record<string, string>>[] = [];
      const hosting = establishHost(room, build, pinned, { name: "Sam", onProgress: names => progress.push(names) });
      const guestRoom = await joinRoom(url, room.identity.code, { reliable });
      // Guest 1 is through before guest 2 has even joined: its handshake does not wait on the other's
      const guest = (await establishGuest(guestRoom, build, guestOverlay, { name: "Alex" })).link;
      links.push(guest);
      expect(guest.rosterComplete).toBe(false);
      // Only who is in: the second guest's seat has no name yet
      expect(guest.knownNames).toEqual({ host: "Sam", guest: "Alex" });
      const guest2Room = await joinRoom(url, room.identity.code, { reliable });
      const guest2 = (await establishGuest(guest2Room, build, guestOverlay, { name: "Kim" })).link;
      const host = (await hosting).link;
      links.push(guest2, host);
      expect(progress).toEqual([{ guest: "Alex" }, { guest: "Alex", guest2: "Kim" }]);
      await waitFor(() => guest.rosterComplete && guest2.rosterComplete);
      expect(guest.names).toEqual({ host: "Sam", guest: "Alex", guest2: "Kim" });
      expect(guest2.names).toEqual({ host: "Sam", guest: "Alex", guest2: "Kim" });
      expect(guest.partnerName).toBe("Sam & Kim");
    });

    it("gives the seat of a guest who left before the room was full to the next one (D40)", async () => {
      const room = await createRoom(url, { reliable, seats: 3 });
      const hosting = establishHost(room, build, pinned, { name: "Sam" });
      const leaverRoom = await joinRoom(url, room.identity.code, { reliable });
      const leaver = (await establishGuest(leaverRoom, build, guestOverlay, { name: "Lee" })).link;
      leaverRoom.relay.leave();
      leaver.close();
      await new Promise(resolve => setTimeout(resolve, 100));
      const guestRoom = await joinRoom(url, room.identity.code, { reliable });
      expect(guestRoom.identity.seat).toBe("guest");
      const guest2Room = await joinRoom(url, room.identity.code, { reliable });
      const [guest, guest2] = await Promise.all([
        establishGuest(guestRoom, build, guestOverlay, { name: "Alex" }),
        establishGuest(guest2Room, build, guestOverlay, { name: "Kim" }),
      ]);
      const host = (await hosting).link;
      links.push(guest.link, guest2.link, host);
      expect(host.names).toEqual({ host: "Sam", guest: "Alex", guest2: "Kim" });
    });

    it("refuses the game when one guest is on another build (D40)", async () => {
      const room = await createRoom(url, { reliable, seats: 3 });
      const hosting = establishHost(room, build, pinned);
      const guestRoom = await joinRoom(url, room.identity.code, { reliable });
      const guest = (await establishGuest(guestRoom, build, guestOverlay)).link;
      links.push(guest);
      const guest2Room = await joinRoom(url, room.identity.code, { reliable });
      const refused = await Promise.allSettled([
        hosting,
        establishGuest(guest2Room, { ...build, gitSha: "other" }, guestOverlay),
      ]);
      expect(refused.map(result => result.status)).toEqual(["rejected", "rejected"]);
      expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(HandshakeRefusedError);
      room.cancel();
      guest2Room.cancel();
    });

    it("gives a session of three every player's name by seat (D40)", async () => {
      const { guest2 } = await connectThree();
      await waitFor(() => guest2.rosterComplete);
      const session = new CoopSession({ seat: "guest2", runSeed: "x", build });
      session.link = guest2;
      expect(session.names).toEqual({ host: "Sam", guest: "Alex", guest2: "Kim" });
    });

    it("tells lobby listeners which seat a lobby message came from (D40)", async () => {
      const { host, guest2 } = await connectThree();
      const got: [LobbyMessage, string][] = [];
      host.onLobby((message, from) => got.push([message, from]));
      guest2.sendLobby({ t: "unready" });
      await waitFor(() => got.length > 0);
      expect(got).toEqual([[{ t: "unready" }, "guest2"]]);
    });

    it("links three players, each in its seat, and the host knows the three names", async () => {
      const { host, guest, guest2 } = await connectThree();
      expect([host.seat, guest.seat, guest2.seat]).toEqual(["host", "guest", "guest2"]);
      expect([host.players, guest.players, guest2.players]).toEqual([3, 3, 3]);
      expect(host.names).toEqual({ host: "Sam", guest: "Alex", guest2: "Kim" });
      expect(guest2.names).toMatchObject({ host: "Sam", guest2: "Kim" });
    });

    it("sequences a decision of the second guest to all three, in one order", async () => {
      const { host, guest, guest2 } = await connectThree();
      const key = { wave: 1, turn: 1, kind: "TURN_COMMANDS", ref: 3 } as const;
      const got = [host, guest, guest2].map(link => link.sequencer.awaitDecision(key, { authors: ["guest2"] }));
      guest2.sequencer.propose(key, { from: "guest2" });
      const [onHost, onGuest, onGuest2] = await Promise.all(got);
      expect(onHost).toMatchObject({ seq: 1, author: "guest2" });
      expect(onGuest).toEqual(onHost);
      expect(onGuest2).toEqual(onHost);
    });

    it("tells the host who left, and goes on with the guest who stays", async () => {
      const { host, guest, guest2 } = await connectThree();
      const changes: [string, boolean][] = [];
      host.onPresence((seat, present) => changes.push([seat, present]));
      guest.close();
      await waitFor(() => !host.present("guest"));
      expect(host.present("guest2")).toBe(true);
      expect(changes).toContainEqual(["guest", false]);
      const key = { wave: 1, turn: 2, kind: "TURN_COMMANDS", ref: 3 } as const;
      const onHost = host.sequencer.awaitDecision(key, { authors: ["guest2"] });
      const onGuest2 = guest2.sequencer.awaitDecision(key, { authors: ["guest2"] });
      guest2.sequencer.propose(key, "still here");
      expect((await onHost).payload).toBe("still here");
      expect(await onGuest2).toEqual(await onHost);
    });
  });

  it("refuses a join with a code that does not exist", async () => {
    await expect(joinRoom(url, "ZZZZZZ", { reliable })).rejects.toBeInstanceOf(RelayError);
  });

  it("refuses a guest on another build", async () => {
    const room = await createRoom(url, { reliable });
    const guestRoom = await joinRoom(url, room.identity.code, { reliable });
    await room.partner;
    const results = await Promise.allSettled([
      establishHost(room, build, pinned),
      establishGuest(guestRoom, { ...build, gitSha: "other" }, guestOverlay),
    ]);
    expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
    const [host] = results;
    expect((host as PromiseRejectedResult).reason).toBeInstanceOf(HandshakeRefusedError);
    room.cancel();
    guestRoom.cancel();
  });

  it("sequences a decision from either side on the link", async () => {
    const { host, guest } = await connect();
    const key = { wave: 1, turn: 1, kind: "TURN_COMMANDS", ref: 7 } as const;
    const onHost = host.sequencer.awaitDecision(key, { authors: ["guest"] });
    const onGuest = guest.sequencer.awaitDecision(key, { authors: ["guest"] });
    guest.sequencer.propose(key, { hello: "host" });
    expect(await onHost).toEqual(await onGuest);
    expect((await onHost).author).toBe("guest");
  });

  it("sequences a decision of the guest to both clients in a few milliseconds over the local relay", async () => {
    // What a player waits for after their own choice when the partner has chosen already: the decision goes to the host,
    // is sequenced there, and comes back. (When the host chooses last, its own decision is sequenced at once.)
    const { host, guest } = await connect();
    const samples: number[] = [];
    for (let i = 0; i < 60; i++) {
      const key = { wave: 1, turn: i + 1, kind: "TURN_COMMANDS", ref: i } as const;
      const onHost = host.sequencer.awaitDecision(key);
      const onGuest = guest.sequencer.awaitDecision(key);
      const started = performance.now();
      guest.sequencer.propose(key, i);
      await Promise.all([onHost, onGuest]);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const at = (fraction: number): number =>
      samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))];
    process.stderr.write(
      `decision round trip over the local relay (guest -> host -> guest), ${samples.length} samples: `
        + `median ${at(0.5).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)} ms, max ${samples.at(-1)!.toFixed(1)} ms`,
    );
    expect(at(0.5)).toBeLessThan(100);
  });

  it("carries the lobby, START and checkpoints between the two", async () => {
    const { host, guest } = await connect();
    const lobbyAtHost: LobbyMessage[] = [];
    host.onLobby(message => lobbyAtHost.push(message));
    const startAtGuest: StartPayload[] = [];
    guest.onStart(start => startAtGuest.push(start));

    guest.sendLobby({ t: "unready" });
    await until(() => lobbyAtHost.length === 1, "the lobby message");
    expect(lobbyAtHost[0]).toEqual({ t: "unready" });

    const start: StartPayload = {
      runSeed: "seed",
      starters: { host: [starter(1)], guest: [starter(4)] },
      snapshots: { host: account(1), guest: account(2) },
      timedEvents: [],
    };
    host.sendStart(start);
    await until(() => startAtGuest.length === 1, "START");
    expect(startAtGuest[0]).toEqual(start);
    expect(() => guest.sendStart(start)).toThrow("Only the host");
  });

  it("tells the survivor that the partner left", async () => {
    const { host, guest } = await connect();
    const ends: string[] = [];
    host.onEnd(end => ends.push(end));
    guest.close();
    await until(() => ends.length > 0, "the partner leaving");
    expect(["peerLeft", "peerGone", "closed"]).toContain(ends[0]);
  });
});

describe("StarterLobby and the checkpoint exchange on a link", () => {
  const links: CoopLink[] = [];
  const reliable = { rtoMs: 40, tickMs: 10 };

  function pair(): { host: CoopLink; guest: CoopLink } {
    const [a, b] = createLoopbackPair();
    const host = new CoopLink({ seat: "host", reliable: new ReliableTransport(a, reliable) });
    const guest = new CoopLink({ seat: "guest", reliable: new ReliableTransport(b, reliable) });
    links.push(host, guest);
    return { host, guest };
  }

  afterEach(() => {
    for (const link of links.splice(0)) {
      link.close();
    }
    clocks.host = [];
    clocks.guest = [];
  });

  /** The timed events each client's clock has on (D33) */
  const clocks: Record<"host" | "guest", string[]> = { host: [], guest: [] };

  function lobbies(sharedLimit = 10) {
    const { host, guest } = pair();
    const make = (seat: "host" | "guest", link: CoopLink) =>
      new StarterLobby({ seat, link, sharedLimit, makeRunSeed: () => "run-seed", localEvents: () => clocks[seat] });
    return { host: make("host", host), guest: make("guest", guest), hostLink: host, guestLink: guest };
  }

  it("shows each player the other's picks and takes their points", async () => {
    const { host, guest } = lobbies();
    expect(host.valueLimit).toBe(10);
    host.setPicks([starter(1)], 3);
    await until(() => guest.partner.picks.length === 1, "the host's picks");
    expect(guest.partner).toMatchObject({ cost: 3, ready: false });
    expect(guest.valueLimit).toBe(7);
    expect(host.valueLimit).toBe(10);
  });

  it("refuses a party that costs more than the partner left, and one with no or too many starters", async () => {
    const { host, guest } = lobbies();
    host.setPicks([starter(1)], 7);
    await until(() => guest.partner.cost === 7, "the host's picks");
    expect(guest.setReady([starter(4)], 4, account(2))).toBe(false);
    expect(guest.setReady([], 0, account(2))).toBe(false);
    expect(guest.setReady([1, 2, 3, 4].map(starter), 1, account(2))).toBe(false);
    expect(guest.setReady([starter(4)], 3, account(2))).toBe(true);
  });

  it("starts the run on both clients when both are ready, with the same START", async () => {
    const { host, guest } = lobbies();
    const startedAtHost: StartPayload[] = [];
    const startedAtGuest: StartPayload[] = [];
    host.onStart(start => startedAtHost.push(start));
    guest.onStart(start => startedAtGuest.push(start));

    expect(guest.setReady([starter(4), starter(7)], 6, account(2))).toBe(true);
    await until(() => host.partner.ready, "the guest being ready");
    expect(startedAtHost).toEqual([]);
    expect(host.setReady([starter(1)], 3, account(1))).toBe(true);
    await until(() => startedAtGuest.length === 1, "START at the guest");

    expect(startedAtHost).toHaveLength(1);
    expect(startedAtGuest[0]).toEqual(startedAtHost[0]);
    expect(startedAtHost[0]).toEqual({
      runSeed: "run-seed",
      starters: { host: [starter(1)], guest: [starter(4), starter(7)] },
      snapshots: { host: account(1), guest: account(2) },
      timedEvents: [],
    });
    expect(host.startInfo).not.toBeNull();
    expect(guest.startInfo).not.toBeNull();
  });

  it("starts the run with the timed events both clocks have on (D33)", async () => {
    // The guest's clock is past the end of one event and before the start of another
    clocks.host = ["Halloween 26", "Item Update waiting room"];
    clocks.guest = ["Item Update waiting room", "Winter 26"];
    const { host, guest } = lobbies();
    const startedAtGuest: StartPayload[] = [];
    guest.onStart(start => startedAtGuest.push(start));
    expect(guest.setReady([starter(4)], 3, account(2))).toBe(true);
    await until(() => host.partner.ready, "the guest being ready");
    expect(host.setReady([starter(1)], 3, account(1))).toBe(true);
    await until(() => startedAtGuest.length === 1, "START at the guest");
    expect(startedAtGuest[0].timedEvents).toEqual(["Item Update waiting room"]);
    expect(host.startInfo?.timedEvents).toEqual(["Item Update waiting room"]);
  });

  it("lets a ready player take the ready back and change the party", async () => {
    const { host, guest } = lobbies();
    guest.setReady([starter(4)], 3, account(2));
    await until(() => host.partner.ready, "the guest being ready");
    guest.cancelReady();
    await until(() => !host.partner.ready, "the guest taking the ready back");
    expect(guest.localReady).toBe(false);
    expect(host.setReady([starter(1)], 3, account(1))).toBe(true);
    expect(host.startInfo).toBeNull();
  });

  it("resets both when the two parties together cost more than the budget", async () => {
    // Both add points at the same time, so each accepted the other's earlier, smaller party
    const { host, guest } = lobbies();
    expect(host.setReady([starter(1)], 6, account(1))).toBe(true);
    expect(guest.setReady([starter(4)], 6, account(2))).toBe(true);
    await until(() => !host.localReady && !guest.localReady, "the reset");
    expect(host.startInfo).toBeNull();
    expect(guest.startInfo).toBeNull();
    expect(host.partner.ready).toBe(false);
    expect(guest.partner.ready).toBe(false);
    // both screens say why, until the player picks again
    await until(() => guest.wasReset, "the reset at the guest");
    expect(host.wasReset).toBe(true);
    guest.setPicks([starter(4)], 3);
    expect(guest.wasReset).toBe(false);
    expect(host.wasReset).toBe(true);
  });

  it("exchanges checkpoints and finds the first one that differs", async () => {
    const { hostLink, guestLink } = lobbies();
    const make = (seat: "host" | "guest") =>
      new CoopSession({ seat, runSeed: "x", build, accountSnapshot: { host: account(1), guest: account(2) } });
    const hostSession = make("host");
    const guestSession = make("guest");
    attachCheckpointExchange(hostSession, hostLink);
    attachCheckpointExchange(guestSession, guestLink);

    const pass = (session: CoopSession, hash: string, turn: number) => {
      const checkpoint = session.checkpoints.append({ kind: "turn", wave: 1, turn, phaseName: "TurnInitPhase", hash });
      session.onCheckpoint?.(checkpoint);
    };
    pass(hostSession, "aaaaaaaaaaaaaa", 1);
    pass(guestSession, "aaaaaaaaaaaaaa", 1);
    await until(
      () => hostSession.remoteCheckpoints.size === 0 && guestSession.remoteCheckpoints.size === 0,
      "checkpoint 0",
    );
    expect(hostSession.checkpointMismatch).toBeNull();
    expect(guestSession.checkpointMismatch).toBeNull();

    // The guest is ahead and the hash differs: the host notices when it reaches the checkpoint
    pass(guestSession, "bbbbbbbbbbbbbb", 2);
    await until(() => hostSession.remoteCheckpoints.has(1), "the guest's checkpoint 1");
    expect(hostSession.checkpointMismatch).toBeNull();
    pass(hostSession, "cccccccccccccc", 2);
    expect(hostSession.checkpointMismatch).not.toBeNull();
    expect(hostSession.desyncMessage).toContain("checkpoint #1");
    await until(() => guestSession.checkpointMismatch !== null, "the guest noticing too");
  });
});
