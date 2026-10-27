/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  clientIp,
  DEFAULT_LIMITS,
  IpLimiter,
  ipTag,
  isPrivateAddress,
  originAllowed,
  type RelayLimits,
  TokenBucket,
} from "../src/limits.ts";

/** The per-IP limits of the relay (DECISIONS D23), with a clock the test moves */
function limiterWith(overrides: Partial<RelayLimits>) {
  let time = 1_000_000;
  const limiter = new IpLimiter({ ...DEFAULT_LIMITS, ...overrides }, () => time);
  return {
    limiter,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const fakeRequest = (headers: Record<string, string>, remoteAddress = "10.0.0.1"): IncomingMessage =>
  ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

describe("TokenBucket", () => {
  it("lets a burst through, then a steady rate", () => {
    const bucket = new TokenBucket(3, 1 / 1000, 0); // 3 at once, 1 per second
    expect([bucket.take(0), bucket.take(0), bucket.take(0), bucket.take(0)]).toEqual([true, true, true, false]);
    expect(bucket.take(500)).toBe(false);
    expect(bucket.take(1000)).toBe(true);
    expect(bucket.take(1001)).toBe(false);
    // a long pause refills it, up to the capacity and no further
    expect([bucket.take(100_000), bucket.take(100_000), bucket.take(100_000), bucket.take(100_000)]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});

describe("IpLimiter", () => {
  it("limits the sockets one IP holds, and frees them when they close", () => {
    const { limiter } = limiterWith({ maxConnectionsPerIp: 2, connectionsPerMinute: 100 });
    expect(limiter.admit("1.1.1.1")).toBe("ok");
    expect(limiter.admit("1.1.1.1")).toBe("ok");
    expect(limiter.admit("1.1.1.1")).toBe("tooManySockets");
    expect(limiter.admit("2.2.2.2")).toBe("ok"); // another IP is not affected
    limiter.release("1.1.1.1");
    expect(limiter.admit("1.1.1.1")).toBe("ok");
  });

  it("limits the connection attempts per minute, which makes guessing room codes pointless", () => {
    const { limiter, advance } = limiterWith({ maxConnectionsPerIp: 1000, connectionsPerMinute: 6 });
    const attempts: string[] = [];
    for (let i = 0; i < 8; i++) {
      attempts.push(limiter.admit("1.1.1.1"));
      limiter.release("1.1.1.1");
    }
    expect(attempts).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "tooManyAttempts", "tooManyAttempts"]);
    advance(10_000); // 6 per minute: one more token every 10 s
    expect(limiter.admit("1.1.1.1")).toBe("ok");
    expect(limiter.admit("1.1.1.1")).toBe("tooManyAttempts");
  });

  it("limits the rooms one IP creates per minute", () => {
    const { limiter, advance } = limiterWith({ roomsPerMinute: 2 });
    expect([limiter.allowRoom("1.1.1.1"), limiter.allowRoom("1.1.1.1"), limiter.allowRoom("1.1.1.1")]).toEqual([
      true,
      true,
      false,
    ]);
    expect(limiter.allowRoom("2.2.2.2")).toBe(true);
    advance(30_000);
    expect(limiter.allowRoom("1.1.1.1")).toBe(true);
  });

  it("limits the messages of an IP over all its sockets: a burst, then a steady rate", () => {
    const { limiter, advance } = limiterWith({ messagesPerSecond: 10, messageBurst: 5 });
    const results = Array.from({ length: 7 }, () => limiter.allowMessage("1.1.1.1"));
    expect(results).toEqual([true, true, true, true, true, false, false]);
    advance(200); // 10 per second: two more
    expect([limiter.allowMessage("1.1.1.1"), limiter.allowMessage("1.1.1.1"), limiter.allowMessage("1.1.1.1")]).toEqual(
      [true, true, false],
    );
  });

  it("limits the bytes of an IP over all its sockets; a message larger than the burst still passes when it is full", () => {
    const { limiter, advance } = limiterWith({ bytesPerSecond: 1000, byteBurst: 3000, messageBurst: 1000 });
    expect([limiter.allowMessage("1.1.1.1", 1000), limiter.allowMessage("1.1.1.1", 1500)]).toEqual([true, true]);
    expect(limiter.allowMessage("1.1.1.1", 1000)).toBe(false);
    expect(limiter.allowMessage("2.2.2.2", 1000)).toBe(true); // another IP is not affected
    advance(500); // 1000 per second: 500 more, 1000 in all
    expect(limiter.allowMessage("1.1.1.1", 1000)).toBe(true);
    advance(10_000);
    expect(limiter.allowMessage("1.1.1.1", 50_000)).toBe(true);
    expect(limiter.allowMessage("1.1.1.1", 1)).toBe(false);
  });

  it("forgets the IPs that are quiet again", () => {
    const { limiter, advance } = limiterWith({});
    limiter.admit("1.1.1.1");
    limiter.release("1.1.1.1");
    limiter.admit("2.2.2.2"); // still connected
    expect(limiter.trackedIps).toBe(2);
    advance(120_000);
    limiter.sweep();
    expect(limiter.trackedIps).toBe(1);
  });
});

describe("clientIp", () => {
  it("is the socket's address unless a proxy is trusted", () => {
    expect(clientIp(fakeRequest({ "x-forwarded-for": "9.9.9.9" }), 0)).toBe("10.0.0.1");
  });

  it("takes the entry the trusted proxy appended, not what the client claims to be", () => {
    const request = fakeRequest({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" });
    expect(clientIp(request, 1)).toBe("203.0.113.7");
    expect(clientIp(request, 2)).toBe("6.6.6.6");
    // more hops trusted than there are entries: the socket
    expect(clientIp(request, 3)).toBe("10.0.0.1");
    expect(clientIp(fakeRequest({}), 1)).toBe("10.0.0.1");
  });
});

describe("clientIp behind a proxy of the deploy (the default)", () => {
  it("knows a private network from the internet", () => {
    for (const address of [
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "10.1.2.3",
      "172.16.0.9",
      "172.31.255.1",
      "192.168.1.20",
      "169.254.1.1",
      "100.64.0.7",
      "fd12:3456::1",
      "fe80::1",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of [
      "8.8.8.8",
      "203.0.113.7",
      "172.32.0.1",
      "172.15.0.1",
      "100.128.0.1",
      "2001:db8::1",
      "11.0.0.1",
    ]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("takes the first address from the right that is not private, when the connection is a proxy's", () => {
    expect(clientIp(fakeRequest({ "x-forwarded-for": "203.0.113.7" }, "10.0.0.2"), "private")).toBe("203.0.113.7");
    expect(clientIp(fakeRequest({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }, "127.0.0.1"), "private")).toBe(
      "203.0.113.7",
    );
    // a platform with two hops of its own
    expect(clientIp(fakeRequest({ "x-forwarded-for": "198.51.100.4, 10.9.9.9" }, "172.17.0.1"), "private")).toBe(
      "198.51.100.4",
    );
  });

  it("counts an IPv6 client as its /64 and an IPv4-mapped one as its IPv4, wherever the address comes from", () => {
    const socket = (address: string) => clientIp(fakeRequest({}, address), 0);
    expect(socket("2001:db8:1:2::aaaa")).toBe(socket("2001:db8:1:2:ffff::1"));
    expect(socket("2001:db8:1:2::aaaa")).not.toBe(socket("2001:db8:1:3::aaaa"));
    expect(socket("::ffff:203.0.113.7")).toBe("203.0.113.7");
    const proxied = (forwarded: string) =>
      clientIp(fakeRequest({ "x-forwarded-for": forwarded }, "10.0.0.2"), "private");
    expect(proxied("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(proxied("2001:db8:1:2::1")).toBe(proxied("2001:db8:1:2:9::9"));
    expect(clientIp(fakeRequest({ "x-forwarded-for": "2001:db8:1:2::1" }), 1)).toBe("2001:db8:1:2::/64");
  });

  it("does not believe a header that comes straight from the internet", () => {
    expect(clientIp(fakeRequest({ "x-forwarded-for": "9.9.9.9" }, "203.0.113.50"), "private")).toBe("203.0.113.50");
  });

  it("is the socket without a header, and the first address on a network that is all private", () => {
    expect(clientIp(fakeRequest({}, "10.0.0.2"), "private")).toBe("10.0.0.2");
    expect(clientIp(fakeRequest({ "x-forwarded-for": "192.168.1.30" }, "192.168.1.1"), "private")).toBe("192.168.1.30");
  });
});

describe("originAllowed", () => {
  it("lets a client without an Origin through (a script, a test), and the page's own origin", () => {
    expect(originAllowed(undefined, "game.example.com", null)).toBe(true);
    expect(originAllowed("https://game.example.com", "game.example.com", null)).toBe(true);
    expect(originAllowed("http://localhost:8000", "localhost:8000", null)).toBe(true);
  });

  it("refuses another origin by default, and a malformed one", () => {
    expect(originAllowed("https://evil.example", "game.example.com", null)).toBe(false);
    expect(originAllowed("https://game.example.com:444", "game.example.com", null)).toBe(false);
    expect(originAllowed("not a url", "game.example.com", null)).toBe(false);
  });

  it("follows ALLOWED_ORIGINS when it is set", () => {
    const allowed = ["http://localhost:8000"];
    expect(originAllowed("http://localhost:8000", "localhost:8787", allowed)).toBe(true);
    expect(originAllowed("http://localhost:9000", "localhost:8787", allowed)).toBe(false);
    expect(originAllowed("https://anything.example", "localhost:8787", ["*"])).toBe(true);
  });
});

describe("ipTag", () => {
  it("stands in for the address in the logs without containing it", () => {
    const tag = ipTag("203.0.113.7");
    expect(tag).toMatch(/^[0-9a-f]{8}$/);
    expect(tag).toBe(ipTag("203.0.113.7"));
    expect(tag).not.toBe(ipTag("203.0.113.8"));
  });
});
