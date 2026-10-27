/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describePhaseTraceDiff, diffPhaseTraces, formatPhaseTrace, PhaseTrace } from "#coop/phase-trace";
import { describe, expect, it } from "vitest";

function record(trace: PhaseTrace, phases: [name: string, rng: string][], wave = 1) {
  phases.forEach(([phaseName, rng], i) => {
    trace.record({ wave, turn: i, phaseName, rng });
  });
}

describe("PhaseTrace", () => {
  it("keeps the last `capacity` entries, oldest first, with their absolute index", () => {
    const trace = new PhaseTrace(3);
    record(trace, [
      ["A", "1"],
      ["B", "2"],
      ["C", "3"],
      ["D", "4"],
      ["E", "5"],
    ]);
    expect(trace.total).toBe(5);
    expect(trace.dump().map(e => [e.index, e.phaseName])).toEqual([
      [2, "C"],
      [3, "D"],
      [4, "E"],
    ]);
  });

  it("clears", () => {
    const trace = new PhaseTrace(2);
    record(trace, [["A", "1"]]);
    trace.clear();
    expect(trace.dump()).toEqual([]);
    expect(trace.record({ wave: 1, turn: 0, phaseName: "B", rng: "2" }).index).toBe(0);
  });

  it("needs a capacity", () => {
    expect(() => new PhaseTrace(0)).toThrow("capacity");
  });
});

describe("diffPhaseTraces", () => {
  const phases: [string, string][] = [
    ["EncounterPhase", "r0"],
    ["SummonPhase", "r1"],
    ["TurnInitPhase", "r2"],
    ["CommandPhase", "r3"],
    ["MovePhase", "r4"],
  ];

  it("is null when the traces agree", () => {
    const a = new PhaseTrace();
    const b = new PhaseTrace();
    record(a, phases);
    record(b, phases);
    expect(diffPhaseTraces(a.dump(), b.dump())).toBeNull();
  });

  it("finds the first phase start whose RNG differs, with the phases before it as context", () => {
    const a = new PhaseTrace();
    const b = new PhaseTrace();
    record(a, phases);
    record(b, [phases[0], phases[1], phases[2], ["CommandPhase", "rX"], ["MovePhase", "rY"]]);

    const diff = diffPhaseTraces(a.dump(), b.dump())!;
    expect(diff.index).toBe(3);
    expect(diff.fields).toEqual(["rng"]);
    expect(diff.local?.phaseName).toBe("CommandPhase");
    expect(diff.context.map(e => e.phaseName)).toEqual(["EncounterPhase", "SummonPhase", "TurnInitPhase"]);
    expect(describePhaseTraceDiff(diff)).toContain("phase start #3 differs (rng)");
  });

  it("finds a different phase order", () => {
    const a = new PhaseTrace();
    const b = new PhaseTrace();
    record(a, phases);
    record(b, [phases[0], ["MessagePhase", "r1"], phases[2], phases[3], phases[4]]);
    const diff = diffPhaseTraces(a.dump(), b.dump())!;
    expect(diff).toMatchObject({ index: 1, fields: ["phaseName"] });
  });

  it("reports a trace that stopped early", () => {
    const a = new PhaseTrace();
    const b = new PhaseTrace();
    record(a, phases);
    record(b, phases.slice(0, 3));
    expect(diffPhaseTraces(a.dump(), b.dump())).toMatchObject({ index: 3, remote: null, fields: ["length"] });
  });

  it("compares only the range both still hold after the buffers wrapped", () => {
    const a = new PhaseTrace(3);
    const b = new PhaseTrace(5);
    record(a, phases);
    record(b, phases);
    expect(diffPhaseTraces(a.dump(), b.dump())).toBeNull();
  });

  it("formats a dump", () => {
    const trace = new PhaseTrace();
    record(trace, [["A", "r"]]);
    expect(formatPhaseTrace(trace.dump())).toBe("#0 wave 1 turn 0 A rng r");
  });
});
