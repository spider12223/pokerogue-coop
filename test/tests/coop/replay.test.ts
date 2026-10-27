/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { describePhaseTraceDiff, diffPhaseTraces } from "#coop/phase-trace";
import { BattleStyle } from "#enums/battle-style";
import { BiomeId } from "#enums/biome-id";
import { ExpNotification } from "#enums/exp-notification";
import { MoveId } from "#enums/move-id";
import { PlayerGender } from "#enums/player-gender";
import { SpeciesId } from "#enums/species-id";
import {
  accountWith,
  type ClientConfig,
  type ClientReport,
  Decider,
  expectSameCheckpoints,
  NON_SHINY_CAUGHT,
  playClient,
  type Scenario,
  type SharedRun,
  type TurnPayload,
} from "#test/helpers/coop-harness";
import Phaser from "phaser";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Record/replay (DECISIONS D14): one client plays a double-battle run as the host and logs every decision;
 * another client, with another account and other local settings, replays that log as the guest. Both must pass the
 * same state-hash checkpoints (D13).
 *
 * The battle RNG is the real one: `GameManager` replaces it with max rolls, which would hide every battle-RNG
 * desync, so the harness puts it back.
 */

const SCENARIO: Scenario = {
  species: [SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER, SpeciesId.PIKACHU],
  waves: 10,
  moveset: [MoveId.TACKLE, MoveId.MEMENTO, MoveId.GROWL, MoveId.TAIL_WHIP],
  // wave 4, turn 1: the slot-1 Pokémon uses Memento and faints, its replacement is a decision
  faints: [{ wave: 4, turn: 1, slots: [1] }],
  faintMove: MoveId.MEMENTO,
  // two each: the host's Bulbasaur and Charmander, the guest's Squirtle and Pikachu
  starterOwners: ["host", "guest", "host", "guest"],
};

const RUN_SEED = "co-op-m2-replay-seed";
const STALL_MS = 20_000;
const TEST_MS = 600_000;

describe("Co-op record/replay (D13, D14)", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  /**
   * Two different accounts. The shiny roll reads the account's TID/SID: the host's account makes the first starter
   * shiny, the guest's makes it not shiny, so a client that read its own account would simulate another run. The ids
   * of the starters come from the run seed, so a probe of the first one tells which TID/SID does that.
   */
  async function accountsAndShared(): Promise<{ host: ClientConfig; guest: ClientConfig; shared: SharedRun }> {
    const probeAccount = accountWith({ trainerId: 1, secretId: 2 });
    const probeShared: SharedRun = {
      runSeed: RUN_SEED,
      snapshot: { host: probeAccount, guest: probeAccount },
      hostPlayerGender: PlayerGender.MALE,
    };
    const probeClient: ClientConfig = {
      seat: "host",
      liveAccount: probeAccount,
      localSettings: {},
      applyOverlay: true,
      bypassSnapshot: false,
      stallMs: STALL_MS,
    };
    const probe = await playClient(phaserGame, probeShared, probeClient, Decider.recording(), {
      ...SCENARIO,
      waves: 0,
    });
    const id = probe.partyIds[0];
    const F = ((id & 0xffff0000) >>> 16) ^ (id & 0x0000ffff);

    // E = TID ^ SID: the host's E equals F, so E ^ F = 0 is under the shiny threshold; the guest's is 0x5555 away
    const hostAccount = accountWith({
      trainerId: F,
      secretId: 0,
      unlocked: { eviolite: true, miniBlackHole: false },
      caught: { [SpeciesId.BULBASAUR]: NON_SHINY_CAUGHT, [SpeciesId.PIKACHU]: NON_SHINY_CAUGHT },
      eggMoves: { [SpeciesId.BULBASAUR]: 0b0001 },
    });
    const guestAccount = accountWith({
      trainerId: F ^ 0x5555,
      secretId: 0,
      unlocked: { eviolite: false, miniBlackHole: true },
      caught: { [SpeciesId.SQUIRTLE]: NON_SHINY_CAUGHT, [SpeciesId.CHARMANDER]: NON_SHINY_CAUGHT },
      eggMoves: { [SpeciesId.SQUIRTLE]: 0b0011 },
    });
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
      stallMs: STALL_MS,
    };
    const guest: ClientConfig = {
      seat: "guest",
      liveAccount: guestAccount,
      // Everything a guest might have saved that is not what the host plays with. The pinned ones are replaced by
      // the overlay; the others (game speed, animations, ...) are local and must not matter.
      localSettings: {
        general: {
          battleStyle: BattleStyle.SWITCH,
          enableTutorials: true,
          skipSeenDialogues: true,
          manualMessageClear: true,
          partyExpNotificationMode: ExpNotification.ONLY_LEVEL_UP,
          playerGender: PlayerGender.FEMALE,
          gameSpeed: 4,
        },
        display: { showStatsOnLevelUp: true },
      },
      applyOverlay: true,
      bypassSnapshot: false,
      stallMs: STALL_MS,
    };
    return { host, guest, shared };
  }

  function expectCoverage(host: ClientReport): void {
    // at least ten waves, in order, every one a double battle
    expect(
      host.stalledIn,
      `the recording stalled: ${JSON.stringify(host.stalledIn)} after ${host.decisions.length} decisions`,
    ).toBeNull();
    expect(host.waves.map(w => w.wave)).toEqual(Array.from({ length: SCENARIO.waves }, (_, i) => i + 1));
    expect(host.waves.every(w => w.double)).toBe(true);
    // a trainer wave
    expect(host.waves.filter(w => w.trainer).map(w => w.wave)).toContain(5);
    // a level-up that teaches a move through the prompt
    expect(host.movesLearned).toBeGreaterThanOrEqual(1);
    expect(host.decisions.filter(d => d.key.kind === "LEARN_MOVE").length).toBe(host.movesLearned);
    // prompt decisions are keyed outside a turn, with a ref that names the Pokémon and the move (D2)
    for (const d of host.decisions.filter(d => d.key.kind === "LEARN_MOVE")) {
      expect(d.key.turn).toBe(0);
      expect(d.key.ref).toMatch(/^\d+:\d+$/);
    }
    // only turn commands and faint switches carry the turn
    for (const d of host.decisions.filter(d => d.key.kind === "TURN_COMMANDS" || d.key.kind === "FAINT_SWITCH")) {
      expect(d.key.turn).toBeGreaterThanOrEqual(1);
    }
    // the reward screens alternate between the seats, host first
    const pickers = host.decisions.filter(d => d.key.kind === "REWARD_PICK").map(d => d.by);
    expect(pickers).toEqual(pickers.map((_, i) => (i % 2 === 0 ? "host" : "guest")));
    expect(host.decisions.filter(d => d.key.kind === "REWARD_PICK").map(d => d.key.ref)).toEqual(
      pickers.map((_, i) => `${i}`),
    );
    // each slot is commanded by the owner of the Pokémon in it
    expect(new Set(host.decisions.filter(d => d.key.kind === "TURN_COMMANDS").map(d => d.by))).toEqual(
      new Set(["host", "guest"]),
    );
    // a reward pick (not a skip)
    expect(
      host.decisions.filter(
        d => d.key.kind === "REWARD_PICK" && (d.payload as { cursor: number | null }).cursor !== null,
      ).length,
    ).toBeGreaterThanOrEqual(1);
    // a faint and its replacement
    expect(host.replacements).toBe(1);
    expect(host.decisions.filter(d => d.key.kind === "FAINT_SWITCH")).toHaveLength(1);
    // all four hash points of D13 (+ the reward options of D9), waves 1 -> 2 -> 3 and on; wave 11 is the new biome
    const waveStarts = host.checkpoints.filter(c => c.kind === "waveStart");
    expect(waveStarts.map(c => c.wave)).toEqual(Array.from({ length: SCENARIO.waves + 1 }, (_, i) => i + 1));
    expect(waveStarts.map(c => c.phaseName)).toEqual([
      "EncounterPhase",
      ...Array.from({ length: SCENARIO.waves - 1 }, () => "NextEncounterPhase"),
      "NewBiomeEncounterPhase",
    ]);
    expect(host.checkpoints.filter(c => c.kind === "waveEnd").length).toBe(SCENARIO.waves);
    expect(host.checkpoints.filter(c => c.kind === "turn").length).toBeGreaterThanOrEqual(SCENARIO.waves);
    // the tenth wave has fixed rewards and no reward screen
    expect(host.checkpoints.filter(c => c.kind === "rewards").map(c => c.wave)).toEqual(
      Array.from({ length: SCENARIO.waves - 1 }, (_, i) => i + 1),
    );
    // the first starter is shiny on the host's account only
    expect(host.shinyIds).toContain(host.partyIds[0]);
  }

  it(
    "a guest with another account and other local settings replays the host's log to the same hashes",
    async () => {
      const { host, guest, shared } = await accountsAndShared();

      const recorded = await playClient(phaserGame, shared, host, Decider.recording(), SCENARIO);
      expectCoverage(recorded);

      const replayed = await playClient(
        phaserGame,
        shared,
        guest,
        Decider.replaying(recorded.decisions),
        SCENARIO,
        recorded.checkpoints,
      );

      expect(replayed.stalledIn).toBeNull();
      expect(replayed.divergence).toBeNull();
      expectSameCheckpoints(recorded, replayed);
      expect(replayed.checkpoints.map(c => c.hash)).toEqual(recorded.checkpoints.map(c => c.hash));
      // it really ran the same game: same party, same shiny first starter, same decisions in the same order
      expect(replayed.partyIds).toEqual(recorded.partyIds);
      expect(replayed.shinyIds).toEqual(recorded.shinyIds);
      expect(replayed.decisions).toEqual(recorded.decisions);
      expect(replayed.waves).toEqual(recorded.waves);
      // and the traces agree phase by phase
      const traceDiff = diffPhaseTraces(recorded.trace, replayed.trace);
      expect(traceDiff === null ? null : describePhaseTraceDiff(traceDiff)).toBeNull();
    },
    TEST_MS,
  );

  it(
    "plays with the real battle RNG, not the max rolls `GameManager` installs",
    async () => {
      const { host, shared } = await accountsAndShared();
      await playClient(phaserGame, shared, host, Decider.recording(), { ...SCENARIO, waves: 1 });

      const rolls = Array.from({ length: 30 }, () => globalScene.randBattleSeedInt(100));
      expect(new Set(rolls).size).toBeGreaterThan(5);
      expect(rolls.every(roll => roll === 99)).toBe(false);
    },
    TEST_MS,
  );

  it(
    "30 waves with reward screens, shop buys, a catch and two trades: the guest's hashes match",
    async () => {
      const { host, guest, shared } = await accountsAndShared();
      const long: Scenario = {
        ...SCENARIO,
        waves: 30,
        startingMoney: 100_000,
        // shop buys at these waves' reward screens: a Revive for the Pokémon that fainted in wave 4, then Potions
        buyAtWaves: [4, 5, 6, 12],
        catchFromWave: 14,
        // and two trades (D11): the host's first for the guest's first, then the guest's for the host's
        tradeAtWaves: [3, 12],
      };

      const recorded = await playClient(phaserGame, shared, host, Decider.recording(), long);
      expect(recorded.stalledIn).toBeNull();
      // reward screens alternate (the tenth, twentieth and thirtieth waves have fixed rewards and no screen)
      const picks = recorded.decisions.filter(d => d.key.kind === "REWARD_PICK");
      expect(picks).toHaveLength(27);
      expect(picks.map(d => d.by)).toEqual(picks.map((_, i) => (i % 2 === 0 ? "host" : "guest")));
      expect(picks.map(d => d.key.ref)).toEqual(picks.map((_, i) => `${i}`));
      // shop buys, by either seat, keyed by the screen and the step (D9)
      expect(recorded.shopBuys).toBeGreaterThanOrEqual(1);
      const buys = recorded.decisions.filter(d => d.key.kind === "SHOP_BUY");
      expect(buys.length).toBeGreaterThanOrEqual(1);
      for (const buy of buys) {
        expect(buy.by).toBe("either");
        expect(buy.key.ref).toMatch(/^\d+:0$/);
      }
      // a catch, at a wild wave: the party has one more Pokémon than the four starters
      expect(recorded.catches).toBe(1);
      expect(recorded.finalParty).toHaveLength(5);
      // the trades: both clients made both, and the owners are what the trades left (the same on both clients below)
      expect(recorded.trades).toBe(2);
      expect(recorded.decisions.filter(d => d.key.kind === "TRADE_PROPOSE").map(d => d.by)).toEqual(["host", "guest"]);
      expect(recorded.decisions.filter(d => d.key.kind === "TRADE_ACCEPT").map(d => d.by)).toEqual(["guest", "host"]);
      // the four starters are still there (a faint switch reorders the party), and everyone, the catch too, has an owner
      expect(recorded.finalParty.map(p => p.id)).toEqual(expect.arrayContaining(recorded.partyIds));
      expect(recorded.finalParty.filter(p => p.owner === null)).toHaveLength(0);
      expect(
        recorded.decisions.some(d => d.key.kind === "TURN_COMMANDS" && (d.payload as TurnPayload).ball !== undefined),
      ).toBe(true);
      expect(recorded.waves).toHaveLength(30);

      const replayed = await playClient(
        phaserGame,
        shared,
        guest,
        Decider.replaying(recorded.decisions),
        long,
        recorded.checkpoints,
      );

      expect(replayed.stalledIn).toBeNull();
      expect(replayed.divergence).toBeNull();
      expectSameCheckpoints(recorded, replayed);
      expect(replayed.checkpoints.map(c => c.hash)).toEqual(recorded.checkpoints.map(c => c.hash));
      expect(replayed.partyIds).toEqual(recorded.partyIds);
      expect(replayed.finalParty).toEqual(recorded.finalParty);
      expect(replayed.decisions).toEqual(recorded.decisions);
      expect(replayed.catches).toBe(1);
      expect(replayed.trades).toBe(2);
      expect(replayed.shopBuys).toBe(recorded.shopBuys);
      const traceDiff = diffPhaseTraces(recorded.trace, replayed.trace);
      expect(traceDiff === null ? null : describePhaseTraceDiff(traceDiff)).toBeNull();
    },
    TEST_MS,
  );

  it(
    "30 waves with a forced resync in the middle: both clients reload the wave start and stay green, as a client that never reloaded",
    async () => {
      const { host, guest, shared } = await accountsAndShared();
      const long: Scenario = {
        ...SCENARIO,
        waves: 30,
        startingMoney: 100_000,
        buyAtWaves: [4, 5, 6, 12],
        catchFromWave: 14,
        tradeAtWaves: [3, 12],
      };
      // wave 13 starts again from its saved start, on both clients. (Not after the catch of wave 14: a Pokémon that was caught
      // comes with the HP of the wild one, above its own maximum, and a reload clamps it. Both clients reload, so they agree.)
      const resynced: Scenario = { ...long, resyncAtWaves: [13] };

      const never = await playClient(phaserGame, shared, host, Decider.recording(), long);
      expect(never.stalledIn).toBeNull();

      const recorded = await playClient(phaserGame, shared, host, Decider.recording(), resynced);
      expect(recorded.stalledIn).toBeNull();
      expect(recorded.resyncs).toBe(1);
      // the reload is faithful: the wave starts again with the very state it started with, and the run goes on as if it had
      // never happened (every later hash is the one of the client that did not reload)
      const starts = recorded.checkpoints.filter(c => c.kind === "waveStart" && c.wave === 13);
      expect(starts).toHaveLength(2);
      const [before, after] = recorded.waveStarts.filter(entry => entry.wave === 13);
      expect(after.snapshot, "the state after the reload, against the state before it").toEqual(before.snapshot);
      expect(starts[1].hash).toBe(starts[0].hash);
      // (the reload takes the wave's first checkpoints again: the start, and the start of turn 1, with the hashes of before)
      const reloaded = recorded.checkpoints.indexOf(starts[1]);
      const [startAgain, turnAgain] = recorded.checkpoints.slice(reloaded, reloaded + 2);
      const turnBefore = recorded.checkpoints.find(c => c.kind === "turn" && c.wave === 13 && c.turn === 1)!;
      expect([turnAgain.kind, turnAgain.wave, turnAgain.turn, turnAgain.hash]).toEqual([
        "turn",
        13,
        1,
        turnBefore.hash,
      ]);
      expect(startAgain.hash).toBe(starts[0].hash);
      const withoutReload = recorded.checkpoints.filter((_, i) => i !== reloaded && i !== reloaded + 1);
      expect(withoutReload.map(c => [c.kind, c.wave, c.turn, c.hash])).toEqual(
        never.checkpoints.map(c => [c.kind, c.wave, c.turn, c.hash]),
      );
      expect(recorded.decisions).toEqual(never.decisions);

      // the guest reloads the HOST's save of the wave (D13), and its hashes match the host's, reload included
      const replayed = await playClient(
        phaserGame,
        shared,
        guest,
        Decider.replaying(recorded.decisions),
        { ...resynced, resyncSaves: recorded.waveSaves },
        recorded.checkpoints,
      );
      expect(replayed.stalledIn).toBeNull();
      expect(replayed.divergence).toBeNull();
      expect(replayed.resyncs).toBe(1);
      expectSameCheckpoints(recorded, replayed);
      expect(replayed.checkpoints.map(c => c.hash)).toEqual(recorded.checkpoints.map(c => c.hash));
      expect(replayed.decisions).toEqual(recorded.decisions);
      expect(replayed.finalParty).toEqual(recorded.finalParty);
    },
    TEST_MS,
  );

  describe("the end of the run is shared (D4a)", () => {
    async function bothEnd(scenario: Scenario): Promise<{ recorded: ClientReport; replayed: ClientReport }> {
      const { host, guest, shared } = await accountsAndShared();
      const recorded = await playClient(phaserGame, shared, host, Decider.recording(), scenario);
      const replayed = await playClient(
        phaserGame,
        shared,
        guest,
        Decider.replaying(recorded.decisions),
        scenario,
        recorded.checkpoints,
      );
      expect(recorded.stalledIn).toBeNull();
      expect(replayed.stalledIn).toBeNull();
      expect(replayed.divergence).toBeNull();
      expectSameCheckpoints(recorded, replayed);
      return { recorded, replayed };
    }

    it(
      "the final boss wave is two of ours against one boss, and both clients reach the victory",
      async () => {
        const { recorded, replayed } = await bothEnd({
          ...SCENARIO,
          waves: 1,
          faints: [],
          configure: game => game.override.startingLevel(10000).startingWave(200).startingBiome(BiomeId.END),
        });
        for (const client of [recorded, replayed]) {
          expect(client.gameOver).toEqual({ victory: true, wave: 200 });
          expect(client.waves).toHaveLength(1);
          expect(client.waves[0]).toMatchObject({ wave: 200, double: true, enemyField: 1 });
          expect(client.waves[0].onField).toHaveLength(2);
          // each player commands one of the two
          expect(new Set(client.waves[0].controllers)).toEqual(new Set(["host", "guest"]));
        }
        expect(replayed.decisions).toEqual(recorded.decisions);
      },
      TEST_MS,
    );

    it(
      "a wipe is a game over for both clients",
      async () => {
        const { recorded, replayed } = await bothEnd({
          ...SCENARIO,
          waves: 1,
          // all four starters use Memento in turns 1 to 3 (two at a time, the bench comes in after each)
          faints: [1, 2, 3].map(turn => ({ wave: 1, turn, slots: [0, 1] as (0 | 1)[] })),
        });
        for (const client of [recorded, replayed]) {
          expect(client.gameOver).toEqual({ victory: false, wave: 1 });
        }
        expect(replayed.decisions).toEqual(recorded.decisions);
      },
      TEST_MS,
    );
  });

  describe("negative: what the pins and the snapshot protect against must fail at the first checkpoint", () => {
    it(
      "(a) a guest that reads its own TID/SID instead of the snapshot diverges at wave 1's first checkpoint",
      async () => {
        const { host, guest, shared } = await accountsAndShared();
        const recorded = await playClient(phaserGame, shared, host, Decider.recording(), { ...SCENARIO, waves: 2 });

        const bypassing = await playClient(
          phaserGame,
          shared,
          { ...guest, bypassSnapshot: true },
          Decider.replaying(recorded.decisions),
          { ...SCENARIO, waves: 2 },
          recorded.checkpoints,
        );

        // it is not shiny on the guest's own account: another game from the first Pokémon on
        expect(recorded.shinyIds).toContain(recorded.partyIds[0]);
        expect(bypassing.shinyIds).not.toContain(recorded.partyIds[0]);
        // and it stopped at the very first checkpoint, which names the phase
        expect(bypassing.divergence).toMatchObject({ kind: "checkpoint", mismatch: { index: 0 } });
        expect(bypassing.checkpoints).toHaveLength(1);
        expect(() => expectSameCheckpoints(recorded, bypassing)).toThrow(
          /checkpoint #0 differs \(hash\).*waveStart@EncounterPhase.*first differing checkpoint was taken in EncounterPhase/s,
        );
      },
      TEST_MS,
    );

    it(
      "(b) a guest with tutorials enabled (the pin bypassed) diverges at wave 1's first checkpoint",
      async () => {
        const { host, shared } = await accountsAndShared();
        const recorded = await playClient(phaserGame, shared, host, Decider.recording(), { ...SCENARIO, waves: 2 });

        const tutorials = await playClient(
          phaserGame,
          shared,
          {
            seat: "guest",
            liveAccount: host.liveAccount,
            localSettings: { general: { enableTutorials: true } },
            applyOverlay: false,
            bypassSnapshot: false,
            stallMs: STALL_MS,
          },
          Decider.replaying(recorded.decisions),
          { ...SCENARIO, waves: 2 },
          recorded.checkpoints,
        );

        // everything else is the same: the simulation, the account, the decisions. Only the setting differs, and the
        // state hash covers the pinned settings, so the first checkpoint catches it and names its phase.
        expect(tutorials.divergence).toMatchObject({ kind: "checkpoint", mismatch: { index: 0 } });
        expect(tutorials.checkpoints).toHaveLength(1);
        expect(() => expectSameCheckpoints(recorded, tutorials)).toThrow(
          /checkpoint #0 differs \(hash\).*waveStart@EncounterPhase.*first differing checkpoint was taken in EncounterPhase/s,
        );
        // the phase trace agrees up to there: it is not the RNG that differs
        expect(diffPhaseTraces(recorded.trace.slice(0, tutorials.trace.length), tutorials.trace)).toBeNull();
      },
      TEST_MS,
    );

    it(
      "(c) the same two guests pass when nothing is bypassed: the pins and the snapshot are what make the runs equal",
      async () => {
        const { host, guest, shared } = await accountsAndShared();
        const recorded = await playClient(phaserGame, shared, host, Decider.recording(), { ...SCENARIO, waves: 2 });
        const replayed = await playClient(
          phaserGame,
          shared,
          { ...guest, localSettings: { general: { ...guest.localSettings.general, enableTutorials: true } } },
          Decider.replaying(recorded.decisions),
          { ...SCENARIO, waves: 2 },
          recorded.checkpoints,
        );
        expect(replayed.divergence).toBeNull();
        expectSameCheckpoints(recorded, replayed);
      },
      TEST_MS,
    );
  });
});
