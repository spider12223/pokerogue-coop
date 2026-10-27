/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import type { Checkpoint, CheckpointKind } from "#coop/checkpoint-log";
import { hashCanonical } from "#coop/protocol";
import { getCoopSession } from "#coop/session";
import { computeStateHash, registerOpenRewardOptions } from "#coop/state-hash";
import type { ModifierTypeOption } from "#modifiers/modifier-type";
import Phaser from "phaser";

/**
 * The hooks the game calls at the D13 hash points. Each is a no-op in solo play, so solo play is unchanged.
 *
 * @module
 */

/**
 * Pass a checkpoint: hash the simulation state and append it to the session's log (and hand it to the session's
 * listener, which is how a client reports it to its partner).
 * @param kind - Which hash point
 * @param phaseName - The phase that takes it, so a mismatch names the phase
 * @returns The checkpoint, or `null` in solo play
 */
export function coopCheckpoint(kind: CheckpointKind, phaseName: string): Checkpoint | null {
  const session = getCoopSession();
  if (session === null) {
    return null;
  }
  const battle = globalScene.currentBattle as typeof globalScene.currentBattle | null;
  const checkpoint = session.checkpoints.append({
    kind,
    wave: battle?.waveIndex ?? 0,
    turn: battle?.turn ?? 0,
    phaseName,
    hash: computeStateHash(),
  });
  session.pace.checkpointTaken();
  session.onCheckpoint?.(checkpoint);
  return checkpoint;
}

/** `SelectModifierPhase` has generated its option list (D9): register it for the state hash and take the checkpoint. */
export function coopRewardOptionsReady(phase: object, options: readonly ModifierTypeOption[]): void {
  if (getCoopSession() === null) {
    return;
  }
  registerOpenRewardOptions(phase, options);
  coopCheckpoint("rewards", "SelectModifierPhase");
}

/**
 * Record a phase start in the session's phase trace (co-op only): wave, turn, phase and a hash of the RNG state. Called
 * wherever a phase is started: `PhaseManager.startCurrentPhase`, and the test `PhaseInterceptor` that replaces it. It is on in
 * a deployed build too: the report of a desync that a playtester sends is made of these.
 */
export function tracePhaseStart(phase: { readonly phaseName: string }): void {
  const session = getCoopSession();
  if (session === null) {
    return;
  }
  const battle = globalScene.currentBattle as typeof globalScene.currentBattle | null;
  session.trace.record({
    wave: battle?.waveIndex ?? 0,
    turn: battle?.turn ?? 0,
    phaseName: phase.phaseName,
    rng: hashCanonical(Phaser.Math.RND.state()),
  });
  // Where this client is in the text of the run (D27)
  session.pace.phaseStarted(phase.phaseName);
}
