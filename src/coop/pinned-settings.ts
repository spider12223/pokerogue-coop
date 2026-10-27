/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { SettingsOverlayPort } from "#coop/handshake";
import { hashCanonical, type PinnedSettings } from "#coop/protocol";
import { BattleStyle } from "#enums/battle-style";
import { ExpNotification } from "#enums/exp-notification";
import type { PlayerGender } from "#enums/player-gender";
import type { GeneralSettings } from "#types/settings";

/**
 * The settings that change the phase flow of the simulation and are therefore pinned in co-op (DECISIONS D5).
 * Everything else (game speed, animations, cosmetics) stays local.
 */
export const PINNED_SETTING_KEYS = [
  "battleStyle",
  "enableTutorials",
  "skipSeenDialogues",
  "levelMoveConfirmation",
  "enableRetries",
  "playerGender",
  "manualMessageClear",
  "partyExpNotificationMode",
] as const satisfies readonly (keyof GeneralSettings)[];

export type PinnedSettingKey = (typeof PINNED_SETTING_KEYS)[number];

/** The D5 values. `playerGender` is the host's, so it is not part of the fixed set. */
export const COOP_FIXED_SETTINGS = {
  battleStyle: BattleStyle.SET,
  enableTutorials: false,
  skipSeenDialogues: false,
  levelMoveConfirmation: true,
  enableRetries: false,
  manualMessageClear: false,
  partyExpNotificationMode: ExpNotification.SKIP,
} as const satisfies Pick<GeneralSettings, Exclude<PinnedSettingKey, "playerGender">>;

/** @returns The settings the host pins: the D5 values plus the host's own player gender */
export function buildPinnedSettings(hostPlayerGender: PlayerGender): PinnedSettings {
  return { ...COOP_FIXED_SETTINGS, playerGender: hostPlayerGender };
}

const KEY_SET: ReadonlySet<string> = new Set(PINNED_SETTING_KEYS);

/**
 * Check what a peer sent as pinned settings: exactly the pinned keys, plain values of the right type.
 * @throws If the keys are not exactly {@linkcode PINNED_SETTING_KEYS}, or a value is not a number or boolean
 */
export function assertPinnedSettings(
  pinned: PinnedSettings,
): asserts pinned is Pick<GeneralSettings, PinnedSettingKey> {
  const keys = Object.keys(pinned);
  for (const key of keys) {
    if (!KEY_SET.has(key)) {
      throw new Error(`Unknown pinned setting: ${key}`);
    }
  }
  for (const key of PINNED_SETTING_KEYS) {
    const value = pinned[key];
    if (typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`Pinned setting ${key} is missing or not a number or boolean`);
    }
  }
}

/** The part of `SettingsManager` the co-op overlay needs; the global `settings` satisfies it. */
export interface OverlayCapableSettings {
  readonly general: Readonly<GeneralSettings>;
  applyOverlay(overlay: Partial<GeneralSettings>): void;
  removeOverlay(): void;
}

/** @returns The pinned subset of `general` as currently in effect (what {@linkcode hashCanonical} is taken of) */
export function readPinnedSettings(settings: OverlayCapableSettings): PinnedSettings {
  const out: Record<string, string | number | boolean> = {};
  for (const key of PINNED_SETTING_KEYS) {
    out[key] = settings.general[key] as string | number | boolean;
  }
  return out;
}

/**
 * @returns The handshake's view of a settings manager: `apply` puts the pinned settings in as an in-memory overlay
 * and returns the hash of the pinned values as read back; `remove` takes the overlay off.
 */
export function createSettingsOverlayPort(settings: OverlayCapableSettings): SettingsOverlayPort {
  return {
    apply(pinned) {
      assertPinnedSettings(pinned);
      settings.applyOverlay(pinned);
      return hashCanonical(readPinnedSettings(settings));
    },
    remove() {
      settings.removeOverlay();
    },
  };
}
