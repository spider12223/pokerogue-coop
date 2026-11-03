/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { DebugAction } from "#coop/debug/actions";
import type { ItemFamily } from "#coop/debug/catalog";
import { debugChanges, queueDebugChange } from "#coop/debug/queue";

/**
 * What the host's debug window (DECISIONS D42) is showing, shared by its parts: the section, the Pokémon edited, the item
 * group open in the catalog; and the changes made from it.
 * @module
 */

export type SectionId = "pokemon" | "enemies" | "waves" | "rewards" | "modes";

export const SECTIONS: readonly SectionId[] = ["pokemon", "enemies", "waves", "rewards", "modes"];

export const view = {
  section: "pokemon" as SectionId,
  /** The Pokémon of the party being edited */
  selected: null as number | null,
  /** What the search box finds, across every section */
  search: "",
  /** The group of items open in the catalog */
  family: "forms" as ItemFamily,
  /** What the catalog's own search box finds */
  itemSearch: "",
  /** The wave being planned (0: the next one) */
  planWave: 0,
};

let redrawMain: () => void = () => {};

/** The window says how it is drawn again */
export function onRedraw(draw: () => void): void {
  redrawMain = draw;
}

/** Draw the section again (a list changed, a Pokémon was picked) */
export function redraw(): void {
  redrawMain();
}

/** Make a change from the window: it waits for the next turn, and replaces a pending one with the same key */
export function change(note: string, key: string | null, ...actions: DebugAction[]): void {
  queueDebugChange(note, key, ...actions);
}

/** @returns The newest pending action with this key, if any: what a field will be once the turn comes */
export function pendingAction(key: string): DebugAction | null {
  const changes = debugChanges();
  for (let index = changes.length - 1; index >= 0; index--) {
    const entry = changes[index];
    if (entry.state === "pending" && entry.key === key) {
      return entry.actions.at(-1) ?? null;
    }
  }
  return null;
}

/** @returns Whether a change with this key waits */
export function isPending(key: string): boolean {
  return pendingAction(key) !== null;
}
