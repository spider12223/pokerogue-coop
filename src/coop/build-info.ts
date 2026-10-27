/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { activeOverrides, defaultOverrides } from "#app/overrides";
import { bypassLogin } from "#constants/app-constants";
import { type BuildIdentity, COOP_PROTOCOL_VERSION, hashCanonical } from "#coop/protocol";

/** @returns Whether no override is in effect; a client with overrides must not start or join a co-op run (D1) */
export function overridesAreDefaults(): boolean {
  return hashCanonical(activeOverrides) === hashCanonical({ ...defaultOverrides });
}

/**
 * @returns The identity of this build for the handshake (DECISIONS D1)
 * - `gitSha`, `dirtyHash`: injected by `vite.config.ts`
 * - `buildMode`: the Vite mode, plus `+bypass` with `VITE_BYPASS_LOGIN`
 * - `overridesHash`: the hash of the overrides in effect; two clients can only agree if both run the defaults
 */
export function getLocalBuildIdentity(): BuildIdentity {
  return {
    protocolVersion: COOP_PROTOCOL_VERSION,
    gitSha: __COOP_GIT_SHA__,
    dirtyHash: __COOP_DIRTY_HASH__,
    buildMode: `${import.meta.env.MODE}${bypassLogin ? "+bypass" : ""}`,
    overridesHash: hashCanonical(activeOverrides),
  };
}
