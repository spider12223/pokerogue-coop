import { audioManager } from "#app/global-audio-manager";
import { globalScene } from "#app/global-scene";
import { Phase } from "#app/phase";
import { whenCoopBehind } from "#coop/pace-run";
import { isCoop } from "#coop/session";
import type { EggHatchData } from "#data/egg-hatch-data";
import { UiMode } from "#enums/ui-mode";

/** Co-op (D30): how long the guest's summary stays at least, before it gives way to the host being past it */
const COOP_SUMMARY_MIN_MS = 3000;

/**
 * Class that represents the egg summary phase
 * It does some of the function for updating egg data
 * Phase is handled mostly by the egg-hatch-scene-handler UI
 */
export class EggSummaryPhase extends Phase {
  public readonly phaseName = "EggSummaryPhase";
  private eggHatchData: EggHatchData[];
  /** Co-op: nothing hatched on this client; the phase only keeps both clients' phases the same (D30) */
  private quiet = false;
  private ended = false;

  constructor(eggHatchData: EggHatchData[]) {
    super();
    this.eggHatchData = eggHatchData;
  }

  public override async start(): Promise<void> {
    super.start();

    if (isCoop() && this.eggHatchData.length === 0) {
      this.quiet = true;
      this.end();
      return;
    }

    for (const eggHatchData of this.eggHatchData) {
      eggHatchData.setDex();
      await eggHatchData.updatePokemon();
    }

    await globalScene.ui.setModeForceTransition(UiMode.EGG_HATCH_SUMMARY, this.eggHatchData);
    audioManager.fadeOutBgm();
    if (isCoop()) {
      // The guest's own hatches do not hold the run up: once it was seen a moment, it closes when the host is past it
      globalScene.time.delayedCall(COOP_SUMMARY_MIN_MS, () => whenCoopBehind(() => this.end()));
    }
  }

  public override end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    if (this.quiet) {
      super.end();
      return;
    }
    this.eggHatchData.forEach(data => {
      data.pokemon?.destroy();
    });
    this.eggHatchData = [];
    globalScene.time.delayedCall(250, () => globalScene.setModifiersVisible(true));
    globalScene.ui.setModeForceTransition(UiMode.MESSAGE).then(() => {
      super.end();
    });
  }
}
