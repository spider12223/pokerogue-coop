import { audioManager } from "#app/global-audio-manager";
import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { activeOverrides } from "#app/overrides";
import { Phase } from "#app/phase";
import { arrangeCoopParty } from "#coop/arrange";
import { isLinked, reportBridgeError } from "#coop/bridge";
import { coopLog } from "#coop/coop-log";
import { closeStarterLobby, getStarterLobby } from "#coop/lobby";
import { interleaveStarters } from "#coop/ownership";
import type { StartPayload } from "#coop/protocol";
import { isCoop, requireCoopSession } from "#coop/session";
import { ownerSeat, simAccount } from "#coop/sim-account";
import { applyCoopRunSeed } from "#coop/sim-rng";
import { fromCoopStarter } from "#coop/starter-select-coop";
import { setTouchEmoteVisible } from "#coop/touch-emote";
import { SpeciesFormChangeMoveLearnedTrigger } from "#data/form-change-triggers";
import { Gender } from "#data/gender";
import { ChallengeType } from "#enums/challenge-type";
import { UiMode } from "#enums/ui-mode";
import { overrideHeldItems, overrideModifiers } from "#modifiers/modifier";
import type { Starter } from "#types/save-data";
import { SaveSlotUiMode } from "#ui/save-slot-select-ui-handler";
import { applyChallenges } from "#utils/challenge-utils";

export class SelectStarterPhase extends Phase {
  public readonly phaseName = "SelectStarterPhase";
  start() {
    super.start();

    audioManager.playBgm("menu");

    if (isLinked()) {
      this.startCoop();
      return;
    }

    globalScene.ui.setMode(UiMode.STARTER_SELECT, (starters: Starter[]) => {
      globalScene.ui.clearText();
      globalScene.ui.setMode(UiMode.SAVE_SLOT, SaveSlotUiMode.SAVE, (slotId: number) => {
        // If clicking cancel, back out to title screen
        if (slotId === -1) {
          globalScene.phaseManager.toTitleScreen();
          this.end();
          return;
        }
        globalScene.sessionSlotId = slotId;
        this.initBattle(starters);
      });
    });
  }

  /**
   * Co-op with a network (DECISIONS D3, D4, D7): both players pick at once on the same screen and press ready; the run
   * starts when the host's `START` arrives, with both parties and both accounts. The starter select does not call back
   * with the player's starters: in co-op, confirming only makes the player ready (`CoopStarterSelectController`).
   */
  private startCoop(): void {
    const lobby = getStarterLobby();
    if (lobby === null) {
      throw new Error("co-op: the starter select needs a lobby");
    }
    globalScene.ui.setMode(UiMode.STARTER_SELECT, () => undefined);
    const begin = (start: StartPayload): void => {
      try {
        this.startCoopRun(start);
      } catch (error) {
        reportBridgeError(error);
      }
    };
    if (lobby.startInfo === null) {
      const stop = lobby.onStart(start => {
        stop();
        begin(start);
      });
    } else {
      begin(lobby.startInfo);
    }
  }

  /** Both players are ready: build the party they picked, in the same order on both clients. */
  private startCoopRun(start: StartPayload): void {
    const session = requireCoopSession();
    const { starters, owners } = interleaveStarters(start.starters.host, start.starters.guest);
    coopLog().info("session", "the run starts", {
      host: start.starters.host.map(starter => starter.speciesId),
      guest: start.starters.guest.map(starter => starter.speciesId),
    });
    session.setRunSeed(start.runSeed);
    session.setAccountSnapshot(start.snapshots);
    session.setStarterOwners(owners);
    closeStarterLobby();
    globalScene.ui.clearText();
    // The battle message box still holds what the lobby last said
    globalScene.ui.getMessageHandler().showText("", 0);
    globalScene.ui.setMode(UiMode.MESSAGE);
    // The emote button works from the first battle on (it does nothing on the starter select)
    setTouchEmoteVisible(true);
    applyCoopRunSeed();
    globalScene.money = globalScene.gameMode.getStartingMoney();
    this.initBattle(starters.map(fromCoopStarter));
  }

  /**
   * Initialize starters before starting the first battle
   * @param starters - Array of {@linkcode Starter}s with which to start the battle
   */
  initBattle(starters: Starter[]) {
    const party = globalScene.getPlayerParty();
    const loadPokemonAssets: Promise<void>[] = [];
    starters.forEach((starter: Starter, i: number) => {
      if (!i && activeOverrides.STARTER_SPECIES_OVERRIDE) {
        starter.speciesId = activeOverrides.STARTER_SPECIES_OVERRIDE;
      }
      const species = speciesDataRegistry.getSpecies(starter.speciesId);
      let starterFormIndex = starter.formIndex;
      if (
        starter.speciesId in activeOverrides.STARTER_FORM_OVERRIDES
        && activeOverrides.STARTER_FORM_OVERRIDES[starter.speciesId] != null
        && species.forms[activeOverrides.STARTER_FORM_OVERRIDES[starter.speciesId]!]
      ) {
        starterFormIndex = activeOverrides.STARTER_FORM_OVERRIDES[starter.speciesId]!;
      }

      let starterGender =
        species.malePercent === null ? Gender.GENDERLESS : starter.female ? Gender.FEMALE : Gender.MALE;
      if (activeOverrides.GENDER_OVERRIDE !== null) {
        starterGender = activeOverrides.GENDER_OVERRIDE;
      }
      const starterPokemon = globalScene.addPlayerPokemon(
        species,
        globalScene.gameMode.getStartingLevel(),
        starter.abilityIndex,
        starterFormIndex,
        starterGender,
        starter.shiny,
        starter.variant,
        starter.ivs,
        starter.nature,
      );
      if (starter.moveset) {
        starterPokemon.tryPopulateMoveset(starter.moveset);
      }
      if (starter.passive) {
        starterPokemon.passive = true;
      }
      if (isCoop()) {
        // The owner first: the luck below reads the owner's dex
        const owner = requireCoopSession().starterOwners[i];
        if (owner === undefined) {
          throw new Error(`Starter ${i} has no owner`);
        }
        requireCoopSession().ownership.set(starterPokemon.id, owner);
      }
      starterPokemon.luck = globalScene.gameData.getDexAttrLuck(
        simAccount().getCaughtAttr(species.speciesId, ownerSeat(starterPokemon)),
      );
      if (starter.pokerus) {
        starterPokemon.pokerus = true;
      }

      if (starter.nickname) {
        starterPokemon.nickname = starter.nickname;
      }

      if (starter.teraType == null) {
        starterPokemon.teraType = starterPokemon.species.type1;
      } else {
        starterPokemon.teraType = starter.teraType;
      }

      if (globalScene.gameMode.isSplicedOnly || activeOverrides.STARTER_FUSION_OVERRIDE) {
        starterPokemon.generateFusionSpecies(true);
      }
      starterPokemon.setVisible(false);
      const chalApplied = applyChallenges(ChallengeType.STARTER_MODIFY, starterPokemon);
      party.push(starterPokemon);
      if (chalApplied) {
        // If any challenges modified the starter, it should update
        loadPokemonAssets.push(starterPokemon.updateInfo());
      }
      loadPokemonAssets.push(starterPokemon.loadAssets());
    });
    if (isCoop()) {
      // The two seats' Pokémon take the two slots (D7)
      arrangeCoopParty();
    }
    overrideModifiers();
    overrideHeldItems(party[0]);
    Promise.all(loadPokemonAssets).then(() => {
      audioManager.playBgm(undefined, true);
      if (globalScene.gameMode.isClassic) {
        globalScene.gameData.gameStats.classicSessionsPlayed++;
      } else {
        globalScene.gameData.gameStats.endlessSessionsPlayed++;
      }
      globalScene.newBattle();
      globalScene.arena.init();
      globalScene.sessionPlayTime = 0;
      globalScene.lastSavePlayTime = 0;
      // Ensures Keldeo (or any future Pokemon that have this type of form change) starts in the correct form
      globalScene.getPlayerParty().forEach(p => {
        globalScene.triggerPokemonFormChange(p, SpeciesFormChangeMoveLearnedTrigger);
      });
      this.end();
    });
  }
}
