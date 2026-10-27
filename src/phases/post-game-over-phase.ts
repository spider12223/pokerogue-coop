import { globalScene } from "#app/global-scene";
import { Phase } from "#app/phase";
import { coopText } from "#coop/bridge";
import { leaveCoop } from "#coop/lobby";
import { removeCoopSlot } from "#coop/wave-save";
import type { EndCardPhase } from "#phases/end-card-phase";

export class PostGameOverPhase extends Phase {
  public readonly phaseName = "PostGameOverPhase";
  private endCardPhase?: EndCardPhase | undefined;
  private slotId: number;

  constructor(slotId: number, endCardPhase?: EndCardPhase) {
    super();
    this.slotId = slotId;
    this.endCardPhase = endCardPhase;
  }

  /**
   * A co-op run is over (DECISIONS D4a): the account is saved, but never a session (a co-op run must not take a solo
   * slot), the co-op session ends, and both clients go back to the title screen with a message.
   */
  private endCoopRun(): void {
    const { ui } = globalScene;
    globalScene.gameData
      .saveSystem()
      // The game over faded the screen to black: the message is under that until it fades back in
      .then(() => ui.fadeIn(500))
      .then(() => {
        ui.showText(
          coopText("runEnded", "Co-op run ended"),
          null,
          () => {
            removeCoopSlot();
            leaveCoop();
            globalScene.reset();
            globalScene.phaseManager.unshiftNew("TitlePhase");
            this.end();
          },
          2500,
        );
      });
  }

  start() {
    super.start();

    if (globalScene.gameMode.isCoop) {
      this.endCoopRun();
      return;
    }

    const saveAndReset = () => {
      globalScene.gameData.saveAll(true, true, true).then(success => {
        if (!success) {
          return globalScene.reset(true);
        }
        globalScene.gameData.tryClearSession(this.slotId).then(([success]) => {
          if (!success) {
            return globalScene.reset(true);
          }
          globalScene.reset();
          globalScene.phaseManager.unshiftNew("TitlePhase");
          this.end();
        });
      });
    };

    if (this.endCardPhase) {
      globalScene.ui.fadeOut(500).then(() => {
        globalScene.ui.getMessageHandler().bg.setVisible(true);

        this.endCardPhase?.endCard.destroy();
        this.endCardPhase?.text.destroy();
        saveAndReset();
      });
    } else {
      saveAndReset();
    }
  }
}
