/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * The patch notes (D50): what each update of the co-op site brought, newest first, in words a player reads. Every update
 * adds its entry at the top before it ships: what is new, what works differently, and what got fixed (bug fixes too).
 * @module
 */

/** One update */
export interface PatchNote {
  /** The day it went out, `YYYY-MM-DD` */
  date: string;
  /** What players can do that they could not before */
  new?: readonly string[];
  /** What works differently */
  changed?: readonly string[];
  /** What was broken and is not any more */
  fixed?: readonly string[];
}

export const PATCH_NOTES: readonly PatchNote[] = [
  {
    date: "2026-11-28",
    new: [
      "Click & Tap Controls (Settings > General): play with the mouse or by tapping. Point at an option to pick it, click to choose, right click to go back, hold to open the menu or to see a Pokémon's stats on its HP box, and scroll long lists with the wheel.",
      "Mouse Highlight: how the option under the mouse is marked. Corners (the default), Long, Pulse, Classic, Glow or Bar.",
      "Mouse Cursor: the game's own pointer, on the whole page: an arrow, a Poké Ball or a glove. System brings back your computer's.",
      "Patch Notes: this list. Every update adds what is new and what got fixed.",
    ],
    fixed: ["Patch Notes no longer covers the Source link at the bottom left of the title screen."],
  },
  {
    date: "2026-11-27",
    new: [
      "Trade Evolutions (Settings > Co-op, off by default, the host's choice): a Pokémon that evolves by trading, such as Kadabra, Machoke, Graveler or Haunter, evolves when you trade it to your partner. Those that need a held item still evolve with their item.",
    ],
  },
  {
    date: "2026-11-24",
    fixed: ["The game installed as an app (Install or Add to Home Screen) opens the game instead of another page."],
  },
  {
    date: "2026-11-23",
    changed: ["Updated to PokéRogue 1.12.2.8."],
    fixed: ["Importing a save made on a newer version of PokéRogue now says that it can still be imported."],
  },
  {
    date: "2026-11-22",
    fixed: [
      "After eggs hatch in co-op, the game waits until everyone has closed their egg summary, and shows who is still looking.",
    ],
  },
  {
    date: "2026-11-20",
    fixed: ["After a co-op challenge run is won, the voucher messages show on screen instead of over a black screen."],
  },
  {
    date: "2026-11-13",
    new: [
      "A Co-op tab in the settings: choose what you see of co-op, such as your partner's move tags, target pointers, and ping and emote bubbles.",
      "Two tabs of the same browser are told that they share one save.",
    ],
    changed: ["Updated to PokéRogue 1.12.2.7.", "The offer to back up your save comes less often."],
    fixed: ["Going back to the title screen from the starter select no longer leaves parts of it on screen."],
  },
];
