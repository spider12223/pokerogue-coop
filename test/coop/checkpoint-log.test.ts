/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  type Checkpoint,
  CheckpointLog,
  describeCheckpointMismatch,
  firstCheckpointMismatch,
} from "#coop/checkpoint-log";
import { describe, expect, it } from "vitest";

function logOf(...hashes: string[]): readonly Checkpoint[] {
  const log = new CheckpointLog();
  hashes.forEach((hash, i) => {
    log.append({
      kind: i === 0 ? "waveStart" : "turn",
      wave: 1,
      turn: i,
      phaseName: i === 0 ? "EncounterPhase" : "TurnInitPhase",
      hash,
    });
  });
  return log.entries;
}

describe("CheckpointLog", () => {
  it("numbers its entries from 0", () => {
    expect(logOf("a", "b", "c").map(c => c.index)).toEqual([0, 1, 2]);
  });

  it("clears", () => {
    const log = new CheckpointLog();
    log.append({ kind: "turn", wave: 1, turn: 1, phaseName: "TurnInitPhase", hash: "a" });
    log.clear();
    expect(log.entries).toEqual([]);
    expect(log.append({ kind: "turn", wave: 1, turn: 1, phaseName: "TurnInitPhase", hash: "a" }).index).toBe(0);
  });
});

describe("firstCheckpointMismatch", () => {
  it("is null for equal logs", () => {
    expect(firstCheckpointMismatch(logOf("a", "b"), logOf("a", "b"))).toBeNull();
    expect(firstCheckpointMismatch([], [])).toBeNull();
  });

  it("names the first checkpoint that differs and the phase that took it", () => {
    const mismatch = firstCheckpointMismatch(logOf("a", "b", "c"), logOf("a", "x", "y"))!;
    expect(mismatch.index).toBe(1);
    expect(mismatch.fields).toEqual(["hash"]);
    expect(mismatch.local?.phaseName).toBe("TurnInitPhase");
    expect(describeCheckpointMismatch(mismatch)).toContain("checkpoint #1 differs (hash)");
    expect(describeCheckpointMismatch(mismatch)).toContain("TurnInitPhase");
  });

  it("reports a log that ends early", () => {
    const mismatch = firstCheckpointMismatch(logOf("a", "b"), logOf("a"))!;
    expect(mismatch).toMatchObject({ index: 1, remote: null, fields: ["length"] });
    expect(describeCheckpointMismatch(mismatch)).toContain("(none)");
  });

  it("also compares the labels, not only the hash", () => {
    const other = new CheckpointLog();
    other.append({ kind: "waveStart", wave: 2, turn: 0, phaseName: "EncounterPhase", hash: "a" });
    expect(firstCheckpointMismatch(logOf("a"), other.entries)?.fields).toEqual(["wave"]);
  });
});
