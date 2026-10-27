/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { attachCheckpointExchange, CHECKPOINT_LOOKAHEAD } from "#coop/checkpoint-exchange";
import type { CoopLink } from "#coop/link";
import type { BuildIdentity, CheckpointMessage } from "#coop/protocol";
import { CoopSession } from "#coop/session";
import { describe, expect, it } from "vitest";

/**
 * The checkpoint exchange (DECISIONS D13) keeps the partner's checkpoints until this client reaches them: only those close
 * enough ahead, so a partner that sends checkpoints far ahead cannot fill this client's memory.
 */

const build: BuildIdentity = {
  protocolVersion: 2,
  gitSha: "a6995c571a092e762ea036589bb6f3a8fa4f5dbd",
  dirtyHash: "clean",
  buildMode: "development+bypass",
  overridesHash: "00000000000000",
};

const HASH = "0123456789abcd";

function setup() {
  const session = new CoopSession({ seat: "host", runSeed: "x", build });
  let deliver: ((message: CheckpointMessage) => void) | null = null;
  const link = {
    sendCheckpoint: () => undefined,
    onCheckpoint: (listener: (message: CheckpointMessage) => void) => {
      deliver = listener;
      return () => undefined;
    },
  } as unknown as CoopLink;
  attachCheckpointExchange(session, link);
  const fromPartner = (index: number, hash = HASH): void =>
    deliver!({ index, kind: "turn", wave: 1, turn: index, phaseName: "TurnInitPhase", hash });
  const pass = (turn: number, hash = HASH): void => {
    const checkpoint = session.checkpoints.append({ kind: "turn", wave: 1, turn, phaseName: "TurnInitPhase", hash });
    session.onCheckpoint?.(checkpoint);
  };
  return { session, fromPartner, pass };
}

describe("the partner's checkpoints that wait for this client", () => {
  it("keeps those a little ahead, and compares them when this client gets there", () => {
    const { session, fromPartner, pass } = setup();
    fromPartner(0);
    fromPartner(1, "ffffffffffffff");
    expect(session.remoteCheckpoints.size).toBe(2);
    pass(0);
    pass(1);
    expect(session.remoteCheckpoints.size).toBe(0);
    expect(session.checkpointMismatch).not.toBeNull();
  });

  it("drops one too far ahead of this client's log", () => {
    const { session, fromPartner } = setup();
    fromPartner(CHECKPOINT_LOOKAHEAD + 1);
    fromPartner(1_000_000_000);
    expect(session.remoteCheckpoints.size).toBe(0);
    fromPartner(CHECKPOINT_LOOKAHEAD);
    expect(session.remoteCheckpoints.size).toBe(1);
  });

  it("never holds more than the look-ahead, however many come", () => {
    const { session, fromPartner, pass } = setup();
    for (let round = 0; round < 3; round++) {
      for (let index = 0; index < 10_000; index++) {
        fromPartner(index);
      }
      expect(session.remoteCheckpoints.size).toBeLessThanOrEqual(CHECKPOINT_LOOKAHEAD + 1);
      pass(round);
    }
    expect(session.checkpointMismatch).toBeNull();
  });
});
