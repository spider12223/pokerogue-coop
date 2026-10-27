/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { requireCoopSession } from "#coop/session";
import { MoveId } from "#enums/move-id";
import { PartyUiMode } from "#enums/party-ui-mode";
import { PlayerGender } from "#enums/player-gender";
import { SpeciesId } from "#enums/species-id";
import {
  accountWith,
  advanceTo,
  type ClientConfig,
  type CoopRun,
  Decider,
  openCoopRun,
  playWave,
  queueTurnCommands,
  type Scenario,
  type SharedRun,
} from "#test/helpers/coop-harness";
import { PartyUiHandler } from "#ui/party-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Who replaces a Pokémon that faints (DECISIONS D7), and the wave-start arrange step after faints.
 * Starters are named by owner: H1 is the host's first, G1 the guest's first.
 */

const ACCOUNT = accountWith({ trainerId: 111, secretId: 222 });

const SHARED: SharedRun = {
  runSeed: "co-op-m3-faints",
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

const SPECIES = [
  SpeciesId.BULBASAUR,
  SpeciesId.SQUIRTLE,
  SpeciesId.CHARMANDER,
  SpeciesId.PIKACHU,
  SpeciesId.MACHOP,
  SpeciesId.GEODUDE,
];

function scenario(overrides: Partial<Scenario>): Scenario {
  return {
    species: SPECIES,
    waves: 0,
    // Bite is Dark: nothing is immune to it
    moveset: [MoveId.BITE, MoveId.MEMENTO, MoveId.GROWL, MoveId.TAIL_WHIP],
    faints: [],
    faintMove: MoveId.MEMENTO,
    starterOwners: ["host", "guest", "host", "guest", "host", "guest"],
    ...overrides,
  };
}

const MINUTES = 60_000;

describe("Co-op: faint rules and the wave-start arrange step (D7)", () => {
  let phaserGame: Phaser.Game;
  let run: CoopRun | null = null;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    run?.close();
    run = null;
    vi.restoreAllMocks();
  });

  /** The Pokémon under the cursor each time the party screen of a faint switch opened */
  function watchFaintSwitchCursor(): number[] {
    const opened: number[] = [];
    const show = PartyUiHandler.prototype.show;
    vi.spyOn(PartyUiHandler.prototype, "show").mockImplementation(function (this: PartyUiHandler, args: any[]) {
      const shown = show.call(this, args);
      if (shown && args[0] === PartyUiMode.FAINT_SWITCH) {
        opened.push(globalScene.getPlayerParty()[this.getCursor()].id);
      }
      return shown;
    });
    return opened;
  }

  async function start(overrides: Partial<Scenario>): Promise<CoopRun> {
    run = await openCoopRun(phaserGame, SHARED, HOST, Decider.recording(), scenario(overrides));
    return run;
  }

  /** Play waves `1..waves` and return the ids of the starters in party order, by name (H1, G1, H2, ...) */
  async function playWaves(r: CoopRun, waves: number) {
    const { ctx } = r;
    const counts = { host: 0, guest: 0 };
    const names = new Map(
      ctx.game.scene.getPlayerParty().map(p => {
        const seat = requireCoopSession().ownership.require(p.id);
        return [p.id, `${seat === "host" ? "H" : "G"}${++counts[seat]}`] as const;
      }),
    );
    for (let wave = 1; wave <= waves; wave++) {
      await advanceTo(ctx, ["CommandPhase"]);
      await playWave(ctx);
    }
    return (ids: readonly number[]) => ids.map(id => names.get(id));
  }

  it(
    "(a) the owner's bench refills the slot",
    async () => {
      const r = await start({ faints: [{ wave: 1, turn: 1, slots: [1] }] });
      const initialOwners = requireCoopSession().ownership.toJSON();
      const opened = watchFaintSwitchCursor();
      const nameOf = await playWaves(r, 2);
      const { report } = r.ctx;

      expect(report.stalledIn).toBeNull();
      expect(report.replacementLog).toHaveLength(1);
      const [swap] = report.replacementLog;
      // the guest's Pokémon in slot 1 fainted, the guest picked, from the guest's bench
      expect(nameOf([swap.fainted, swap.chosen])).toEqual(["G1", "G2"]);
      // the party screen opened on the first that may go in, not on the field
      expect(nameOf(opened)).toEqual(["G2"]);
      expect(swap.by).toBe("guest");
      expect(requireCoopSession().ownership.toJSON()).toEqual(initialOwners);
      // the decision is the guest's, keyed by the fainted Pokémon; the replacement is asked after the turn's end phase
      // advanced the turn, on every client alike
      const decision = r.ctx.decider.decisions.find(d => d.key.kind === "FAINT_SWITCH")!;
      expect(decision).toMatchObject({ by: "guest", key: { wave: 1, turn: 2, ref: swap.fainted } });
      // the next wave: each seat has a Pokémon in its slot again
      expect(report.waves[1].controllers).toEqual(["host", "guest"]);
    },
    5 * MINUTES,
  );

  it(
    "(b) the owner has no bench: the partner's bench fills the slot and nobody changes owner",
    async () => {
      // the guest brings one Pokémon, the host five
      const r = await start({
        species: SPECIES.slice(0, 4),
        starterOwners: ["host", "guest", "host", "host"],
        faints: [{ wave: 1, turn: 1, slots: [1] }],
      });
      const initialOwners = requireCoopSession().ownership.toJSON();
      const opened = watchFaintSwitchCursor();
      const nameOf = await playWaves(r, 1);
      const { report } = r.ctx;

      expect(report.stalledIn).toBeNull();
      const [swap] = report.replacementLog;
      expect(nameOf([swap.fainted, swap.chosen])).toEqual(["G1", "H2"]);
      // the host chooses for the guest's slot: the screen opens on the host's bench, not on the field
      expect(nameOf(opened)).toEqual(["H2"]);
      expect(swap.by).toBe("host");
      expect(r.ctx.decider.decisions.find(d => d.key.kind === "FAINT_SWITCH")).toMatchObject({ by: "host" });
      // the Pokémon that came in is still the host's; the guest's fainted one is still the guest's
      expect(requireCoopSession().ownership.toJSON()).toEqual(initialOwners);
      expect(requireCoopSession().ownership.get(swap.fainted)).toBe("guest");
      expect(requireCoopSession().ownership.get(swap.chosen)).toBe("host");
    },
    5 * MINUTES,
  );

  it(
    "(c) one seat is wiped: the partner covers both slots, for the commands too",
    async () => {
      const r = await start({
        species: SPECIES.slice(0, 4),
        starterOwners: ["host", "guest", "host", "host"],
        faints: [{ wave: 1, turn: 1, slots: [1] }],
      });
      await playWaves(r, 3);
      const { report } = r.ctx;

      expect(report.stalledIn).toBeNull();
      // wave 1 started with one of each; after the guest's only Pokémon fainted the host has both slots
      expect(report.waves[0].controllers).toEqual(["host", "guest"]);
      expect(report.waves[1].controllers).toEqual(["host", "host"]);
      expect(report.waves[2].controllers).toEqual(["host", "host"]);
      expect(report.waves[1].legalBySeat).toEqual({ host: 3, guest: 0 });
      // and every command of those waves was the host's
      const later = r.ctx.decider.decisions.filter(d => d.key.kind === "TURN_COMMANDS" && d.key.wave >= 2);
      expect(later.length).toBeGreaterThanOrEqual(4);
      expect(later.every(d => d.by === "host")).toBe(true);
    },
    5 * MINUTES,
  );

  it(
    "(d) a full wipe is a game over: nobody is asked for a replacement",
    async () => {
      const r = await start({
        species: SPECIES.slice(0, 2),
        starterOwners: ["host", "guest"],
        faints: [{ wave: 1, turn: 1, slots: [0, 1] }],
      });
      const { ctx } = r;
      await advanceTo(ctx, ["CommandPhase"]);
      queueTurnCommands(ctx);

      const reached = await advanceTo(ctx, ["GameOverPhase", "TurnInitPhase", "SelectModifierPhase"]);

      expect(reached).toBe("GameOverPhase");
      expect(ctx.game.scene.getPokemonAllowedInBattle()).toHaveLength(0);
      expect(ctx.report.replacementLog).toEqual([]);
      expect(ctx.decider.decisions.filter(d => d.key.kind === "FAINT_SWITCH")).toEqual([]);
    },
    5 * MINUTES,
  );

  it(
    "the arrange step after mixed faints across waves: each seat's first legal Pokémon in its slot, the partner covers a wiped seat",
    async () => {
      // the guest loses its Pokémon one by one, the host loses its first
      const r = await start({
        faints: [
          { wave: 2, turn: 1, slots: [1] }, // G1 -> G2
          { wave: 3, turn: 1, slots: [0] }, // H1 -> H2
          { wave: 4, turn: 1, slots: [1] }, // G2 -> G3
          { wave: 5, turn: 1, slots: [1] }, // G3 -> nobody of the guest's: H3 from the partner's bench
        ],
      });
      const initialOwners = requireCoopSession().ownership.toJSON();
      const nameOf = await playWaves(r, 7);
      const { report } = r.ctx;

      expect(report.stalledIn).toBeNull();
      expect(report.replacementLog.map(s => nameOf([s.fainted, s.chosen]))).toEqual([
        ["G1", "G2"],
        ["H1", "H2"],
        ["G2", "G3"],
        ["G3", "H3"],
      ]);
      expect(report.replacementLog.map(s => s.by)).toEqual(["guest", "host", "guest", "host"]);

      // At every wave start the slots hold what the rule says, whoever was on the field before
      for (const wave of report.waves) {
        const { host, guest } = wave.legalBySeat;
        const expected =
          host > 0 && guest > 0
            ? ["host", "guest"]
            : host > 1
              ? ["host", "host"]
              : guest > 1
                ? ["guest", "guest"]
                : ["host"];
        expect(wave.controllers, `wave ${wave.wave} (${host} host, ${guest} guest left)`).toEqual(expected);
        // the slot Pokémon are the first two of the party, and they are the ones on the field
        expect(wave.onField.slice().sort(), `wave ${wave.wave}`).toEqual(wave.partyOrder.slice(0, 2).sort());
      }
      // the seats ran out in this order
      expect(report.waves.map(w => w.legalBySeat.guest)).toEqual([3, 3, 2, 2, 1, 0, 0]);
      // the guest is wiped from wave 6 on: the host commands both slots there
      expect(report.waves[5].controllers).toEqual(["host", "host"]);
      expect(report.waves[6].controllers).toEqual(["host", "host"]);
      // ownership never changed
      expect(requireCoopSession().ownership.toJSON()).toEqual(initialOwners);
    },
    10 * MINUTES,
  );

  it(
    "a revived Pokémon takes its seat's slot back at the next wave, and the one that covered for it is recalled",
    async () => {
      const r = await start({
        species: SPECIES.slice(0, 4),
        starterOwners: ["host", "guest", "host", "host"],
        faints: [{ wave: 1, turn: 1, slots: [1] }],
        afterWave: ({ game }, wave) => {
          if (wave !== 1) {
            return;
          }
          // the guest's Pokémon that fainted in wave 1 is revived before wave 2
          const fainted = game.scene.getPlayerParty().find(p => p.isFainted())!;
          fainted.resetStatus(true, false, false, false);
          fainted.hp = fainted.getMaxHp();
        },
      });
      const initialOwners = requireCoopSession().ownership.toJSON();
      const nameOf = await playWaves(r, 2);
      const { report } = r.ctx;

      expect(report.stalledIn).toBeNull();
      // wave 1: H1 and G1; G1 fainted and H2 covered for the guest
      const [swap] = report.replacementLog;
      expect(nameOf([swap.fainted, swap.chosen])).toEqual(["G1", "H2"]);
      // wave 2: G1 is back in the guest's slot and H2 is off the field again
      expect(report.waves[1].controllers).toEqual(["host", "guest"]);
      expect(report.waves[1].partyOrder.slice(0, 2).map(id => nameOf([id])[0])).toEqual(["H1", "G1"]);
      expect(report.waves[1].onField.map(id => nameOf([id])[0]).sort()).toEqual(["G1", "H1"]);
      expect(requireCoopSession().ownership.toJSON()).toEqual(initialOwners);
    },
    5 * MINUTES,
  );
});
