/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { Phase } from "#app/phase";
import { reportBridgeError } from "#coop/bridge";
import type { ResyncPayload } from "#coop/resync";
import { beforeReload, showReloadFailed } from "#coop/resync-run";
import { getCoopSession, requireCoopSession } from "#coop/session";
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

  constructor(private readonly message: ResyncPayload) {
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

  private noticeText(): string {
    const session = requireCoopSession();
    const wave = this.message.wave;
    switch (this.message.reason) {
      case "rejoin":
        return coopText("resyncRejoin", "{{partner}} is back. Resuming wave {{wave}} from its start.", {
          partner: session.partnerName,
          wave,
        });
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
    phaseManager.pushNew("EncounterPhase", true);
    const available = globalScene.getPokemonAllowedInBattle().length;
    const { currentBattle } = globalScene;
    phaseManager.pushNew("SummonPhase", 0, true, true);
    if (currentBattle.double && available > 1) {
      phaseManager.pushNew("SummonPhase", 1, true, true);
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

    session.timing["reloadedAt"] = Date.now();
    await new Promise<void>(resolve => globalScene.time.delayedCall(fixedInt(NOTICE_MS), resolve));
    ui.clearText();
    session.reloading = false;
    this.end();
  }
}
