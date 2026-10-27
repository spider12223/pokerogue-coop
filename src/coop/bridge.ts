/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { AfkWatcher, showTookOver } from "#coop/afk";
import { coopLog } from "#coop/coop-log";
import { EpochChangedError } from "#coop/epoch";
import type { CoopLink } from "#coop/link";
import type { DecisionKey, Seat } from "#coop/protocol";
import { type Decision, DesyncError, ProposalRejectedError, type ProposeOptions } from "#coop/sequencer";
import { getCoopSession, requireCoopSession } from "#coop/session";
import { canTakeOver, takeoverPlan } from "#coop/takeover";
import { coopText } from "#coop/text";
import { UiMode } from "#enums/ui-mode";

/** The text of the co-op UI is in `text.ts` (a leaf); the phases still read it from here */
export { coopText };

/**
 * The decision bridge (DECISIONS D2, D7, D10): the one helper every co-op decision phase uses.
 *
 * 1. The simulation says which decision it expects (the key) and who makes it (`deciderOf`).
 * 2. The decider's client shows the normal UI; what the player chose is proposed to the sequencer, not applied.
 * 3. The other client shows that it waits.
 * 4. Both clients, the decider's included, apply the sequenced decision, strictly in `seq` order.
 *
 * So the UI never changes the simulation in co-op: only a sequenced decision does.
 *
 * @module
 */

/** @returns The connection to the partner, or `null` when this co-op session has no network (rule tests) */
export function getLink(): CoopLink | null {
  return getCoopSession()?.link ?? null;
}

/** @returns Whether this client is in a co-op run with a network: decisions are sequenced */
export function isLinked(): boolean {
  return getLink() !== null;
}

/** @returns This client's seat */
export function mySeat(): Seat {
  return requireCoopSession().seat;
}

/**
 * What every decision does first (D20, D13): while the partner is away, or a reload is due, it does not go on. Resolves when
 * the decision may open its window.
 * @throws {@linkcode EpochChangedError} If the run was reloaded while it waited: the decision belongs to the old world
 */
export async function coopGate(): Promise<void> {
  await getCoopSession()?.beforeDecision?.();
}

/** "Waiting for your partner…" in the message box, for the side that does not decide. */
export function showWaitingForPartner(): void {
  const { ui } = globalScene;
  ui.setMode(UiMode.MESSAGE);
  ui.showText(coopText("waitingForPartner", "Waiting for your partner…"), null, undefined, null, false);
}

export interface BridgeRequest<P> {
  key: DecisionKey;
  /** Who makes the decision; `"either"`: both may (the shop), and the first sequenced one counts */
  decider: Seat | "either";
  /**
   * The decider's side: show the normal UI and resolve with what the player chose. Called only on the decider's client.
   * Nothing may change the simulation until the decision comes back.
   */
  ask: () => Promise<P>;
  /** The other side: show that this client waits. Default: {@linkcode showWaitingForPartner}. */
  wait?: () => void;
  /** Check the sequenced payload; a payload that does not fit is a desync */
  isPayload: (payload: unknown) => payload is P;
  /**
   * A decision whose take over is the waiting phase's own (`takeoverPlan` says `custom`): the waiting player chose "Take
   * over" (D17). Other kinds need nothing: the bridge proposes the default or asks the same question.
   */
  takeover?: () => void;
}

/**
 * Propose, and let go of the proposal if it came too late: the partner's answer (or a take over) was sequenced first, and
 * a decision cannot be made twice (D17).
 */
export function proposeUnlessLate(link: CoopLink, key: DecisionKey, payload: unknown, options?: ProposeOptions): void {
  if (link.sequencer.hasDecision(key)) {
    return;
  }
  try {
    link.sequencer.propose(key, payload, options);
  } catch (error) {
    if (error instanceof ProposalRejectedError && (error.reason === "duplicate" || error.reason === "closed")) {
      return;
    }
    throw error;
  }
}

/**
 * While this client waits for the partner's decision (D17): hint, then offer to take over.
 * @returns The watcher to stop when the decision comes, or `null` for a decision nobody can take over
 */
function watchForTakeover<P>(link: CoopLink, request: BridgeRequest<P>, ask: () => Promise<P>): AfkWatcher | null {
  const { key } = request;
  if (!canTakeOver(key.kind)) {
    return null;
  }
  const runTakeover = async (): Promise<void> => {
    const plan = takeoverPlan(key);
    if (plan.mode === "custom") {
      request.takeover?.();
      return;
    }
    // Nothing to choose (the default), or the same screen the partner would have had
    const payload = plan.mode === "payload" ? plan.payload : await ask();
    proposeUnlessLate(link, key, payload, { takeover: true });
  };
  const watcher = new AfkWatcher({ onTakeOver: () => void runTakeover().catch(error => reportBridgeError(error)) });
  watcher.start();
  return watcher;
}

/**
 * Make one sequenced decision.
 * @returns The sequenced decision: the same on both clients
 * @throws {@linkcode DesyncError} If the decision is not what the simulation expected
 */
export async function coopDecide<P>(request: BridgeRequest<P>): Promise<Decision<P>> {
  const session = requireCoopSession();
  const link = session.link;
  if (link === null) {
    throw new Error("coopDecide needs a linked co-op session");
  }
  const { key, decider } = request;
  const authors = decider === "either" ? undefined : ([decider] as const);

  await coopGate();
  // What the player answers after a reload is an answer to a question of the old world
  const epoch = link.epoch;
  session.openWindow = [...session.openWindow, key];
  const pending = link.sequencer.awaitDecision<P>(key, authors === undefined ? {} : { authors });
  const mine = decider === "either" || decider === session.seat;
  let watcher: AfkWatcher | null = null;
  // The lines of the question are this player's own, not the run's: the partner does not see them (D27)
  const leavePrivate: (() => void)[] = [];
  const ask = (): Promise<P> => {
    leavePrivate.push(session.pace.enterPrivate());
    return request.ask();
  };
  try {
    if (mine) {
      ask()
        .then(payload => {
          if (link.epoch === epoch) {
            proposeUnlessLate(link, key, payload);
          }
        })
        .catch(error => reportBridgeError(error));
    } else {
      (request.wait ?? showWaitingForPartner)();
      watcher = watchForTakeover(link, request, ask);
    }
    const decision = await pending;
    watcher?.stop();
    if (!request.isPayload(decision.payload)) {
      throw new DesyncError("a sequenced decision has a payload this client cannot read", {
        actual: decision.key,
        seq: decision.seq,
      });
    }
    if (mine && decision.takeover === true && decision.author !== session.seat) {
      // The partner decided for this player while they were still choosing: the question goes away (D17)
      showTookOver();
    }
    return decision;
  } finally {
    watcher?.stop();
    for (const leave of leavePrivate) {
      leave();
    }
    session.openWindow = session.openWindow.filter(open => open !== key);
  }
}

/**
 * A failure inside the bridge: the clients can no longer be trusted to agree. A decision of a world that was reloaded is not a
 * failure (D18); the rest is loud, and a decision that does not fit makes the sequencer ask for a reload (D13).
 */
export function reportBridgeError(error: unknown): void {
  if (error instanceof EpochChangedError) {
    return;
  }
  console.error("co-op decision failed:", error);
  coopLog().error("error", "co-op decision failed", error);
  const session = getCoopSession();
  if (session !== null && session.desyncMessage === null) {
    session.desyncMessage = error instanceof Error ? error.message : String(error);
  }
}
