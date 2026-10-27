/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface CoopBuildIdentity {
  gitSha: string;
  /** `"clean"`, or a hash of the working tree's changes (see {@linkcode computeCoopBuildIdentity}) */
  dirtyHash: string;
}

export type GitRunner = (args: string[], cwd: string) => string;

const defaultGit: GitRunner = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });

/** Both players must run the same tree on any OS: hash text with `\n` line endings whatever the checkout has. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * The co-op build identity (DECISIONS D1): the commit and a hash of what differs from it, so two clients on the same
 * commit but different working trees are told apart.
 *
 * `dirtyHash` is `"clean"` when the tree matches the commit. Otherwise it hashes `git diff HEAD` (tracked changes,
 * staged or not) and the content and path of every untracked file under `src/` that git does not ignore (a new source
 * file is code that runs). Untracked files elsewhere (notes, local config) do not count.
 * @param cwd - The repository root
 * @param git - Runs git; injectable for tests
 * @returns `"unknown"` for both fields if git is not available
 */
export function computeCoopBuildIdentity(cwd: string, git: GitRunner = defaultGit): CoopBuildIdentity {
  try {
    const gitSha = git(["rev-parse", "HEAD"], cwd).trim();
    const diff = git(["diff", "HEAD"], cwd);
    const untracked = git(["ls-files", "--others", "--exclude-standard", "-z", "--", "src"], cwd)
      .split("\0")
      .filter(path => path.length > 0)
      .sort();
    if (diff.length === 0 && untracked.length === 0) {
      return { gitSha, dirtyHash: "clean" };
    }
    const hash = createHash("sha256");
    hash.update(normalizeNewlines(diff));
    for (const path of untracked) {
      hash.update(`\0${path}\0`);
      hash.update(normalizeNewlines(readFileSync(join(cwd, path), "utf8")));
    }
    return { gitSha, dirtyHash: hash.digest("hex").slice(0, 14) };
  } catch {
    return { gitSha: "unknown", dirtyHash: "unknown" };
  }
}

/**
 * The identity to build with (DECISIONS D1, D22): the one the environment names, if `COOP_GIT_SHA` is set, else the one the
 * working tree has. A container is built from a copy without `.git`, so it is told the commit as build arguments (`docker build
 * --build-arg GIT_SHA=$(git rev-parse HEAD)`) and both players, who run the same image, get the same identity.
 * @param cwd - The repository root
 * @param env - The environment; injectable for tests
 */
export function coopBuildIdentity(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): CoopBuildIdentity {
  const sha = env["COOP_GIT_SHA"]?.trim();
  if (sha !== undefined && sha !== "") {
    const dirty = env["COOP_DIRTY_HASH"]?.trim();
    return { gitSha: sha, dirtyHash: dirty === undefined || dirty === "" ? "clean" : dirty };
  }
  return computeCoopBuildIdentity(cwd);
}
