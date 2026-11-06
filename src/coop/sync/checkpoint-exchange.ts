/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { coopLog } from "#coop/diagnostics/coop-log";
import type { CoopLink } from "#coop/link/link";
import type { Seat } from "#coop/protocol";
import type { CoopSession } from "#coop/session";
import {
  CHECKPOINT_KINDS,
  type Checkpoint,
  type CheckpointKind,
  describeCheckpointMismatch,
} from "#coop/sync/checkpoint-log";

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

/**
 * How far ahead of this client the partner's checkpoints are kept: the partner can only be a few ahead (it waits for this
 * player's decisions every turn), so one further than this is dropped and never compared, and the waiting ones stay few
 */
export const CHECKPOINT_LOOKAHEAD = 64;

/** Compare this client's checkpoint `index` with the one of the partner in `seat`, once both are there */
function compare(session: CoopSession, index: number, seat: Seat): void {
  const remotes = session.remoteCheckpointsOf(seat);
  const local = session.checkpoints.entries[index];
  const remote = remotes.get(index);
  if (local === undefined || remote === undefined) {
    return;
  }
  remotes.delete(index);
  if (session.checkpointMismatch !== null) {
    return;
  }
  const fields = FIELDS.filter(field => local[field] !== remote[field]);
  if (fields.length > 0) {
    session.checkpointMismatch = { local, remote, seat };
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
    for (const seat of session.remoteCheckpointSeats) {
      compare(session, checkpoint.index, seat);
    }
  };
  // Each partner's apart: the host of a game of three hears both guests (D40)
  const stop = link.onCheckpoint((message, sender?: Seat) => {
    if (!(CHECKPOINT_KINDS as readonly string[]).includes(message.kind)) {
      return;
    }
    // (a game of two has one partner)
    const from = sender ?? (session.seat === "host" ? "guest" : "host");
    const remotes = session.remoteCheckpointsOf(from);
    const local = session.checkpoints.entries.length;
    if (
      message.index > local + CHECKPOINT_LOOKAHEAD
      || (message.index >= local && !remotes.has(message.index) && remotes.size > CHECKPOINT_LOOKAHEAD)
    ) {
      return;
    }
    remotes.set(message.index, { ...message, kind: message.kind as CheckpointKind } as Checkpoint);
    compare(session, message.index, from);
  });
  return () => {
    stop();
    session.onCheckpoint = null;
  };
}
