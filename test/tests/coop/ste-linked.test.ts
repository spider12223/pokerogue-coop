/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { controllerOf, deciderOf, ownerOf } from "#coop/control";
import { type CheckpointMessage, type DecisionKey, keyId, otherSeat, type Seat } from "#coop/protocol";
import type { RewardAction } from "#coop/reward-actions";
import type { Decision } from "#coop/sequencer";
import { commandTargetPick } from "#coop/sim-rng";
import { tradeDoneKey, tradeKey, tradeRequestKey } from "#coop/trade";
import { commandToWire, type TurnCommandsPayload } from "#coop/turn-commands";
import { modifierTypes } from "#data/data-lists";
import { getLevelTotalExp } from "#data/exp";
import { BattleType } from "#enums/battle-type";
import type { BattlerIndex } from "#enums/battler-index";
import { BiomeId } from "#enums/biome-id";
import { Button } from "#enums/buttons";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { MoveUseMode } from "#enums/move-use-mode";
import { PokeballType } from "#enums/pokeball";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { PlayerPokemon } from "#field/pokemon";
import { PokemonHeldItemModifier } from "#modifiers/modifier";
import {
  getPlayerShopModifierTypeOptionsForWave,
  type ModifierTypeOption,
  PokemonModifierType,
  PokemonReviveModifierType,
} from "#modifiers/modifier-type";
import { getMoveTargets } from "#moves/move-utils";
import { SelectBiomePhase } from "#phases/select-biome-phase";
import * as ribbonMethods from "#system/ribbon-methods";
import { advanceTo, type Ctx, openUi, runsQueuedMove, smartMove } from "#test/helpers/coop-harness";
import {
  ballCommand,
  describeStall,
  type LinkedRun,
  openLinkedRun,
  openScreen,
  partnerActs,
  playerActs,
  untilStep,
} from "#test/helpers/coop-linked";
import type { ConfirmUiHandler } from "#ui/confirm-ui-handler";
import type { TradeScreenActions } from "#ui/coop-trade-ui-handler";
import { getModifierType } from "#utils/modifier-utils";
import Phaser from "phaser";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * START-TO-ETERNATUS, networked: the run from the first wave to Eternatus with every decision through the sequencer. One
 * real game client plays one seat, a scripted partner on the other end of the link plays the other the way a player would.
 *
 * - STE-linked: the real client is the host. Each of the twenty decision kinds comes from each seat where the rules let both
 *   decide, in the order the run brings them, and the victory counts a co-op clear and writes the run history.
 * - STE-twin: the same run again, with the real client as the guest, and the two runs must pass the same state-hash
 *   checkpoints. Every decision follows the same rule whichever seat makes it, so the two runs differ only in which client's
 *   code ran each seat: the owner's paths (a command phase, a menu, a takeover) run for the host's Pokémon in one run and
 *   for the guest's in the other. Anything those paths change on one client alone (a draw from the battle's RNG, a move
 *   order, an item) shows up as the first checkpoint that differs. STE-replay cannot see it (its clients run every path
 *   alike) and STE-linked alone cannot either (it has one game).
 *
 * Run with `pnpm test:ste`.
 */

/** `pnpm test:ste` (vitest's mode `ste`), or `COOP_STE=1` with any vitest command */
const STE = process.env["COOP_STE"] === "1" || import.meta.env.MODE === "ste";

/** What the run does on purpose, by wave. The rest comes from the game. */
const PLAN = {
  /** Memento on purpose: the replacement is the owner's decision (D7) */
  faints: [
    { wave: 21, seat: "guest" },
    { wave: 81, seat: "host" },
  ] as const,
  /** A Revive from the shop for the one that fainted, bought by the other seat (either may buy, D9) */
  buys: [
    { wave: 22, seat: "host" },
    { wave: 82, seat: "guest" },
  ] as const,
  /** The picker rerolls, then locks the tiers (the guest picks on odd screens, the host on even ones) */
  rerolls: [12, 13],
  locks: [14, 15],
  /** A held item moved from a Pokémon of the seat to one of the other (D9) */
  transfers: [
    { wave: 16, seat: "guest" },
    { wave: 17, seat: "host" },
  ] as const,
  /**
   * Catches (D10): from the wave, in the first wild wave with two enemies, the first is taken down and the thrower's ball
   * goes to the other. Each thrower has three: the first catch of each seat releases one, the second declines. The guest's
   * first ball is turned down by the host (D8).
   */
  catches: [
    { from: 31, thrower: "host" },
    { from: 51, thrower: "guest" },
    { from: 71, thrower: "host" },
    { from: 91, thrower: "guest" },
  ] as const,
  /** U-turn on a wild boss from the wave: the switch after it is its owner's decision (D7) */
  pivots: [
    { from: 30, seat: "host" },
    { from: 40, seat: "guest" },
  ] as const,
  /**
   * The host Terastallizes (D8). Only one seat: when both do, the first by `seq` keeps it, and which one is first is a
   * matter of timing that two runs need not share (`linked-run.test.ts` has that rule)
   */
  teraFrom: 45,
  /** Trades (D11): asked for on the reward screen, then the trade screen */
  trades: [
    { wave: 41, requestedBy: "host", proposer: "host", outcome: "accept" },
    { wave: 61, requestedBy: "guest", proposer: "guest", outcome: "decline, cancel" },
    { wave: 131, requestedBy: "guest", proposer: "guest", outcome: "accept" },
  ] as readonly { wave: number; requestedBy: Seat; proposer: Seat; outcome: "accept" | "decline, cancel" }[],
  /** The move slot a Pokémon forgets for a new move: decided by the state, so both seats decide alike */
  learnMoveSlot: (pokemon: PlayerPokemon): number => 2 + (pokemon.level % 2),
  /** Which of the biomes on offer is chosen after a wave: the first or the second in turn, by the wave */
  biomeIndex: (wave: number, offered: number): number => Math.min(offered - 1, Math.floor(wave / 10) % 2),
};

/** Two attacks nothing is immune to by type alone; Memento to faint on purpose; Sand Attack hurts nobody */
const MOVESET = [MoveId.WATERFALL, MoveId.MEMENTO, MoveId.FLAMETHROWER, MoveId.SAND_ATTACK] as const;

/** What each seat does in the turn being chosen */
type TurnAct = "smart" | "faint" | "attack" | "sand" | "ball" | "pivot" | "tera" | "hold";

interface TradePhaseInternals {
  actions(): TradeScreenActions;
  state: { step: number; pending: unknown; done: { host: boolean; guest: boolean }; finished: boolean };
}

interface WaveRow {
  wave: number;
  trainer: boolean;
  boss: boolean;
  eternatus: boolean;
}

interface LinkedSteResult {
  me: Seat;
  table: Record<string, number>;
  /** The real client's state-hash checkpoints, as its partner received them */
  checkpoints: CheckpointMessage[];
  /** How many phases the real client started between each two checkpoints (D27: pacing counts on them being the same) */
  segments: number[];
  /** The same stretches, by phase name */
  phaseNames: string[][];
  desync: string | null;
  history: unknown;
}

/** Every decision kind that either seat may make */
const BOTH: DecisionKey["kind"][] = [
  "TURN_COMMANDS",
  "SIDE_ACTION",
  "FAINT_SWITCH",
  "PIVOT_SWITCH",
  "REWARD_PICK",
  "SHOP_BUY",
  "REROLL",
  "REWARD_LOCK",
  "REWARD_TRANSFER",
  "LEARN_MOVE",
  "EVOLUTION_CANCEL",
  "BIOME",
  "CATCH_RELEASE",
  "TRADE_REQUEST",
  "TRADE_PROPOSE",
  "TRADE_ACCEPT",
  "TRADE_DONE",
];

/**
 * Play the run with the real client in seat `me` and a scripted partner in the other.
 * @returns What the run covered, and the real client's checkpoints
 */
async function playLinkedSte(phaserGame: Phaser.Game, me: Seat): Promise<LinkedSteResult> {
  const other = otherSeat(me);
  let run: LinkedRun | null = null;
  const getRun = (): LinkedRun => run!;
  /** The plan of the turn being chosen: the partner's commands read theirs when its slot is asked */
  const turn: {
    host: TurnAct;
    guest: TurnAct;
    target: BattlerIndex | null;
    /** The answer to the ball of this turn, whoever gives it */
    ballAccepted: boolean;
  } = { host: "smart", guest: "smart", target: null, ballAccepted: true };
  /** The biomes the Map offered at the last choice */
  let offered: number[] = [];
  const capAnswers: Record<Seat, number> = { host: 0, guest: 0 };
  let guestBallDeclined = false;

  /** The first field slot a seat controls: the plan of the turn is for it, a second one fights (D7) */
  const firstSlotOf = (seat: Seat) => ([0, 1] as const).find(slot => controllerOf(slot) === seat);

  /** A fight command as the partner's command phase makes it: the targets the move gives itself, else the one chosen */
  const fight = (pokemon: PlayerPokemon, slot: number, moveId: MoveId, target: BattlerIndex | null, tera = false) => {
    const cursor = pokemon.getMoveset().findIndex(move => move.moveId === moveId);
    const set = getMoveTargets(pokemon, moveId, undefined, commandTargetPick(pokemon, moveId));
    const targets = set.multiple || set.targets.length <= 1 || target === null ? [...set.targets] : [target];
    return {
      command: commandToWire({
        command: Command.FIGHT,
        cursor,
        move: { move: moveId, targets, useMode: MoveUseMode.NORMAL },
      }),
      pre: commandToWire(
        tera ? { command: Command.TERA, targets: [slot] } : { command: Command.FIGHT, targets: [slot], skip: true },
      ),
    } satisfies TurnCommandsPayload;
  };

  const partnerCommands = (pokemon: PlayerPokemon, slot: number): TurnCommandsPayload => {
    const r = getRun();
    // A Pokémon locked into a move goes on with it: the partner's command phase sends it without asking
    const [queued] = pokemon.getMoveQueue();
    if (queued !== undefined) {
      const cursor = pokemon.getMoveset().findIndex(move => move.moveId === queued.move);
      return {
        command: commandToWire({
          command: Command.FIGHT,
          cursor: queued.move === MoveId.NONE ? -1 : cursor,
          move: { move: queued.move, targets: [...queued.targets], useMode: queued.useMode },
          ...(queued.move === MoveId.NONE ? { targets: [slot] } : {}),
        }),
        pre: commandToWire({ command: Command.FIGHT, targets: [slot], skip: true }),
      };
    }
    const enemiesUp = enemies(r.ctx);
    const act = slot === firstSlotOf(other) ? turn[other] : "smart";
    switch (act) {
      case "faint":
        return fight(pokemon, slot, MoveId.MEMENTO, enemiesUp[0]);
      case "attack":
        return fight(pokemon, slot, MoveId.WATERFALL, enemiesUp[0]);
      case "sand":
      case "hold":
        ensureSandAttack(pokemon);
        return fight(pokemon, slot, MoveId.SAND_ATTACK, turn.target ?? enemiesUp[0]);
      case "pivot":
        return fight(pokemon, slot, MoveId.U_TURN, turn.target ?? enemiesUp[0]);
      case "ball":
        return ballCommand(r, slot);
      default: {
        if (!pokemon.getMoveset().some(move => move.isUsable(pokemon, false, true)[0])) {
          // nothing can be used: Struggle, from a slot as the command phase sends it
          const struggle = fight(pokemon, slot, MoveId.STRUGGLE, null);
          return { ...struggle, command: { ...struggle.command!, cursor: 0 } };
        }
        const best = smartMove(r.ctx, slot as BattlerIndex, enemiesUp);
        return fight(pokemon, slot, best.moveId, best.target, act === "tera");
      }
    }
  };

  run = await openLinkedRun(phaserGame, {
    seat: me,
    species: [
      SpeciesId.BULBASAUR,
      SpeciesId.SQUIRTLE,
      SpeciesId.CHARMANDER,
      SpeciesId.PIKACHU,
      SpeciesId.MACHOP,
      SpeciesId.GEODUDE,
    ],
    starterOwners: ["host", "guest", "host", "guest", "host", "guest"],
    moveset: [...MOVESET],
    names: me === "host" ? { mine: "Sam", theirs: "Alex" } : { mine: "Alex", theirs: "Sam" },
    configure: game =>
      game.override
        .startingLevel(600)
        .startingBiome(BiomeId.TOWN)
        .enemyLevel(0)
        .enemyMoveset([])
        .levelCap(0)
        .xpMultiplier(1),
    scenario: {
      smartMoves: true,
      learnMoveSlot: PLAN.learnMoveSlot,
      biomeCursor: ctx => PLAN.biomeIndex(ctx.game.scene.currentBattle.waveIndex, offered.length),
      // the first starter of each seat levels up from 12: learn-move asks and evolutions of both
      atStart: ctx => {
        const party = ctx.game.scene.getPlayerParty();
        for (const pokemon of [party[0], party[1]]) {
          pokemon.level = 12;
          pokemon.exp = getLevelTotalExp(12, pokemon.species.growthRate);
          pokemon.calculateStats();
          pokemon.hp = pokemon.getMaxHp();
        }
      },
    },
    policy: {
      auto: [
        "TURN_COMMANDS",
        "SIDE_ACTION",
        "FAINT_SWITCH",
        "PIVOT_SWITCH",
        "LEARN_MOVE",
        "EVOLUTION_CANCEL",
        "CATCH_RELEASE",
        "BIOME",
      ],
      commands: partnerCommands,
      sideAction: () => ({ accept: turn.ballAccepted }),
      learnMove: PLAN.learnMoveSlot,
      // a seat's first catch at the cap releases its last Pokémon, the second declines
      catchRelease: mine => (capAnswers[other]++ % 2 === 0 ? (mine.at(-1)?.id ?? null) : null),
      // the biome, when the partner picked last (D10)
      other: key =>
        key.kind === "BIOME" && deciderOf({ kind: "BIOME" }) === other && offered.length > 0
          ? { biome: offered[PLAN.biomeIndex(getRun().ctx.game.scene.currentBattle.waveIndex, offered.length)] }
          : undefined,
    },
  });
  const r = run;
  const { ctx, partner, session } = r;
  const { game } = ctx;
  // The phases of each stretch between two checkpoints, by name: what a failure of the STE-twin's count names (D27)
  const phaseNames: string[][] = [...session.pace.segments.map(() => []), []];
  const { pace } = session;
  const phaseStarted = pace.phaseStarted.bind(pace);
  const checkpointTaken = pace.checkpointTaken.bind(pace);
  pace.phaseStarted = name => {
    phaseNames.at(-1)!.push(name);
    phaseStarted(name);
  };
  pace.checkpointTaken = () => {
    phaseNames.push([]);
    checkpointTaken();
  };
  const decisions: Decision[] = [];
  r.link.sequencer.onDecision(decision => decisions.push(decision));

  // (after the run is open: opening it restores every spy)
  vi.spyOn(ribbonMethods, "awardRibbonsToSpeciesLine").mockImplementation(() => undefined);
  const biomeChoice = SelectBiomePhase.prototype as unknown as { chooseBiomeSequenced(b: number[]): void };
  const realChoose = biomeChoice.chooseBiomeSequenced;
  vi.spyOn(biomeChoice, "chooseBiomeSequenced").mockImplementation(function (this: SelectBiomePhase, biomes) {
    offered = [...biomes];
    return realChoose.call(this, biomes);
  });

  // A Map (biome choices), a Lock Capsule (the tier lock), a Tera Orb, Master Balls, and a held item for each seat to move
  const { scene } = game;
  scene.addModifier(getModifierType(modifierTypes.MAP).newModifier()!, true);
  scene.addModifier(getModifierType(modifierTypes.LOCK_CAPSULE).newModifier()!, true);
  scene.addModifier(getModifierType(modifierTypes.TERA_ORB).newModifier()!, true);
  scene.pokeballCounts[PokeballType.MASTER_BALL] = 20;
  /** The first starter of each seat: they level up from 12 on their own */
  const levellingStarters = scene
    .getPlayerParty()
    .slice(0, 2)
    .map(pokemon => pokemon.id);
  for (const seat of ["host", "guest"] as const) {
    scene.addModifier(getModifierType(modifierTypes.LEFTOVERS).newModifier(owned(ctx, seat)[1])!, true);
  }

  const waves: WaveRow[] = [];
  let catchIndex = 0;
  let catchStage: 0 | 1 = 0;
  let catchGaveUpIn = 0;
  let pivotIndex = 0;
  let teraDone = false;
  let waveTurns = 0;
  let victory: boolean | null = null;

  /** Make a decision of the reward screen as `seat`: through the real screen, or as the partner */
  const act = (seat: Seat, action: RewardAction): void => {
    if (seat === me) {
      playerActs(r, action);
    } else {
      partnerActs(r, action);
    }
  };

  const step = async (seat: Seat, action: RewardAction): Promise<void> => {
    const before = openScreen().step;
    act(seat, action);
    try {
      await untilStep(before + 1);
    } catch (error) {
      throw new Error(`the ${seat}'s ${action.t} did not go through: desync ${session.desyncMessage}`, {
        cause: error,
      });
    }
  };

  const advance = async (targets: Parameters<typeof advanceTo>[1]) => {
    try {
      return await advanceTo(ctx, targets);
    } catch (error) {
      throw new Error(
        `stalled: ${describeStall(game)}; window ${session.openWindow.map(keyId).join(",")}; desync ${session.desyncMessage}`,
        { cause: error },
      );
    }
  };

  // #region the turn

  function planTurn(wave: number, turnNumber: number): void {
    const enemiesUp = enemies(ctx);
    const wild = scene.currentBattle.battleType === BattleType.WILD;
    turn.host = "smart";
    turn.guest = "smart";
    turn.target = null;
    turn.ballAccepted = true;

    const faint = PLAN.faints.find(f => f.wave === wave && turnNumber === 1);
    if (faint !== undefined) {
      turn[faint.seat] = "faint";
      return;
    }
    const pivot = PLAN.pivots[pivotIndex];
    if (pivot !== undefined && wave >= pivot.from && wild && turnNumber === 1 && wave % 10 === 0) {
      const boss = scene.getEnemyField().find(enemy => enemy.isActive(true) && enemy.isBoss());
      if (boss !== undefined) {
        pivotIndex++;
        turn.target = boss.getBattlerIndex();
        turn[pivot.seat] = "pivot";
        turn[otherSeat(pivot.seat)] = "sand";
        // U-turn goes in the second move slot for the turn
        const slot = firstSlotOf(pivot.seat);
        if (slot !== undefined) {
          scene.getPlayerField()[slot].setMove(1, MoveId.U_TURN);
        }
        return;
      }
    }
    if (!teraDone && wave >= PLAN.teraFrom && turnNumber === 1 && enemiesUp.length > 0) {
      teraDone = true;
      turn.host = "tera";
      return;
    }
    const plannedCatch = PLAN.catches[catchIndex];
    if (plannedCatch !== undefined && wave >= plannedCatch.from && wild && wave % 10 !== 0 && catchGaveUpIn !== wave) {
      if (catchStage === 1 && enemiesUp.length === 2) {
        // the first one was not taken down (immune to the attack): another wave
        catchStage = 0;
        catchGaveUpIn = wave;
        return;
      }
      if (catchStage === 0 && enemiesUp.length === 2) {
        // the host takes the first down, the guest only lowers the second's accuracy
        catchStage = 1;
        turn.host = "attack";
        turn.guest = "sand";
        turn.target = enemiesUp[1];
        return;
      }
      if (catchStage === 1 && enemiesUp.length === 1) {
        turn[plannedCatch.thrower] = "ball";
        turn[otherSeat(plannedCatch.thrower)] = "hold";
        turn.target = enemiesUp[0];
        // the guest's first ball is turned down (D8); the thrower then fights, and the catch waits for another wave
        turn.ballAccepted = plannedCatch.thrower === "host" || guestBallDeclined;
        if (turn.ballAccepted) {
          catchIndex++;
          catchStage = 0;
        } else {
          guestBallDeclined = true;
        }
        return;
      }
      catchStage = 0;
    }
  }

  function actForMe(): void {
    ctx.turnSerial++;
    // A seat with nobody left to send out leaves both slots to the other (D7): the plan is for the first, the second
    // fights. With a network the second is asked even after a ball from the first.
    const slots = ([0, 1] as const).filter(s => controllerOf(s) === me);
    slots.forEach((slot, index) => chooseForMe(slot, index === 0 ? turn[me] : "smart"));
    // the prompts are answered first in, first out: the question about the partner's ball comes after this player's
    // command
    if (turn[other] === "ball") {
      answerPartnerBall();
    }
  }

  function chooseForMe(slot: 0 | 1, act: TurnAct): void {
    const pokemon = scene.getPlayerField()[slot];
    if (runsQueuedMove(pokemon)) {
      return;
    }
    const enemiesUp = enemies(ctx);
    const select = (moveId: MoveId, target: BattlerIndex | null) => game.move.select(moveId, slot, target ?? undefined);
    switch (act) {
      case "faint":
        select(MoveId.MEMENTO, enemiesUp[0]);
        return;
      case "attack":
        select(MoveId.WATERFALL, enemiesUp[0]);
        return;
      case "sand":
      case "hold":
        ensureSandAttack(pokemon);
        select(MoveId.SAND_ATTACK, turn.target ?? enemiesUp[0]);
        return;
      case "pivot":
        select(MoveId.U_TURN, turn.target);
        return;
      case "ball":
        // the thrower at the cap answers through the real menus: a release on its first catch, a decline on the next
        game.doThrowPokeball(PokeballType.MASTER_BALL);
        if (!turn.ballAccepted) {
          // the partner says no: this player chooses again, and fights
          chooseForMe(slot, "smart");
        }
        return;
      case "tera": {
        const best = smartMove(ctx, slot, enemiesUp);
        game.move.selectWithTera(best.moveId, slot, best.target ?? undefined);
        return;
      }
      default: {
        if (!pokemon.getMoveset().some(move => move.isUsable(pokemon, false, true)[0])) {
          // nothing can be used: whatever is pressed, the command phase makes it Struggle
          select(pokemon.getMoveset()[0].moveId, null);
          return;
        }
        const best = smartMove(ctx, slot, enemiesUp);
        select(best.moveId, best.target);
      }
    }
  }

  /** The partner's ball asks this player (D8), who answers as the plan says */
  function answerPartnerBall(): void {
    const accept = turn.ballAccepted;
    game.onNextPrompt("CoopTurnSyncPhase", UiMode.CONFIRM, () => {
      if (!accept) {
        // the partner chooses again, and fights
        turn[other] = "smart";
      }
      const handler = scene.ui.getHandler() as ConfirmUiHandler;
      handler.setCursor(accept ? 0 : 1);
      handler.processInput(Button.ACTION);
    });
  }

  // #endregion

  // #region the reward screen and the trade screen

  async function rewardScreen(wave: number): Promise<void> {
    await openUi(ctx, "SelectModifierPhase");
    const { picker } = openScreen();
    const buy = PLAN.buys.find(b => b.wave === wave);
    if (buy !== undefined) {
      const fainted = scene.getPlayerParty().find(pokemon => pokemon.hp === 0);
      const shop = getPlayerShopModifierTypeOptionsForWave(wave, scene.getWaveMoneyAmount(1));
      const index = shop.findIndex(option => option.type instanceof PokemonReviveModifierType);
      if (fainted !== undefined && index >= 0) {
        scene.money = Math.max(scene.money, 20_000);
        await step(buy.seat, { t: "buy", index, target: fainted.id });
      }
    }
    if (PLAN.rerolls.includes(wave)) {
      // the same screen again (a new phase of it, which starts in the next step). A player rerolls only what they can
      // pay for: an unaffordable one is illegal (D24)
      scene.money = Math.max(scene.money, 20_000);
      const before = scene.phaseManager.getCurrentPhase();
      await step(picker, { t: "reroll" });
      await vi.waitUntil(() => scene.phaseManager.getCurrentPhase() !== before, { interval: 5, timeout: 8000 });
      await openUi(ctx, "SelectModifierPhase");
    }
    if (PLAN.locks.includes(wave)) {
      await step(picker, { t: "lock" });
    }
    const transfer = PLAN.transfers.find(t => t.wave === wave);
    if (transfer !== undefined) {
      const holder = owned(ctx, transfer.seat).find(pokemon => heldItems(ctx, pokemon) > 0);
      const receiver = owned(ctx, otherSeat(transfer.seat))[0];
      if (holder !== undefined) {
        await step(transfer.seat, {
          t: "transfer",
          from: holder.id,
          to: receiver.id,
          items: [{ index: 0, quantity: 1 }],
        });
      }
    }
    const trade = PLAN.trades.find(t => t.wave === wave);
    if (trade !== undefined) {
      const { screen, step: at } = openScreen();
      if (trade.requestedBy === me) {
        // the screen's Trade button
        (
          scene.phaseManager.getCurrentPhase() as unknown as {
            onSequencedInput(row: number, cursor: number): boolean;
          }
        ).onSequencedInput(0, 4);
      } else {
        partner.propose(tradeRequestKey(wave, screen, at), null);
      }
      await untilStep(at + 1);
    }
    const options = (scene.phaseManager.getCurrentPhase() as unknown as { typeOptions: ModifierTypeOption[] })
      .typeOptions;
    const index = options.findIndex(option => !(option.type instanceof PokemonModifierType));
    act(picker, index >= 0 ? { t: "pick", index } : { t: "skip" });
  }

  async function tradeScreen(wave: number): Promise<void> {
    await openUi(ctx, "CoopTradePhase");
    const phase = scene.phaseManager.getCurrentPhase() as unknown as TradePhaseInternals;
    const trade = PLAN.trades.find(t => t.wave === wave)!;
    const answerer = otherSeat(trade.proposer);
    const proposal = () => ({ give: owned(ctx, trade.proposer)[0].id, want: owned(ctx, answerer)[0].id });
    const until = (check: () => boolean) => vi.waitUntil(check, { interval: 5, timeout: 8000 });
    const propose = async () => {
      const before = phase.state.step;
      if (trade.proposer === me) {
        const { give, want } = proposal();
        expect(phase.actions().propose(give, want)).toBe(true);
      } else {
        partner.propose(tradeKey(wave, "TRADE_PROPOSE", phase.state.step), proposal());
      }
      await until(() => phase.state.step > before && phase.state.pending !== null);
    };
    const answer = async (accept: boolean) => {
      const before = phase.state.step;
      if (answerer === me) {
        phase.actions().answer(accept);
      } else {
        partner.propose(tradeKey(wave, accept ? "TRADE_ACCEPT" : "TRADE_DECLINE", phase.state.step), null);
      }
      await until(() => phase.state.step > before);
    };

    await propose();
    if (trade.outcome === "accept") {
      await answer(true);
    } else {
      await answer(false);
      await propose();
      // the proposer takes it back
      const before = phase.state.step;
      if (trade.proposer === me) {
        phase.actions().cancel();
      } else {
        partner.propose(tradeKey(wave, "TRADE_CANCEL", phase.state.step), null);
      }
      await until(() => phase.state.step > before);
    }
    phase.actions().done(true);
    await until(() => phase.state.done[me]);
    partner.propose(tradeDoneKey(wave, phase.state.step, other), { done: true });
    await until(() => phase.state.finished);
  }

  // #endregion

  /** The commands of the turn are chosen: the rest of the turn runs (a slot asked again in it ends at once) */
  let chosen = false;
  for (let guard = 0; guard < 20_000 && victory === null; guard++) {
    const reached = await advance([
      chosen ? "TurnInitPhase" : "CommandPhase",
      "SelectModifierPhase",
      "CoopTradePhase",
      "GameOverPhase",
    ]);
    chosen = false;
    const battle = scene.currentBattle;
    const wave = battle.waveIndex;

    if (reached === "GameOverPhase") {
      victory = (scene.phaseManager.getCurrentPhase() as unknown as { isVictory: boolean }).isVictory;
      break;
    }
    if (reached === "TurnInitPhase") {
      continue;
    }

    if (reached === "CommandPhase") {
      if (waves.at(-1)?.wave !== wave) {
        // a new wave: full PP, and the second move slot back to Memento (a pivot may have put U-turn there)
        waves.push({
          wave,
          trainer: battle.battleType === BattleType.TRAINER,
          boss: scene.getEnemyParty().some(enemy => enemy.isBoss()),
          eternatus: scene.getEnemyParty().some(enemy => enemy.species.speciesId === SpeciesId.ETERNATUS),
        });
        for (const pokemon of scene.getPlayerParty()) {
          if (pokemon.getMoveset()[1]?.moveId !== MoveId.MEMENTO) {
            pokemon.setMove(1, MoveId.MEMENTO);
          }
          // a catch joins at its own level and with its own moves: the scenario brings it up to the party's level and
          // gives it the scenario's moves, so that the run can win and the plan's moves are there
          if (!levellingStarters.includes(pokemon.id) && pokemon.level < 600) {
            pokemon.level = 600;
            pokemon.exp = getLevelTotalExp(600, pokemon.species.growthRate);
            pokemon.calculateStats();
            pokemon.hp = pokemon.hp > 0 ? pokemon.getMaxHp() : 0;
            MOVESET.forEach((moveId, slot) => pokemon.setMove(slot, moveId));
          }
          for (const move of pokemon.getMoveset()) {
            move.ppUsed = 0;
          }
        }
        waveTurns = 0;
        catchStage = 0;
      }
      if (++waveTurns > 40) {
        throw new Error(`wave ${wave} took more than 40 turns: ${describeStall(game)}`);
      }
      planTurn(wave, battle.turn);
      actForMe();
      chosen = true;
      continue;
    }

    if (reached === "SelectModifierPhase") {
      await rewardScreen(wave);
      continue;
    }

    await tradeScreen(wave);
  }

  // #region the end of the run, and what it covered

  let history: unknown;
  if (victory === true) {
    await game.phaseInterceptor.to("PostGameOverPhase", false);
    await vi.waitUntil(async () => Object.keys(await scene.gameData.getRunHistoryData()).length === 1, {
      interval: 5,
      timeout: 4000,
    });
    [history] = Object.values(await scene.gameData.getRunHistoryData());
  }

  const by = (kind: DecisionKey["kind"], author?: Seat): number =>
    decisions.filter(d => d.key.kind === kind && (author === undefined || d.author === author)).length;
  const table: Record<string, number> = {
    "waves played": waves.length,
    "trainer waves": waves.filter(w => w.trainer).length,
    "boss waves": waves.filter(w => w.boss).length,
    "Eternatus at wave 200": waves.some(w => w.wave === 200 && w.eternatus) ? 1 : 0,
    victory: victory === true ? 1 : 0,
    "co-op clears counted": scene.gameData.gameStats.coopRunsWon,
    "run history entries (co-op)": (history as { coop?: unknown } | undefined)?.coop === undefined ? 0 : 1,
    "decisions sequenced": decisions.length,
    "checkpoints sent": partner.checkpointsSeen.length,
  };
  for (const kind of BOTH) {
    table[`${kind} by the host`] = by(kind, "host");
    table[`${kind} by the guest`] = by(kind, "guest");
  }
  table["TRADE_DECLINE"] = by("TRADE_DECLINE");
  table["TRADE_CANCEL"] = by("TRADE_CANCEL");
  table["releases for a catch"] = decisions.filter(
    d => d.key.kind === "CATCH_RELEASE" && (d.payload as { release: number | null }).release !== null,
  ).length;
  table["declined catches"] = by("CATCH_RELEASE") - table["releases for a catch"];
  table["Tera turns"] = decisions.filter(
    d => d.key.kind === "TURN_COMMANDS" && (d.payload as TurnCommandsPayload).pre?.command === Command.TERA,
  ).length;
  table["trades done"] = session.trades;

  const width = Math.max(...Object.keys(table).map(name => name.length));
  process.stderr.write(
    `\nSTE, the real client as the ${me}:\n${Object.entries(table)
      .map(([name, n]) => `  ${name.padEnd(width)}  ${n}`)
      .join("\n")}\n`,
  );

  const result: LinkedSteResult = {
    me,
    table,
    checkpoints: [...partner.checkpointsSeen],
    segments: [...session.pace.segments],
    phaseNames,
    desync: session.desyncMessage,
    history,
  };
  r.close();
  return result;

  // #endregion
}

/** What every networked run must have covered */
function expectCovered(result: LinkedSteResult): void {
  const { table } = result;
  expect(result.desync).toBeNull();
  expect(table["victory"], "victory").toBe(1);
  expect(table["waves played"]).toBe(200);
  expect(table["Eternatus at wave 200"]).toBe(1);
  expect(table["co-op clears counted"]).toBe(1);
  expect(result.history).toMatchObject({
    isVictory: true,
    coop: { names: { host: "Sam", guest: "Alex" }, seat: result.me },
  });
  for (const kind of BOTH) {
    expect(table[`${kind} by the host`], `${kind} by the host`).toBeGreaterThan(0);
    expect(table[`${kind} by the guest`], `${kind} by the guest`).toBeGreaterThan(0);
  }
  for (const name of ["TRADE_DECLINE", "TRADE_CANCEL", "releases for a catch", "declined catches", "Tera turns"]) {
    expect(table[name], name).toBeGreaterThan(0);
  }
  expect(table["trades done"]).toBe(2);
}

/** @returns The first checkpoint where the two runs differ, described; `null` if they pass the same ones */
function firstDifference(a: readonly CheckpointMessage[], b: readonly CheckpointMessage[]): string | null {
  const label = (c: CheckpointMessage | undefined) =>
    c === undefined ? "none" : `${c.kind} at wave ${c.wave}, turn ${c.turn} (${c.phaseName}): ${c.hash}`;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const [x, y] = [a[index], b[index]];
    if (
      x === undefined
      || y === undefined
      || x.kind !== y.kind
      || x.wave !== y.wave
      || x.turn !== y.turn
      || x.hash !== y.hash
    ) {
      return `checkpoint ${index}: the host's run has ${label(x)}; the guest's run has ${label(y)}`;
    }
  }
  return null;
}

/**
 * Pacing (D27) names a line by the phases started since the last checkpoint, so both seats must start the same number of
 * phases between each two checkpoints. The stretch before the first checkpoint is each seat's own setup and is not compared.
 * @returns The first stretch where the two runs differ, described; `null` if none does
 */
function firstSegmentDifference(host: LinkedSteResult, guest: LinkedSteResult): string | null {
  for (let index = 1; index < Math.max(host.segments.length, guest.segments.length); index++) {
    if (host.segments[index] !== guest.segments[index]) {
      const before = host.checkpoints[index];
      const where = before === undefined ? "?" : `${before.kind} at wave ${before.wave}, turn ${before.turn}`;
      const [a, b] = [host.phaseNames[index] ?? [], guest.phaseNames[index] ?? []];
      const split = a.findIndex((name, i) => name !== b[i]);
      const from = Math.max(0, (split === -1 ? Math.min(a.length, b.length) : split) - 3);
      return (
        `before checkpoint ${index} (${where}): the host's run started ${host.segments[index]} phases, the guest's `
        + `${guest.segments[index]}; from phase ${from}, the host's: ${a.slice(from, from + 8).join(", ")}; the guest's: `
        + b.slice(from, from + 8).join(", ")
      );
    }
  }
  return null;
}

describe.runIf(STE)("START-TO-ETERNATUS, networked (STE-linked, STE-twin)", () => {
  let phaserGame: Phaser.Game;
  let hostRun: LinkedSteResult | null = null;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  it("STE-linked: the host's client and a scripted guest play from the starters to Eternatus through the sequencer", async () => {
    hostRun = await playLinkedSte(phaserGame, "host");
    expectCovered(hostRun);
  }, 3_600_000);

  it("STE-twin: the guest's client and a scripted host play the same run, to the same state hashes", async () => {
    const guestRun = await playLinkedSte(phaserGame, "guest");
    expectCovered(guestRun);
    expect(hostRun, "STE-linked ran first").not.toBeNull();
    expect(guestRun.checkpoints.length).toBeGreaterThanOrEqual(200);
    expect(firstDifference(hostRun!.checkpoints, guestRun.checkpoints)).toBeNull();
    // and the same phases between them: the guest's screen follows the host's text by that count (D27)
    expect(guestRun.segments.length).toBe(hostRun!.segments.length);
    expect(firstSegmentDifference(hostRun!, guestRun)).toBeNull();
  }, 3_600_000);
});

/** The enemies still up, as battler indexes */
function enemies(ctx: Ctx): BattlerIndex[] {
  return ctx.game.scene
    .getEnemyField()
    .filter(enemy => enemy.isActive(true))
    .map(enemy => enemy.getBattlerIndex());
}

/** The Pokémon of a seat, in party order */
function owned(ctx: Ctx, seat: Seat): PlayerPokemon[] {
  return ctx.game.scene.getPlayerParty().filter(pokemon => ownerOf(pokemon) === seat);
}

/** How many held items a Pokémon has that can be moved (what a transfer's item index counts) */
function heldItems(ctx: Ctx, pokemon: PlayerPokemon): number {
  return ctx.game.scene.findModifiers(
    m => m instanceof PokemonHeldItemModifier && m.isTransferable && m.pokemonId === pokemon.id,
  ).length;
}

/** Learned moves may have taken Sand Attack's slot: the scenario puts it back where it was */
function ensureSandAttack(pokemon: PlayerPokemon): void {
  if (!pokemon.getMoveset().some(move => move.moveId === MoveId.SAND_ATTACK)) {
    pokemon.setMove(3, MoveId.SAND_ATTACK);
  }
}
