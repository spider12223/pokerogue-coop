import type { PlayerSlot } from "#app/multiplayer/input-role";
import type { InputSource, SourceId, SourceKind } from "#app/multiplayer/input-source";
import type { Button } from "#enums/buttons";
import { getButtonWithKeycode } from "#inputs/config-handler";
import type { CustomKeyboardConfig, KeyboardConfig } from "#types/configs/inputs";

const REPEAT_INPUT_DELAY_MS = 250;

function ensureCustom(config: KeyboardConfig): CustomKeyboardConfig {
  if (config.custom) {
    return config as CustomKeyboardConfig;
  }
  return { ...config, custom: { ...config.default } } as CustomKeyboardConfig;
}

export class KeyboardInputSource implements InputSource {
  public readonly id: SourceId;
  public readonly kind: SourceKind = "keyboard";
  public readonly playerSlot: PlayerSlot;
  public enabled = true;

  private config: CustomKeyboardConfig;
  private emitter: Phaser.Events.EventEmitter | null = null;
  private keyboard: Phaser.Input.Keyboard.KeyboardPlugin | null = null;
  private readonly buttonLock = new Set<Button>();
  private readonly repeatTimers = new Map<Button, ReturnType<typeof setInterval>>();

  private readonly onKeyDown: (event: KeyboardEvent) => void;
  private readonly onKeyUp: (event: KeyboardEvent) => void;

  constructor(id: SourceId, playerSlot: PlayerSlot, config: KeyboardConfig) {
    this.id = id;
    this.playerSlot = playerSlot;
    this.config = ensureCustom(config);
    this.onKeyDown = (event: KeyboardEvent) => this.handleKeyDown(event);
    this.onKeyUp = (event: KeyboardEvent) => this.handleKeyUp(event);
  }

  attach(scene: Phaser.Scene, emitter: Phaser.Events.EventEmitter): void {
    this.emitter = emitter;
    this.keyboard = scene.input.keyboard ?? null;
    this.keyboard?.on("keydown", this.onKeyDown);
    this.keyboard?.on("keyup", this.onKeyUp);
  }

  detach(): void {
    this.keyboard?.off("keydown", this.onKeyDown);
    this.keyboard?.off("keyup", this.onKeyUp);
    this.releaseAll();
    this.keyboard = null;
    this.emitter = null;
  }

  releaseAll(): void {
    for (const timer of this.repeatTimers.values()) {
      clearInterval(timer);
    }
    this.repeatTimers.clear();
    this.buttonLock.clear();
  }

  getIconForButton(button: Button): string | undefined {
    const custom = this.config.custom ?? this.config.default;
    for (const [keyName, settingName] of Object.entries(custom)) {
      if (settingName !== -1 && this.config.settings[settingName] === button) {
        return this.config.icons[keyName as keyof typeof this.config.icons];
      }
    }
    return;
  }

  setConfig(config: KeyboardConfig): void {
    this.config = ensureCustom(config);
  }

  getConfig(): CustomKeyboardConfig {
    return this.config;
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.enabled || !this.emitter) {
      return;
    }
    const button = getButtonWithKeycode(this.config, event.keyCode);
    if (button == null) {
      return;
    }
    if (this.buttonLock.has(button)) {
      return;
    }

    this.emit("input_down", button, false);
    this.buttonLock.add(button);

    const existing = this.repeatTimers.get(button);
    if (existing) {
      clearInterval(existing);
    }
    this.repeatTimers.set(
      button,
      setInterval(() => {
        if (!this.enabled || !this.emitter) {
          return;
        }
        this.emit("input_down", button, true);
      }, REPEAT_INPUT_DELAY_MS),
    );
  }

  private handleKeyUp(event: KeyboardEvent): void {
    if (!this.emitter) {
      return;
    }
    const button = getButtonWithKeycode(this.config, event.keyCode);
    if (button == null) {
      return;
    }

    this.emit("input_up", button, false);
    this.buttonLock.delete(button);
    const timer = this.repeatTimers.get(button);
    if (timer) {
      clearInterval(timer);
      this.repeatTimers.delete(button);
    }
  }

  private emit(name: "input_down" | "input_up", button: Button, isRepeat: boolean): void {
    this.emitter!.emit(name, {
      button,
      sourceId: this.id,
      sourceKind: this.kind,
      playerSlot: this.playerSlot,
      timestamp: Date.now(),
      isRepeat,
    });
  }
}
