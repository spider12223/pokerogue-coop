import type { PointerRowHitAreaConfig } from "#ui/pointer-hit-areas";
import type { TabMenu } from "#ui/tab-menu";
import Phaser from "phaser";

/** A drawn object whose on-screen box can be read (text, sprite, window, ...) */
interface DrawnObject {
  x: number;
  y: number;
  displayWidth: number;
  displayHeight: number;
  originX: number;
  originY: number;
}

export interface LocalBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The box enclosing the given objects, in the coordinates of their (shared) parent container.
 * @param objects - Objects drawn in the same container
 */
export function getLocalBounds(...objects: DrawnObject[]): LocalBounds {
  const bounds: LocalBounds = {
    left: Number.POSITIVE_INFINITY,
    top: Number.POSITIVE_INFINITY,
    right: Number.NEGATIVE_INFINITY,
    bottom: Number.NEGATIVE_INFINITY,
  };
  for (const obj of objects) {
    const width = obj.displayWidth ?? 0;
    const height = obj.displayHeight ?? 0;
    const left = (obj.x ?? 0) - width * (obj.originX ?? 0);
    const top = (obj.y ?? 0) - height * (obj.originY ?? 0);
    bounds.left = Math.min(bounds.left, left);
    bounds.top = Math.min(bounds.top, top);
    bounds.right = Math.max(bounds.right, left + width);
    bounds.bottom = Math.max(bounds.bottom, top + height);
  }
  return bounds;
}

/**
 * Hit areas over a settings {@linkcode TabMenu}: one per tab title (split halfway between neighbouring titles), plus the
 * previous / next tab icons drawn at both ends of the bar. Coordinates are relative to the tab menu's parent container.
 * @param tabMenu - The tab bar
 * @param onSelectTab - Called with the index of the clicked tab
 * @param onPreviousTab - Called when the "previous tab" icon is clicked
 * @param onNextTab - Called when the "next tab" icon is clicked
 */
export function getTabMenuHitAreas(
  tabMenu: TabMenu,
  onSelectTab: (index: number) => void,
  onPreviousTab: () => void,
  onNextTab: () => void,
): PointerRowHitAreaConfig[] {
  // The tab menu's titles are its only texts, in tab order; its only sprites are the previous then next tab icons
  const titles = tabMenu.list.filter((obj): obj is Phaser.GameObjects.Text => obj instanceof Phaser.GameObjects.Text);
  const icons = tabMenu.list.filter(
    (obj): obj is Phaser.GameObjects.Sprite => obj instanceof Phaser.GameObjects.Sprite,
  );
  const configs: PointerRowHitAreaConfig[] = [];
  const height = tabMenu.height;

  const titleBounds = titles.map(title => getLocalBounds(title));
  titleBounds.forEach((bounds, index) => {
    const left = index === 0 ? bounds.left - 2 : (titleBounds[index - 1].right + bounds.left) / 2;
    const right =
      index === titleBounds.length - 1 ? bounds.right + 2 : (bounds.right + titleBounds[index + 1].left) / 2;
    configs.push({
      x: tabMenu.x + left,
      y: tabMenu.y,
      width: right - left,
      height,
      onActivate: () => onSelectTab(index),
    });
  });

  const iconHandlers = [onPreviousTab, onNextTab];
  icons.slice(0, iconHandlers.length).forEach((icon, index) => {
    if (!icon.visible || icon.alpha === 0) {
      return;
    }
    const bounds = getLocalBounds(icon);
    configs.push({
      x: tabMenu.x + bounds.left - 2,
      y: tabMenu.y,
      width: bounds.right - bounds.left + 4,
      height,
      onActivate: iconHandlers[index],
    });
  });

  return configs;
}

/**
 * Hit areas over the values drawn on one settings row, each widened halfway towards its neighbours so that the whole
 * stretch between the first and last value is clickable.
 * @param values - The value labels of the row, left to right, in the same container
 * @param offsetX - X offset from the values' container to the hit areas' container
 * @param y - Top of the row, in the hit areas' container
 * @param height - Height of the row
 * @param callbacks - Hover and activate callbacks, given the value's index
 */
export function getRowValueHitAreas(
  values: readonly DrawnObject[],
  offsetX: number,
  y: number,
  height: number,
  callbacks: { onHover: () => void; onActivate: (valueIndex: number) => void },
): PointerRowHitAreaConfig[] {
  const valueBounds = values.map(value => getLocalBounds(value));
  return valueBounds.map((bounds, index) => {
    const left = index === 0 ? bounds.left - 2 : (valueBounds[index - 1].right + bounds.left) / 2;
    const right =
      index === valueBounds.length - 1 ? bounds.right + 2 : (bounds.right + valueBounds[index + 1].left) / 2;
    return {
      x: offsetX + left,
      y,
      width: right - left,
      height,
      onHover: callbacks.onHover,
      onActivate: () => callbacks.onActivate(index),
    };
  });
}
