import { globalScene } from "#app/global-scene";
import { pointerControlsOn } from "#ui/pointer-input";
import { enterPointerMode, hideHoverBox, isHoverBoxOf, showHoverBox } from "#ui/pointer-mode";
import type Phaser from "phaser";

export interface PointerRowHitAreaConfig {
  /** X position of the hit area relative to the parent container */
  x: number;
  /** Y position of the hit area relative to the parent container */
  y: number;
  width: number;
  height: number;
  /** Called on pointerover (mouse hover). Not meaningfully available on touch. */
  onHover?: () => void;
  /** Called on left-click / tap */
  onActivate?: () => void;
  /** Called on right-click */
  onRightClick?: () => void;
}

type CursorStyleSetter = (cursorStyle: "pointer" | "default") => void;

let contextMenuDisabled = false;

/**
 * Prevent the browser context menu on the game canvas so right-click can be used in-game.
 * Safe to call repeatedly.
 */
export function ensureCanvasContextMenuDisabled(): void {
  if (contextMenuDisabled) {
    return;
  }
  const canvas = globalScene.game.canvas;
  // (with Click & Tap Controls off, a right click is the browser's again, D49)
  canvas.addEventListener("contextmenu", event => {
    if (pointerControlsOn()) {
      event.preventDefault();
    }
  });
  contextMenuDisabled = true;
}

function isLeftPointer(pointer: Phaser.Input.Pointer): boolean {
  // Touch / pen have no mouse buttons; treat as primary activate.
  if (pointer.wasTouch || pointer.button === undefined || pointer.button < 0) {
    return true;
  }
  return pointer.leftButtonDown() || pointer.button === 0;
}

function isRightPointer(pointer: Phaser.Input.Pointer): boolean {
  return pointer.rightButtonDown() || pointer.button === 2;
}

/**
 * Manages rebuildable Phaser pointer hit areas for menu rows and optional outside-cancel zones.
 */
export class PointerHitAreaManager {
  private readonly parent: Phaser.GameObjects.Container;
  private readonly setCursorStyle: CursorStyleSetter;
  private readonly rowZones: Phaser.GameObjects.Rectangle[] = [];
  private outsideZone: Phaser.GameObjects.Rectangle | null = null;
  private wheelListener: ((pointer: Phaser.Input.Pointer, over: unknown[], dx: number, dy: number) => void) | null =
    null;

  constructor(parent: Phaser.GameObjects.Container, setCursorStyle: CursorStyleSetter) {
    this.parent = parent;
    this.setCursorStyle = setCursorStyle;
  }

  /**
   * Replace all row hit areas with the given configs.
   */
  public setRows(configs: PointerRowHitAreaConfig[]): void {
    this.clearRows();

    for (const config of configs) {
      // Invisible rectangle hit targets (Zones are not mocked in unit tests).
      const zone = globalScene.add
        .rectangle(config.x, config.y, config.width, config.height, 0xffffff, 0)
        .setOrigin(0, 0)
        .setInteractive();

      zone.on("pointerover", () => {
        if (!pointerControlsOn()) {
          return;
        }
        this.setCursorStyle("pointer");
        // mouse mode: a box on the option instead of the menu's arrow (D49)
        enterPointerMode();
        showHoverBox(this.parent, config, zone);
        config.onHover?.();
      });

      // (back from a key press with the pointer still on the option: its box comes back as it moves)
      zone.on("pointermove", () => {
        if (pointerControlsOn() && !isHoverBoxOf(zone)) {
          enterPointerMode();
          showHoverBox(this.parent, config, zone);
        }
      });

      zone.on("pointerout", () => {
        this.setCursorStyle("default");
        hideHoverBox(zone);
      });

      zone.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        if (!pointerControlsOn()) {
          return;
        }
        if (isRightPointer(pointer)) {
          config.onRightClick?.();
          return;
        }
        if (isLeftPointer(pointer)) {
          config.onActivate?.();
        }
      });

      this.parent.add(zone);
      this.rowZones.push(zone);
    }
  }

  /**
   * Full-screen (or custom) zone that fires on pointerdown for clicks outside a menu.
   * Appended to the parent; callers should `bringToTop` the menu above this zone so
   * menu rows receive hits first while everything else falls through to cancel.
   */
  public setOutsideCancel(
    onCancel: () => void,
    width: number = globalScene.scaledCanvas.width,
    height: number = globalScene.scaledCanvas.height,
    x = 0,
    y = -globalScene.scaledCanvas.height,
  ): void {
    this.clearOutside();

    const zone = globalScene.add.rectangle(x, y, width, height, 0xffffff, 0).setOrigin(0, 0).setInteractive();
    zone.on("pointerdown", () => {
      if (pointerControlsOn()) {
        onCancel();
      }
    });

    this.parent.add(zone);
    this.outsideZone = zone;
  }

  /** Bring the outside-cancel zone above other siblings (menu should still be brought above this). */
  public bringOutsideToTop(): void {
    if (this.outsideZone) {
      this.parent.bringToTop(this.outsideZone);
    }
  }

  public clearRows(): void {
    for (const zone of this.rowZones) {
      hideHoverBox(zone);
      zone.removeAllListeners();
      // Parent may have already destroyed children via removeAll(true).
      if (zone.scene) {
        zone.destroy();
      }
    }
    this.rowZones.length = 0;
  }

  public clearOutside(): void {
    if (this.outsideZone) {
      this.outsideZone.removeAllListeners();
      if (this.outsideZone.scene) {
        this.outsideZone.destroy();
      }
      this.outsideZone = null;
    }
  }

  /**
   * Route the mouse wheel to a scrolling list: `onWheel(-1)` for wheel up, `onWheel(1)` for wheel down.
   * Replaces any previous wheel handler. Removed by {@linkcode clear}.
   * @param onWheel - Called once per wheel notch with the scroll direction
   */
  public setWheelHandler(onWheel: (direction: -1 | 1) => void): void {
    this.clearWheel();
    this.wheelListener = (_pointer: Phaser.Input.Pointer, _over: unknown[], _dx: number, dy: number) => {
      if (dy !== 0 && pointerControlsOn()) {
        onWheel(dy < 0 ? -1 : 1);
      }
    };
    globalScene.input?.on?.("wheel", this.wheelListener);
  }

  public clearWheel(): void {
    if (this.wheelListener) {
      globalScene.input?.off?.("wheel", this.wheelListener);
      this.wheelListener = null;
    }
  }

  public clear(): void {
    this.clearRows();
    this.clearOutside();
    this.clearWheel();
    // Scene/input may already be torn down during handler clear in tests.
    try {
      this.setCursorStyle("default");
    } catch {
      // no-op
    }
  }

  /**
   * Enable or disable interactive input on all managed row zones.
   */
  public setRowsEnabled(enabled: boolean): void {
    for (const zone of this.rowZones) {
      if (enabled) {
        zone.setInteractive();
      } else {
        zone.disableInteractive();
      }
    }
  }
}
