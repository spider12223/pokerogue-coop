/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Phase trace of a co-op session (DECISIONS D13; in a deployed build too): a ring buffer with one entry per phase
 * start, holding the wave, the turn, the phase and a hash of the RNG state at that moment. When two clients' state
 * hashes disagree, diffing their traces names the first phase after which they differ, which is where to look.
 *
 * No game imports. Taking entries is `tracePhaseStart` in `src/coop/checkpoints.ts`.
 *
 * @module
 */

export interface PhaseTraceEntry {
  /** Counts every phase start of this client, from 0, so entries of two clients line up even after the buffer wrapped */
  index: number;
  wave: number;
  turn: number;
  phaseName: string;
  /** Hash of `Phaser.Math.RND.state()` when the phase started */
  rng: string;
}

export const DEFAULT_TRACE_CAPACITY = 4096;

export class PhaseTrace {
  private readonly buffer: (PhaseTraceEntry | undefined)[];
  private count = 0;

  constructor(public readonly capacity = DEFAULT_TRACE_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("A phase trace needs a capacity of at least 1");
    }
    this.buffer = new Array(capacity);
  }

  /** How many phase starts were recorded in total (the buffer keeps the last {@linkcode capacity}) */
  public get total(): number {
    return this.count;
  }

  public record(entry: Omit<PhaseTraceEntry, "index">): PhaseTraceEntry {
    const recorded: PhaseTraceEntry = { index: this.count, ...entry };
    this.buffer[this.count % this.capacity] = recorded;
    this.count++;
    return recorded;
  }

  /** @returns The entries still in the buffer, oldest first */
  public dump(): PhaseTraceEntry[] {
    const first = Math.max(0, this.count - this.capacity);
    const out: PhaseTraceEntry[] = [];
    for (let i = first; i < this.count; i++) {
      out.push(this.buffer[i % this.capacity]!);
    }
    return out;
  }

  public clear(): void {
    this.buffer.fill(undefined);
    this.count = 0;
  }
}

export interface PhaseTraceDiff {
  /** The `index` of the first phase start on which the traces differ */
  index: number;
  local: PhaseTraceEntry | null;
  remote: PhaseTraceEntry | null;
  /** The entries before it that both traces agree on (the last few, oldest first), for context */
  context: PhaseTraceEntry[];
  /** `rng`, `phaseName`, `wave`, `turn`, or `length` if one trace stopped earlier */
  fields: string[];
}

/**
 * Compare two traces by phase-start index, over the range both still hold.
 * @param contextSize - How many agreeing entries before the difference to include
 * @returns The first difference, or `null` if the traces agree wherever both have an entry
 */
export function diffPhaseTraces(
  local: readonly PhaseTraceEntry[],
  remote: readonly PhaseTraceEntry[],
  contextSize = 3,
): PhaseTraceDiff | null {
  const byIndex = (entries: readonly PhaseTraceEntry[]) => new Map(entries.map(entry => [entry.index, entry]));
  const a = byIndex(local);
  const b = byIndex(remote);
  const first = Math.max(local[0]?.index ?? 0, remote[0]?.index ?? 0);
  const end = Math.max((local.at(-1)?.index ?? -1) + 1, (remote.at(-1)?.index ?? -1) + 1);
  const context: PhaseTraceEntry[] = [];
  for (let index = first; index < end; index++) {
    const x = a.get(index) ?? null;
    const y = b.get(index) ?? null;
    if (x === null || y === null) {
      return { index, local: x, remote: y, context, fields: ["length"] };
    }
    const fields = (["phaseName", "wave", "turn", "rng"] as const).filter(field => x[field] !== y[field]);
    if (fields.length > 0) {
      return { index, local: x, remote: y, context, fields };
    }
    context.push(x);
    if (context.length > contextSize) {
      context.shift();
    }
  }
  return null;
}

/** @returns A readable dump of trace entries, one line each */
export function formatPhaseTrace(entries: readonly PhaseTraceEntry[]): string {
  return entries.map(e => `#${e.index} wave ${e.wave} turn ${e.turn} ${e.phaseName} rng ${e.rng}`).join("\n");
}

/** @returns A readable description of a trace difference, naming the phase */
export function describePhaseTraceDiff(diff: PhaseTraceDiff): string {
  const lines = [`phase start #${diff.index} differs (${diff.fields.join(", ")})`];
  if (diff.context.length > 0) {
    lines.push("agreed up to:", formatPhaseTrace(diff.context));
  }
  lines.push("local:  " + (diff.local ? formatPhaseTrace([diff.local]) : "(none)"));
  lines.push("remote: " + (diff.remote ? formatPhaseTrace([diff.remote]) : "(none)"));
  return lines.join("\n");
}
