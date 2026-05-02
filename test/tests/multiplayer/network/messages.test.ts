import {
  COOP_PROTOCOL_VERSION,
  type DisconnectMessage,
  type Envelope,
  envelopeSchema,
  type HelloMessage,
  type PingMessage,
  type PongMessage,
  parseEnvelope,
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
