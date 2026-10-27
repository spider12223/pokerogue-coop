/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Checkpoint } from "#coop/checkpoint-log";
import type { PhaseTraceEntry } from "#coop/phase-trace";
import type { BuildIdentity, Seat } from "#coop/protocol";

/**
 * Resync (DECISIONS D13, D18, D20, D21): the messages, the strike count and the report. No game imports.
 *
 * The flow, for a desync: a client that sees two different hashes at the same checkpoint asks the host (`RESYNC_REQUEST`; the
 * host's own detection needs no message). At its next decision gate the host sequences a `RESYNC` that carries the current
 * wave's start save and the next epoch, and both clients reload from it. A rejoin and a resume use the same `RESYNC`.
 * The third desync of the same wave is not resynced: the host sends a `RESYNC` with `stop: true` and both clients show the
 * report.
 *
 * @module
 */

/**
 * Why the run is reloaded:
 * - `mismatch`: two checkpoints of the same index differ
 * - `desync`: a decision did not fit what the simulation was waiting for
 * - `rejoin`: a player came back (D20)
 * - `resume`: the host continued a saved run (D21)
 * - `retry`: the party was wiped and the host chose to play the wave again (D4a); not a desync strike
 */
export const RESYNC_REASONS = ["mismatch", "desync", "rejoin", "resume", "retry"] as const;
export type ResyncReason = (typeof RESYNC_REASONS)[number];

/** How many desyncs of the same wave the run survives: the third one stops it (D13) */
export const MAX_DESYNCS_PER_WAVE = 3;

/** How many phases of its trace a client puts in a report */
export const REPORT_TRACE_LENGTH = 300;

/** How many checkpoints of its log a client puts in a report */
export const REPORT_CHECKPOINT_LENGTH = 40;

/** The two checkpoints that differ, as the report names them */
export interface MismatchInfo {
  /** The index in the log of the current epoch */
  index: number;
  kind: string;
  wave: number;
  turn: number;
  phaseName: string;
  /** This client's hash and the partner's */
  local: string | null;
  remote: string | null;
}

/** `RESYNC_REQUEST`: the guest saw the clients disagree (D13). The host decides. */
export interface ResyncRequestPayload {
  reason: Extract<ResyncReason, "mismatch" | "desync">;
  /** The wave the guest was in */
  wave: number;
  mismatch: MismatchInfo | null;
}

/** `RESYNC`: both clients reload the wave start in this save (D13) */
export interface ResyncPayload {
  stop?: false;
  /** The epoch after the reload (D18) */
  epoch: number;
  /** The `seq` of this message; both clients carry on from `seq + 1` (D18) */
  seq: number;
  /** The wave whose start the save is */
  wave: number;
  reason: ResyncReason;
  /** The session save (D19), `JSON.stringify`d */
  save: string;
}

/** `RESYNC` with `stop`: the wave desynced for the third time; nobody reloads (D13) */
export interface ResyncStopPayload {
  stop: true;
  /** The next epoch, like any `RESYNC`: what the old one has in flight is dropped */
  epoch: number;
  seq: number;
  wave: number;
  mismatch: MismatchInfo | null;
  /** The host's phase trace, for the report */
  trace: PhaseTraceEntry[];
}

export type ResyncMessage = ResyncPayload | ResyncStopPayload;

/** `REPORT`: what a client adds to the other's report after a stop */
export interface ReportPayload {
  mismatch: MismatchInfo | null;
  trace: PhaseTraceEntry[];
  checkpoints: Checkpoint[];
}

const isInt = (value: unknown, min: number): value is number => Number.isInteger(value) && (value as number) >= min;

export function isMismatchInfo(value: unknown): value is MismatchInfo {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const info = value as Record<string, unknown>;
  return (
    isInt(info["index"], 0)
    && typeof info["kind"] === "string"
    && isInt(info["wave"], 0)
    && isInt(info["turn"], 0)
    && typeof info["phaseName"] === "string"
    && (info["local"] === null || typeof info["local"] === "string")
    && (info["remote"] === null || typeof info["remote"] === "string")
  );
}

function isTrace(value: unknown): value is PhaseTraceEntry[] {
  return (
    Array.isArray(value)
    && value.length <= REPORT_TRACE_LENGTH * 2
    && value.every(
      entry =>
        typeof entry === "object"
        && entry !== null
        && isInt((entry as Record<string, unknown>)["index"], 0)
        && isInt((entry as Record<string, unknown>)["wave"], 0)
        && isInt((entry as Record<string, unknown>)["turn"], 0)
        && typeof (entry as Record<string, unknown>)["phaseName"] === "string"
        && typeof (entry as Record<string, unknown>)["rng"] === "string",
    )
  );
}

function isCheckpointList(value: unknown): value is Checkpoint[] {
  return (
    Array.isArray(value)
    && value.length <= REPORT_CHECKPOINT_LENGTH * 2
    && value.every(
      entry =>
        typeof entry === "object"
        && entry !== null
        && isInt((entry as Record<string, unknown>)["index"], 0)
        && typeof (entry as Record<string, unknown>)["kind"] === "string"
        && typeof (entry as Record<string, unknown>)["hash"] === "string",
    )
  );
}

export function isResyncRequest(value: unknown): value is ResyncRequestPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const request = value as Record<string, unknown>;
  return (
    (request["reason"] === "mismatch" || request["reason"] === "desync")
    && isInt(request["wave"], 0)
    && (request["mismatch"] === null || isMismatchInfo(request["mismatch"]))
  );
}

export function isResyncMessage(value: unknown): value is ResyncMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value as Record<string, unknown>;
  // a stop also comes with a newer epoch: whatever the old one still has in flight is dropped
  if (!isInt(message["epoch"], 1) || !isInt(message["seq"], 1) || !isInt(message["wave"], 0)) {
    return false;
  }
  if (message["stop"] === true) {
    return (message["mismatch"] === null || isMismatchInfo(message["mismatch"])) && isTrace(message["trace"]);
  }
  return (
    (message["stop"] === undefined || message["stop"] === false)
    && (RESYNC_REASONS as readonly string[]).includes(message["reason"] as string)
    && typeof message["save"] === "string"
    && message["save"].length > 0
  );
}

export function isReportPayload(value: unknown): value is ReportPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const report = value as Record<string, unknown>;
  return (
    (report["mismatch"] === null || isMismatchInfo(report["mismatch"]))
    && isTrace(report["trace"])
    && isCheckpointList(report["checkpoints"])
  );
}

/** @returns Whether this message stops the run instead of reloading it */
export function isStop(message: ResyncMessage): message is ResyncStopPayload {
  return message.stop === true;
}

/**
 * The host's count of desyncs per wave (D13). The first and the second are resynced; the third stops the run, because a wave
 * that cannot be played the same way on both clients after two reloads will not be fixed by a third.
 */
export class ResyncBook {
  private readonly counts = new Map<number, number>();

  constructor(private readonly limit = MAX_DESYNCS_PER_WAVE) {}

  /**
   * A desync in this wave.
   * @returns `"resync"` to reload the wave, or `"stop"` if this was the last one allowed
   */
  desync(wave: number): "resync" | "stop" {
    const count = (this.counts.get(wave) ?? 0) + 1;
    this.counts.set(wave, count);
    return count >= this.limit ? "stop" : "resync";
  }

  /** @returns How many desyncs this wave has had */
  desyncsOf(wave: number): number {
    return this.counts.get(wave) ?? 0;
  }
}

/** What the player can save after a stop (D13): both phase traces and the two checkpoints that differ */
export interface CoopReport {
  version: 1;
  /** Who wrote it */
  seat: Seat;
  epoch: number;
  wave: number;
  build: BuildIdentity;
  names: Record<Seat, string>;
  /** The first checkpoint on which the clients differ, as this client saw it */
  mismatch: MismatchInfo | null;
  /** The last phases each client started; `null` if the partner's did not arrive */
  traces: Record<Seat, PhaseTraceEntry[] | null>;
  /** The checkpoints of the current epoch of each client, last ones; `null` if the partner's did not arrive */
  checkpoints: Record<Seat, Checkpoint[] | null>;
  /** The mismatch as the partner saw it, if it told */
  partnerMismatch: MismatchInfo | null;
}

/** Build the report of a stopped run from what this client has and what the partner sent (or `null`) */
export function buildReport(input: {
  seat: Seat;
  epoch: number;
  wave: number;
  build: BuildIdentity;
  names: Record<Seat, string>;
  mismatch: MismatchInfo | null;
  trace: readonly PhaseTraceEntry[];
  checkpoints: readonly Checkpoint[];
  partner: ReportPayload | null;
  partnerTrace?: readonly PhaseTraceEntry[] | null;
}): CoopReport {
  const mine = input.trace.slice(-REPORT_TRACE_LENGTH);
  const myCheckpoints = input.checkpoints.slice(-REPORT_CHECKPOINT_LENGTH);
  const partnerSeat: Seat = input.seat === "host" ? "guest" : "host";
  const theirs = input.partner?.trace ?? input.partnerTrace ?? null;
  const traces = { [input.seat]: mine, [partnerSeat]: theirs } as Record<Seat, PhaseTraceEntry[] | null>;
  const checkpoints = { [input.seat]: myCheckpoints, [partnerSeat]: input.partner?.checkpoints ?? null } as Record<
    Seat,
    Checkpoint[] | null
  >;
  return {
    version: 1,
    seat: input.seat,
    epoch: input.epoch,
    wave: input.wave,
    build: input.build,
    names: input.names,
    mismatch: input.mismatch,
    traces,
    checkpoints,
    partnerMismatch: input.partner?.mismatch ?? null,
  };
}
