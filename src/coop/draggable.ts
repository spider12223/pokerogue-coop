/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * A box over the game that the player can drag by its handles: the chat box (DECISIONS D38) and the host's debug menu
 * (D42). Where it was dropped is kept in this browser and comes back on the next page; it is kept inside the window when the
 * window or the box changes size. A double click on a handle puts it back where it was at first.
 * @module
 */

/** How far the pointer must move before a press becomes a drag: a press on a handle that is a button stays a click */
const DRAG_THRESHOLD = 4;

/**
 * Where the box was dropped, in CSS pixels from the window's top and from its left edge (`left` anchor) or its right edge
 * (`right` anchor: a box laid out from the right, such as the chat, keeps its right edge when it grows)
 */
interface Position {
  x: number;
  y: number;
}

export type DragAnchor = "left" | "right";

export interface Draggable {
  /** Put the box back where it was at first, and forget where it was dropped */
  reset(): void;
  /** Keep the box inside the window: call it when the box is shown or changes size */
  clamp(): void;
  /** Stop listening (the box goes away) */
  destroy(): void;
}

function readPosition(key: string): Position | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) {
      return null;
    }
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const { x, y } = value as Record<string, unknown>;
    return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  } catch {
    return null;
  }
}

function writePosition(key: string, position: Position | null): void {
  try {
    if (position === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify({ x: Math.round(position.x), y: Math.round(position.y) }));
    }
  } catch {
    // Storage off: the box stays where it is for this page only
  }
}

const between = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), Math.max(low, high));

/** A press on a control inside a handle (a close button, a mute button) is that control's, not a drag */
function isControlIn(handle: HTMLElement, target: EventTarget | null): boolean {
  if (!(target instanceof Element) || target === handle) {
    return false;
  }
  const control = target.closest("button, input, select, textarea, a");
  return control !== null && control !== handle && handle.contains(control);
}

/**
 * Let the player drag `root` by `handles`.
 * @param storageKey - Where this browser keeps the spot it was dropped at
 * @param anchor - Which edge of the window the spot is measured from
 */
export function makeDraggable(
  root: HTMLElement,
  handles: readonly HTMLElement[],
  storageKey: string,
  anchor: DragAnchor = "left",
): Draggable {
  let position = readPosition(storageKey);
  let press: { x: number; y: number; left: number; top: number; width: number; handle: HTMLElement } | null = null;
  let dragging = false;
  let swallowClick = false;

  const place = (): void => {
    if (position === null) {
      for (const side of ["left", "right", "top"] as const) {
        root.style.removeProperty(side);
      }
      root.classList.remove("coop-moved");
      return;
    }
    const rect = root.getBoundingClientRect();
    const x = between(position.x, 0, window.innerWidth - rect.width);
    const y = between(position.y, 0, window.innerHeight - rect.height);
    root.style.top = `${y}px`;
    if (anchor === "left") {
      root.style.left = `${x}px`;
      root.style.right = "auto";
    } else {
      root.style.right = `${x}px`;
      root.style.left = "auto";
    }
    root.classList.add("coop-moved");
  };

  const onDown = (event: PointerEvent): void => {
    const handle = event.currentTarget as HTMLElement;
    if (event.button !== 0 || isControlIn(handle, event.target)) {
      return;
    }
    const rect = root.getBoundingClientRect();
    press = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, width: rect.width, handle };
    dragging = false;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // (a synthetic press has no pointer to capture)
    }
  };

  const onMove = (event: PointerEvent): void => {
    if (press === null) {
      return;
    }
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) {
      return;
    }
    dragging = true;
    event.preventDefault();
    const left = press.left + dx;
    position = { x: anchor === "left" ? left : window.innerWidth - (left + press.width), y: press.top + dy };
    place();
  };

  const onUp = (): void => {
    if (press === null) {
      return;
    }
    if (dragging) {
      writePosition(storageKey, position);
      // The click that ends a drag on a button handle (the chat toggle) is not a press of that button
      swallowClick = true;
    }
    press = null;
    dragging = false;
  };

  const onClick = (event: MouseEvent): void => {
    if (swallowClick) {
      swallowClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  const onDoubleClick = (event: MouseEvent): void => {
    if (!isControlIn(event.currentTarget as HTMLElement, event.target)) {
      reset();
    }
  };

  const reset = (): void => {
    position = null;
    writePosition(storageKey, null);
    place();
  };

  for (const handle of handles) {
    handle.classList.add("coop-drag-handle");
    handle.addEventListener("pointerdown", onDown);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
    // Before the handle's own click: it must not see the click that ends a drag
    handle.addEventListener("click", onClick, true);
    handle.addEventListener("dblclick", onDoubleClick);
  }
  window.addEventListener("resize", place);
  place();

  return {
    reset,
    clamp: place,
    destroy() {
      window.removeEventListener("resize", place);
      for (const handle of handles) {
        handle.removeEventListener("pointerdown", onDown);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        handle.removeEventListener("click", onClick, true);
        handle.removeEventListener("dblclick", onDoubleClick);
      }
    },
  };
}
