/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  CHECKPOINT_KINDS,
  type Checkpoint,
  type CheckpointKind,
  describeCheckpointMismatch,
} from "#coop/checkpoint-log";
import { coopLog } from "#coop/coop-log";
import type { CoopLink } from "#coop/link";
import type { CoopSession } from "#coop/session";

/**
 * Each client tells the other the state hash of every checkpoint it passes, and compares the partner's with its own
 * (DECISIONS D13). The two clients pass the same checkpoints at different times, so a hash that arrives early waits for
 * the local one and the other way round.
 *
 * A mismatch is recorded (`session.checkpointMismatch` and `session.desyncMessage` say where the clients diverged first, and the
 * debug API shows it) and handed to `session.onMismatch`, which asks for a reload: both clients load the host's wave-start
 * save (D13, `resync-run.ts`).
 *
 * @module
 */

const FIELDS = ["kind", "wave", "turn", "phaseName", "hash"] as const;

function compare(session: CoopSession, index: number): void {
  const local = session.checkpoints.entries[index];
  const remote = session.remoteCheckpoints.get(index);
  if (local === undefined || remote === undefined) {
    return;
  }
  session.remoteCheckpoints.delete(index);
  if (session.checkpointMismatch !== null) {
    return;
  }
  const fields = FIELDS.filter(field => local[field] !== remote[field]);
  if (fields.length > 0) {
    session.checkpointMismatch = { local, remote };
    session.desyncMessage ??= describeCheckpointMismatch({ index, local, remote, fields });
    console.error("co-op: ", session.desyncMessage);
    coopLog().warn("checkpoint", session.desyncMessage, { local, remote, fields });
    session.onMismatch?.(local, remote);
  }
}

/**
 * Start the exchange for a session with a link.
 * @returns A function that stops it
 */
export function attachCheckpointExchange(session: CoopSession, link: CoopLink): () => void {
  session.onCheckpoint = checkpoint => {
    link.sendCheckpoint({ ...checkpoint });
    compare(session, checkpoint.index);
  };
  const stop = link.onCheckpoint(message => {
    if (!(CHECKPOINT_KINDS as readonly string[]).includes(message.kind)) {
      return;
    }
    session.remoteCheckpoints.set(message.index, { ...message, kind: message.kind as CheckpointKind } as Checkpoint);
    compare(session, message.index);
  });
  return () => {
    stop();
    session.onCheckpoint = null;
  };
}
