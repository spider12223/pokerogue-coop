/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { drawUniquePokemonId, MAX_ID_REDRAWS } from "#coop/pokemon-id";
import { describe, expect, it } from "vitest";

function sequence(values: number[]): { draw: () => number; drawn: () => number } {
  let next = 0;
  return { draw: () => values[next++]!, drawn: () => next };
}

describe("drawUniquePokemonId", () => {
  it("takes the first draw when it is free, consuming exactly one value", () => {
    const rng = sequence([5, 6, 7]);
    expect(drawUniquePokemonId(rng.draw, new Set([1, 2]))).toBe(5);
    expect(rng.drawn()).toBe(1);
  });

  it("redraws until the id is free, and does so identically on both clients", () => {
    const run = () => {
      const rng = sequence([10, 10, 20, 30]);
      const id = drawUniquePokemonId(rng.draw, new Set([10, 20]));
      return { id, drawn: rng.drawn() };
    };
    expect(run()).toEqual({ id: 30, drawn: 4 });
    expect(run()).toEqual(run());
  });

  it("gives up on a stuck stream instead of looping forever", () => {
    expect(() => drawUniquePokemonId(() => 1, new Set([1]))).toThrow(`after ${MAX_ID_REDRAWS} redraws`);
  });
});
