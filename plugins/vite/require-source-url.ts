/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { loadEnv, type Plugin } from "vite";

/**
 * The AGPL asks a service that runs a modified version to offer its users the source (DECISIONS D25): the title screen links to
 * `VITE_SOURCE_URL`. A production build without one stops here, so a deploy cannot leave the link out by accident.
 */

/** @returns Whether `value` is an `http` or `https` address (nothing else, such as `javascript:`, is a place for a link) */
export function isSourceUrl(value: string | undefined): value is string {
  if (value === undefined) {
    return false;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * @param mode - The mode of the build
 * @param value - `VITE_SOURCE_URL`
 * @throws If this is a production build and there is no address
 */
export function checkSourceUrl(mode: string, value: string | undefined): void {
  if (mode === "production" && !isSourceUrl(value)) {
    throw new Error(
      "VITE_SOURCE_URL is not set (or is not an http(s) address). The AGPL asks a service that runs this game to offer its "
        + "source: set it to where the source of this build is published, for example "
        + "VITE_SOURCE_URL=https://github.com/you/pokerogue-coop pnpm build",
    );
  }
}

export function requireSourceUrl(): Plugin {
  return {
    name: "coop-require-source-url",
    apply: "build",
    configResolved(config) {
      checkSourceUrl(
        config.mode,
        process.env["VITE_SOURCE_URL"] ?? loadEnv(config.mode, config.envDir, "VITE_")["VITE_SOURCE_URL"],
      );
    },
  };
}
