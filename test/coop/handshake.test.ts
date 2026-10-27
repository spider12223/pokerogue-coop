/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { guestHandshake, hostHandshake, type SettingsOverlayPort } from "#coop/handshake";
import { type BuildIdentity, hashCanonical, type PinnedSettings } from "#coop/protocol";
import { createLoopbackPair } from "#coop/transport/loopback";
import { ReliableTransport } from "#coop/transport/reliable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createManualLink } from "./manual-link";

const build: BuildIdentity = {
  protocolVersion: 1,
  gitSha: "a6995c571a092e762ea036589bb6f3a8fa4f5dbd",
  dirtyHash: "clean",
  buildMode: "development+bypass",
  overridesHash: "00000000000000",
};

const pinned: PinnedSettings = { battleStyle: 1, enableTutorials: false, playerGender: 2 };

/** A guest's settings: the overlay writes into `effective`, `saved` is what would be persisted. */
function fakeOverlay(initial: PinnedSettings) {
  const saved = { ...initial };
  let effective: PinnedSettings = { ...initial };
  const calls: string[] = [];
  const port: SettingsOverlayPort = {
    apply(settings) {
      calls.push("apply");
      effective = { ...effective, ...settings };
      // like the real port: the hash of the pinned values as read back
      return hashCanonical(Object.fromEntries(Object.keys(settings).map(key => [key, effective[key]])));
    },
    remove() {
      calls.push("remove");
      effective = { ...saved };
    },
  };
  return { port, calls, saved, effective: () => effective };
}

function reliablePair() {
  const [rawHost, rawGuest] = createLoopbackPair();
  return { host: new ReliableTransport(rawHost), guest: new ReliableTransport(rawGuest) };
}

describe("asymmetric handshake (D1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds when the builds match: the guest runs with the host's pinned settings, nothing is saved", async () => {
    const { host, guest } = reliablePair();
    const overlay = fakeOverlay({ battleStyle: 0, enableTutorials: true, playerGender: 1, gameSpeed: 5 });
    const [a, b] = await Promise.all([
      hostHandshake(host, build, pinned),
      guestHandshake(guest, { ...build }, overlay.port),
    ]);
    expect(a).toEqual({ ok: true, remote: build, name: "Player", accountId: "" });
    expect(b).toEqual({
      ok: true,
      hello: { build, pinnedSettings: pinned, name: "Player", mode: "new" },
      effectiveSettingsHash: hashCanonical(pinned),
    });
    expect(overlay.effective()).toEqual({ ...overlay.saved, ...pinned });
    expect(overlay.saved).toEqual({ battleStyle: 0, enableTutorials: true, playerGender: 1, gameSpeed: 5 });
    expect(overlay.calls).toEqual(["apply"]);
  });

  it("carries the display names both ways, cleaned", async () => {
    const { host, guest } = reliablePair();
    const overlay = fakeOverlay({ battleStyle: 0, enableTutorials: true, playerGender: 1, gameSpeed: 5 });
    const [a, b] = await Promise.all([
      hostHandshake(host, build, pinned, { name: "  Sam\u0007  " }),
      guestHandshake(guest, { ...build }, overlay.port, { name: "A name that is far too long to show" }),
    ]);
    expect(a).toMatchObject({ ok: true, name: "A name that is f" });
    expect(b).toMatchObject({ ok: true, hello: { name: "Sam" } });
  });

  it.each([
    ["protocol version", { protocolVersion: 2 }, "protocolVersion"],
    ["git sha", { gitSha: "deadbeef" }, "gitSha"],
    ["dirty hash", { dirtyHash: "0123456789abcd" }, "dirtyHash"],
    ["build mode", { buildMode: "production" }, "buildMode"],
    ["overrides hash", { overridesHash: "11111111111111" }, "overridesHash"],
  ])(
    "refuses on both sides when the %s differs, and the guest never applies the overlay",
    async (_n, change, field) => {
      const { host, guest } = reliablePair();
      const overlay = fakeOverlay({ battleStyle: 0 });
      const [a, b] = await Promise.all([
        hostHandshake(host, build, pinned),
        guestHandshake(guest, { ...build, ...change }, overlay.port),
      ]);
      for (const result of [a, b]) {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(["mismatch", "refused"]).toContain(result.reason);
          expect(result.mismatches.map(m => m.field)).toContain(field);
        }
      }
      expect(overlay.calls).toEqual([]);
    },
  );

  it("refuses when the guest's effective settings are not what the host pinned", async () => {
    const { host, guest } = reliablePair();
    const overlay = fakeOverlay({ battleStyle: 0 });
    const lying: SettingsOverlayPort = { apply: () => "ffffffffffffff", remove: () => overlay.port.remove() };
    const [a, b] = await Promise.all([hostHandshake(host, build, pinned), guestHandshake(guest, build, lying)]);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok) {
      expect(a.reason).toBe("mismatch");
      expect(a.mismatches.map(m => m.field)).toEqual(["effectiveSettingsHash"]);
    }
    // the guest was refused after applying: the overlay is taken off again
    expect(overlay.calls).toEqual(["remove"]);
  });

  it("refuses when the overlay rejects the pinned settings, and takes it off", async () => {
    const { host, guest } = reliablePair();
    const calls: string[] = [];
    const rejecting: SettingsOverlayPort = {
      apply: () => {
        throw new Error("Unknown pinned setting: nonsense");
      },
      remove: () => {
        calls.push("remove");
      },
    };
    const [a, b] = await Promise.all([hostHandshake(host, build, pinned), guestHandshake(guest, build, rejecting)]);
    expect(a.ok).toBe(false);
    expect(b).toEqual({ ok: false, reason: "malformed", mismatches: [] });
    expect(calls).toEqual(["remove"]);
  });

  it("works when the host's HELLO arrived before the guest started listening", async () => {
    const { host, guest } = reliablePair();
    const overlay = fakeOverlay({ battleStyle: 0 });
    const early = hostHandshake(host, build, pinned); // sends HELLO, which the guest transport buffers
    await vi.advanceTimersByTimeAsync(20);
    const late = guestHandshake(guest, build, overlay.port);
    const [a, b] = await Promise.all([early, late]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("the host refuses an ACK that is not a HELLO_ACK payload", async () => {
    const link = createManualLink();
    const result = hostHandshake(link.host, build, pinned);
    link.host.receive({ key: null, author: "guest", kind: "HELLO_ACK", payload: { nonsense: true } });
    expect(await result).toEqual({ ok: false, reason: "malformed", mismatches: [] });
    expect(link.host.outbox.map(m => m.kind)).toEqual(["HELLO", "REFUSE"]);
  });

  it("the guest refuses a HELLO that is not a HELLO payload", async () => {
    const link = createManualLink();
    const overlay = fakeOverlay({});
    const result = guestHandshake(link.guest, build, overlay.port);
    link.guest.receive({ key: null, author: "host", kind: "HELLO", payload: { nonsense: true } });
    expect(await result).toEqual({ ok: false, reason: "malformed", mismatches: [] });
    expect(link.guest.outbox.map(m => m.kind)).toEqual(["REFUSE"]);
    expect(overlay.calls).toEqual([]);
  });

  it("the guest does not finish before the host's HELLO_OK", async () => {
    const link = createManualLink();
    const overlay = fakeOverlay({ battleStyle: 0 });
    let settled = false;
    const result = guestHandshake(link.guest, build, overlay.port).then(r => {
      settled = true;
      return r;
    });
    link.guest.receive({
      key: null,
      author: "host",
      kind: "HELLO",
      payload: { build, pinnedSettings: pinned, name: "Host", mode: "new" },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    expect(link.guest.outbox.map(m => m.kind)).toEqual(["HELLO_ACK"]);
    link.guest.receive({ key: null, author: "host", kind: "HELLO_OK", payload: null });
    expect((await result).ok).toBe(true);
  });

  it("gives up when the partner never answers, and the guest takes the overlay off", async () => {
    const link = createManualLink();
    const overlay = fakeOverlay({ battleStyle: 0 });
    const hostResult = hostHandshake(link.host, build, pinned, { timeoutMs: 1000 });
    const guestResult = guestHandshake(link.guest, build, overlay.port, { timeoutMs: 1000 });
    link.guest.receive({
      key: null,
      author: "host",
      kind: "HELLO",
      payload: { build, pinnedSettings: pinned, name: "Host", mode: "new" },
    });
    await vi.advanceTimersByTimeAsync(1001);
    expect(await hostResult).toEqual({ ok: false, reason: "timeout", mismatches: [] });
    expect(await guestResult).toEqual({ ok: false, reason: "timeout", mismatches: [] });
    expect(overlay.calls).toEqual(["apply", "remove"]);
  });
});
