import { globalScene } from "#app/global-scene";
import { isLinked } from "#coop/decisions/bridge";
import { allMoves } from "#data/data-lists";
import { type BattlerIndex, playerBattlerOf } from "#enums/battler-index";
import { Command } from "#enums/command";
import { UiMode } from "#enums/ui-mode";
import { PokemonPhase } from "#phases/pokemon-phase";

export class SelectTargetPhase extends PokemonPhase {
  public readonly phaseName = "SelectTargetPhase";

  constructor(fieldIndex: number) {
    super(fieldIndex);
  }

  start() {
    super.start();

    const turnCommand = globalScene.currentBattle.turnCommands[this.battlerIndex];
    const moveId = turnCommand?.move?.move;
    if (!moveId) {
      this.end();
      return;
    }

    // TODO: Move the logic for computing default targets here instead of `target-select-ui-handler`
    const move = allMoves[moveId];
    const fieldSide = globalScene.getField();

    const user = this.getPokemon();
    // (the first ally in field order that has not fainted, in a battle of three of ours: co-op D40)
    const ally = user.getAllies().find(other => !other.isFainted());
    const shouldDefaultToAlly =
      globalScene.currentBattle.double // formatting
      && move.allyTargetDefault
      && ally != null
      && !ally.isFainted();
    const defaultTargets = shouldDefaultToAlly ? [ally.getBattlerIndex()] : undefined;

    globalScene.ui.setMode(
      UiMode.TARGET_SELECT,
      this.fieldIndex,
      move.id,
      (targets: BattlerIndex[]) => {
        globalScene.ui.setMode(UiMode.MESSAGE);
        // Find any tags blocking this target from being selected
        // TODO: Denest and make less jank

        // TODO: when would this occur?
        if (targets[0]) {
          const restrictingTag = user.getTargetRestrictingTag(moveId, fieldSide[targets[0]]);
          if (restrictingTag) {
            globalScene.phaseManager.queueMessage(restrictingTag.selectionDeniedText(user, moveId));
            targets = [];
          }
        }

        if (targets.length === 0) {
          globalScene.currentBattle.turnCommands[this.battlerIndex] = null;
          globalScene.phaseManager.unshiftNew("CommandPhase", this.fieldIndex);
        } else {
          turnCommand.targets = targets;
        }
        if (turnCommand.command === Command.BALL && this.fieldIndex && !isLinked()) {
          globalScene.currentBattle.turnCommands[playerBattlerOf(this.fieldIndex - 1)]!.skip = true;
        }
        this.end();
      },
      defaultTargets,
    );
  }
}
