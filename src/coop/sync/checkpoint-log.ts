/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * The state-hash checkpoints a client passes (DECISIONS D13): the hash of the simulation state at a fixed moment of
 * the run, the same moment on both clients. No game imports: the log is plain data that the transport can carry and
 * that tests can compare in plain Node.
 *
 * @module
 */

/**
 * - `turn`: `TurnInitPhase.start`
 * - `waveStart`: after `resetSeed` in `EncounterPhase`
 * - `waveEnd`: the end of `BattleEndPhase.start`
 * - `rewards`: `SelectModifierPhase`, once the option list is generated and before it is shown (D9)
 */
export const CHECKPOINT_KINDS = ["turn", "waveStart", "waveEnd", "rewards"] as const;

export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

export interface Checkpoint {
  /** Position in the log of this client, from 0 */
  index: number;
  kind: CheckpointKind;
  /** `currentBattle.waveIndex` (a label: never a key) */
  wave: number;
  /** `currentBattle.turn` (a label: never a key) */
  turn: number;
  /** The phase that took the checkpoint, so a mismatch names where the clients diverged */
  phaseName: string;
  hash: string;
}

export class CheckpointLog {
  private readonly log: Checkpoint[] = [];

  public get entries(): readonly Checkpoint[] {
    return this.log;
  }

  public append(entry: Omit<Checkpoint, "index">): Checkpoint {
    const checkpoint: Checkpoint = { index: this.log.length, ...entry };
    this.log.push(checkpoint);
    return checkpoint;
  }

  public clear(): void {
    this.log.length = 0;
  }
}

export interface CheckpointMismatch {
  /** Position of the first checkpoint on which the logs differ */
  index: number;
  /** Absent if this log ended first */
  local: Checkpoint | null;
  /** Absent if the other log ended first */
  remote: Checkpoint | null;
  /** What differs: `length`, or the fields of the checkpoints */
  fields: string[];
}

/**
 * Compare two logs position by position.
 * @returns The first position on which they differ (kind, wave, turn, phase or hash, or one log is shorter), or `null`
 * if they are the same
 */
export function firstCheckpointMismatch(
  local: readonly Checkpoint[],
  remote: readonly Checkpoint[],
): CheckpointMismatch | null {
  const length = Math.max(local.length, remote.length);
  for (let index = 0; index < length; index++) {
    const a = local[index] ?? null;
    const b = remote[index] ?? null;
    if (a === null || b === null) {
      return { index, local: a, remote: b, fields: ["length"] };
    }
    const fields = (["kind", "wave", "turn", "phaseName", "hash"] as const).filter(field => a[field] !== b[field]);
    if (fields.length > 0) {
      return { index, local: a, remote: b, fields };
    }
  }
  return null;
}

/** @returns A one-line description of a checkpoint mismatch, naming the phase */
export function describeCheckpointMismatch(mismatch: CheckpointMismatch): string {
  const show = (c: Checkpoint | null): string =>
    c === null ? "(none)" : `${c.kind}@${c.phaseName} wave ${c.wave} turn ${c.turn} ${c.hash}`;
  return `checkpoint #${mismatch.index} differs (${mismatch.fields.join(", ")}): ${show(mismatch.local)} vs ${show(mismatch.remote)}`;
}
