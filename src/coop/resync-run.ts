/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { stopAllAfkWatchers } from "#coop/afk";
import type { Checkpoint } from "#coop/checkpoint-log";
import { coopLog } from "#coop/coop-log";
import { endTurnCosmetics, getCosmeticView } from "#coop/cosmetic-view";
import { EpochChangedError } from "#coop/epoch";
import { safeLegality } from "#coop/legal";
import { gameLegalityView } from "#coop/legal-view";
import type { CoopLink } from "#coop/link";
import { showOverlayMenu } from "#coop/overlay";
import { hideReconnectScreen, reconnectScreenText, showReconnectScreen } from "#coop/reconnect-ui";
import {
  buildReport,
  isStop,
  type MismatchInfo,
  REPORT_CHECKPOINT_LENGTH,
  REPORT_TRACE_LENGTH,
  type ResyncMessage,
  type ResyncPayload,
  type ResyncReason,
  type ResyncStopPayload,
} from "#coop/resync";
import { type CoopSession, getCoopSession } from "#coop/session";
import { coopText } from "#coop/text";
import { updateSlotEpoch } from "#coop/wave-save";
import { UiMode } from "#enums/ui-mode";

/**
 * Resync, rejoin and resume at run time (DECISIONS D13, D18, D20, D21): what a client does when the clients disagree or the
 * partner comes back.
 *
 * Everything funnels into one thing: both clients reload the wave-start save of the host (D19) under the next epoch (D18). The
 * host decides and sequences it (`issueResync`); both apply it (`applyResync`): the sequencer and the link forget the old
 * world, the phases are abandoned, and `CoopResyncPhase` loads the save the way a retry does.
 *
 * A reload abandons whatever phase is running, so it only happens where that is safe (`isSafePoint`): while a phase waits for a
 * decision (a window is open), for the player's commands, at the title screen, or after a desync, when nothing runs any more.
 * Elsewhere it waits for the next decision gate (`coopGate`), which every decision passes first.
 *
 * @module
 */

/** What "leave" does in this game: end the session, forget the seat and go back to the title screen (the lobby sets it) */
let leaveHandler: (() => void) | null = null;

export function registerLeaveHandler(handler: () => void): void {
  leaveHandler = handler;
}

/** What the lobby does before a reload: a guest still on the starter select (its START was lost) closes it first */
let beforeReloadHandler: (() => void) | null = null;

export function registerBeforeReload(handler: () => void): void {
  beforeReloadHandler = handler;
}

/** A reload starts (`CoopResyncPhase`): the lobby, if one is still open, closes first */
export function beforeReload(): void {
  beforeReloadHandler?.();
}

/** The phases that wait for the player or for nothing: abandoning one loses no work */
// (the starter select: a guest whose START was lost while its connection dropped is brought into the run by the reload)
const SAFE_PHASES: ReadonlySet<string> = new Set([
  "CommandPhase",
  "SelectTargetPhase",
  "TitlePhase",
  "SelectStarterPhase",
]);

/** @returns Whether the running phase can be abandoned now */
export function isSafePoint(session: CoopSession): boolean {
  // (after a retry the game over phase only waits for the host's reload, D4a; a phase whose decision failed is stuck)
  if (session.atGate || session.retryPending || session.bridgeFailed) {
    return true;
  }
  const phase = globalScene?.phaseManager?.getCurrentPhase?.();
  if (phase == null) {
    return true;
  }
  return (
    session.openWindow.length > 0
    || SAFE_PHASES.has(phase.phaseName)
    || (session.link?.sequencer.desync ?? null) !== null
  );
}

/** The first checkpoint on which the two clients differ, as the report names it */
export function mismatchInfoOf(session: CoopSession): MismatchInfo | null {
  const found = session.checkpointMismatch;
  if (found === null) {
    return session.resyncWanted?.mismatch ?? null;
  }
  const { local, remote } = found;
  return {
    index: (local ?? remote).index,
    kind: (local ?? remote).kind,
    wave: (local ?? remote).wave,
    turn: (local ?? remote).turn,
    phaseName: (local ?? remote).phaseName,
    local: local?.hash ?? null,
    remote: remote.hash,
  };
}

/** The clients disagree (a checkpoint, or a decision that does not fit): ask for a reload (D13) */
export function wantResync(
  session: CoopSession,
  reason: "mismatch" | "desync",
  mismatch: MismatchInfo | null = mismatchInfoOf(session),
): void {
  const link = session.link;
  if (link === null || link.isClosed || session.stopped !== null || session.reloading) {
    return;
  }
  const wave = mismatch?.wave ?? session.waveSave?.wave ?? globalScene.currentBattle?.waveIndex ?? 0;
  if (session.resyncWanted === null) {
    session.resyncWanted = { reason, wave, mismatch };
    console.warn(`co-op: the clients disagree (${reason}), reloading the wave start`, mismatch);
    coopLog().warn("resync", `the clients disagree (${reason}): reloading the wave start`, { wave, mismatch });
  }
  if (!session.isHost && !session.resyncRequested) {
    session.resyncRequested = true;
    link.sendResyncRequest({ reason, wave, mismatch });
  }
  trySafeApply(session);
}

/** Do what is due if the running phase can be abandoned now (D13) */
export function trySafeApply(session: CoopSession): void {
  const link = session.link;
  if (link === null || link.isClosed || session.reloading || !isSafePoint(session)) {
    return;
  }
  step(session, link);
}

/**
 * Do what is due: apply the reload that came from the host, or (host) issue the one that is wanted or that a returning
 * partner needs.
 * @returns Whether a reload or a stop was started
 */
function step(session: CoopSession, link: CoopLink): boolean {
  if (session.stopped !== null || session.reloading) {
    return false;
  }
  if (session.pendingResync !== null) {
    applyResync(session, session.pendingResync);
    return true;
  }
  if (session.isHost && link.partnerPresent && (session.resyncWanted !== null || link.needsResync)) {
    if (session.waveSave === null && session.resyncWanted === null) {
      // A return before the first wave (the lobby, the starter select): there is no world to reload yet. The lobby sends
      // its state again; once the first wave is saved, its start is what the partner reloads
      return false;
    }
    issueResync(session, session.resyncWanted?.reason ?? "rejoin");
    return true;
  }
  return false;
}

/**
 * Host: sequence a reload and apply it here too (D13).
 * @param reason - Why; a desync counts against its wave, and the third one of the same wave stops the run
 * @param source - The save to reload; default the wave-start save of the run (a resumed run passes its slot's)
 */
export function issueResync(
  session: CoopSession,
  reason: ResyncReason,
  source: { wave: number; json: string } | null = session.waveSave,
): void {
  const link = session.link;
  if (link === null || !session.isHost) {
    return;
  }
  if (source === null) {
    // There is no wave start to go back to (the run has not started yet): nothing to resume
    console.warn("co-op: no wave-start save to reload; ending the session");
    coopLog().error("resync", "no wave-start save to reload: the session ends");
    endSession(session);
    return;
  }
  if ((reason === "mismatch" || reason === "desync") && session.resyncBook.desync(source.wave) === "stop") {
    const stop: ResyncStopPayload = {
      stop: true,
      epoch: link.epoch + 1,
      seq: link.sequencer.reserveSeq(),
      wave: source.wave,
      mismatch: mismatchInfoOf(session),
      trace: session.trace.dump().slice(-REPORT_TRACE_LENGTH),
    };
    link.sendResync(stop);
    applyResync(session, stop);
    return;
  }
  const message: ResyncPayload = {
    epoch: link.epoch + 1,
    seq: link.sequencer.reserveSeq(),
    wave: source.wave,
    reason,
    save: source.json,
  };
  link.sendResync(message);
  applyResync(session, message);
}

/** Guest: the host's `RESYNC` arrived. It is applied at the next safe point (D13). */
export function receiveResync(session: CoopSession, message: ResyncMessage): void {
  if (session.stopped !== null) {
    if (isStop(message) || message.epoch <= session.stopped.epoch) {
      return;
    }
    // The host reloaded its tab after the stop and continues the run from its slot: this client comes back into it
    session.stopped = null;
    session.stopMismatch = null;
  }
  // A newer one replaces an older one that was not applied yet
  if (session.pendingResync === null || session.pendingResync.epoch < message.epoch) {
    session.pendingResync = message;
    session.timing["resyncReceivedAt"] = Date.now();
  }
  trySafeApply(session);
}

/**
 * Both clients: forget the old world and reload (or stop). From here the link, the sequencer and the session are in the new
 * epoch (D18); the phases of the old world are abandoned and `CoopResyncPhase` brings up the saved wave.
 */
export function applyResync(session: CoopSession, message: ResyncMessage): void {
  const link = session.link;
  if (link === null) {
    return;
  }
  session.reloading = true;
  hideReconnectScreen();
  stopAllAfkWatchers();
  endTurnCosmetics();
  getCosmeticView()?.clearCursor();
  // The mismatch is in the checkpoint log of the old epoch: the report takes it from there
  const lastMismatch = mismatchInfoOf(session);
  session.beginEpoch(link.epoch);
  link.beginEpoch(message.epoch, message.seq + 1);
  if (isStop(message)) {
    session.reloading = false;
    session.stopped = message;
    if (session.isHost) {
      // The slot moves to the stop's epoch too: a host that reloads then brings a still-open guest back with a newer one
      updateSlotEpoch(message.epoch, message.seq);
    }
    showStop(session, link, message, lastMismatch);
    return;
  }
  session.resyncs.push({ epoch: message.epoch, reason: message.reason, wave: message.wave });
  if (session.isHost) {
    updateSlotEpoch(message.epoch, message.seq);
  }
  // A handler of the old phase reads that phase when it clears (the move list reads the command phase that opened it), so
  // the screen goes back to the message window while that phase is still the current one, with every screen under it
  globalScene.ui.clearScreensUnder();
  void globalScene.ui.setMode(UiMode.MESSAGE).catch((error: unknown) => {
    console.warn("co-op: clearing the screen before the reload failed:", error);
    coopLog().warn("resync", "clearing the screen before the reload failed", error);
  });
  const phaseManager = globalScene.phaseManager;
  phaseManager.coopRestartWith(phaseManager.create("CoopResyncPhase", message));
}

/** This client ends the session: it leaves the room, forgets the seat and goes to the title screen (D20) */
export function endSession(session: CoopSession): void {
  hideReconnectScreen();
  session.link?.leave();
  leaveHandler?.();
}

/**
 * The wave start could not be loaded (D13): a save this build refuses, or a broken one. Nothing can go on from there, so the
 * player is told why and goes back to the title screen; the partner sees them leave.
 * @param reason - Why, for the player
 */
export function showReloadFailed(session: CoopSession, reason: string): void {
  const { ui } = globalScene;
  void ui.setMode(UiMode.MESSAGE).then(() => {
    if (getCoopSession() !== session) {
      return;
    }
    ui.showText(
      coopText("reloadFailed", "The start of the wave could not be loaded: {{reason}}", { reason }),
      null,
      () =>
        showOverlayMenu([
          {
            label: coopText("backToTitle", "Back to the title screen"),
            handler: () => {
              endSession(session);
              return true;
            },
          },
        ]),
      null,
      false,
    );
  });
}

/**
 * What a decision does first (D20, D13): while the partner is away, or a reload is due, it does not go on. Every decision of
 * the game passes here before it opens its window.
 * @throws {@linkcode EpochChangedError} If the run was reloaded while this waited: the decision belongs to the old world
 */
async function gate(session: CoopSession): Promise<void> {
  const link = session.link;
  if (link === null) {
    return;
  }
  const startEpoch = link.epoch;
  session.atGate = true;
  try {
    for (;;) {
      if (session.stopped !== null) {
        // The run was stopped: nothing is decided any more
        await new Promise<never>(() => undefined);
      }
      if (link.epoch !== startEpoch || step(session, link)) {
        throw new EpochChangedError();
      }
      if (link.isClosed) {
        await new Promise<never>(() => undefined);
      }
      if (link.partnerPresent && !link.needsResync) {
        hideReconnectScreen();
        return;
      }
      showReconnectScreen({
        partner: session.partnerName,
        code: link.code,
        back: link.partnerPresent,
        onEnd: () => endSession(session),
        ...(session.reconnectEndMs === null ? {} : { endAfterMs: session.reconnectEndMs }),
      });
      await link.untilChange();
    }
  } finally {
    session.atGate = false;
  }
}

/**
 * The partner left or came back while this client is in the middle of a decision (a window is open: the reward screen, a
 * prompt): the waiting screen replaces what is on screen at once (D20). Between decisions the next gate does it.
 */
function refreshAwayScreen(session: CoopSession, link: CoopLink): void {
  if (link.isClosed || session.reloading || session.stopped !== null || session.atGate) {
    return;
  }
  if (!link.partnerPresent) {
    // Nobody is there to take over for
    stopAllAfkWatchers();
    // (a guest that waits for the host's reload after a retry, a rejoin or a continued run waits like one in a decision,
    // D4a, D20, D21)
    if (session.openWindow.length > 0 || session.retryPending || session.awaitingReload) {
      showReconnectScreen({
        partner: session.partnerName,
        code: link.code,
        back: false,
        onEnd: () => endSession(session),
        ...(session.reconnectEndMs === null ? {} : { endAfterMs: session.reconnectEndMs }),
      });
    }
  } else if (link.needsResync && reconnectScreenText() !== null) {
    showReconnectScreen({
      partner: session.partnerName,
      code: link.code,
      back: true,
      onEnd: () => endSession(session),
    });
  }
}

/**
 * Wire the resync of a session: the host's reload messages, the guest's requests, a checkpoint mismatch, a decision that
 * does not fit, and the decision gate.
 * @returns A function that stops it
 */
export function installResync(session: CoopSession, link: CoopLink): () => void {
  session.beforeDecision = () => gate(session);
  // Every decision is checked against the state, on both clients, just before the simulation gets it (D24)
  link.sequencer.setLegality(
    safeLegality(gameLegalityView, error => {
      console.warn("co-op: the legality check failed, the decision stands:", error);
      coopLog().warn("decision", "the legality check failed, the decision stands", error);
    }),
  );
  session.onMismatch = () => wantResync(session, "mismatch");
  session.onBridgeFailure = () => {
    session.bridgeFailed = true;
    wantResync(session, "desync");
  };
  const stops = [
    link.onResync(message => receiveResync(session, message)),
    link.onResyncRequest(request => {
      if (session.isHost) {
        wantResync(session, request.reason, request.mismatch);
      }
    }),
    link.onReport(report => {
      session.partnerReport = report;
    }),
    link.sequencer.onDesync(() => wantResync(session, "desync")),
    link.onChange(() => {
      refreshAwayScreen(session, link);
      trySafeApply(session);
    }),
  ];
  // A reload that is due waits for a safe point; look again now and then (cheap: it only does something when one is due)
  const poll = setInterval(() => {
    if (session.pendingResync !== null || session.resyncWanted !== null || link.needsResync) {
      trySafeApply(session);
    }
  }, 250);
  return () => {
    clearInterval(poll);
    for (const stop of stops) {
      stop();
    }
    session.beforeDecision = null;
    session.onMismatch = null;
    session.onBridgeFailure = null;
  };
}

// #region The stop (D13)

/** The checkpoints of the last epoch this client was in, for the report */
function lastCheckpoints(session: CoopSession): Checkpoint[] {
  const current = [...session.checkpoints.entries];
  const source = current.length > 0 ? current : (session.checkpointHistory.at(-1)?.entries ?? []);
  return source.slice(-REPORT_CHECKPOINT_LENGTH);
}

/** The report of a stopped run: this client's side and, if it arrived, the partner's (D13) */
export function reportOf(session: CoopSession): ReturnType<typeof buildReport> | null {
  const stopped = session.stopped;
  const link = session.link;
  if (stopped === null || link === null) {
    return null;
  }
  const names = {
    host: session.isHost ? link.name : link.theirName,
    guest: session.isHost ? link.theirName : link.name,
  };
  return buildReport({
    seat: session.seat,
    epoch: stopped.epoch,
    wave: stopped.wave,
    build: session.build,
    names,
    mismatch: session.stopMismatch ?? stopped.mismatch,
    trace: session.trace.dump(),
    checkpoints: lastCheckpoints(session),
    partner: session.partnerReport,
    partnerTrace: session.isHost ? null : stopped.trace,
  });
}

/** Save the report as a file the player can send (D13) */
export function downloadReport(session: CoopSession): boolean {
  const report = reportOf(session);
  if (report === null || typeof document === "undefined") {
    return false;
  }
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `coop-report-wave${report.wave}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  session.timing["reportSavedAt"] = Date.now();
  return true;
}

function showStop(
  session: CoopSession,
  link: CoopLink,
  message: ResyncStopPayload,
  mismatch: MismatchInfo | null,
): void {
  session.stopMismatch = mismatch ?? message.mismatch;
  coopLog().error("resync", `the run is stopped: wave ${message.wave} kept getting different results`, {
    wave: message.wave,
    mismatch: session.stopMismatch,
  });
  // This client's side of the report goes to the partner
  link.sendReport({
    mismatch: session.stopMismatch,
    trace: session.trace.dump().slice(-REPORT_TRACE_LENGTH),
    checkpoints: lastCheckpoints(session),
  });
  const { ui } = globalScene;
  // The screen comes a moment later: a session that ended meanwhile (the player left, a new run began) does not get it
  const current = (): boolean => getCoopSession() === session;
  const menu = (): void => {
    if (!current()) {
      return;
    }
    showOverlayMenu([
      {
        label: coopText("saveReport", "Save report"),
        handler: () => {
          downloadReport(session);
          menu();
          return true;
        },
      },
      {
        label: coopText("backToTitle", "Back to the title screen"),
        handler: () => {
          endSession(session);
          return true;
        },
      },
    ]);
  };
  void ui.setMode(UiMode.MESSAGE).then(() => {
    if (!current()) {
      return;
    }
    ui.showText(
      coopText(
        "resyncStopped",
        "Your game and {{partner}}'s keep getting different results in wave {{wave}}, so the run is stopped. Your progress up to the start of that wave is saved.",
        { partner: session.partnerName, wave: message.wave },
      ),
      null,
      menu,
      null,
      true,
    );
  });
}

// #endregion
