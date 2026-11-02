/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Seat } from "#coop/protocol";

/**
 * Each player's colour on the screens of a game of three (DECISIONS D40), the same everywhere: P1 (the host) yellow, P2
 * blue, P3 green. A game of two keeps its partner colour.
 * @module
 */

export const PLAYER_COLORS: Readonly<Record<Seat, number>> = { host: 0xf8d030, guest: 0x8fd3ff, guest2: 0x78c850 };

/** The darker shade under each colour, for the text shadow */
const PLAYER_SHADOWS: Readonly<Record<Seat, number>> = { host: 0x8a6d10, guest: 0x2f6a8f, guest2: 0x35662a };

/** `#rrggbb` */
function hex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

/** The player's colour as `#rrggbb` */
export function playerColorHex(seat: Seat): string {
  return hex(PLAYER_COLORS[seat]);
}

/** A name in its player's colour, for text that reads BBCode (the message box); brackets in the name are dropped */
export function coloredName(seat: Seat, name: string): string {
  const shown = name.replace(/[[\]]/g, "");
  return `[color=${hex(PLAYER_COLORS[seat])}][shadow=${hex(PLAYER_SHADOWS[seat])}]${shown}[/shadow][/color]`;
}
