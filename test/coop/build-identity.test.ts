/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { computeCoopBuildIdentity, coopBuildIdentity } from "../../plugins/vite/coop-build-identity.ts";

/** A throwaway repository with a commit that has `src/a.ts`; no line-ending conversion, no hooks, no signing. */
function makeRepo(root: string): string {
  const dir = mkdtempSync(join(root, "repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      stdio: "ignore",
    });
  git("init", "-q");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init");
  return dir;
}

describe("computeCoopBuildIdentity (D1)", () => {
  const root = mkdtempSync(join(tmpdir(), "coop-build-identity-"));
  let repo: string;

  beforeEach(() => {
    repo = makeRepo(root);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is clean when the tree matches the commit", () => {
    const identity = computeCoopBuildIdentity(repo);
    expect(identity.dirtyHash).toBe("clean");
    expect(identity.gitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("hashes a change to a tracked file", () => {
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
    const changed = computeCoopBuildIdentity(repo).dirtyHash;
    expect(changed).toMatch(/^[0-9a-f]{14}$/);

    writeFileSync(join(repo, "src", "a.ts"), "export const a = 3;\n");
    expect(computeCoopBuildIdentity(repo).dirtyHash).not.toBe(changed);
  });

  it("covers untracked files under src/: a new source file makes the tree dirty, and its content counts", () => {
    writeFileSync(join(repo, "src", "new.ts"), "export const b = 1;\n");
    const withNew = computeCoopBuildIdentity(repo).dirtyHash;
    expect(withNew).toMatch(/^[0-9a-f]{14}$/);

    writeFileSync(join(repo, "src", "new.ts"), "export const b = 2;\n");
    expect(computeCoopBuildIdentity(repo).dirtyHash).not.toBe(withNew);

    rmSync(join(repo, "src", "new.ts"));
    expect(computeCoopBuildIdentity(repo).dirtyHash).toBe("clean");
  });

  it("covers a new file in a new directory under src/, and tells two different files apart", () => {
    mkdirSync(join(repo, "src", "coop"));
    writeFileSync(join(repo, "src", "coop", "x.ts"), "export const x = 1;\n");
    const x = computeCoopBuildIdentity(repo).dirtyHash;
    rmSync(join(repo, "src", "coop", "x.ts"));
    writeFileSync(join(repo, "src", "coop", "y.ts"), "export const x = 1;\n");
    expect(computeCoopBuildIdentity(repo).dirtyHash).not.toBe(x);
  });

  it("ignores untracked files outside src/ and files git ignores", () => {
    writeFileSync(join(repo, "NOTES.md"), "local notes\n");
    writeFileSync(join(repo, ".gitignore"), "src/generated.ts\n");
    // .gitignore itself is untracked but outside src/
    writeFileSync(join(repo, "src", "generated.ts"), "export const g = 1;\n");
    expect(computeCoopBuildIdentity(repo).dirtyHash).toBe("clean");
  });

  it("is the same on every machine: line endings and checkout location do not matter", () => {
    writeFileSync(join(repo, "src", "new.ts"), "export const b = 1;\nexport const c = 2;\n");
    const lf = computeCoopBuildIdentity(repo).dirtyHash;
    writeFileSync(join(repo, "src", "new.ts"), "export const b = 1;\r\nexport const c = 2;\r\n");
    expect(computeCoopBuildIdentity(repo).dirtyHash).toBe(lf);

    // the same changes in another checkout of the same commit
    const other = makeRepo(root);
    writeFileSync(join(other, "src", "new.ts"), "export const b = 1;\nexport const c = 2;\n");
    const otherIdentity = computeCoopBuildIdentity(other);
    expect(otherIdentity.dirtyHash).toBe(lf);
  });

  it("is unknown without git", () => {
    expect(
      computeCoopBuildIdentity(repo, () => {
        throw new Error("git is not installed");
      }),
    ).toEqual({ gitSha: "unknown", dirtyHash: "unknown" });
  });
});

describe("coopBuildIdentity: a container is built without a repository (D22)", () => {
  it("takes the commit it was told, and says the tree is clean unless it is told otherwise", () => {
    expect(coopBuildIdentity("/nowhere", { COOP_GIT_SHA: "a6995c571a092e762ea036589bb6f3a8fa4f5dbd" })).toEqual({
      gitSha: "a6995c571a092e762ea036589bb6f3a8fa4f5dbd",
      dirtyHash: "clean",
    });
    expect(coopBuildIdentity("/nowhere", { COOP_GIT_SHA: " abc123 ", COOP_DIRTY_HASH: "0123456789abcd" })).toEqual({
      gitSha: "abc123",
      dirtyHash: "0123456789abcd",
    });
  });

  it("asks the repository when it was told nothing, and is 'unknown' where there is none", () => {
    expect(coopBuildIdentity("/nowhere", {})).toEqual({ gitSha: "unknown", dirtyHash: "unknown" });
    expect(coopBuildIdentity("/nowhere", { COOP_GIT_SHA: "  " })).toEqual({ gitSha: "unknown", dirtyHash: "unknown" });
  });
});
