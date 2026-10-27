/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { coopLog, hookPageIntoCoopLog } from "#coop/coop-log";
import type { CoopLink } from "#coop/link";
import { keyId } from "#coop/protocol";
import { logUrlFor } from "#coop/relay-url";
import { type CoopSession, getCoopSession } from "#coop/session";
import { UiMode } from "#enums/ui-mode";

/**
 * What the co-op log (DECISIONS D26) records of a session, and what a report adds: a snapshot of the game as it is. The log
 * itself (`coop-log.ts`) knows nothing of the game.
 *
 * @module
 */

/** A decision's payload, short: what was chosen, not every field of it */
const PAYLOAD_CHARS = 300;
/** How long without a new phase before the log says so, and again after each further stretch of it */
const STALL_AFTER_MS = 60_000;
const STALL_CHECK_MS = 10_000;

/** Where the log goes: the relay's own server (`/coop/log` beside `/coop`) */
export function setCoopLogServer(relayUrl: string | null): void {
  coopLog().setServer(relayUrl === null ? null : logUrlFor(relayUrl));
}

function short(value: unknown): unknown {
  const json = JSON.stringify(value ?? null);
  return json.length > PAYLOAD_CHARS ? `${json.slice(0, PAYLOAD_CHARS)}…` : value;
}

/** The game as it is now, for a stall note or a report; `full` adds the party, the last phases and the checkpoints */
export function gameSnapshot(full = false): Record<string, unknown> {
  const session = getCoopSession();
  const scene = globalScene;
  const snapshot: Record<string, unknown> = {};
  try {
    snapshot["phase"] = scene.phaseManager.getCurrentPhase()?.phaseName ?? null;
    snapshot["wave"] = scene.currentBattle?.waveIndex ?? null;
    snapshot["turn"] = scene.currentBattle?.turn ?? null;
    snapshot["ui"] = UiMode[scene.ui.mode] ?? scene.ui.mode;
    snapshot["message"] = scene.ui.getMessageHandler().message?.text ?? null;
    if (session !== null) {
      snapshot["epoch"] = session.link?.epoch ?? null;
      snapshot["partnerPresent"] = session.link?.partnerPresent ?? null;
      snapshot["window"] = session.openWindow.map(keyId);
      snapshot["desync"] = session.desyncMessage;
      snapshot["stopped"] =
        session.stopped === null ? null : { wave: session.stopped.wave, epoch: session.stopped.epoch };
      snapshot["rewards"] = { screen: session.rewardPickCount - 1, step: session.rewardStep };
      snapshot["resyncs"] = session.resyncs.slice(-5);
    }
    if (full) {
      snapshot["money"] = scene.money;
      snapshot["party"] = scene.getPlayerParty().map(pokemon => ({
        id: pokemon.id,
        species: pokemon.species.name,
        owner: session?.ownership.get(pokemon.id) ?? null,
        level: pokemon.level,
        hp: `${pokemon.hp}/${pokemon.getMaxHp()}`,
        moves: pokemon.getMoveset().map(move => move.moveId),
      }));
      snapshot["enemies"] = scene.getEnemyField().map(pokemon => ({
        species: pokemon.species.name,
        level: pokemon.level,
        hp: `${pokemon.hp}/${pokemon.getMaxHp()}`,
      }));
      if (session !== null) {
        snapshot["trace"] = session.trace
          .dump()
          .slice(-120)
          .map(entry => `${entry.index}:${entry.wave}:${entry.turn}:${entry.phaseName}`);
        snapshot["checkpoints"] = session.checkpoints.entries.slice(-20);
      }
    }
  } catch (error) {
    // A snapshot of a game in a bad state may fail half way: what was read is kept
    snapshot["snapshotError"] = error instanceof Error ? error.message : String(error);
  }
  return snapshot;
}

/** Notes, in the log, a game where no phase has started for a long time (a dead prompt, a lost message) */
function watchStalls(session: CoopSession): () => void {
  const log = coopLog();
  let lastTotal = session.trace.total;
  let lastChange = log.now();
  let notes = 0;
  const timer = setInterval(() => {
    const total = session.trace.total;
    if (total !== lastTotal) {
      if (notes > 0) {
        log.info("stall", `moving again after ${Math.round((log.now() - lastChange) / 1000)} s`);
      }
      lastTotal = total;
      lastChange = log.now();
      notes = 0;
      return;
    }
    const still = log.now() - lastChange;
    if (still >= STALL_AFTER_MS * (notes + 1)) {
      notes++;
      // The first note may be a slow partner; the third (3 minutes) is worth a look
      log.add(notes >= 3 ? "warn" : "info", "stall", `no new phase for ${Math.round(still / 1000)} s`, gameSnapshot());
    }
  }, STALL_CHECK_MS);
  return () => clearInterval(timer);
}

/**
 * The session starts: the log knows who and where, sends to the relay's server, and records the link, the decisions, the
 * refusals and the desyncs from now on.
 * @returns What stops the recording (the session ended)
 */
export function attachCoopLog(session: CoopSession, link: CoopLink, name: string): () => void {
  const log = coopLog();
  hookPageIntoCoopLog();
  log.setContext({
    room: link.identity?.code ?? link.code ?? null,
    seat: session.seat,
    name,
    build: `${session.build.gitSha.slice(0, 9)}+${session.build.dirtyHash.slice(0, 8)}`,
  });
  setCoopLogServer(link.relayUrl);
  log.info("session", "begin", { seat: session.seat, partner: link.partnerName, epoch: link.epoch });

  let present = link.partnerPresent;
  const unsubscribes = [
    link.onChange(() => {
      if (link.partnerPresent !== present) {
        present = link.partnerPresent;
        log.add(present ? "info" : "warn", "link", present ? "partner back" : "partner away", { epoch: link.epoch });
      }
    }),
    link.onEnd(end => log.warn("link", `ended: ${end}`, { reason: link.closedReason ?? null })),
    link.sequencer.onDecision(decision =>
      log.info("decision", keyId(decision.key), {
        seq: decision.seq,
        author: decision.author,
        ...(decision.takeover === true ? { takeover: true } : {}),
        payload: short(decision.payload),
      }),
    ),
    link.sequencer.onProposalRejected(({ key, reason }) => log.info("decision", `refused: ${keyId(key)}`, { reason })),
    link.sequencer.onDesync(error => log.error("desync", error.message, gameSnapshot())),
  ];
  const stopStalls = watchStalls(session);
  return () => {
    stopStalls();
    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }
    log.info("session", "end");
  };
}
