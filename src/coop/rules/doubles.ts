/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { TrainerType } from "#enums/trainer-type";
import { TrainerVariant } from "#enums/trainer-variant";
import { Trainer } from "#field/trainer";

/**
 * Forced doubles (DECISIONS D6): every co-op battle is a double. A trainer uses its `DOUBLE` variant where its config has
 * one; a trainer without one fights as it is, and the engine sends out its first two Pokémon (a trainer with a single
 * Pokémon is two of ours against one of it).
 *
 * @module
 */

/**
 * Whether a trainer of this type has a double variant that a random trainer battle uses: a generic one (Ace Trainer, a
 * grunt, ...), a double-only pair, or Tate & Liza. The other named pairs (Red & Blue, ...) exist only as the partner of a
 * pair that no wave generates, and fight as a single trainer.
 */
export function hasUsableDoubleVariant(trainer: Trainer): boolean {
  const { config } = trainer;
  if (config.doubleOnly) {
    return true;
  }
  if (!config.hasDouble) {
    return false;
  }
  return (
    !config.trainerTypeDouble
    || trainer.config.trainerType === TrainerType.TATE
    || trainer.config.trainerType === TrainerType.LIZA
  );
}

/**
 * A fixed battle builds its trainer with an explicit variant. In co-op a trainer that has a double variant gets it.
 * @returns The trainer itself, or a new one of the same type with the `DOUBLE` variant (the given one is destroyed)
 */
export function withCoopDoubleVariant(trainer: Trainer): Trainer {
  if (trainer.variant === TrainerVariant.DOUBLE || trainer.config.doubleOnly || !hasUsableDoubleVariant(trainer)) {
    return trainer;
  }
  const double = new Trainer(trainer.config.trainerType, TrainerVariant.DOUBLE);
  trainer.destroy();
  return double;
}
