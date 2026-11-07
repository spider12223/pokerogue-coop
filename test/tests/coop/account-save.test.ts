/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { loggedInUser } from "#app/account";
import { ownerOf } from "#coop/decisions/control";
import { getCoopSession } from "#coop/session";
import { MoveId } from "#enums/move-id";
import { PlayerGender } from "#enums/player-gender";
import { PokeballType } from "#enums/pokeball";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import {
  accountWith,
  advanceTo,
  type ClientConfig,
  type CoopRun,
  Decider,
  openCoopRun,
  openUi,
  playWave,
  type SharedRun,
} from "#test/helpers/coop-harness";
import {
  ballThrowingPartner,
  type LinkedRun,
  openLinkedRun,
  pickerSkips,
  toTurnWithOneEnemy,
} from "#test/helpers/coop-linked";
import { decrypt } from "#utils/data";
import i18next from "i18next";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Each player's own account in a co-op run (DECISIONS D19, D30): what the run gives it (caught Pokémon, which the starter
 * select shows; candies, eggs, vouchers) is saved at every wave start, as a solo run's `saveAll` saves it, and not only
 * when the run ends. Save and Quit saves it too, and never writes the run into a solo slot.
 */

const ACCOUNT = accountWith({ trainerId: 333, secretId: 444 });

const SHARED: SharedRun = {
  runSeed: "co-op-account-save",
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

/** A co-op run takes a while to open on a loaded machine: the full suite runs many files at once */
const MINUTES = 60_000;

describe("Co-op: each player's account is saved during the run", () => {
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

  async function start(): Promise<CoopRun> {
    run = await openCoopRun(phaserGame, SHARED, HOST, Decider.recording(), {
      species: [SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER, SpeciesId.PIKACHU],
      waves: 0,
      moveset: [MoveId.BITE, MoveId.MEMENTO, MoveId.GROWL, MoveId.TAIL_WHIP],
      faints: [],
      faintMove: MoveId.MEMENTO,
      starterOwners: ["host", "guest", "host", "guest"],
    });
    return run;
  }

  it(
    "at every wave start, so a catch reaches the starter select before the run ends",
    async () => {
      const r = await start();
      const { ctx } = r;
      const saved = vi.spyOn(ctx.game.scene.gameData, "saveSystem");
      const waveStarts = (): number => saved.mock.calls.length;

      await advanceTo(ctx, ["CommandPhase"]);
      const atFirst = waveStarts();
      for (let wave = 1; wave <= 3; wave++) {
        await advanceTo(ctx, ["CommandPhase"]);
        await playWave(ctx);
      }
      await advanceTo(ctx, ["CommandPhase"]);
      // waves 2, 3 and 4 started: the account was saved at each
      expect(waveStarts() - atFirst).toBeGreaterThanOrEqual(3);
    },
    5 * MINUTES,
  );

  it(
    "Save and Quit saves this player's account, ends the session, and writes no solo slot",
    async () => {
      const r = await start();
      const { ctx } = r;
      const { gameData, ui } = ctx.game.scene;
      await advanceTo(ctx, ["CommandPhase"]);
      const saveAll = vi.spyOn(gameData, "saveAll");
      const saveSystem = vi.spyOn(gameData, "saveSystem").mockResolvedValue(true);

      await ui.setOverlayMode(UiMode.MENU);
      const menu = ui.handlers[UiMode.MENU] as unknown as {
        getMenuOptionsConfig(): { options: { label: string; handler: () => boolean }[] };
      };
      const saveAndQuit = menu
        .getMenuOptionsConfig()
        .options.find(option => option.label === i18next.t("menuUiHandler:saveAndQuit"));
      expect(saveAndQuit).toBeDefined();
      saveAndQuit!.handler();

      await vi.waitUntil(() => getCoopSession() === null, { interval: 10, timeout: 4000 });
      expect(saveSystem).toHaveBeenCalled();
      expect(saveAll).not.toHaveBeenCalled();
    },
    5 * MINUTES,
  );
});

describe("Co-op: what a player catches is in the account their browser saves (D4a, D19)", () => {
  let phaserGame: Phaser.Game;
  let run: LinkedRun | null = null;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    run?.close();
    run = null;
    vi.restoreAllMocks();
  });

  /** @returns The account this browser saved last, as the next start of the game loads it */
  function savedAccount(): {
    dexData: Record<number, { caughtCount: number; caughtAttr: number | string }>;
    starterData: Record<number, { candyCount: number }>;
  } {
    const stored = localStorage.getItem(`data_${loggedInUser?.username}`);
    expect(stored).toBeTruthy();
    return JSON.parse(decrypt(stored!, true));
  }

  // A player's report: the second player got no candies and none of their catches on their account. The guest's own
  // catch must reach the guest's saved account as the host's reaches the host's.
  it.each(["host", "guest"] as const)(
    "the %s throws the ball: the catch and its candy are in their saved account from the next wave start",
    async seat => {
      let r: LinkedRun | null = null;
      const partner = ballThrowingPartner(() => r!);
      r = await openLinkedRun(phaserGame, {
        seat,
        species: [SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER, SpeciesId.PIKACHU],
        starterOwners: ["host", "guest", "host", "guest"],
        configure: game => game.override.startingLevel(40),
        policy: partner.policy,
      });
      run = r;
      await toTurnWithOneEnemy(r);
      const { game } = r.ctx;
      const [enemy] = game.scene.getEnemyField().filter(e => e.isActive(true));
      const species = enemy.species.speciesId;
      const root = enemy.species.getRootSpeciesId(true);
      const { gameData } = game.scene;
      const caughtBefore = gameData.dexData[species].caughtCount;
      const candyBefore = gameData.starterData[root].candyCount;

      game.doThrowPokeball(PokeballType.MASTER_BALL);
      await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);
      expect(ownerOf(game.scene.getPlayerParty().at(-1)!)).toBe(seat);
      await openUi(r.ctx, "SelectModifierPhase");
      pickerSkips(r);
      await advanceTo(r.ctx, ["CommandPhase"]);

      expect(game.scene.currentBattle.waveIndex).toBe(2);
      const saved = savedAccount();
      expect(saved.dexData[species].caughtCount).toBe(caughtBefore + 1);
      expect(Number(saved.dexData[species].caughtAttr)).toBeGreaterThan(0);
      expect(saved.starterData[root].candyCount).toBeGreaterThan(candyBefore);
      expect(r.session.desyncMessage).toBeNull();
    },
    5 * MINUTES,
  );
});
