/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createLoopbackRoom } from "#coop/transport/loopback";
import { RoutedHub } from "#coop/transport/routed";
import type { CloseInfo, RawTransport } from "#coop/transport/transport";
import { describe, expect, it } from "vitest";

/**
 * The host's side of a room of three (D40): one channel per guest over the relay's one connection. The relay routes the host's
 * frames by the guest named in front and names the guest in front of what it sends the host.
 */

const settle = () => new Promise(resolve => setTimeout(resolve, 5));

function received(raw: RawTransport): string[] {
  const frames: string[] = [];
  raw.onFrame(frame => frames.push(frame));
  return frames;
}

/** A relay connection the test feeds by hand */
class FakeRelay implements RawTransport {
  readonly sent: string[] = [];
  private readonly listeners = new Set<(frame: string) => void>();
  readonly isOpen = true;
  send(frame: string): void {
    this.sent.push(frame);
  }
  onFrame(listener: (frame: string) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onClose(_listener: (info: CloseInfo) => void) {
    return () => {};
  }
  close(): void {}
  deliver(frame: string): void {
    for (const listener of this.listeners) {
      listener(frame);
    }
  }
}

describe("RoutedHub (D40)", () => {
  it("sends on a guest's channel to that guest only", async () => {
    const room = createLoopbackRoom(3);
    const hub = new RoutedHub(room.host, ["guest", "guest2"]);
    const atGuest = received(room.guests.get("guest")!);
    const atGuest2 = received(room.guests.get("guest2")!);
    hub.channel("guest2").send("to guest2");
    hub.channel("guest").send("to guest");
    await settle();
    expect(atGuest2).toEqual(["to guest2"]);
    expect(atGuest).toEqual(["to guest"]);
  });

  it("hands a guest's frame to that guest's channel only", async () => {
    const room = createLoopbackRoom(3);
    const hub = new RoutedHub(room.host, ["guest", "guest2"]);
    const onGuest = received(hub.channel("guest"));
    const onGuest2 = received(hub.channel("guest2"));
    room.guests.get("guest2")!.send("from guest2");
    await settle();
    expect(onGuest2).toEqual(["from guest2"]);
    expect(onGuest).toEqual([]);
  });

  it("drops what names no guest of the room", () => {
    const relay = new FakeRelay();
    const hub = new RoutedHub(relay, ["guest", "guest2"]);
    const onGuest = received(hub.channel("guest"));
    relay.deliver("no route");
    relay.deliver(`host\n{"n":1}`);
    relay.deliver(`guest3\n{"n":2}`);
    relay.deliver(`guest\n{"n":3}`);
    expect(onGuest).toEqual([`{"n":3}`]);
    hub.channel("guest").send("x");
    expect(relay.sent).toEqual(["guest\nx"]);
  });

  it("closes one guest's channel without closing the relay connection", () => {
    const relay = new FakeRelay();
    const hub = new RoutedHub(relay, ["guest", "guest2"]);
    const closed: string[] = [];
    hub.channel("guest").onClose(() => closed.push("guest"));
    hub.channel("guest").close();
    expect(closed).toEqual(["guest"]);
    expect(hub.channel("guest").isOpen).toBe(false);
    expect(hub.channel("guest2").isOpen).toBe(true);
  });
});
