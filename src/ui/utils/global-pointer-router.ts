import { globalScene } from "#app/global-scene";
import { Button } from "#enums/buttons";
import { ensureCanvasContextMenuDisabled } from "#ui/pointer-hit-areas";
import { pointerControlsOn, pressButton } from "#ui/pointer-input";

/** How long a press on empty space is held before it counts as a long press (opens the main menu) */
export const LONG_PRESS_MILLIS = 600;
/** How far (in canvas pixels) the pointer may move during a press for it to still count as a tap / long press */
const TAP_MOVE_TOLERANCE = 12;

/**
 * Pointer behaviour for presses that land on EMPTY space (no interactive hit area is under the pointer). This replaces
 * the A, B and Menu buttons of the removed on-screen keypad everywhere that a handler has no hit area of its own:
 *
 * - **tap / left click** advances whatever waits for a press (message text, tutorials), like A;
 * - **right click** goes back, like B;
 * - **long press** (held {@linkcode LONG_PRESS_MILLIS}) opens the main menu, like Menu. The game itself decides in which
 *   screens that is allowed.
 *
 * Interactive hit areas (menus, grids, ...) are on top of empty space and handle their own presses.
 */
export function installGlobalPointerRouter(): void {
  const input = globalScene.input;
  if (!input?.on) {
    return;
  }
  ensureCanvasContextMenuDisabled();

  let pressStartedOnEmpty = false;
  let longPressFired = false;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelLongPress = (): void => {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };

  input.on("pointerdown", (pointer: Phaser.Input.Pointer, over: unknown[]) => {
    cancelLongPress();
    pressStartedOnEmpty = false;
    longPressFired = false;
    // (Click & Tap Controls off: a press on the game does nothing, as before, D49)
    if (over.length > 0 || !pointerControlsOn()) {
      return;
    }

    if (pointer.rightButtonDown()) {
      pressButton(Button.CANCEL);
      return;
    }

    pressStartedOnEmpty = true;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (pressStartedOnEmpty && pointer.isDown && pointer.getDistance() <= TAP_MOVE_TOLERANCE) {
        longPressFired = true;
        pressButton(Button.MENU, pointer.wasTouch);
      }
    }, LONG_PRESS_MILLIS);
  });

  input.on("pointerup", (pointer: Phaser.Input.Pointer) => {
    cancelLongPress();
    const wasTap = pressStartedOnEmpty && !longPressFired && pointer.getDistance() <= TAP_MOVE_TOLERANCE;
    pressStartedOnEmpty = false;
    if (!wasTap) {
      return;
    }

    if (globalScene.ui?.getHandler?.()?.acceptsEmptySpaceTap()) {
      pressButton(Button.ACTION, pointer.wasTouch);
    }
  });
}
