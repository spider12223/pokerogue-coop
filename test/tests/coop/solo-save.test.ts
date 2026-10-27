/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { COOP_SAVE_VERSION, CoopSaveRefusedError } from "#coop/save-block";
import { isCoop } from "#coop/session";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import type { SessionSaveData } from "#types/save-data";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** A solo run saves exactly what it did before, and a co-op save is never continued as a solo run. */
describe("Solo play: the session save", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;
  let saved: SessionSaveData;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(async () => {
    game = new GameManager(phaserGame);
    await game.classicMode.startBattle(SpeciesId.PIKACHU);
    saved = game.scene.gameData.getSessionSaveData();
  });

  it("has no co-op block", () => {
    expect(isCoop()).toBe(false);
    expect(Object.hasOwn(saved, "coop")).toBe(false);
  });

  it("loads back as before", async () => {
    const parsed = game.scene.gameData.parseSessionData(
      JSON.stringify(saved, (_, value) => (typeof value === "bigint" ? value.toString() : value)),
    );
    vi.spyOn(game.scene.gameData, "getSession").mockResolvedValue(parsed);

    await expect(game.scene.gameData.loadSession(0)).resolves.toBe(true);
    expect(isCoop()).toBe(false);
  });

  it("refuses a co-op save, with the reason, and loads nothing", async () => {
    const account = {
      trainerId: 1,
      secretId: 2,
      unlocked: { eviolite: false, miniBlackHole: false },
      caught: {},
      eggMoves: {},
    };
    const coopSave: SessionSaveData = {
      ...saved,
      coop: {
        version: COOP_SAVE_VERSION,
        accountIds: { host: "h", guest: "g" },
        owners: { [saved.party[0].id]: "host" },
        rewardPickCount: 0,
        trades: 0,
        accounts: { host: account, guest: account },
      },
    };
    vi.spyOn(game.scene.gameData, "getSession").mockResolvedValue(coopSave);
    const partyBefore = game.scene.getPlayerParty().slice();

    await expect(game.scene.gameData.loadSession(0)).rejects.toThrow(CoopSaveRefusedError);
    await expect(game.scene.gameData.loadSession(0)).rejects.toThrow("co-op run");
    expect(game.scene.getPlayerParty()).toEqual(partyBefore);
    expect(isCoop()).toBe(false);
  });
});
