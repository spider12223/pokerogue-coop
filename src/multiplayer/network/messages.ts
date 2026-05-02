import { z } from "zod";

export const COOP_PROTOCOL_VERSION = "m2a-1";

export const helloSchema = z.object({
  type: z.literal("hello"),
  version: z.string(),
  role: z.enum(["host", "joiner"]),
});

export const pingSchema = z.object({
  type: z.literal("ping"),
  nonce: z.number(),
});

export const pongSchema = z.object({
  type: z.literal("pong"),
  nonce: z.number(),
});

export const disconnectSchema = z.object({
  type: z.literal("disconnect"),
  reason: z.string().nullable(),
});

export const envelopeSchema = z.discriminatedUnion("type", [helloSchema, pingSchema, pongSchema, disconnectSchema]);

export type HelloMessage = z.infer<typeof helloSchema>;
export type PingMessage = z.infer<typeof pingSchema>;
export type PongMessage = z.infer<typeof pongSchema>;
export type DisconnectMessage = z.infer<typeof disconnectSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;

export function parseEnvelope(raw: unknown): Envelope | null {
  const result = envelopeSchema.safeParse(raw);
  return result.success ? result.data : null;
}
