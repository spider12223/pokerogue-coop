/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { PLAYER_COLORS } from "#coop/player-colors";
import type { Seat } from "#coop/protocol";
import { getCoopSession } from "#coop/session";
import { TextStyle } from "#enums/text-style";
import type { Pokemon } from "#field/pokemon";
import { addTextObject } from "#ui/text";

/**
 * The HP of a battle of three of ours (DECISIONS D40), as each client draws it for its own player: its own Pokémon has the
 * full box where a single battle has it; each teammate's Pokémon has a small bar over it, with its player's name in their
 * colour. Display only: nothing here is simulation, so the clients still agree on everything.
 * @module
 */

/** The bar's size, in field pixels */
const BAR_WIDTH = 30;
const BAR_HEIGHT = 6;
/** How far above the top of the sprite the bar sits */
const BAR_GAP = 3;
/** The fill colours, as the HP bar's frames have them */
const HIGH = 0x58d080;
const MEDIUM = 0xf8c838;
const LOW = 0xf85838;

/** Whether `pokemon` is one of ours in a battle of three */
export function inBattleOfThree(pokemon: Pokemon): boolean {
  return pokemon.isPlayer() && globalScene.currentBattle?.playerSlots === 3;
}

/**
 * Whether this client shows the full box of `pokemon`, one of ours in a battle of three: the first of this player's own
 * Pokémon on the field. Any other (a teammate's, or a second one of this player's that fills a teammate's slot) has a bar.
 */
export function showsOwnBox(pokemon: Pokemon): boolean {
  const session = getCoopSession();
  if (session === null) {
    return true;
  }
  const mine = globalScene.getPlayerField().find(other => session.ownership.get(other.id) === session.seat);
  return mine === pokemon;
}

class TeammateBar extends Phaser.GameObjects.Container {
  private readonly nameText: Phaser.GameObjects.Text;
  private readonly frame: Phaser.GameObjects.Rectangle;
  private readonly fill: Phaser.GameObjects.Rectangle;

  constructor(seat: Seat, name: string) {
    super(globalScene, 0, 0);
    const color = PLAYER_COLORS[seat];
    this.nameText = addTextObject(0, -BAR_HEIGHT - 1, name, TextStyle.BATTLE_INFO, { fontSize: "40px" })
      .setOrigin(0.5, 1)
      .setColor(`#${color.toString(16).padStart(6, "0")}`);
    this.frame = globalScene.add
      .rectangle(0, 0, BAR_WIDTH, BAR_HEIGHT, 0x303030)
      .setOrigin(0.5, 1)
      .setStrokeStyle(1, color);
    this.fill = globalScene.add.rectangle(-BAR_WIDTH / 2 + 1, -1, BAR_WIDTH - 2, BAR_HEIGHT - 2, HIGH).setOrigin(0, 1);
    this.add([this.frame, this.fill, this.nameText]);
  }

  setRatio(ratio: number): void {
    const clamped = Math.max(0, Math.min(1, ratio));
    this.fill.width = Math.max(0, Math.round((BAR_WIDTH - 2) * clamped));
    this.fill.setFillStyle(clamped > 0.5 ? HIGH : clamped > 0.25 ? MEDIUM : LOW);
  }
}

const bars = new Map<number, { pokemon: Pokemon; bar: TeammateBar }>();
let following = false;

/** Keep every bar over its Pokémon, as the Pokémon moves (summons, switches, the field's zoom) */
function follow(): void {
  for (const [id, { pokemon, bar }] of bars) {
    if (!bar.active) {
      bars.delete(id);
      continue;
    }
    const sprite = pokemon.getSprite();
    const top = sprite ? sprite.displayHeight * pokemon.scaleY : 48;
    bar.setPosition(pokemon.x, pokemon.y - Math.min(top, 80) - BAR_GAP);
    bar.setVisible(pokemon.visible && pokemon.isOnField() && !pokemon.isFainted());
  }
  if (bars.size === 0 && following) {
    globalScene.events.off("update", follow);
    following = false;
  }
}

/** Show the bar over a teammate's Pokémon (its info box stays hidden on this client) */
export function showTeammateBar(pokemon: Pokemon): void {
  const session = getCoopSession();
  const owner = session?.ownership.get(pokemon.id);
  if (session === null || owner === undefined) {
    return;
  }
  let entry = bars.get(pokemon.id);
  if (entry === undefined || !entry.bar.active) {
    const bar = new TeammateBar(owner, session.names[owner] ?? "");
    globalScene.field.add(bar);
    entry = { pokemon, bar };
    bars.set(pokemon.id, entry);
  }
  globalScene.field.bringToTop(entry.bar);
  entry.bar.setRatio(pokemon.getHpRatio(true));
  if (!following) {
    globalScene.events.on("update", follow);
    following = true;
  }
  follow();
}

/** The Pokémon's HP changed: its bar follows */
export function updateTeammateBar(pokemon: Pokemon): void {
  bars.get(pokemon.id)?.bar.setRatio(pokemon.getHpRatio(true));
}

/** The Pokémon left the field: no bar over its place */
export function hideTeammateBar(pokemon: Pokemon): void {
  const entry = bars.get(pokemon.id);
  if (entry !== undefined) {
    entry.bar.destroy();
    bars.delete(pokemon.id);
  }
}

/** Where an enemy's box stands in a battle of three of ours: 5/6 of its size, higher up, the second under the first */
const ENEMY_BOXES: readonly [number, number][] = [
  [120, -151],
  [110, -132],
];

/**
 * An enemy's box in a battle of three of ours: smaller and higher, so the boxes stay clear of our three. Set before the box
 * slides in (a boss's box slides 48 further).
 */
export function placeEnemyBoxForThree(pokemon: Pokemon): void {
  if (pokemon.isPlayer() || globalScene.currentBattle?.playerSlots !== 3 || pokemon.getBattleInfo().visible) {
    return;
  }
  const [x, y] = ENEMY_BOXES[pokemon.getFieldIndex() === 1 ? 1 : 0];
  const info = pokemon.getBattleInfo();
  info.setScale(5 / 6);
  info.placeAt(x - (pokemon.isBoss() ? 48 : 0), y);
}
