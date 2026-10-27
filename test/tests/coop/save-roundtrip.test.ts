/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { CoopSaveRefusedError, isCoopSaveBlock } from "#coop/save-block";
import { endCoopSession, isCoop, requireCoopSession } from "#coop/session";
import { MoveId } from "#enums/move-id";
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
  type SharedRun,
} from "#test/helpers/coop-harness";
import type { SessionSaveData } from "#types/save-data";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The co-op block of the session save. A co-op save loads back into a co-op session with the same owners and the
 * same reward counter, and is refused by a solo game; a solo save is refused by a co-op session.
 */

const ACCOUNT = accountWith({ trainerId: 111, secretId: 222 });

const SHARED: SharedRun = {
  runSeed: "co-op-m3-save",
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

const WAVES_PLAYED = 3;

describe("Co-op: the session save and its co-op block (D4, D7, D9)", () => {
  let phaserGame: Phaser.Game;
  let run: CoopRun;
  /** The save as the game writes it, and as it reads it back */
  let saved: SessionSaveData;
  let loaded: SessionSaveData;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(async () => {
    run = await openCoopRun(phaserGame, SHARED, HOST, Decider.recording(), {
      species: [
        SpeciesId.BULBASAUR,
        SpeciesId.SQUIRTLE,
        SpeciesId.CHARMANDER,
        SpeciesId.PIKACHU,
        SpeciesId.MACHOP,
        SpeciesId.GEODUDE,
      ],
      waves: 0,
      moveset: [MoveId.BITE, MoveId.MEMENTO, MoveId.GROWL, MoveId.TAIL_WHIP],
      // a guest Pokémon faints in wave 2, so the party is not in its starting order any more
      faints: [{ wave: 2, turn: 1, slots: [1] }],
      faintMove: MoveId.MEMENTO,
      starterOwners: ["host", "guest", "host", "guest", "host", "guest"],
    });
    const { ctx } = run;
    for (let wave = 1; wave <= WAVES_PLAYED; wave++) {
      await advanceTo(ctx, ["CommandPhase"]);
      if (wave < WAVES_PLAYED) {
        await playWave(ctx);
      }
    }
    const { gameData } = ctx.game.scene;
    saved = gameData.getSessionSaveData();
    loaded = gameData.parseSessionData(
      JSON.stringify(saved, (_, value) => (typeof value === "bigint" ? value.toString() : value)),
    );
  });

  afterEach(() => {
    run.close();
    vi.restoreAllMocks();
  });

  it("writes a co-op block with the owners of the party, the reward counter and the two accounts", () => {
    const session = requireCoopSession();
    const partyIds = run.ctx.game.scene.getPlayerParty().map(p => p.id);

    expect(isCoopSaveBlock(saved.coop)).toBe(true);
    const block = saved.coop!;
    expect(Object.keys(block.owners).map(Number).sort()).toEqual([...partyIds].sort());
    expect(block.owners).toEqual(session.ownership.toJSON());
    expect(block.rewardPickCount).toBe(session.rewardPickCount);
    expect(block.rewardPickCount).toBeGreaterThanOrEqual(WAVES_PLAYED - 1);
    expect(block.accounts).toEqual(session.accountSnapshot);
  });

  it("survives the save's JSON", () => {
    expect(loaded.coop).toEqual(saved.coop);
    expect(loaded.party.map(p => p.id)).toEqual(saved.party.map(p => p.id));
  });

  it("loads back into the co-op session: the same owners, the same counter, the same party order", async () => {
    const { game } = run.ctx;
    const session = requireCoopSession();
    const owners = session.ownership.toJSON();
    const { rewardPickCount } = session;
    const partyOrder = game.scene.getPlayerParty().map(p => p.id);

    // forget what the save knows
    session.ownership.retain([]);
    session.rewardPickCount = 0;
    vi.spyOn(game.scene.gameData, "getSession").mockResolvedValue(loaded);

    await expect(game.scene.gameData.loadSession(0)).resolves.toBe(true);

    expect(isCoop()).toBe(true);
    expect(requireCoopSession().ownership.toJSON()).toEqual(owners);
    expect(requireCoopSession().rewardPickCount).toBe(rewardPickCount);
    expect(game.scene.getPlayerParty().map(p => p.id)).toEqual(partyOrder);
    // the next reward screen is the next picker's, as if the run had never stopped
    expect(requireCoopSession().beginRewardScreen().index).toBe(rewardPickCount);
  });

  it("is never continued as a solo run", async () => {
    const { game } = run.ctx;
    vi.spyOn(game.scene.gameData, "getSession").mockResolvedValue(loaded);
    endCoopSession();

    await expect(game.scene.gameData.loadSession(0)).rejects.toThrow(CoopSaveRefusedError);
    await expect(game.scene.gameData.loadSession(0)).rejects.toThrow("co-op run");
    // and nothing was loaded: no co-op game mode, no session
    expect(isCoop()).toBe(false);
  });

  it("does not take a solo save into a co-op session", async () => {
    const { game } = run.ctx;
    const solo: SessionSaveData = { ...loaded };
    delete solo.coop;
    vi.spyOn(game.scene.gameData, "getSession").mockResolvedValue(solo);
    const owners = requireCoopSession().ownership.toJSON();

    await expect(game.scene.gameData.loadSession(0)).rejects.toThrow(CoopSaveRefusedError);
    expect(requireCoopSession().ownership.toJSON()).toEqual(owners);
  });

  it("refuses the save of two other accounts", async () => {
    const { game } = run.ctx;
    const session = requireCoopSession();
    const other = {
      ...loaded,
      coop: { ...loaded.coop!, accountIds: { ...loaded.coop!.accountIds, guest: "someone else" } },
    };
    vi.spyOn(game.scene.gameData, "getSession").mockResolvedValue(other);
    const owners = session.ownership.toJSON();

    await expect(game.scene.gameData.loadSession(0)).rejects.toThrow("two other players");
    expect(session.ownership.toJSON()).toEqual(owners);
  });
});
