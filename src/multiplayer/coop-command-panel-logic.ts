import type {
  CancelCommandRequestMessage,
  ChooseCommandMessage,
  RequestCommandMessage,
} from "#app/multiplayer/network/messages";
import type { BattleSnapshot } from "#app/multiplayer/network/snapshot";
import { allMoves } from "#data/data-lists";
import { MoveTarget } from "#enums/move-target";

export type PanelState =
  | { kind: "idle" }
  | {
      kind: "request-active";
      requestId: string;
      substate: "move-select" | "target-select";
      pendingMoveIndex?: number;
    }
  | { kind: "submitted"; requestId: string };

export type RequiresEnemyPicker = (moveId: number) => boolean;

export interface CoopCommandPanelDeps {
  sendChooseCommand: (command: ChooseCommandMessage["command"], requestId: string) => void;
  requiresEnemyPicker?: RequiresEnemyPicker;
}

const defaultRequiresEnemyPicker: RequiresEnemyPicker = moveId => {
  const move = allMoves[moveId];
  if (!move) {
    return false;
  }
  const target: MoveTarget = move.moveTarget;
  return target === MoveTarget.NEAR_ENEMY || target === MoveTarget.OTHER;
};

export class CoopCommandPanelLogic {
  private state: PanelState = { kind: "idle" };
  private snapshot: BattleSnapshot | null = null;
  private readonly requiresEnemyPicker: RequiresEnemyPicker;

  constructor(private readonly deps: CoopCommandPanelDeps) {
    this.requiresEnemyPicker = deps.requiresEnemyPicker ?? defaultRequiresEnemyPicker;
  }

  getState(): PanelState {
    return this.state;
  }

  getSnapshot(): BattleSnapshot | null {
    return this.snapshot;
  }

  onSnapshotUpdate(snapshot: BattleSnapshot): void {
    this.snapshot = snapshot;
  }

  onRequestCommand(envelope: RequestCommandMessage): void {
    this.state = {
      kind: "request-active",
      requestId: envelope.requestId,
      substate: "move-select",
    };
  }

  onCancelRequest(_envelope: CancelCommandRequestMessage): void {
    this.state = { kind: "idle" };
  }

  onMoveSelected(moveIndex: number): void {
    if (this.state.kind !== "request-active" || this.state.substate !== "move-select") {
      return;
    }
    const moveId = this.getMoveIdAt(moveIndex);
    if (moveId !== null && this.shouldShowTargetPicker(moveId)) {
      this.state = {
        kind: "request-active",
        requestId: this.state.requestId,
        substate: "target-select",
        pendingMoveIndex: moveIndex,
      };
      return;
    }
    this.submitFight(moveIndex, null);
  }

  onTargetSelected(battlerIndex: number): void {
    if (this.state.kind !== "request-active" || this.state.substate !== "target-select") {
      return;
    }
    if (this.state.pendingMoveIndex === undefined) {
      return;
    }
    this.submitFight(this.state.pendingMoveIndex, [battlerIndex]);
  }

  onTargetBack(): void {
    if (this.state.kind !== "request-active" || this.state.substate !== "target-select") {
      return;
    }
    this.state = {
      kind: "request-active",
      requestId: this.state.requestId,
      substate: "move-select",
    };
  }

  onRunSelected(): void {
    if (this.state.kind !== "request-active") {
      return;
    }
    const requestId = this.state.requestId;
    this.state = { kind: "submitted", requestId };
    this.deps.sendChooseCommand({ kind: "RUN" }, requestId);
  }

  private submitFight(moveIndex: number, targets: number[] | null): void {
    if (this.state.kind !== "request-active") {
      return;
    }
    const requestId = this.state.requestId;
    this.state = { kind: "submitted", requestId };
    this.deps.sendChooseCommand({ kind: "FIGHT", moveIndex, targets }, requestId);
  }

  private getMoveIdAt(moveIndex: number): number | null {
    const moves = this.snapshot?.field.slot1?.moves;
    if (!moves || moveIndex < 0 || moveIndex >= moves.length) {
      return null;
    }
    return moves[moveIndex].id;
  }

  private shouldShowTargetPicker(moveId: number): boolean {
    if (!this.snapshot || !this.requiresEnemyPicker(moveId)) {
      return false;
    }
    const foe0Alive = this.snapshot.field.foe0 != null && this.snapshot.field.foe0.hp > 0;
    const foe1Alive = this.snapshot.field.foe1 != null && this.snapshot.field.foe1.hp > 0;
    return foe0Alive && foe1Alive;
  }
}
