import { eventBus } from "#app/event-bus";
import { globalScene } from "#app/global-scene";
import { settings } from "#app/global-settings-manager";
import { PointerHighlight } from "#enums/pointer-highlight";
import type { SettingsUpdateEventArgs } from "#types/event-bus-types";
import { cursorCss } from "#ui/mouse-cursors";
import { pointerControlsOn } from "#ui/pointer-input";
import type Phaser from "phaser";

/**
 * Mouse mode (D49): with Click & Tap Controls on, a player who moves the pointer plays by pointer. The menus then mark the
 * option under it in the chosen style (Settings > General > Mouse Highlight) instead of with their arrow; a key or a
 * gamepad button brings the arrow back. The game's own mouse pointer is set here too (Mouse Cursor).
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

const WHITE = 0xffffff;
const SHADOW = 0x101010;
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

/** The pointer moved or pressed: mouse mode, if Click & Tap Controls is on */
export function enterPointerMode(): void {
  if (pointerControlsOn()) {
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

/** Lines `length` long at the four corners of the area, grown by `out` on each side, each over a dark line */
function corners(box: Phaser.GameObjects.Graphics, area: Area, length: number, out: number): void {
  box.clear();
  const x = area.x - out;
  const y = area.y - out;
  const w = area.width + 2 * out;
  const h = area.height + 2 * out;
  const l = Math.max(1, Math.min(length, Math.floor(w / 2), Math.floor(h / 2)));
  for (const [color, alpha, d] of [
    [SHADOW, 0.5, 1],
    [WHITE, 1, 0],
  ] as const) {
    box.fillStyle(color, alpha);
    box.fillRect(x + d, y + d, l, 1);
    box.fillRect(x + d, y + d, 1, l);
    box.fillRect(x + w - l + d, y + d, l, 1);
    box.fillRect(x + w - 1 + d, y + d, 1, l);
    box.fillRect(x + d, y + h - 1 + d, l, 1);
    box.fillRect(x + d, y + h - l + d, 1, l);
    box.fillRect(x + w - l + d, y + h - 1 + d, l, 1);
    box.fillRect(x + w - 1 + d, y + h - l + d, 1, l);
  }
}

/** Draw the chosen mark into the box (and start its motion, for the pulsing ones) */
function drawMark(box: Phaser.GameObjects.Graphics, area: Area, style: PointerHighlight): void {
  const { x, y, width: w, height: h } = area;
  switch (style) {
    case PointerHighlight.CORNERS_LONG:
      corners(box, area, LONG_CORNER, 0);
      break;
    case PointerHighlight.CORNERS_PULSE: {
      let out = 0;
      corners(box, area, SHORT_CORNER, out);
      hoverTimer = globalScene.time.addEvent({
        delay: 400,
        loop: true,
        callback: () => {
          out = 1 - out;
          corners(box, area, SHORT_CORNER, out);
        },
      });
      break;
    }
    case PointerHighlight.GLOW:
      box.fillStyle(GLOW, 0.35);
      frame(box, x - 1, y - 1, w + 2, h + 2);
      box.fillStyle(GLOW, 1);
      frame(box, x, y, w, h);
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
 * back, also if the menu changed it meanwhile), except with the Classic style; otherwise the hidden arrows come back.
 */
export function syncMenuArrow(): void {
  if (!isPointerMode() || highlight() === PointerHighlight.CLASSIC) {
    if (hiddenArrows.size > 0) {
      restoreArrows();
    }
    return;
  }
  const arrow = (globalScene.ui?.getHandler?.() as { cursorObj?: unknown } | undefined)?.cursorObj;
  if (isArrow(arrow) && arrow.alpha !== 0) {
    hiddenArrows.set(arrow, arrow.alpha);
    arrow.setAlpha(0);
  }
}

/** Give the canvas the chosen mouse pointer (the computer's with Click & Tap Controls off, or System) */
export function applyMouseCursor(): void {
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
      if (key === "pointerControls" || key === "mouseCursor") {
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
