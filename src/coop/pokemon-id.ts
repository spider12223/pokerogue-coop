/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * `pokemon.id` is a 32-bit draw from the seeded stream with no uniqueness check upstream. Co-op keys
 * decisions and ownership by `pokemon.id` (D2, D7), so two Pokémon with one id would be a desync waiting to happen.
 * The draw is repeated until the id is free. The repeat is deterministic: both clients draw from the same state
 * against the same set of taken ids, so they end on the same id and the same stream position.
 */
export const MAX_ID_REDRAWS = 64;

/**
 * @param draw - Draws the next candidate id (from the seeded stream)
 * @param taken - Ids that are in use
 * @returns A candidate that is not in `taken`
 * @throws If no free id was found in {@linkcode MAX_ID_REDRAWS} redraws (a stuck stream, not bad luck)
 */
export function drawUniquePokemonId(draw: () => number, taken: ReadonlySet<number>): number {
  let id = draw();
  for (let redraws = 0; taken.has(id); redraws++) {
    if (redraws >= MAX_ID_REDRAWS) {
      throw new Error(`No free pokemon.id after ${MAX_ID_REDRAWS} redraws`);
    }
    id = draw();
  }
  return id;
}
