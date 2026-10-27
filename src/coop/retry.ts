/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * The retry after a wipe (DECISIONS D4a, amended): when the party is out of usable Pokémon, the host chooses to play the wave
 * again from its start or to end the run. It is a sequenced decision (`RETRY`); a retry is then the reload of D13 with the
 * reason `retry`, which is not a desync strike. No game imports.
 *
 * @module
 */

/** `RETRY`: whether the wave is played again from its start (`true`) or the run ends (`false`) */
export interface RetryPayload {
  retry: boolean;
}

export function isRetryPayload(value: unknown): value is RetryPayload {
  return (
    typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)["retry"] === "boolean"
  );
}
