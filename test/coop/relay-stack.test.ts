/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { guestHandshake, hostHandshake, type SettingsOverlayPort } from "#coop/handshake";
import { type BuildIdentity, DECISION_KINDS, type DecisionKey, hashCanonical, type Seat } from "#coop/protocol";
import { type Decision, Sequencer } from "#coop/sequencer";
import { findMatch, type MatchSearch } from "#coop/transport/match-ws";
import { RelayError, type RelayEvent, RelayWsTransport } from "#coop/transport/relay-ws";
import { ReliableTransport } from "#coop/transport/reliable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RelayServer, startRelayServer } from "../../coop-server/src/relay-server.ts";

/**
 * The whole transport stack against the real relay: `RelayWsTransport` (global WebSocket) -> `ReliableTransport` ->
 * handshake -> `Sequencer`, two clients in one process. This is also what keeps the client side of the relay protocol
 * (`src/coop/transport/relay-ws.ts`) in sync with the server (`coop-server/src/relay-protocol.ts`).
 */

const build: BuildIdentity = {
  protocolVersion: 1,
  gitSha: "a6995c571a092e762ea036589bb6f3a8fa4f5dbd",
  dirtyHash: "clean",
  buildMode: "development+bypass",
  overridesHash: "00000000000000",
};

const pinned = { battleStyle: 1, enableTutorials: false };

/** A guest overlay that just reports the pinned settings back. */
const overlay: SettingsOverlayPort = { apply: settings => hashCanonical(settings), remove: () => undefined };

const keyFor = (i: number): DecisionKey => ({
  wave: 1,
  turn: i,
  kind: DECISION_KINDS[i % DECISION_KINDS.length]!,
  ref: i % 2,
});

interface Client {
  seat: Seat;
  relay: RelayWsTransport;
  reliable: ReliableTransport;
  sequencer: Sequencer;
  events: RelayEvent[];
}

describe("co-op stack over the relay", () => {
  let server: RelayServer;
  let url: string;
  const open: Client[] = [];
  const extraTransports: RelayWsTransport[] = [];

  const reliableOptions = { rtoMs: 40, tickMs: 10 };

  function wire(seat: Seat, relay: RelayWsTransport): Client {
    const reliable = new ReliableTransport(relay, reliableOptions);
    const sequencer = new Sequencer({ role: seat, transport: reliable });
    const events: RelayEvent[] = [];
    relay.onRelayEvent(event => events.push(event));
    const client: Client = { seat, relay, reliable, sequencer, events };
    open.push(client);
    return client;
  }

  async function connectPair(): Promise<{ host: Client; guest: Client; code: string; guestToken: string }> {
    const hostRelay = RelayWsTransport.connect(url, { mode: "create" });
    const hostIdentity = await hostRelay.ready;
    const guestRelay = RelayWsTransport.connect(url, { mode: "join", code: hostIdentity.code });
    const guestIdentity = await guestRelay.ready;
    return {
      host: wire("host", hostRelay),
      guest: wire("guest", guestRelay),
      code: hostIdentity.code,
      guestToken: guestIdentity.token,
    };
  }

  /** What a simulation does at step `i`: expect, let the owner decide, wait for the sequenced decision. */
  async function step(client: Client, i: number, author: Seat): Promise<Decision> {
    const pending = client.sequencer.awaitDecision(keyFor(i));
    if (client.seat === author) {
      client.sequencer.propose(keyFor(i), i);
    }
    return await pending;
  }

  beforeEach(async () => {
    server = await startRelayServer({ port: 0, host: "127.0.0.1", holdMs: 3000, sweepIntervalMs: 50 });
    url = `ws://127.0.0.1:${server.port}/coop`;
  });

  afterEach(async () => {
    for (const client of open.splice(0)) {
      client.sequencer.close();
      client.reliable.close();
      client.relay.close();
    }
    for (const transport of extraTransports.splice(0)) {
      transport.close();
    }
    await server.close();
  });

  it("creates, joins, shakes hands and sequences decisions in both directions", async () => {
    const { host, guest } = await connectPair();
    const [a, b] = await Promise.all([
      hostHandshake(host.reliable, build, pinned),
      guestHandshake(guest.reliable, build, overlay),
    ]);
    expect(a.ok && b.ok).toBe(true);

    for (let i = 0; i < 60; i++) {
      const author: Seat = i % 2 === 0 ? "host" : "guest";
      const [onHost, onGuest] = await Promise.all([step(host, i, author), step(guest, i, author)]);
      expect(onHost).toEqual(onGuest);
      expect(onHost).toMatchObject({ seq: i + 1, author, payload: i });
    }
  });

  it("refuses a client built from another commit before any decision is sequenced", async () => {
    const { host, guest } = await connectPair();
    const [a, b] = await Promise.all([
      hostHandshake(host.reliable, build, pinned),
      guestHandshake(guest.reliable, { ...build, gitSha: "0000000" }, overlay),
    ]);
    for (const result of [a, b]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.mismatches.map(m => m.field)).toContain("gitSha");
      }
    }
  });

  it("survives a dropped connection: the guest rejoins with code + seat token and nothing is lost or repeated", async () => {
    const { host, guest, code, guestToken } = await connectPair();
    for (let i = 0; i < 10; i++) {
      const author: Seat = i % 2 === 0 ? "host" : "guest";
      await Promise.all([step(host, i, author), step(guest, i, author)]);
    }

    // The guest's connection dies. The host does not know yet and keeps deciding.
    guest.relay.close();
    await expect.poll(() => host.events.some(e => e.t === "relay:peerLeft")).toBe(true);
    expect(host.events.find(e => e.t === "relay:peerLeft")).toEqual({ t: "relay:peerLeft", holdMs: null });
    expect(guest.reliable.connected).toBe(false);

    const hostSteps: Promise<Decision>[] = [];
    for (let i = 10; i < 15; i++) {
      hostSteps.push(step(host, i, "host"));
    }
    await Promise.all(hostSteps);
    expect(host.reliable.pending).toBeGreaterThan(0); // sent into the void, waiting for the guest

    // The guest comes back with its seat token and picks up everything it missed.
    const back = RelayWsTransport.connect(url, { mode: "rejoin", code, seat: "guest", token: guestToken });
    extraTransports.push(back);
    expect(await back.ready).toMatchObject({ code, seat: "guest", token: guestToken, peerPresent: true });
    guest.reliable.attach(back);
    await expect.poll(() => host.events.some(e => e.t === "relay:peerBack")).toBe(true);

    const missed: Decision[] = [];
    for (let i = 10; i < 15; i++) {
      missed.push(await step(guest, i, "host"));
    }
    expect(missed.map(d => [d.seq, d.payload])).toEqual([
      [11, 10],
      [12, 11],
      [13, 12],
      [14, 13],
      [15, 14],
    ]);
    await expect.poll(() => host.reliable.pending).toBe(0);

    // And it keeps working in both directions.
    for (let i = 15; i < 25; i++) {
      const author: Seat = i % 2 === 0 ? "host" : "guest";
      const [onHost, onGuest] = await Promise.all([step(host, i, author), step(guest, i, author)]);
      expect(onHost).toEqual(onGuest);
    }
    expect(host.sequencer.desync).toBeNull();
    expect(guest.sequencer.desync).toBeNull();
    expect(guest.reliable.stats.duplicatesDropped + host.reliable.stats.duplicatesDropped).toBeGreaterThanOrEqual(0);
  }, 20_000);

  describe("matchmaking (D37)", () => {
    const searches: MatchSearch[] = [];
    const search = (build: string): MatchSearch => {
      const found = findMatch(url, build, { guestWaitMs: 2000 });
      searches.push(found);
      return found;
    };
    afterEach(() => {
      for (const found of searches.splice(0)) {
        found.cancel();
      }
    });
    const until = async (check: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !check(); i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(check()).toBe(true);
    };

    it("matches two players of a build: the first hosts a room, the second gets its code and joins it", async () => {
      const first = search("buildA");
      await until(() => server.stats().matching === 1);
      const second = search("buildA");
      const host = await first.found;
      expect(host.role).toBe("host");
      // the host makes its room as usual and sends the code
      const hostRelay = RelayWsTransport.connect(url, { mode: "create" });
      extraTransports.push(hostRelay);
      const { code } = await hostRelay.ready;
      if (host.role === "host") {
        host.sendCode(code);
      }
      const guest = await second.found;
      expect(guest).toEqual({ role: "guest", code });
      const guestRelay = RelayWsTransport.connect(url, { mode: "join", code });
      extraTransports.push(guestRelay);
      expect(await guestRelay.ready).toMatchObject({ code, seat: "guest" });
      // both left the queue
      await until(() => server.stats().matching === 0);
    });

    it("never matches players of different builds", async () => {
      const a = search("buildA");
      const b = search("buildB");
      await until(() => server.stats().matching === 2);
      const statuses: string[] = [];
      a.onStatus(status => statuses.push(`a:${status}`));
      b.onStatus(status => statuses.push(`b:${status}`));
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(statuses).toEqual([]);
      // a third player of the first build is matched with the first, who waited longer and hosts
      const c = search("buildA");
      expect((await a.found).role).toBe("host");
      expect(statuses).toContain("a:matched");
      c.cancel();
    });

    it("a host who leaves before its room is made puts the other back in the queue, in their place", async () => {
      const first = search("buildA");
      await until(() => server.stats().matching === 1);
      const second = search("buildA");
      const statuses: string[] = [];
      second.onStatus(status => statuses.push(status));
      await first.found;
      await until(() => statuses.includes("matched"));
      first.cancel();
      await until(() => statuses.at(-1) === "waiting");
      // the next player is matched with the one who was left: it waited longer, so it hosts now
      const third = search("buildA");
      expect((await second.found).role).toBe("host");
      third.cancel();
    });

    it("refuses a build it cannot read", async () => {
      const bad = search("not a build!");
      await expect(bad.found).rejects.toMatchObject({ name: "RelayError", reason: "badRequest" });
    });
  });

  it("reports why the relay refused", async () => {
    const unknown = RelayWsTransport.connect(url, { mode: "join", code: "ZZZZZZ" });
    extraTransports.push(unknown);
    await expect(unknown.ready).rejects.toMatchObject({ name: "RelayError", reason: "notFound" });

    const { code } = await connectPair();
    const badToken = RelayWsTransport.connect(url, { mode: "rejoin", code, seat: "guest", token: "0".repeat(32) });
    extraTransports.push(badToken);
    const error = await badToken.ready.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayError);
    expect((error as RelayError).reason).toBe("badToken");
  });
});
