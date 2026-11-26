import type { PointerHitAreaManager, PointerRowHitAreaConfig } from "#ui/pointer-hit-areas";

/** A pointer hit area with an `id` that tells two areas of the same size apart (what the area does). */
export interface KeyedPointerRow extends PointerRowHitAreaConfig {
  id: string;
}

/** An axis-aligned box, in the coordinates of the container its object belongs to. */
export interface PointerBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Wraps a {@linkcode PointerHitAreaManager} so that its rows are only rebuilt when their geometry or meaning changed.
 * Handlers refresh their hit areas after every cursor move; skipping identical rebuilds avoids destroying the very
 * rectangle that is dispatching a pointer event and keeps the work per input small.
 */
export class SyncedPointerHitAreas {
  public readonly manager: PointerHitAreaManager;
  private signature = "";

  constructor(manager: PointerHitAreaManager) {
    this.manager = manager;
  }

  /**
   * Replace the rows, unless they are the same as the ones set last time.
   * @param rows - The hit areas to show; `id` must change whenever what the area does changes
   * @returns Whether the rows were rebuilt
   */
  public set(rows: KeyedPointerRow[]): boolean {
    const signature = JSON.stringify(rows.map(r => [r.id, r.x, r.y, r.width, r.height]));
    if (signature === this.signature) {
      return false;
    }
    this.signature = signature;
    this.manager.setRows(rows);
    return true;
  }

  /** Remove the rows (the next {@linkcode set} rebuilds them). */
  public clearRows(): void {
    this.signature = "";
    this.manager.clearRows();
  }

  /** Remove everything the manager made: rows, outside zone and wheel handler. */
  public clear(): void {
    this.signature = "";
    this.manager.clear();
  }
}

/**
 * The box a display object covers, in the coordinates of its parent container (respects scale and origin).
 * @param obj - The sprite, text or similar object
 */
export function getDisplayBounds(obj: {
  x: number;
  y: number;
  displayWidth: number;
  displayHeight: number;
  displayOriginX?: number;
  displayOriginY?: number;
  frame?: unknown;
}): PointerBounds {
  // A sprite whose texture is not loaded has no frame, and reading its display size throws
  if (obj.frame === null) {
    return { x: obj.x, y: obj.y, width: 0, height: 0 };
  }
  return {
    x: obj.x - (obj.displayOriginX ?? 0),
    y: obj.y - (obj.displayOriginY ?? 0),
    width: obj.displayWidth,
    height: obj.displayHeight,
  };
}

/**
 * The smallest box that covers all the given boxes.
 * @param boxes - At least one box
 */
export function unionBounds(...boxes: PointerBounds[]): PointerBounds {
  const left = Math.min(...boxes.map(b => b.x));
  const top = Math.min(...boxes.map(b => b.y));
  const right = Math.max(...boxes.map(b => b.x + b.width));
  const bottom = Math.max(...boxes.map(b => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
