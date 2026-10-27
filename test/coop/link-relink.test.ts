/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  type CoopLink,
  createRoom,
  establishGuest,
  establishHost,
  HandshakeRefusedError,
  joinRoom,
  type RejoinedRoom,
  rejoinRoom,
} from "#coop/link";
import { type BuildIdentity, type DecisionKey, hashCanonical, type PinnedSettings } from "#coop/protocol";
import type { ResyncPayload } from "#coop/resync";
import { RelayError, type RelayWsTransport } from "#coop/transport/relay-ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RelayServer, startRelayServer } from "../../coop-server/src/relay-server.ts";

/**
 * The reconnecting link (DECISIONS D18, D20, D21) against the real relay: the partner leaves and comes back, a
 * connection drops, the session ends, and an epoch starts. Two clients in one Node process.
 */

const build: BuildIdentity = {
  protocolVersion: 4,
  gitSha: "a6995c571a092e762ea036589bb6f3a8fa4f5dbd",
  dirtyHash: "clean",
  buildMode: "development+bypass",
  overridesHash: "00000000000000",
};

const pinned: PinnedSettings = { battleStyle: 1, enableTutorials: false };
const overlay = { apply: (settings: PinnedSettings) => hashCanonical(settings), remove: () => undefined };

const turn = (n: number): DecisionKey => ({ wave: 2, turn: n, kind: "TURN_COMMANDS", ref: 0 });

async function until(condition: () => boolean, what: string, ms = 4000): Promise<void> {
  for (let i = 0; i < ms / 5; i++) {
    if (condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("CoopLink: the partner comes and goes (D20)", () => {
  let server: RelayServer;
  let url: string;
  const links: CoopLink[] = [];
  const reliable = { rtoMs: 40, tickMs: 10 };

  beforeEach(async () => {
    server = await startRelayServer({ port: 0, host: "127.0.0.1", holdMs: 800, sweepIntervalMs: 20 });
    url = `ws://127.0.0.1:${server.port}/coop`;
  });

  afterEach(async () => {
    for (const link of links.splice(0)) {
      link.close();
    }
    await server.close();
  });

  async function connect(
    guestAccountId = "7:8",
  ): Promise<{ host: CoopLink; guest: CoopLink; code: string; guestToken: string }> {
    const room = await createRoom(url, { reliable });
    const guestRoom = await joinRoom(url, room.identity.code, { reliable });
    await room.partner;
    const [host, guest] = await Promise.all([
      establishHost(room, build, pinned, { name: "Sam" }),
      establishGuest(guestRoom, build, overlay, { name: "Alex", accountId: guestAccountId }),
    ]);
    links.push(host.link, guest.link);
    return { host: host.link, guest: guest.link, code: room.identity.code, guestToken: guestRoom.identity.token };
  }

  /** What the guest's tab does when it is reloaded: a new connection with the old token, and the handshake again */
  async function reloadedGuest(code: string, token: string, accountId = "7:8"): Promise<CoopLink> {
    const room: RejoinedRoom = await rejoinRoom(url, { code, seat: "guest", token }, { reliable });
    await room.paired;
    const { link } = await establishGuest(room, build, overlay, { name: "Alex", accountId });
    links.push(link);
    return link;
  }

  const relayOf = (link: CoopLink): RelayWsTransport => (link as unknown as { relay: RelayWsTransport }).relay;

  it("tells the one who stays that the partner left, and that they are back; then both need a reload", async () => {
    const { host, guest, code, guestToken } = await connect();
    const ends: string[] = [];
    host.onEnd(end => ends.push(end));
    expect(host.partnerPresent).toBe(true);
    expect(host.needsResync).toBe(false);

    // the guest's tab dies
    guest.close();
    await until(() => !host.partnerPresent, "the host to see the guest leave");
    expect(ends).toEqual(["peerLeft"]);
    expect(server.registry.has(code)).toBe(true); // the room stays as long as the host does

    const again = await reloadedGuest(code, guestToken);
    await until(() => host.partnerPresent && host.needsResync, "the host to be told the guest is back");
    expect(host.refusal).toBeNull();
    expect(again.partnerName).toBe("Sam");
  });

  it("keeps the seat of the one who left for as long as the other stays", async () => {
    const { host, guest, code, guestToken } = await connect();
    guest.close();
    await until(() => !host.partnerPresent, "the host to see the guest leave");
    // far beyond the hold of 800 ms: the host is still there, so nothing expires
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(server.registry.isReserved(code, "guest")).toBe(true);
    const again = await reloadedGuest(code, guestToken);
    expect(again.seat).toBe("guest");
    // and when both are gone the clock runs for both
    host.close();
    again.close();
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(server.registry.has(code)).toBe(false);
  });

  it("starts the numbering again: what the old pairing had in flight does not reach the new one", async () => {
    const { host, guest, code, guestToken } = await connect();
    const onHost = host.sequencer.awaitDecision(turn(1));
    guest.sequencer.propose(turn(1), "before"); // sequenced and received in the old pairing
    expect((await onHost).payload).toBe("before");
    // the host sends something that the guest never gets: the guest is gone
    guest.close();
    await until(() => !host.partnerPresent, "the host to see the guest leave");
    expect(() => host.sequencer.propose(turn(2), "lost")).not.toThrow(); // sequenced for nobody
    const pendingBefore = host.pending;
    expect(pendingBefore).toBeGreaterThan(0);

    const again = await reloadedGuest(code, guestToken);
    await until(() => host.needsResync, "the host to need a resync");
    // the new pairing is clean: what the old one had in flight is gone, only the new handshake is acknowledged
    await until(() => host.pending === 0, "the new pairing to be acknowledged");

    // the host sequences a RESYNC (it takes the next seq), both begin epoch 1, and the next decision goes through
    const received: ResyncPayload[] = [];
    again.onResync(message => {
      if (!("stop" in message) || message.stop !== true) {
        received.push(message);
      }
    });
    const seq = host.sequencer.reserveSeq();
    const message: ResyncPayload = { epoch: 1, seq, wave: 2, reason: "rejoin", save: "{}" };
    host.sendResync(message);
    await until(() => received.length === 1, "the guest to get the RESYNC");
    expect(received[0]).toEqual(message);
    host.beginEpoch(1, seq + 1);
    again.beginEpoch(1, seq + 1);
    expect(host.needsResync).toBe(false);
    expect(host.epoch).toBe(1);
    expect(again.epoch).toBe(1);

    const hostNext = host.sequencer.awaitDecision(turn(1)); // the same key as in the old epoch: the wave is played again
    const guestNext = again.sequencer.awaitDecision(turn(1));
    host.sequencer.propose(turn(1), "after");
    expect(await hostNext).toMatchObject({ payload: "after", seq: seq + 1 });
    expect(await guestNext).toMatchObject({ payload: "after", seq: seq + 1 });
  });

  it("refuses a guest of another account when the host knows which one it had", async () => {
    const { host, code, guestToken } = await connect("7:8");
    const room = await rejoinRoom(url, { code, seat: "guest", token: guestToken }, { reliable });
    // the first guest's link is still alive here: take its seat with another account
    await room.paired;
    await expect(establishGuest(room, build, overlay, { name: "Mallory", accountId: "9:9" })).rejects.toBeInstanceOf(
      HandshakeRefusedError,
    );
    await until(() => host.refusal !== null, "the host to refuse");
    expect(host.refusal).toBe("mismatch");
  });

  it("gets the seat back by itself when its own connection drops", async () => {
    const { host, guest } = await connect();
    expect(guest.partnerPresent).toBe(true);
    // the guest's connection to the relay dies (a network blip): the tab is alive
    relayOf(guest).close(4999, "drop");
    await until(() => !guest.partnerPresent, "the guest to notice");
    // it takes its seat back, the relay pairs the two again, and both shake hands again
    await until(() => guest.partnerPresent && guest.needsResync, "the guest to be back", 6000);
    await until(() => host.partnerPresent && host.needsResync, "the host to be told", 6000);
  });

  it("ends the room at once when a player ends the session, and the seat tokens stop working", async () => {
    const { host, guest, code, guestToken } = await connect();
    const ends: string[] = [];
    host.onEnd(end => ends.push(end));
    guest.leave();
    await until(() => ends.includes("peerGone"), "the host to be told the session ended");
    expect(server.registry.has(code)).toBe(false);
    await expect(rejoinRoom(url, { code, seat: "guest", token: guestToken }, { reliable })).rejects.toBeInstanceOf(
      RelayError,
    );
  });
});
