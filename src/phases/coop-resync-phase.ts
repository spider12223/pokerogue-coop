/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { Phase } from "#app/phase";
import { reportBridgeError } from "#coop/bridge";
import type { Seat } from "#coop/protocol";
import type { ResyncPayload } from "#coop/resync";
import { beforeReload, showReloadFailed } from "#coop/resync-run";
import { queueRewardResume } from "#coop/reward-resume";
import { type CoopSession, getCoopSession, requireCoopSession } from "#coop/session";
import { coopText } from "#coop/text";
import { BattleType } from "#enums/battle-type";
import { UiMode } from "#enums/ui-mode";
import { fixedInt } from "#utils/common";

/** How long the notice of a reload stays up once the wave is loaded, so that the players can read it */
const NOTICE_MS = 1200;

/**
 * Both clients reload the wave start in the host's save (DECISIONS D13, D18, D20, D21): the retry path of a solo run (reset,
 * clear the phase queue, load the save, `EncounterPhase` with the loaded flag and the summon phases), in a co-op session that
 * keeps its link and its epoch. It replaces whatever was running (`PhaseManager.coopRestartWith`).
 */
export class CoopResyncPhase extends Phase {
  public readonly phaseName = "CoopResyncPhase";

  /**
   * @param back - Who came back since this client's last reload (`CoopLink.takeWhoCameBack`), for what a rejoin's notice
   * says (D20)
   */
  constructor(
    private readonly message: ResyncPayload,
    private readonly back: readonly Seat[] = [],
  ) {
    super();
  }

  public override start(): void {
    super.start();
    this.reload().catch(error => {
      console.error("co-op: reloading the wave failed:", error);
      reportBridgeError(error);
      const session = getCoopSession();
      if (session === null) {
        return;
      }
      session.reloading = false;
      // Nothing can go on from a wave that does not load: the player is told why and can only leave (D13)
      showReloadFailed(session, error instanceof Error ? error.message : String(error));
    });
  }

  /** Whether the save is a reward screen's (D19): the reload goes back to the rewards, not to the wave start */
  private atRewards(): boolean {
    try {
      return (JSON.parse(this.message.save) as { coop?: { resumeAt?: unknown } }).coop?.resumeAt !== undefined;
    } catch {
      return false;
    }
  }

  private noticeText(): string {
    const session = requireCoopSession();
    const wave = this.message.wave;
    if (this.message.reason === "rejoin") {
      return resyncNotice(this.message, this.atRewards(), this.back, session);
    }
    if (this.atRewards()) {
      switch (this.message.reason) {
        case "resume":
          return coopText("resyncResumeRewards", "Back to the rewards of wave {{wave}}.", { wave });
        case "retry":
          break;
        default:
          return coopText(
            "resyncMismatchRewards",
            "Your game and {{partner}}'s stopped matching. Reloading the rewards of wave {{wave}}.",
            { partner: session.partnerName, wave },
          );
      }
    }
    switch (this.message.reason) {
      case "resume":
        return coopText("resyncResume", "Resuming wave {{wave}} from its start.", { wave });
      case "retry":
        return coopText("resyncRetry", "Retrying the wave…");
      default:
        return coopText(
          "resyncMismatch",
          "Your game and {{partner}}'s stopped matching. Reloading the start of wave {{wave}}.",
          { partner: session.partnerName, wave },
        );
    }
  }

  private async reload(): Promise<void> {
    const { ui } = globalScene;
    const session = requireCoopSession();
    beforeReload();
    session.timing["reloadStartedAt"] = Date.now();
    await ui.setMode(UiMode.MESSAGE);
    ui.resetModeChain();
    ui.showText(this.noticeText(), null, undefined, null, false);

    globalScene.reset();
    await globalScene.gameData.loadCoopSession(this.message.save);
    // The save that was loaded is the wave start of this epoch: a second reload goes back to it, on either client (D13, D19)
    session.waveSave = { wave: this.message.wave, epoch: this.message.epoch, json: this.message.save };

    const { phaseManager } = globalScene;
    const resume = session.resumeAt;
    session.resumeAt = null;
    if (resume !== null) {
      // A reward-screen save: back to that screen and what follows it (D19)
      queueRewardResume(resume);
      await this.finish(session);
      return;
    }
    phaseManager.pushNew("EncounterPhase", true);
    const available = globalScene.getPokemonAllowedInBattle().length;
    const { currentBattle } = globalScene;
    phaseManager.pushNew("SummonPhase", 0, true, true);
    if (currentBattle.double && available > 1) {
      phaseManager.pushNew("SummonPhase", 1, true, true);
    }
    // The third of ours, in a game of three (D40)
    if (currentBattle.playerSlots === 3 && available > 2) {
      phaseManager.pushNew("SummonPhase", 2, true, true);
    }
    if (currentBattle.battleType !== BattleType.TRAINER && currentBattle.waveIndex > 1) {
      const minPartySize = currentBattle.double ? 2 : 1;
      if (available > minPartySize) {
        phaseManager.pushNew("CheckSwitchPhase", 0, currentBattle.double);
        if (currentBattle.double) {
          phaseManager.pushNew("CheckSwitchPhase", 1, currentBattle.double);
        }
      }
    }

    await this.finish(session);
  }

  /** The wave is loaded: the notice stays a moment, and the run goes on */
  private async finish(session: ReturnType<typeof requireCoopSession>): Promise<void> {
    session.timing["reloadedAt"] = Date.now();
    await new Promise<void>(resolve => globalScene.time.delayedCall(fixedInt(NOTICE_MS), resolve));
    globalScene.ui.clearText();
    session.reloading = false;
    this.end();
  }
}

/**
 * What the reload after a return says (D20): the player who came back is told they are back; the others are told who came
 * back, by seat in a game of three (D40). With nobody known to have come back, only where the run goes on.
 * @param back - Who came back since this client's last reload, its own seat too
 */
export function resyncNotice(
  message: Pick<ResyncPayload, "wave">,
  atRewards: boolean,
  back: readonly Seat[],
  session: Pick<CoopSession, "seat" | "nameOf">,
): string {
  const { wave } = message;
  const where = atRewards
    ? coopText("resyncResumeRewards", "Back to the rewards of wave {{wave}}.", { wave })
    : coopText("resyncResume", "Resuming wave {{wave}} from its start.", { wave });
  if (back.includes(session.seat)) {
    return `${coopText("resyncYouAreBack", "You're back.")} ${where}`;
  }
  const others = back.map(seat => session.nameOf(seat));
  if (others.length === 0) {
    return where;
  }
  const who =
    others.length === 1
      ? coopText("resyncIsBack", "{{partner}} is back.", { partner: others[0] })
      : coopText("resyncAreBack", "{{partners}} are back.", { partners: others.join(" & ") });
  return `${who} ${where}`;
}
