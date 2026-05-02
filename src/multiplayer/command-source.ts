import { globalScene } from "#app/global-scene";
import type { PlayerSlot } from "#app/multiplayer/input-role";
import { UiMode } from "#enums/ui-mode";
import type { CommandPhase } from "#phases/command-phase";

export interface CommandSource {
  readonly playerSlot: PlayerSlot;
  readonly kind: "local-ui" | "network";
  requestCommand(phase: CommandPhase): void;
  cancelPending(): void;
}

export class LocalUiCommandSource implements CommandSource {
  public readonly kind = "local-ui" as const;

  constructor(public readonly playerSlot: PlayerSlot) {}

  requestCommand(phase: CommandPhase): void {
    const fieldIndex = phase.getFieldIndex();
    const battle = globalScene.currentBattle;
    if (battle.isBattleMysteryEncounter() && battle.mysteryEncounter?.skipToFightInput) {
      globalScene.ui.clearText();
      globalScene.ui.setMode(UiMode.FIGHT, fieldIndex);
    } else {
      globalScene.ui.setMode(UiMode.COMMAND, fieldIndex);
    }
  }

  cancelPending(): void {}
}
