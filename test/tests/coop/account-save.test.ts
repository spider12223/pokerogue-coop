/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { getCoopSession } from "#coop/session";
import { MoveId } from "#enums/move-id";
import { PlayerGender } from "#enums/player-gender";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import {
  accountWith,
  advanceTo,
  type ClientConfig,
  type CoopRun,
  Decider,
  openCoopRun,
  playWave,
  type SharedRun,
} from "#test/helpers/coop-harness";
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
