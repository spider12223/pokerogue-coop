import type { BattleScene } from "#app/battle-scene";
import { globalScene } from "#app/global-scene";
import type { CommandSource } from "#app/multiplayer/command-source";
import type { PlayerSlot } from "#app/multiplayer/input-role";
import { CoopSession } from "#app/multiplayer/network/coop-session";
import type { ChooseCommandMessage } from "#app/multiplayer/network/messages";
import { Command } from "#enums/command";
import type { MoveId } from "#enums/move-id";
import { MoveUseMode } from "#enums/move-use-mode";
import type { Pokemon } from "#field/pokemon";
import { getMoveTargets } from "#moves/move-utils";
import type { CommandPhase } from "#phases/command-phase";
import type { TurnMove } from "#types/turn-move";

export const COOP_DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

export type DefaultTargetsResolver = (pokemon: Pokemon, moveId: MoveId) => number[];
export type SceneAccessor = () => BattleScene;

export interface NetworkCommandSourceOptions {
  timeoutMs?: number;
  botFillJoiner?: boolean;
  getDefaultTargets?: DefaultTargetsResolver;
  getScene?: SceneAccessor;
}

const defaultGetDefaultTargets: DefaultTargetsResolver = (pokemon, moveId) =>
  getMoveTargets(pokemon, moveId).targets.slice(0, 1);

const defaultGetScene: SceneAccessor = () => globalScene;

interface PendingRequest {
  requestId: string;
  phase: CommandPhase;
  timer: ReturnType<typeof setTimeout> | null;
}

export class NetworkCommandSource implements CommandSource {
  public readonly kind = "network" as const;

  private pending: PendingRequest | null = null;
  private readonly timeoutMs: number;
  private readonly botFillJoiner: boolean;
  private readonly getDefaultTargets: DefaultTargetsResolver;
  private readonly getScene: SceneAccessor;

  constructor(
    public readonly playerSlot: PlayerSlot,
    private readonly session: CoopSession,
    opts: NetworkCommandSourceOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? COOP_DEFAULT_COMMAND_TIMEOUT_MS;
    this.botFillJoiner = opts.botFillJoiner ?? false;
    this.getDefaultTargets = opts.getDefaultTargets ?? defaultGetDefaultTargets;
    this.getScene = opts.getScene ?? defaultGetScene;
    this.session.on(CoopSession.CHOOSE_COMMAND_RECEIVED, (envelope: ChooseCommandMessage) => {
      this.handleChoiceResponse(envelope);
    });
  }

  requestCommand(phase: CommandPhase): void {
    if (this.botFillJoiner) {
      setTimeout(() => this.resolveDefault(phase), 0);
      return;
    }
    const requestId = crypto.randomUUID();
    this.pending = {
      requestId,
      phase,
      timer: setTimeout(() => this.handleTimeout(), this.timeoutMs),
    };
    void this.sendRequestEnvelope(requestId);
  }

  cancelPending(): void {
    if (!this.pending) {
      return;
    }
    const requestId = this.pending.requestId;
    if (this.pending.timer) {
      clearTimeout(this.pending.timer);
    }
    this.pending = null;
    void this.session.sendEnvelope({
      type: "cancel-command-request",
      requestId,
      reason: null,
    });
  }

  private async sendRequestEnvelope(requestId: string): Promise<void> {
    const scene = this.getScene();
    await this.session.broadcastSnapshot(scene);
    await this.session.sendEnvelope({
      type: "request-command",
      requestId,
      fieldIndex: 1,
      snapshotTurn: scene.currentBattle.turn,
      allowedCommands: ["FIGHT", "RUN"],
      forcedKind: null,
    });
  }

  private handleChoiceResponse(envelope: ChooseCommandMessage): void {
    if (!this.pending || envelope.requestId !== this.pending.requestId) {
      return;
    }
    const phase = this.pending.phase;
    if (this.pending.timer) {
      clearTimeout(this.pending.timer);
    }
    this.pending = null;
    this.resolveFromResponse(phase, envelope.command);
  }

  private handleTimeout(): void {
    if (!this.pending) {
      return;
    }
    const requestId = this.pending.requestId;
    const phase = this.pending.phase;
    this.pending = null;
    void this.session.sendEnvelope({
      type: "cancel-command-request",
      requestId,
      reason: "host timeout",
    });
    this.getScene().phaseManager.queueMessage("Joiner timed out, defaulting to first usable move.");
    this.resolveDefault(phase);
  }

  private resolveFromResponse(phase: CommandPhase, command: ChooseCommandMessage["command"]): void {
    switch (command.kind) {
      case "FIGHT": {
        const pokemon = phase.getPokemon();
        const moveset = pokemon.getMoveset();
        const moveEntry = moveset[command.moveIndex];
        if (!moveEntry) {
          this.resolveDefault(phase);
          return;
        }
        const moveId = moveEntry.moveId;
        const targets = command.targets ?? this.getDefaultTargets(pokemon, moveId);
        const turnMove: TurnMove = {
          move: moveId,
          targets,
          useMode: MoveUseMode.NORMAL,
        };
        phase.handleCommand(Command.FIGHT, command.moveIndex, MoveUseMode.NORMAL, turnMove);
        return;
      }
      case "RUN":
        phase.handleCommand(Command.RUN, -1);
        return;
      case "CANCEL":
        phase.cancel();
        return;
    }
  }

  private resolveDefault(phase: CommandPhase): void {
    const pokemon = phase.getPokemon();
    const moveset = pokemon.getMoveset();
    const firstUsableIndex = moveset.findIndex(
      (pm): pm is NonNullable<typeof pm> => pm != null && pm.isUsable(pokemon)[0],
    );
    if (firstUsableIndex < 0) {
      phase.handleCommand(Command.FIGHT, -1);
      return;
    }
    const moveEntry = moveset[firstUsableIndex];
    if (!moveEntry) {
      phase.handleCommand(Command.FIGHT, -1);
      return;
    }
    const moveId = moveEntry.moveId;
    const targets = this.getDefaultTargets(pokemon, moveId);
    const turnMove: TurnMove = {
      move: moveId,
      targets,
      useMode: MoveUseMode.NORMAL,
    };
    phase.handleCommand(Command.FIGHT, firstUsableIndex, MoveUseMode.NORMAL, turnMove);
  }
}
