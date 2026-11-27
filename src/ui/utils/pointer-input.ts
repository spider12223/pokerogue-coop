import { globalScene } from "#app/global-scene";
import { settings } from "#app/global-settings-manager";
import type { Button } from "#enums/buttons";

/** @returns Whether clicks and taps on the game itself work (the Click & Tap Controls setting, D49) */
export function pointerControlsOn(): boolean {
  return settings?.general?.pointerControls === true;
}

/**
 * Press and release a game {@linkcode Button} exactly as the keyboard would, through the global input event path
 * (`input_down` then `input_up`). Use this for pointer shortcuts that must behave like a real key press everywhere
 * (e.g. opening the main menu or cycling an option), where calling a single handler's `processInput` is not enough.
 *
 * Inside one handler, prefer calling that handler's own `setCursor(...)` / `processInput(...)`.
 *
 * @param button - The button to press
 * @param isTouch - Whether the press comes from a touch pointer (selects the touch glyphs/tooltips)
 */
export function pressButton(button: Button, isTouch = false): void {
  const events = globalScene.game.events;
  events.emit("input_down", { controller_type: "keyboard", button, isTouch });
  events.emit("input_up", { controller_type: "keyboard", button, isTouch });
}

/**
 * Hold a game {@linkcode Button} down; call the returned function to release it.
 * Used for hold-to-show inputs such as the stats/info overlays.
 * @returns A function that releases the button
 */
export function holdButton(button: Button, isTouch = false): () => void {
  const events = globalScene.game.events;
  events.emit("input_down", { controller_type: "keyboard", button, isTouch });
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    events.emit("input_up", { controller_type: "keyboard", button, isTouch });
  };
}
