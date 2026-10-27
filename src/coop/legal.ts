/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { checkMeChoice, type MeQuestion } from "#coop/me-choice";
import type { OwnerMap } from "#coop/ownership";
import { checkPartyEdit, type PartyMemberView } from "#coop/party-edit";
import {
  isBiomePayload,
  isCatchReleasePayload,
  isEvolutionCancelPayload,
  isEvolutionPausePayload,
  isLearnMovePayload,
} from "#coop/prompt-payloads";
import type { DecisionKey, Seat } from "#coop/protocol";
import { isRetryPayload } from "#coop/retry";
import { isRewardAction, isRewardKind, kindOfAction, type RewardAction } from "#coop/reward-actions";
import { checkTradeProposal, isTradeDonePayload, isTradeProposePayload } from "#coop/trade";
import {
  isSideActionPayload,
  isSidePickPayload,
  isTurnCommandsPayload,
  type WireTurnCommand,
} from "#coop/turn-commands";

/**
 * Is a sequenced decision legal? (DECISIONS D24)
 *
 * Both clients ask this of every decision just before they apply it, against the state they have at that moment (the
 * simulation waits for the decision, so the state is the same on both). A decision that is not legal is not applied by
 * either: the sequencer raises a `DesyncError` ("illegal decision: ...") and the run goes through the resync path of D13. The
 * host asks it of its own and of the guest's decisions alike, so a forged or corrupted payload cannot make the two clients
 * differ.
 *
 * These are pure functions of the decision and a {@linkcode LegalityView}, a small read-only picture of the state that the
 * game fills in (`legal-view.ts`). Nothing here imports the game, so Node tests feed it illegal payloads of every kind. A check
 * never throws: whatever the payload looks like, the answer is a reason or `null`.
 *
 * @module
 */

/** Command numbers on the wire (`Command` of the game) */
const FIGHT = 0;
const BALL = 1;
const POKEMON = 2;
const RUN = 3;
const TERA = 4;

/** `MoveId.NONE` and `MoveId.STRUGGLE` */
const MOVE_NONE = 0;
const MOVE_STRUGGLE = 165;

/** What a Pokémon of the player's side that is on the field can do this turn */
export interface FighterView {
  fieldIndex: number;
  /** The seat that chooses its commands */
  controller: Seat;
  /** The moveset, in order: the move and whether it can be selected now (PP, disabled, locked) */
  moves: readonly { id: number; usable: boolean }[];
  /** The move it is made to use next (a two-turn move, a rampage), if any */
  queuedMove: number | null;
  /** Whether it can be switched out of the field */
  trapped: boolean;
  /** Whether it can Terastallize this turn */
  canTera: boolean;
  /** The party indices it may switch to by its own choice */
  switchTargets: readonly number[];
  /** Where a move can go: the candidates, and whether the move hits all of them */
  targetsOf(moveId: number): { targets: readonly number[]; multiple: boolean };
}

/** One entry of the reward screen: what it asks of its player, and what it costs */
export interface RewardOptionView {
  /** `none`: a plain item; `pokemon`: for one Pokémon; `fuse`: for two; `move`: for one Pokémon and one of its moves */
  target: "none" | "pokemon" | "fuse" | "move";
  /** The price in the shop; `0` for a free pick */
  cost: number;
}

export interface RewardView {
  options: readonly RewardOptionView[];
  shop: readonly RewardOptionView[];
  money: number;
  /** Rerolls (and the Lock Capsule) are off when this is below 0 */
  rerollCost: number;
  /** A test override makes everything free */
  waived: boolean;
}

/** A read-only picture of the state a decision is checked against. Every query answers `undefined` or `null` for "no such thing". */
export interface LegalityView {
  /** The seat that owns a Pokémon of the party, by `pokemon.id` */
  ownerOf(pokemonId: number): Seat | undefined;
  /** A Pokémon of the player's side that fights now */
  fighter(pokemonId: number): FighterView | null;
  /** Whether a Ball may be thrown, and a Run attempted (a wild battle) */
  canCatch: boolean;
  canRun: boolean;
  /** Balls left, by type (`PokeballType`) */
  ballCount(type: number): number;
  /** The party indices that may replace the Pokémon that left (a faint or a pivot) */
  replacements(leavingId: number, reason: "faint" | "voluntary"): readonly number[];
  /** The reward screen that is open, if one is */
  reward(): RewardView | null;
  /** How many items of a Pokémon can be moved, and how many of each there are */
  transferable(pokemonId: number): readonly number[];
  /** How many moves a Pokémon knows (the learn-move prompt asks which to forget) */
  moveCount(pokemonId: number): number | null;
  /** The biomes the picker may choose from, while the Map is open */
  biomeChoices(): readonly number[] | null;
  /** Who owns what, for the trade rules */
  ownership(): OwnerMap | undefined;
  /** The party in order, as a party edit is checked against it (D28) */
  partyMembers(): readonly PartyMemberView[];
  /** The choice an encounter asks now, if one does (D29) */
  meQuestion(): MeQuestion | null;
  /** The Pokémon whose Ball or Run may be picked, while both players chose one this turn (D8) */
  sidePick(): readonly number[] | null;
}

const reasonOf = (text: string): string => text;

/** `"12"` or `"12:3"`: the Pokémon of a key whose ref starts with its id */
function pokemonOfRef(ref: DecisionKey["ref"]): number | null {
  const id = typeof ref === "number" ? ref : Number(String(ref).split(":")[0]);
  return Number.isInteger(id) ? id : null;
}

const isIndex = (value: unknown, below: number): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) < below;

// #region Turn commands

function checkFight(fighter: FighterView, command: WireTurnCommand): string | null {
  if (command.skip === true) {
    return null; // a command that is not carried out (the partner threw a Ball): nothing in it matters
  }
  const move = command.move;
  if (move === undefined) {
    return command.cursor === -1 ? null : reasonOf("a fight without a move");
  }
  const cursor = command.cursor ?? -1;
  const queued = fighter.queuedMove !== null && fighter.queuedMove === move.move;
  if (cursor === -1) {
    // A move that is made (or none at all): only what the Pokémon is bound to
    if (move.move !== MOVE_NONE && !queued) {
      return reasonOf("a move that is not in its moveset or its queue");
    }
  } else if (!isIndex(cursor, fighter.moves.length)) {
    return reasonOf(`move slot ${cursor} does not exist`);
  } else if (!queued) {
    const known = fighter.moves[cursor]!;
    const struggling = move.move === MOVE_STRUGGLE && fighter.moves.every(entry => !entry.usable);
    if (!struggling && known.id !== move.move) {
      return reasonOf(`slot ${cursor} holds move ${known.id}, not ${move.move}`);
    }
    if (!struggling && !known.usable) {
      return reasonOf("a move that cannot be selected");
    }
  }
  if (move.move === MOVE_NONE || queued) {
    return null; // a move that was already under way keeps the targets it had
  }
  // The target the player picked (`SelectTargetPhase` stores it on the command), else the ones the move has by itself
  const chosen = command.targets ?? move.targets;
  const where = fighter.targetsOf(move.move);
  if (where.multiple) {
    // A move that hits several is carried out on all of them, whatever the command says; it must still name battlers
    return chosen.every(target => isIndex(target, 4)) ? null : reasonOf(`targets [${chosen}] that are not battlers`);
  }
  const fits =
    where.targets.length === 0 ? chosen.length === 0 : chosen.length === 1 && where.targets.includes(chosen[0]!);
  return fits
    ? null
    : reasonOf(`targets [${chosen}] that move ${move.move} cannot have (it can go to one of [${where.targets}])`);
}

function checkCommand(view: LegalityView, fighter: FighterView, command: WireTurnCommand, pre: boolean): string | null {
  switch (command.command) {
    case FIGHT:
      return pre ? null : checkFight(fighter, command);
    case TERA:
      return pre && fighter.canTera ? null : reasonOf("a Terastallization that is not possible");
    case BALL:
      if (pre) {
        return reasonOf("a Ball before the turn");
      }
      if (!view.canCatch) {
        return reasonOf("a Ball where nothing can be caught");
      }
      return isIndex(command.cursor, 16) && view.ballCount(command.cursor) > 0
        ? null
        : reasonOf("a Ball that is not in the bag");
    case POKEMON:
      if (pre) {
        return reasonOf("a switch before the turn");
      }
      if (fighter.trapped) {
        return reasonOf("a switch of a Pokémon that is trapped");
      }
      return typeof command.cursor === "number" && fighter.switchTargets.includes(command.cursor)
        ? null
        : reasonOf("a switch to a Pokémon that cannot come in");
    case RUN:
      return !pre && view.canRun ? null : reasonOf("a Run where it is not allowed");
    default:
      return reasonOf("an unknown command");
  }
}

function checkTurnCommands(view: LegalityView, key: DecisionKey, payload: unknown): string | null {
  if (!isTurnCommandsPayload(payload)) {
    return reasonOf("commands that cannot be read");
  }
  const id = pokemonOfRef(key.ref);
  const fighter = id === null ? null : view.fighter(id);
  if (fighter === null) {
    return reasonOf("commands for a Pokémon that is not on the field");
  }
  if (payload.command !== null) {
    const problem = checkCommand(view, fighter, payload.command, false);
    if (problem !== null) {
      return problem;
    }
  }
  if (payload.pre !== null && payload.pre.command !== FIGHT) {
    return checkCommand(view, fighter, payload.pre, true);
  }
  return null;
}

// #endregion

// #region The reward screen

function checkTargets(
  option: RewardOptionView,
  action: Extract<RewardAction, { t: "pick" | "buy" }>,
  view: LegalityView,
  author: Seat,
): string | null {
  const known = (id: number | undefined): boolean => id !== undefined && view.ownerOf(id) !== undefined;
  switch (option.target) {
    case "none":
      return null;
    case "pokemon":
      return known(action.target) ? null : reasonOf("an item for a Pokémon that is not in the party");
    case "move":
      return known(action.target) && (action.option === undefined || isIndex(action.option, 100))
        ? null
        : reasonOf("an item for a move that does not exist");
    case "fuse":
      if (!known(action.target) || !known(action.target2) || action.target === action.target2) {
        return reasonOf("a fusion that does not name two Pokémon of the party");
      }
      // Two of the author's own: the partner's are not theirs to give up
      return view.ownerOf(action.target!) === author && view.ownerOf(action.target2!) === author
        ? null
        : reasonOf("a fusion of a Pokémon that is not the user's");
  }
}

function checkRewardAction(view: LegalityView, key: DecisionKey, payload: unknown, author: Seat): string | null {
  if (!isRewardAction(payload) || !isRewardKind(key.kind) || kindOfAction(payload) !== key.kind) {
    return reasonOf("a reward action that does not fit its key");
  }
  const screen = view.reward();
  if (screen === null) {
    return reasonOf("a reward action while no reward screen is open");
  }
  switch (payload.t) {
    case "skip":
      return null;
    case "pick": {
      const option = screen.options[payload.index];
      return option === undefined
        ? reasonOf(`reward ${payload.index} is not on the screen`)
        : checkTargets(option, payload, view, author);
    }
    case "buy": {
      const option = screen.shop[payload.index];
      if (option === undefined) {
        return reasonOf(`shop item ${payload.index} is not for sale`);
      }
      if (!screen.waived && screen.money < option.cost) {
        return reasonOf("a purchase that costs more than the money there is");
      }
      return checkTargets(option, payload, view, author);
    }
    case "reroll":
      return screen.rerollCost >= 0 && (screen.waived || screen.money >= screen.rerollCost)
        ? null
        : reasonOf("a reroll that is not possible or not affordable");
    case "lock":
      return screen.rerollCost >= 0 ? null : reasonOf("a Lock Capsule that is not possible");
    case "transfer": {
      if (
        view.ownerOf(payload.from) !== author
        || view.ownerOf(payload.to) === undefined
        || payload.from === payload.to
      ) {
        return reasonOf("a transfer between Pokémon that it may not join");
      }
      const stacks = view.transferable(payload.from);
      const taken = new Set<number>();
      for (const { index, quantity } of payload.items) {
        const have = stacks[index];
        if (have === undefined || taken.has(index) || quantity > have) {
          return reasonOf("a transfer of items that are not there");
        }
        taken.add(index);
      }
      return null;
    }
  }
}

// #endregion

function checkSwitch(view: LegalityView, key: DecisionKey, payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return reasonOf("a switch that cannot be read");
  }
  const { partyIndex, baton } = payload as Record<string, unknown>;
  if (typeof baton !== "boolean" || !(partyIndex === null || Number.isInteger(partyIndex))) {
    return reasonOf("a switch that cannot be read");
  }
  const leaving = pokemonOfRef(key.ref);
  if (partyIndex === null || leaving === null) {
    return null;
  }
  return view.replacements(leaving, key.kind === "FAINT_SWITCH" ? "faint" : "voluntary").includes(partyIndex as number)
    ? null
    : reasonOf("a replacement that may not come in");
}

/**
 * Whether a sequenced decision is legal in the state `view` shows.
 * @param author - The seat that made it
 * @returns The reason it is not, or `null` if it is
 */
export function checkDecisionLegal(
  view: LegalityView,
  key: DecisionKey,
  payload: unknown,
  author: Seat,
): string | null {
  switch (key.kind) {
    case "TURN_COMMANDS":
      return checkTurnCommands(view, key, payload);
    case "SIDE_ACTION":
      return isSideActionPayload(payload) ? null : reasonOf("an answer that cannot be read");
    case "SIDE_PICK": {
      if (!isSidePickPayload(payload)) {
        return reasonOf("an answer that cannot be read");
      }
      const picks = view.sidePick();
      if (picks === null) {
        return reasonOf("nobody has two side actions to pick from");
      }
      return picks.includes(payload.pokemonId) ? null : reasonOf("a Pokémon that chose no Ball or Run this turn");
    }
    case "FAINT_SWITCH":
    case "PIVOT_SWITCH":
      return checkSwitch(view, key, payload);
    case "REWARD_TARGET":
      return reasonOf("a decision of a kind that this version does not make");
    case "REWARD_PICK":
    case "SHOP_BUY":
    case "REROLL":
    case "REWARD_LOCK":
    case "REWARD_TRANSFER":
      return checkRewardAction(view, key, payload, author);
    case "LEARN_MOVE": {
      if (!isLearnMovePayload(payload)) {
        return reasonOf("an answer that cannot be read");
      }
      const known = view.moveCount(pokemonOfRef(key.ref) ?? -1);
      if (known === null) {
        return reasonOf("a move for a Pokémon that is not in the party");
      }
      return payload.replaceIndex === null || payload.replaceIndex < known
        ? null
        : reasonOf("a move to forget that it does not know");
    }
    case "EVOLUTION_CANCEL": {
      const ok = String(key.ref).endsWith(":pause")
        ? isEvolutionPausePayload(payload)
        : isEvolutionCancelPayload(payload);
      if (!ok) {
        return reasonOf("an answer that cannot be read");
      }
      return view.ownerOf(pokemonOfRef(key.ref) ?? -1) === undefined
        ? reasonOf("an evolution of a Pokémon that is not in the party")
        : null;
    }
    case "BIOME": {
      if (!isBiomePayload(payload)) {
        return reasonOf("a biome that cannot be read");
      }
      const choices = view.biomeChoices();
      return choices === null || choices.includes(payload.biome) ? null : reasonOf("a biome that was not offered");
    }
    case "CATCH_RELEASE": {
      if (!isCatchReleasePayload(payload)) {
        return reasonOf("an answer that cannot be read");
      }
      if (payload.release === null) {
        return null;
      }
      return view.ownerOf(payload.release) !== undefined && payload.release !== pokemonOfRef(key.ref)
        ? null
        : reasonOf("a release of a Pokémon that is not in the party");
    }
    case "TRADE_REQUEST":
    case "TRADE_ACCEPT":
    case "TRADE_DECLINE":
    case "TRADE_CANCEL":
      return payload === null ? null : reasonOf("an answer that should carry nothing");
    case "TRADE_PROPOSE": {
      const ownership = view.ownership();
      if (!isTradeProposePayload(payload) || ownership === undefined) {
        return reasonOf("a trade that cannot be read");
      }
      const problem = checkTradeProposal(author, payload, ownership);
      return problem === null ? null : reasonOf(`a trade that breaks the rules (${problem})`);
    }
    case "TRADE_DONE":
      return isTradeDonePayload(payload) ? null : reasonOf("an answer that cannot be read");
    case "PARTY_EDIT":
      return checkPartyEdit(payload, author, view.partyMembers());
    case "ME_CHOICE":
      return checkMeChoice(payload, view.meQuestion());
    case "RETRY":
      // the game over phase is what asks it: a retry or an end is legal whenever it is asked (D4a)
      return isRetryPayload(payload) ? null : reasonOf("an answer that cannot be read");
    default:
      return reasonOf("a decision of a kind that does not exist");
  }
}

/**
 * {@linkcode checkDecisionLegal} for the sequencer: it never throws. A check that fails for its own reasons (the state could not
 * be read) lets the decision through, because the legality layer must not be what breaks a run; the shape guards of every
 * kind run first and do not throw.
 * @returns The reason, or `null`
 */
export function safeLegality(view: () => LegalityView, onError: (error: unknown) => void) {
  return (key: DecisionKey, payload: unknown, author: Seat): string | null => {
    try {
      return checkDecisionLegal(view(), key, payload, author);
    } catch (error) {
      onError(error);
      return null;
    }
  };
}
