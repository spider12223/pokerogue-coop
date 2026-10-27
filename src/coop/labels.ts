/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * The words of the co-op rows that sit in upstream's screens (the stats, the run history). The locales are upstream's and have no
 * translation for them yet, so they say what they are in English (a leaf: the screens read it).
 *
 * @module
 */

/**
 * @param labelKey - The key of a row of the stats screen in `gameStatsUiHandler:`
 * @returns The options of `i18next.t` for it
 */
export function coopStatLabel(labelKey: string | undefined): { defaultValue: string } | Record<string, never> {
  return labelKey === "coopWins" ? { defaultValue: "Co-op Clears" } : {};
}

/** The names of the two players of a co-op run, as the run history shows them: "Sam & Alex", cut to fit a line of the list */
export function coopRunNames(names: { host: string; guest: string }, maxLength = 24): string {
  const text = `${names.host} & ${names.guest}`;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
