/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

/**
 * The config of `pnpm shot` (`test/shots/`): the screenshots of one co-op interaction, from every player. It runs the one
 * file `run.shot.ts`, which reads what to shoot from `SHOT_JOB` (written by `test/shots/shot.ts`).
 *
 * The dev server is the browser tests' one (`playwright.config.ts`); `pnpm shot --keep` leaves a server it started running,
 * so the next shot does not wait for it.
 */
const { webServer, ...rest } = base;

// biome-ignore lint/style/noDefaultExport: required for Playwright
export default defineConfig({
  ...rest,
  testDir: "./test/shots",
  testMatch: "run.shot.ts",
  outputDir: "./test-results/shots-runner",
  // The job sets its own time limit (`--timeout`)
  timeout: 0,
  reporter: [["./test/shots/reporter.ts"]],
  use: { ...base.use, trace: "off", screenshot: "off" },
  // `--list` needs no game
  ...(process.env["SHOT_NO_SERVER"] === "1" || webServer === undefined ? {} : { webServer }),
});
