/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Envelope, Seat } from "#coop/protocol";
import { FanoutTransport } from "#coop/transport/fanout";
import { createLoopbackRoom } from "#coop/transport/loopback";
import { ReliableTransport } from "#coop/transport/reliable";
import { RoutedHub } from "#coop/transport/routed";
import { describe, expect, it } from "vitest";

/**
 * The host's fan-out over its two guests (D40): what the host sends reaches both, or one; what a guest sends arrives with the
 * guest's seat, whatever the guest wrote; one guest's drop does not stop the other.
 */

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

function message(author: Seat, payload: number): Envelope {
  return { key: null, author, kind: "START", payload };
}

function roomOfThree() {
  const room = createLoopbackRoom(3);
  const hub = new RoutedHub(room.host, ["guest", "guest2"]);
  const channels = new Map<Seat, ReliableTransport>([
    ["guest", new ReliableTransport(hub.channel("guest"))],
    ["guest2", new ReliableTransport(hub.channel("guest2"))],
  ]);
  const host = new FanoutTransport(channels);
  const guest = new ReliableTransport(room.guests.get("guest")!);
  const guest2 = new ReliableTransport(room.guests.get("guest2")!);
  return { room, host, guest, guest2 };
}

function payloads(transport: { onMessage(listener: (message: Envelope) => void): unknown }): unknown[] {
  const seen: unknown[] = [];
  transport.onMessage(m => seen.push(m.payload));
  return seen;
}

describe("FanoutTransport (D40)", () => {
  it("sends to both guests, or to one", async () => {
    const { host, guest, guest2 } = roomOfThree();
    const atGuest = payloads(guest);
    const atGuest2 = payloads(guest2);
    host.send(message("host", 1));
    host.sendTo("guest2", message("host", 2));
    await settle();
    expect(atGuest).toEqual([1]);
    expect(atGuest2).toEqual([1, 2]);
  });

  it("stamps what a guest sends with that guest's seat, whatever the guest wrote", async () => {
    const { host, guest } = roomOfThree();
    const seen: Envelope[] = [];
    host.onMessage(m => seen.push(m));
    guest.send({ ...message("guest2", 3), from: "guest2" });
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ author: "guest2", from: "guest", payload: 3 });
  });

  it("keeps what arrives before anyone listens for the first listener", async () => {
    const { host, guest2 } = roomOfThree();
    guest2.send(message("guest2", 4));
    await settle();
    const seen: Envelope[] = [];
    host.onMessage(m => seen.push(m));
    expect(seen.map(m => [m.from, m.payload])).toEqual([["guest2", 4]]);
  });

  it("goes on with one guest when the other's connection drops", async () => {
    const { room, host, guest2 } = roomOfThree();
    const seen: unknown[] = [];
    host.onMessage(m => seen.push(m.payload));
    const atGuest2 = payloads(guest2);
    room.guests.get("guest")!.close();
    host.send(message("host", 5));
    guest2.send(message("guest2", 6));
    await settle();
    expect(atGuest2).toEqual([5]);
    expect(seen).toEqual([6]);
  });

  it("takes a returning guest's new channel: sending to them starts again, the old channel stays shut (D40)", async () => {
    const room = createLoopbackRoom(3);
    const hub = new RoutedHub(room.host, ["guest", "guest2"]);
    const host = new FanoutTransport(
      new Map<Seat, ReliableTransport>([
        ["guest", new ReliableTransport(hub.channel("guest"))],
        ["guest2", new ReliableTransport(hub.channel("guest2"))],
      ]),
    );
    const seen: Envelope[] = [];
    host.onMessage(m => seen.push(m));
    host.stopSending("guest");
    // the guest comes back on a new channel of its seat
    const returned = new ReliableTransport(hub.reopen("guest"));
    host.replace("guest", returned);
    host.resume("guest");
    const guestAgain = new ReliableTransport(room.guests.get("guest")!);
    const atGuest = payloads(guestAgain);
    host.send(message("host", 7));
    guestAgain.send(message("guest", 8));
    await settle();
    expect(atGuest).toEqual([7]);
    expect(seen.map(m => [m.from, m.payload])).toEqual([["guest", 8]]);
  });
});
