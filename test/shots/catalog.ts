/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Scenario } from "./scenario.ts";
import { battleScenarios } from "./scenarios/battle.ts";
import { betweenWavesScenarios } from "./scenarios/between-waves.ts";
import { encounterScenarios } from "./scenarios/encounters.ts";
import { joiningScenarios } from "./scenarios/joining.ts";
import { runScenarios } from "./scenarios/run.ts";
import { togetherScenarios } from "./scenarios/together.ts";
import { COMMON, VARIABLES, type Variable, type VariableName } from "./variables.ts";

/** Every scenario of `pnpm shot`, in the order of a run: joining, battle, between waves, the run, co-op's own, the encounters */
export const CATALOG: readonly Scenario[] = [
  ...joiningScenarios,
  ...battleScenarios,
  ...betweenWavesScenarios,
  ...runScenarios,
  ...togetherScenarios,
  ...encounterScenarios,
];

/** The variables a scenario takes: the common ones and its own */
export function variablesOf(scenario: Scenario): VariableName[] {
  return [...new Set([...COMMON, ...(Object.keys(scenario.vars ?? {}) as VariableName[])])];
}

/** The scenario's own defaults (a `null` in `vars` keeps the variable's) */
export function defaultsOf(scenario: Scenario): Partial<Record<VariableName, string | number>> {
  return Object.fromEntries(Object.entries(scenario.vars ?? {}).filter(([, value]) => value !== null)) as Partial<
    Record<VariableName, string | number>
  >;
}

/**
 * The scenarios a name means: the one with that id, else those whose id ends with `*`'s prefix (`me:*`), else the one
 * whose id contains it (`breeder`)
 * @throws An `Error` with the ids that come close, if none or several do
 */
export function findScenarios(name: string): Scenario[] {
  const exact = CATALOG.find(scenario => scenario.id === name);
  if (exact !== undefined) {
    return [exact];
  }
  if (name.endsWith("*")) {
    const prefix = name.slice(0, -1);
    const all = CATALOG.filter(scenario => scenario.id.startsWith(prefix));
    if (all.length > 0) {
      return all;
    }
    throw new Error(`no scenario starts with "${prefix}"; see pnpm shot --list`);
  }
  const close = CATALOG.filter(scenario => scenario.id.includes(name));
  if (close.length === 1) {
    return close;
  }
  throw new Error(
    close.length === 0
      ? `no scenario "${name}"; see pnpm shot --list`
      : `"${name}" could be: ${close.map(scenario => scenario.id).join(", ")}`,
  );
}

/** A variable's values, as `--list` shows them */
function valuesOf(variable: Variable): string {
  switch (variable.kind) {
    case "choice":
      return variable.values.join("|");
    case "number":
      return `${variable.min}-${variable.max}`;
    case "text":
      return "text";
  }
}

/** `pnpm shot --list`: the scenarios by area, then the variables */
export function listing(): string {
  const lines: string[] = [];
  let area = "";
  for (const scenario of CATALOG) {
    if (scenario.area !== area) {
      area = scenario.area;
      lines.push("", area);
    }
    // its own variables, and the common ones it gives another default
    const defaults = defaultsOf(scenario);
    const shown = variablesOf(scenario).filter(name => !COMMON.includes(name) || name in defaults);
    const vars = shown.map(name => (name in defaults ? `--${name} ${defaults[name]}` : `--${name}`)).join(" ");
    lines.push(`  ${scenario.id.padEnd(34)} ${scenario.summary}${vars === "" ? "" : `  [${vars}]`}`);
  }
  lines.push("", `Variables (${COMMON.map(v => `--${v}`).join(" ")} go with every scenario):`);
  for (const [name, variable] of Object.entries(VARIABLES)) {
    const values = valuesOf(variable);
    lines.push(
      `  --${name.padEnd(8)} ${values.padEnd(22)} ${variable.describe} (default ${variable.default === "" ? "none" : variable.default})`,
    );
  }
  return lines.join("\n");
}
