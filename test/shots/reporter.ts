/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { FullResult, Reporter, TestCase, TestError, TestResult } from "@playwright/test/reporter";

/**
 * What `pnpm shot` prints: the job's own lines as they come, and why it failed. Playwright's own lines (one test, its
 * name, its time) say nothing to someone who asked for a screen.
 */
// biome-ignore lint/style/noDefaultExport: required for Playwright
export default class ShotReporter implements Reporter {
  onStdOut(chunk: string | Buffer): void {
    process.stdout.write(chunk);
  }

  onStdErr(chunk: string | Buffer): void {
    process.stderr.write(chunk);
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    for (const error of result.errors) {
      process.stderr.write(`\nshot failed: ${error.message ?? error.value ?? "unknown error"}\n`);
    }
  }

  /** An error outside the test: a file that does not load, the dev server that does not start */
  onError(error: TestError): void {
    process.stderr.write(`\nshot failed: ${error.stack ?? error.message ?? error.value ?? "unknown error"}\n`);
  }

  onEnd(result: FullResult): void {
    if (result.status === "timedout") {
      process.stderr.write("\nshot failed: the run hit its time limit (--timeout)\n");
    }
  }

  printsToStdio(): boolean {
    return true;
  }
}
