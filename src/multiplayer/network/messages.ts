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

export const stateSnapshotSchema = z.object({
  type: z.literal("state-snapshot"),
  turn: z.number().int().min(0),
  payload: z.unknown(),
});

export const requestCommandSchema = z.object({
  type: z.literal("request-command"),
  requestId: z.string().min(1),
  fieldIndex: z.literal(1),
  snapshotTurn: z.number().int().min(0),
  allowedCommands: z.array(z.enum(["FIGHT", "RUN"])).min(1),
  forcedKind: z.enum(["CHECK_SWITCH", "SWITCH"]).nullable(),
});

export const chooseCommandSchema = z.object({
  type: z.literal("choose-command"),
  requestId: z.string().min(1),
  command: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("FIGHT"),
      moveIndex: z.number().int().min(0).max(3),
      targets: z.array(z.number().int()).nullable(),
    }),
    z.object({ kind: z.literal("RUN") }),
    z.object({ kind: z.literal("CANCEL") }),
  ]),
});

export const cancelCommandRequestSchema = z.object({
  type: z.literal("cancel-command-request"),
  requestId: z.string().min(1),
  reason: z.string().nullable(),
});

export const startRunSchema = z.object({
  type: z.literal("start-run"),
  seed: z.string().min(1),
  startingWave: z.number().int().min(1),
});

export const envelopeSchema = z.discriminatedUnion("type", [
  helloSchema,
  pingSchema,
  pongSchema,
  disconnectSchema,
  stateSnapshotSchema,
  requestCommandSchema,
  chooseCommandSchema,
  cancelCommandRequestSchema,
  startRunSchema,
]);

export type HelloMessage = z.infer<typeof helloSchema>;
export type PingMessage = z.infer<typeof pingSchema>;
export type PongMessage = z.infer<typeof pongSchema>;
export type DisconnectMessage = z.infer<typeof disconnectSchema>;
export type StateSnapshotMessage = z.infer<typeof stateSnapshotSchema>;
export type RequestCommandMessage = z.infer<typeof requestCommandSchema>;
export type ChooseCommandMessage = z.infer<typeof chooseCommandSchema>;
export type CancelCommandRequestMessage = z.infer<typeof cancelCommandRequestSchema>;
export type StartRunMessage = z.infer<typeof startRunSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;

export function parseEnvelope(raw: unknown): Envelope | null {
  const result = envelopeSchema.safeParse(raw);
  return result.success ? result.data : null;
}
