/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { ShotRun } from "./engine.ts";
import type { VariableName, Vars } from "./variables.ts";

export type Area = "Joining" | "Battle" | "Between waves" | "Run" | "Co-op" | "Encounters";

/**
 * One interaction `pnpm shot` can shoot. To add one: a `Scenario` in a file of `scenarios/`, listed in that file's export
 * (the catalog collects them).
 */
export interface Scenario {
  /** What is typed after `pnpm shot`: `area-word:name`, lowercase */
  id: string;
  area: Area;
  /** One line for `--list` */
  summary: string;
  /**
   * The variables it takes besides the common ones, each with the scenario's own default (`null`: the variable's). A
   * common variable listed here gets that default too.
   */
  vars?: Partial<Record<VariableName, string | number | null>>;
  /** With `--all`: run once for each value of this variable, until the scenario says there are no more */
  sweep?: VariableName;
  /** Bring the players there and shoot every step */
  play(run: ShotRun, vars: Vars): Promise<void>;
}

/** Thrown by a scenario run with `--all` for a value past the last (an encounter's fifth option): the sweep ends there */
export class NoSuchValue extends Error {}
