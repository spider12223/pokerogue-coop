/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { fetchPlayersOnline, parsePlayersOnline, playersOnlineRelay } from "#coop/link/players-online";
import { onlineUrlFor } from "#coop/transport/relay-url";
import { describe, expect, it, vi } from "vitest";

const RELAY = "wss://relay.example.dev/coop";

describe("Co-op: the title screen's players online (D46)", () => {
  it("asks the relay at /online under its path, over https for wss and http for ws", () => {
    expect(onlineUrlFor(RELAY)).toBe("https://relay.example.dev/coop/online");
    expect(onlineUrlFor("ws://127.0.0.1:8787/coop/")).toBe("http://127.0.0.1:8787/coop/online");
  });

  it("only a relay built into the website is asked: a self-hosted one (the Windows pack, Docker) has no count", () => {
    expect(playersOnlineRelay(RELAY)).toBe(RELAY);
    expect(playersOnlineRelay(` ${RELAY} `)).toBe(RELAY);
    expect(playersOnlineRelay("")).toBeNull();
    expect(playersOnlineRelay("  ")).toBeNull();
    expect(playersOnlineRelay(undefined)).toBeNull();
  });

  it("reads a whole number of players from the relay's answer, and nothing else", () => {
    expect(parsePlayersOnline({ players: 12 })).toBe(12);
    expect(parsePlayersOnline({ players: 0 })).toBe(0);
    for (const bad of [
      { players: -1 },
      { players: 1.5 },
      { players: "12" },
      { players: Number.NaN },
      {},
      null,
      "12",
      12,
      [],
    ]) {
      expect(parsePlayersOnline(bad)).toBeNull();
    }
  });

  it("gives the relay's count", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ players: 20 }));
    await expect(fetchPlayersOnline(RELAY, fetcher)).resolves.toBe(20);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://relay.example.dev/coop/online");
  });

  it("gives no count for a relay without one, an error page, a wrong answer or no answer at all", async () => {
    const answers: (() => Promise<Response>)[] = [
      async () => new Response("Not found", { status: 404 }),
      async () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
      async () => Response.json({ players: -3 }),
      async () => {
        throw new TypeError("offline");
      },
    ];
    for (const answer of answers) {
      await expect(fetchPlayersOnline(RELAY, vi.fn(answer))).resolves.toBeNull();
    }
  });
});
