import type { PlayerSlot } from "#app/multiplayer/input-role";
import type { Button } from "#enums/buttons";

export type SourceKind = "keyboard" | "gamepad" | "touch" | "network";

export type SourceId = string;

export interface InputEvent {
  readonly button: Button;
  readonly sourceId: SourceId;
  readonly sourceKind: SourceKind;
  readonly playerSlot: PlayerSlot;
  readonly timestamp: number;
  readonly isRepeat: boolean;
}

export type InputDownEvent = InputEvent;

export interface InputUpEvent extends InputEvent {
  readonly isRepeat: false;
}

export type InputEventName = "input_down" | "input_up";

export interface InputSource {
  readonly id: SourceId;
  readonly kind: SourceKind;
  readonly playerSlot: PlayerSlot;
  enabled: boolean;

  attach(scene: Phaser.Scene, emitter: Phaser.Events.EventEmitter): void;
  detach(): void;
  releaseAll(): void;
  getIconForButton(button: Button): string | undefined;
}
