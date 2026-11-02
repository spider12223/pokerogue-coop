/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { type Draggable, makeDraggable } from "#coop/draggable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The chat box (D38) and the debug menu (D42) can be dragged around the screen, and stay where they were dropped */

const KEY = "testDragPos";

describe("Co-op: a box the player drags around the screen", () => {
  let root: HTMLElement;
  let handle: HTMLElement;
  let button: HTMLButtonElement;
  let drag: Draggable | null = null;
  /** Where the box is, as the page lays it out (jsdom lays out nothing) */
  let box = { left: 100, top: 50, width: 200, height: 120 };

  beforeEach(() => {
    localStorage.clear();
    window.innerWidth = 1000;
    window.innerHeight = 600;
    box = { left: 100, top: 50, width: 200, height: 120 };
    root = document.createElement("div");
    handle = document.createElement("div");
    button = document.createElement("button");
    handle.append(button);
    root.append(handle);
    document.body.append(root);
    vi.spyOn(root, "getBoundingClientRect").mockImplementation(
      () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top }) as DOMRect,
    );
  });

  afterEach(() => {
    drag?.destroy();
    drag = null;
    root.remove();
    localStorage.clear();
  });

  const pointer = (type: string, x: number, y: number, target: EventTarget = handle): void => {
    target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
  };

  /** Press on the handle at (x, y), move by (dx, dy), let go */
  const dragBy = (dx: number, dy: number, x = 150, y = 60): void => {
    pointer("pointerdown", x, y);
    pointer("pointermove", x + dx, y + dy);
    pointer("pointerup", x + dx, y + dy);
  };

  it("moves with the pointer, and the next page puts it where it was dropped", () => {
    drag = makeDraggable(root, [handle], KEY);
    dragBy(300, 200);
    expect([root.style.left, root.style.top]).toEqual(["400px", "250px"]);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ x: 400, y: 250 });

    drag.destroy();
    root.removeAttribute("style");
    drag = makeDraggable(root, [handle], KEY);
    expect([root.style.left, root.style.top]).toEqual(["400px", "250px"]);
    expect(root.classList.contains("coop-moved")).toBe(true);
  });

  it("measured from the right edge, it keeps its right edge (the chat box)", () => {
    drag = makeDraggable(root, [handle], KEY, "right");
    dragBy(-50, 10);
    // left 50 + width 200 = right edge at 250: 750 from the window's right edge
    expect([root.style.right, root.style.left, root.style.top]).toEqual(["750px", "auto", "60px"]);
  });

  it("stays inside the window, also when the window gets smaller", () => {
    drag = makeDraggable(root, [handle], KEY);
    dragBy(2000, 2000);
    expect([root.style.left, root.style.top]).toEqual(["800px", "480px"]);
    window.innerWidth = 500;
    window.dispatchEvent(new Event("resize"));
    expect(root.style.left).toBe("300px");
  });

  it("a press that hardly moves is a click; the click that ends a drag is not", () => {
    const clicks = vi.fn();
    handle.addEventListener("click", clicks);
    drag = makeDraggable(root, [handle], KEY);
    dragBy(2, 1);
    handle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(root.style.left).toBe("");

    dragBy(40, 0);
    handle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it("a press on a button inside the handle is that button's, not a drag", () => {
    drag = makeDraggable(root, [handle], KEY);
    pointer("pointerdown", 150, 60, button);
    pointer("pointermove", 300, 200, button);
    pointer("pointerup", 300, 200, button);
    expect(root.style.left).toBe("");
    expect(localStorage.getItem(KEY) ?? null).toBeNull();
  });

  it("a double click puts it back where it was at first", () => {
    drag = makeDraggable(root, [handle], KEY);
    dragBy(100, 100);
    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect([root.style.left, root.style.top]).toEqual(["", ""]);
    expect(localStorage.getItem(KEY) ?? null).toBeNull();
    expect(root.classList.contains("coop-moved")).toBe(false);
  });

  it("a damaged saved spot is ignored", () => {
    localStorage.setItem(KEY, "{not json");
    drag = makeDraggable(root, [handle], KEY);
    expect(root.style.left).toBe("");
    localStorage.setItem(KEY, JSON.stringify({ x: "1", y: 2 }));
    drag.destroy();
    drag = makeDraggable(root, [handle], KEY);
    expect(root.style.left).toBe("");
  });
});
