import {
  type CancelCommandRequestMessage,
  type ChooseCommandMessage,
  COOP_PROTOCOL_VERSION,
  type DisconnectMessage,
  type Envelope,
  envelopeSchema,
  type HelloMessage,
  type PingMessage,
  type PongMessage,
  parseEnvelope,
  type RequestCommandMessage,
  type StartRunMessage,
  type StateSnapshotMessage,
} from "#app/multiplayer/network/messages";
import { describe, expect, it } from "vitest";

describe("network messages", () => {
  describe("envelopeSchema round-trips", () => {
    it("parses a hello message", () => {
      const msg: HelloMessage = { type: "hello", version: COOP_PROTOCOL_VERSION, role: "host" };
      const result = envelopeSchema.safeParse(msg);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(msg);
      }
    });

    it("parses a ping message", () => {
      const msg: PingMessage = { type: "ping", nonce: 42 };
      const result = envelopeSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("parses a pong message", () => {
      const msg: PongMessage = { type: "pong", nonce: 42 };
      const result = envelopeSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("parses a disconnect message with reason", () => {
      const msg: DisconnectMessage = { type: "disconnect", reason: "user requested" };
      const result = envelopeSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("parses a disconnect message with null reason", () => {
      const msg: DisconnectMessage = { type: "disconnect", reason: null };
      const result = envelopeSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });
  });

  describe("envelopeSchema rejection", () => {
    it("rejects null", () => {
      expect(envelopeSchema.safeParse(null).success).toBe(false);
    });

    it("rejects an object missing type", () => {
      expect(envelopeSchema.safeParse({ version: "x", role: "host" }).success).toBe(false);
    });

    it("rejects an object with unknown type", () => {
      expect(envelopeSchema.safeParse({ type: "wave", reason: "hi" }).success).toBe(false);
    });

    it("rejects a hello message missing version", () => {
      expect(envelopeSchema.safeParse({ type: "hello", role: "host" }).success).toBe(false);
    });

    it("rejects a hello message with invalid role", () => {
      expect(envelopeSchema.safeParse({ type: "hello", version: "x", role: "spectator" }).success).toBe(false);
    });

    it("rejects a ping message with non-numeric nonce", () => {
      expect(envelopeSchema.safeParse({ type: "ping", nonce: "abc" }).success).toBe(false);
    });

    it("rejects a stringified payload", () => {
      expect(envelopeSchema.safeParse(JSON.stringify({ type: "hello" })).success).toBe(false);
    });
  });

  describe("parseEnvelope", () => {
    it("returns the parsed Envelope on success", () => {
      const msg: Envelope = { type: "ping", nonce: 7 };
      expect(parseEnvelope(msg)).toEqual(msg);
    });

    it("returns null on failure", () => {
      expect(parseEnvelope({ type: "garbage" })).toBeNull();
      expect(parseEnvelope(undefined)).toBeNull();
      expect(parseEnvelope(123)).toBeNull();
    });

    it("returns the typed Envelope variant when discriminator matches", () => {
      const helloRaw: unknown = { type: "hello", version: COOP_PROTOCOL_VERSION, role: "joiner" };
      const result = parseEnvelope(helloRaw);
      expect(result).not.toBeNull();
      if (result?.type === "hello") {
        expect(result.role).toBe("joiner");
      }
    });
  });
});

describe("M2c envelope types", () => {
  describe("round-trips", () => {
    it("parses a state-snapshot message", () => {
      const msg: StateSnapshotMessage = { type: "state-snapshot", turn: 3, payload: { foo: "bar" } };
      const result = envelopeSchema.safeParse(msg);
      expect(result.success).toBe(true);
      if (result.success && result.data.type === "state-snapshot") {
        expect(result.data.turn).toBe(3);
      }
    });

    it("parses a request-command message", () => {
      const msg: RequestCommandMessage = {
        type: "request-command",
        requestId: "req-abc",
        fieldIndex: 1,
        snapshotTurn: 2,
        allowedCommands: ["FIGHT", "RUN"],
        forcedKind: null,
      };
      const result = envelopeSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("parses a choose-command FIGHT message", () => {
      const msg: ChooseCommandMessage = {
        type: "choose-command",
        requestId: "req-abc",
        command: { kind: "FIGHT", moveIndex: 2, targets: [3] },
      };
      const result = envelopeSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("parses a choose-command RUN message", () => {
      const msg: ChooseCommandMessage = {
        type: "choose-command",
        requestId: "req-abc",
        command: { kind: "RUN" },
      };
      const result = envelopeSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("parses a choose-command CANCEL message", () => {
      const msg: ChooseCommandMessage = {
        type: "choose-command",
        requestId: "req-abc",
        command: { kind: "CANCEL" },
      };
      const result = envelopeSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("parses a cancel-command-request message with reason", () => {
      const msg: CancelCommandRequestMessage = {
        type: "cancel-command-request",
        requestId: "req-abc",
        reason: "host aborted",
      };
      const result = envelopeSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("parses a cancel-command-request message with null reason", () => {
      const msg: CancelCommandRequestMessage = {
        type: "cancel-command-request",
        requestId: "req-abc",
        reason: null,
      };
      const result = envelopeSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("parses a start-run message", () => {
      const msg: StartRunMessage = { type: "start-run", seed: "seed-xyz", startingWave: 1 };
      const result = envelopeSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });
  });

  describe("rejection", () => {
    it("rejects request-command with empty requestId", () => {
      const raw = {
        type: "request-command",
        requestId: "",
        fieldIndex: 1,
        snapshotTurn: 0,
        allowedCommands: ["FIGHT"],
        forcedKind: null,
      };
      expect(envelopeSchema.safeParse(raw).success).toBe(false);
    });

    it("rejects request-command with fieldIndex !== 1", () => {
      const raw = {
        type: "request-command",
        requestId: "req-abc",
        fieldIndex: 0,
        snapshotTurn: 0,
        allowedCommands: ["FIGHT"],
        forcedKind: null,
      };
      expect(envelopeSchema.safeParse(raw).success).toBe(false);
    });

    it("rejects request-command with empty allowedCommands array", () => {
      const raw = {
        type: "request-command",
        requestId: "req-abc",
        fieldIndex: 1,
        snapshotTurn: 0,
        allowedCommands: [],
        forcedKind: null,
      };
      expect(envelopeSchema.safeParse(raw).success).toBe(false);
    });

    it("rejects request-command with disallowed command in allowedCommands", () => {
      const raw = {
        type: "request-command",
        requestId: "req-abc",
        fieldIndex: 1,
        snapshotTurn: 0,
        allowedCommands: ["FIGHT", "POKEMON"],
        forcedKind: null,
      };
      expect(envelopeSchema.safeParse(raw).success).toBe(false);
    });

    it("rejects choose-command FIGHT with moveIndex out of range", () => {
      const raw = {
        type: "choose-command",
        requestId: "req-abc",
        command: { kind: "FIGHT", moveIndex: 4, targets: null },
      };
      expect(envelopeSchema.safeParse(raw).success).toBe(false);
    });

    it("rejects choose-command with unknown kind", () => {
      const raw = {
        type: "choose-command",
        requestId: "req-abc",
        command: { kind: "TERA", moveIndex: 0, targets: null },
      };
      expect(envelopeSchema.safeParse(raw).success).toBe(false);
    });

    it("rejects start-run with startingWave < 1", () => {
      const raw = { type: "start-run", seed: "seed-xyz", startingWave: 0 };
      expect(envelopeSchema.safeParse(raw).success).toBe(false);
    });

    it("rejects start-run with empty seed", () => {
      const raw = { type: "start-run", seed: "", startingWave: 1 };
      expect(envelopeSchema.safeParse(raw).success).toBe(false);
    });

    it("rejects state-snapshot with negative turn", () => {
      const raw = { type: "state-snapshot", turn: -1, payload: {} };
      expect(envelopeSchema.safeParse(raw).success).toBe(false);
    });
  });
});
