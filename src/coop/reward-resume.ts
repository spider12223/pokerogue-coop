/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import type { RewardResume } from "#coop/save-block";
import type { ModifierTier } from "#enums/modifier-tier";
import type { CustomModifierSettings } from "#modifiers/modifier-type";

/**
 * The reward-screen save (DECISIONS D19): a linked run also saves when a reward screen opens, so a reload (a refresh, a
 * rejoin, a desync) brings both players back to that screen instead of to the start of the battle they already won. The
 * save says what comes after the screen, so the reload can queue it again.
 * @module
 */

/** The phases that may follow a reward screen and that the reload knows how to queue again: they take no arguments */
export const RESUMABLE_AFTER_REWARDS: ReadonlySet<string> = new Set(["SelectBiomePhase", "NewBattlePhase"]);

/**
 * The plan of a reload at this reward screen, or `null` when this screen cannot be rebuilt (a reward screen of a Mystery
 * Encounter, of other tiers, or followed by phases with arguments): a reload then goes back to the wave start, as before.
 * @param modifierTiers - The screen's own tiers, if it has any
 * @param settings - The screen's custom settings, if it has any
 */
export function rewardResumePlan(
  modifierTiers: readonly ModifierTier[] | undefined,
  settings: CustomModifierSettings | undefined,
): RewardResume | null {
  if (modifierTiers !== undefined) {
    return null;
  }
  const fixed = globalScene.gameMode.getFixedBattle(globalScene.currentBattle.waveIndex)?.customModifierRewardSettings;
  if (settings !== undefined && settings !== fixed) {
    return null;
  }
  const after = globalScene.phaseManager.queuedPhaseNames();
  if (!after.every(name => RESUMABLE_AFTER_REWARDS.has(name))) {
    return null;
  }
  return { at: "rewards", fixedSettings: settings !== undefined, after, turn: globalScene.currentBattle.turn };
}

/** Queue the reward screen of `resume` and what follows it, in place of the wave's encounter */
export function queueRewardResume(resume: RewardResume): void {
  const { phaseManager } = globalScene;
  globalScene.currentBattle.turn = resume.turn;
  const settings = resume.fixedSettings
    ? globalScene.gameMode.getFixedBattle(globalScene.currentBattle.waveIndex)?.customModifierRewardSettings
    : undefined;
  phaseManager.pushNew("SelectModifierPhase", 0, undefined, settings);
  for (const name of resume.after) {
    phaseManager.pushNew(name as "SelectBiomePhase" | "NewBattlePhase");
  }
}
