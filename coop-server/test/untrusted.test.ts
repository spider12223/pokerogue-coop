/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, it } from "vitest";
import { logField, normalizeIp, printable, requestUrl } from "../src/untrusted.ts";

/** What the relay takes from a client and must not take as it is (DECISIONS D23) */

describe("requestUrl", () => {
  it("reads a path that starts with // as a path, where `new URL(target, base)` throws or finds a host", () => {
    expect(requestUrl("//")?.pathname).toBe("//");
    expect(requestUrl("//:")?.pathname).toBe("//:");
    expect(requestUrl("///")?.pathname).toBe("///");
    expect(requestUrl("//evil.example/coop")?.pathname).toBe("//evil.example/coop");
    expect(requestUrl("/coop?role=host&code=AB%0A")?.searchParams.get("code")).toBe("AB\n");
    expect(requestUrl(undefined)?.pathname).toBe("/");
  });

  it("reads an absolute target, and is null for what is no URL", () => {
    expect(requestUrl("http://game.example/coop?role=host")?.pathname).toBe("/coop");
    for (const target of ["http://", "http://[", "*", ""]) {
      expect(requestUrl(target), target).toBeNull();
    }
  });
});

describe("normalizeIp", () => {
  it("keeps IPv4, and makes an IPv4-mapped address the IPv4 it is", () => {
    expect(normalizeIp("203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeIp("::FFFF:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIp("::ffff:cb00:7107")).toBe("203.0.113.7");
    expect(normalizeIp("0:0:0:0:0:ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("makes every address of one IPv6 /64 the same key, however it is written", () => {
    const key = "2001:db8:0:1::/64";
    for (const address of [
      "2001:db8:0:1::1",
      "2001:db8:0:1:ffff:ffff:ffff:ffff",
      "2001:0DB8:0000:0001:0000:0000:0000:0002",
      "[2001:db8:0:1::3]",
      "2001:db8:0:1::4%eth0",
      "2001:db8:0:1:abcd::1",
      "2001:db8:0:1::1.2.3.4",
    ]) {
      expect(normalizeIp(address), address).toBe(key);
    }
    expect(normalizeIp("2001:db8:0:2::1")).toBe("2001:db8:0:2::/64");
    expect(normalizeIp("::1")).toBe("0:0:0:0::/64");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("leaves what is not an address as it is, clipped", () => {
    expect(normalizeIp("unknown")).toBe("unknown");
    expect(normalizeIp("1:2:3")).toBe("1:2:3");
    expect(normalizeIp("1::2::3")).toBe("1::2::3");
    expect(normalizeIp("::ffff:1.2.3.400")).toBe("::ffff:1.2.3.400");
    expect(normalizeIp("x".repeat(500))).toHaveLength(64);
  });

  it("is the same twice", () => {
    for (const address of ["2001:db8:0:1::1", "::ffff:1.2.3.4", "8.8.8.8", "unknown"]) {
      expect(normalizeIp(normalizeIp(address))).toBe(normalizeIp(address));
    }
  });
});

describe("printable and logField", () => {
  it("keep one line: line breaks, escape sequences, C1 controls and direction overrides are written out", () => {
    expect(printable("a\nb\r\u001b[2J\u009b31m‮evil x\\", 100)).toBe(
      "a\\x0ab\\x0d\\x1b[2J\\x9b31m\\u{202e}evil\\u{2028}x\\\\",
    );
  });

  it("keep letters of any script, and clip", () => {
    expect(printable("Sébastien 🙂 ポケモン", 100)).toBe("Sébastien 🙂 ポケモン");
    expect(printable("x".repeat(100), 10)).toBe(`${"x".repeat(10)}...`);
  });

  it("logField writes out braces, so no line of the relay holds a JSON object", () => {
    expect(logField('{"src":"client"}')).toBe('\\x7b"src":"client"\\x7d');
    expect(logField("y".repeat(500))).toHaveLength(83);
  });
});
