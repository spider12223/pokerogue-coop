/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { TextStyle } from "#enums/text-style";
import type { Pokemon } from "#field/pokemon";
import { addTextObject } from "#ui/text";

/**
 * How the cosmetic channel draws on the field (D16): small framed tags in the colours of the game's windows, and a
 * pointer over a target's head. The battle font has no check mark or arrow (the browser drew them in another font), so the icons
 * are drawn here, pixel by pixel. Everything goes into the field's UI layer (`globalScene.fieldUI`), in the canvas's units;
 * `y` is a field `y` (the layer sits one canvas height lower).
 *
 * @module
 */

/** The colours of the co-op marks */
export const MARK_COLORS = {
  /** Whatever is the partner's (the party screen names their Pokémon in it too) */
  partner: 0x8fd3ff,
  partnerText: "#8fd3ff",
  /** A command that is locked in */
  ready: 0x55ee77,
  readyText: "#55ee77",
  /** This player's own bubbles */
  own: 0xf8f8f8,
  text: "#f8f8f8",
  /** The tag's body and edge: the game's window colours */
  body: 0x2a2838,
  edge: 0x6b5a73,
  shadow: 0x101018,
} as const;

/** A pixel icon of a tag */
export type MarkIcon = "check" | "arrow" | "dots" | "bang";

/** One piece of a tag, left to right */
export type TagPiece =
  | { text: string; color: string }
  | { icon: MarkIcon; color: number }
  /** A small square in a colour: the type of a move */
  | { chip: number };

export interface TagOptions {
  /** The bar on the left: whose it is, or whether it is locked in */
  accent: number;
  /** Lighter: not decided yet */
  dim?: boolean;
  /** A notch under the tag, pointing down at what it is about */
  tail?: boolean;
}

/** The icons, as rows of pixels (`#` on, `.` off), all five high */
export const MARK_ICONS: Record<MarkIcon, readonly string[]> = {
  check: [".....##", "....##.", "##.##..", ".###...", "..#...."],
  arrow: ["...#.", "....#", "#####", "....#", "...#."],
  dots: [".....", ".....", ".....", ".....", "#.#.#"],
  bang: ["#", "#", "#", ".", "#"],
};

/** The tag's height, its padding on each side, and the space between pieces */
const HEIGHT = 11;
const PAD = 3;
const GAP = 2;
const ACCENT = 2;
const TAIL = 2;
/** The font size of a tag's text (the battle info font, a little smaller) */
const FONT_SIZE = "64px";

/**
 * A tag whose bottom centre (the tip of its notch, with one) is at field position (x, y), kept on the screen.
 * @returns The tag; destroying it takes everything it drew
 */
export function addTag(
  x: number,
  y: number,
  pieces: readonly TagPiece[],
  options: TagOptions,
): Phaser.GameObjects.Container {
  const tag = globalScene.add.container(0, 0);
  const graphics = globalScene.add.graphics();
  tag.add(graphics);

  // Lay the pieces out from the left edge, then centre the whole
  const placed: { piece: TagPiece; left: number; text?: Phaser.GameObjects.Text }[] = [];
  let width = ACCENT + PAD;
  for (const piece of pieces) {
    if ("text" in piece) {
      const text = addTextObject(0, 0, piece.text, TextStyle.BATTLE_INFO, { color: piece.color, fontSize: FONT_SIZE });
      text.setOrigin(0, 0.5);
      tag.add(text);
      placed.push({ piece, left: width, text });
      width += textWidth(text, piece.text) + GAP;
    } else if ("icon" in piece) {
      placed.push({ piece, left: width });
      width += MARK_ICONS[piece.icon][0].length + GAP;
    } else {
      placed.push({ piece, left: width });
      width += 4 + GAP;
    }
  }
  width += PAD - GAP;

  const left = -Math.round(width / 2);
  const top = -HEIGHT - (options.tail ? TAIL : 0);
  // a shadow, the edge, the body, the bar of its owner
  graphics.fillStyle(MARK_COLORS.shadow, 0.5);
  graphics.fillRect(left, top + 1, width + 1, HEIGHT + 1);
  graphics.fillStyle(MARK_COLORS.edge, 1);
  graphics.fillRect(left - 1, top - 1, width + 2, HEIGHT + 2);
  graphics.fillStyle(MARK_COLORS.body, 0.94);
  graphics.fillRect(left, top, width, HEIGHT);
  graphics.fillStyle(options.accent, 1);
  graphics.fillRect(left, top, ACCENT, HEIGHT);
  if (options.tail) {
    // a notch of two steps under the middle
    graphics.fillStyle(MARK_COLORS.edge, 1);
    graphics.fillRect(-2, top + HEIGHT + 1, 5, 1);
    graphics.fillRect(-1, top + HEIGHT + 2, 3, 1);
    graphics.fillStyle(MARK_COLORS.body, 0.94);
    graphics.fillRect(-1, top + HEIGHT, 3, 1);
    graphics.fillRect(0, top + HEIGHT + 1, 1, 1);
  }

  const middle = top + HEIGHT / 2;
  for (const { piece, left: offset, text } of placed) {
    const at = left + offset;
    if (text !== undefined) {
      // the font sits a little high in its line
      text.setPosition(at, middle + 0.5);
    } else if ("icon" in piece) {
      drawPixels(graphics, MARK_ICONS[piece.icon], at, Math.round(middle - 2.5), piece.color);
    } else if ("chip" in piece) {
      graphics.fillStyle(MARK_COLORS.shadow, 1);
      graphics.fillRect(at, Math.round(middle - 2), 4, 4);
      graphics.fillStyle(piece.chip, 1);
      graphics.fillRect(at, Math.round(middle - 2), 3, 3);
    }
  }

  // on the screen, whatever the battler's place
  const screenWidth = globalScene.scaledCanvas.width;
  const half = width / 2 + 1;
  tag.setPosition(
    Math.min(Math.max(x, half + 1), screenWidth - half - 1),
    Math.max(y, -top + 2) - globalScene.scaledCanvas.height,
  );
  tag.setAlpha(options.dim ? 0.82 : 1);
  globalScene.fieldUI.add(tag);
  return tag;
}

/** The pointer over a target: a triangle pointing down */
const POINTER = ["#########", ".#######.", "..#####..", "...###...", "....#...."];

/**
 * A pointer over a battler's head, in a colour, with a dark outline (it reads on a light sprite and on the sky). Only the
 * top of the battler is used: below its feet, a sprite's frame has room that the info bars cover.
 * @param bob - It moves up and down a little: the target is not locked in yet. The caller stops it
 * (`globalScene.tweens.killTweensOf`) before it destroys the pointer.
 */
export function addTargetPointer(pokemon: Pokemon, color: number, bob = false): Phaser.GameObjects.Container {
  const pointer = globalScene.add.container(0, 0);
  const graphics = globalScene.add.graphics();
  pointer.add(graphics);
  const width = POINTER[0].length;
  const left = -Math.floor(width / 2);
  const top = -POINTER.length;
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]) {
    drawPixels(graphics, POINTER, left + dx, top + dy, MARK_COLORS.shadow);
  }
  drawPixels(graphics, POINTER, left, top, color);
  pointer.setPosition(Math.round(pokemon.x), battlerBox(pokemon).top - 3 - globalScene.scaledCanvas.height);
  globalScene.fieldUI.add(pointer);
  if (bob) {
    globalScene.tweens.add({ targets: pointer, y: pointer.y - 2, duration: 420, yoyo: true, repeat: -1 });
  }
  return pointer;
}

/**
 * Where a battler is drawn, in field units: its sprite's frame, trimmed to the part a Pokémon fills (the frames have room
 * around the Pokémon). Without a sprite (a test scene), a box of the usual size.
 */
export function battlerBox(pokemon: Pokemon): { left: number; right: number; top: number; bottom: number } {
  const sprite = pokemon.getSprite?.() as Phaser.GameObjects.Sprite | undefined;
  const scale = Math.abs(pokemon.scale || 1);
  const frameWidth = (Number.isFinite(sprite?.displayWidth) && sprite?.displayWidth ? sprite.displayWidth : 48) * scale;
  const frameHeight =
    (Number.isFinite(sprite?.displayHeight) && sprite?.displayHeight ? sprite.displayHeight : 48) * scale;
  const width = Math.round(frameWidth * 0.7);
  const height = Math.round(frameHeight * 0.8);
  const x = Math.round(pokemon.x);
  const bottom = Math.round(pokemon.y);
  return { left: x - Math.round(width / 2), right: x + Math.round(width / 2), top: bottom - height, bottom };
}

/** A text's width in canvas units; the test scene's texts have none, so it is guessed from the length */
function textWidth(text: Phaser.GameObjects.Text, content: string): number {
  const width = text.displayWidth;
  return Number.isFinite(width) && width > 0 ? Math.ceil(width) : content.length * 5;
}

/** Draw an icon given as rows of pixels (`#` on, `.` off), its top left at (left, top), in the units of `graphics` */
export function drawPixels(
  graphics: Phaser.GameObjects.Graphics,
  rows: readonly string[],
  left: number,
  top: number,
  color: number,
): void {
  graphics.fillStyle(color, 1);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === "#") {
        graphics.fillRect(left + x, top + y, 1, 1);
      }
    }
  });
}
