/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { AccountSnapshot } from "#coop/account-snapshot";
import { attachCheckpointExchange } from "#coop/checkpoint-exchange";
import { CoopLink, createRoom, establishGuest, establishHost, HandshakeRefusedError, joinRoom } from "#coop/link";
import {
  type BuildIdentity,
  type CoopStarter,
  hashCanonical,
  type LobbyMessage,
  type PinnedSettings,
  type StartPayload,
} from "#coop/protocol";
import { CoopSession } from "#coop/session";
import { StarterLobby } from "#coop/starter-lobby";
import { createLoopbackPair } from "#coop/transport/loopback";
import { RelayError } from "#coop/transport/relay-ws";
import { ReliableTransport } from "#coop/transport/reliable";
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
  });

  function lobbies(sharedLimit = 10) {
    const { host, guest } = pair();
    const make = (seat: "host" | "guest", link: CoopLink) =>
      new StarterLobby({ seat, link, sharedLimit, makeRunSeed: () => "run-seed" });
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
    });
    expect(host.startInfo).not.toBeNull();
    expect(guest.startInfo).not.toBeNull();
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
    pass(hostSession, "aaaa", 1);
    pass(guestSession, "aaaa", 1);
    await until(
      () => hostSession.remoteCheckpoints.size === 0 && guestSession.remoteCheckpoints.size === 0,
      "checkpoint 0",
    );
    expect(hostSession.checkpointMismatch).toBeNull();
    expect(guestSession.checkpointMismatch).toBeNull();

    // The guest is ahead and the hash differs: the host notices when it reaches the checkpoint
    pass(guestSession, "bbbb", 2);
    await until(() => hostSession.remoteCheckpoints.has(1), "the guest's checkpoint 1");
    expect(hostSession.checkpointMismatch).toBeNull();
    pass(hostSession, "cccc", 2);
    expect(hostSession.checkpointMismatch).not.toBeNull();
    expect(hostSession.desyncMessage).toContain("checkpoint #1");
    await until(() => guestSession.checkpointMismatch !== null, "the guest noticing too");
  });
});
