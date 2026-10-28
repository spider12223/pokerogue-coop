/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { listenForAgain } from "#coop/again-answer";
import { attachCheckpointExchange } from "#coop/checkpoint-exchange";
import { controllerOf, deciderOf, ownerOf, switchTargets } from "#coop/control";
import type { CosmeticMessage } from "#coop/cosmetic";
import { startCosmeticView, stopCosmeticView } from "#coop/cosmetic-view";
import { EpochTransport } from "#coop/epoch";
import { CoopLink } from "#coop/link";
import {
  type CheckpointMessage,
  type DecisionKey,
  keyId,
  type LobbyMessage,
  otherSeat,
  type Seat,
} from "#coop/protocol";
import type { ResyncMessage, ResyncPayload, ResyncReason, ResyncRequestPayload } from "#coop/resync";
import { installResync } from "#coop/resync-run";
import type { RetryPayload } from "#coop/retry";
import { kindOfAction, type RewardAction, rewardKey } from "#coop/reward-actions";
import { Sequencer } from "#coop/sequencer";
import { type CoopSession, requireCoopSession, rewardPickerOf } from "#coop/session";
import type { AfkTimers } from "#coop/takeover";
import { createLoopbackPair } from "#coop/transport/loopback";
import { ReliableTransport } from "#coop/transport/reliable";
import { commandToWire, type SideActionPayload, type TurnCommandsPayload } from "#coop/turn-commands";
import { validateProposal } from "#coop/validate";
import { BattlerIndex } from "#enums/battler-index";
import { Button } from "#enums/buttons";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { MoveUseMode } from "#enums/move-use-mode";
import type { PlayerGender } from "#enums/player-gender";
import { PokeballType } from "#enums/pokeball";
import type { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { PlayerPokemon } from "#field/pokemon";
import type { ModifierTypeOption } from "#modifiers/modifier-type";
import { getMoveTargets } from "#moves/move-utils";
import { GameOverPhase } from "#phases/game-over-phase";
import type { GameManager } from "#test/framework/game-manager";
import {
  accountWith,
  advanceTo,
  type ClientConfig,
  type CoopRun,
  Decider,
  openCoopRun,
  openUi,
  queueTurnCommands,
  type Scenario,
  type SharedRun,
} from "#test/helpers/coop-harness";
import type { ConfirmUiHandler } from "#ui/confirm-ui-handler";
import type { OptionSelectUiHandler } from "#ui/option-select-ui-handler";
import type Phaser from "phaser";
import { vi } from "vitest";

/**
 * Tests of a linked run (DECISIONS D2, D7, D8, D10): one real game client whose decisions go through the sequencer,
 * and a scripted partner on the other end of an in-process link. The partner is the other seat's sequencer; it answers
 * what the real client's simulation is waiting for, or whatever a test makes it propose, and it does so at the moment
 * the test says.
 */

export const LINKED_ACCOUNT = accountWith({ trainerId: 111, secretId: 222 });

const LINKED_SHARED: SharedRun = {
  runSeed: "co-op-m4-linked",
  snapshot: { host: LINKED_ACCOUNT, guest: LINKED_ACCOUNT },
  hostPlayerGender: 1 as PlayerGender,
};

/** What the scripted partner answers. Anything left out is not answered by itself: the test proposes it. */
export interface PartnerPolicy {
  /** The partner's Pokémon uses the first of its moves on the first enemy still up, unless this says otherwise */
  commands?(pokemon: PlayerPokemon, slot: number): TurnCommandsPayload;
  /** The partner's answer to a Ball or Run of the real client's player. Default: accept. */
  sideAction?(proposer: PlayerPokemon): SideActionPayload;
  /** Which move slot a Pokémon of the partner forgets for a new move; `null`: it does not learn it. Default: slot 2. */
  learnMove?(pokemon: PlayerPokemon): number | null;
  /** The partner's answer to a catch that does not fit its seat: the id of the Pokémon it releases, or `null` to decline */
  catchRelease?(partnerPokemon: PlayerPokemon[]): number | null;
  /** Which kinds the partner answers by itself. Default: none. */
  auto?: readonly DecisionKey["kind"][];
  /**
   * The partner's answer to a decision of a kind in {@linkcode auto} that has no answer of its own above (the biome, the
   * reward screen), or the host's answer after a wipe (`RETRY`, answered always; default: end the run); `undefined`: not now
   */
  other?(key: DecisionKey): unknown;
}

/**
 * @param enemyIndex - Which of the enemies still up is the target (the first by default)
 * @returns A plain attack, as the command phase of the partner's player would make it
 */
export function attackCommand(
  game: GameManager,
  slot: number,
  moveId: MoveId = MoveId.BITE,
  enemyIndex = 0,
): TurnCommandsPayload {
  const enemies = game.scene
    .getEnemyField()
    .filter(enemy => enemy.isActive(true))
    .map(enemy => enemy.getBattlerIndex());
  const player = game.scene.getPlayerField()[slot];
  // A move that hits several (Tail Whip, Earthquake) names all of them, as the command phase does (D24)
  const spread = getMoveTargets(player, moveId);
  const targets = spread.multiple ? spread.targets : [enemies[enemyIndex] ?? enemies[0] ?? BattlerIndex.ENEMY];
  return {
    command: commandToWire({
      command: Command.FIGHT,
      cursor: Math.max(
        0,
        player.getMoveset().findIndex(move => move.moveId === moveId),
      ),
      move: { move: moveId, targets, useMode: MoveUseMode.NORMAL },
    }),
    pre: commandToWire({ command: Command.FIGHT, targets: [slot], skip: true }),
  };
}

/** The partner's side of the link: a sequencer of the other seat, and an optional auto-responder. */
export class ScriptedPartner {
  readonly sequencer: Sequencer;
  /** The partner's end of the epoch (D18): what it sends is stamped, what the real client sent from another epoch is dropped */
  readonly channel: EpochTransport;
  /** The cosmetic messages (D16) the real client sent to the partner */
  readonly cosmeticsSeen: CosmeticMessage[] = [];
  /** The pacing messages (D27, `pace` and `press`) the real client sent, apart from the cosmetic ones */
  readonly paceSeen: CosmeticMessage[] = [];
  /** The `RESYNC`s the real client's host sent, and the checkpoints and requests it received, in order (D13) */
  readonly resyncs: ResyncMessage[] = [];
  readonly checkpointsSeen: CheckpointMessage[] = [];
  readonly requestsSeen: ResyncRequestPayload[] = [];
  /** The `LOBBY` messages the real client sent (the end screen's "Play again", D35) */
  readonly lobbySeen: LobbyMessage[] = [];
  private readonly answered = new Set<string>();
  /** As the host, the partner's simulation expects what the real client's simulation does (a proposal waits for it) */
  private readonly expected = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    readonly seat: Seat,
    private readonly reliable: ReliableTransport,
    private readonly session: CoopSession,
    private readonly game: GameManager,
    public policy: PartnerPolicy = {},
  ) {
    this.channel = new EpochTransport(reliable);
    this.sequencer = new Sequencer({ role: seat, transport: this.channel });
    reliable.onMessage(message => {
      if (message.kind === "COSMETIC") {
        const payload = message.payload as CosmeticMessage;
        (payload.t === "pace" || payload.t === "press" ? this.paceSeen : this.cosmeticsSeen).push(payload);
      }
    });
    this.channel.onMessage(message => {
      if (message.kind === "RESYNC") {
        this.resyncs.push(message.payload as ResyncMessage);
      } else if (message.kind === "CHECKPOINT") {
        this.checkpointsSeen.push(message.payload as CheckpointMessage);
      } else if (message.kind === "RESYNC_REQUEST") {
        this.requestsSeen.push(message.payload as ResyncRequestPayload);
      } else if (message.kind === "LOBBY") {
        this.lobbySeen.push(message.payload as LobbyMessage);
      }
    });
    this.timer = setInterval(() => this.poll(), 5);
  }

  /**
   * Send a cosmetic message as the partner's client would, straight to the wire: a test uses this to play a partner that
   * keeps to the limits and one that floods
   */
  cosmetic(payload: unknown): void {
    this.channel.sendVolatile({ key: null, author: this.seat, kind: "COSMETIC", payload: payload as CosmeticMessage });
  }

  /** Send a `LOBBY` message as the partner's client would (the end screen's "Play again", D35) */
  sendLobby(message: LobbyMessage): void {
    this.channel.send({ key: null, author: this.seat, kind: "LOBBY", payload: message });
  }

  /** Leave the room for good, as the partner's client does when it goes back to the title (the real client hears `BYE`) */
  bye(): void {
    this.channel.send({ key: null, author: this.seat, kind: "BYE", payload: null });
  }

  /** Send a checkpoint as the partner's client would (D13): a test makes it differ from the real client's to cause a resync */
  sendCheckpoint(checkpoint: CheckpointMessage): void {
    this.channel.send({ key: null, author: this.seat, kind: "CHECKPOINT", payload: checkpoint });
  }

  /** As the guest: ask the host for a reload (D13) */
  sendResyncRequest(request: ResyncRequestPayload): void {
    this.channel.send({ key: null, author: this.seat, kind: "RESYNC_REQUEST", payload: request });
  }

  /** The partner's client applies a reload (D13, D18): the same epoch and the same `seq` as the real client's */
  beginEpoch(epoch: number, nextSeq: number): void {
    this.sequencer.resetForEpoch(nextSeq);
    this.channel.setEpoch(epoch);
    this.expected.clear();
    this.answered.clear();
  }

  /** Propose as the partner with the takeover flag (D17) */
  takeOver(key: DecisionKey, payload: unknown): void {
    this.answered.add(keyId(key));
    this.sequencer.propose(key, payload, { takeover: true });
  }

  /** Make a decision of the partner's player now. Before the real client opens the window it is parked. */
  propose(key: DecisionKey, payload: unknown): void {
    this.answered.add(keyId(key));
    this.sequencer.propose(key, payload);
  }

  /** Every key of the decision window the partner has answered so far */
  get answeredKeys(): readonly string[] {
    return [...this.answered];
  }

  close(): void {
    clearInterval(this.timer);
    this.sequencer.close();
  }

  /**
   * As the host: sequence a reload of the wave start and apply it on this side, as `issueResync` does in the game (D13)
   * @param save - The wave-start save it carries (the real client's own is the same state)
   * @returns The `RESYNC` that was sent
   */
  resync(reason: ResyncReason, wave: number, save: string): ResyncPayload {
    if (this.seat !== "host") {
      throw new Error("only the host sequences a RESYNC");
    }
    const message: ResyncPayload = {
      epoch: this.channel.epoch + 1,
      seq: this.sequencer.reserveSeq(),
      wave,
      reason,
      save,
    };
    this.channel.sendAt(message.epoch, {
      key: null,
      seq: message.seq,
      author: "host",
      kind: "RESYNC",
      payload: message,
    });
    this.beginEpoch(message.epoch, message.seq + 1);
    return message;
  }

  private poll(): void {
    // One of the two has applied a reload and the other not yet: the real client's window is of the other world (D18)
    if (this.session.link !== null && this.session.link.epoch !== this.channel.epoch) {
      return;
    }
    // The host's answer after a wipe (D4a) is given whether or not the policy lists it: a scenario that ends in a game over
    // ends the run unless it says otherwise
    const auto = [...(this.policy.auto ?? []), "RETRY"];
    for (const key of this.session.openWindow) {
      const id = keyId(key);
      if (this.seat === "host" && !this.expected.has(id)) {
        // the host sequences what the guest proposes once its simulation is at the decision too
        this.expected.add(id);
        this.sequencer.awaitDecision(key).catch(() => undefined);
      }
      if (this.answered.has(id) || !auto.includes(key.kind)) {
        continue;
      }
      let payload: unknown;
      try {
        payload = this.answer(key);
      } catch {
        continue; // the simulation is not at a state the partner can read yet
      }
      if (payload !== undefined) {
        this.propose(key, payload);
      }
    }
  }

  private pokemonOf(ref: DecisionKey["ref"]): PlayerPokemon | undefined {
    const id = Number(String(ref).split(":")[0]);
    return this.game.scene.getPlayerParty().find(pokemon => pokemon.id === id);
  }

  private answer(key: DecisionKey): unknown {
    const pokemon = this.pokemonOf(key.ref);
    switch (key.kind) {
      case "TURN_COMMANDS": {
        if (pokemon === undefined || ownerOf(pokemon) !== this.seat) {
          return undefined;
        }
        const slot = this.game.scene.getPlayerField().indexOf(pokemon);
        return this.policy.commands?.(pokemon, slot) ?? attackCommand(this.game, slot);
      }
      case "SIDE_ACTION": {
        if (pokemon === undefined || ownerOf(pokemon) === this.seat) {
          return undefined;
        }
        return this.policy.sideAction?.(pokemon) ?? { accept: true };
      }
      case "SIDE_PICK": {
        // both chose a Ball or a Run: the host picks (D8); by default the first that may be picked
        const picks = this.session.sidePick;
        if (this.seat !== "host" || picks === null) {
          return undefined;
        }
        return this.policy.other?.(key) ?? { pokemonId: picks[0] };
      }
      case "RETRY":
        // the party is wiped: the host retries the wave or ends the run (D4a); by default it ends it
        if (this.seat !== "host") {
          return undefined;
        }
        return this.policy.other?.(key) ?? { retry: false };
      case "FAINT_SWITCH":
      case "PIVOT_SWITCH": {
        if (pokemon === undefined) {
          return undefined;
        }
        const fieldIndex = this.game.scene.getPlayerParty().indexOf(pokemon);
        const decider =
          key.kind === "FAINT_SWITCH"
            ? deciderOf({ kind: "FAINT_SWITCH", fieldIndex })
            : deciderOf({ kind: "PIVOT_SWITCH", fieldIndex });
        if (decider !== this.seat) {
          return undefined;
        }
        const reason = key.kind === "FAINT_SWITCH" ? "faint" : "voluntary";
        const [target] = switchTargets(fieldIndex, reason);
        return { partyIndex: this.game.scene.getPlayerParty().indexOf(target), baton: false };
      }
      case "LEARN_MOVE": {
        if (pokemon === undefined || ownerOf(pokemon) !== this.seat) {
          return undefined;
        }
        const replaceIndex = this.policy.learnMove ? this.policy.learnMove(pokemon) : 2;
        return { replaceIndex };
      }
      case "EVOLUTION_CANCEL":
        if (pokemon === undefined || ownerOf(pokemon) !== this.seat) {
          return undefined;
        }
        return String(key.ref).endsWith(":pause") ? { pause: false } : { cancel: false };
      case "CATCH_RELEASE": {
        // only the thrower answers (D10)
        const phase = this.game.scene.phaseManager.getCurrentPhase();
        if (phase.is("AttemptCapturePhase") && phase.getThrowerSeat() !== this.seat) {
          return undefined;
        }
        const mine = this.game.scene.getPlayerParty().filter(member => ownerOf(member) === this.seat);
        return { release: this.policy.catchRelease ? this.policy.catchRelease(mine) : (mine.at(-1)?.id ?? null) };
      }
      default:
        return this.policy.other?.(key);
    }
  }
}

export interface LinkedRun extends CoopRun {
  link: CoopLink;
  partner: ScriptedPartner;
  session: CoopSession;
}

export interface LinkedScenario {
  /** The seat of the real client; the partner plays the other */
  seat: Seat;
  species: SpeciesId[];
  starterOwners: Seat[];
  moveset?: Scenario["moveset"];
  /** Pokémon that faint on purpose (they use the faint move in that turn) */
  faints?: Scenario["faints"];
  policy?: PartnerPolicy;
  configure?: Scenario["configure"];
  /** The display names of the two players (D1); default: both "Player" */
  names?: { mine: string; theirs: string };
  /** When a waiting player is told the partner is slow, and may take over (D17); default: the real 30 s and 90 s */
  afkTimers?: AfkTimers;
  /** More of the scenario of the real client's harness (STE: smart moves, a hook at the start) */
  scenario?: Partial<Scenario>;
  /**
   * What the real client's player answers when the host is asked to retry the wave after a wipe (D4a): `false` ends the run,
   * `true` retries, `"menu"` shows the real menu for the test to answer. Default: `false`, the run ends.
   */
  retry?: boolean | "menu";
}

/**
 * Open a co-op run for one real client whose session has a network: the other end of the link is a
 * {@linkcode ScriptedPartner}. The client waits at its first `EncounterPhase`.
 */
export async function openLinkedRun(phaserGame: Phaser.Game, scenario: LinkedScenario): Promise<LinkedRun> {
  const client: ClientConfig = {
    seat: scenario.seat,
    liveAccount: LINKED_ACCOUNT,
    localSettings: {},
    applyOverlay: true,
    bypassSnapshot: false,
    stallMs: 8_000,
  };
  const run = await openCoopRun(phaserGame, LINKED_SHARED, client, Decider.recording(), {
    species: scenario.species,
    waves: 0,
    // Bite is Dark: nothing is immune to it
    moveset: scenario.moveset ?? [MoveId.BITE, MoveId.MEMENTO, MoveId.SAND_ATTACK, MoveId.TAIL_WHIP],
    faints: scenario.faints ?? [],
    faintMove: MoveId.MEMENTO,
    starterOwners: scenario.starterOwners,
    ...(scenario.configure === undefined ? {} : { configure: scenario.configure }),
    ...scenario.scenario,
  });
  const session = requireCoopSession();
  const [near, far] = createLoopbackPair();
  const reliable = { rtoMs: 40, tickMs: 5 };
  const link = new CoopLink({
    seat: scenario.seat,
    reliable: new ReliableTransport(near, reliable),
    // The host checks what the guest proposes (D9, D10), as it does in the game
    sequencer: { validatePayload: validateProposal },
    ...(scenario.names === undefined ? {} : { names: scenario.names }),
  });
  session.link = link;
  if (scenario.afkTimers !== undefined) {
    session.afkTimers = scenario.afkTimers;
  }
  attachCheckpointExchange(session, link);
  // The partner's answer on the end screen of the run (D35), as the lobby listens for it in the game
  listenForAgain(link);
  // The resync of the session (D13): a checkpoint that differs, the host's `RESYNC`, and the decision gate (D20)
  const stopResync = installResync(session, link);
  const partner = new ScriptedPartner(
    otherSeat(scenario.seat),
    new ReliableTransport(far, reliable),
    session,
    run.ctx.game,
    scenario.policy,
  );
  // What the partner's cosmetic messages show, as the lobby starts it in the game (D16)
  startCosmeticView(link, otherSeat(scenario.seat));
  // The retry menu after a wipe (D4a): answered at once unless the test wants the real one
  const retry = scenario.retry ?? false;
  const retryMenu =
    retry === "menu"
      ? null
      : vi
          .spyOn(GameOverPhase.prototype as unknown as { askCoopRetry(): Promise<RetryPayload> }, "askCoopRetry")
          .mockResolvedValue({ retry });
  return {
    ...run,
    link,
    partner,
    session,
    close() {
      retryMenu?.mockRestore();
      stopResync();
      stopCosmeticView();
      partner.close();
      run.close();
    },
  };
}

/** Which seat controls each field slot right now */
export function controllers(): (Seat | null)[] {
  return [controllerOf(0), controllerOf(1)];
}

// #region The reward screen (D9)

type RewardPhase = {
  propose(action: RewardAction): void;
  onSequencedInput(rowCursor: number, cursor: number): boolean;
};

/** The reward screen that is open, with the methods the screen's own input calls */
export function rewardScreen(r: LinkedRun): RewardPhase {
  const phase = r.ctx.game.scene.phaseManager.getCurrentPhase();
  if (!phase.is("SelectModifierPhase")) {
    throw new Error(`the current phase is ${phase.phaseName}, not a reward screen`);
  }
  return phase as unknown as RewardPhase;
}

/** Which reward screen of the run is open, and who picks on it */
export function openScreen(): { screen: number; picker: Seat; step: number } {
  const session = requireCoopSession();
  const screen = session.rewardPickCount - 1;
  return { screen, picker: rewardPickerOf(screen), step: session.rewardStep };
}

/** Where a stalled test is: the phase, the screen, the turn and what is queued, for the message of the failure */
export function describeStall(game: GameManager): string {
  const queue = (game.promptHandler as unknown as { prompts: { phaseTarget: string; mode: number }[] }).prompts;
  return JSON.stringify({
    phase: game.scene.phaseManager.getCurrentPhase().phaseName,
    ui: UiMode[game.scene.ui.mode],
    wave: game.scene.currentBattle.waveIndex,
    turn: game.scene.currentBattle.turn,
    enemies: game.scene.getEnemyField().map(e => [e.species.name, e.hp, e.isActive(true)]),
    queue: queue.map(p => `${p.phaseTarget}/${UiMode[p.mode]}`),
  });
}

/** A long fight must not run the moves of the scenario out of PP */
export function restorePp(game: GameManager): void {
  for (const pokemon of game.scene.getPlayerParty()) {
    for (const move of pokemon.getMoveset()) {
      move.ppUsed = 0;
    }
  }
}

/**
 * Win the current wave, then open its reward screen and leave it waiting for decisions.
 * @returns Whether a reward screen is open (every tenth wave has none)
 */
export async function winWave(r: LinkedRun): Promise<boolean> {
  const { ctx } = r;
  const wave = ctx.game.scene.currentBattle.waveIndex;
  for (;;) {
    await advanceTo(ctx, ["CommandPhase"]);
    restorePp(ctx.game);
    queueTurnCommands(ctx);
    let reached: string;
    try {
      reached = await advanceTo(ctx, ["TurnInitPhase", "SelectModifierPhase"]);
    } catch (error) {
      const window = r.session.openWindow.map(keyId).join(",");
      throw new Error(
        `wave ${wave} stalled: ${describeStall(ctx.game)}; window ${window}; answered ${r.partner.answeredKeys.join(",")}; desync ${r.session.desyncMessage}`,
        { cause: error },
      );
    }
    if (reached === "SelectModifierPhase") {
      await openUi(ctx, "SelectModifierPhase");
      return true;
    }
    if (ctx.game.scene.currentBattle.waveIndex !== wave) {
      return false;
    }
  }
}

/**
 * Play turns until the run ends (the final boss has two stages and no reward screen; a wipe ends it too), and leave the
 * game over phase waiting to start.
 * @returns Whether it is a victory
 */
/**
 * The end screen of the run (D35): wait for its menu and its input delay, then choose
 * @returns The menu's labels
 */
export async function answerEndScreen(r: LinkedRun, playAgain: boolean): Promise<string[]> {
  const { scene } = r.ctx.game;
  await vi.waitUntil(
    () => scene.phaseManager.getCurrentPhase().is("PostGameOverPhase") && scene.ui.mode === UiMode.OPTION_SELECT,
    { interval: 5, timeout: 8000 },
  );
  const handler = scene.ui.getHandler() as OptionSelectUiHandler;
  const internals = handler as unknown as { blockInput: boolean; config: { options: { label: string }[] } };
  const labels = internals.config.options.map(option => option.label);
  await vi.waitUntil(() => !internals.blockInput, { interval: 10, timeout: 4000 });
  handler.setCursor(playAgain ? 0 : labels.length - 1);
  handler.processInput(Button.ACTION);
  return labels;
}

export async function playToRunEnd(r: LinkedRun, maxTurns = 8): Promise<boolean> {
  const { ctx } = r;
  for (let turn = 0; turn < maxTurns; turn++) {
    await advanceTo(ctx, ["CommandPhase"]);
    restorePp(ctx.game);
    queueTurnCommands(ctx);
    const reached = await advanceTo(ctx, ["TurnInitPhase", "GameOverPhase"]);
    if (reached === "GameOverPhase") {
      return (ctx.game.scene.phaseManager.getCurrentPhase() as unknown as { isVictory: boolean }).isVictory;
    }
  }
  throw new Error(`the run did not end in ${maxTurns} turns`);
}

/**
 * Put a reward screen with these rewards in front of the players right now (the shop is the wave's own), and leave it
 * waiting for decisions. The current phase must be one that has not started yet.
 */
export async function openRewardScreen(r: LinkedRun, rewards: ModifierTypeOption[]): Promise<void> {
  const { ctx } = r;
  ctx.game.scene.phaseManager.unshiftNew("SelectModifierPhase", 0, undefined, {
    guaranteedModifierTypeOptions: rewards,
    fillRemaining: false,
  });
  await advanceTo(ctx, ["SelectModifierPhase"]);
  await openUi(ctx, "SelectModifierPhase");
}

/** Make a decision of the reward screen as the partner: in the step that is open (or another) */
export function partnerActs(r: LinkedRun, action: RewardAction, step = requireCoopSession().rewardStep): void {
  const { screen } = openScreen();
  r.partner.propose(rewardKey(r.ctx.game.scene.currentBattle.waveIndex, kindOfAction(action), screen, step), action);
}

/** Make a decision of the reward screen as the real client's player (through the same method the screen's input calls) */
export function playerActs(r: LinkedRun, action: RewardAction): void {
  rewardScreen(r).propose(action);
}

/** The picker skips the reward: whoever it is, in the open step */
export function pickerSkips(r: LinkedRun): void {
  const { picker } = openScreen();
  if (picker === r.link.seat) {
    playerActs(r, { t: "skip" });
  } else {
    partnerActs(r, { t: "skip" });
  }
}

/** Wait until the open reward screen has consumed `steps` more decisions */
export async function untilStep(step: number): Promise<void> {
  await vi.waitUntil(() => requireCoopSession().rewardStep >= step, { interval: 5, timeout: 8000 });
}

// #endregion

// #region Catching (D10) and the turn with one enemy left

/** A Poké Ball thrown at the one enemy that is left, as the partner's command */
export function ballCommand(
  r: LinkedRun,
  slot: number,
  ball: PokeballType = PokeballType.MASTER_BALL,
): TurnCommandsPayload {
  const [enemy] = r.ctx.game.scene.getEnemyField().filter(e => e.isActive(true));
  return {
    command: commandToWire({ command: Command.BALL, cursor: ball, targets: [enemy.getBattlerIndex()] }),
    pre: commandToWire({ command: Command.FIGHT, targets: [slot], skip: true }),
  };
}

/**
 * A partner that only lowers an accuracy (so the host's bite is the one attack and the second enemy survives turn 1), and
 * throws a ball once `throwBall()` is called.
 */
export function ballThrowingPartner(getRun: () => LinkedRun, extra: Partial<PartnerPolicy> = {}) {
  let pending = false;
  const policy: PartnerPolicy = {
    auto: ["TURN_COMMANDS", "SIDE_ACTION", "CATCH_RELEASE", "LEARN_MOVE", "EVOLUTION_CANCEL"],
    commands: (_pokemon, slot) => {
      if (pending) {
        pending = false;
        return ballCommand(getRun(), slot);
      }
      return attackCommand(getRun().ctx.game, slot, MoveId.SAND_ATTACK);
    },
    ...extra,
  };
  return {
    policy,
    throwBall: () => {
      pending = true;
    },
  };
}

/** Play turn 1 so that one wild Pokémon is left: the host bites the first, the partner only lowers an accuracy */
export async function toTurnWithOneEnemy(r: LinkedRun): Promise<void> {
  const { ctx } = r;
  await advanceTo(ctx, ["CommandPhase"]);
  queueTurnCommands(ctx);
  await advanceTo(ctx, ["TurnInitPhase", "SelectModifierPhase"]);
  await advanceTo(ctx, ["CommandPhase"]);
  if (ctx.game.scene.getEnemyField().filter(enemy => enemy.isActive(true)).length !== 1) {
    throw new Error("expected one enemy to be left after turn 1");
  }
  ctx.game.scene.pokeballCounts[PokeballType.MASTER_BALL] = 5;
}

/** Answer the question "let your partner throw a ball (or run)?" on the real client's screen */
export function answerSideAction(r: LinkedRun, accept: boolean): void {
  r.ctx.game.onNextPrompt("CoopTurnSyncPhase", UiMode.CONFIRM, () => {
    const handler = r.ctx.game.scene.ui.getHandler() as ConfirmUiHandler;
    handler.setCursor(accept ? 0 : 1);
    handler.processInput(Button.ACTION);
  });
}

// #endregion
