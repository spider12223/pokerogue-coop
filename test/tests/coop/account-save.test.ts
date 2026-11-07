/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { loggedInUser } from "#app/account";
import { ownerOf } from "#coop/decisions/control";
import { coopLog } from "#coop/diagnostics/coop-log";
import type { Seat } from "#coop/protocol";
import { currentCoopSlot } from "#coop/save/wave-save";
import { getCoopSession } from "#coop/session";
import { chatInfo, startChat, stopChat } from "#coop/ui/chat";
import { MoveId } from "#enums/move-id";
import { PlayerGender } from "#enums/player-gender";
import { PokeballType } from "#enums/pokeball";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { VoucherType } from "#enums/voucher-type";
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
  answerEndScreen,
  attackCommand,
  ballThrowingPartner,
  type LinkedRun,
  openLinkedRun,
  pickerSkips,
  playToRunEnd,
  toTurnWithOneEnemy,
  winWave,
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

describe("Co-op: a save the browser refuses is not lost without a word (D19)", () => {
  let phaserGame: Phaser.Game;
  let run: LinkedRun | null = null;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    stopChat();
    run?.close();
    run = null;
    vi.restoreAllMocks();
  });

  /** What a browser throws when a write does not fit in its storage */
  const storageFull = (): DOMException => new DOMException("The quota has been exceeded.", "QuotaExceededError");

  async function startLinked(seat: Seat = "host"): Promise<LinkedRun> {
    run = await openLinkedRun(phaserGame, {
      seat,
      species: [SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER, SpeciesId.PIKACHU],
      starterOwners: ["host", "guest", "host", "guest"],
      configure: game => game.override.startingLevel(40),
      policy: { auto: ["TURN_COMMANDS", "LEARN_MOVE", "EVOLUTION_CANCEL"] },
    });
    // the chat box of the session, as the lobby starts it in the game (D38): the notes of the game go there
    startChat(run.link, "Sam");
    return run;
  }

  /** Win the wave and skip its reward: the next wave starts, and is saved (D19) */
  async function nextWave(r: LinkedRun): Promise<void> {
    if (await winWave(r)) {
      pickerSkips(r);
    }
    await advanceTo(r.ctx, ["CommandPhase"]);
  }

  /** The chat lines that say something was not saved */
  const notSaved = (): string[] => (chatInfo()?.lines ?? []).filter(line => line.includes("could not be saved"));

  it(
    "a full storage first gives up the co-op log's copy; then the account is saved, and nothing is said",
    async () => {
      const r = await startLinked();
      const { gameData } = r.ctx.game.scene;
      await advanceTo(r.ctx, ["CommandPhase"]);
      const release = vi.spyOn(coopLog(), "releaseStorage").mockReturnValue(true);
      const save = vi.spyOn(gameData, "saveSystem").mockRejectedValueOnce(storageFull()).mockResolvedValue(true);

      await nextWave(r);

      expect(r.ctx.game.scene.currentBattle.waveIndex).toBe(2);
      await vi.waitUntil(() => save.mock.calls.length >= 2, { interval: 5, timeout: 2000 });
      expect(release).toHaveBeenCalledOnce();
      expect(notSaved()).toEqual([]);
    },
    5 * MINUTES,
  );

  it(
    "the player is told once that their account cannot be saved, and the run goes on",
    async () => {
      const r = await startLinked("guest");
      const { gameData } = r.ctx.game.scene;
      await advanceTo(r.ctx, ["CommandPhase"]);
      vi.spyOn(coopLog(), "releaseStorage").mockReturnValue(false);
      vi.spyOn(gameData, "saveSystem").mockRejectedValue(storageFull());

      await nextWave(r);
      await nextWave(r);

      expect(r.ctx.game.scene.currentBattle.waveIndex).toBe(3);
      expect(notSaved()).toEqual([
        expect.stringContaining("Your account could not be saved: this browser's storage is full"),
      ]);
      expect(
        coopLog().all.some(entry => entry.level === "error" && entry.msg.includes("account could not be saved")),
      ).toBe(true);
      expect(r.session.desyncMessage).toBeNull();
    },
    5 * MINUTES,
  );

  it(
    "the host's save file that does not fit gets room first; if it still does not fit, the host is told",
    async () => {
      const r = await startLinked("host");
      await advanceTo(r.ctx, ["CommandPhase"]);
      const release = vi.spyOn(coopLog(), "releaseStorage").mockReturnValue(true);
      const write = localStorage.setItem.bind(localStorage);
      let refusals = 1;
      vi.spyOn(localStorage, "setItem").mockImplementation((key: string, value: string) => {
        if (key.startsWith("coopSlot") && refusals > 0) {
          refusals--;
          throw storageFull();
        }
        write(key, value);
      });

      await nextWave(r);
      // room was made and the file written again (the first write was the reward screen's): wave 2's start is in it
      expect(release).toHaveBeenCalledOnce();
      expect(currentCoopSlot()?.wave).toBe(2);
      expect(notSaved()).toEqual([]);

      refusals = Number.POSITIVE_INFINITY;
      release.mockReturnValue(false);
      await nextWave(r);
      // an earlier wave must not stay in the file: Continue would take the run back to it
      expect(currentCoopSlot()).toBeNull();
      expect(notSaved()).toEqual([
        expect.stringContaining("This run could not be saved: this browser's storage is full"),
      ]);
    },
    5 * MINUTES,
  );

  it(
    "the end screen of the run comes even when the account cannot be saved",
    async () => {
      let r: LinkedRun | null = null;
      r = await openLinkedRun(phaserGame, {
        seat: "host",
        species: [SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER, SpeciesId.PIKACHU],
        starterOwners: ["host", "guest", "host", "guest"],
        configure: game => game.override.startingLevel(40),
        faints: [1, 2].map(turn => ({ wave: 1, turn, slots: [0, 1] as (0 | 1)[] })),
        policy: {
          auto: ["TURN_COMMANDS", "FAINT_SWITCH", "LEARN_MOVE", "EVOLUTION_CANCEL"],
          commands: (_pokemon, slot) => attackCommand(r!.ctx.game, slot, MoveId.MEMENTO),
        },
      });
      run = r;
      const { game } = r.ctx;
      vi.spyOn(coopLog(), "releaseStorage").mockReturnValue(false);
      vi.spyOn(game.scene.gameData, "saveSystem").mockRejectedValue(storageFull());

      expect(await playToRunEnd(r)).toBe(false);
      const toTitle = game.phaseInterceptor.to("TitlePhase", false);
      // the end screen (D35), after the account was not saved
      const labels = await answerEndScreen(r, false);
      expect(labels.at(-1)).toBe("Back to title");
      await toTitle;
      expect(getCoopSession()).toBeNull();
    },
    5 * MINUTES,
  );

  it(
    "Save and Quit says so before it leaves, when the account cannot be saved",
    async () => {
      const r = await startLinked("host");
      const { gameData, ui } = r.ctx.game.scene;
      await advanceTo(r.ctx, ["CommandPhase"]);
      vi.spyOn(coopLog(), "releaseStorage").mockReturnValue(false);
      vi.spyOn(gameData, "saveSystem").mockRejectedValue(storageFull());
      // (the test UI shows a line and calls its callback at once, prompt or not: what is checked is how it is asked for)
      const lines: { text: string; prompt: boolean; ownLine: boolean; inSession: boolean }[] = [];
      const showText = ui.showText.bind(ui);
      vi.spyOn(ui, "showText").mockImplementation((text, delay, callback, callbackDelay, prompt, promptDelay) => {
        lines.push({
          text,
          prompt: prompt === true,
          ownLine: r.session.pace.isPrivate,
          inSession: getCoopSession() !== null,
        });
        showText(text, delay, callback, callbackDelay, prompt, promptDelay);
      });

      await ui.setOverlayMode(UiMode.MENU);
      const menu = ui.handlers[UiMode.MENU] as unknown as {
        getMenuOptionsConfig(): { options: { label: string; handler: () => boolean }[] };
      };
      menu
        .getMenuOptionsConfig()
        .options.find(option => option.label === i18next.t("menuUiHandler:saveAndQuit"))!
        .handler();
      await vi.waitUntil(() => getCoopSession() === null, { interval: 10, timeout: 4000 });

      // told in the message box (the chat box goes with the session) before the session ended, on a line that waits for
      // the press: this player's own, so the partner's screen does not move it on (D27)
      expect(lines).toContainEqual({
        text: expect.stringContaining("Your account could not be saved"),
        prompt: true,
        ownLine: true,
        inSession: true,
      });
      expect(r.session.pace.isPrivate).toBe(false);
    },
    5 * MINUTES,
  );

  it(
    "the egg machine goes on when the account cannot be saved, and the run is not reset",
    async () => {
      const r = await startLinked("host");
      const { game } = r.ctx;
      const { gameData } = game.scene;
      await advanceTo(r.ctx, ["CommandPhase"]);
      vi.spyOn(coopLog(), "releaseStorage").mockReturnValue(false);
      vi.spyOn(gameData, "saveSystem").mockRejectedValue(storageFull());
      const reset = vi.spyOn(game.scene, "reset");
      gameData.voucherCounts[VoucherType.REGULAR] = 5;
      const gacha = game.scene.ui.handlers[UiMode.EGG_GACHA] as unknown as {
        pull(pullCount?: number): Promise<void>;
        doPullAnim(): Promise<void>;
        showSummary(): void;
      };
      // (the animation and the summary of a pull are not what this checks)
      const animation = vi.spyOn(gacha, "doPullAnim").mockResolvedValue();
      vi.spyOn(gacha, "showSummary").mockReturnValue();

      await expect(gacha.pull(1)).resolves.toBeUndefined();
      expect(animation).toHaveBeenCalledOnce();
      expect(reset).not.toHaveBeenCalled();
      expect(notSaved()).toEqual([expect.stringContaining("Your account could not be saved")]);
    },
    5 * MINUTES,
  );
});
