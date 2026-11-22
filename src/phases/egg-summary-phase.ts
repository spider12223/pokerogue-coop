import { audioManager } from "#app/global-audio-manager";
import { globalScene } from "#app/global-scene";
import { Phase } from "#app/phase";
import { coopDecide, isLinked, reportBridgeError } from "#coop/decisions/bridge";
import { eggSummaryKey } from "#coop/decisions/decision-keys";
import { seatsFor } from "#coop/protocol";
import { isCoop, requireCoopSession } from "#coop/session";
import { coopText } from "#coop/ui/text";
import { showWaitingLine } from "#coop/ui/waiting-line";
import type { EggHatchData } from "#data/egg-hatch-data";
import { UiMode } from "#enums/ui-mode";

/** Co-op (D30): how long a wait for a guest's summary shows no line (a guest with nothing hatched answers at once) */
const COOP_WAIT_LINE_MS = 1000;

/**
 * Class that represents the egg summary phase
 * It does some of the function for updating egg data
 * Phase is handled mostly by the egg-hatch-scene-handler UI
 */
export class EggSummaryPhase extends Phase {
  public readonly phaseName = "EggSummaryPhase";
  private eggHatchData: EggHatchData[];
  /** The summary is on screen: in co-op it comes only on a client where something hatched (D30) */
  private shown = false;
  private ended = false;
  /** Co-op with a network: this player closed their summary; the phase goes on once every guest closed theirs (D30) */
  private onClosed: (() => void) | null = null;

  constructor(eggHatchData: EggHatchData[]) {
    super();
    this.eggHatchData = eggHatchData;
  }

  public override async start(): Promise<void> {
    super.start();

    if (isLinked()) {
      const closed = new Promise<void>(resolve => {
        this.onClosed = resolve;
      });
      this.waitForGuests(closed)
        .then(() => {
          // (a take over closed this guest's summary, D17: there is no press left to wait for)
          this.onClosed = null;
          this.end();
        })
        .catch(reportBridgeError);
    }

    if (isCoop() && this.eggHatchData.length === 0) {
      this.end();
      return;
    }

    for (const eggHatchData of this.eggHatchData) {
      eggHatchData.setDex();
      await eggHatchData.updatePokemon();
    }
    if (this.ended) {
      return;
    }

    this.shown = true;
    await globalScene.ui.setModeForceTransition(UiMode.EGG_HATCH_SUMMARY, this.eggHatchData);
    audioManager.fadeOutBgm();
  }

  /**
   * Co-op with a network (D30): each guest's summary holds the run until they close it, or are taken over for (D17). The
   * others wait, with a line once their own summary is closed. The host's summary holds only the host: the guests wait at
   * the next decision, which the host has not reached.
   * @param closed - This player's summary is closed (at once if nothing hatched here)
   */
  private async waitForGuests(closed: Promise<void>): Promise<void> {
    const session = requireCoopSession();
    const wave = globalScene.currentBattle.waveIndex;
    const occurrence = session.nextOccurrence(wave, "eggSummary");
    // One after the other in seat order on every client, so that the sequence is the same on all: the second guest's
    // close may come first, and waits at the host
    for (const seat of seatsFor(session.players).filter(seat => seat !== "host")) {
      let over = false;
      await coopDecide<null>({
        key: eggSummaryKey(wave, seat, occurrence),
        decider: seat,
        ask: () => closed.then(() => null),
        wait: () =>
          void closed.then(() =>
            globalScene.time.delayedCall(COOP_WAIT_LINE_MS, () => {
              if (!over) {
                showWaitingLine(
                  coopText("eggsLooking", "{{name}} is looking at their eggs…", { name: session.nameOf(seat) }),
                );
              }
            }),
          ),
        isPayload: (payload): payload is null => payload === null,
      });
      over = true;
    }
    if (session.isHost) {
      await closed;
    }
  }

  public override end(): void {
    if (this.ended) {
      return;
    }
    const closed = this.onClosed;
    if (closed !== null) {
      this.onClosed = null;
      void this.hideSummary().then(closed);
      return;
    }
    this.ended = true;
    if (this.shown) {
      void this.hideSummary().then(() => super.end());
    } else {
      super.end();
    }
  }

  /** Take the summary off the screen: its Pokémon go, and the held items come back */
  private async hideSummary(): Promise<void> {
    if (!this.shown) {
      return;
    }
    this.shown = false;
    this.eggHatchData.forEach(data => {
      data.pokemon?.destroy();
    });
    this.eggHatchData = [];
    globalScene.time.delayedCall(250, () => globalScene.setModifiersVisible(true));
    await globalScene.ui.setModeForceTransition(UiMode.MESSAGE);
  }
}
