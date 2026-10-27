/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, it } from "vitest";
import { scanAccountReads } from "./sim-call-sites";

/**
 * Call-site test for account data (DECISIONS D4): the simulation reads the account through
 * `simAccount()` (`src/coop/sim-account.ts`), never from `gameData` directly. Every direct `gameData` access left in
 * `src/` (outside the UI, `src/coop/` and `game-data.ts` itself) is listed here with its reason; a new one fails the
 * test. Decide whether the new read decides anything in the simulation (add it to `SimAccountData` and the snapshot)
 * or not (list it here).
 *
 * The exact count per file is listed, so a new read in a listed file also fails.
 */
type Why =
  | "write" // credits the account (counters, candy, vouchers, dex): the owner's account, nothing reads it back in the sim
  | "off-in-coop" // a feature that is off in co-op v1 (D12): eggs, Mystery Encounters, challenges, title screen
  | "run-end" // progression at the end of a run: not part of the simulated waves, handled per account (D4)
  | "display"; // only changes what is shown (text, IV scanner, achievement popups)

const ALLOWED: Record<string, { count: number; why: Why; note: string }> = {
  "src/battle-scene.ts": {
    count: 6,
    why: "write",
    note: "playTime, achvUnlocks/voucherUnlocks/voucherCounts when an achievement or voucher is earned",
  },
  "src/data/challenge.ts": { count: 1, why: "off-in-coop", note: "starter value reduction in challenge validation" },
  "src/data/egg-hatch-data.ts": { count: 2, why: "off-in-coop", note: "egg hatch results" },
  "src/data/egg.ts": {
    count: 19,
    why: "write",
    note: "egg pity (overall and per species), egg list, pull statistics: an egg's draws are outside the run (D30)",
  },
  "src/data/mystery-encounters/encounters/training-session-encounter.ts": {
    count: 4,
    why: "off-in-coop",
    note: "Mystery Encounters are off",
  },
  "src/data/mystery-encounters/encounters/weird-dream-encounter.ts": {
    count: 2,
    why: "off-in-coop",
    note: "Mystery Encounters are off",
  },
  "src/field/pokemon.ts": { count: 2, why: "write", note: "candy per battle (starterData), gameStats.pokemonFused" },
  "src/modifier/modifier.ts": { count: 1, why: "write", note: "voucherCounts from a voucher modifier" },
  "src/phases/battle-end-phase.ts": { count: 1, why: "write", note: "gameStats counters and high-water marks" },
  "src/phases/egg-hatch-phase.ts": { count: 3, why: "off-in-coop", note: "eggs are off" },
  "src/phases/egg-lapse-phase.ts": { count: 3, why: "off-in-coop", note: "returns before reading them in co-op" },
  "src/phases/encounter-phase.ts": {
    count: 2,
    why: "display",
    note: "final-boss dialogue: session count in the text, seen-dialogue record (skipSeenDialogues is pinned off)",
  },
  "src/phases/game-over-phase.ts": {
    count: 7,
    why: "run-end",
    note: "unlock phases and statistics at the end of a run; the co-op clear counter of this account",
  },
  "src/phases/level-up-phase.ts": { count: 2, why: "write", note: "highestLevel" },
  "src/phases/move-effect-phase.ts": { count: 2, why: "write", note: "highestDamage" },
  "src/phases/pokemon-heal-phase.ts": { count: 2, why: "write", note: "highestHeal" },
  "src/phases/scan-ivs-phase.ts": { count: 1, why: "display", note: "best known IVs shown by the IV scanner" },
  "src/phases/select-starter-phase.ts": {
    count: 3,
    why: "write",
    note: "classic/endless session counters, and getDexAttrLuck (a pure function of its argument; the dex read is simAccount)",
  },
  "src/phases/title-phase.ts": { count: 4, why: "off-in-coop", note: "title menu and daily-run statistics" },
  "src/phases/unlock-phase.ts": { count: 1, why: "run-end", note: "marks an unlockable unlocked" },
  "src/phases/victory-phase.ts": { count: 1, why: "write", note: "pokemonDefeated" },
  "src/system/achv.ts": { count: 2, why: "display", note: "achievement conditions on statistics (popups, vouchers)" },
  "src/system/ribbons/ribbon-methods.ts": { count: 1, why: "run-end", note: "ribbons are awarded at the end of a run" },
};

describe("direct account-data reads in src/ (D4)", () => {
  const found = scanAccountReads(process.cwd());

  it("has no direct read in a file that is not listed", () => {
    const unlisted = Object.keys(found).filter(file => !(file in ALLOWED));
    expect(unlisted, `unlisted: ${JSON.stringify(unlisted.map(f => [f, found[f]]))}`).toEqual([]);
  });

  it("lists exact counts per file", () => {
    const actual = Object.fromEntries(
      Object.entries(found).map(([file, counts]) => [file, Object.values(counts).reduce((a, b) => a + b, 0)]),
    );
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([file, entry]) => [file, entry.count]));
    expect(actual).toEqual(expected);
  });

  it("every simulation read goes through simAccount: these files read no account data directly", () => {
    for (const file of [
      "src/data/balance/pokemon-evolutions.ts",
      "src/data/pokemon-forms.ts",
      "src/data/pokeball.ts",
      "src/modifier/init-modifier-pools.ts",
      "src/phases/command-phase.ts",
    ]) {
      expect(found[file], file).toBeUndefined();
    }
  });
});
