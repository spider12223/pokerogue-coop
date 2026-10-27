/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Checkpoint } from "#coop/checkpoint-log";
import type { PhaseTraceEntry } from "#coop/phase-trace";
import type { BuildIdentity } from "#coop/protocol";
import {
  buildReport,
  isReportPayload,
  isResyncMessage,
  isResyncRequest,
  isStop,
  type MismatchInfo,
  REPORT_CHECKPOINT_LENGTH,
  REPORT_TRACE_LENGTH,
  ResyncBook,
  type ResyncPayload,
  type ResyncStopPayload,
} from "#coop/resync";
import { describe, expect, it } from "vitest";

const build: BuildIdentity = {
  protocolVersion: 4,
  gitSha: "a6995c571a092e762ea036589bb6f3a8fa4f5dbd",
  dirtyHash: "clean",
  buildMode: "development+bypass",
  overridesHash: "00000000000000",
};

const mismatch: MismatchInfo = {
  index: 4,
  kind: "turn",
  wave: 7,
  turn: 2,
  phaseName: "TurnInitPhase",
  local: "aaaaaaaaaaaaaa",
  remote: "bbbbbbbbbbbbbb",
};

const trace = (n: number): PhaseTraceEntry[] =>
  Array.from({ length: n }, (_, index) => ({ index, wave: 7, turn: 1, phaseName: "MovePhase", rng: "0".repeat(14) }));

const checkpoints = (n: number): Checkpoint[] =>
  Array.from({ length: n }, (_, index) => ({
    index,
    kind: "turn",
    wave: 7,
    turn: index,
    phaseName: "TurnInitPhase",
    hash: "c".repeat(14),
  }));

const resync: ResyncPayload = { epoch: 2, seq: 40, wave: 7, reason: "mismatch", save: '{"waveIndex":7}' };
const stop: ResyncStopPayload = { stop: true, epoch: 2, seq: 41, wave: 7, mismatch, trace: trace(5) };

describe("the desync count of a wave (D13)", () => {
  it("resyncs the first two desyncs of a wave and stops at the third", () => {
    const book = new ResyncBook();
    expect(book.desync(7)).toBe("resync");
    expect(book.desync(7)).toBe("resync");
    expect(book.desync(7)).toBe("stop");
    expect(book.desyncsOf(7)).toBe(3);
  });

  it("counts every wave on its own", () => {
    const book = new ResyncBook();
    book.desync(7);
    book.desync(7);
    expect(book.desync(8)).toBe("resync");
    expect(book.desync(8)).toBe("resync");
    expect(book.desync(7)).toBe("stop");
    expect(book.desync(8)).toBe("stop");
    expect(book.desyncsOf(9)).toBe(0);
  });
});

describe("what a RESYNC says", () => {
  it("accepts a reload and a stop", () => {
    expect(isResyncMessage(resync)).toBe(true);
    expect(isResyncMessage(stop)).toBe(true);
    expect(isStop(stop)).toBe(true);
    expect(isStop(resync)).toBe(false);
    expect(isResyncMessage({ ...stop, mismatch: null })).toBe(true);
  });

  it("refuses what does not fit", () => {
    for (const bad of [
      null,
      "resync",
      { ...resync, epoch: 0 }, // a reload goes to a later epoch than the first one
      { ...resync, epoch: 1.5 },
      { ...resync, seq: 0 },
      { ...resync, reason: "because" },
      { ...resync, save: "" },
      { ...resync, save: 5 },
      { ...resync, wave: -1 },
      { ...stop, trace: [{ index: "x" }] },
      { ...stop, mismatch: { index: 1 } },
    ]) {
      expect(isResyncMessage(bad), JSON.stringify(bad)?.slice(0, 80)).toBe(false);
    }
  });

  it("checks a request and a report", () => {
    expect(isResyncRequest({ reason: "mismatch", wave: 3, mismatch })).toBe(true);
    expect(isResyncRequest({ reason: "desync", wave: 3, mismatch: null })).toBe(true);
    expect(isResyncRequest({ reason: "rejoin", wave: 3, mismatch: null })).toBe(false); // the host decides those itself
    expect(isReportPayload({ mismatch, trace: trace(3), checkpoints: checkpoints(3) })).toBe(true);
    expect(isReportPayload({ mismatch, trace: "no", checkpoints: [] })).toBe(false);
    expect(isReportPayload({ mismatch, trace: trace(REPORT_TRACE_LENGTH * 2 + 1), checkpoints: [] })).toBe(false);
  });
});

describe("the report of a stopped run (D13)", () => {
  const input = {
    seat: "host" as const,
    epoch: 2,
    wave: 7,
    build,
    names: { host: "Sam", guest: "Alex" },
    mismatch,
    trace: trace(500),
    checkpoints: checkpoints(100),
  };

  it("has both phase traces and the two checkpoints that differ", () => {
    const guestTrace = trace(40);
    const report = buildReport({
      ...input,
      partner: {
        mismatch: { ...mismatch, local: mismatch.remote, remote: mismatch.local },
        trace: guestTrace,
        checkpoints: checkpoints(6),
      },
    });
    expect(report.seat).toBe("host");
    expect(report.mismatch).toEqual(mismatch);
    expect(report.partnerMismatch).toMatchObject({ local: mismatch.remote, remote: mismatch.local });
    expect(report.traces.host).toHaveLength(REPORT_TRACE_LENGTH);
    expect(report.traces.host?.at(-1)?.index).toBe(499); // the last ones
    expect(report.traces.guest).toEqual(guestTrace);
    expect(report.checkpoints.host).toHaveLength(REPORT_CHECKPOINT_LENGTH);
    expect(report.checkpoints.guest).toHaveLength(6);
  });

  it("is still a report when the partner's side did not arrive", () => {
    const report = buildReport({ ...input, seat: "guest", partner: null, partnerTrace: trace(9) });
    expect(report.traces.guest).toHaveLength(REPORT_TRACE_LENGTH);
    expect(report.traces.host).toHaveLength(9); // what the stop message itself carried
    expect(report.checkpoints.host).toBeNull();
    expect(report.partnerMismatch).toBeNull();
    // it is plain JSON: it can be written to a file
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
