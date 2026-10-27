/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, it } from "vitest";
import { CODE_ALPHABET, CODE_LENGTH } from "../src/relay-protocol.ts";
import { RoomRegistry } from "../src/room-registry.ts";

function registry(holdMs = 1000) {
  const clock = { now: 0 };
  const rooms = new RoomRegistry({ holdMs, now: () => clock.now });
  return { rooms, clock };
}

describe("RoomRegistry: rooms and seats", () => {
  it("creates rooms with 6-character codes from the unambiguous alphabet", () => {
    const { rooms } = registry();
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { code, token } = rooms.createRoom();
      expect(code).toHaveLength(CODE_LENGTH);
      expect([...code].every(c => CODE_ALPHABET.includes(c))).toBe(true);
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      codes.add(code);
    }
    expect(codes.size).toBe(200);
    expect(CODE_ALPHABET).not.toMatch(/[01OI]/);
  });

  it("never reuses a code that is still in use", () => {
    let calls = 0;
    // The first two codes the generator produces are identical; the registry must keep drawing.
    const rooms = new RoomRegistry({ random: () => (calls++ < 12 ? 0 : 0.5) });
    const first = rooms.createRoom().code;
    const second = rooms.createRoom().code;
    expect(first).toBe("AAAAAA");
    expect(second).not.toBe(first);
    expect(rooms.size).toBe(2);
  });

  it("gives the free guest seat to the first joiner and refuses the second", () => {
    const { rooms } = registry();
    const { code } = rooms.createRoom();
    const joined = rooms.join(code);
    expect(joined).toMatchObject({ seat: "guest" });
    expect(typeof joined === "object" && joined.token).toMatch(/^[0-9a-f]{32}$/);
    expect(rooms.join(code)).toBe("full");
    expect(rooms.join("NOPE23")).toBe("notFound");
    expect(rooms.isConnected(code, "host")).toBe(true);
    expect(rooms.isConnected(code, "guest")).toBe(true);
  });

  it("never hands out the host seat to a code-only join", () => {
    const { rooms } = registry();
    const { code } = rooms.createRoom();
    rooms.disconnect(code, "host");
    expect(rooms.join(code)).toMatchObject({ seat: "guest" });
    expect(rooms.join(code)).toBe("full");
  });
});

describe("RoomRegistry: seat tokens and hold", () => {
  it("lets a dropped seat come back with its token only", () => {
    const { rooms, clock } = registry(1000);
    const { code, token } = rooms.createRoom();
    rooms.disconnect(code, "host");
    expect(rooms.isConnected(code, "host")).toBe(false);
    expect(rooms.isHeld(code, "host")).toBe(true);
    clock.now = 400;
    expect(rooms.holdRemaining(code, "host")).toBe(600);

    expect(rooms.rejoin(code, "host", "0".repeat(32))).toBe("badToken");
    expect(rooms.rejoin(code, "host", "short")).toBe("badToken");
    expect(rooms.rejoin(code, "guest", token)).toBe("badToken"); // the host's token is not the guest's
    expect(rooms.rejoin("NOPE23", "host", token)).toBe("notFound");
    expect(rooms.rejoin(code, "host", token)).toEqual({ seat: "host", wasConnected: false });
    expect(rooms.isConnected(code, "host")).toBe(true);
    expect(rooms.holdRemaining(code, "host")).toBeNull();
  });

  it("lets a newer connection take over a seat that still looks connected", () => {
    const { rooms } = registry();
    const { code, token } = rooms.createRoom();
    expect(rooms.rejoin(code, "host", token)).toEqual({ seat: "host", wasConnected: true });
  });

  it("does not expire connected seats", () => {
    const { rooms, clock } = registry(1000);
    const { code } = rooms.createRoom();
    clock.now = 1_000_000;
    expect(rooms.sweep()).toEqual([]);
    expect(rooms.has(code)).toBe(true);
  });

  it("keeps a seat for as long as the partner stays: the clock only runs when both are gone (D20)", () => {
    const { rooms, clock } = registry(1000);
    const { code, token } = rooms.createRoom();
    const guest = rooms.join(code);
    const guestToken = typeof guest === "object" ? guest.token : "";
    rooms.disconnect(code, "guest");
    expect(rooms.isReserved(code, "guest")).toBe(true);
    expect(rooms.isHeld(code, "guest")).toBe(false);
    expect(rooms.holdRemaining(code, "guest")).toBeNull();

    clock.now = 1_000_000; // far beyond the hold: the host is still connected
    expect(rooms.sweep()).toEqual([]);
    expect(rooms.rejoin(code, "guest", guestToken)).toEqual({ seat: "guest", wasConnected: false });

    // the host goes away while the guest stays: the same for the host's seat, and the room stays
    rooms.disconnect(code, "host");
    clock.now = 2_000_000;
    expect(rooms.sweep()).toEqual([]);
    expect(rooms.has(code)).toBe(true);
    expect(rooms.rejoin(code, "host", token)).toEqual({ seat: "host", wasConnected: false });
  });

  it("starts the clock for both seats when the last one is gone, and frees them when it runs out", () => {
    const { rooms, clock } = registry(1000);
    const { code } = rooms.createRoom();
    const guest = rooms.join(code);
    const oldToken = typeof guest === "object" ? guest.token : "";
    rooms.disconnect(code, "guest"); // the host stays: no clock
    clock.now = 500;
    rooms.disconnect(code, "host"); // both gone: the clock runs for both from now
    expect(rooms.holdRemaining(code, "guest")).toBe(1000);
    expect(rooms.holdRemaining(code, "host")).toBe(1000);

    clock.now = 1499;
    expect(rooms.sweep()).toEqual([]);
    clock.now = 1500;
    expect(rooms.sweep()).toEqual([
      { type: "seatExpired", code, seat: "host" },
      { type: "seatExpired", code, seat: "guest" },
      { type: "roomClosed", code, reason: "hostGone" },
    ]);
    expect(rooms.has(code)).toBe(false);
    expect(rooms.rejoin(code, "guest", oldToken)).toBe("notFound");
  });

  it("makes the clock of the one who stayed away unlimited again when the other comes back", () => {
    const { rooms, clock } = registry(1000);
    const { code } = rooms.createRoom();
    const guest = rooms.join(code);
    const guestToken = typeof guest === "object" ? guest.token : "";
    rooms.disconnect(code, "guest");
    rooms.disconnect(code, "host");
    clock.now = 400;
    // the guest comes back: the host's seat is kept for as long as the guest stays
    rooms.rejoin(code, "guest", guestToken);
    expect(rooms.holdRemaining(code, "host")).toBeNull();
    clock.now = 5000;
    expect(rooms.sweep()).toEqual([]);
    expect(rooms.has(code)).toBe(true);
  });

  it("deletes a room at once when a player ends the session", () => {
    const { rooms } = registry(1000);
    const { code, token } = rooms.createRoom();
    rooms.join(code);
    rooms.leave(code);
    expect(rooms.has(code)).toBe(false);
    expect(rooms.rejoin(code, "host", token)).toBe("notFound");
  });

  it("restarts the hold on every disconnect", () => {
    const { rooms, clock } = registry(1000);
    const { code, token } = rooms.createRoom();
    rooms.disconnect(code, "host");
    clock.now = 900;
    rooms.rejoin(code, "host", token);
    rooms.disconnect(code, "host");
    clock.now = 1500; // 600 ms after the second drop
    expect(rooms.sweep()).toEqual([]);
    clock.now = 1900;
    expect(rooms.sweep().map(e => e.type)).toEqual(["seatExpired", "roomClosed"]);
  });
});

describe("RoomRegistry: idle rooms (D23)", () => {
  function idleRegistry(idleMs: number) {
    const clock = { now: 0 };
    const rooms = new RoomRegistry({ holdMs: 100_000, idleMs, now: () => clock.now });
    return { rooms, clock };
  }

  it("closes a room in which nothing happened for the idle time, whoever is connected", () => {
    const { rooms, clock } = idleRegistry(1000);
    const { code } = rooms.createRoom();
    rooms.join(code);
    clock.now = 999;
    expect(rooms.sweep()).toEqual([]);
    clock.now = 1000;
    expect(rooms.sweep()).toEqual([{ type: "roomClosed", code, reason: "idle" }]);
    expect(rooms.has(code)).toBe(false);
  });

  it("counts a game frame, a join, a rejoin and a disconnect as something happening", () => {
    const { rooms, clock } = idleRegistry(1000);
    const { code, token } = rooms.createRoom();
    clock.now = 600;
    rooms.join(code);
    clock.now = 1200; // 600 ms since the join
    expect(rooms.sweep()).toEqual([]);
    rooms.touch(code);
    clock.now = 2100;
    expect(rooms.sweep()).toEqual([]);
    rooms.disconnect(code, "host");
    clock.now = 2900;
    expect(rooms.sweep()).toEqual([]);
    rooms.rejoin(code, "host", token);
    clock.now = 3800;
    expect(rooms.sweep()).toEqual([]);
    clock.now = 3900;
    expect(rooms.sweep()).toEqual([{ type: "roomClosed", code, reason: "idle" }]);
  });

  it("never closes an idle room when no idle time is set", () => {
    const { rooms, clock } = registry();
    const { code } = rooms.createRoom();
    clock.now = 10 ** 12;
    expect(rooms.sweep()).toEqual([]);
    expect(rooms.has(code)).toBe(true);
  });

  it("ignores a touch of a room that is gone", () => {
    const { rooms } = idleRegistry(1000);
    expect(() => rooms.touch("NOROOM")).not.toThrow();
  });
});
