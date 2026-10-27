import { globalScene } from "#app/global-scene";
import { isLinked } from "#coop/bridge";
import { coopCheckpoint } from "#coop/checkpoints";
import { BattlerIndex } from "#enums/battler-index";
import { TurnInitEvent } from "#events/battle-scene";
import type { PlayerPokemon } from "#field/pokemon";
import {
  handleMysteryEncounterBattleStartEffects,
  handleMysteryEncounterTurnStartEffects,
} from "#mystery-encounters/encounter-phase-utils";
import { FieldPhase } from "#phases/field-phase";
import i18next from "i18next";

export class TurnInitPhase extends FieldPhase {
  public readonly phaseName = "TurnInitPhase";
  start() {
    super.start();
    coopCheckpoint("turn", this.phaseName);

    globalScene.getPlayerField().forEach(p => {
      // If this pokemon is in play and evolved into something illegal under the current challenge, force a switch
      if (p.isOnField() && !p.isAllowedInBattle()) {
        globalScene.phaseManager.queueMessage(
          i18next.t("challenges:illegalEvolution", { pokemon: p.name }),
          null,
          true,
        );

        const allowedPokemon = globalScene.getPokemonAllowedInBattle();

        if (allowedPokemon.length === 0) {
          // If there are no longer any legal pokemon in the party, game over.
          globalScene.phaseManager.clearPhaseQueue();
          globalScene.phaseManager.unshiftNew("GameOverPhase");
        } else if (
          allowedPokemon.length >= globalScene.currentBattle.getBattlerCount()
          || (globalScene.currentBattle.double && !allowedPokemon[0].isActive(true))
        ) {
          // If there is at least one pokemon in the back that is legal to switch in, force a switch.
          p.switchOut();
        } else {
          // If there are no pokemon in the back but we're not game overing, just hide the pokemon.
          // This should only happen in double battles.
          p.leaveField();
        }
        if (allowedPokemon.length === 1 && globalScene.currentBattle.double) {
          globalScene.phaseManager.unshiftNew("ToggleDoublePositionPhase", true);
        }
      }
    });

    globalScene.eventTarget.dispatchEvent(new TurnInitEvent());

    handleMysteryEncounterBattleStartEffects();

    // If true, will skip remainder of current phase (and not queue CommandPhases etc.)
    if (handleMysteryEncounterTurnStartEffects()) {
      this.end();
      return;
    }

    // Co-op (D8): the commands of both players are collected after the command phases, before the enemies choose
    let commandsSynced = !isLinked();
    const syncCommands = (): void => {
      if (!commandsSynced) {
        commandsSynced = true;
        globalScene.phaseManager.pushNew("CoopTurnSyncPhase");
      }
    };
    globalScene.getField().forEach((pokemon, i) => {
      if (pokemon?.isActive()) {
        if (pokemon.isPlayer()) {
          globalScene.currentBattle.addParticipant(pokemon as PlayerPokemon);
        }

        pokemon.resetTurnData();

        if (pokemon.isPlayer()) {
          globalScene.phaseManager.pushNew("CommandPhase", i);
        } else {
          syncCommands();
          globalScene.phaseManager.pushNew("EnemyCommandPhase", i - BattlerIndex.ENEMY);
        }
      }
    });
    syncCommands();

    globalScene.phaseManager.pushNew("TurnStartPhase");

    this.end();
  }
}
