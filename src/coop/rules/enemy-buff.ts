/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { getCoopSession } from "#coop/session";
import { type PermanentStat, Stat } from "#enums/stat";

/**
 * Enemies of a game of three (DECISIONS D40): three of ours fight two of theirs, so the enemies are made tougher, bosses
 * too, to play about as hard as a game of two. The same on every client: it depends only on the run's player count.
 * @module
 */

/** How much tougher each stat of an enemy is in a game of three; the others are unchanged */
const BUFF: Readonly<Partial<Record<PermanentStat, number>>> = {
  [Stat.HP]: 1.5,
  [Stat.ATK]: 1.15,
  [Stat.SPATK]: 1.15,
};

/**
 * @param enemy - Whether the Pokémon is an enemy
 * @param stat - The stat
 * @param value - The stat as calculated
 * @returns The stat of an enemy of a game of three; `value` for anyone else
 */
export function coopEnemyStat(enemy: boolean, stat: PermanentStat, value: number): number {
  const factor = BUFF[stat];
  if (!enemy || factor === undefined || getCoopSession()?.players !== 3) {
    return value;
  }
  return Math.floor(value * factor);
}
