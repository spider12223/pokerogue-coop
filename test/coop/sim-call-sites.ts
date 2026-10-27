/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type Patterns = readonly (readonly [name: string, pattern: RegExp])[];

/** What counts as an unseeded or wall-clock input to scan `src/` for. */
const RNG_PATTERNS: Patterns = [
  ["Math.random", /\bMath\.random\s*\(/g],
  ["randInt", /(?<![\w.])randInt\s*\(/g],
  ["randIntRange", /(?<![\w.])randIntRange\s*\(/g],
  ["randItem", /(?<![\w.])randItem\s*\(/g],
  ["randGauss", /(?<![\w.])randGauss\s*\(/g],
  ["randomString", /(?<![\w.])randomString\s*\(([^)]*)\)/g],
  ["Date.now", /\bDate\.now\s*\(/g],
  ["new Date", /\bnew Date\s*\(/g],
  ["performance.now", /\bperformance\.now\s*\(/g],
  ["crypto", /\bcrypto\.(?:getRandomValues|randomUUID|subtle)/g],
];

/** Blank out comments (keeping line structure), so mentions in documentation are not calls. */
export function stripComments(source: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, (_match, before: string) => before);
}

export type SiteCounts = Record<string, Record<string, number>>;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
    } else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) {
      yield path;
    }
  }
}

/**
 * @param root - The repository root
 * @param patterns - What to look for, by name; the regexes must be global
 * @param skip - Files (repo-relative, forward slashes) that are not scanned
 * @param accept - Filter for a match; return `false` to not count it
 * @returns For every file under `src/` with a hit: `{ "src/x.ts": { "name": 2, ... } }` (forward slashes)
 */
export function scanSource(
  root: string,
  patterns: Patterns,
  skip: (file: string) => boolean = () => false,
  accept: (name: string, match: RegExpMatchArray) => boolean = () => true,
): SiteCounts {
  const found: SiteCounts = {};
  for (const file of walk(join(root, "src"))) {
    const rel = relative(root, file).split(sep).join("/");
    if (skip(rel)) {
      continue;
    }
    const text = stripComments(readFileSync(file, "utf8"));
    for (const [name, pattern] of patterns) {
      for (const match of text.matchAll(pattern)) {
        if (accept(name, match)) {
          const counts = (found[rel] ??= {});
          counts[name] = (counts[name] ?? 0) + 1;
        }
      }
    }
  }
  return found;
}

/**
 * @param root - The repository root
 * @returns For every file under `src/` with an unseeded RNG or wall-clock call: `{ "src/x.ts": { "randInt": 2, ... } }`
 */
export function scanSimCallSites(root: string): SiteCounts {
  // `randomString(n, true)` draws from the seeded stream
  return scanSource(
    root,
    RNG_PATTERNS,
    () => false,
    (name, match) => !(name === "randomString" && /\btrue\b/.test(match[1] ?? "")),
  );
}

/** Direct reads of the account's data (`globalScene.gameData`, `this.gameData`, a local `gameData`). */
const ACCOUNT_MEMBERS =
  "dexData|starterData|trainerId|secretId|unlocks|isUnlocked|getSpeciesCount|getStarterCount|checkSpeciesNatureUnlocked|checkStarterAbilityIndexUnlocked|getDexAttrLuck|eggs|voucherCounts|gameStats|getSeenDialogues|achvUnlocks|voucherUnlocks";

const ACCOUNT_PATTERNS: Patterns = [
  ["gameData.member", new RegExp(`\\bgameData\\s*\\.\\s*(?:${ACCOUNT_MEMBERS})\\b`, "g")],
  [
    "destructured gameData",
    new RegExp(`\\{[^}]*\\b(?:${ACCOUNT_MEMBERS})\\b[^}]*\\}\\s*=\\s*(?:globalScene\\.|this\\.)?gameData\\b`, "g"),
  ],
];

/**
 * @param root - The repository root
 * @returns For every file under `src/` (not `src/coop/`, `src/ui/`, and `src/system/game-data.ts`, which is the account
 * data itself) that reads account data directly: `{ "src/x.ts": { "gameData.member": 2 } }`
 */
export function scanAccountReads(root: string): SiteCounts {
  return scanSource(
    root,
    ACCOUNT_PATTERNS,
    file => file.startsWith("src/coop/") || file.startsWith("src/ui/") || file === "src/system/game-data.ts",
  );
}
