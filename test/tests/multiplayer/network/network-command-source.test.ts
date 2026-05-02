import type { CoopSession } from "#app/multiplayer/network/coop-session";
import { COOP_DEFAULT_COMMAND_TIMEOUT_MS, NetworkCommandSource } from "#app/multiplayer/network/network-command-source";
import type { CommandPhase } from "#phases/command-phase";
import { describe, expect, it } from "vitest";

describe("NetworkCommandSource (skeleton)", () => {
  const fakeSession = {} as unknown as CoopSession;

  it("exposes kind === 'network'", () => {
    const source = new NetworkCommandSource(1, fakeSession);
    expect(source.kind).toBe("network");
  });

  it("exposes the playerSlot passed to the constructor", () => {
    const source = new NetworkCommandSource(1, fakeSession);
    expect(source.playerSlot).toBe(1);
  });

  it("exports a default command-timeout constant of 60_000ms", () => {
    expect(COOP_DEFAULT_COMMAND_TIMEOUT_MS).toBe(60_000);
  });

  it("constructor accepts no opts and does not throw", () => {
    expect(() => new NetworkCommandSource(1, fakeSession)).not.toThrow();
  });

  it("constructor accepts a custom timeoutMs option", () => {
    expect(() => new NetworkCommandSource(1, fakeSession, { timeoutMs: 30_000 })).not.toThrow();
  });

  it("constructor accepts a botFillJoiner option", () => {
    expect(() => new NetworkCommandSource(1, fakeSession, { botFillJoiner: true })).not.toThrow();
  });

  it("requestCommand does not throw when called with a phase argument", () => {
    const source = new NetworkCommandSource(1, fakeSession);
    const fakePhase = {} as unknown as CommandPhase;
    expect(() => source.requestCommand(fakePhase)).not.toThrow();
  });

  it("cancelPending does not throw when nothing is pending", () => {
    const source = new NetworkCommandSource(1, fakeSession);
    expect(() => source.cancelPending()).not.toThrow();
  });
});
