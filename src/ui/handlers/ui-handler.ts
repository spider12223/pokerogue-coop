import { globalScene } from "#app/global-scene";
import type { Button } from "#enums/buttons";
import { PointerHitAreaManager } from "#ui/pointer-hit-areas";
import { pointerControlsOn } from "#ui/pointer-input";

/**
 * A basic abstract class to act as a holder and processor for UI elements.
 */
export abstract class UiHandler {
  protected cursor = 0;
  public active = false;

  abstract setup(): void;

  show(_args: any[]): boolean {
    this.active = true;

    return true;
  }

  abstract processInput(button: Button): boolean;

  getUi() {
    return globalScene.ui;
  }

  getCursor(): number {
    return this.cursor;
  }

  setCursor(cursor: number): boolean {
    const changed = this.cursor !== cursor;
    if (changed) {
      this.cursor = cursor;
    }

    return changed;
  }

  /**
   * Create a {@linkcode PointerHitAreaManager} whose hit areas live inside `parent` and which restyles the mouse cursor
   * over its rows. Call `.clear()` on it from this handler's `clear()`.
   * @param parent - The container the invisible hit areas are added to
   */
  protected createPointerHitAreas(parent: Phaser.GameObjects.Container): PointerHitAreaManager {
    return new PointerHitAreaManager(parent, style => this.setMouseCursorStyle(style));
  }

  /**
   * Whether a tap / left click on EMPTY space (not on any hit area) should press ACTION for this handler, like the A
   * button. Handlers whose screen is waiting for "press A to continue" override this.
   */
  public acceptsEmptySpaceTap(): boolean {
    return false;
  }

  /**
   * Whether pointer events should currently reach this handler: it is active AND it is the handler of the mode that is on
   * top. `setModeWithoutClear` and overlays leave lower handlers `active`, so `active` alone is not enough.
   * Every pointer callback should bail out when this is false. Off with the Click & Tap Controls setting (D49).
   */
  protected isPointerInputEnabled(): boolean {
    return pointerControlsOn() && this.active && globalScene.ui?.getHandler?.() === this;
  }

  /**
   * Changes the style of the mouse cursor.
   * @see {@link https://developer.mozilla.org/en-US/docs/Web/CSS/cursor}
   * @param cursorStyle cursor style to apply
   */
  protected setMouseCursorStyle(cursorStyle: "pointer" | "default") {
    const canvas = globalScene.input?.manager?.canvas;
    if (canvas) {
      canvas.style.cursor = cursorStyle;
    }
  }

  clear() {
    this.active = false;
  }
  /**
   * To be implemented by individual handlers when necessary to free memory
   * Called when {@linkcode BattleScene} is reset
   */
  destroy(): void {}
}
