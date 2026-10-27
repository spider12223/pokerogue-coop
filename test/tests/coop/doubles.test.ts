/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { hasUsableDoubleVariant } from "#coop/doubles";
import { BattleType } from "#enums/battle-type";
import { ClassicFixedBossWaves } from "#enums/fixed-boss-waves";
import { MoveId } from "#enums/move-id";
import { PlayerGender } from "#enums/player-gender";
import { SpeciesId } from "#enums/species-id";
import { TrainerType } from "#enums/trainer-type";
import { TrainerVariant } from "#enums/trainer-variant";
import {
  accountWith,
  advanceTo,
  type ClientConfig,
  Decider,
  describeWave,
  openCoopRun,
  playClient,
  queueTurnCommands,
  type Scenario,
  type SharedRun,
  type WaveInfo,
} from "#test/helpers/coop-harness";
import { classicFixedBattles } from "#trainers/fixed-battle-configs";
import { trainerConfigs } from "#trainers/trainer-config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Phaser from "phaser";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Forced doubles (DECISIONS D6): no `FIELD_SIZE_OVERRIDE`, the co-op game mode alone makes every battle a double.
 * With `COOP_WRITE_DOCS=1 pnpm test:coop:game` the tables these tests check are also written to `test-results/coop-tables/`.
 */

const SIX = [
  SpeciesId.BULBASAUR,
  SpeciesId.SQUIRTLE,
  SpeciesId.CHARMANDER,
  SpeciesId.PIKACHU,
  SpeciesId.MACHOP,
  SpeciesId.GEODUDE,
];

const BASE: Scenario = {
  species: SIX,
  waves: 0,
  // Bite is Dark: nothing is immune to it, so no fight with a Ghost-type goes on forever
  moveset: [MoveId.BITE, MoveId.MEMENTO, MoveId.GROWL, MoveId.TAIL_WHIP],
  faints: [],
  faintMove: MoveId.MEMENTO,
};

const ACCOUNT = accountWith({ trainerId: 4242, secretId: 2424 });

const SHARED: SharedRun = {
  runSeed: "co-op-m3-doubles",
  snapshot: { host: ACCOUNT, guest: ACCOUNT },
  hostPlayerGender: PlayerGender.MALE,
};

const HOST: ClientConfig = {
  seat: "host",
  liveAccount: ACCOUNT,
  localSettings: {},
  applyOverlay: true,
  bypassSnapshot: false,
  stallMs: 20_000,
};

const MINUTES = 60_000;

interface Surveyed {
  info: WaveInfo;
  /** The trainer's party template sizes, for the trainer table */
  templates: number[];
  failure: string | null;
}

describe("Co-op: forced doubles (D6)", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  /** Start a run at `wave` (optionally against a given trainer), look at the battle and play one turn of it. */
  async function surveyWave(options: { wave: number; trainer?: TrainerType }): Promise<Surveyed> {
    const run = await openCoopRun(phaserGame, SHARED, HOST, Decider.recording(), {
      ...BASE,
      configure: game => {
        game.override.startingWave(options.wave);
        if (options.trainer !== undefined) {
          game.override.battleType(BattleType.TRAINER).randomTrainer({ trainerType: options.trainer as never });
        }
        // the final boss opens with dialogue that waits for input
        vi.spyOn(game.scene.ui, "shouldSkipDialogue").mockReturnValue(true);
      },
    });
    const { ctx } = run;
    let failure: string | null = null;
    let info!: WaveInfo;
    try {
      await advanceTo(ctx, ["CommandPhase"]);
      info = describeWave(ctx);
      queueTurnCommands(ctx);
      await advanceTo(ctx, ["TurnInitPhase", "SelectModifierPhase"]);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      info ??= describeWave(ctx);
    } finally {
      run.close();
    }
    const templates = info.trainerType === null ? [] : trainerConfigs[info.trainerType].partyTemplates.map(t => t.size);
    return { info, templates, failure };
  }

  it(
    "50 seeded waves: every battle is a double and the enemy side is what the table says",
    async () => {
      const report = await playClient(phaserGame, SHARED, HOST, Decider.recording(), { ...BASE, waves: 50 });

      expect(report.stalledIn).toBeNull();
      expect(report.waves).toHaveLength(50);
      expect(report.waves.map(w => w.wave)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));

      for (const wave of report.waves) {
        expect(wave.double, `wave ${wave.wave} is a double`).toBe(true);
        // both slots have somebody to command, one of each seat
        expect(wave.controllers, `wave ${wave.wave}`).toEqual(["host", "guest"]);
        if (wave.trainer) {
          // the party of the trainer, two at a time
          expect(wave.enemyField, `trainer wave ${wave.wave}`).toBe(Math.min(2, wave.enemyParty));
          const config = trainerConfigs[wave.trainerType!];
          const fixed = wave.wave in classicFixedBattles;
          if (!fixed && (config.doubleOnly || hasUsableDoubleVariant({ config } as never))) {
            expect(wave.trainerVariant, `trainer ${TrainerType[wave.trainerType!]} on wave ${wave.wave}`).toBe(
              TrainerVariant.DOUBLE,
            );
          }
        } else {
          // a wild battle has two enemies, a boss wave two bosses
          expect(wave.enemyParty, `wild wave ${wave.wave}`).toBe(2);
          expect(wave.enemyField, `wild wave ${wave.wave}`).toBe(2);
        }
      }
      // the run included trainers, fixed and random, and boss waves
      expect(report.waves.filter(w => w.trainer).length).toBeGreaterThanOrEqual(3);
      // every command went to the owner of the Pokémon in the slot
      expect(report.decisions.every(d => d.by !== null)).toBe(true);
    },
    10 * MINUTES,
  );

  it(
    "the fixed battles: rival, evil team, Elite Four, Champion and the finale",
    async () => {
      const fixedWaves = [...Object.keys(classicFixedBattles).map(Number), 200].sort((a, b) => a - b);
      const rows: Surveyed[] = [];
      for (const wave of fixedWaves) {
        rows.push(await surveyWave({ wave }));
      }

      for (const { info, failure } of rows) {
        expect(failure, `wave ${info.wave}`).toBeNull();
        expect(info.double, `wave ${info.wave}`).toBe(true);
        expect(info.enemyField, `wave ${info.wave}`).toBe(Math.min(2, info.enemyParty));
        expect(info.controllers, `wave ${info.wave}`).toEqual(["host", "guest"]);
      }
      // the finale: two of ours against its one boss
      const finale = rows.find(r => r.info.wave === 200)!.info;
      expect(finale).toMatchObject({ trainer: false, double: true, enemyParty: 1, enemyField: 1 });
      // the Youngster of wave 5 and the grunts use their double variant; the rival and the others have none
      const variantOf = (wave: number) => rows.find(r => r.info.wave === wave)!.info.trainerVariant;
      expect(variantOf(ClassicFixedBossWaves.TOWN_YOUNGSTER)).toBe(TrainerVariant.DOUBLE);
      expect(variantOf(ClassicFixedBossWaves.EVIL_GRUNT_1)).toBe(TrainerVariant.DOUBLE);
      expect(variantOf(ClassicFixedBossWaves.RIVAL_1)).not.toBe(TrainerVariant.DOUBLE);

      if (process.env["COOP_WRITE_DOCS"]) {
        writeDoc("fixed-battles", fixedBattlesTable(rows));
      }
    },
    15 * MINUTES,
  );

  /** One of each kind of trainer: a generic double, a grunt, Tate, a double-only pair, a pair-trainer that has no random double, one with a single Pokémon, a gym leader, an Elite Four member, an admin. */
  const REPRESENTATIVES: readonly TrainerType[] = [
    TrainerType.YOUNGSTER,
    TrainerType.ROCKET_GRUNT,
    TrainerType.TATE,
    TrainerType.RED,
    TrainerType.TWINS,
    TrainerType.VICKY,
    TrainerType.OFFICER,
    TrainerType.BROCK,
    TrainerType.LORELEI,
    TrainerType.ARCHER,
  ];

  it(
    "a trainer of every kind, forced into a double: the engine copes, and the enemy count follows its party",
    async () => {
      for (const trainer of REPRESENTATIVES) {
        const { info, failure } = await surveyWave({ wave: 2, trainer });
        const name = TrainerType[trainer];
        expect(failure, name).toBeNull();
        expect(info).toMatchObject({ trainer: true, double: true });
        expect(info.enemyField, name).toBe(Math.min(2, info.enemyParty));
        const config = trainerConfigs[trainer];
        const usable =
          config.doubleOnly || (config.hasDouble && (!config.trainerTypeDouble || trainer === TrainerType.TATE));
        if (usable) {
          expect(info.trainerVariant === TrainerVariant.DOUBLE || config.doubleOnly, name).toBe(true);
          expect(info.enemyParty, name).toBeGreaterThanOrEqual(2);
        } else {
          expect(info.trainerVariant, name).not.toBe(TrainerVariant.DOUBLE);
        }
      }
    },
    15 * MINUTES,
  );

  it.skipIf(!process.env["COOP_SURVEY"])(
    "survey: every trainer config, forced into a double",
    async () => {
      const rows: Surveyed[] = [];
      for (const key of Object.keys(trainerConfigs)) {
        const trainer = Number(key) as TrainerType;
        if (trainer === TrainerType.UNKNOWN) {
          continue;
        }
        rows.push(await surveyWave({ wave: 2, trainer }));
      }
      const failures = rows
        .filter(r => r.failure !== null)
        .map(r => `${TrainerType[r.info.trainerType!]}: ${r.failure}`);
      if (process.env["COOP_WRITE_DOCS"]) {
        writeDoc("trainers", trainersTable(rows));
      }
      expect(failures).toEqual([]);
    },
    60 * MINUTES,
  );
});

// #region Docs

function writeDoc(name: string, content: string): void {
  const dir = join(process.cwd(), "test-results", "coop-tables");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content);
}

const variantName = (variant: number | null): string => (variant === null ? "-" : TrainerVariant[variant]);

function fixedBattlesTable(rows: Surveyed[]): string {
  const lines = [
    "<!--\nSPDX-FileCopyrightText: 2026 pokerogue-coop contributors\n\nSPDX-License-Identifier: AGPL-3.0-only\n-->\n",
    "# Enemy count of the fixed battles in a co-op double\n",
    "Generated by `COOP_WRITE_DOCS=1 pnpm test:coop:game`. Field = enemies on the field at the start, party = enemies in the battle.\n",
    "| Wave | Battle | Trainer | Variant | Party | Field |",
    "|---|---|---|---|---|---|",
  ];
  for (const { info } of rows) {
    const kind = info.wave === 200 ? "finale (wild boss)" : info.trainer ? "trainer" : "wild";
    lines.push(
      `| ${info.wave} | ${kind} | ${info.trainerType === null ? "-" : TrainerType[info.trainerType]} | ${variantName(info.trainerVariant)} | ${info.enemyParty} | ${info.enemyField} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function trainersTable(rows: Surveyed[]): string {
  const lines = [
    "<!--\nSPDX-FileCopyrightText: 2026 pokerogue-coop contributors\n\nSPDX-License-Identifier: AGPL-3.0-only\n-->\n",
    "# Every trainer config forced into a co-op double\n",
    "Generated by `COOP_SURVEY=1 COOP_WRITE_DOCS=1 pnpm test:coop:game`. Party = the enemy Pokémon of the battle, field = the ones out at the start.\n",
    "| Trainer | Double variant | Template sizes | Variant used | Party | Field | Result |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const { info, templates, failure } of rows) {
    const config = trainerConfigs[info.trainerType!];
    const kind = config.doubleOnly ? "double only" : config.hasDouble ? "yes" : "none";
    lines.push(
      `| ${TrainerType[info.trainerType!]} | ${kind} | ${templates.join("/")} | ${variantName(info.trainerVariant)} | ${info.enemyParty} | ${info.enemyField} | ${failure ?? "ok"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// #endregion
