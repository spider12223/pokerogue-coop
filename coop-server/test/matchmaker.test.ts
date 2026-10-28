/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, it } from "vitest";
import { MatchQueue, type MatchSocket } from "../src/matchmaker.ts";
import { MATCH_PING, MATCH_PONG } from "../src/relay-protocol.ts";

/** A socket that keeps what it was sent, and how it was closed */
class FakeSocket implements MatchSocket {
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  send(text: string): void {
    this.sent.push(text);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  get messages(): string[] {
    return this.sent.filter(text => text !== MATCH_PONG).map(text => (JSON.parse(text) as { t: string }).t);
  }
}

describe("The matchmaking queue (D37)", () => {
  it("matches in the order players came, per build", () => {
    const queue = new MatchQueue();
    const [a, b, c, d] = [new FakeSocket(), new FakeSocket(), new FakeSocket(), new FakeSocket()];
    queue.join(a, "x");
    queue.join(b, "y");
    queue.join(c, "x");
    queue.join(d, "y");
    expect(a.messages).toEqual(["relay:queued", "relay:matchHost"]);
    expect(c.messages).toEqual(["relay:queued", "relay:matched"]);
    expect(b.messages).toEqual(["relay:queued", "relay:matchHost"]);
    expect(d.messages).toEqual(["relay:queued", "relay:matched"]);
  });

  it("passes a host's room code to its partner, then both leave the queue", () => {
    const queue = new MatchQueue();
    const [host, guest] = [new FakeSocket(), new FakeSocket()];
    queue.join(host, "x");
    queue.join(guest, "x");
    queue.message(host, JSON.stringify({ t: "match:code", code: "ABC234" }));
    expect(JSON.parse(guest.sent.at(-1)!)).toEqual({ t: "relay:matchGuest", code: "ABC234" });
    expect(host.closed?.code).toBe(1000);
    expect(guest.closed?.code).toBe(1000);
    expect(queue.size).toBe(0);
  });

  it("takes a code only from a matched host, and only a room code", () => {
    const queue = new MatchQueue();
    const [host, guest] = [new FakeSocket(), new FakeSocket()];
    queue.join(host, "x");
    queue.join(guest, "x");
    queue.message(guest, JSON.stringify({ t: "match:code", code: "ABC234" }));
    queue.message(host, JSON.stringify({ t: "match:code", code: "abc" }));
    queue.message(host, "not json");
    expect(guest.messages).toEqual(["relay:queued", "relay:matched"]);
    expect(queue.size).toBe(2);
  });

  it("answers a keepalive, and cuts off a player who keeps sending", () => {
    const queue = new MatchQueue();
    const socket = new FakeSocket();
    queue.join(socket, "x");
    queue.message(socket, MATCH_PING);
    expect(socket.sent.at(-1)).toBe(MATCH_PONG);
    for (let i = 0; i < 6; i++) {
      queue.message(socket, "{}");
    }
    expect(socket.closed?.code).toBe(1008);
  });

  it("refuses a player when the queue is full", () => {
    const queue = new MatchQueue(1);
    expect(queue.join(new FakeSocket(), "x")).toBe(true);
    expect(queue.join(new FakeSocket(), "y")).toBe(false);
  });

  it("puts a guest whose host left back in the queue, in its old place", () => {
    const queue = new MatchQueue();
    const [host, guest, next] = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
    queue.join(host, "x");
    queue.join(guest, "x");
    queue.left(host);
    expect(guest.messages.at(-1)).toBe("relay:matchLost");
    queue.join(next, "x");
    // the guest waited longer than the newcomer: it hosts now
    expect(guest.messages.at(-1)).toBe("relay:matchHost");
    expect(next.messages.at(-1)).toBe("relay:matched");
  });
});
