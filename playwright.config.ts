/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineConfig, devices } from "@playwright/test";

/** The dev server port (`VITE_PORT` in `.env.development`). */
const PORT = 8000;

/** A game that is already running, such as the container of a deploy (DECISIONS D22): no dev server is started for it */
const EXTERNAL = process.env["E2E_BASE_URL"] || undefined;

// biome-ignore lint/style/noDefaultExport: required for Playwright
export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "./test-results/e2e",
  // Two full game instances per test: run one test at a time.
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: "list",
  use: {
    baseURL: EXTERNAL ?? `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // A game that is already running needs no dev server
  ...(EXTERNAL === undefined
    ? {
        webServer: {
          // `start:dev` loads `.env.development` (`VITE_BYPASS_LOGIN=1`): offline play, no rogueserver needed.
          command: "pnpm start:dev",
          url: `http://localhost:${PORT}`,
          reuseExistingServer: true,
          timeout: 240_000,
          stdout: "ignore" as const,
          stderr: "pipe" as const,
        },
      }
    : {}),
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Phaser needs WebGL; headless Chromium has none without a software rasterizer.
        launchOptions: {
          args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
        },
      },
    },
  ],
});
