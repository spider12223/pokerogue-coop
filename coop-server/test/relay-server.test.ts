/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Test structure (real `ws` clients against an in-process relay) adapted from SunghoLee98/pokerogue
 * `coop-server/test/relay-server.test.ts` (AGPL-3.0-only).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { RelayControlMessage } from "../src/relay-protocol.ts";
import { type RelayServer, startRelayServer } from "../src/relay-server.ts";

const HOLD_MS = 300;

type Control = RelayControlMessage;

/** A `ws` client that records what it receives and lets a test wait for specific messages. */
class TestClient {
  readonly socket: WebSocket;
  readonly received: string[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private cursor = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(url: string, options: { autoPong?: boolean } = {}) {
    this.socket = new WebSocket(url, options);
    this.socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        this.received.push(data.toString());
        for (const waiter of this.waiters.splice(0)) {
          waiter();
        }
      }
    });
    this.closed = new Promise(resolve => {
      this.socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    this.socket.on("error", () => {});
  }

  /** Wait for the next unread message, optionally the next one that satisfies `predicate` (others are skipped). */
  async next(predicate: (text: string) => boolean = () => true, timeoutMs = 3000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.cursor < this.received.length) {
        const text = this.received[this.cursor++]!;
        if (predicate(text)) {
          return text;
        }
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(`timed out; received so far: ${JSON.stringify(this.received)}`);
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Wait for the next relay control message of this type. */
  async control<T extends Control["t"]>(type: T, timeoutMs = 3000): Promise<Extract<Control, { t: T }>> {
    const text = await this.next(t => t.startsWith(`{"t":"${type}"`), timeoutMs);
    return JSON.parse(text) as Extract<Control, { t: T }>;
  }

  /** Assert that nothing (matching) arrives within `ms`. */
  async expectSilence(ms = 150, predicate: (text: string) => boolean = () => true): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
    const unread = this.received.slice(this.cursor).filter(predicate);
    expect(unread).toEqual([]);
  }

  async open(): Promise<this> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      await new Promise<void>((resolve, reject) => {
        this.socket.once("open", () => resolve());
        this.socket.once("error", reject);
        this.socket.once("close", () => resolve());
      });
    }
    return this;
  }

  send(text: string): void {
    this.socket.send(text);
  }

  close(): void {
    this.socket.close();
  }
}

describe("relay server", () => {
  let relay: RelayServer;
  let base: string;
  const clients: TestClient[] = [];

  const connect = (query: string, options?: { autoPong?: boolean }): Promise<TestClient> => {
    const client = new TestClient(`${base}/coop?${query}`, options);
    clients.push(client);
    return client.open();
  };

  /** A host and a guest in a paired room. */
  async function pairedRoom() {
    const host = await connect("role=host");
    const created = await host.control("relay:created");
    const guest = await connect(`code=${created.code}`);
    const joined = await guest.control("relay:joined");
    await host.control("relay:paired");
    await guest.control("relay:paired");
    return { host, guest, code: created.code, hostToken: created.token, guestToken: joined.token };
  }

  beforeEach(async () => {
    relay = await startRelayServer({
      port: 0,
      host: "127.0.0.1",
      holdMs: HOLD_MS,
      sweepIntervalMs: 20,
      heartbeatIntervalMs: 150,
    });
    base = `ws://127.0.0.1:${relay.port}`;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.socket.terminate();
    }
    await relay.close();
  });

  describe("create and join", () => {
    it("creates a room for the host with a code and a seat token", async () => {
      const host = await connect("role=host");
      const created = await host.control("relay:created");
      expect(created.code).toMatch(/^[A-Z2-9]{6}$/);
      expect(created.seat).toBe("host");
      expect(created.token).toMatch(/^[0-9a-f]{32}$/);
    });

    it("joins a guest by code and announces the pair to both", async () => {
      const { code, hostToken, guestToken } = await pairedRoom();
      expect(code).toMatch(/^[A-Z2-9]{6}$/);
      expect(guestToken).not.toBe(hostToken);
    });

    it("rejects an unknown code, a full room and a malformed request", async () => {
      const unknown = await connect("code=ZZZZZZ");
      expect(await unknown.control("relay:error")).toEqual({ t: "relay:error", reason: "notFound" });
      expect((await unknown.closed).code).toBe(4002);

      const { code } = await pairedRoom();
      const third = await connect(`code=${code}`);
      expect(await third.control("relay:error")).toEqual({ t: "relay:error", reason: "full" });

      const empty = await connect("");
      expect(await empty.control("relay:error")).toEqual({ t: "relay:error", reason: "badRequest" });
      const noToken = await connect(`code=${code}&seat=host`);
      expect(await noToken.control("relay:error")).toEqual({ t: "relay:error", reason: "badRequest" });
      const badSeat = await connect(`code=${code}&seat=spectator&token=abc`);
      expect(await badSeat.control("relay:error")).toEqual({ t: "relay:error", reason: "badRequest" });
    });
  });

  describe("rooms of three (D40)", () => {
    /** A host and two guests in a full room of three */
    async function roomOfThree() {
      const host = await connect("role=host&seats=3");
      const created = await host.control("relay:created");
      const guest = await connect(`code=${created.code}`);
      expect((await guest.control("relay:joined")).seat).toBe("guest");
      const guest2 = await connect(`code=${created.code}`);
      expect((await guest2.control("relay:joined")).seat).toBe("guest2");
      for (const client of [host, guest, guest2]) {
        await client.control("relay:paired");
      }
      return { host, guest, guest2, code: created.code };
    }

    it("takes two guests, announces the room complete only then, and refuses a fourth", async () => {
      const host = await connect("role=host&seats=3");
      const created = await host.control("relay:created");
      const guest = await connect(`code=${created.code}`);
      await guest.control("relay:joined");
      await host.expectSilence(150, text => text.includes("relay:paired"));
      const guest2 = await connect(`code=${created.code}`);
      await guest2.control("relay:joined");
      await host.control("relay:paired");
      const fourth = await connect(`code=${created.code}`);
      expect(await fourth.control("relay:error")).toEqual({ t: "relay:error", reason: "full" });
    });

    it("routes the host's frames to one guest, and stamps each guest's frames with its seat", async () => {
      const { host, guest, guest2 } = await roomOfThree();
      host.send('guest2\n{"n":1}');
      expect(await guest2.next()).toBe('{"n":1}');
      await guest.expectSilence(150);
      guest.send('{"n":2}');
      expect(await host.next()).toBe('guest\n{"n":2}');
      guest2.send('{"n":3}');
      expect(await host.next()).toBe('guest2\n{"n":3}');
      await guest.expectSilence(150);
    });

    it("drops a host frame without a route to a guest seat", async () => {
      const { host, guest, guest2 } = await roomOfThree();
      host.send('{"n":1}');
      host.send('host\n{"n":2}');
      host.send('guest3\n{"n":3}');
      await guest.expectSilence(150);
      await guest2.expectSilence(10);
    });

    it("keeps the room for the other two when a guest drops or ends its session", async () => {
      const { host, guest, guest2 } = await roomOfThree();
      guest.close();
      expect(await host.control("relay:peerLeft")).toEqual({ t: "relay:peerLeft", holdMs: null, seat: "guest" });
      expect(await guest2.control("relay:peerLeft")).toEqual({ t: "relay:peerLeft", holdMs: null, seat: "guest" });
      host.send('guest2\n{"n":1}');
      expect(await guest2.next()).toBe('{"n":1}');

      guest2.socket.close(4003);
      expect(await host.control("relay:peerGone")).toEqual({ t: "relay:peerGone", seat: "guest2" });
      host.send('guest2\n{"n":2}');
      await host.expectSilence(150, text => text.includes("relay:closed"));
    });

    it("closes the room for both guests when the host ends the session", async () => {
      const { host, guest, guest2 } = await roomOfThree();
      host.socket.close(4003);
      for (const client of [guest, guest2]) {
        expect(await client.control("relay:closed")).toEqual({ t: "relay:closed", reason: "partnerLeft" });
      }
    });

    it("leaves a room of two exactly as it was: frames unprefixed, no seat in its notices", async () => {
      const { host, guest } = await pairedRoom();
      host.send('{"n":1}');
      expect(await guest.next()).toBe('{"n":1}');
      guest.close();
      const left = await host.next(text => text.includes("relay:peerLeft"));
      expect(left).toBe('{"t":"relay:peerLeft","holdMs":null}');
    });
  });

  describe("relaying", () => {
    it("forwards text frames verbatim in both directions", async () => {
      const { host, guest } = await pairedRoom();
      const frame = JSON.stringify({ n: 1, b: { kind: "PROPOSE", note: "héllo ☃" } });
      host.send(frame);
      expect(await guest.next()).toBe(frame);
      guest.send('{"a":1}');
      expect(await host.next()).toBe('{"a":1}');
    });

    it("preserves the order of many frames", async () => {
      const { host, guest } = await pairedRoom();
      for (let i = 0; i < 200; i++) {
        host.send(`frame-${i}`);
      }
      for (let i = 0; i < 200; i++) {
        expect(await guest.next()).toBe(`frame-${i}`);
      }
    });

    it("never forwards a client frame that looks like a relay control message", async () => {
      const { host, guest } = await pairedRoom();
      guest.send(JSON.stringify({ t: "relay:peerGone" }));
      guest.send(JSON.stringify({ t: "relay:closed", reason: "hostGone" }));
      guest.send("marker");
      expect(await host.next()).toBe("marker");
    });

    it("drops binary frames", async () => {
      const { host, guest } = await pairedRoom();
      guest.socket.send(Buffer.from([1, 2, 3]));
      guest.send("after-binary");
      expect(await host.next()).toBe("after-binary");
    });

    it("drops frames while the partner is away instead of queueing them", async () => {
      const { host, guest, code, guestToken } = await pairedRoom();
      guest.close();
      await host.control("relay:peerLeft");
      host.send("while-away");
      const back = await connect(`code=${code}&seat=guest&token=${guestToken}`);
      await back.control("relay:rejoined");
      await back.expectSilence(120, text => !text.startsWith('{"t":"relay:'));
    });
  });

  describe("disconnect, hold and rejoin", () => {
    it("tells the partner that the seat is kept as long as they stay", async () => {
      const { host, guest } = await pairedRoom();
      guest.close();
      expect(await host.control("relay:peerLeft")).toEqual({ t: "relay:peerLeft", holdMs: null });
    });

    it("lets the dropped player rejoin with code + seat token and resume relaying", async () => {
      const { host, guest, code, guestToken } = await pairedRoom();
      guest.close();
      await host.control("relay:peerLeft");

      const back = await connect(`code=${code}&seat=guest&token=${guestToken}`);
      expect(await back.control("relay:rejoined")).toEqual({
        t: "relay:rejoined",
        code,
        seat: "guest",
        peerPresent: true,
      });
      await host.control("relay:peerBack");
      await host.control("relay:paired");
      await back.control("relay:paired");

      host.send("to-guest");
      expect(await back.next(text => !text.startsWith('{"t":"relay:'))).toBe("to-guest");
      back.send("to-host");
      expect(await host.next(text => !text.startsWith('{"t":"relay:'))).toBe("to-host");
    });

    it("lets the host rejoin too, and a lone rejoiner is told the partner is away, without a limit", async () => {
      const { host, guest, code, hostToken } = await pairedRoom();
      host.close();
      await guest.control("relay:peerLeft");
      guest.close();
      await new Promise(resolve => setTimeout(resolve, 30));

      const back = await connect(`code=${code}&seat=host&token=${hostToken}`);
      expect(await back.control("relay:rejoined")).toMatchObject({ seat: "host", peerPresent: false });
      expect(await back.control("relay:peerLeft")).toEqual({ t: "relay:peerLeft", holdMs: null });
    });

    it("tells the guest the host's seat is gone, then closes the room, when the host's hold runs out", async () => {
      const host = await connect("role=host");
      const created = await host.control("relay:created");
      host.close();
      await host.closed;
      const guest = await connect(`code=${created.code}`);
      await guest.control("relay:joined");
      expect(await guest.control("relay:peerLeft")).toEqual({ t: "relay:peerLeft", holdMs: null });
      const notices = [
        await guest.next(text => text.startsWith('{"t":"relay:peer') || text.startsWith('{"t":"relay:closed"'), 2000),
        await guest.next(text => text.startsWith('{"t":"relay:closed"'), 2000),
      ];
      expect(notices.map(text => JSON.parse(text))).toEqual([
        { t: "relay:peerGone" },
        { t: "relay:closed", reason: "hostGone" },
      ]);
    });

    it("refuses a wrong token and the other seat's token", async () => {
      const { guest, code, hostToken } = await pairedRoom();
      guest.close();
      await new Promise(resolve => setTimeout(resolve, 30));
      const wrong = await connect(`code=${code}&seat=guest&token=${"0".repeat(32)}`);
      expect(await wrong.control("relay:error")).toEqual({ t: "relay:error", reason: "badToken" });
      const swapped = await connect(`code=${code}&seat=guest&token=${hostToken}`);
      expect(await swapped.control("relay:error")).toEqual({ t: "relay:error", reason: "badToken" });
    });

    it("keeps the seat of the one who left for as long as the other stays, however long (D20)", async () => {
      const { host, guest, code, guestToken } = await pairedRoom();
      guest.close();
      await host.control("relay:peerLeft");
      // three times the hold: the host is still here, so the seat is not freed
      await new Promise(resolve => setTimeout(resolve, HOLD_MS * 3));
      await host.expectSilence(10, text => text.includes("peerGone"));

      const back = await connect(`code=${code}&seat=guest&token=${guestToken}`);
      expect(await back.control("relay:rejoined")).toMatchObject({ seat: "guest", peerPresent: true });
      await host.control("relay:peerBack");
      await host.control("relay:paired");
    });

    it("runs the clock only when both are gone: the seats expire, the old tokens are dead, the room is closed", async () => {
      const { host, guest, code, hostToken, guestToken } = await pairedRoom();
      host.close();
      await guest.control("relay:peerLeft");
      guest.close();
      await new Promise(resolve => setTimeout(resolve, HOLD_MS + 500));

      const lateHost = await connect(`code=${code}&seat=host&token=${hostToken}`);
      expect(await lateHost.control("relay:error")).toEqual({ t: "relay:error", reason: "notFound" });
      const lateGuest = await connect(`code=${code}&seat=guest&token=${guestToken}`);
      expect(await lateGuest.control("relay:error")).toEqual({ t: "relay:error", reason: "notFound" });
      const newcomer = await connect(`code=${code}`);
      expect(await newcomer.control("relay:error")).toEqual({ t: "relay:error", reason: "notFound" });
    });

    it("closes the room at once when a player ends the session, and tells the other", async () => {
      const { host, guest, code, hostToken } = await pairedRoom();
      guest.socket.close(4003, "leave");
      expect(await host.control("relay:closed")).toEqual({ t: "relay:closed", reason: "partnerLeft" });
      expect((await host.closed).code).toBe(4001);
      const late = await connect(`code=${code}&seat=host&token=${hostToken}`);
      expect(await late.control("relay:error")).toEqual({ t: "relay:error", reason: "notFound" });
    });

    it("lets a newer connection with the right token replace one the relay still thinks is alive", async () => {
      const { host, guest, code, guestToken } = await pairedRoom();
      const replacement = await connect(`code=${code}&seat=guest&token=${guestToken}`);
      await replacement.control("relay:rejoined");
      expect((await guest.closed).code).toBe(4000);
      await host.control("relay:peerBack");

      host.send("hello-new-connection");
      expect(await replacement.next(text => !text.startsWith('{"t":"relay:'))).toBe("hello-new-connection");
      // The replaced connection closing must not look like the player leaving.
      await host.expectSilence(120, text => text.includes("peerLeft"));
    });
  });

  describe("heartbeat", () => {
    it("drops a connection that stops answering pings and holds its seat", async () => {
      const host = await connect("role=host");
      const { code } = await host.control("relay:created");
      const mute = await connect(`code=${code}`, { autoPong: false });
      await mute.control("relay:joined");
      await host.control("relay:paired");
      // Two heartbeat intervals later the relay has given up on the silent client.
      expect(await host.control("relay:peerLeft", 3000)).toEqual({ t: "relay:peerLeft", holdMs: null });
    });

    it("keeps a connection that answers pings", async () => {
      const { host } = await pairedRoom();
      await host.expectSilence(500, text => text.includes("peerLeft"));
    });
  });

  it("closes a client that sends a frame larger than the limit", async () => {
    const small = await startRelayServer({ port: 0, host: "127.0.0.1", maxPayloadBytes: 256 });
    try {
      const client = new TestClient(`ws://127.0.0.1:${small.port}/coop?role=host`);
      clients.push(client);
      await client.open();
      await client.control("relay:created");
      client.send("x".repeat(1024));
      expect((await client.closed).code).toBe(1009);
    } finally {
      await small.close();
    }
  });
});
