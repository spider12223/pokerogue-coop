/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ownerOf } from "#coop/control";
import { turnCommandsKey } from "#coop/decision-keys";
import { checkDecisionLegal } from "#coop/legal";
import { gameLegalityView } from "#coop/legal-view";
import { askCommandFor } from "#coop/takeover-command";
import { tradeRequestKey } from "#coop/trade";
import { commandToWire } from "#coop/turn-commands";
import type { Egg } from "#data/egg";
import { Button } from "#enums/buttons";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { MoveUseMode } from "#enums/move-use-mode";
import { PartyUiMode } from "#enums/party-ui-mode";
import { SpeciesId } from "#enums/species-id";
import { Stat } from "#enums/stat";
import { UiMode } from "#enums/ui-mode";
import { VoucherType } from "#enums/voucher-type";
import type { PlayerPokemon } from "#field/pokemon";
import { getMoveTargets } from "#moves/move-utils";
import { advanceTo, openUi, queueTurnCommands } from "#test/helpers/coop-harness";
import {
  attackCommand,
  type LinkedRun,
  type LinkedScenario,
  openLinkedRun,
  openScreen,
  pickerSkips,
} from "#test/helpers/coop-linked";
import { PartyOption, type PartyUiHandler } from "#ui/party-ui-handler";
import { SummaryUiMode } from "#ui/summary-ui-handler";
import i18next from "i18next";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Regression tests of the co-op bugs found after the start-to-Eternatus run (STE), by reasoning from the three it found: a
 * phase left over from a wave that is won, a change to the game that one client makes alone, a check against the wrong
 * player. Each was a failing repro first. One real client, a scripted partner.
 */

const SIX = [
  SpeciesId.BULBASAUR,
  SpeciesId.SQUIRTLE,
  SpeciesId.CHARMANDER,
  SpeciesId.PIKACHU,
  SpeciesId.MACHOP,
  SpeciesId.GEODUDE,
];
const ALTERNATING = ["host", "guest", "host", "guest", "host", "guest"] as const;

describe("Co-op: the bugs found after the start-to-Eternatus run", () => {
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

  async function start(overrides: Partial<LinkedScenario> = {}): Promise<LinkedRun> {
    run = await openLinkedRun(phaserGame, {
      seat: "host",
      species: SIX,
      starterOwners: [...ALTERNATING],
      moveset: [MoveId.DOUBLE_EDGE, MoveId.MEMENTO, MoveId.SAND_ATTACK, MoveId.BITE],
      configure: game => game.override.startingLevel(40),
      ...overrides,
    });
    return run;
  }

  const battleRng = (r: LinkedRun) =>
    (r.ctx.game.scene.currentBattle as unknown as { battleSeedState: string | null }).battleSeedState;

  it("a trade asked for after a wave whose last kill fainted the attacker (recoil) opens the trade screen", async () => {
    const r = await start({
      policy: {
        auto: ["TURN_COMMANDS", "LEARN_MOVE", "EVOLUTION_CANCEL"],
        // the partner takes the second enemy down first
        commands: (_pokemon, slot) => attackCommand(r.ctx.game, slot, MoveId.BITE, 1),
      },
    });
    const { ctx } = r;
    const { game } = ctx;
    await advanceTo(ctx, ["CommandPhase"]);
    // the host's Pokémon is slow and at 1 HP: its Double-Edge takes the last enemy down, and its recoil faints it
    const host = game.scene.getPlayerField()[0];
    expect(ownerOf(host)).toBe("host");
    host.setStat(Stat.SPD, 1);
    host.hp = 1;
    queueTurnCommands(ctx);
    await advanceTo(ctx, ["SelectModifierPhase"]);
    expect(host.isFainted()).toBe(true);
    // the faint replacement was queued behind the next wave's set-up
    expect(game.scene.phaseManager.hasPhaseOfType("SwitchPhase")).toBe(true);
    await openUi(ctx, "SelectModifierPhase");

    const { screen, step } = openScreen();
    r.partner.propose(tradeRequestKey(game.scene.currentBattle.waveIndex, screen, step), null);
    await vi.waitUntil(() => r.session.tradeRequested, { timeout: 3000 });
    pickerSkips(r);
    await advanceTo(ctx, ["CoopTradePhase"]);
    await openUi(ctx, "CoopTradePhase");

    expect(r.session.desyncMessage).toBeNull();
    expect(game.scene.ui.mode).toBe(UiMode.COOP_TRADE);
    // the leftover replacement went first: the next wave's arrange step fills that slot
    expect(game.scene.phaseManager.hasPhaseOfType("SwitchPhase")).toBe(false);
  });

  describe("a move with a random target (Outrage) against two enemies", () => {
    const withOutrage: Partial<LinkedScenario> = {
      moveset: [MoveId.BITE, MoveId.MEMENTO, MoveId.SAND_ATTACK, MoveId.OUTRAGE],
    };

    it("choosing it leaves the battle's RNG alone (only the owner's client chooses it)", async () => {
      const r = await start({ ...withOutrage, policy: { auto: ["TURN_COMMANDS"] } });
      const { ctx } = r;
      const { game } = ctx;
      await advanceTo(ctx, ["CommandPhase"]);
      const enemies = game.scene
        .getEnemyField()
        .filter(enemy => enemy.isActive(true))
        .map(enemy => enemy.getBattlerIndex());
      expect(enemies).toHaveLength(2);
      // the battle stream has started this turn, so a change shows
      game.scene.currentBattle.randSeedInt(2);

      // the partner's slot: its command phase ends at once on this client (as the host's own slot does on the guest's)
      const own = game.scene.phaseManager.getCurrentPhase() as unknown as CommandPhaseInternals;
      const remote = new (own.constructor as new (slot: number) => CommandPhaseInternals)(1);
      vi.spyOn(remote, "end").mockImplementation(() => undefined);
      const before = battleRng(r);
      remote.start();
      expect(battleRng(r)).toBe(before);

      // the owner's slot: picking Outrage in the fight menu gives it a target, and no draw the partner's client lacks
      vi.spyOn(own, "end").mockImplementation(() => undefined);
      own.start();
      const cursor = game.scene
        .getPlayerField()[0]
        .getMoveset()
        .findIndex(move => move.moveId === MoveId.OUTRAGE);
      own.handleCommand(Command.FIGHT, cursor);
      expect(battleRng(r)).toBe(before);
      const targets = game.scene.currentBattle.turnCommands[0]?.move?.targets ?? [];
      expect(targets).toHaveLength(1);
      expect(enemies).toContain(targets[0]);
    });

    it("the legality check takes either enemy as its target, and draws nothing", async () => {
      // the real client is the guest; the host's Outrage comes over the link
      const r = await start({ ...withOutrage, seat: "guest", policy: {} });
      const { ctx, partner } = r;
      const { game } = ctx;
      await advanceTo(ctx, ["CommandPhase"]);
      const hostMon = game.scene.getPlayerField()[0];
      expect(ownerOf(hostMon)).toBe("host");
      const enemies = game.scene
        .getEnemyField()
        .filter(enemy => enemy.isActive(true))
        .map(enemy => enemy.getBattlerIndex());
      expect(enemies).toHaveLength(2);

      // the enemy a roll of the battle stream would give now (the check used to roll it, and refused any other)
      const battle = game.scene.currentBattle as unknown as { battleSeedState: string | null };
      const saved = battle.battleSeedState;
      const rolled = getMoveTargets(hostMon, MoveId.OUTRAGE).targets[0];
      battle.battleSeedState = saved;
      // the host's own roll gave the other one: a legal command
      const target = enemies.find(index => index !== rolled)!;
      const legal = gameLegalityView();
      const before = battleRng(r);
      expect([...(legal.fighter(hostMon.id)?.targetsOf(MoveId.OUTRAGE).targets ?? [])].sort()).toEqual(
        [...enemies].sort(),
      );
      expect(battleRng(r)).toBe(before);

      const { waveIndex, turn } = game.scene.currentBattle;
      partner.propose(turnCommandsKey(waveIndex, turn, hostMon.id), {
        command: commandToWire({
          command: Command.FIGHT,
          cursor: hostMon.getMoveset().findIndex(move => move.moveId === MoveId.OUTRAGE),
          move: { move: MoveId.OUTRAGE, targets: [target], useMode: MoveUseMode.NORMAL },
        }),
        pre: commandToWire({ command: Command.FIGHT, targets: [0], skip: true }),
      });
      queueTurnCommands(ctx);
      await advanceTo(ctx, ["TurnStartPhase"]);

      expect(r.session.desyncMessage).toBeNull();
    });
  });

  it("taking over for a Pokémon that can use no move makes a Struggle the legality check takes", async () => {
    const r = await start({ policy: {} });
    const { ctx } = r;
    const { game } = ctx;
    await advanceTo(ctx, ["CommandPhase"]);
    const theirs = game.scene.getPlayerField()[1];
    expect(ownerOf(theirs)).toBe("guest");
    for (const move of theirs.getMoveset()) {
      move.ppUsed = move.getMovePp();
    }
    const before = battleRng(r);

    // the partner is away: this player chooses for the partner's Pokémon (D17); there is nothing to pick from
    const payload = await askCommandFor(theirs, 1);

    expect(payload?.command?.move?.move).toBe(MoveId.STRUGGLE);
    const { waveIndex, turn } = game.scene.currentBattle;
    expect(
      checkDecisionLegal(gameLegalityView(), turnCommandsKey(waveIndex, turn, theirs.id), payload, "host"),
    ).toBeNull();
    // Struggle's target is random: drawn without the battle's stream
    expect(battleRng(r)).toBe(before);
  });

  describe("screens that would change the game on one client only are closed in co-op", () => {
    it("the summary does not swap or delete moves", async () => {
      const r = await start({ policy: {} });
      const { game } = r.ctx;
      await advanceTo(r.ctx, ["CommandPhase"]);
      const pokemon = game.scene.getPlayerParty()[0];
      const order = pokemon.getMoveset().map(move => move.moveId);
      const summary = game.scene.ui.handlers[UiMode.SUMMARY] as unknown as {
        pokemon: unknown;
        moveSelect: boolean;
        moveCursor: number;
        selectedMoveIndex: number;
        transitioning: boolean;
        processInput(button: Button): boolean;
      };
      // the summary opened from the party (not to learn a move), the moves page, a move under the cursor, nothing picked
      // yet: Action asks what to do with it. (The handler is the scene's: what an earlier screen left in it is set here.)
      Object.assign(summary, {
        pokemon,
        summaryUiMode: SummaryUiMode.DEFAULT,
        moveSelectFunction: null,
        moveSelect: true,
        moveCursor: 1,
        selectedMoveIndex: -1,
        transitioning: false,
      });

      expect(summary.processInput(Button.ACTION)).toBe(false);
      expect(game.scene.ui.mode).not.toBe(UiMode.OPTION_SELECT);
      expect(pokemon.getMoveset().map(move => move.moveId)).toEqual(order);
    });

    it("the party screen does not switch to throwing items away", async () => {
      const r = await start({ policy: {} });
      const { game } = r.ctx;
      await advanceTo(r.ctx, ["CommandPhase"]);
      await game.scene.ui.setMode(UiMode.PARTY, PartyUiMode.MODIFIER_TRANSFER, -1, () => undefined);
      const party = game.scene.ui.getHandler() as PartyUiHandler;
      // the discard button
      party.setCursor(7);
      party.processInput(Button.ACTION);

      expect((party as unknown as { partyUiMode: PartyUiMode }).partyUiMode).toBe(PartyUiMode.MODIFIER_TRANSFER);
    });

    it("a DNA Splicer takes two of the player's own Pokémon: the partner's are refused on the screen, both picks", async () => {
      const r = await start({ policy: {} });
      const { game } = r.ctx;
      await advanceTo(r.ctx, ["CommandPhase"]);
      await game.scene.ui.setMode(
        UiMode.PARTY,
        PartyUiMode.SPLICE,
        -1,
        () => undefined,
        () => null,
      );
      const party = game.scene.ui.getHandler() as unknown as {
        transferCursor: number;
        getFilterResult(option: number, pokemon: PlayerPokemon): string | null;
      };
      const members = game.scene.getPlayerParty();
      const mine = members.find(pokemon => ownerOf(pokemon) === "host")!;
      const theirs = members.find(pokemon => ownerOf(pokemon) === "guest")!;
      party.transferCursor = members.indexOf(mine);

      // the first pick (the one that stays) and the second (the one fused in)
      expect(party.getFilterResult(PartyOption.APPLY, mine)).toBeNull();
      expect(party.getFilterResult(PartyOption.APPLY, theirs)).toMatch(/is .+'s\./);
      expect(party.getFilterResult(PartyOption.SPLICE, theirs)).toMatch(/is .+'s\./);
    });

    it("the egg machine pulls from this player's vouchers, outside the run (D30)", async () => {
      const r = await start({ policy: {} });
      const { game } = r.ctx;
      await advanceTo(r.ctx, ["CommandPhase"]);
      const menu = game.scene.ui.handlers[UiMode.MENU] as unknown as {
        getMenuOptionsConfig(): { options: { label: string }[] };
      };
      const labels = menu.getMenuOptionsConfig().options.map(option => option.label);
      expect(labels).toContain(i18next.t("menuUiHandler:eggList"));
      expect(labels).toContain(i18next.t("menuUiHandler:eggGacha"));

      const gacha = game.scene.ui.handlers[UiMode.EGG_GACHA] as unknown as {
        handleVoucherSelectAction(cursor: number): boolean | undefined;
        pull(pullCount?: number): Promise<void>;
        pullEggs(pullCount: number): Egg[];
      };
      const { gameData } = game.scene;
      gameData.voucherCounts[VoucherType.REGULAR] = 5;

      // the first voucher of the machine: one of this player's, one pull
      const pull = vi.spyOn(gacha, "pull").mockResolvedValue();
      expect(gacha.handleVoucherSelectAction(0)).toBe(true);
      expect(gameData.voucherCounts[VoucherType.REGULAR]).toBe(4);
      expect(pull).toHaveBeenCalledWith(1);
      pull.mockRestore();

      // making the eggs and putting them in order draws nothing from the run's stream: the partner's client makes none
      const rng = Phaser.Math.RND.state();
      expect(gacha.pullEggs(10)).toHaveLength(10);
      expect(Phaser.Math.RND.state()).toBe(rng);

      // only the account is saved: the run is saved at the start of a wave, to the co-op slot (D19)
      const saveAll = vi.spyOn(gameData, "saveAll");
      const saveSystem = vi.spyOn(gameData, "saveSystem").mockReturnValue(new Promise(() => undefined));
      void gacha.pull(1);
      expect(saveSystem).toHaveBeenCalledOnce();
      expect(saveAll).not.toHaveBeenCalled();
    });
  });
});

interface CommandPhaseInternals {
  start(): void;
  end(): void;
  handleCommand(command: Command, cursor: number): boolean;
}
