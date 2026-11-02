/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createCoopGameMode, type GameMode } from "#app/game-mode";
import { globalScene } from "#app/global-scene";
import type { CoopChallenge } from "#coop/protocol";
import { GameModes } from "#enums/game-modes";
import { UiMode } from "#enums/ui-mode";

/**
 * The challenge screen, opened by co-op's Host a game for a challenge run (DECISIONS D41): the solo screen, except that its
 * Start hands the challenges to co-op, which hosts the game with them, and its Cancel goes back to the mode question.
 * @module
 */

interface CoopChallengePick {
  start(challenges: CoopChallenge[]): void;
  cancel(): void;
}

let pick: CoopChallengePick | null = null;

/** The challenges that are on in a game mode, as they go over the wire (D41) */
export function challengesOn(mode: GameMode = globalScene.gameMode): CoopChallenge[] {
  return mode.challenges
    .filter(challenge => challenge.value !== 0)
    .map(({ id, value, severity }) => ({ id, value, severity }));
}

/** Open the challenge screen on a co-op challenge run's game mode, whose challenges the host sets there */
export function openCoopChallengePick(start: (challenges: CoopChallenge[]) => void, cancel: () => void): void {
  globalScene.gameMode = createCoopGameMode(GameModes.CHALLENGE);
  pick = { start, cancel };
  globalScene.ui.setMode(UiMode.CHALLENGE_SELECT);
}

/**
 * For the challenge screen: the co-op pick it shows, if it shows one. Taking it ends it.
 * @returns Start (with the challenges that are on now) and Cancel, or `null` on the solo screen
 */
export function takeCoopChallengePick(): { start(): void; cancel(): void } | null {
  const taken = pick;
  pick = null;
  if (taken === null) {
    return null;
  }
  return {
    start: () => taken.start(challengesOn()),
    cancel: () => taken.cancel(),
  };
}
