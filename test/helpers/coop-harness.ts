/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { BattleScene } from "#app/battle-scene";
import { createCoopGameMode } from "#app/game-mode";
import { settings } from "#app/global-settings-manager";
import type { Phase } from "#app/phase";
import type { AccountSnapshot, CoopAccountSnapshot } from "#coop/account-snapshot";
import { isLinked } from "#coop/bridge";
import {
  type Checkpoint,
  type CheckpointMismatch,
  describeCheckpointMismatch,
  firstCheckpointMismatch,
} from "#coop/checkpoint-log";
import { tracePhaseStart } from "#coop/checkpoints";
import { controllerOf, deciderOf, requireOwnerOf, switchTargets } from "#coop/control";
import { catchReleaseKey } from "#coop/decision-keys";
import { describePhaseTraceDiff, diffPhaseTraces, type PhaseTraceEntry } from "#coop/phase-trace";
import { buildPinnedSettings, createSettingsOverlayPort } from "#coop/pinned-settings";
import { type DecisionKey, keysEqual, NO_REF, otherSeat, type Seat } from "#coop/protocol";
import type { ResyncPayload } from "#coop/resync";
import { endCoopSession, requireCoopSession, startCoopSession } from "#coop/session";
// biome-ignore lint/performance/noNamespaceImport: necessary in order to spy on `simAccount`
import * as simAccountModule from "#coop/sim-account";
import { applyCoopRunSeed } from "#coop/sim-rng";
import { captureStateSnapshot, type StateHashSnapshot } from "#coop/state-hash";
import {
  applyTrade,
  checkTradeProposal,
  type TradeProposePayload,
  TradeState,
  tradeDoneKey,
  tradeKey,
} from "#coop/trade";
import { BattleType } from "#enums/battle-type";
import { BattlerIndex } from "#enums/battler-index";
import { Button } from "#enums/buttons";
import { DexAttr } from "#enums/dex-attr";
import { GameModes } from "#enums/game-modes";
import { MoveCategory } from "#enums/move-category";
import { MoveId } from "#enums/move-id";
import { isIgnorePP, isVirtual } from "#enums/move-use-mode";
import type { PlayerGender } from "#enums/player-gender";
import { PokeballType } from "#enums/pokeball";
import type { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { Unlockables } from "#enums/unlockables";
import type { PlayerPokemon } from "#field/pokemon";
import {
  getPlayerShopModifierTypeOptionsForWave,
  type ModifierTypeOption,
  PokemonModifierType,
  PokemonReviveModifierType,
} from "#modifiers/modifier-type";
import { getMoveTargets } from "#moves/move-utils";
import { SelectStarterPhase } from "#phases/select-starter-phase";
import { GameManager } from "#test/framework/game-manager";
import { PromptHandler } from "#test/helpers/prompt-handler";
import type { PhaseString } from "#types/phase-types";
import type { Starter } from "#types/save-data";
import type { DisplaySettings, GeneralSettings } from "#types/settings";
import type { ModifierSelectUiHandler } from "#ui/handlers/modifier-select-ui-handler";
import type { OptionSelectUiHandler } from "#ui/handlers/option-select-ui-handler";
import type { PartyUiHandler } from "#ui/handlers/party-ui-handler";
import { SHOP_OPTIONS_ROW_LIMIT } from "#ui/modifier-select-ui-handler";
import type Phaser from "phaser";
import { type MockInstance, vi } from "vitest";

/**
 * The record/replay harness. One "client" is a fresh game scene (`GameManager`) with its own account, its
 * own local settings and a co-op session; a scenario is played on it by a driver that takes every decision from a
 * `Decider`: the policy while recording (as the host), the recorded log while replaying (as the guest). The two
 * clients then must have passed the same state-hash checkpoints.
 *
 * What a client does with a decision is plain UI driving through the test framework's prompt handler, like the
 * existing tests; the decision log is the same `DecisionKey`s the sequencer carries (D2): wave, turn
 * (`0` outside a turn), kind and a slot or `pokemon.id` as `ref`.
 */

// #region Decisions

export interface LoggedDecision {
  key: DecisionKey;
  /** Who makes the decision, by the control rules (`deciderOf`) */
  by: Seat | "either" | null;
  payload: unknown;
}

export interface TurnPayload {
  moveId: MoveId;
  target: BattlerIndex | null;
  /** The Pokémon throws this ball instead of using a move (its ally's command is skipped) */
  ball?: PokeballType;
}

/** `index` is the position in the shop of the wave (`-1`: nothing is bought); `target` the `pokemon.id` it is used on */
export interface ShopBuyPayload {
  index: number;
  target: number | null;
}

/** `cursor: null` skips the reward screen */
export interface RewardPayload {
  cursor: number | null;
}

export interface LearnMovePayload {
  /** Which move slot the new move replaces */
  replaceSlot: number;
}

export interface FaintSwitchPayload {
  partyIndex: number;
}

export interface BiomePayload {
  cursor: number;
}

/** A replay found a decision that is not the one the recording made at this point: the simulations diverged. */
export class ReplayDivergenceError extends Error {
  constructor(
    public readonly expected: DecisionKey | null,
    public readonly actual: DecisionKey,
  ) {
    super(
      `replay diverged: the log has ${expected ? JSON.stringify(expected) : "no more decisions"}, `
        + `the game asks for ${JSON.stringify(actual)}`,
    );
  }
}

/** Takes the decisions of a run: from a policy (and logs them), or from a log. */
export class Decider {
  private cursor = 0;
  private firstDivergence: ReplayDivergenceError | null = null;

  private constructor(
    private readonly log: LoggedDecision[],
    private readonly replaying: boolean,
  ) {}

  public static recording(): Decider {
    return new Decider([], false);
  }

  public static replaying(log: readonly LoggedDecision[]): Decider {
    return new Decider([...log], true);
  }

  public get decisions(): readonly LoggedDecision[] {
    return this.log;
  }

  /** While replaying: the first time the game asked for another decision than the log has */
  public get divergence(): ReplayDivergenceError | null {
    return this.firstDivergence;
  }

  /**
   * @param key - What the game asks for now
   * @param policy - The answer while recording
   * @returns The payload: the policy's, or the logged one if the log has this very key at this point
   * While replaying, a key that is not the log's next one is noted ({@linkcode divergence}) and the policy answers, so
   * that nothing throws inside a UI callback; the driver stops at the next phase boundary.
   */
  public decide<P>(key: DecisionKey, by: LoggedDecision["by"], policy: () => P): P {
    if (!this.replaying) {
      const payload = policy();
      this.log.push({ key, by, payload });
      return payload;
    }
    const next = this.log[this.cursor];
    if (next === undefined || !keysEqual(next.key, key) || next.by !== by) {
      this.firstDivergence ??= new ReplayDivergenceError(next?.key ?? null, key);
      return policy();
    }
    this.cursor++;
    return next.payload as P;
  }
}

// #endregion

// #region Scenario

export interface Scenario {
  /** At least two: slots 0 and 1 are the first two */
  species: SpeciesId[];
  /** Play waves `1..waves` */
  waves: number;
  /** The moves every party member knows (the first is the one used in turns) */
  moveset: [MoveId, MoveId, MoveId, MoveId];
  /** In these turns the Pokémon in these slots use `faintMove` and faint: their replacements are decisions */
  faints: readonly { wave: number; turn: number; slots: readonly (0 | 1)[] }[];
  /** The move that makes its user faint */
  faintMove: MoveId;
  /** Runs after a wave's reward screen (or its fixed rewards), before the next wave is set up */
  afterWave?: (ctx: Ctx, wave: number) => void;
  /** More overrides for this scenario (starting wave, a given trainer, ...), applied after the defaults */
  configure?: (game: GameManager) => void;
  /** Who owns each starter, in party order (default: three each, the host's first) */
  starterOwners?: readonly Seat[];
  /** An endless run (D39) instead of a classic one */
  endless?: boolean;
  /** The money the run starts with (the harness starts the run without the starter screen, which would set it) */
  startingMoney?: number;
  /** From this wave on, the first wild wave with two enemies gets a Master Ball thrown at the second one left (D10) */
  catchFromWave?: number;
  /**
   * Several catches (STE): catch number `k` is tried from wave `catchFromWaves[k]` on, as {@linkcode catchFromWave} does. A
   * thrower who has three already is asked (D10): the first such catch releases the thrower's last Pokémon for it, the next
   * one declines, and so on, through the real menus
   */
  catchFromWaves?: readonly number[];
  /** Runs once the party is made, before the first wave (both clients alike): a level, an item, a move of the scenario */
  atStart?: (ctx: Ctx) => void;
  /** At the reward screens of these waves the player buys the first item of the shop that needs no Pokémon */
  buyAtWaves?: readonly number[];
  /**
   * After the reward screens of these waves the players trade a Pokémon 1-for-1 (D11): one asks on the screen, one
   * proposes, the other accepts, both are done. The proposer alternates between the seats.
   */
  tradeAtWaves?: readonly number[];
  /**
   * At the start of these waves the client reloads the wave-start save, as a resync does (D13): `CoopResyncPhase` replaces the
   * phases that run, loads the save and starts the wave again. The save is the client's own, or the host's if
   * {@linkcode resyncSaves} has it.
   */
  resyncAtWaves?: readonly number[];
  /** The host's wave-start saves by wave (`ClientReport.waveSaves` of the recording): what the guest loads when it resyncs */
  resyncSaves?: Readonly<Record<number, string>>;
  /**
   * Each slot takes the move a player would (STE): of its moves that can be used and hurt, the one that does the most to an
   * enemy that is up, as the game reckons it (type chart, abilities), at that enemy. Without it, every turn is
   * `moveset[0]` at the first enemy.
   */
  smartMoves?: boolean;
  /** A wave that takes more turns than this stops the run as a stall (an enemy nothing hurts) instead of going on forever */
  maxTurnsPerWave?: number;
  /** Which move slot a Pokémon forgets for a new move; default: slot 2 and slot 3 in turn */
  learnMoveSlot?: (pokemon: PlayerPokemon) => number;
  /** Which of the biomes on offer is chosen; default: the first and the second in turn */
  biomeCursor?: (ctx: Ctx) => number;
}

export interface ClientConfig {
  seat: Seat;
  /** What this client's `gameData` holds (the live account; co-op must not read it) */
  liveAccount: AccountSnapshot;
  /** Settings this client has saved; the pinned ones are replaced by the host's through the overlay */
  localSettings: { general?: Partial<GeneralSettings>; display?: Partial<DisplaySettings> };
  /** `false`: do not apply the pinned-settings overlay (negative test) */
  applyOverlay: boolean;
  /** `true`: simulation code reads the live account instead of the snapshot (negative test) */
  bypassSnapshot: boolean;
  /** A phase that does not end within this long is a stall */
  stallMs: number;
}

export interface SharedRun {
  runSeed: string;
  /** Both accounts, as both clients hold them */
  snapshot: CoopAccountSnapshot;
  hostPlayerGender: PlayerGender;
}

export interface WaveInfo {
  wave: number;
  trainer: boolean;
  /** `TrainerType` and `TrainerVariant` of the trainer, if any */
  trainerType: number | null;
  trainerVariant: number | null;
  double: boolean;
  /** Who commands the two slots when the wave starts, and the party order (`pokemon.id`s) */
  controllers: (Seat | null)[];
  partyOrder: number[];
  /** The party members that are out on the field, and how many legal Pokémon each seat has */
  onField: number[];
  legalBySeat: Record<Seat, number>;
  /** Enemy Pokémon in the party and on the field when the wave starts */
  enemyParty: number;
  /** The species of the enemy side, in party order */
  enemySpecies: number[];
  /** Whether an enemy is a boss (segmented HP bar) */
  boss: boolean;
  enemyField: number;
  turns: number;
}

export interface ClientReport {
  checkpoints: readonly Checkpoint[];
  trace: readonly PhaseTraceEntry[];
  decisions: readonly LoggedDecision[];
  waves: WaveInfo[];
  /** How many times a Pokémon fainted and was replaced */
  replacements: number;
  /** Each replacement: which slot, who fainted, who came in, and who decided */
  replacementLog: { wave: number; fieldIndex: number; fainted: number; chosen: number; by: Seat | "either" | null }[];
  /** How many moves were learned through the prompt */
  movesLearned: number;
  /** How many times the biome was chosen (the player holds a Map) */
  biomesChosen: number;
  /** Set when a replaying client stopped because it differs from the recording */
  divergence:
    | { kind: "checkpoint"; mismatch: CheckpointMismatch }
    | { kind: "decision"; error: ReplayDivergenceError }
    | null;
  /** Set if a phase did not end in time: where the client stopped */
  stalledIn: { phaseName: string; wave: number; turn: number; uiMode: string; queuedPrompts: string[] } | null;
  /** Shiny Pokémon in the party, by `pokemon.id` */
  partyIds: number[];
  shinyIds: number[];
  /** The party when the client closed, with each member's owner */
  finalParty: { id: number; owner: Seat | null }[];
  /** Balls thrown, shop items bought, and trades made */
  catches: number;
  shopBuys: number;
  trades: number;
  /** How many times each phase started, over the whole run (the trace only keeps the last ones) */
  phaseStarts: Record<string, number>;
  /** The wave-start save of each wave this client played (D19), as it took it */
  waveSaves: Record<number, string>;
  /** What the state hash covered at each wave start, in order (a reload takes it again): to see what a hash difference is */
  waveStarts: { wave: number; snapshot: StateHashSnapshot }[];
  /** How many times the wave was reloaded (D13) */
  resyncs: number;
  /** Set when the run ended (D4a): the game over phase was reached */
  gameOver: { victory: boolean; wave: number } | null;
}

// #endregion

// #region Driving the game

/** What the test framework's `PhaseInterceptor` keeps private and this driver needs. */
interface InterceptorInternals {
  state: "idling" | "running" | "interrupted";
  target: PhaseString;
}

const NEVER_A_TARGET: PhaseString = "LoginPhase";

/** Restore the real battle RNG: `GameManager` replaces it with max rolls, which would hide every battle-RNG desync. */
function useRealBattleRng(): void {
  BattleScene.prototype.randBattleSeedInt = function (this: BattleScene, range: number, min = 0): number {
    return this.currentBattle?.randSeedInt(range, min);
  };
}

class Stall extends Error {
  constructor(public readonly phaseName: string) {
    super(`stalled in ${phaseName}`);
  }
}

export interface Ctx {
  game: GameManager;
  decider: Decider;
  scenario: Scenario;
  client: ClientConfig;
  report: ClientReport;
  /** Set by the checkpoint hook of a replaying client; the driver stops at the next phase boundary */
  checkpointMismatch: CheckpointMismatch | null;
  /** Counts the turns whose commands were queued; a prompt queued ahead of a turn goes stale when the next one starts */
  turnSerial: number;
  /** The catch of the scenario: 0 not started, 1 the first enemy was taken down, 2 the ball was thrown */
  catchStage: 0 | 1 | 2;
  /** How many catches met the cap of three, and were answered (D10) */
  capAnswers: number;
}

/** The wave from which the next catch of the scenario is tried; `null` when every catch has been thrown */
function nextCatchWave(ctx: Ctx): number | null {
  const { scenario, report } = ctx;
  if (scenario.catchFromWaves !== undefined) {
    return scenario.catchFromWaves[report.catches] ?? null;
  }
  return scenario.catchFromWave !== undefined && report.catches === 0 ? scenario.catchFromWave : null;
}

/** A replaying client noticed that it differs from the recording and stops. */
class Diverged extends Error {}

function stopIfDiverged(ctx: Ctx): void {
  if (ctx.checkpointMismatch !== null) {
    ctx.report.divergence = { kind: "checkpoint", mismatch: ctx.checkpointMismatch };
    throw new Diverged("checkpoint mismatch");
  }
  if (ctx.decider.divergence !== null) {
    ctx.report.divergence = { kind: "decision", error: ctx.decider.divergence };
    throw new Diverged("decision mismatch");
  }
}

function stopWaiting(ctx: Ctx): boolean {
  return ctx.checkpointMismatch !== null || ctx.decider.divergence !== null;
}

function battle(ctx: Ctx) {
  return ctx.game.scene.currentBattle;
}

/** Start the current phase and wait for it to end (or to be interrupted by the UI at the interceptor's target). */
export async function runPhase(ctx: Ctx, phase: Phase): Promise<void> {
  const interceptor = ctx.game.phaseInterceptor as unknown as InterceptorInternals;
  interceptor.state = "running";
  tracePhaseStart(phase); // the stubbed `PhaseManager.startCurrentPhase` would have
  phase.start();
  if (interceptor.state !== "running") {
    stopIfDiverged(ctx);
    return;
  }
  try {
    await vi.waitUntil(() => interceptor.state !== "running" || stopWaiting(ctx), {
      interval: 5,
      timeout: ctx.client.stallMs,
    });
  } catch {
    stopIfDiverged(ctx);
    throw new Stall(phase.phaseName);
  }
  stopIfDiverged(ctx);
}

/**
 * Run phases until the current one is one of `targets`, and stop before it starts.
 * @returns Which of the targets it is
 */
export async function advanceTo(ctx: Ctx, targets: readonly PhaseString[]): Promise<PhaseString> {
  const interceptor = ctx.game.phaseInterceptor as unknown as InterceptorInternals;
  interceptor.target = NEVER_A_TARGET;
  for (let steps = 0; steps < 100_000; steps++) {
    stopIfDiverged(ctx);
    const phase = ctx.game.scene.phaseManager.getCurrentPhase();
    if (interceptor.state === "interrupted") {
      // The UI waits for a queued prompt (or for the inputs of the caller): wait for the phase to end
      try {
        await vi.waitUntil(() => interceptor.state !== "interrupted" || stopWaiting(ctx), {
          interval: 5,
          timeout: ctx.client.stallMs,
        });
      } catch {
        stopIfDiverged(ctx);
        throw new Stall(phase.phaseName);
      }
      continue;
    }
    const reached = targets.find(target => phase.is(target));
    if (reached !== undefined) {
      return reached;
    }
    if (phase.is("SelectBiomePhase")) {
      queueBiomeChoice(ctx);
    } else if (phase.is("SwitchPhase")) {
      queueFaintSwitch(ctx, phase);
    } else if (phase.is("LearnMovePhase")) {
      queueLearnMoveAsk(ctx, phase);
    } else if (phase.is("AttemptCapturePhase")) {
      queueCatchAnswer(ctx, phase);
    }
    ctx.report.phaseStarts[phase.phaseName] = (ctx.report.phaseStarts[phase.phaseName] ?? 0) + 1;
    await runPhase(ctx, phase);
  }
  throw new Error("advanceTo did not reach its target");
}

/** Start the current phase, which must be `target`, until it waits for input in the UI. */
export async function openUi(ctx: Ctx, target: PhaseString): Promise<void> {
  const interceptor = ctx.game.phaseInterceptor as unknown as InterceptorInternals;
  const phase = ctx.game.scene.phaseManager.getCurrentPhase();
  if (!phase.is(target)) {
    throw new Error(`expected ${target}, the current phase is ${phase.phaseName}`);
  }
  interceptor.target = target;
  await runPhase(ctx, phase);
  if (interceptor.state !== "interrupted") {
    throw new Error(`${target} did not wait for input`);
  }
}

/** Only turn commands and faint switches carry the turn (D2) */
function turnKey(ctx: Ctx, kind: "TURN_COMMANDS" | "FAINT_SWITCH", ref: number): DecisionKey {
  const b = battle(ctx);
  return { wave: b.waveIndex, turn: b.turn, kind, ref };
}

/**
 * The catch of a scenario (D10): in the first wild wave with two enemies from `catchFromWave` on, turn 1 takes down the
 * first enemy (the second one only has its accuracy lowered), and turn 2 throws a Master Ball at the one that is left.
 * Only the recording client asks: a replaying client takes what was logged.
 */
function catchPlan(ctx: Ctx, slot: number, enemiesUp: BattlerIndex[]): TurnPayload | null {
  const { scenario } = ctx;
  const b = battle(ctx);
  const from = nextCatchWave(ctx);
  if (
    from === null
    || ctx.catchStage === 2
    || b.waveIndex < from
    || b.battleType !== BattleType.WILD
    || b.waveIndex % 10 === 0
  ) {
    return null;
  }
  if (ctx.catchStage === 0 && enemiesUp.length === 2) {
    if (slot === BattlerIndex.PLAYER) {
      return { moveId: scenario.moveset[0], target: enemiesUp[0] };
    }
    ctx.catchStage = 1;
    return { moveId: MoveId.SAND_ATTACK, target: enemiesUp[1] };
  }
  if (ctx.catchStage === 1) {
    if (enemiesUp.length !== 1) {
      // The first enemy is not down: try again in a later wave
      ctx.catchStage = 0;
      return null;
    }
    ctx.catchStage = 2;
    return { moveId: scenario.moveset[0], target: enemiesUp[0], ball: PokeballType.MASTER_BALL };
  }
  return null;
}

/**
 * The move a player would take (STE, {@linkcode Scenario.smartMoves}): of the slot's moves that can be used and hurt, the one
 * that does the most to an enemy that is up (power, accuracy, and the game's own effectiveness with its abilities), at that
 * enemy; a move that hits every enemy has no target. With nothing that hurts, the first move that can be used.
 */
export function smartMove(ctx: Ctx, slot: BattlerIndex, enemiesUp: BattlerIndex[]): TurnPayload {
  const { game, scenario } = ctx;
  const pokemon = game.scene.getPlayerField()[slot];
  const field = game.scene.getField();
  let best: { score: number; payload: TurnPayload } | null = null;
  for (const move of pokemon.getMoveset()) {
    const data = move.getMove();
    if (
      data.id === scenario.faintMove
      || data.category === MoveCategory.STATUS
      || !move.isUsable(pokemon, false, true)[0]
    ) {
      continue;
    }
    // (a random target is not drawn: only the recording client asks, and a draw would move its battle stream alone)
    const { multiple } = getMoveTargets(pokemon, data.id, undefined, "all");
    for (const target of enemiesUp) {
      const enemy = field[target];
      if (enemy === undefined) {
        continue;
      }
      const accuracy = data.accuracy > 0 ? data.accuracy / 100 : 1;
      const score = enemy.getMoveEffectiveness(pokemon, data) * Math.max(data.power, 1) * accuracy;
      if (score > (best?.score ?? 0)) {
        best = { score, payload: { moveId: data.id, target: multiple ? null : target } };
      }
    }
  }
  if (best !== null) {
    return best.payload;
  }
  const usable = pokemon
    .getMoveset()
    .find(move => move.moveId !== scenario.faintMove && move.isUsable(pokemon, false, true)[0]);
  const fallback = usable?.moveId ?? scenario.moveset[0];
  return {
    moveId: fallback,
    target: getMoveTargets(pokemon, fallback, undefined, "all").multiple ? null : (enemiesUp[0] ?? null),
  };
}

/**
 * Whether the Pokémon goes on with a move it is locked into (a rampage, a charge, a recharge): its `CommandPhase` runs the
 * first usable entry of its move queue without asking (`tryExecuteQueuedMove` in `command-phase.ts`)
 */
export function runsQueuedMove(pokemon: PlayerPokemon): boolean {
  const moveset = pokemon.getMoveset();
  return pokemon
    .getMoveQueue()
    .some(
      queued =>
        queued.move === MoveId.NONE
        || isVirtual(queued.useMode)
        || (moveset.find(m => m.moveId === queued.move)?.isUsable(pokemon, isIgnorePP(queued.useMode), true)?.[0]
          ?? false),
    );
}

/** Queue the commands of both slots for this turn. */
export function queueTurnCommands(ctx: Ctx): void {
  const { game, scenario } = ctx;
  const b = battle(ctx);
  // A single-target move always asks for a target (an ally is a target too): the first and second enemy still up
  const enemiesUp = game.scene
    .getEnemyField()
    .filter(p => p.isActive(true))
    .map(p => p.getBattlerIndex());
  const fainting = scenario.faints.filter(f => f.wave === b.waveIndex && f.turn === b.turn).flatMap(f => f.slots);

  // Only the slots that have a Pokémon that can act are commanded; with a network, only this client's own (D8): the
  // other client chooses for the partner's slot, whose `CommandPhase` ends without asking. A Pokémon locked into a move
  // goes on with it, without asking either
  const slots = ([BattlerIndex.PLAYER, BattlerIndex.PLAYER_2] as const).filter(slot => {
    const controller = controllerOf(slot);
    return (
      controller !== null
      && (!isLinked() || controller === ctx.client.seat)
      && !runsQueuedMove(game.scene.getPlayerField()[slot])
    );
  });
  for (const slot of slots) {
    const payload = ctx.decider.decide<TurnPayload>(
      turnKey(ctx, "TURN_COMMANDS", slot),
      deciderOf({ kind: "TURN_COMMANDS", fieldIndex: slot }),
      () =>
        catchPlan(ctx, slot, enemiesUp)
        ?? (fainting.includes(slot) || !scenario.smartMoves
          ? {
              moveId: fainting.includes(slot) ? scenario.faintMove : scenario.moveset[0],
              target: enemiesUp[slot === BattlerIndex.PLAYER ? 0 : Math.min(1, enemiesUp.length - 1)],
            }
          : smartMove(ctx, slot, enemiesUp)),
    );
    if (payload.ball !== undefined) {
      // The ball takes the whole turn: the other slot's command phase is skipped, so it is not asked
      game.doThrowPokeball(payload.ball);
      ctx.report.catches++;
      // the next catch of the scenario, if there is one, starts over
      ctx.catchStage = 0;
      break;
    }
    game.move.select(payload.moveId, slot, payload.target ?? undefined);
    if (game.scene.currentBattle.mysteryEncounter?.skipToFightInput) {
      // The encounter opens the move menu at once (Fun and Games): the command menu `select` answers never comes
      const prompts = (game.promptHandler as unknown as { prompts: { phaseTarget: string; mode: UiMode }[] }).prompts;
      let commandMenu = prompts.length - 1;
      while (
        commandMenu >= 0
        && !(prompts[commandMenu].phaseTarget === "CommandPhase" && prompts[commandMenu].mode === UiMode.COMMAND)
      ) {
        commandMenu--;
      }
      if (commandMenu >= 0) {
        prompts.splice(commandMenu, 1);
      }
    }
  }

  ctx.turnSerial++;
}

/**
 * The replacement of a Pokémon that fainted. Queued when the phase is about to start: whether a learn-move ask or this
 * comes first in a turn depends on the order of the kills and the faints, and the prompt queue is first in, first out.
 */
function queueFaintSwitch(ctx: Ctx, phase: Phase): void {
  const { game } = ctx;
  game.onNextPrompt(
    "SwitchPhase",
    UiMode.PARTY,
    () => {
      const party = game.scene.getPlayerParty();
      const { fieldIndex } = phase as unknown as { fieldIndex: number };
      const by = deciderOf({ kind: "FAINT_SWITCH", fieldIndex });
      const { partyIndex } = ctx.decider.decide<FaintSwitchPayload>(
        turnKey(ctx, "FAINT_SWITCH", party[fieldIndex].id),
        by,
        () => ({ partyIndex: party.indexOf(switchTargets(fieldIndex, "faint")[0]) }),
      );
      ctx.report.replacementLog.push({
        wave: battle(ctx).waveIndex,
        fieldIndex,
        fainted: party[fieldIndex].id,
        chosen: party[partyIndex].id,
        by,
      });
      const handler = game.scene.ui.getHandler() as PartyUiHandler;
      handler.setCursor(partyIndex);
      handler.processInput(Button.ACTION); // select the party slot
      handler.processInput(Button.ACTION); // send out
      ctx.report.replacements++;
    },
    () => game.scene.phaseManager.getCurrentPhase() !== phase,
  );
}

/** Forget the prompts that were queued and not used (the queue is first in, first out: a leftover blocks what follows). */
function dropQueuedPrompts(ctx: Ctx): void {
  (ctx.game.promptHandler as unknown as { prompts: unknown[] }).prompts.length = 0;
}

/**
 * With a Map the biome after a wave is chosen (D10): the picker of the last reward screen decides. Queued when the biome
 * phase is about to start, after everything left over from the wave's fighting (learn-move asks that were not needed) was
 * dropped: the prompt queue is first in, first out, and a leftover at the front would block it.
 */
function queueBiomeChoice(ctx: Ctx): void {
  const { game } = ctx;
  dropQueuedPrompts(ctx);
  const serial = ctx.turnSerial;
  game.onNextPrompt(
    "SelectBiomePhase",
    UiMode.OPTION_SELECT,
    () => {
      const key: DecisionKey = { wave: battle(ctx).waveIndex, turn: 0, kind: "BIOME", ref: NO_REF };
      const { cursor } = ctx.decider.decide<BiomePayload>(key, deciderOf({ kind: "BIOME" }), () => ({
        cursor: ctx.scenario.biomeCursor?.(ctx) ?? ctx.report.biomesChosen % 2,
      }));
      ctx.report.biomesChosen++;
      const handler = game.scene.ui.getHandler() as OptionSelectUiHandler;
      // the list ignores input for a second after it opens
      (handler as unknown as { unblockInput(): void }).unblockInput();
      handler.setCursor(cursor);
      handler.processInput(Button.ACTION);
    },
    () => ctx.turnSerial !== serial,
  );
}

/**
 * A level-up with a new move to teach asks (levelMoveConfirmation is pinned on): yes, then which move to forget. Queued
 * when the phase is about to start, and dropped if it does not ask (a Pokémon with a free move slot just learns it).
 */
function queueLearnMoveAsk(ctx: Ctx, phase: Phase): void {
  const { game } = ctx;
  let replaceSlot = 0;
  const gone = (): boolean => game.scene.phaseManager.getCurrentPhase() !== phase;
  game.onNextPrompt(
    "LearnMovePhase",
    UiMode.CONFIRM,
    () => {
      const learn = phase as unknown as { getPlayerPokemon(): { id: number }; moveId: MoveId };
      const pokemonId = learn.getPlayerPokemon().id;
      // A prompt decision: `turn = 0` and a ref that is unique within the wave (D2)
      const key: DecisionKey = {
        wave: battle(ctx).waveIndex,
        turn: 0,
        kind: "LEARN_MOVE",
        ref: `${pokemonId}:${learn.moveId}`,
      };
      replaceSlot = ctx.decider.decide<LearnMovePayload>(key, deciderOf({ kind: "LEARN_MOVE", pokemonId }), () => ({
        replaceSlot:
          ctx.scenario.learnMoveSlot?.(learn.getPlayerPokemon() as PlayerPokemon) ?? 2 + (ctx.report.movesLearned % 2),
      })).replaceSlot;
      game.scene.ui.processInput(Button.ACTION);
    },
    gone,
  );
  game.onNextPrompt(
    "LearnMovePhase",
    UiMode.SUMMARY,
    () => {
      game.scene.ui.setCursor(replaceSlot);
      game.scene.ui.processInput(Button.ACTION);
      ctx.report.movesLearned++;
    },
    gone,
  );
}

/**
 * A catch by a player who has three of their own (D10): "The party is full", then the thrower's choice. The scenario releases
 * the thrower's last Pokémon for it on the first such catch and declines on the next, and so on: "Yes", then the party screen
 * in release mode, the Pokémon, "Release", and the message; or "No". Queued when the phase starts, dropped if it does not ask
 * (a thrower with room just adds the catch).
 */
function queueCatchAnswer(ctx: Ctx, phase: Phase): void {
  const { game } = ctx;
  // With a network only the thrower's client asks; the other may show a menu of its own in this phase (the take over offer
  // of D17), which this answer must not take for the question
  if (isLinked() && (phase as unknown as { getThrowerSeat(): Seat | null }).getThrowerSeat() !== ctx.client.seat) {
    return;
  }
  const gone = (): boolean => game.scene.phaseManager.getCurrentPhase() !== phase;
  let releaseIndex = -1;
  game.onNextPrompt(
    "AttemptCapturePhase",
    UiMode.OPTION_SELECT,
    () => {
      const capture = phase as unknown as { getPokemon(): { id: number }; getThrowerSeat(): Seat | null };
      const thrower = capture.getThrowerSeat() ?? ctx.client.seat;
      const session = requireCoopSession();
      const party = game.scene.getPlayerParty();
      const key = catchReleaseKey(battle(ctx).waveIndex, capture.getPokemon().id);
      const { release } = ctx.decider.decide<{ release: number | null }>(key, thrower, () => ({
        release:
          ctx.capAnswers % 2 === 0
            ? (party.filter(member => session.ownership.get(member.id) === thrower).at(-1)?.id ?? null)
            : null,
      }));
      ctx.capAnswers++;
      releaseIndex = release === null ? -1 : party.findIndex(member => member.id === release);
      const handler = game.scene.ui.getHandler() as OptionSelectUiHandler;
      (handler as unknown as { unblockInput(): void }).unblockInput();
      // Summary, Pokédex, Yes, No
      handler.setCursor(releaseIndex < 0 ? 3 : 2);
      handler.processInput(Button.ACTION);
    },
    gone,
  );
  game.onNextPrompt(
    "AttemptCapturePhase",
    UiMode.PARTY,
    () => {
      const partyHandler = game.scene.ui.getHandler() as PartyUiHandler;
      partyHandler.setCursor(releaseIndex);
      partyHandler.processInput(Button.ACTION); // the Pokémon's options
      partyHandler.processInput(Button.ACTION); // Release
    },
    () => gone() || releaseIndex < 0,
  );
  // the goodbye message waits for a button
  game.onNextPrompt(
    "AttemptCapturePhase",
    UiMode.PARTY,
    () => game.scene.ui.getHandler().processInput(Button.ACTION),
    () => gone() || releaseIndex < 0,
    true,
  );
}

/** The first reward that needs no target Pokémon; `null` if there is none. */
function firstUntargetedReward(options: readonly ModifierTypeOption[]): number | null {
  const index = options.findIndex(option => !(option.type instanceof PokemonModifierType));
  return index === -1 ? null : index;
}

/**
 * Buy a Revive for the first Pokémon that has fainted, or else a Potion for the first one that is hurt, if the money pays
 * for it. Every shop item needs a target, so the shop opens the party menu, where the buyer picks it (D9). Either seat
 * may buy.
 */
async function buyFromShop(ctx: Ctx, handler: ModifierSelectUiHandler, screen: number): Promise<void> {
  const { game } = ctx;
  const wave = battle(ctx).waveIndex;
  const shop = getPlayerShopModifierTypeOptionsForWave(wave, game.scene.getWaveMoneyAmount(1));
  const key: DecisionKey = { wave, turn: 0, kind: "SHOP_BUY", ref: `${screen}:0` };
  const { index, target } = ctx.decider.decide<ShopBuyPayload>(key, deciderOf({ kind: "SHOP_BUY" }), () => {
    const party = game.scene.getPlayerParty();
    const fainted = party.find(p => p.hp === 0);
    const hurt = party.find(p => p.hp > 0 && p.hp < p.getMaxHp());
    // the shop's first item is the Potion
    const wanted = fainted ? shop.findIndex(item => item.type instanceof PokemonReviveModifierType) : 0;
    const patient = fainted ?? hurt;
    if (patient === undefined || wanted < 0 || shop[wanted].cost > game.scene.money) {
      return { index: -1, target: null };
    }
    return { index: wanted, target: patient.id };
  });
  const slot = game.scene.getPlayerParty().findIndex(p => p.id === target);
  if (index < 0 || slot < 0) {
    return;
  }
  // The shop has one row, or two with the first `SHOP_OPTIONS_ROW_LIMIT` items in the upper one (row 3)
  const twoRows = shop.length > SHOP_OPTIONS_ROW_LIMIT;
  handler.setRowCursor(twoRows && index < SHOP_OPTIONS_ROW_LIMIT ? 3 : 2);
  handler.setCursor(twoRows && index >= SHOP_OPTIONS_ROW_LIMIT ? index - SHOP_OPTIONS_ROW_LIMIT : index);
  const money = game.scene.money;
  const modifierHandler = handler as unknown as { awaitingActionInput: boolean };
  handler.processInput(Button.ACTION);
  try {
    await vi.waitUntil(() => game.scene.ui.mode === UiMode.PARTY, { interval: 5, timeout: ctx.client.stallMs });
    const partyHandler = game.scene.ui.getHandler() as PartyUiHandler;
    partyHandler.setCursor(slot);
    partyHandler.processInput(Button.ACTION); // the options of the Pokémon
    partyHandler.processInput(Button.ACTION); // APPLY
    await vi.waitUntil(() => game.scene.money < money && modifierHandler.awaitingActionInput, {
      interval: 5,
      timeout: ctx.client.stallMs,
    });
  } catch {
    throw new Stall("SelectModifierPhase");
  }
  ctx.report.shopBuys++;
}

async function pickReward(ctx: Ctx): Promise<void> {
  const { game } = ctx;
  await openUi(ctx, "SelectModifierPhase");
  const phase = game.scene.phaseManager.getCurrentPhase() as unknown as { typeOptions: ModifierTypeOption[] };
  // The screen's index: the counter was advanced when the screen started (D9)
  const screen = requireCoopSession().rewardPickCount - 1;
  const key: DecisionKey = { wave: battle(ctx).waveIndex, turn: 0, kind: "REWARD_PICK", ref: `${screen}` };
  const { cursor } = ctx.decider.decide<RewardPayload>(key, deciderOf({ kind: "REWARD_PICK" }), () => ({
    cursor: firstUntargetedReward(phase.typeOptions),
  }));

  const handler = game.scene.ui.getHandler() as ModifierSelectUiHandler;
  // The screen takes input once it has finished showing
  try {
    await vi.waitUntil(() => (handler as unknown as { awaitingActionInput: boolean }).awaitingActionInput, {
      interval: 5,
      timeout: ctx.client.stallMs,
    });
  } catch {
    throw new Stall("SelectModifierPhase");
  }
  if (ctx.scenario.buyAtWaves?.includes(battle(ctx).waveIndex)) {
    await buyFromShop(ctx, handler, screen);
  }
  if (cursor === null) {
    // skip: cancel, then confirm
    dropQueuedPrompts(ctx);
    game.doSelectModifier();
    return;
  }
  handler.setRowCursor(1);
  handler.setCursor(cursor);
  handler.processInput(Button.ACTION);
}

/**
 * The trade phase of the real game (D11), scripted: it runs after what the pick queued and before the biome and the next
 * battle are set up, and every decision of it is the same one the sequencer would carry (`TradeState` and `applyTrade` are
 * what `CoopTradePhase` runs). The proposer alternates between the seats, and trades the first Pokémon each owns.
 */
async function tradeAfterReward(ctx: Ctx): Promise<void> {
  await advanceTo(ctx, ["SelectBiomePhase", "NewBattlePhase"]);
  const session = requireCoopSession();
  const wave = battle(ctx).waveIndex;
  const screen = session.rewardPickCount - 1;
  ctx.decider.decide({ wave, turn: 0, kind: "TRADE_REQUEST", ref: `${screen}:t` }, "either", () => null);
  const proposer: Seat = ctx.report.trades % 2 === 0 ? "host" : "guest";
  const answerer: Seat = otherSeat(proposer);
  const party = ctx.game.scene.getPlayerParty();
  const first = (seat: Seat): number => party.find(pokemon => requireOwnerOf(pokemon) === seat)!.id;

  const state = new TradeState();
  const apply = (key: DecisionKey, by: Seat, payload: unknown): void => {
    const decided = ctx.decider.decide(key, by, () => payload);
    const effect = state.apply({ key, author: by, payload: decided });
    if (effect.t === "accepted") {
      applyTrade(session.ownership, effect.trade.proposer, effect.trade);
      session.trades++;
      ctx.report.trades++;
    }
  };
  const proposal: TradeProposePayload = { give: first(proposer), want: first(answerer) };
  if (checkTradeProposal(proposer, proposal, session.ownership) !== null) {
    throw new Error("the scripted trade is not allowed");
  }
  apply(tradeKey(wave, "TRADE_PROPOSE", state.step), proposer, proposal);
  apply(tradeKey(wave, "TRADE_ACCEPT", state.step), answerer, null);
  apply(tradeDoneKey(wave, state.step, "host"), "host", { done: true });
  apply(tradeDoneKey(wave, state.step, "guest"), "guest", { done: true });
  if (!state.finished) {
    throw new Error("the scripted trade did not end");
  }
}

/** What the wave that is about to be fought looks like. */
export function describeWave(ctx: Ctx): WaveInfo {
  const start = battle(ctx);
  return {
    wave: start.waveIndex,
    trainer: start.battleType === BattleType.TRAINER,
    trainerType: start.trainer?.config.trainerType ?? null,
    trainerVariant: start.trainer?.variant ?? null,
    double: start.double,
    controllers: [controllerOf(0), controllerOf(1)],
    partyOrder: ctx.game.scene.getPlayerParty().map(p => p.id),
    onField: ctx.game.scene
      .getPlayerParty()
      .filter(p => p.isOnField())
      .map(p => p.id),
    legalBySeat: {
      host: ctx.game.scene.getPokemonAllowedInBattle().filter(p => requireOwnerOf(p) === "host").length,
      guest: ctx.game.scene.getPokemonAllowedInBattle().filter(p => requireOwnerOf(p) === "guest").length,
    },
    enemyParty: ctx.game.scene.getEnemyParty().length,
    enemySpecies: ctx.game.scene.getEnemyParty().map(p => p.species.speciesId),
    boss: ctx.game.scene.getEnemyParty().some(p => p.isBoss()),
    enemyField: ctx.game.scene.getEnemyField().length,
    turns: 0,
  };
}

/**
 * Reload the wave start, as a resync does (D13): the phases that run are replaced by `CoopResyncPhase`, which loads the save
 * and queues the wave again. The caller runs it with `advanceTo`.
 */
export function reloadWave(ctx: Ctx, wave: number): void {
  const session = requireCoopSession();
  const save = ctx.scenario.resyncSaves?.[wave] ?? session.waveSave?.json;
  if (save === undefined) {
    throw new Error(`there is no wave-start save of wave ${wave} to reload`);
  }
  const epoch = ctx.report.resyncs + 1;
  const message: ResyncPayload = { epoch, seq: epoch, wave, reason: "mismatch", save };
  session.resyncs.push({ epoch, reason: "mismatch", wave });
  ctx.report.resyncs++;
  const { phaseManager } = ctx.game.scene;
  phaseManager.coopRestartWith(phaseManager.create("CoopResyncPhase", message));
}

/** One wave: turns until the enemies are down, then the reward screen (if the wave has one). */
export async function playWave(ctx: Ctx): Promise<void> {
  // The scenario's moves never run out: every wave starts with full PP (both clients do the same)
  for (const pokemon of ctx.game.scene.getPlayerParty()) {
    for (const move of pokemon.getMoveset()) {
      move.ppUsed = 0;
    }
  }
  const catchFrom = nextCatchWave(ctx);
  if (catchFrom !== null && battle(ctx).waveIndex >= catchFrom) {
    // The catch needs a move that takes nothing down, whatever the level-ups have taught (both clients do the same). With
    // smart moves the second attack stays: an enemy immune to the first must still be hurt in the waves before the catch
    const [attack, faint, third, other] = ctx.scenario.moveset;
    const moves = ctx.scenario.smartMoves
      ? [attack, faint, third, MoveId.SAND_ATTACK]
      : [attack, faint, MoveId.SAND_ATTACK, other];
    for (const pokemon of ctx.game.scene.getPlayerParty()) {
      ctx.game.move.changeMoveset(pokemon, moves);
    }
  }
  const info = describeWave(ctx);
  ctx.report.waves.push(info);

  for (;;) {
    await advanceTo(ctx, ["CommandPhase"]);
    if (ctx.scenario.maxTurnsPerWave !== undefined && info.turns >= ctx.scenario.maxTurnsPerWave) {
      throw new Stall(`CommandPhase (wave ${info.wave} took ${info.turns} turns)`);
    }
    queueTurnCommands(ctx);
    info.turns++;
    const reached = await advanceTo(ctx, ["TurnInitPhase", "SelectModifierPhase", "GameOverPhase"]);
    if (reached === "GameOverPhase") {
      // The run is over, for both players (D4a): victory after the final boss, game over after a wipe
      const phase = ctx.game.scene.phaseManager.getCurrentPhase() as unknown as { isVictory: boolean };
      ctx.report.gameOver = { victory: phase.isVictory, wave: info.wave };
      return;
    }
    if (reached === "SelectModifierPhase") {
      await pickReward(ctx);
      if (ctx.scenario.tradeAtWaves?.includes(info.wave)) {
        await tradeAfterReward(ctx);
      }
      ctx.scenario.afterWave?.(ctx, info.wave);
      return;
    }
    if (battle(ctx).waveIndex !== info.wave) {
      // Every tenth wave has fixed rewards and no reward screen: the next wave (a new biome) is already set up
      return;
    }
  }
}

function makeStarters(species: readonly SpeciesId[]): Starter[] {
  // Shiny, variant, IVs and nature are left to the game, so the shiny roll is a real account-dependent input
  return species.map(
    speciesId => ({ speciesId, formIndex: 0, abilityIndex: 0, passive: false, pokerus: false }) as unknown as Starter,
  );
}

function applyLiveAccount(game: GameManager, account: AccountSnapshot): void {
  const { gameData } = game.scene;
  gameData.trainerId = account.trainerId;
  gameData.secretId = account.secretId;
  gameData.unlocks[Unlockables.EVIOLITE] = account.unlocked.eviolite;
  gameData.unlocks[Unlockables.MINI_BLACK_HOLE] = account.unlocked.miniBlackHole;
  for (const [species, caught] of Object.entries(account.caught)) {
    gameData.dexData[Number(species)].caughtAttr = BigInt(caught);
  }
  for (const [species, eggMoves] of Object.entries(account.eggMoves)) {
    gameData.starterData[Number(species)].eggMoves = eggMoves;
  }
}

// #endregion

/** A co-op client that is set up and waiting at the start of its first wave. */
export interface CoopRun {
  ctx: Ctx;
  close(): void;
}

/**
 * Set up one co-op client: scene, account, local settings, session, and the run started with the scenario's starters.
 * The client waits at its first `EncounterPhase`. Call `close()` when done.
 * @param phaserGame - The Phaser game of the test file
 * @param shared - What both clients share: the run seed and both accounts
 * @param client - This client's own account, settings and the negative-test switches
 * @param decider - Where its decisions come from
 */
export async function openCoopRun(
  phaserGame: Phaser.Game,
  shared: SharedRun,
  client: ClientConfig,
  decider: Decider,
  scenario: Scenario,
  /** A replaying client compares its checkpoints with these as it takes them and stops at the first difference */
  expected?: readonly Checkpoint[],
): Promise<CoopRun> {
  endCoopSession();
  // One test plays two clients: the previous client's prompt interval must not be running (the test hooks clear it
  // only at the end of a test)
  clearInterval(PromptHandler.runInterval);
  PromptHandler.runInterval = undefined;
  // ... and the previous client's spies (a second `PromptHandler` would wrap the first one's `setModeInternal` spy and
  // call itself); the overrides are applied again below
  vi.restoreAllMocks();
  const game = new GameManager(phaserGame);
  useRealBattleRng();

  const report: ClientReport = {
    checkpoints: [],
    trace: [],
    decisions: [],
    waves: [],
    replacements: 0,
    replacementLog: [],
    movesLearned: 0,
    biomesChosen: 0,
    finalParty: [],
    catches: 0,
    shopBuys: 0,
    trades: 0,
    phaseStarts: {},
    waveSaves: {},
    waveStarts: [],
    resyncs: 0,
    gameOver: null,
    stalledIn: null,
    divergence: null,
    partyIds: [],
    shinyIds: [],
  };
  const ctx: Ctx = {
    game,
    decider,
    scenario,
    client,
    report,
    checkpointMismatch: null,
    turnSerial: 0,
    catchStage: 0,
    capAnswers: 0,
  };

  // The same overrides on both clients: they are part of the build identity
  // No `FIELD_SIZE_OVERRIDE`: every battle is a double because the game mode says so (D6)
  game.override
    .startingLevel(5)
    .enemyLevel(3)
    .xpMultiplier(50)
    .levelCap(14)
    .enemyMoveset(MoveId.SPLASH)
    .mysteryEncounterChance(0);
  scenario.configure?.(game);

  // This client's account and local settings, as saved on this client
  applyLiveAccount(game, client.liveAccount);
  const savedDisplay: Partial<DisplaySettings> = {};
  for (const [key, value] of Object.entries(client.localSettings.display ?? {})) {
    const k = key as keyof DisplaySettings;
    (savedDisplay as Record<string, unknown>)[k] = settings.display[k];
    settings.update("display", k, value);
  }
  const savedBefore: Partial<GeneralSettings> = {};
  for (const [key, value] of Object.entries(client.localSettings.general ?? {})) {
    const k = key as keyof GeneralSettings;
    (savedBefore as Record<string, unknown>)[k] = settings.persistedGeneral[k];
    settings.update("general", k, value);
  }

  // Co-op session: the pinned settings are put over the local ones, the snapshot and the run seed are the host's
  const overlay = createSettingsOverlayPort(settings);
  if (client.applyOverlay) {
    overlay.apply(buildPinnedSettings(shared.hostPlayerGender));
  }
  const session = startCoopSession({
    seat: client.seat,
    runSeed: shared.runSeed,
    build: { protocolVersion: 1, gitSha: "harness", dirtyHash: "clean", buildMode: "test", overridesHash: "0" },
    overlay: client.applyOverlay ? overlay : null,
    accountSnapshot: shared.snapshot,
    accountIds: { host: "host-account", guest: "guest-account" },
    ...(scenario.starterOwners === undefined ? {} : { starterOwners: scenario.starterOwners }),
  });

  session.onCheckpoint = checkpoint => {
    if (checkpoint.kind === "waveStart") {
      report.waveStarts.push({ wave: checkpoint.wave, snapshot: captureStateSnapshot() });
    }
  };
  if (expected !== undefined) {
    session.onCheckpoint = checkpoint => {
      if (checkpoint.kind === "waveStart") {
        report.waveStarts.push({ wave: checkpoint.wave, snapshot: captureStateSnapshot() });
      }
      const want = expected[checkpoint.index];
      ctx.checkpointMismatch ??=
        want === undefined
          ? { index: checkpoint.index, local: null, remote: checkpoint, fields: ["length"] }
          : firstCheckpointMismatch([want], [{ ...checkpoint, index: want.index }]);
    };
  }

  let bypass: MockInstance | null = null;
  if (client.bypassSnapshot) {
    bypass = vi.spyOn(simAccountModule, "simAccount").mockImplementation(() => simAccountModule.liveSimAccount());
  }

  const close = (): void => {
    bypass?.mockRestore();
    report.checkpoints = [...session.checkpoints.entries];
    report.trace = session.trace.dump();
    report.decisions = [...decider.decisions];
    if (client.applyOverlay) {
      overlay.remove();
    }
    endCoopSession();
    for (const [key, value] of Object.entries(savedDisplay)) {
      settings.update("display", key as keyof DisplaySettings, value);
    }
    for (const [key, value] of Object.entries(savedBefore)) {
      settings.update("general", key as keyof GeneralSettings, value);
    }
  };

  try {
    await game.runToTitle();
    game.onNextPrompt("TitlePhase", UiMode.TITLE, () => {
      game.scene.gameMode = createCoopGameMode(scenario.endless ? GameModes.ENDLESS : GameModes.CLASSIC);
      applyCoopRunSeed();
      const selectStarterPhase = new SelectStarterPhase();
      game.scene.phaseManager.pushNew("EncounterPhase", false);
      selectStarterPhase.initBattle(makeStarters(scenario.species));
    });
    await advanceTo(ctx, ["EncounterPhase"]);
    for (const pokemon of game.scene.getPlayerParty()) {
      game.move.changeMoveset(pokemon, scenario.moveset);
    }
    if (scenario.startingMoney !== undefined) {
      game.scene.money = scenario.startingMoney;
    }
    if (scenario.catchFromWave !== undefined || scenario.catchFromWaves !== undefined) {
      game.scene.pokeballCounts[PokeballType.MASTER_BALL] = 5 + (scenario.catchFromWaves?.length ?? 0);
    }
    scenario.atStart?.(ctx);
    report.partyIds = game.scene.getPlayerParty().map(p => p.id);
    report.shinyIds = game.scene
      .getPlayerParty()
      .filter(p => p.shiny)
      .map(p => p.id);
  } catch (error) {
    close();
    throw error;
  }
  return { ctx, close };
}

/**
 * Play a scenario as one co-op client: {@linkcode openCoopRun}, `scenario.waves` waves, close.
 * Takes the same parameters as {@linkcode openCoopRun}.
 */
export async function playClient(
  phaserGame: Phaser.Game,
  shared: SharedRun,
  client: ClientConfig,
  decider: Decider,
  scenario: Scenario,
  expected?: readonly Checkpoint[],
): Promise<ClientReport> {
  const run = await openCoopRun(phaserGame, shared, client, decider, scenario, expected);
  const { ctx } = run;
  try {
    for (let wave = 1; wave <= scenario.waves; wave++) {
      await advanceTo(ctx, ["CommandPhase"]);
      const saved = ctx.report.waveSaves;
      const waveSave = requireCoopSession().waveSave;
      if (waveSave?.wave === wave) {
        saved[wave] = waveSave.json;
      }
      if (scenario.resyncAtWaves?.includes(wave)) {
        reloadWave(ctx, wave);
        await advanceTo(ctx, ["CommandPhase"]);
      }
      await playWave(ctx);
      if (ctx.report.gameOver !== null) {
        break;
      }
    }
  } catch (error) {
    if (error instanceof Stall) {
      ctx.report.stalledIn = {
        phaseName: error.phaseName,
        wave: ctx.game.scene.currentBattle?.waveIndex ?? 0,
        turn: ctx.game.scene.currentBattle?.turn ?? 0,
        uiMode: UiMode[ctx.game.scene.ui.mode] ?? String(ctx.game.scene.ui.mode),
        queuedPrompts: (
          ctx.game.promptHandler as unknown as { prompts: { phaseTarget: string; mode: UiMode }[] }
        ).prompts.map(prompt => `${prompt.phaseTarget}/${UiMode[prompt.mode]}`),
      };
    } else if (!(error instanceof Diverged)) {
      throw error;
    }
  } finally {
    ctx.report.finalParty = ctx.game.scene.getPlayerParty().map(p => ({
      id: p.id,
      owner: requireCoopSession().ownership.get(p.id) ?? null,
    }));
    run.close();
  }
  return ctx.report;
}

/**
 * Check that a replaying client passed the same checkpoints as the recording one.
 * @throws An error that names the first checkpoint that differs and the phase that took it; if the replay stalled it
 * says in which phase, and the phase trace diff names the first phase after which the RNG state differs
 */
export function expectSameCheckpoints(recorded: ClientReport, replayed: ClientReport): void {
  const mismatch = firstCheckpointMismatch(recorded.checkpoints, replayed.checkpoints);
  if (mismatch === null) {
    return;
  }
  const lines = [describeCheckpointMismatch(mismatch)];
  const expectedPhase = (mismatch.local ?? mismatch.remote)?.phaseName ?? "?";
  lines.push(`first differing checkpoint was taken in ${expectedPhase}`);
  if (replayed.stalledIn !== null) {
    lines.push(
      `the replay stalled in ${replayed.stalledIn.phaseName} (wave ${replayed.stalledIn.wave}, turn ${replayed.stalledIn.turn})`,
    );
  }
  const traceDiff = diffPhaseTraces(recorded.trace, replayed.trace);
  if (traceDiff !== null) {
    lines.push(describePhaseTraceDiff(traceDiff));
  }
  throw new Error(`co-op clients diverged: ${lines.join("\n")}`);
}

/** A fully-caught dex and egg moves, to make accounts different where the simulation might read them. */
export function accountWith(overrides: Partial<AccountSnapshot>): AccountSnapshot {
  return {
    trainerId: 1,
    secretId: 2,
    unlocked: { eviolite: false, miniBlackHole: false },
    caught: {},
    eggMoves: {},
    ...overrides,
  };
}

export const NON_SHINY_CAUGHT = DexAttr.NON_SHINY.toString();
