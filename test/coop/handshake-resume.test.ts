/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { guestHandshake, hostHandshake, type SettingsOverlayPort } from "#coop/handshake";
import { type BuildIdentity, hashCanonical, type PinnedSettings } from "#coop/protocol";
import { createLoopbackPair } from "#coop/transport/loopback";
import { ReliableTransport } from "#coop/transport/reliable";
import { describe, expect, it } from "vitest";

/**
 * The handshake of a resumed run (DECISIONS D1, D21): the host says it continues a saved run, the guest says which account it
 * is, and a guest of another account is refused.
 */

const build: BuildIdentity = {
  protocolVersion: 4,
  gitSha: "a6995c571a092e762ea036589bb6f3a8fa4f5dbd",
  dirtyHash: "clean",
  buildMode: "development+bypass",
  overridesHash: "00000000000000",
};

const pinned: PinnedSettings = { battleStyle: 1, enableTutorials: false, playerGender: 2 };
const overlay: SettingsOverlayPort = { apply: settings => hashCanonical(settings), remove: () => undefined };

function pair() {
  const [rawHost, rawGuest] = createLoopbackPair();
  return { host: new ReliableTransport(rawHost), guest: new ReliableTransport(rawGuest) };
}

describe("handshake of a resumed run (D21)", () => {
  it("tells the guest that the host continues a saved run, and gives the host the guest's account", async () => {
    const { host, guest } = pair();
    const [a, b] = await Promise.all([
      hostHandshake(host, build, pinned, { mode: "resume", expectedGuestAccountId: "7:8" }),
      guestHandshake(guest, build, overlay, { accountId: "7:8" }),
    ]);
    expect(a).toMatchObject({ ok: true, accountId: "7:8" });
    expect(b).toMatchObject({ ok: true, hello: { mode: "resume" } });
  });

  it("a new run is `new`, and the guest's account is reported either way", async () => {
    const { host, guest } = pair();
    const [a, b] = await Promise.all([
      hostHandshake(host, build, pinned),
      guestHandshake(guest, build, overlay, { accountId: "7:8" }),
    ]);
    expect(a).toMatchObject({ ok: true, accountId: "7:8" });
    expect(b).toMatchObject({ ok: true, hello: { mode: "new" } });
  });

  it("refuses a guest of another account, and names the field that differs", async () => {
    const { host, guest } = pair();
    const [a, b] = await Promise.all([
      hostHandshake(host, build, pinned, { mode: "resume", expectedGuestAccountId: "7:8" }),
      guestHandshake(guest, build, overlay, { accountId: "9:9" }),
    ]);
    expect(a).toEqual({
      ok: false,
      reason: "mismatch",
      mismatches: [{ field: "accountId", local: "7:8", remote: "9:9" }],
    });
    expect(b).toMatchObject({ ok: false, reason: "refused", mismatches: [{ field: "accountId" }] });
  });

  it("does not check the account of a new run", async () => {
    const { host, guest } = pair();
    const [a] = await Promise.all([
      hostHandshake(host, build, pinned),
      guestHandshake(guest, build, overlay, { accountId: "anything" }),
    ]);
    expect(a.ok).toBe(true);
  });
});
