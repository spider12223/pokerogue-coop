/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { SettingsOverlayPort } from "#coop/handshake";
import type { BuildIdentity } from "#coop/protocol";
import { endCoopSession, getCoopSession, isCoop, requireCoopSession, startCoopSession } from "#coop/session";
import { afterEach, describe, expect, it, vi } from "vitest";

const build: BuildIdentity = {
  protocolVersion: 1,
  gitSha: "a6995c571a092e762ea036589bb6f3a8fa4f5dbd",
  dirtyHash: "clean",
  buildMode: "test",
  overridesHash: "00000000000000",
};

describe("CoopSession", () => {
  afterEach(() => {
    endCoopSession();
  });

  it("is null in solo play", () => {
    expect(isCoop()).toBe(false);
    expect(getCoopSession()).toBeNull();
    expect(() => requireCoopSession()).toThrow("No co-op session is active");
  });

  it("is the active session until it ends", () => {
    const session = startCoopSession({ seat: "host", runSeed: "abc", build });
    expect(isCoop()).toBe(true);
    expect(getCoopSession()).toBe(session);
    expect(requireCoopSession()).toBe(session);
    expect(session).toMatchObject({ seat: "host", isHost: true, runSeed: "abc", hasEnded: false });

    session.end();
    expect(isCoop()).toBe(false);
    expect(session.hasEnded).toBe(true);
  });

  it("does not allow two sessions at once", () => {
    startCoopSession({ seat: "host", runSeed: "abc", build });
    expect(() => startCoopSession({ seat: "guest", runSeed: "def", build })).toThrow("already active");
  });

  it("removes the settings overlay once when it ends, however often it is ended", () => {
    const overlay: SettingsOverlayPort = { apply: vi.fn(), remove: vi.fn() };
    const session = startCoopSession({ seat: "guest", runSeed: "abc", build, overlay });
    expect(session.isHost).toBe(false);

    endCoopSession();
    session.end();
    expect(overlay.remove).toHaveBeenCalledTimes(1);
  });

  it("an ended session does not end its successor", () => {
    const first = startCoopSession({ seat: "host", runSeed: "abc", build });
    first.end();
    const second = startCoopSession({ seat: "host", runSeed: "def", build });
    first.end();
    expect(getCoopSession()).toBe(second);
  });
});
