/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PLAYER_PARTY_MAX_SIZE } from "#app/constants";
import { globalScene } from "#app/global-scene";
import { coopDecide, coopText, mySeat } from "#coop/bridge";
import { notYourPokemonText } from "#coop/control";
import { isMeChoiceOf, type MeChoice, type MeChoiceKind, type MeQuestion, meChoiceKey } from "#coop/me-choice";
import { STARTERS_PER_SEAT } from "#coop/ownership";
import type { Seat } from "#coop/protocol";
import { getCoopSession, isCoop, requireCoopSession } from "#coop/session";
import { MysteryEncounterOptionMode } from "#enums/mystery-encounter-option-mode";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { PartyUiMode } from "#enums/party-ui-mode";
import { Stat } from "#enums/stat";
import { UiMode } from "#enums/ui-mode";
import type { EnemyPokemon, PlayerPokemon } from "#field/pokemon";
import { showEncounterText } from "#mystery-encounters/encounter-dialogue-utils";
import type { MysteryEncounterOption } from "#mystery-encounters/mystery-encounter-option";
import type { OptionSelectItem, OptionSelectModeConfig } from "#types/ui-types";
import type { MysteryEncounterUiHandler } from "#ui/mystery-encounter-ui-handler";
import type { PokemonSelectFilter } from "#ui/party-ui-handler";
import i18next from "i18next";

/**
 * The game's side of the encounter choices (DECISIONS D29): every place where an encounter waits for its player asks the
 * chooser instead, as an `ME_CHOICE` decision, and both clients carry on with the answer. The chooser is the host, or the
 * player who goes in a one-Pokémon encounter; the other one waits, and may take over after 90 s (D17).
 *
 * @module
 */

type ChoiceOf<K extends MeChoiceKind> = Extract<MeChoice, { k: K }>;

/** @returns Who makes the choices of the encounter that is open */
export function meChooser(): Seat {
  return requireCoopSession().meChooser;
}

/** The seed offset of an option's requirement check, apart from the encounter's own offsets */
const REQUIREMENT_SEED_OFFSET = 77;

/**
 * Whether an option can be chosen. The check may draw (it picks the encounter's primary Pokémon), and the option screen is
 * drawn again on one client alone (back from "View Party"): in co-op it draws from its own seeded stream, so it gives the
 * same answer on both clients however often it is asked, and the run's stream does not move.
 */
export function coopMeetsRequirements(option: MysteryEncounterOption): boolean {
  let met = false;
  globalScene.executeWithSeedOffset(() => {
    met = option.meetsRequirements();
  }, globalScene.currentBattle.mysteryEncounter!.getSeedOffset() + REQUIREMENT_SEED_OFFSET);
  return met;
}

/** @returns Which options of an encounter's screen can be chosen (the disabled ones that do not meet their requirements cannot) */
export function choosableOptions(options: readonly MysteryEncounterOption[]): boolean[] {
  return options.map(
    option =>
      coopMeetsRequirements(option)
      || (option.optionMode !== MysteryEncounterOptionMode.DISABLED_OR_DEFAULT
        && option.optionMode !== MysteryEncounterOptionMode.DISABLED_OR_SPECIAL),
  );
}

/** An encounter's first option screen: its decisions are counted from here, and the host chooses until told otherwise */
export function beginCoopEncounter(): void {
  const session = requireCoopSession();
  session.meStep = 0;
  session.meChooser = "host";
  session.meLoneEnemy = null;
}

/**
 * A Pokémon an encounter put in place of another (a GTS trade, a Weird Dream transformation) belongs to the owner of the one
 * it replaced (D29); the one that left is no one's any more. Nothing in solo play.
 */
export function passOwnership(previous: { id: number }, next: { id: number }): void {
  const session = getCoopSession();
  if (session === null) {
    return;
  }
  session.ownership.set(next.id, session.ownership.get(previous.id) ?? session.meChooser);
  session.ownership.retain(globalScene.getPlayerParty().map(member => member.id));
}

/** Whether a seat has as many Pokémon as it may (the cap of 3, D10), or the party is full */
export function coopSeatFull(seat: Seat): boolean {
  const party = globalScene.getPlayerParty();
  return (
    requireCoopSession().ownership.countOwned(
      party.map(member => member.id),
      seat,
    ) >= STARTERS_PER_SEAT || party.length >= PLAYER_PARTY_MAX_SIZE
  );
}

// #region Battles (D29)

/** Every encounter battle is a double in co-op, unless the party is down to one Pokémon (a one-Pokémon encounter) */
export function coopEncounterDouble(): boolean {
  return isCoop() && globalScene.getPlayerParty().length >= 2;
}

/**
 * A lone wild Pokémon stays two against one, and is made stronger: one more boss shield (a Pokémon that is not a boss
 * becomes one of two), and +1 to its stats once it is out ({@linkcode queueLoneEnemyBoost}); beating it pays more
 * ({@linkcode isLoneEnemy}).
 */
export function markLoneEnemy(enemy: EnemyPokemon): void {
  enemy.setBoss(true, enemy.isBoss() ? enemy.bossSegments + 1 : 2);
  requireCoopSession().meLoneEnemy = enemy.id;
}

/** @returns Whether this is the lone enemy of an encounter battle: its EXP is doubled, and its defeat pays a trainer's money */
export function isLoneEnemy(pokemon: { id: number }): boolean {
  return getCoopSession()?.meLoneEnemy === pokemon.id;
}

/** The lone enemy's +1 to Attack, Defense, Sp. Atk, Sp. Def and Speed, once both sides are out */
export function queueLoneEnemyBoost(): void {
  const enemy = globalScene.getEnemyParty().find(pokemon => isLoneEnemy(pokemon));
  if (enemy === undefined) {
    return;
  }
  globalScene.phaseManager.pushNew("StatStageChangePhase", {
    battlerIndex: enemy.getBattlerIndex(),
    changes: ([Stat.ATK, Stat.DEF, Stat.SPATK, Stat.SPDEF, Stat.SPD] as const).map(stat => ({ stat, stages: 1 })),
    sourcePokemon: enemy,
    ignoreAbilities: true,
  });
}

// #endregion

/**
 * "{chooser} is choosing…" for the player who waits: on the encounter's screen under its description (the message box is
 * under the options there), elsewhere in the message box
 */
export function showChooserWaiting(what: "option" | "pokemon" = "option"): void {
  const partner = requireCoopSession().partnerName;
  const text =
    what === "pokemon"
      ? coopText("meChoosingPokemon", "{{partner}} is choosing a Pokémon…", { partner })
      : coopText("meChoosing", "{{partner}} is choosing…", { partner });
  const { ui } = globalScene;
  if (ui.mode === UiMode.MYSTERY_ENCOUNTER) {
    (ui.getHandler() as MysteryEncounterUiHandler).setWaitingLine(text);
    return;
  }
  ui.showText(text, null, undefined, null, false);
}

/** Answers a test gives instead of the chooser's screens (tests only: the encounter tour, D29) */
export interface MeAutoAnswers {
  /** The answer to an encounter question */
  choose(question: MeQuestion): MeChoice;
  /** The catch of an encounter at the cap: which of the chooser's Pokémon to release, or `null` to decline */
  release(own: readonly number[]): number | null;
}

let autoAnswers: MeAutoAnswers | null = null;

/** Tests only: answer the encounter's questions of this client's player with these, instead of the screens */
export function setMeAutoAnswers(answers: MeAutoAnswers | null): void {
  autoAnswers = answers;
}

/** Tests only: the answers set with {@linkcode setMeAutoAnswers}, if any */
export function meAutoAnswers(): MeAutoAnswers | null {
  return autoAnswers;
}

/**
 * Ask the chooser one encounter choice; both clients get the same answer.
 * @param question - What may be answered (the legality check of the answer, D24)
 * @param ask - The chooser's screen: resolves with the choice
 * @param wait - What the other player sees meanwhile
 */
export async function meDecide<K extends MeChoiceKind>(
  question: MeQuestion & { k: K },
  ask: () => Promise<ChoiceOf<K>>,
  wait: () => void = () => showChooserWaiting(),
): Promise<ChoiceOf<K>> {
  const session = requireCoopSession();
  const key = meChoiceKey(globalScene.currentBattle.waveIndex, session.meStep++);
  session.meQuestion = question;
  const auto = autoAnswers;
  try {
    const { payload } = await coopDecide<ChoiceOf<K>>({
      key,
      decider: session.meChooser,
      ask: auto === null ? ask : async () => auto.choose(question) as ChoiceOf<K>,
      wait,
      isPayload: isMeChoiceOf(question.k),
    });
    return payload;
  } finally {
    if (session.meQuestion === question) {
      session.meQuestion = null;
    }
  }
}

/**
 * @returns Whose Pokémon the chooser picks from: anyone's (`null`), as in solo play; in a one-Pokémon encounter only the
 * player's who goes, who then plays the one they pick
 */
function pickableOwner(chooser: Seat): Seat | null {
  const encounter = globalScene.currentBattle.mysteryEncounter;
  return encounter != null && isOnePokemonEncounter(encounter.encounterType) ? chooser : null;
}

/** The Pokémon the chooser may pick that `filter` allows */
function choosablePokemon(chooser: Seat, filter?: PokemonSelectFilter): number[] {
  const { ownership } = requireCoopSession();
  const owner = pickableOwner(chooser);
  return globalScene
    .getPlayerParty()
    .filter(pokemon => (owner === null || ownership.get(pokemon.id) === owner) && (filter?.(pokemon) ?? null) === null)
    .map(pokemon => pokemon.id);
}

/** The party screen filter of a co-op choice: what the encounter allows, of the goer's own in a one-Pokémon encounter */
function chooserFilter(chooser: Seat, filter?: PokemonSelectFilter): PokemonSelectFilter {
  const owner = pickableOwner(chooser);
  return (pokemon: PlayerPokemon) => {
    if (owner !== null && requireCoopSession().ownership.get(pokemon.id) !== owner) {
      // The taker of a choice (D17) picks among the chooser's, not its own
      return chooser === mySeat()
        ? notYourPokemonText(pokemon)
        : coopText("meChooseTheirs", "Choose one of {{partner}}'s Pokémon.", {
            partner: requireCoopSession().partnerName,
          });
    }
    return filter?.(pokemon) ?? null;
  };
}

/** The chooser's party screen: resolves with the Pokémon, or `null` for going back */
function askPokemon(chooser: Seat, filter?: PokemonSelectFilter): Promise<ChoiceOf<"pokemon">> {
  return new Promise(resolve => {
    globalScene.ui.setMode(
      UiMode.PARTY,
      PartyUiMode.SELECT,
      -1,
      (slotIndex: number) => {
        const party = globalScene.getPlayerParty();
        resolve({ k: "pokemon", pokemonId: slotIndex < party.length ? party[slotIndex].id : null });
      },
      chooserFilter(chooser, filter),
    );
  });
}

/**
 * The screen a Pokémon pick goes back to: where the encounter was. The waiting player may be looking at the party (View
 * Party) when the pick starts; the party is not where the encounter goes on
 */
function exitMode(): UiMode {
  const { mode } = globalScene.ui;
  return mode === UiMode.PARTY ? UiMode.MYSTERY_ENCOUNTER : mode;
}

/**
 * The player leaves View Party of an encounter's options. The encounter goes on meanwhile in co-op (D29): its options come
 * back only while one of its choices is open, else the message box.
 * @returns Whether to show the options again
 */
export function viewPartyBackToOptions(): boolean {
  const session = getCoopSession();
  if (session === null || !isCoop()) {
    return true;
  }
  const question = session.meQuestion?.k;
  return question === "option" || question === "pokemon" || question === "optionPokemon";
}

/** Back on the encounter's options while the partner chooses: who the player waits for is said again under them */
export function refreshChooserWaiting(): void {
  const session = getCoopSession();
  const question = session?.meQuestion?.k;
  if (session == null || question == null || session.meChooser === mySeat()) {
    return;
  }
  showChooserWaiting(question === "option" ? "option" : "pokemon");
}

/** A menu of the chooser's (the encounter's entries and "Cancel"): resolves with the entry, or `null` for cancel */
function askMenu(
  options: readonly OptionSelectItem[],
  onPick: (index: number | null) => void,
  onHoverOverCancel?: () => void,
): void {
  const full: OptionSelectItem[] = options
    .map(
      (option, index): OptionSelectItem => ({
        ...option,
        handler: () => {
          onPick(index);
          return true;
        },
      }),
    )
    .concat({
      label: i18next.t("menu:cancel"),
      handler: () => {
        onPick(null);
        return true;
      },
      onHover: () => {
        onHoverOverCancel?.();
        showEncounterText(i18next.t("mysteryEncounterMessages:cancelOption"), 0, 0, false);
      },
    });
  const config: OptionSelectModeConfig = { options: full, maxOptions: 7, yOffset: 48 };
  full[0]?.onHover?.();
  globalScene.ui.setModeWithoutClear(UiMode.OPTION_SELECT, config);
}

/**
 * `selectPokemonForOption` in a linked run: the chooser picks a Pokémon of the party (one decision); both clients run
 * `onPokemonSelected` with it, and if it offers a menu, the chooser picks from that (a second decision) and both run the
 * entry's handler. Going back at either step is `false`, as in solo play.
 */
export async function coopSelectPokemonForOption(
  // biome-ignore lint/suspicious/noConfusingVoidType: the same callback as upstream's `selectPokemonForOption`
  onPokemonSelected: (pokemon: PlayerPokemon) => void | OptionSelectItem[],
  onPokemonNotSelected?: () => void,
  selectablePokemonFilter?: PokemonSelectFilter,
): Promise<boolean> {
  const modeToSetOnExit = exitMode();
  const chooser = meChooser();
  const picked = await meDecide(
    { k: "pokemon", pokemon: choosablePokemon(chooser, selectablePokemonFilter) },
    () => askPokemon(chooser, selectablePokemonFilter),
    () => showChooserWaiting("pokemon"),
  );
  await globalScene.ui.setMode(modeToSetOnExit);
  const pokemon = globalScene.getPlayerParty().find(member => member.id === picked.pokemonId);
  if (pokemon === undefined) {
    onPokemonNotSelected?.();
    return false;
  }

  const encounter = globalScene.currentBattle.mysteryEncounter!;
  const secondaryOptions = onPokemonSelected(pokemon);
  if (!secondaryOptions) {
    encounter.setDialogueToken("selectedPokemon", pokemon.getNameToRender());
    return true;
  }

  // There is a menu to choose from after the Pokémon
  await globalScene.ui.setMode(UiMode.MESSAGE);
  const textPromptKey = encounter.selectedOption?.dialogue?.secondOptionPrompt;
  const entry = await meDecide(
    { k: "sub", enabled: secondaryOptions.map(() => true) },
    () =>
      new Promise<ChoiceOf<"sub">>(resolve => {
        const show = (): void => askMenu(secondaryOptions, index => resolve({ k: "sub", index }));
        if (textPromptKey) {
          showEncounterText(textPromptKey).then(show);
        } else {
          show();
        }
      }),
  );
  if (entry.index === null) {
    globalScene.ui.clearText();
    await globalScene.ui.setMode(modeToSetOnExit);
    return false;
  }
  secondaryOptions[entry.index].handler();
  encounter.setDialogueToken("selectedPokemon", pokemon.getNameToRender());
  return true;
}

/**
 * `selectOptionThenPokemon` in a linked run: the chooser picks an entry, then a Pokémon of the party, as one decision;
 * both clients run the entry's handler with them.
 * @returns The party index and the entry, or `null` if the chooser went back
 */
export async function coopSelectOptionThenPokemon(
  options: OptionSelectItem[],
  optionSelectPromptKey: string,
  selectablePokemonFilter?: PokemonSelectFilter,
  onHoverOverCancelOption?: () => void,
): Promise<{ selectedPokemonIndex: number; selectedOptionIndex: number } | null> {
  const modeToSetOnExit = exitMode();
  const chooser = meChooser();
  const choice = await meDecide(
    {
      k: "optionPokemon",
      enabled: options.map(() => true),
      pokemon: choosablePokemon(chooser, selectablePokemonFilter),
    },
    () =>
      new Promise<ChoiceOf<"optionPokemon">>(resolve => {
        const showMenu = async (): Promise<void> => {
          await globalScene.ui.setMode(UiMode.MESSAGE);
          if (optionSelectPromptKey) {
            showEncounterText(optionSelectPromptKey);
          }
          askMenu(
            options,
            index => {
              if (index === null) {
                resolve({ k: "optionPokemon", index: null, pokemonId: null });
                return;
              }
              // the Pokémon for that entry; going back returns to the entries
              askPokemon(chooser, selectablePokemonFilter).then(({ pokemonId }) => {
                if (pokemonId === null) {
                  showMenu();
                } else {
                  resolve({ k: "optionPokemon", index, pokemonId });
                }
              });
            },
            onHoverOverCancelOption,
          );
        };
        showMenu();
      }),
  );
  await globalScene.ui.setMode(modeToSetOnExit);
  if (choice.index === null || choice.pokemonId === null) {
    globalScene.ui.clearText();
    return null;
  }
  options[choice.index].handler();
  return {
    selectedPokemonIndex: globalScene.getPlayerParty().findIndex(member => member.id === choice.pokemonId),
    selectedOptionIndex: choice.index,
  };
}

/** An encounter's own yes/no question, asked of the chooser: both clients get the answer */
export async function coopConfirm(ask: () => Promise<boolean>): Promise<boolean> {
  const choice = await meDecide({ k: "confirm" }, async () => ({ k: "confirm", yes: await ask() }));
  return choice.yes;
}

// #region One-Pokémon encounters (D29)

/** The encounters that only one Pokémon takes part in, and how many Pokémon able to fight the one who goes needs */
const ONE_POKEMON_ENCOUNTERS = new Map<MysteryEncounterType, number>([
  [MysteryEncounterType.THE_EXPERT_POKEMON_BREEDER, 3],
  [MysteryEncounterType.FUN_AND_GAMES, 1],
]);

/** What an encounter sets up again for the player who goes (the Breeder's three choices are of their Pokémon) */
const goerSetUps = new Map<MysteryEncounterType, (pool: PlayerPokemon[]) => void>();

/** An encounter module registers how it sets itself up for the player who goes */
export function registerGoerSetUp(type: MysteryEncounterType, setUp: (pool: PlayerPokemon[]) => void): void {
  goerSetUps.set(type, setUp);
}

/** @returns Whether only one player can take part in this encounter: the host first decides who goes */
export function isOnePokemonEncounter(type: MysteryEncounterType): boolean {
  return ONE_POKEMON_ENCOUNTERS.has(type);
}

/** A seat's Pokémon that can fight */
function fightersOf(seat: Seat): PlayerPokemon[] {
  const { ownership } = requireCoopSession();
  return globalScene
    .getPlayerParty()
    .filter(pokemon => ownership.get(pokemon.id) === seat && pokemon.isAllowedInBattle());
}

/**
 * The host decides who goes in a one-Pokémon encounter: itself, the guest, or nobody. Only a player with enough Pokémon
 * able to fight is offered.
 * @returns Who goes (the encounter is then set up with their Pokémon, and they make its choices), or `null` for nobody
 */
export async function askWhoGoes(type: MysteryEncounterType): Promise<Seat | null> {
  const needed = ONE_POKEMON_ENCOUNTERS.get(type) ?? 1;
  const seats = (["host", "guest"] as const).filter(seat => fightersOf(seat).length >= needed);
  const session = requireCoopSession();
  const choice = await meDecide(
    { k: "who", seats },
    () =>
      new Promise<ChoiceOf<"who">>(resolve => {
        const partner = session.partnerName;
        const options: OptionSelectItem[] = [];
        for (const seat of seats) {
          options.push({
            label:
              seat === mySeat()
                ? coopText("meIGo", "I'll go")
                : coopText("mePartnerGoes", "{{partner}} goes", { partner }),
            handler: () => {
              resolve({ k: "who", seat });
              return true;
            },
          });
        }
        options.push({
          label: coopText("meNobodyGoes", "Skip it"),
          handler: () => {
            resolve({ k: "who", seat: null });
            return true;
          },
        });
        globalScene.ui.showText(
          coopText("meWhoGoes", "Only one Pokémon can take part in this. Who goes?"),
          null,
          () => globalScene.ui.setModeWithoutClear(UiMode.OPTION_SELECT, { options, yOffset: 48 }),
          null,
          false,
        );
      }),
  );
  if (choice.seat !== null) {
    session.meChooser = choice.seat;
    goerSetUps.get(type)?.(fightersOf(choice.seat));
  }
  return choice.seat;
}

// #endregion
