import { eventBus } from "#app/event-bus";
import { globalScene } from "#app/global-scene";
import { settings } from "#app/global-settings-manager";
import { PointerHighlight } from "#enums/pointer-highlight";
import { UiMode } from "#enums/ui-mode";
import type { SettingsUpdateEventArgs } from "#types/event-bus-types";
import { applySiteCursor, cursorCss } from "#ui/mouse-cursors";
import { pointerControlsOn } from "#ui/pointer-input";
import type Phaser from "phaser";

/**
 * Mouse mode (D49): with Click & Tap Controls on, a player who moves the pointer plays by pointer. The menus then mark the
 * option under it in the chosen style (Settings > General > Mouse Highlight) instead of with their arrow; a key, a
 * gamepad button or a tap brings the arrow back. The screens where a click picks keep theirs. The game's own mouse
 * pointer is set here too (Mouse Cursor).
 * @module
 */

/** An arrow of a menu: anything with an alpha (a menu's `cursorObj`) */
interface Arrow {
  alpha: number;
  setAlpha(value: number): unknown;
}

interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The pointer was used last (the setting decides whether that counts: {@linkcode isPointerMode}) */
let pointerUsed = false;
/** The mark on the option under the pointer: one pointer, one mark */
let hoverBox: Phaser.GameObjects.Graphics | null = null;
/** What the mark belongs to (the hit area under the pointer) */
let hoverOwner: unknown = null;
/** The step of the pulsing corners */
let hoverTimer: Phaser.Time.TimerEvent | null = null;
/** The arrows hidden in mouse mode, with the alpha each had */
const hiddenArrows = new Map<Arrow, number>();
/** The settings are listened to (once: the event bus outlives a game's scene) */
let listening = false;

/**
 * The screens where the first click picks and a second one acts, while a hover only points: their cursor shows the pick
 * (which the mark under the pointer does not), so mouse mode keeps it
 */
const CLICK_TO_PICK_MODES: ReadonlySet<UiMode> = new Set([
  UiMode.MODIFIER_SELECT,
  UiMode.STARTER_SELECT,
  UiMode.POKEDEX,
  UiMode.EGG_LIST,
  UiMode.EGG_HATCH_SUMMARY,
  UiMode.RUN_HISTORY,
  UiMode.SAVE_SLOT,
]);

const WHITE = 0xffffff;
const GLOW = 0x7fd8ff;
const SHORT_CORNER = 3;
const LONG_CORNER = 6;

function isArrow(value: unknown): value is Arrow {
  return (
    typeof value === "object"
    && value !== null
    && typeof (value as Arrow).alpha === "number"
    && typeof (value as Arrow).setAlpha === "function"
  );
}

function highlight(): PointerHighlight {
  return settings?.general?.pointerHighlight ?? PointerHighlight.CORNERS;
}

/** @returns Whether the menus mark the option under the pointer instead of showing their arrow */
export function isPointerMode(): boolean {
  return pointerUsed && pointerControlsOn();
}

/**
 * The pointer moved or pressed: a mouse means mouse mode, if Click & Tap Controls is on; a finger is played like the keys
 * (a tap has no hover, so the arrow is what shows the option between taps)
 */
export function enterPointerMode(pointer?: { wasTouch?: boolean }): void {
  if (pointer?.wasTouch) {
    enterKeyMode();
  } else if (pointerControlsOn()) {
    pointerUsed = true;
  }
}

/** A key or a gamepad button: the arrows come back as they were, and the mark goes */
export function enterKeyMode(): void {
  pointerUsed = false;
  hideHoverBox();
  restoreArrows();
}

function restoreArrows(): void {
  for (const [arrow, alpha] of hiddenArrows) {
    arrow.setAlpha(alpha);
  }
  hiddenArrows.clear();
}

/** @returns Whether a mark is up (for tests) */
export function hasHoverBox(): boolean {
  return hoverBox !== null;
}

/** A frame one pixel wide with its corners cut */
function frame(box: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number): void {
  box.fillRect(x + 1, y, w - 2, 1);
  box.fillRect(x + 1, y + h - 1, w - 2, 1);
  box.fillRect(x, y + 1, 1, h - 2);
  box.fillRect(x + w - 1, y + 1, 1, h - 2);
}

/**
 * Where a mark goes: the option's hit area, 2 pixels in at the sides and 1 at the top and bottom, so that no mark reaches
 * the window's border (a hit area runs to it, to be easy to press); a small one is used whole
 */
function cleanArea(area: Area): Area {
  const dx = area.width >= 16 ? 2 : 0;
  const dy = area.height >= 10 ? 1 : 0;
  return { x: area.x + dx, y: area.y + dy, width: area.width - 2 * dx, height: area.height - 2 * dy };
}

/** Lines `length` long at the four corners of the area, drawn `inward` pixels in */
function corners(box: Phaser.GameObjects.Graphics, area: Area, length: number, inward: number): void {
  box.clear();
  const x = area.x + inward;
  const y = area.y + inward;
  const w = area.width - 2 * inward;
  const h = area.height - 2 * inward;
  const l = Math.max(1, Math.min(length, Math.floor(w / 2), Math.floor(h / 2)));
  box.fillStyle(WHITE, 1);
  box.fillRect(x, y, l, 1);
  box.fillRect(x, y, 1, l);
  box.fillRect(x + w - l, y, l, 1);
  box.fillRect(x + w - 1, y, 1, l);
  box.fillRect(x, y + h - 1, l, 1);
  box.fillRect(x, y + h - l, 1, l);
  box.fillRect(x + w - l, y + h - 1, l, 1);
  box.fillRect(x + w - 1, y + h - l, 1, l);
}

/** Draw the chosen mark into the box, inside the option's clean area (and start its motion, for the moving ones) */
function drawMark(box: Phaser.GameObjects.Graphics, hitArea: Area, style: PointerHighlight): void {
  const area = cleanArea(hitArea);
  const { x, y, width: w, height: h } = area;
  switch (style) {
    case PointerHighlight.CORNERS_LONG:
      corners(box, area, LONG_CORNER, 0);
      break;
    case PointerHighlight.CORNERS_PULSE: {
      // (it steps in and back, never out of the clean area)
      let inward = 0;
      corners(box, area, SHORT_CORNER, inward);
      hoverTimer = globalScene.time.addEvent({
        delay: 400,
        loop: true,
        callback: () => {
          inward = 1 - inward;
          corners(box, area, SHORT_CORNER, inward);
        },
      });
      break;
    }
    case PointerHighlight.GLOW:
      box.fillStyle(GLOW, 1);
      frame(box, x, y, w, h);
      box.fillStyle(GLOW, 0.3);
      frame(box, x + 1, y + 1, w - 2, h - 2);
      globalScene.tweens.add({
        targets: box,
        alpha: { from: 1, to: 0.45 },
        duration: 700,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
      break;
    case PointerHighlight.BAR:
      box.fillStyle(WHITE, 0.22);
      box.fillRect(x + 1, y, w - 2, h);
      box.fillRect(x, y + 1, 1, h - 2);
      box.fillRect(x + w - 1, y + 1, 1, h - 2);
      break;
    default:
      corners(box, area, SHORT_CORNER, 0);
      break;
  }
}

/**
 * Mark an option under the pointer in the chosen style, the size of its hit area, in the hit area's parent (so it moves
 * and hides with the menu). The Classic style marks nothing: the menu's own arrow follows the pointer.
 * @param owner - The hit area: the mark goes when the pointer leaves it ({@linkcode hideHoverBox})
 */
export function showHoverBox(parent: Phaser.GameObjects.Container, area: Area, owner: unknown): void {
  hideHoverBox();
  const style = highlight();
  if (!isPointerMode() || style === PointerHighlight.CLASSIC) {
    return;
  }
  const box = globalScene.add.graphics();
  hoverBox = box;
  hoverOwner = owner;
  drawMark(box, area, style);
  parent.add(box);
}

/**
 * Take the mark away
 * @param owner - Only if it is this hit area's (the pointer left it); without one, whoever's it is
 */
export function hideHoverBox(owner?: unknown): void {
  if (hoverBox === null || (owner !== undefined && owner !== hoverOwner)) {
    return;
  }
  hoverTimer?.remove();
  hoverTimer = null;
  globalScene.tweens?.killTweensOf?.(hoverBox);
  hoverBox.destroy();
  hoverBox = null;
  hoverOwner = null;
}

/** @returns Whether the mark is this hit area's */
export function isHoverBoxOf(owner: unknown): boolean {
  return hoverBox !== null && hoverOwner === owner;
}

/**
 * Each frame: in mouse mode the arrow of the menu that is up is hidden (its own alpha is kept for when a key brings it
 * back, also if the menu changed it meanwhile), except with the Classic style and on a screen where a click picks;
 * otherwise the hidden arrows come back.
 */
export function syncMenuArrow(): void {
  const mode = globalScene.ui?.mode;
  if (
    !isPointerMode()
    || highlight() === PointerHighlight.CLASSIC
    || (mode !== undefined && CLICK_TO_PICK_MODES.has(mode))
  ) {
    if (hiddenArrows.size > 0) {
      restoreArrows();
    }
    return;
  }
  // (the party's options list has its own arrow, with a name of its own)
  const handler = globalScene.ui?.getHandler?.() as { cursorObj?: unknown; optionsCursorObj?: unknown } | undefined;
  for (const arrow of [handler?.cursorObj, handler?.optionsCursorObj]) {
    if (isArrow(arrow) && arrow.alpha !== 0) {
      hiddenArrows.set(arrow, arrow.alpha);
      arrow.setAlpha(0);
    }
  }
}

/** Give the page and the canvas the chosen mouse pointer (the computer's with System) */
export function applyMouseCursor(): void {
  applySiteCursor();
  const css = cursorCss("default");
  globalScene.input?.setDefaultCursor?.(css);
  const canvas = globalScene.game?.canvas;
  if (canvas) {
    canvas.style.cursor = css;
  }
}

/** Listen for the pointer, the keys and the settings, and keep the arrows in step every frame (once, from the UI's setup) */
export function installPointerMode(): void {
  if (!listening) {
    listening = true;
    eventBus.on("settings/update/success", ({ category, key }: SettingsUpdateEventArgs) => {
      if (category !== "general") {
        return;
      }
      // (a new highlight is drawn on the next option the pointer enters; the pointer itself changes at once)
      if (key === "pointerControls" || key === "pointerHighlight") {
        hideHoverBox();
      }
      if (key === "mouseCursor") {
        applyMouseCursor();
      }
    });
  }
  const input = globalScene.input;
  if (!input?.on) {
    return;
  }
  input.on("pointermove", enterPointerMode);
  input.on("pointerdown", enterPointerMode);
  input.keyboard?.on("keydown", enterKeyMode);
  input.gamepad?.on("down", enterKeyMode);
  globalScene.events.on("postupdate", syncMenuArrow);
  applyMouseCursor();
}
