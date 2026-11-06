import { PLAYER_PARTY_MAX_SIZE } from "#app/constants";
import { audioManager } from "#app/global-audio-manager";
import { timedEventManager } from "#app/global-event-manager";
import { globalScene } from "#app/global-scene";
import { IS_TEST, isBeta, isDev } from "#constants/app-constants";
import { coopDecide, coopText, isLinked, reportBridgeError } from "#coop/bridge";
import { noRoomQuestion } from "#coop/catch-room";
import { chatNote } from "#coop/chat";
import { catchReleaseKey } from "#coop/decision-keys";
import { type CatchReleasePayload, isCatchReleasePayload } from "#coop/prompt-payloads";
import { type Seat, startersPerSeat } from "#coop/protocol";
import { DesyncError } from "#coop/sequencer";
import { getCoopSession } from "#coop/session";
import { writesForSeat } from "#coop/sim-account";
import { showWaitingLine } from "#coop/waiting-line";
import { SubstituteTag } from "#data/battler-tags";
import { Gender } from "#data/gender";
import {
  doPokeballBounceAnim,
  getCriticalCaptureChance,
  getPokeballAtlasKey,
  getPokeballCatchMultiplier,
  getPokeballTintColor,
} from "#data/pokeball";
import { getStatusEffectCatchRateMultiplier } from "#data/status-effect";
import { BattlerIndex } from "#enums/battler-index";
import { ChallengeType } from "#enums/challenge-type";
import { PartyUiMode } from "#enums/party-ui-mode";
import type { PokeballType } from "#enums/pokeball";
import { StatusEffect } from "#enums/status-effect";
import { UiMode } from "#enums/ui-mode";
import type { EnemyPokemon } from "#field/pokemon";
import { PokemonHeldItemModifier } from "#modifiers/modifier";
import { PokemonPhase } from "#phases/pokemon-phase";
import { achvs } from "#system/achv";
import type { OptionSelectModeConfig } from "#types/ui-types";
import type { PartyOption } from "#ui/party-ui-handler";
import { SummaryUiMode } from "#ui/summary-ui-handler";
import { applyChallenges } from "#utils/challenge-utils";
import { BooleanHolder } from "#utils/common";
import i18next from "i18next";

// TODO: Refactor and split up to allow for overriding capture chance
export class AttemptCapturePhase extends PokemonPhase {
  public readonly phaseName = "AttemptCapturePhase";
  private readonly pokeballType: PokeballType;
  private pokeball: Phaser.GameObjects.Sprite;
  private originalY: number;

  /**
   * @param throwerId - The `pokemon.id` of the Pokémon that threw the ball: in co-op its owner owns the catch (D10)
   */
  constructor(
    targetIndex: number,
    pokeballType: PokeballType,
    private readonly throwerId?: number,
  ) {
    super(BattlerIndex.ENEMY + targetIndex);

    this.pokeballType = pokeballType;
  }

  /** @returns Who threw the ball in a co-op run (the owner of the thrower); `null` in solo play */
  public getThrowerSeat(): Seat | null {
    const session = getCoopSession();
    if (session === null) {
      return null;
    }
    return (this.throwerId === undefined ? undefined : session.ownership.get(this.throwerId)) ?? session.seat;
  }

  /**
   * @returns Whether the thrower has no room for the catch: a full party in solo play, three of their own in co-op (D10),
   * two in a game of three (D40)
   */
  private isSeatFull(thrower: Seat | null): boolean {
    const session = getCoopSession();
    if (thrower === null || session === null) {
      return globalScene.getPlayerParty().length === PLAYER_PARTY_MAX_SIZE;
    }
    const partyIds = globalScene.getPlayerParty().map(member => member.id);
    return (
      session.ownership.countOwned(partyIds, thrower) >= startersPerSeat(session.players)
      || globalScene.getPlayerParty().length >= PLAYER_PARTY_MAX_SIZE
    );
  }

  start() {
    super.start();

    const pokemon = this.getPokemon() as EnemyPokemon;

    if (!pokemon?.hp) {
      return this.end();
    }

    const substitute = pokemon.getTag(SubstituteTag);
    if (substitute) {
      substitute.sprite.setVisible(false);
    }

    globalScene.pokeballCounts[this.pokeballType]--;

    this.originalY = pokemon.y;

    const _3m = 3 * pokemon.getMaxHp();
    const _2h = 2 * pokemon.hp;
    const catchRate = pokemon.species.catchRate;
    const pokeballMultiplier = getPokeballCatchMultiplier(this.pokeballType);
    const statusMultiplier = pokemon.status ? getStatusEffectCatchRateMultiplier(pokemon.status.effect) : 1;
    const shinyMultiplier = pokemon.isShiny() ? timedEventManager.getShinyCatchMultiplier() : 1;
    const modifiedCatchRate = Math.round(
      (((_3m - _2h) * catchRate * pokeballMultiplier) / _3m) * statusMultiplier * shinyMultiplier,
    );
    const shakeProbability = Math.round(65536 / Math.pow(255 / modifiedCatchRate, 0.1875)); // Formula taken from gen 6
    const criticalCaptureChance = getCriticalCaptureChance(modifiedCatchRate);

    if ((isBeta || isDev) && !IS_TEST) {
      console.log(
        "Base Catch Rate: %d\nBall Mult: %d\nStatus Mult: %d\nShiny Bonus: %d\nModified Catch Rate: %d\nShake Probability: %d\nCritical Catch Chance: %d",
        catchRate,
        pokeballMultiplier,
        statusMultiplier,
        shinyMultiplier,
        modifiedCatchRate,
        shakeProbability,
        criticalCaptureChance,
      );
    }

    const isCritical = pokemon.randBattleSeedInt(256) < criticalCaptureChance;
    const fpOffset = pokemon.getFieldPositionOffset();

    const pokeballAtlasKey = getPokeballAtlasKey(this.pokeballType);
    this.pokeball = globalScene.addFieldSprite(16, 80, "pb", pokeballAtlasKey);
    this.pokeball.setOrigin(0.5, 0.625);
    globalScene.field.add(this.pokeball);

    audioManager.playSound(isCritical ? "se/crit_throw" : "se/pb_throw");
    globalScene.time.delayedCall(300, () => {
      globalScene.field.moveBelow(this.pokeball as Phaser.GameObjects.GameObject, pokemon);
    });

    globalScene.tweens.add({
      // Throw animation
      targets: this.pokeball,
      x: { value: 236 + fpOffset[0], ease: "Linear" },
      y: { value: 16 + fpOffset[1], ease: "Cubic.easeOut" },
      duration: 500,
      onComplete: () => {
        // Ball opens
        this.pokeball.setTexture("pb", `${pokeballAtlasKey}_opening`);
        globalScene.time.delayedCall(17, () => this.pokeball.setTexture("pb", `${pokeballAtlasKey}_open`));
        audioManager.playSound("se/pb_rel");
        pokemon.tint(getPokeballTintColor(this.pokeballType));

        globalScene.animations.addPokeballOpenParticles(this.pokeball.x, this.pokeball.y, this.pokeballType);

        globalScene.tweens.add({
          // Mon enters ball
          targets: pokemon,
          duration: 500,
          ease: "Sine.easeIn",
          scale: 0.25,
          y: 20,
          onComplete: () => {
            // Ball closes
            this.pokeball.setTexture("pb", `${pokeballAtlasKey}_opening`);
            pokemon.setVisible(false);
            audioManager.playSound("se/pb_catch");
            globalScene.time.delayedCall(17, () => this.pokeball.setTexture("pb", `${pokeballAtlasKey}`));

            const doShake = () => {
              // After the overall catch rate check, the game does 3 shake checks before confirming the catch.
              let shakeCount = 0;
              const pbX = this.pokeball.x;
              const shakeCounter = globalScene.tweens.addCounter({
                from: 0,
                to: 1,
                repeat: isCritical ? 2 : 4, // Critical captures only perform 1 shake check
                yoyo: true,
                ease: "Cubic.easeOut",
                duration: 250,
                repeatDelay: 500,
                onUpdate: t => {
                  if (shakeCount && shakeCount < (isCritical ? 2 : 4)) {
                    const value = t.getValue() ?? 0;
                    const directionMultiplier = shakeCount % 2 === 1 ? 1 : -1;
                    this.pokeball.setX(pbX + value * 4 * directionMultiplier);
                    this.pokeball.setAngle(value * 27.5 * directionMultiplier);
                  }
                },
                onRepeat: () => {
                  if (shakeCount++ < (isCritical ? 1 : 3)) {
                    // Shake check (skip check for critical or guaranteed captures, but still play the sound)
                    if (
                      pokeballMultiplier === -1
                      || isCritical
                      || modifiedCatchRate >= 255
                      || pokemon.randBattleSeedInt(65536) < shakeProbability
                    ) {
                      audioManager.playSound("se/pb_move");
                    } else {
                      shakeCounter.stop();
                      this.failCatch(shakeCount);
                    }
                  } else if (isCritical && pokemon.randBattleSeedInt(65536) >= shakeProbability) {
                    // Above, perform the one shake check for critical captures after the ball shakes once
                    shakeCounter.stop();
                    this.failCatch(shakeCount);
                  } else {
                    audioManager.playSound("se/pb_lock");
                    globalScene.animations.addPokeballCaptureStars(this.pokeball);

                    const pbTint = globalScene.add.sprite(this.pokeball.x, this.pokeball.y, "pb", "pb");
                    pbTint.setOrigin(this.pokeball.originX, this.pokeball.originY);
                    pbTint.setTintFill(0);
                    pbTint.setAlpha(0);
                    globalScene.field.add(pbTint);
                    globalScene.tweens.add({
                      targets: pbTint,
                      alpha: 0.375,
                      duration: 200,
                      easing: "Sine.easeOut",
                      onComplete: () => {
                        globalScene.tweens.add({
                          targets: pbTint,
                          alpha: 0,
                          duration: 200,
                          easing: "Sine.easeIn",
                          onComplete: () => pbTint.destroy(),
                        });
                      },
                    });
                  }
                },
                onComplete: () => {
                  this.catch();
                },
              });
            };

            // Ball bounces (handled in pokemon.ts)
            globalScene.time.delayedCall(250, () =>
              doPokeballBounceAnim(this.pokeball, 16, 72, 350, doShake, isCritical),
            );
          },
        });
      },
    });
  }

  failCatch(_shakeCount: number) {
    const pokemon = this.getPokemon();

    audioManager.playSound("se/pb_rel");
    pokemon.setY(this.originalY);
    if (pokemon.status?.effect !== StatusEffect.SLEEP) {
      pokemon.cry(pokemon.getHpRatio() > 0.25 ? undefined : { rate: 0.85 });
    }
    pokemon.tint(getPokeballTintColor(this.pokeballType));
    pokemon.setVisible(true);
    pokemon.untint(250, "Sine.easeOut");

    const substitute = pokemon.getTag(SubstituteTag);
    if (substitute) {
      substitute.sprite.setVisible(true);
    }

    const pokeballAtlasKey = getPokeballAtlasKey(this.pokeballType);
    this.pokeball.setTexture("pb", `${pokeballAtlasKey}_opening`);
    globalScene.time.delayedCall(17, () => this.pokeball.setTexture("pb", `${pokeballAtlasKey}_open`));

    globalScene.tweens.add({
      targets: pokemon,
      duration: 250,
      ease: "Sine.easeOut",
      scale: 1,
    });

    globalScene.currentBattle.lastUsedPokeball = this.pokeballType;
    this.removePb();
    this.end();
  }

  catch() {
    const { gameData, phaseManager, pokemonInfoContainer, ui } = globalScene;
    const pokemon = this.getPokemon() as EnemyPokemon;

    const speciesForm = pokemon.fusionSpecies ? pokemon.getFusionSpeciesForm() : pokemon.getSpeciesForm();

    // Co-op (D4a): only the thrower's client writes to its account for what the thrower catches; the partner's client
    // saw the Pokémon already
    const thrower = this.getThrowerSeat();
    const writes = thrower === null || writesForSeat(thrower);

    if (
      writes
      && speciesForm.abilityHidden
      && (pokemon.fusionSpecies ? pokemon.fusionAbilityIndex : pokemon.abilityIndex)
        === speciesForm.getAbilityCount() - 1
    ) {
      globalScene.validateAchv(achvs.HIDDEN_ABILITY);
    }

    if (writes && pokemon.species.subLegendary) {
      globalScene.validateAchv(achvs.CATCH_SUB_LEGENDARY);
    }

    if (writes && pokemon.species.legendary) {
      globalScene.validateAchv(achvs.CATCH_LEGENDARY);
    }

    if (writes && pokemon.species.mythical) {
      globalScene.validateAchv(achvs.CATCH_MYTHICAL);
    }

    pokemonInfoContainer.show(pokemon, true);

    if (writes) {
      gameData.updateSpeciesDexIvs(pokemon.species.getRootSpeciesId(true), pokemon.ivs);
    }

    const addStatus = new BooleanHolder(true);
    applyChallenges(ChallengeType.POKEMON_ADD_TO_PARTY, pokemon, addStatus);

    ui.showText(
      i18next.t(addStatus.value ? "battle:pokemonCaught" : "battle:pokemonCaughtButChallenge", {
        pokemonName: pokemon.name,
      }),
      null,
      () => {
        const end = () => {
          phaseManager.unshiftNew("VictoryPhase", this.battlerIndex);
          pokemonInfoContainer.hide();
          this.removePb();
          this.end();
        };
        const removePokemon = () => {
          globalScene.addFaintedEnemyScore(pokemon);
          pokemon.hp = 0;
          pokemon.doSetStatus(StatusEffect.FAINT);
          globalScene.clearEnemyHeldItemModifiers();
          pokemon.leaveField(true, true, true);
        };
        /** @param owner - Co-op (D10): who gets the catch; the thrower unless a partner's Pokémon made room for it */
        const addToParty = (slotIndex?: number, owner: Seat | null = thrower) => {
          const newPokemon = pokemon.addToParty(this.pokeballType, slotIndex);
          const session = getCoopSession();
          if (session !== null && owner !== null) {
            // The catch belongs to the thrower, or to the player whose Pokémon was released for it (D10, amended); a
            // Pokémon that was released is no one's any more
            if (newPokemon) {
              session.ownership.set(newPokemon.id, owner);
            }
            session.ownership.retain(globalScene.getPlayerParty().map(member => member.id));
          }
          const modifiers = globalScene.findModifiers(m => m instanceof PokemonHeldItemModifier, false);
          if (writes && globalScene.getPlayerParty().filter(p => p.isShiny()).length === PLAYER_PARTY_MAX_SIZE) {
            globalScene.validateAchv(achvs.SHINY_PARTY);
          }
          Promise.all(modifiers.map(m => globalScene.addModifier(m, true))).then(() => {
            globalScene.updateModifiers(true);
            removePokemon();
            if (newPokemon) {
              newPokemon.leaveField(true, true, false);
              newPokemon.loadAssets().then(end);
            } else {
              end();
            }
          });
        };
        Promise.all([pokemon.hideInfo(), writes ? gameData.setPokemonCaught(pokemon) : Promise.resolve(false)]).then(
          () => {
            if (!addStatus.value) {
              removePokemon();
              end();
              return;
            }
            if (this.isSeatFull(thrower)) {
              /** Co-op with a network: the thrower's answer, which the prompts below give instead of acting on it */
              let answer: ((payload: CatchReleasePayload) => void) | null = null;
              const addToPartyMenuConfig: OptionSelectModeConfig = {
                options: [
                  {
                    label: i18next.t("partyUiHandler:summary"),
                    handler: () => {
                      const newPokemon = globalScene.addPlayerPokemon(
                        pokemon.species,
                        pokemon.level,
                        pokemon.abilityIndex,
                        pokemon.formIndex,
                        pokemon.gender,
                        pokemon.shiny,
                        pokemon.variant,
                        pokemon.ivs,
                        pokemon.nature,
                        pokemon,
                      );
                      ui.setMode(
                        UiMode.SUMMARY,
                        newPokemon,
                        0,
                        SummaryUiMode.DEFAULT,
                        () => {
                          ui.setMode(UiMode.MESSAGE).then(() => promptRelease());
                        },
                        false,
                      );
                      return true;
                    },
                  },
                  {
                    label: i18next.t("menuUiHandler:pokedex"),
                    handler: () => {
                      const attributes = {
                        shiny: pokemon.shiny,
                        variant: pokemon.variant,
                        form: pokemon.formIndex,
                        female: pokemon.gender === Gender.FEMALE,
                      };
                      ui.setOverlayMode(UiMode.POKEDEX_PAGE, pokemon.species, attributes, null, null, () => {
                        ui.setMode(UiMode.MESSAGE).then(() => promptRelease());
                      });
                      return true;
                    },
                  },
                  {
                    label: i18next.t("menu:yes"),
                    handler: () => {
                      ui.setMode(
                        UiMode.PARTY,
                        PartyUiMode.RELEASE,
                        this.fieldIndex,
                        (slotIndex: number, _option: PartyOption) => {
                          ui.setMode(UiMode.MESSAGE).then(() => {
                            if (slotIndex < PLAYER_PARTY_MAX_SIZE) {
                              if (answer === null) {
                                addToParty(slotIndex);
                              } else {
                                answer({ release: globalScene.getPlayerParty()[slotIndex].id });
                              }
                            } else {
                              promptRelease();
                            }
                          });
                        },
                      );
                      return true;
                    },
                  },
                  {
                    label: i18next.t("menu:no"),
                    handler: () => {
                      ui.setMode(UiMode.MESSAGE).then(() => {
                        if (answer === null) {
                          removePokemon();
                          end();
                        } else {
                          answer({ release: null });
                        }
                      });
                      return true;
                    },
                  },
                ],
                yOffset: 48,
                onResize: (w: number, _h: number) => {
                  pokemonInfoContainer.makeRoomForOptionSelectUi(w);
                },
              };
              const promptRelease = (): void => {
                ui.showText(noRoomQuestion(thrower, pokemon.getNameToRender()), null, () => {
                  ui.setMode(UiMode.OPTION_SELECT, addToPartyMenuConfig);
                });
              };
              if (isLinked() && thrower !== null) {
                // The thrower decides, the partner waits; both carry out the sequenced answer (D10)
                coopDecide<CatchReleasePayload>({
                  key: catchReleaseKey(globalScene.currentBattle.waveIndex, pokemon.id),
                  decider: thrower,
                  ask: () =>
                    new Promise<CatchReleasePayload>(resolve => {
                      answer = resolve;
                      promptRelease();
                    }),
                  wait: () =>
                    showWaitingLine(
                      coopText("partnerDecidesCatch", "{{partner}} is deciding about the catch…", {
                        // (the thrower, in a game of three: D40)
                        partner: getCoopSession()?.nameOf(thrower) ?? "",
                      }),
                    ),
                  isPayload: isCatchReleasePayload,
                })
                  .then(({ payload, key, seq }) => {
                    if (payload.release === null) {
                      removePokemon();
                      end();
                      return;
                    }
                    const party = globalScene.getPlayerParty();
                    const index = party.findIndex(member => member.id === payload.release);
                    const owner = getCoopSession()?.ownership.get(payload.release);
                    // The thrower releases one of their own, or one of a partner's that is not in the battle (D10,
                    // amended): the catch goes to the player whose Pokémon made room for it, so each keeps their share
                    if (
                      index < 0
                      || owner === undefined
                      || (owner !== thrower && globalScene.getPlayerField().includes(party[index]))
                    ) {
                      throw new DesyncError("the sequenced release is not a Pokémon the thrower may release", {
                        actual: key,
                        seq,
                      });
                    }
                    const released = party[index].getNameToRender();
                    globalScene.removePartyMemberModifiers(index);
                    party.splice(index, 1)[0].destroy();
                    addToParty(index, owner);
                    if (owner !== thrower && owner === getCoopSession()?.seat) {
                      // The player whose Pokémon it was is told, without stopping the game (in the chat box)
                      chatNote(
                        coopText(
                          "partnerReleasedForCatch",
                          "{{name}} released your {{released}}: {{caught}} is yours now.",
                          {
                            name: getCoopSession()?.nameOf(thrower) ?? "",
                            released,
                            caught: pokemon.getNameToRender(),
                          },
                        ),
                      );
                    }
                  })
                  .catch(reportBridgeError);
              } else {
                promptRelease();
              }
            } else {
              addToParty();
            }
          },
        );
      },
      0,
      true,
    );
  }

  removePb() {
    globalScene.tweens.add({
      targets: this.pokeball,
      duration: 250,
      delay: 250,
      ease: "Sine.easeIn",
      alpha: 0,
      onComplete: () => this.pokeball.destroy(),
    });
  }
}
