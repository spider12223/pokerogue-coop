/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, it } from "vitest";
import { type CountedRoom, countRoom, noteFilled, type StatsPoint } from "../src/stats.ts";

/** A sink that keeps what it was given, in place of a Workers Analytics Engine dataset */
function sink(): { points: StatsPoint[]; writeDataPoint(point: StatsPoint): void } {
  const points: StatsPoint[] = [];
  return { points, writeDataPoint: point => points.push(point) };
}

describe("The relay's room counter (D43)", () => {
  it("counts a room as its event and its size, and nothing else", () => {
    const stats = sink();
    countRoom(stats, "created", 3);
    countRoom(stats, "filled", 2);
    expect(stats.points).toEqual([
      { indexes: ["created"], blobs: ["created", "3"], doubles: [3] },
      { indexes: ["filled"], blobs: ["filled", "2"], doubles: [2] },
    ]);
  });

  it("counts nothing on a relay without the dataset (wrangler dev, a copy someone hosts)", () => {
    expect(() => countRoom(undefined, "created", 3)).not.toThrow();
  });

  it("a room of three is filled once its second guest takes a seat, and only the first time", () => {
    const room: CountedRoom = {
      size: 3,
      seats: { host: { token: "h" }, guest: { token: "g" }, guest2: { token: null } },
    };
    expect(noteFilled(room)).toBe(false);
    expect(room.filled).toBeUndefined();
    room.seats.guest2 = { token: "g2" };
    expect(noteFilled(room)).toBe(true);
    expect(room.filled).toBe(true);
    // a seat freed and taken again (a guest who was gone for good): the room was already counted
    room.seats.guest2 = { token: "g3" };
    expect(noteFilled(room)).toBe(false);
  });

  it("a room of two is filled by its guest; a room stored before D40 (no size) is a room of two", () => {
    expect(noteFilled({ size: 2, seats: { host: { token: "h" }, guest: { token: "g" } } })).toBe(true);
    expect(noteFilled({ seats: { host: { token: "h" }, guest: { token: "g" } } })).toBe(true);
    expect(noteFilled({ seats: { host: { token: "h" }, guest: { token: null } } })).toBe(false);
  });
});
