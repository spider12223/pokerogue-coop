/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineConfig } from "vitest/config";

/**
 * Config for the co-op tests that do not need the game: the protocol, transports and sequencer (`test/coop/`) and
 * the relay server (`coop-server/test/`). Plain Node, no Phaser, no jsdom, no shared scene (the game's own config
 * runs with `isolate: false` and heavy setup files). Run with `pnpm test:coop`.
 *
 * Tests that drive the game itself live in `test/tests/coop/` and run under the main config.
 */
// biome-ignore lint/style/noDefaultExport: required for vitest
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    name: "coop",
    environment: "node",
    include: ["./test/coop/**/*.test.ts", "./coop-server/test/**/*.test.ts"],
    testTimeout: 60_000,
    restoreMocks: true,
    passWithNoTests: false,
  },
});
