/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { logUrlFor, relayUrlFor } from "#coop/relay-url";
import { describe, expect, it } from "vitest";

/** The relay URL of the client (DECISIONS D22): the page's own origin, unless a build says otherwise */
describe("relayUrlFor", () => {
  it("is /coop of the origin the game came from: wss on https, ws on http", () => {
    expect(relayUrlFor(undefined, { protocol: "https:", host: "game.example.com" })).toBe(
      "wss://game.example.com/coop",
    );
    expect(relayUrlFor(undefined, { protocol: "http:", host: "localhost:8080" })).toBe("ws://localhost:8080/coop");
    expect(relayUrlFor("", { protocol: "https:", host: "game.example.com" })).toBe("wss://game.example.com/coop");
    expect(relayUrlFor("   ", { protocol: "http:", host: "192.168.1.5:8080" })).toBe("ws://192.168.1.5:8080/coop");
  });

  it("follows the one built into the client", () => {
    expect(relayUrlFor("wss://relay.example.org/coop", { protocol: "https:", host: "game.example.com" })).toBe(
      "wss://relay.example.org/coop",
    );
    expect(relayUrlFor(" ws://localhost:8787/coop ", { protocol: "http:", host: "localhost:8000" })).toBe(
      "ws://localhost:8787/coop",
    );
  });
});

/** Where the co-op log goes (DECISIONS D26): beside the relay, on the same server */
describe("logUrlFor", () => {
  it("is /log under the relay's path, over http(s)", () => {
    expect(logUrlFor("wss://game.example.com/coop")).toBe("https://game.example.com/coop/log");
    expect(logUrlFor("ws://127.0.0.1:8787/coop")).toBe("http://127.0.0.1:8787/coop/log");
    expect(logUrlFor("ws://localhost:8080/coop/")).toBe("http://localhost:8080/coop/log");
  });
});
