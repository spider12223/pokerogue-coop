/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describePhaseTraceDiff, diffPhaseTraces } from "#coop/phase-trace";
import { getLevelTotalExp } from "#data/exp";
import { BattleStyle } from "#enums/battle-style";
import { BiomeId } from "#enums/biome-id";
import { ClassicFixedBossWaves } from "#enums/fixed-boss-waves";
import { MoveId } from "#enums/move-id";
import { PlayerGender } from "#enums/player-gender";
import { SpeciesId } from "#enums/species-id";
import {
  accountWith,
  type ClientConfig,
  type ClientReport,
  Decider,
  expectSameCheckpoints,
  playClient,
  type Scenario,
  type SharedRun,
} from "#test/helpers/coop-harness";
import Phaser from "phaser";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * START-TO-ETERNATUS (STE): a whole classic co-op run with nobody at the keys, from the starters to the final boss, on the
 * game's own enemies (their levels, moves, abilities and AI). Every condition of the run that co-op changes is made to happen
 * at least once, and the run fails if one did not. Run with `pnpm test:ste` (`COOP_STE=1`, a few minutes).
 *
 * STE-replay: one client plays the run as the host and logs every decision of both seats; a second client, with the guest's
 * account and other local settings, replays the log as the guest. Both must pass the same state-hash checkpoints from the
 * first wave to Eternatus (D13, D14): any simulation path that reads something local, or rolls an unseeded number, shows up
 * as the first checkpoint that differs.
 *
 * The party is strong (level 600) so that the run reaches the end; the host's first starter starts at level 12, so that it
 * levels up, learns moves and evolves on the way.
 */

const RUN_SEED = "co-op-start-to-eternatus";
/** `pnpm test:ste` (vitest's mode `ste`), or `COOP_STE=1` with any vitest command */
const STE = process.env["COOP_STE"] === "1" || import.meta.env.MODE === "ste";

/** What the run does on purpose; the rest (trainers, bosses, biomes, evolutions, level-up moves) comes from the game */
const SCENARIO: Scenario = {
  // three each: the host's Bulbasaur, Charmander and Machop, the guest's Squirtle, Pikachu and Geodude
  species: [
    SpeciesId.BULBASAUR,
    SpeciesId.SQUIRTLE,
    SpeciesId.CHARMANDER,
    SpeciesId.PIKACHU,
    SpeciesId.MACHOP,
    SpeciesId.GEODUDE,
  ],
  starterOwners: ["host", "guest", "host", "guest", "host", "guest"],
  waves: 200,
  // two attacks of types that nothing is immune to by type alone (Water, Fire); Memento to faint on purpose
  moveset: [MoveId.WATERFALL, MoveId.MEMENTO, MoveId.FLAMETHROWER, MoveId.TAIL_WHIP],
  faintMove: MoveId.MEMENTO,
  // a faint of each seat's Pokémon on the field: the replacement is the owner's decision (D7)
  faints: [
    { wave: 21, turn: 1, slots: [1] },
    { wave: 81, turn: 1, slots: [0] },
  ],
  // revives (or potions) for the fainted, bought from the shop (D9)
  buyAtWaves: [22, 82],
  // three catches, the host at the cap of three each time: a release, a decline, a release (D10)
  catchFromWaves: [31, 71, 111],
  // two trades, one proposed by each seat (D11)
  tradeAtWaves: [41, 131],
  // a reload of the wave start in the middle of the run (D13)
  resyncAtWaves: [101],
  smartMoves: true,
  maxTurnsPerWave: 40,
  configure: game =>
    game.override
      .startingLevel(600)
      .startingBiome(BiomeId.TOWN)
      // the game's own enemies (the harness gives level 3 and Splash), no level cap, the normal exp
      .enemyLevel(0)
      .enemyMoveset([])
      .levelCap(0)
      .xpMultiplier(1),
  atStart: ctx => {
    // the host's first starter levels up from 12: learn-move prompts and evolutions on the way (both clients alike)
    const first = ctx.game.scene.getPlayerParty()[0];
    first.level = 12;
    first.exp = getLevelTotalExp(12, first.species.growthRate);
    first.calculateStats();
    first.hp = first.getMaxHp();
  },
};

/** The conditions the run must meet, and how many times it met each: the table printed at the end */
function coverage(report: ClientReport): Record<string, number> {
  const kinds = (kind: string): number => report.decisions.filter(d => d.key.kind === kind).length;
  const phases = (name: string): number => report.phaseStarts[name] ?? 0;
  const trainerWaves = new Set(report.waves.filter(w => w.trainer).map(w => w.wave));
  const fixed = Object.values(ClassicFixedBossWaves).filter((v): v is number => typeof v === "number");
  return {
    "waves played": report.waves.length,
    "every wave a double": report.waves.every(w => w.double) ? 1 : 0,
    "wild waves": report.waves.filter(w => !w.trainer).length,
    "trainer waves": trainerWaves.size,
    "fixed classic battles (rivals, evil team, Elite Four, Champion) fought as trainers": fixed.filter(wave =>
      trainerWaves.has(wave),
    ).length,
    "boss waves (segmented HP)": report.waves.filter(w => w.boss).length,
    "Eternatus at wave 200": report.waves.some(w => w.wave === 200 && w.enemySpecies.includes(SpeciesId.ETERNATUS))
      ? 1
      : 0,
    victory: report.gameOver?.victory === true ? 1 : 0,
    "turn commands": kinds("TURN_COMMANDS"),
    "turn commands of the host": report.decisions.filter(d => d.key.kind === "TURN_COMMANDS" && d.by === "host").length,
    "turn commands of the guest": report.decisions.filter(d => d.key.kind === "TURN_COMMANDS" && d.by === "guest")
      .length,
    "faint replacements": kinds("FAINT_SWITCH"),
    "reward picks by the host": report.decisions.filter(d => d.key.kind === "REWARD_PICK" && d.by === "host").length,
    "reward picks by the guest": report.decisions.filter(d => d.key.kind === "REWARD_PICK" && d.by === "guest").length,
    "shop buys": report.shopBuys,
    "biome choices": kinds("BIOME"),
    "moves learned on level-up": kinds("LEARN_MOVE"),
    evolutions: phases("EvolutionPhase"),
    catches: report.catches,
    "catches at the cap, answered": kinds("CATCH_RELEASE"),
    "releases for a catch": report.decisions.filter(
      d => d.key.kind === "CATCH_RELEASE" && (d.payload as { release: number | null }).release !== null,
    ).length,
    "declined catches": report.decisions.filter(
      d => d.key.kind === "CATCH_RELEASE" && (d.payload as { release: number | null }).release === null,
    ).length,
    trades: report.trades,
    "reloads of the wave start": report.resyncs,
    "new biomes": report.checkpoints.filter(c => c.kind === "waveStart" && c.phaseName === "NewBiomeEncounterPhase")
      .length,
  };
}

function printCoverage(title: string, table: Record<string, number>): void {
  const width = Math.max(...Object.keys(table).map(name => name.length));
  process.stderr.write(
    `\n${title}\n${Object.entries(table)
      .map(([name, n]) => `  ${name.padEnd(width)}  ${n}`)
      .join("\n")}\n`,
  );
}

describe.runIf(STE)("START-TO-ETERNATUS (STE)", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  it("STE-replay: the host plays from the starters to Eternatus, the guest replays it to the same hashes", async () => {
    const hostAccount = accountWith({ trainerId: 1234, secretId: 5678 });
    const guestAccount = accountWith({ trainerId: 4321, secretId: 8765 });
    const shared: SharedRun = {
      runSeed: RUN_SEED,
      snapshot: { host: hostAccount, guest: guestAccount },
      hostPlayerGender: PlayerGender.MALE,
    };
    const host: ClientConfig = {
      seat: "host",
      liveAccount: hostAccount,
      localSettings: {},
      applyOverlay: true,
      bypassSnapshot: false,
      stallMs: 30_000,
    };
    const started = Date.now();
    const recorded = await playClient(phaserGame, shared, host, Decider.recording(), SCENARIO);
    const table = coverage(recorded);
    printCoverage(`STE-replay, the host's run (${Math.round((Date.now() - started) / 1000)} s):`, table);
    expect(recorded.stalledIn, `stalled: ${JSON.stringify(recorded.stalledIn)}`).toBeNull();

    // every condition happened
    expect(table["waves played"]).toBe(200);
    expect(table["every wave a double"]).toBe(1);
    expect(table["victory"]).toBe(1);
    expect(table["Eternatus at wave 200"]).toBe(1);
    expect(table["fixed classic battles (rivals, evil team, Elite Four, Champion) fought as trainers"]).toBe(
      Object.values(ClassicFixedBossWaves).filter(v => typeof v === "number").length,
    );
    for (const name of [
      "wild waves",
      "trainer waves",
      "boss waves (segmented HP)",
      "turn commands of the host",
      "turn commands of the guest",
      "reward picks by the host",
      "reward picks by the guest",
      "shop buys",
      "biome choices",
      "moves learned on level-up",
      "evolutions",
      "releases for a catch",
      "declined catches",
      "new biomes",
    ]) {
      expect(table[name], name).toBeGreaterThan(0);
    }
    expect(table["faint replacements"]).toBeGreaterThanOrEqual(2);
    expect(table["catches"]).toBe(3);
    expect(table["trades"]).toBe(2);
    expect(table["reloads of the wave start"]).toBe(1);

    // the guest: another account, other local settings, the host's log; the reload loads the host's save
    const guest: ClientConfig = {
      seat: "guest",
      liveAccount: guestAccount,
      localSettings: {
        general: { battleStyle: BattleStyle.SWITCH, enableTutorials: true, gameSpeed: 4 },
        display: { showStatsOnLevelUp: true },
      },
      applyOverlay: true,
      bypassSnapshot: false,
      stallMs: 30_000,
    };
    const replayed = await playClient(
      phaserGame,
      shared,
      guest,
      Decider.replaying(recorded.decisions),
      { ...SCENARIO, resyncSaves: recorded.waveSaves },
      recorded.checkpoints,
    );
    printCoverage("STE-replay, the guest's replay:", coverage(replayed));
    expect(replayed.stalledIn, `the replay stalled: ${JSON.stringify(replayed.stalledIn)}`).toBeNull();
    expect(replayed.divergence).toBeNull();
    expectSameCheckpoints(recorded, replayed);
    expect(replayed.checkpoints.map(c => c.hash)).toEqual(recorded.checkpoints.map(c => c.hash));
    expect(replayed.decisions).toEqual(recorded.decisions);
    expect(replayed.waves).toEqual(recorded.waves);
    expect(replayed.gameOver).toEqual(recorded.gameOver);
    const traceDiff = diffPhaseTraces(recorded.trace, replayed.trace);
    expect(traceDiff === null ? null : describePhaseTraceDiff(traceDiff)).toBeNull();
  }, 3_600_000);
});
