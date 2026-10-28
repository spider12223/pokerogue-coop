import { pokerogueApi } from "#api/api";
import { clientSessionId } from "#app/account";
import { audioManager } from "#app/global-audio-manager";
import { globalScene } from "#app/global-scene";
import { settings } from "#app/global-settings-manager";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { bypassLogin } from "#constants/app-constants";
import { coopDecide, coopText, reportBridgeError } from "#coop/bridge";
import { deciderOf } from "#coop/control";
import { retryKey } from "#coop/decision-keys";
import { beginRunEnd } from "#coop/play-again";
import type { Seat } from "#coop/protocol";
import { issueResync, trySafeApply } from "#coop/resync-run";
import { isRetryPayload, type RetryPayload } from "#coop/retry";
import { getCoopSession, requireCoopSession } from "#coop/session";
import { writesForPokemon } from "#coop/sim-account";
import { modifierTypes } from "#data/data-lists";
import { getCharVariantFromDialogue } from "#data/dialogue";
import type { PokemonSpecies } from "#data/pokemon-species";
import { BattleType } from "#enums/battle-type";
import { ChallengeType } from "#enums/challenge-type";
import { PlayerGender } from "#enums/player-gender";
import { TrainerType } from "#enums/trainer-type";
import { UiMode } from "#enums/ui-mode";
import { Unlockables } from "#enums/unlockables";
import type { Pokemon } from "#field/pokemon";
import { BattlePhase } from "#phases/battle-phase";
import type { EndCardPhase } from "#phases/end-card-phase";
import { achvs, ChallengeAchv } from "#system/achv";
import { ArenaData } from "#system/arena-data";
import { ChallengeData } from "#system/challenge-data";
import { ModifierData as PersistentModifierData } from "#system/modifier-data";
import { PokemonData } from "#system/pokemon-data";
import type { RibbonFlag } from "#system/ribbon-data";
import { awardRibbonsToSpeciesLine } from "#system/ribbon-methods";
import { TrainerData } from "#system/trainer-data";
import { trainerConfigs } from "#trainers/trainer-config";
import type { SessionSaveData } from "#types/save-data";
import type { ConfirmModeConfig, OptionSelectItem } from "#types/ui-types";
import { applyChallenges, getRibbonsToAward } from "#utils/challenge-utils";
import { fixedInt, isLocalServerConnected } from "#utils/common";
import { ValueHolder } from "#utils/value-holder";
import i18next from "i18next";

export class GameOverPhase extends BattlePhase {
  public readonly phaseName = "GameOverPhase";

  private isVictory: boolean;
  private readonly firstRibbons: PokemonSpecies[] = [];

  constructor(isVictory = false) {
    super();

    this.isVictory = isVictory;
  }

  public override start(): void {
    super.start();

    globalScene.phaseManager.hideAbilityBar();

    // Failsafe if players somehow skip floor 200 in classic mode
    if (globalScene.gameMode.isClassic && globalScene.currentBattle.waveIndex > 200) {
      this.isVictory = true;
    }

    // Handle Mystery Encounter special Game Over cases
    // Situations such as when player lost a battle, but it isn't treated as full Game Over
    if (
      !this.isVictory
      && globalScene.currentBattle.mysteryEncounter?.onGameOver
      && !globalScene.currentBattle.mysteryEncounter.onGameOver()
    ) {
      // Do not end the game
      this.end();
      return;
    }
    // Otherwise, continue standard Game Over logic

    if (this.isVictory && globalScene.gameMode.isEndless) {
      const genderIndex = settings.general.playerGender;
      const genderStr = PlayerGender[genderIndex].toLowerCase();
      globalScene.ui.showDialogue(
        i18next.t("miscDialogue:endingEndless", { context: genderStr }),
        i18next.t("miscDialogue:endingName"),
        0,
        () => this.handleGameOver(),
        0,
        fixedInt(3000),
      );
      return;
    }

    // Co-op (D4a): after a wipe the host chooses to retry the wave or end the run; `enableRetries` is not read (it is pinned)
    if (!this.isVictory && globalScene.gameMode.isCoop && this.decideCoopRetry()) {
      return;
    }

    if (this.isVictory || !settings.general.enableRetries || globalScene.gameMode.isCoop) {
      this.handleGameOver();
      return;
    }

    const retryOptions: ConfirmModeConfig = {
      yesHandler: () => {
        globalScene.ui
          .fadeOut(1250)
          .then(() => {
            globalScene.reset();
            globalScene.phaseManager.clearPhaseQueue();
            return globalScene.gameData.loadSession(globalScene.sessionSlotId);
          })
          .then(() => {
            globalScene.phaseManager.pushNew("EncounterPhase", true);

            const availablePartyMembers = globalScene.getPokemonAllowedInBattle().length;

            globalScene.phaseManager.pushNew("SummonPhase", 0, true, true);
            if (globalScene.currentBattle.double && availablePartyMembers > 1) {
              globalScene.phaseManager.pushNew("SummonPhase", 1, true, true);
            }
            if (
              globalScene.currentBattle.waveIndex > 1
              && globalScene.currentBattle.battleType !== BattleType.TRAINER
            ) {
              globalScene.phaseManager.pushNew("CheckSwitchPhase", 0, globalScene.currentBattle.double);
              if (globalScene.currentBattle.double && availablePartyMembers > 1) {
                globalScene.phaseManager.pushNew("CheckSwitchPhase", 1, globalScene.currentBattle.double);
              }
            }

            globalScene.ui.fadeIn(1250);
            this.end();
          });
      },
      noHandler: () => this.handleGameOver(),
      inputDelay: 1000,
    };

    globalScene.ui.showText(i18next.t("battle:retryBattle"), null, () => {
      globalScene.ui.setMode(UiMode.CONFIRM, retryOptions);
    });
  }

  /**
   * Submethod of {@linkcode handleGameOver} that awards ribbons to Pokémon in the player's party
   * based on the current game mode and challenges.
   */
  private awardRibbons(): void {
    const ribbonFlags = getRibbonsToAward();

    // Award ribbons to all Pokémon in the player's party that are considered valid
    // for the current game mode and challenges (as in, they can be used in battle).
    for (const pokemon of globalScene.getPlayerParty()) {
      // Co-op (D4a): ribbons go per owner, each client writing for its own player's Pokémon
      if (!writesForPokemon(pokemon)) {
        continue;
      }
      const species = pokemon.species;
      const challengeAllowed = new ValueHolder(true);
      applyChallenges(ChallengeType.POKEMON_IN_BATTLE, pokemon, challengeAllowed);
      if (challengeAllowed.value) {
        awardRibbonsToSpeciesLine(species.speciesId, ribbonFlags as RibbonFlag);
      }
    }
  }

  /**
   * Co-op (D4a, amended): the party is wiped in a run with a network. The host chooses to play the wave again from its start or
   * to end the run, as a sequenced decision (`RETRY`); the guest waits, and may take it over (D17). A retry is the reload of
   * D13 with the reason `retry`: the host sequences a `RESYNC` with its wave-start save, and both clients load it under the next
   * epoch. Nothing is written to the run history then. An end is {@linkcode handleCoopRunEnd} on both clients.
   *
   * Without a network (the rules harness) or a wave-start save there is nothing to go back to: the run ends as before. Both
   * clients take the wave-start save at the same point of the simulation (D19), so they agree on whether to ask.
   * @returns Whether the decision was opened (the phase waits for it)
   */
  private decideCoopRetry(): boolean {
    const session = getCoopSession();
    const link = session?.link ?? null;
    if (session == null || link === null || link.isClosed || session.waveSave === null) {
      return false;
    }
    // A decision of a world that was reloaded meanwhile (a rejoin) belongs to the abandoned phase: nothing more is done here
    const epoch = link.epoch;
    const partner = session.partnerName;
    coopDecide<RetryPayload>({
      key: retryKey(globalScene.currentBattle.waveIndex),
      decider: deciderOf({ kind: "RETRY" }) as Seat,
      ask: () => this.askCoopRetry(),
      wait: () => {
        const { ui } = globalScene;
        ui.setMode(UiMode.MESSAGE);
        ui.showText(
          coopText("retryWait", "{{partner}} is deciding whether to retry the wave…", { partner }),
          null,
          undefined,
          null,
          false,
        );
      },
      isPayload: isRetryPayload,
    })
      .then(decision => {
        if (link.epoch !== epoch) {
          return;
        }
        if (!decision.payload.retry) {
          this.handleGameOver();
        } else if (session.isHost) {
          issueResync(session, "retry");
        } else {
          // The host's reload is on its way, or already here: this phase only waits for it, so it may be abandoned now
          session.retryPending = true;
          trySafeApply(session);
        }
      })
      .catch(error => reportBridgeError(error));
    return true;
  }

  /** The host's menu after a wipe (D4a): retry the wave from its start, or end the run */
  private askCoopRetry(): Promise<RetryPayload> {
    const { ui } = globalScene;
    return new Promise(resolve => {
      const choose =
        (retry: boolean): (() => boolean) =>
        () => {
          ui.setMode(UiMode.MESSAGE);
          resolve({ retry });
          return true;
        };
      const options: OptionSelectItem[] = [
        { label: coopText("retryWave", "Retry the wave"), handler: choose(true) },
        { label: coopText("retryEnd", "End the run"), handler: choose(false) },
      ];
      ui.setMode(UiMode.MESSAGE);
      ui.showText(
        coopText("retryAsk", "Your party is out of usable Pokémon. Retry the wave from its start?"),
        null,
        // (the same delay as the retry prompt of a solo run: a press meant for the last message does not choose)
        () => ui.setModeWithoutClear(UiMode.OPTION_SELECT, { options, yOffset: 48, inputDelay: 1000 }),
        null,
        false,
      );
    });
  }

  /**
   * The end of a co-op run (DECISIONS D4a): victory and game over are shared (a game over ends the run unless the host
   * retries the wave, {@linkcode decideCoopRetry}). A victory gives each player the ribbons of their own Pokémon and counts as
   * a co-op clear of their own account, and nothing else: no classic-win unlocks or vouchers. The run goes into each player's
   * run history with both display names. Both clients then show the end screen, where each player may play again with the
   * partner (D35).
   */
  private handleCoopRunEnd(): void {
    globalScene.disableMenu = true;
    beginRunEnd();
    if (this.isVictory) {
      this.awardRibbons();
      globalScene.gameData.gameStats.coopRunsWon++;
    }
    void this.recordCoopRun();
    globalScene.time.delayedCall(1000, () => {
      const fadeDuration = this.isVictory ? 4000 : 2000;
      audioManager.fadeOutBgm(fadeDuration);
      const activeBattlers = globalScene.getField().filter(p => p?.isActive(true));
      activeBattlers.map(p => p.hideInfo());
      globalScene.ui.fadeOut(fadeDuration).then(() => {
        activeBattlers.map(a => a.setVisible(false));
        globalScene.setFieldScale(1, true);
        globalScene.phaseManager.clearPhaseQueue();
        globalScene.ui.clearText();
        globalScene.phaseManager.pushNew("PostGameOverPhase", globalScene.sessionSlotId);
        this.end();
      });
    });
  }

  handleGameOver(): void {
    if (globalScene.gameMode.isCoop) {
      this.handleCoopRunEnd();
      return;
    }
    const doGameOver = (newClear: boolean) => {
      globalScene.disableMenu = true;
      globalScene.time.delayedCall(1000, () => {
        let firstClear = false;
        if (this.isVictory) {
          if (globalScene.gameMode.isClassic) {
            firstClear = globalScene.validateAchv(achvs.CLASSIC_VICTORY);
            globalScene.validateAchv(achvs.UNEVOLVED_CLASSIC_VICTORY);
            globalScene.gameData.gameStats.sessionsWon++;
            for (const pokemon of globalScene.getPlayerParty()) {
              this.awardFirstClassicCompletion(pokemon);
              if (pokemon.species.getRootSpeciesId() !== pokemon.species.getRootSpeciesId(true)) {
                this.awardFirstClassicCompletion(pokemon, true);
              }
            }
            this.awardRibbons();
          } else if (globalScene.gameMode.isDaily && newClear) {
            globalScene.gameData.gameStats.dailyRunSessionsWon++;
            globalScene.validateAchv(achvs.DAILY_VICTORY);
          }
        }

        const fadeDuration = this.isVictory ? 10000 : 5000;
        audioManager.fadeOutBgm(fadeDuration);
        const activeBattlers = globalScene.getField().filter(p => p?.isActive(true));
        activeBattlers.map(p => p.hideInfo());
        globalScene.ui.fadeOut(fadeDuration).then(() => {
          activeBattlers.map(a => a.setVisible(false));
          globalScene.setFieldScale(1, true);
          globalScene.phaseManager.clearPhaseQueue();
          globalScene.ui.clearText();

          if (this.isVictory && globalScene.gameMode.isChallenge) {
            globalScene.gameMode.challenges.forEach(c => globalScene.validateAchvs(ChallengeAchv, c));
          }

          const clear = (endCardPhase?: EndCardPhase) => {
            if (this.isVictory && newClear) {
              this.handleUnlocks();

              for (const species of this.firstRibbons) {
                globalScene.phaseManager.unshiftNew("RibbonModifierRewardPhase", modifierTypes.VOUCHER_PLUS, species);
              }
              if (!firstClear) {
                globalScene.phaseManager.unshiftNew("GameOverModifierRewardPhase", modifierTypes.VOUCHER_PREMIUM);
              }
            }
            this.getRunHistoryEntry().then(runHistoryEntry => {
              globalScene.gameData.saveRunHistory(runHistoryEntry, this.isVictory);
              globalScene.phaseManager.pushNew("PostGameOverPhase", globalScene.sessionSlotId, endCardPhase);
              this.end();
            });
          };

          if (this.isVictory && globalScene.gameMode.isClassic) {
            const dialogueKey = "miscDialogue:ending";

            if (globalScene.ui.shouldSkipDialogue(dialogueKey)) {
              const endCardPhase = globalScene.phaseManager.create("EndCardPhase");
              globalScene.phaseManager.unshiftPhase(endCardPhase);
              clear(endCardPhase);
            } else {
              globalScene.ui.fadeIn(500).then(() => {
                const genderIndex = settings.general.playerGender;
                const genderStr = PlayerGender[genderIndex].toLowerCase();
                // Dialogue has to be retrieved so that the rival's expressions can be loaded and shown via getCharVariantFromDialogue
                const dialogue = i18next.t(dialogueKey, { context: genderStr });
                globalScene.charSprite
                  .showCharacter(`rival_${settings.isPlayerFemale ? "m" : "f"}`, getCharVariantFromDialogue(dialogue))
                  .then(() => {
                    globalScene.ui.showDialogue(
                      dialogueKey,
                      settings.isPlayerFemale
                        ? trainerConfigs[TrainerType.RIVAL].name
                        : trainerConfigs[TrainerType.RIVAL].nameFemale,
                      null,
                      () => {
                        globalScene.ui.fadeOut(500).then(() => {
                          globalScene.charSprite.hide().then(() => {
                            const endCardPhase = globalScene.phaseManager.create("EndCardPhase");
                            globalScene.phaseManager.unshiftPhase(endCardPhase);
                            clear(endCardPhase);
                          });
                        });
                      },
                    );
                  });
              });
            }
          } else {
            clear();
          }
        });
      });
    };

    // If Online, execute apiFetch as intended
    // If Offline, execute offlineNewClear() only for victory, a localStorage implementation of newClear daily run checks
    if (!bypassLogin || isLocalServerConnected) {
      pokerogueApi.savedata.session
        .newclear({
          slot: globalScene.sessionSlotId,
          isVictory: this.isVictory,
          clientSessionId,
        })
        .then(success => doGameOver(!globalScene.gameMode.isDaily || !!success))
        .catch(_err => {
          globalScene.phaseManager.clearPhaseQueue();
          globalScene.phaseManager.unshiftNew("MessagePhase", i18next.t("menu:serverCommunicationFailed"), 2500);
          // force the game to reload after 2 seconds.
          setTimeout(() => {
            window.location.reload();
          }, 2000);
          this.end();
        });
    } else if (this.isVictory) {
      globalScene.gameData.offlineNewClear().then(result => {
        doGameOver(result);
      });
    } else {
      doGameOver(false);
    }
  }

  handleUnlocks(): void {
    if (this.isVictory && globalScene.gameMode.isClassic) {
      if (!globalScene.gameData.unlocks[Unlockables.ENDLESS_MODE]) {
        globalScene.phaseManager.unshiftNew("UnlockPhase", Unlockables.ENDLESS_MODE);
      }
      if (
        globalScene.getPlayerParty().filter(p => p.fusionSpecies).length > 0
        && !globalScene.gameData.unlocks[Unlockables.SPLICED_ENDLESS_MODE]
      ) {
        globalScene.phaseManager.unshiftNew("UnlockPhase", Unlockables.SPLICED_ENDLESS_MODE);
      }
      if (!globalScene.gameData.unlocks[Unlockables.MINI_BLACK_HOLE]) {
        globalScene.phaseManager.unshiftNew("UnlockPhase", Unlockables.MINI_BLACK_HOLE);
      }
      if (
        !globalScene.gameData.unlocks[Unlockables.EVIOLITE]
        && globalScene.getPlayerParty().some(p => speciesDataRegistry.hasEvolutions(p.getSpeciesForm(true).speciesId))
      ) {
        globalScene.phaseManager.unshiftNew("UnlockPhase", Unlockables.EVIOLITE);
      }
    }
  }

  awardFirstClassicCompletion(pokemon: Pokemon, forStarter = false): void {
    const speciesId = speciesDataRegistry.getSpecies(pokemon.species.speciesId);
    const speciesRibbonCount = globalScene.gameData.incrementRibbonCount(speciesId, forStarter);
    // first time classic win, award voucher
    if (speciesRibbonCount === 1) {
      this.firstRibbons.push(speciesDataRegistry.getSpecies(pokemon.species.getRootSpeciesId(forStarter)));
    }
  }

  // TODO: Make function use existing getSessionSaveData() function and then modify the values from there.
  /**
   * Slightly modified version of {@linkcode GameData.getSessionSaveData}.
   * @returns A promise containing the {@linkcode SessionSaveData}
   */
  /**
   * A co-op run is over: it is written to this account's run history with both display names, and the system data keeps
   * the clear counter. A failure is told and the run still ends.
   */
  private async recordCoopRun(): Promise<void> {
    try {
      const session = requireCoopSession();
      // (the solo slots are never read for a co-op run: they hold some other run)
      const entry = await this.getRunHistoryEntry(false);
      await globalScene.gameData.saveRunHistory(entry, this.isVictory, { names: session.names, seat: session.seat });
      await globalScene.gameData.saveSystem();
    } catch (error) {
      console.warn("co-op: the run could not be written to the run history:", error);
    }
  }

  private async getRunHistoryEntry(readSoloSlot = true): Promise<SessionSaveData> {
    const preWaveSessionData = readSoloSlot ? await globalScene.gameData.getSession(globalScene.sessionSlotId) : null;
    return {
      seed: globalScene.seed,
      playTime: globalScene.sessionPlayTime,
      gameMode: globalScene.gameMode.modeId,
      party: globalScene.getPlayerParty().map(p => new PokemonData(p)),
      enemyParty: globalScene.getEnemyParty().map(p => new PokemonData(p)),
      modifiers: preWaveSessionData
        ? preWaveSessionData.modifiers
        : globalScene.findModifiers(() => true).map(m => new PersistentModifierData(m, true)),
      enemyModifiers: preWaveSessionData
        ? preWaveSessionData.enemyModifiers
        : globalScene.findModifiers(() => true, false).map(m => new PersistentModifierData(m, false)),
      arena: new ArenaData(globalScene.arena),
      pokeballCounts: globalScene.pokeballCounts,
      money: Math.floor(globalScene.money),
      score: globalScene.score,
      waveIndex: globalScene.currentBattle.waveIndex,
      battleType: globalScene.currentBattle.battleType,
      trainer: globalScene.currentBattle.trainer ? new TrainerData(globalScene.currentBattle.trainer) : null,
      gameVersion: globalScene.game.config.gameVersion,
      timestamp: Date.now(),
      challenges: globalScene.gameMode.challenges.map(c => new ChallengeData(c)),
      mysteryEncounterType: globalScene.currentBattle.mysteryEncounter?.encounterType ?? -1,
      mysteryEncounterSaveData: globalScene.mysteryEncounterSaveData,
      playerFaints: globalScene.arena.playerFaints,
    } as SessionSaveData;
  }
}
