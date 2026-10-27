import { audioManager } from "#app/global-audio-manager";
import { globalScene } from "#app/global-scene";
import { Phase } from "#app/phase";
import { arrangeCoopParty } from "#coop/arrange";
import { isLinked, reportBridgeError } from "#coop/bridge";
import { getCosmeticView } from "#coop/cosmetic-view";
import {
  askWhoGoes,
  beginCoopEncounter,
  choosableOptions,
  isOnePokemonEncounter,
  meDecide,
  queueLoneEnemyBoost,
  showChooserWaiting,
} from "#coop/me-run";
import { isCoop } from "#coop/session";
import { getCharVariantFromDialogue } from "#data/dialogue";
import { ArenaTagSide } from "#enums/arena-tag-side";
import { BattlerTagLapseType } from "#enums/battler-tag-lapse-type";
import { BattlerTagType } from "#enums/battler-tag-type";
import { MysteryEncounterMode } from "#enums/mystery-encounter-mode";
import { SwitchType } from "#enums/switch-type";
import { TrainerSlot } from "#enums/trainer-slot";
import { UiMode } from "#enums/ui-mode";
import { IvScannerModifier } from "#modifiers/modifier";
import { getEncounterText } from "#mystery-encounters/encounter-dialogue-utils";
import type { OptionSelectSettings } from "#mystery-encounters/encounter-phase-utils";
import {
  leaveEncounterWithoutBattle,
  transitionMysteryEncounterIntroVisuals,
} from "#mystery-encounters/encounter-phase-utils";
import type { MysteryEncounterOption, OptionPhaseCallback } from "#mystery-encounters/mystery-encounter-option";
import { SeenEncounterData } from "#mystery-encounters/mystery-encounter-save-data";
import type { MysteryEncounterUiHandler } from "#ui/mystery-encounter-ui-handler";
import { randSeedItem } from "#utils/common";
import { inSpeedOrder } from "#utils/speed-order-generator";
import i18next from "i18next";

/**
 * Will handle (in order):
 * - Clearing of phase queues to enter the Mystery Encounter game state
 * - Management of session data related to MEs
 * - Initialization of ME option select menu and UI
 * - Execute {@linkcode MysteryEncounter.onPreOptionPhase} logic if it exists for the selected option
 * - Display any `OptionTextDisplay.selected` type dialogue that is set in the {@linkcode MysteryEncounterDialogue} dialogue tree for selected option
 * - Queuing of the {@linkcode MysteryEncounterOptionSelectedPhase}
 */
export class MysteryEncounterPhase extends Phase {
  public readonly phaseName = "MysteryEncounterPhase";
  private readonly FIRST_DIALOGUE_PROMPT_DELAY = 300;
  optionSelectSettings?: OptionSelectSettings | undefined;

  /**
   * Mostly useful for having repeated queries during a single encounter, where the queries and options may differ each time
   * @param optionSelectSettings allows overriding the typical options of an encounter with new ones
   */
  constructor(optionSelectSettings?: OptionSelectSettings) {
    super();
    this.optionSelectSettings = optionSelectSettings;
  }

  /**
   * Updates seed offset, sets seen encounter session data, sets UI mode
   */
  start() {
    super.start();

    // Clears out queued phases that are part of standard battle
    globalScene.phaseManager.clearPhaseQueue();

    const encounter = globalScene.currentBattle.mysteryEncounter!;
    encounter.updateSeedOffset();

    if (!this.optionSelectSettings) {
      // Sets flag that ME was encountered, only if this is not a followup option select phase
      // Can be used in later MEs to check for requirements to spawn, run history, etc.
      globalScene.mysteryEncounterSaveData.encounteredEvents.push(
        new SeenEncounterData(encounter.encounterType, encounter.encounterTier, globalScene.currentBattle.waveIndex),
      );
      if (isLinked()) {
        beginCoopEncounter();
        if (isOnePokemonEncounter(encounter.encounterType)) {
          // Co-op (D29): only one Pokémon takes part; the host first decides who goes, or that nobody does
          askWhoGoes(encounter.encounterType)
            .then(seat => (seat === null ? this.coopLeave() : this.showOptions()))
            .catch(reportBridgeError);
          return;
        }
      }
    }

    this.showOptions();
  }

  /** Initiates encounter dialogue window and option select */
  private showOptions(): void {
    const shown = globalScene.ui.setMode(UiMode.MYSTERY_ENCOUNTER, this.optionSelectSettings);
    if (isLinked()) {
      // Co-op (D29): the chooser picks the option, as a sequenced decision that both clients carry out
      shown.then(() => this.coopChooseOption());
    }
  }

  /** Co-op (D29): nobody goes in a one-Pokémon encounter: it is left without a battle, and its shop of healing items opens */
  private async coopLeave(): Promise<void> {
    await transitionMysteryEncounterIntroVisuals(true, true);
    leaveEncounterWithoutBattle(true);
    this.end();
  }

  /** Co-op: the answer to the open option decision, while this client is the one who picks (or takes it over, D17) */
  private coopAnswer: ((index: number) => void) | null = null;

  /** Co-op (D29): ask the chooser which option; both clients carry it out, and ask again if it led back here */
  private coopChooseOption(): void {
    const encounter = globalScene.currentBattle.mysteryEncounter!;
    const options = this.optionSelectSettings?.overrideOptions ?? encounter.options;
    meDecide(
      { k: "option", enabled: choosableOptions(options) },
      () =>
        new Promise(resolve => {
          this.coopAnswer = index => resolve({ k: "option", index });
          // the encounter's question again (a taker waited a moment ago, D17), and the partner's screen follows this
          // player's cursor from where it is now
          if (globalScene.ui.mode === UiMode.MYSTERY_ENCOUNTER) {
            const handler = globalScene.ui.getHandler() as MysteryEncounterUiHandler;
            handler.setWaitingLine(null);
            handler.announceCursor();
          }
        }),
      // the other player keeps the screen, read-only, and its cursor follows the chooser's
      () => {
        showChooserWaiting();
        getCosmeticView()?.drawMeCursor();
      },
    )
      .then(({ index }) => {
        this.coopAnswer = null;
        if (!this.handleOptionSelect(options[index], index)) {
          this.coopChooseOption();
        }
      })
      .catch(reportBridgeError);
  }

  /** Co-op: whether this client picks the open option decision (the chooser, or a taker, D17) */
  public coopChoosing(): boolean {
    return this.coopAnswer !== null;
  }

  /**
   * Co-op: this player picked option `index` on the screen.
   * @returns Whether it counts: only the chooser's pick does (or a taker's, D17)
   */
  public coopPick(index: number): boolean {
    const answer = this.coopAnswer;
    if (answer === null) {
      return false;
    }
    this.coopAnswer = null;
    answer(index);
    return true;
  }

  /**
   * Triggers after a player selects an option for the encounter
   * @param option
   * @param index
   */
  handleOptionSelect(option: MysteryEncounterOption, index: number): boolean {
    // Set option selected flag
    globalScene.currentBattle.mysteryEncounter!.selectedOption = option;

    if (!this.optionSelectSettings) {
      // Saves the selected option in the ME save data, only if this is not a followup option select phase
      // Can be used for analytics purposes to track what options are popular on certain encounters
      const encounterSaveData = globalScene.mysteryEncounterSaveData.encounteredEvents.at(-1)!;
      if (encounterSaveData.type === globalScene.currentBattle.mysteryEncounter?.encounterType) {
        encounterSaveData.selectedOption = index;
      }
    }

    if (!option.onOptionPhase) {
      return false;
    }

    // Populate dialogue tokens for option requirements
    globalScene.currentBattle.mysteryEncounter!.populateDialogueTokensFromRequirements();

    if (option.onPreOptionPhase) {
      globalScene.executeWithSeedOffset(async () => {
        const preOption = option.onPreOptionPhase!().then(result => {
          if (result == null || result) {
            this.continueEncounter();
          } else if (isLinked()) {
            // Co-op (D29): the chooser went back to the options: a new decision
            this.coopChooseOption();
          }
        });
        // Co-op: a decision of a world that was reloaded rejects (D18); anything else is reported
        return await (isLinked() ? preOption.catch(reportBridgeError) : preOption);
      }, globalScene.currentBattle.mysteryEncounter?.getSeedOffset());
    } else {
      this.continueEncounter();
    }

    return true;
  }

  /**
   * Queues {@linkcode MysteryEncounterOptionSelectedPhase}, displays option.selected dialogue and ends phase
   */
  continueEncounter() {
    const endDialogueAndContinueEncounter = () => {
      globalScene.phaseManager.pushNew("MysteryEncounterOptionSelectedPhase");
      this.end();
    };

    const optionSelectDialogue = globalScene.currentBattle?.mysteryEncounter?.selectedOption?.dialogue;
    if (optionSelectDialogue?.selected && optionSelectDialogue.selected.length > 0) {
      // Handle intermediate dialogue (between player selection event and the onOptionSelect logic)
      globalScene.ui.setMode(UiMode.MESSAGE);
      const selectedDialogue = optionSelectDialogue.selected;
      let i = 0;
      const showNextDialogue = () => {
        const nextAction = i === selectedDialogue.length - 1 ? endDialogueAndContinueEncounter : showNextDialogue;
        const dialogue = selectedDialogue[i];
        let title: string | null = null;
        const text: string | null = getEncounterText(dialogue.text);
        if (dialogue.speaker) {
          title = getEncounterText(dialogue.speaker);
        }

        i++;
        if (title) {
          globalScene.ui.showDialogue(
            text ?? "",
            title,
            null,
            nextAction,
            0,
            i === 1 ? this.FIRST_DIALOGUE_PROMPT_DELAY : 0,
          );
        } else {
          globalScene.ui.showText(text ?? "", null, nextAction, i === 1 ? this.FIRST_DIALOGUE_PROMPT_DELAY : 0, true);
        }
      };

      showNextDialogue();
    } else {
      endDialogueAndContinueEncounter();
    }
  }

  /**
   * Ends phase
   */
  end() {
    globalScene.ui.setMode(UiMode.MESSAGE).then(() => super.end());
  }
}

/**
 * Will handle (in order):
 * - Execute {@linkcode MysteryEncounter.onOptionSelect} logic if it exists for the selected option
 *
 * It is important to point out that no phases are directly queued by any logic within this phase
 * Any phase that is meant to follow this one MUST be queued via the onOptionSelect() logic of the selected option
 */
export class MysteryEncounterOptionSelectedPhase extends Phase {
  public readonly phaseName = "MysteryEncounterOptionSelectedPhase";
  onOptionSelect: OptionPhaseCallback;

  constructor() {
    super();
    this.onOptionSelect = globalScene.currentBattle.mysteryEncounter!.selectedOption!.onOptionPhase;
  }

  /**
   * Will handle (in order):
   * - Execute {@linkcode MysteryEncounter.onOptionSelect} logic if it exists for the selected option
   *
   * It is important to point out that no phases are directly queued by any logic within this phase.
   * Any phase that is meant to follow this one MUST be queued via the {@linkcode MysteryEncounter.onOptionSelect} logic of the selected option.
   */
  start() {
    super.start();
    if (globalScene.currentBattle.mysteryEncounter?.autoHideIntroVisuals) {
      transitionMysteryEncounterIntroVisuals().then(() => {
        globalScene.executeWithSeedOffset(() => {
          this.runOption();
        }, globalScene.currentBattle.mysteryEncounter?.getSeedOffset() * 500);
      });
    } else {
      globalScene.executeWithSeedOffset(() => {
        this.runOption();
      }, globalScene.currentBattle.mysteryEncounter?.getSeedOffset() * 500);
    }
  }

  private runOption(): void {
    const done = this.onOptionSelect().finally(() => {
      this.end();
    });
    // Co-op: a decision of a world that was reloaded rejects (D18); anything else is reported
    if (isLinked()) {
      done.catch(reportBridgeError);
    }
  }
}

/**
 * Runs at the beginning of an Encounter's battle
 * Will clean up any residual flinches, Endure, etc. that are left over from {@linkcode MysteryEncounter.startOfBattleEffects}
 * Will also handle Game Overs, switches, etc. that could happen from {@linkcode handleMysteryEncounterBattleStartEffects}
 * See {@linkcode TurnEndPhase} for more details
 */
export class MysteryEncounterBattleStartCleanupPhase extends Phase {
  public readonly phaseName = "MysteryEncounterBattleStartCleanupPhase";
  /**
   * Cleans up `TURN_END` tags, any {@linkcode PostTurnStatusEffectPhase}s, checks for Pokemon switches, then continues
   */
  start() {
    super.start();

    // Lapse any residual flinches/endures but ignore all other turn-end battle tags
    const includedLapseTags = [BattlerTagType.FLINCHED, BattlerTagType.ENDURING];
    for (const pokemon of inSpeedOrder(ArenaTagSide.BOTH)) {
      const tags = pokemon.summonData.tags;
      tags
        .filter(
          t =>
            includedLapseTags.includes(t.tagType)
            && t.lapseTypes.includes(BattlerTagLapseType.TURN_END)
            && !t.lapse(pokemon, BattlerTagLapseType.TURN_END),
        )
        .forEach(t => {
          t.onRemove(pokemon);
          tags.splice(tags.indexOf(t), 1);
        });
    }

    // Remove any status tick phases
    globalScene.phaseManager.removeAllPhasesOfType("PostTurnStatusEffectPhase");

    // The total number of Pokemon in the player's party that can legally fight
    const legalPlayerPokemon = globalScene.getPokemonAllowedInBattle();
    // The total number of legal player Pokemon that aren't currently on the field
    const legalPlayerPartyPokemon = legalPlayerPokemon.filter(p => !p.isActive(true));
    if (legalPlayerPokemon.length === 0) {
      globalScene.phaseManager.unshiftNew("GameOverPhase");
      return this.end();
    }

    // Check for any KOd player mons and switch
    // For each fainted mon on the field, if there is a legal replacement, summon it
    const playerField = globalScene.getPlayerField();
    playerField.forEach((pokemon, i) => {
      if (!pokemon.isAllowedInBattle() && legalPlayerPartyPokemon.length > i) {
        globalScene.phaseManager.unshiftNew("SwitchPhase", SwitchType.SWITCH, i, true, false);
      }
    });

    // THEN, if is a double battle, and player only has 1 summoned pokemon, center pokemon on field
    if (globalScene.currentBattle.double && legalPlayerPokemon.length === 1 && legalPlayerPartyPokemon.length === 0) {
      globalScene.phaseManager.unshiftNew("ToggleDoublePositionPhase", true);
    }

    for (const pokemon of globalScene.getField(true)) {
      pokemon.resetTurnData();
    }

    this.end();
  }
}

/**
 * Will handle (in order):
 * - Setting BGM
 * - Showing intro dialogue for an enemy trainer or wild Pokemon
 * - Sliding in the visuals for enemy trainer or wild Pokemon, as well as handling summoning animations
 * - Queue the {@linkcode SummonPhase}s, {@linkcode PostSummonPhase}s, etc., required to initialize the phase queue for a battle
 */
export class MysteryEncounterBattlePhase extends Phase {
  public readonly phaseName = "MysteryEncounterBattlePhase";
  disableSwitch: boolean;

  constructor(disableSwitch = false) {
    super();
    this.disableSwitch = disableSwitch;
  }

  /**
   * Sets up a ME battle
   */
  start() {
    super.start();

    // Co-op (D7, D29): what the encounter did to the party (a Pokémon taken, one added) may have moved the leads. The
    // party is off the field before an encounter's battle, so the arrange step only reorders it.
    if (isCoop() && !globalScene.getPlayerParty().some(pokemon => pokemon.isOnField())) {
      arrangeCoopParty();
    }

    this.doMysteryEncounterBattle();
  }

  /** Get intro battle message for new battle */
  private getBattleMessage(): string {
    const enemyField = globalScene.getEnemyField();
    const encounterMode = globalScene.currentBattle.mysteryEncounter!.encounterMode;

    if (globalScene.currentBattle.isClassicFinalBoss) {
      return i18next.t("battle:bossAppeared", { bossName: enemyField[0].name });
    }

    if (encounterMode === MysteryEncounterMode.TRAINER_BATTLE) {
      if (globalScene.currentBattle.double) {
        return i18next.t("battle:trainerAppearedDouble", {
          trainerName: globalScene.currentBattle.trainer?.getName(TrainerSlot.NONE, true),
        });
      }
      return i18next.t("battle:trainerAppeared", {
        trainerName: globalScene.currentBattle.trainer?.getName(TrainerSlot.NONE, true),
      });
    }

    return enemyField.length === 1
      ? i18next.t("battle:singleWildAppeared", {
          pokemonName: enemyField[0].name,
        })
      : i18next.t("battle:multiWildAppeared", {
          pokemonName1: enemyField[0].name,
          pokemonName2: enemyField[1].name,
        });
  }

  /**
   * Queue {@linkcode SummonPhase}s for the new battle and handle trainer animations/dialogue for Trainer battles
   */
  private doMysteryEncounterBattle() {
    const encounterMode = globalScene.currentBattle.mysteryEncounter!.encounterMode;
    if (encounterMode === MysteryEncounterMode.WILD_BATTLE || encounterMode === MysteryEncounterMode.BOSS_BATTLE) {
      // Summons the wild/boss Pokemon
      if (encounterMode === MysteryEncounterMode.BOSS_BATTLE) {
        audioManager.playBgm();
      }
      const availablePartyMembers = globalScene.getEnemyParty().filter(p => !p.isFainted()).length;
      globalScene.phaseManager.unshiftNew("SummonPhase", 0, false);
      if (globalScene.currentBattle.double && availablePartyMembers > 1) {
        globalScene.phaseManager.unshiftNew("SummonPhase", 1, false);
      }

      if (globalScene.currentBattle.mysteryEncounter?.hideBattleIntroMessage) {
        this.endBattleSetup();
      } else {
        globalScene.ui.showText(this.getBattleMessage(), null, () => this.endBattleSetup(), 0);
      }
    } else if (encounterMode === MysteryEncounterMode.TRAINER_BATTLE) {
      this.showEnemyTrainer();
      const doSummon = () => {
        globalScene.currentBattle.started = true;
        audioManager.playBgm();
        globalScene.pbTray.showPbTray(globalScene.getPlayerParty());
        globalScene.pbTrayEnemy.showPbTray(globalScene.getEnemyParty());
        const doTrainerSummon = () => {
          this.hideEnemyTrainer();
          const availablePartyMembers = globalScene.getEnemyParty().filter(p => !p.isFainted()).length;
          globalScene.phaseManager.unshiftNew("SummonPhase", 0, false);
          if (globalScene.currentBattle.double && availablePartyMembers > 1) {
            globalScene.phaseManager.unshiftNew("SummonPhase", 1, false);
          }
          this.endBattleSetup();
        };
        if (globalScene.currentBattle.mysteryEncounter?.hideBattleIntroMessage) {
          doTrainerSummon();
        } else {
          globalScene.ui.showText(this.getBattleMessage(), null, doTrainerSummon, 1000, true);
        }
      };

      const encounterMessages = globalScene.currentBattle.trainer?.getEncounterMessages();

      if (!encounterMessages || encounterMessages.length === 0) {
        doSummon();
      } else {
        const trainer = globalScene.currentBattle.trainer;
        let message: string;
        globalScene.executeWithSeedOffset(
          () => (message = randSeedItem(encounterMessages)),
          globalScene.currentBattle.mysteryEncounter?.getSeedOffset(),
        );
        message = message!; // tell TS compiler it's defined now
        const showDialogueAndSummon = () => {
          globalScene.ui.showDialogue(message, trainer?.getName(TrainerSlot.NONE, true), null, () => {
            globalScene.charSprite.hide().then(() => globalScene.hideFieldOverlay(250).then(() => doSummon()));
          });
        };
        if (globalScene.currentBattle.trainer?.config.hasCharSprite && !globalScene.ui.shouldSkipDialogue(message)) {
          globalScene
            .showFieldOverlay(500)
            .then(() =>
              globalScene.charSprite
                .showCharacter(trainer?.getKey()!, getCharVariantFromDialogue(encounterMessages[0]))
                .then(() => showDialogueAndSummon()),
            ); // TODO: is this bang correct?
        } else {
          showDialogueAndSummon();
        }
      }
    }
  }

  /**
   * Initiate {@linkcode SummonPhase}s, {@linkcode ScanIvsPhase}, {@linkcode PostSummonPhase}s, etc.
   */
  private endBattleSetup() {
    const enemyField = globalScene.getEnemyField();
    const encounterMode = globalScene.currentBattle.mysteryEncounter!.encounterMode;

    // PostSummon and ShinySparkle phases are handled by SummonPhase

    if (encounterMode !== MysteryEncounterMode.TRAINER_BATTLE) {
      const ivScannerModifier = globalScene.findModifier(m => m instanceof IvScannerModifier);
      if (ivScannerModifier) {
        enemyField.map(p => globalScene.phaseManager.pushNew("ScanIvsPhase", p.getBattlerIndex()));
      }
    }

    const availablePartyMembers = globalScene.getPlayerParty().filter(p => p.isAllowedInBattle());

    if (!availablePartyMembers[0].isOnField()) {
      globalScene.phaseManager.pushNew("SummonPhase", 0);
    }

    if (globalScene.currentBattle.double) {
      if (availablePartyMembers.length > 1) {
        globalScene.phaseManager.pushNew("ToggleDoublePositionPhase", true);
        if (!availablePartyMembers[1].isOnField()) {
          globalScene.phaseManager.pushNew("SummonPhase", 1);
        }
      }
    } else {
      if (availablePartyMembers.length > 1 && availablePartyMembers[1].isOnField()) {
        for (const pokemon of inSpeedOrder(ArenaTagSide.PLAYER)) {
          pokemon.lapseTag(BattlerTagType.COMMANDED);
        }
        globalScene.phaseManager.pushNew("ReturnPhase", 1);
      }
      globalScene.phaseManager.pushNew("ToggleDoublePositionPhase", false);
    }

    if (encounterMode !== MysteryEncounterMode.TRAINER_BATTLE && !this.disableSwitch) {
      const minPartySize = globalScene.currentBattle.double ? 2 : 1;
      if (availablePartyMembers.length > minPartySize) {
        globalScene.phaseManager.pushNew("CheckSwitchPhase", 0, globalScene.currentBattle.double);
        if (globalScene.currentBattle.double) {
          globalScene.phaseManager.pushNew("CheckSwitchPhase", 1, globalScene.currentBattle.double);
        }
      }
    }

    // Co-op (D29): a lone wild Pokémon against two is stronger, once both sides are out
    if (isCoop()) {
      queueLoneEnemyBoost();
    }

    globalScene.phaseManager.pushNew("InitEncounterPhase");
    this.end();
  }

  /** Ease in enemy trainer */
  private showEnemyTrainer(): void {
    // Show enemy trainer
    const trainer = globalScene.currentBattle.trainer;
    if (!trainer) {
      return;
    }
    trainer.alpha = 0;
    trainer.x += 16;
    trainer.y -= 16;
    trainer.setVisible(true);
    globalScene.tweens.add({
      targets: trainer,
      x: "-=16",
      y: "+=16",
      alpha: 1,
      ease: "Sine.easeInOut",
      duration: 750,
      onComplete: () => {
        trainer.untint(100, "Sine.easeOut");
        trainer.playAnim();
      },
    });
  }

  private hideEnemyTrainer(): void {
    globalScene.tweens.add({
      targets: globalScene.currentBattle.trainer,
      x: "+=16",
      y: "-=16",
      alpha: 0,
      ease: "Sine.easeInOut",
      duration: 750,
    });
  }
}

/**
 * Will handle (in order):
 * - doContinueEncounter() callback for continuous encounters with back-to-back battles (this should push/shift its own phases as needed)
 *
 * OR
 *
 * - Any encounter reward logic that is set within {@linkcode MysteryEncounter.doEncounterExp}
 * - Any encounter reward logic that is set within {@linkcode MysteryEncounter.doEncounterRewards}
 * - Otherwise, can add a no-reward-item shop with only Potions, etc. if addHealPhase is true
 * - Queuing of the {@linkcode PostMysteryEncounterPhase}
 */
export class MysteryEncounterRewardsPhase extends Phase {
  public readonly phaseName = "MysteryEncounterRewardsPhase";
  addHealPhase: boolean;

  constructor(addHealPhase = false) {
    super();
    this.addHealPhase = addHealPhase;
  }

  /**
   * Runs {@linkcode MysteryEncounter.doContinueEncounter} and ends phase, OR {@linkcode MysteryEncounter.onRewards} then continues encounter
   */
  start() {
    super.start();
    const encounter = globalScene.currentBattle.mysteryEncounter!;

    if (encounter.doContinueEncounter) {
      encounter.doContinueEncounter().then(() => {
        this.end();
      });
    } else {
      globalScene.executeWithSeedOffset(() => {
        if (encounter.onRewards) {
          encounter.onRewards().then(() => {
            this.doEncounterRewardsAndContinue();
          });
        } else {
          this.doEncounterRewardsAndContinue();
        }
        // Do not use ME's seedOffset for rewards, these should always be consistent with waveIndex (once per wave)
      }, globalScene.currentBattle.waveIndex * 1000);
    }
  }

  /**
   * Queues encounter EXP and rewards phases, {@linkcode PostMysteryEncounterPhase}, and ends phase
   */
  doEncounterRewardsAndContinue() {
    const encounter = globalScene.currentBattle.mysteryEncounter!;

    if (encounter.doEncounterExp) {
      encounter.doEncounterExp();
    }

    if (encounter.doEncounterRewards) {
      encounter.doEncounterRewards();
    } else if (this.addHealPhase) {
      globalScene.phaseManager.removeAllPhasesOfType("SelectModifierPhase");
      globalScene.phaseManager.unshiftNew("SelectModifierPhase", 0, undefined, {
        fillRemaining: false,
        rerollMultiplier: -1,
      });
    }

    globalScene.phaseManager.pushNew("PostMysteryEncounterPhase");
    this.end();
  }
}

/**
 * Will handle (in order):
 * - {@linkcode MysteryEncounter.onPostOptionSelect} logic (based on an option that was selected)
 * - Showing any outro dialogue messages
 * - Cleanup of any leftover intro visuals
 * - Queuing of the next wave
 */
export class PostMysteryEncounterPhase extends Phase {
  public readonly phaseName = "PostMysteryEncounterPhase";
  private readonly FIRST_DIALOGUE_PROMPT_DELAY = 750;
  onPostOptionSelect?: OptionPhaseCallback | undefined;

  constructor() {
    super();
    this.onPostOptionSelect = globalScene.currentBattle.mysteryEncounter?.selectedOption?.onPostOptionPhase;
  }

  /**
   * Runs {@linkcode MysteryEncounter.onPostOptionSelect} then continues encounter
   */
  start() {
    super.start();

    if (this.onPostOptionSelect) {
      globalScene.executeWithSeedOffset(async () => {
        return await this.onPostOptionSelect!().then(result => {
          if (result == null || result) {
            this.continueEncounter();
          }
        });
      }, globalScene.currentBattle.mysteryEncounter?.getSeedOffset() * 2000);
    } else {
      this.continueEncounter();
    }
  }

  /**
   * Queues {@linkcode NewBattlePhase}, plays outro dialogue and ends phase
   */
  continueEncounter() {
    const endPhase = () => {
      if (globalScene.gameMode.hasRandomBiomes || globalScene.isNewBiome()) {
        globalScene.phaseManager.pushNew("SelectBiomePhase");
      }

      globalScene.phaseManager.pushNew("NewBattlePhase");
      this.end();
    };

    const outroDialogue = globalScene.currentBattle?.mysteryEncounter?.dialogue?.outro;
    if (outroDialogue && outroDialogue.length > 0) {
      let i = 0;
      const showNextDialogue = () => {
        const nextAction = i === outroDialogue.length - 1 ? endPhase : showNextDialogue;
        const dialogue = outroDialogue[i];
        let title: string | null = null;
        const text: string | null = getEncounterText(dialogue.text);
        if (dialogue.speaker) {
          title = getEncounterText(dialogue.speaker);
        }

        i++;
        globalScene.ui.setMode(UiMode.MESSAGE);
        if (title) {
          globalScene.ui.showDialogue(
            text ?? "",
            title,
            null,
            nextAction,
            0,
            i === 1 ? this.FIRST_DIALOGUE_PROMPT_DELAY : 0,
          );
        } else {
          globalScene.ui.showText(text ?? "", null, nextAction, i === 1 ? this.FIRST_DIALOGUE_PROMPT_DELAY : 0, true);
        }
      };

      showNextDialogue();
    } else {
      endPhase();
    }
  }
}
