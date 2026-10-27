/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { speciesDataRegistry } from "#app/global-species-data-registry";
import { controllerOf, ownerOf } from "#coop/control";
import { evolutionCancelKey, learnMoveKey, sideActionKey, sidePickKey, turnCommandsKey } from "#coop/decision-keys";
import { keyId } from "#coop/protocol";
import { commandToWire } from "#coop/turn-commands";
import { BattlerIndex } from "#enums/battler-index";
import { Button } from "#enums/buttons";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { MoveUseMode } from "#enums/move-use-mode";
import { PokeballType } from "#enums/pokeball";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { CommandPhase } from "#phases/command-phase";
import { EvolutionPhase } from "#phases/evolution-phase";
import { advanceTo, queueTurnCommands } from "#test/helpers/coop-harness";
import {
  attackCommand,
  type LinkedRun,
  type LinkedScenario,
  openLinkedRun,
  type PartnerPolicy,
} from "#test/helpers/coop-linked";
import type { ConfirmUiHandler } from "#ui/confirm-ui-handler";
import type { OptionSelectUiHandler } from "#ui/option-select-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The decisions of the battle, sequenced. One real client, a scripted partner on the other end of the link.
 * The real client is the host unless a test says otherwise.
 */

const SIX = [
  SpeciesId.BULBASAUR,
  SpeciesId.SQUIRTLE,
  SpeciesId.CHARMANDER,
  SpeciesId.PIKACHU,
  SpeciesId.MACHOP,
  SpeciesId.GEODUDE,
];

describe("Co-op: the decisions of the battle go through the sequencer (D2, D7, D8, D10)", () => {
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
      starterOwners: ["host", "guest", "host", "guest", "host", "guest"],
      ...overrides,
    });
    return run;
  }

  /** The keys of the commands of the Pokémon in both slots, at the start of a turn */
  function commandKeys(r: LinkedRun, attempt = 0) {
    const { game } = r.ctx;
    const { waveIndex, turn } = game.scene.currentBattle;
    const [first, second] = game.scene.getPlayerField();
    return {
      host: turnCommandsKey(waveIndex, turn, first.id, attempt),
      guest: turnCommandsKey(waveIndex, turn, second.id, attempt),
    };
  }

  describe("simultaneous commands (D8)", () => {
    it.each([
      ["the guest's slot 1 is sequenced before the host's slot 0", "guest first"],
      ["the host's slot 0 is sequenced before the guest's slot 1", "host first"],
    ] as const)("%s", async (_name, order) => {
      const r = await start();
      const { ctx, partner, session } = r;
      const { game } = ctx;
      await advanceTo(ctx, ["CommandPhase"]);
      const keys = commandKeys(r);
      const hostSeen = partner.sequencer.awaitDecision(keys.host);
      const guestSeen = partner.sequencer.awaitDecision(keys.guest);

      // The host's player chooses in their own command phase; the guest's slot has no command phase of its own to wait for
      queueTurnCommands(ctx);
      if (order === "guest first") {
        partner.propose(keys.guest, attackCommand(game, 1, MoveId.TAIL_WHIP));
      }
      const reachedTurnStart = advanceTo(ctx, ["TurnStartPhase"]);
      if (order === "host first") {
        await hostSeen;
        partner.propose(keys.guest, attackCommand(game, 1, MoveId.TAIL_WHIP));
      }
      await reachedTurnStart;

      const battle = game.scene.currentBattle;
      expect(battle.turnCommands[0]).toMatchObject({ command: Command.FIGHT, move: { move: MoveId.BITE } });
      expect(battle.turnCommands[1]).toMatchObject({ command: Command.FIGHT, move: { move: MoveId.TAIL_WHIP } });
      const [hostSeq, guestSeq] = [(await hostSeen).seq, (await guestSeen).seq];
      expect(order === "guest first" ? guestSeq < hostSeq : hostSeq < guestSeq).toBe(true);
      expect(session.waits.turns).toBe(1);
      expect(session.openWindow).toEqual([]);
    });

    it("plays the turn out on the commands of both, and goes on to the next", async () => {
      const r = await start({ policy: { auto: ["TURN_COMMANDS"] } });
      const { ctx } = r;
      await advanceTo(ctx, ["CommandPhase"]);
      queueTurnCommands(ctx);
      const reached = await advanceTo(ctx, ["TurnInitPhase", "SelectModifierPhase"]);
      // Both Pokémon bit the first enemy: the wave is over, or the next turn has started with both slots chosen again
      expect(["TurnInitPhase", "SelectModifierPhase"]).toContain(reached);
      expect(r.session.desyncMessage).toBeNull();
      expect(r.session.waits.turns).toBeGreaterThanOrEqual(1);
    });

    it("has no command phase for the partner's slot: it ends at once and never asks the local player", async () => {
      const r = await start({ seat: "guest" });
      const { ctx } = r;
      const { game } = ctx;
      await advanceTo(ctx, ["CommandPhase"]);
      const remote = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
      expect(remote.getFieldIndex()).toBe(0);
      expect(controllerOf(0)).toBe("host");
      const end = vi.spyOn(remote, "end").mockImplementation(() => undefined);
      remote.start();
      expect(end).toHaveBeenCalledOnce();
      expect(game.scene.ui.mode).not.toBe(UiMode.COMMAND);
    });

    it("drops what the partner's Pokémon can no longer use from the front of its queue, as the partner's client does", async () => {
      const r = await start({ seat: "guest" });
      const { ctx } = r;
      const { game } = ctx;
      await advanceTo(ctx, ["CommandPhase"]);
      const remote = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
      const pokemon = game.scene.getPlayerField()[0];
      // A move it was locked into that it can no longer use (out of PP here; a rampage cut short by Torment in a game),
      // then one it can: the owner's client keeps only the second (`clearUnusableMoves`), and so must this one
      const bite = pokemon.getMoveset().find(move => move.moveId === MoveId.BITE)!;
      bite.ppUsed = bite.getMovePp();
      pokemon.pushMoveQueue({ move: MoveId.BITE, targets: [BattlerIndex.ENEMY], useMode: MoveUseMode.NORMAL });
      pokemon.pushMoveQueue({ move: MoveId.TAIL_WHIP, targets: [BattlerIndex.ENEMY], useMode: MoveUseMode.NORMAL });
      vi.spyOn(remote, "end").mockImplementation(() => undefined);
      remote.start();
      expect(pokemon.getMoveQueue().map(queued => queued.move)).toEqual([MoveId.TAIL_WHIP]);
    });
  });

  describe("cancel (D8)", () => {
    function cancelFrom(r: LinkedRun, slot: number) {
      const { game } = r.ctx;
      const phase = new CommandPhase(slot);
      vi.spyOn(phase, "end").mockImplementation(() => undefined);
      const unshift = vi.spyOn(game.scene.phaseManager, "unshiftNew");
      phase.cancel();
      return unshift.mock.calls.filter(([name]) => name === "CommandPhase").map(([, index]) => index);
    }

    it("reopens nothing for a player who has one slot: the partner's command is not theirs to take back", async () => {
      const r = await start({ seat: "guest" });
      await advanceTo(r.ctx, ["CommandPhase"]);
      expect(cancelFrom(r, 1)).toEqual([]);
    });

    it("reopens both slots of a player who covers both", async () => {
      const r = await start({
        species: [SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER],
        starterOwners: ["host", "host", "host"],
      });
      await advanceTo(r.ctx, ["CommandPhase"]);
      expect([controllerOf(0), controllerOf(1)]).toEqual(["host", "host"]);
      expect(cancelFrom(r, 1)).toEqual([0, 1]);
    });

    it("never reopens a slot of the partner's, even from a command phase of the partner's slot", async () => {
      const r = await start();
      await advanceTo(r.ctx, ["CommandPhase"]);
      expect(cancelFrom(r, 1)).toEqual([]);
    });
  });

  describe("Ball and Run need the partner's accept (D8)", () => {
    /** Strong enough that one bite takes a wild Pokémon down, so that a ball can be thrown at the one that is left */
    const strong: Partial<LinkedScenario> = { configure: game => game.override.startingLevel(40) };

    /** The guest's Pokémon only lowers an accuracy, so the host's bite is the only attack and the second enemy survives */
    const statusAttacks = (r: () => LinkedRun): PartnerPolicy => ({
      auto: ["TURN_COMMANDS", "SIDE_ACTION"],
      commands: (_pokemon, slot) => attackCommand(r().ctx.game, slot, MoveId.SAND_ATTACK),
    });

    /** One enemy is left, so a ball can be thrown: both Pokémon bite the first enemy in turn 1 */
    async function toTurnWithOneEnemy(r: LinkedRun): Promise<void> {
      const { ctx } = r;
      await advanceTo(ctx, ["CommandPhase"]);
      queueTurnCommands(ctx);
      await advanceTo(ctx, ["TurnInitPhase", "SelectModifierPhase"]);
      await advanceTo(ctx, ["CommandPhase"]);
      expect(ctx.game.scene.getEnemyField().filter(enemy => enemy.isActive(true))).toHaveLength(1);
    }

    function answerConfirm(r: LinkedRun, yes: boolean): void {
      r.ctx.game.onNextPrompt("CoopTurnSyncPhase", UiMode.CONFIRM, () => {
        const handler = r.ctx.game.scene.ui.getHandler() as ConfirmUiHandler;
        handler.setCursor(yes ? 0 : 1);
        handler.processInput(Button.ACTION);
      });
    }

    /** The guest's Pokémon in slot 1 throws a Poké Ball at the one enemy that is left */
    function ballCommand(r: LinkedRun, slot: number) {
      const [enemy] = r.ctx.game.scene.getEnemyField().filter(e => e.isActive(true));
      return {
        command: commandToWire({
          command: Command.BALL,
          cursor: PokeballType.POKEBALL,
          targets: [enemy.getBattlerIndex()],
        }),
        pre: commandToWire({ command: Command.FIGHT, targets: [slot], skip: true }),
      };
    }

    /** A partner whose first command after `throwBall()` is a Poké Ball; the others are plain attacks */
    function ballThrower(getRun: () => LinkedRun) {
      let pending = false;
      let thrown = 0;
      const policy: PartnerPolicy = {
        auto: ["TURN_COMMANDS"],
        commands: (_pokemon, slot) => {
          if (pending) {
            pending = false;
            thrown++;
            return ballCommand(getRun(), slot);
          }
          return attackCommand(getRun().ctx.game, slot, MoveId.SAND_ATTACK);
        },
      };
      return {
        policy,
        throwBall: () => {
          pending = true;
        },
        thrown: () => thrown,
      };
    }

    it("the host throws a ball and the guest accepts: the guest's slot is skipped", async () => {
      let r: LinkedRun | null = null;
      r = await start({
        ...strong,
        policy: { ...statusAttacks(() => r!), sideAction: () => ({ accept: true }) },
      });
      await toTurnWithOneEnemy(r);
      const { ctx, partner } = r;
      const { game } = ctx;
      const hostMon = game.scene.getPlayerField()[0];
      const { waveIndex, turn } = game.scene.currentBattle;

      game.doThrowPokeball(PokeballType.POKEBALL);
      await advanceTo(ctx, ["TurnStartPhase"]);

      const battle = game.scene.currentBattle;
      expect(battle.turnCommands[0]).toMatchObject({ command: Command.BALL });
      expect(battle.turnCommands[1]).toMatchObject({ skip: true });
      expect(partner.answeredKeys).toContain(keyId(sideActionKey(waveIndex, turn, hostMon.id, 0)));
    });

    it("the host throws a ball and the guest declines: the host chooses again, with a key of its own", async () => {
      let r: LinkedRun | null = null;
      r = await start({
        ...strong,
        policy: { ...statusAttacks(() => r!), sideAction: () => ({ accept: false }) },
      });
      await toTurnWithOneEnemy(r);
      const { ctx, partner, session } = r;
      const { game } = ctx;
      const hostMon = game.scene.getPlayerField()[0];
      const { waveIndex, turn } = game.scene.currentBattle;
      expect(turnCommandsKey(waveIndex, turn, hostMon.id, 1).ref).toBe(`${hostMon.id}:1`);
      const sequencedBefore = r.link.sequencer.lastApplied;

      // First the ball, then, after the decline, a plain attack
      game.doThrowPokeball(PokeballType.POKEBALL);
      queueTurnCommands(ctx);
      await advanceTo(ctx, ["TurnStartPhase"]);

      const battle = game.scene.currentBattle;
      expect(battle.turnCommands[0]).toMatchObject({ command: Command.FIGHT, move: { move: MoveId.BITE } });
      // the guest's command stayed, and nobody was skipped
      expect(battle.turnCommands[1]?.skip).not.toBe(true);
      // sequenced: the host's ball, the guest's command, the decline, and the host's second choice under its own key
      expect(r.link.sequencer.lastApplied - sequencedBefore).toBe(4);
      expect(session.openWindow).toEqual([]);
      expect(partner.answeredKeys).toContain(keyId(sideActionKey(waveIndex, turn, hostMon.id, 0)));
    });

    it("the guest throws a ball and the host accepts: the host's slot is skipped", async () => {
      let r: LinkedRun | null = null;
      const thrower = ballThrower(() => r!);
      r = await start({ ...strong, policy: thrower.policy });
      await toTurnWithOneEnemy(r);
      const { ctx } = r;
      thrower.throwBall();
      queueTurnCommands(ctx);
      answerConfirm(r, true);
      await advanceTo(ctx, ["TurnStartPhase"]);

      const battle = ctx.game.scene.currentBattle;
      expect(battle.turnCommands[1]).toMatchObject({ command: Command.BALL });
      expect(battle.turnCommands[0]).toMatchObject({ skip: true });
    });

    it("the guest throws a ball and the host declines: the guest chooses again", async () => {
      let r: LinkedRun | null = null;
      const thrower = ballThrower(() => r!);
      r = await start({ ...strong, policy: thrower.policy });
      await toTurnWithOneEnemy(r);
      const { ctx } = r;
      thrower.throwBall();
      queueTurnCommands(ctx);
      answerConfirm(r, false);
      await advanceTo(ctx, ["TurnStartPhase"]);

      const battle = ctx.game.scene.currentBattle;
      expect(thrower.thrown()).toBe(1);
      // the guest's second choice was a plain attack, and the host's command was not skipped
      expect(battle.turnCommands[1]).toMatchObject({ command: Command.FIGHT });
      expect(battle.turnCommands[0]?.skip).not.toBe(true);
    });

    it("both throw a ball: the host picks who throws, and nobody is asked to accept the other's", async () => {
      let r: LinkedRun | null = null;
      const thrower = ballThrower(() => r!);
      // (the partner answers no SIDE_ACTION: had one been asked, the turn would stall)
      r = await start({ ...strong, policy: thrower.policy });
      await toTurnWithOneEnemy(r);
      const { ctx } = r;
      const { game } = ctx;
      const { waveIndex, turn } = game.scene.currentBattle;
      const opened: string[] = [];
      const open = vi.spyOn(r.link.sequencer, "awaitDecision");

      thrower.throwBall();
      game.doThrowPokeball(PokeballType.POKEBALL);
      // the host's menu has the host's ball, then the guest's: the host lets the guest throw
      game.onNextPrompt("CoopTurnSyncPhase", UiMode.OPTION_SELECT, () => {
        const handler = game.scene.ui.getHandler() as OptionSelectUiHandler;
        handler.setCursor(1);
        handler.processInput(Button.ACTION);
      });
      await advanceTo(ctx, ["TurnStartPhase"]);
      opened.push(...open.mock.calls.flatMap(([keys]) => (Array.isArray(keys) ? keys : [keys]).map(keyId)));

      // the guest's ball is the one thrown, the host's slot is skipped
      const battle = game.scene.currentBattle;
      expect(battle.turnCommands[1]).toMatchObject({ command: Command.BALL });
      expect(battle.turnCommands[0]).toMatchObject({ skip: true });
      // the pick was a decision of its own; no accept was asked
      expect(opened).toContain(keyId(sidePickKey(waveIndex, turn)));
      expect(opened.some(id => id.includes("SIDE_ACTION"))).toBe(false);
      expect(r.session.sidePick).toBeNull();
    });

    it("both throw a ball, on the guest's client: the host's pick is carried out", async () => {
      let r: LinkedRun | null = null;
      const thrower = ballThrower(() => r!);
      // the scripted host picks its own ball (the first that may be picked)
      r = await start({
        ...strong,
        seat: "guest",
        policy: { ...thrower.policy, auto: ["TURN_COMMANDS", "SIDE_PICK"] },
      });
      await toTurnWithOneEnemy(r);
      const { ctx } = r;
      const { game } = ctx;
      const desyncs: string[] = [];
      r.link.sequencer.onDesync(error => desyncs.push(error.message));

      thrower.throwBall();
      game.doThrowPokeball(PokeballType.POKEBALL);
      await advanceTo(ctx, ["TurnStartPhase"]);

      const battle = game.scene.currentBattle;
      expect(battle.turnCommands[0]).toMatchObject({ command: Command.BALL });
      expect(battle.turnCommands[1]).toMatchObject({ skip: true });
      expect(desyncs).toEqual([]);
    });
  });

  describe("the replacement of a fainted Pokémon (D7)", () => {
    it("is decided by the partner when the owner has no bench, and nobody changes owner", async () => {
      // The host brings one Pokémon and the guest three: when the host's faints, the guest picks from the guest's bench
      const r = await start({
        species: [SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER, SpeciesId.PIKACHU],
        starterOwners: ["host", "guest", "guest", "guest"],
        faints: [{ wave: 1, turn: 1, slots: [0] }],
        policy: { auto: ["TURN_COMMANDS", "FAINT_SWITCH"] },
      });
      const { ctx, partner, session } = r;
      const { game } = ctx;
      await advanceTo(ctx, ["CommandPhase"]);
      const owners = session.ownership.toJSON();
      const fainting = game.scene.getPlayerField()[0];
      expect(ownerOf(fainting)).toBe("host");

      // The host's Pokémon uses Memento and faints; the partner attacks
      queueTurnCommands(ctx);
      await advanceTo(ctx, ["TurnInitPhase", "SelectModifierPhase"]);

      const replacement = game.scene.getPlayerField()[0];
      expect(replacement.id).not.toBe(fainting.id);
      expect(ownerOf(replacement)).toBe("guest");
      expect(ownerOf(fainting)).toBe("host");
      expect(session.ownership.toJSON()).toEqual(owners);
      // the guest decided it, with the turn the replacement was asked in (the faint turn + 1, D2)
      const key = partner.answeredKeys.find(id => id.includes(":FAINT_SWITCH:"));
      expect(key).toBeDefined();
      expect(key).toContain(`:${game.scene.currentBattle.turn > 1 ? 2 : 1}:`);
      expect([controllerOf(0), controllerOf(1)]).toEqual(["guest", "guest"]);
    });
  });

  describe("learn-move (D10)", () => {
    it("is decided by the owner: the host waits while the guest's Pokémon learns a move", async () => {
      const r = await start({ policy: { auto: ["LEARN_MOVE"], learnMove: () => 1 } });
      const { ctx, partner } = r;
      const { game } = ctx;
      const guestPokemon = game.scene.getPlayerParty().find(pokemon => ownerOf(pokemon) === "guest")!;
      expect(guestPokemon.getMoveset()).toHaveLength(4);
      game.scene.phaseManager.unshiftNew(
        "LearnMovePhase",
        game.scene.getPlayerParty().indexOf(guestPokemon),
        MoveId.SWIFT,
      );

      await advanceTo(ctx, ["CommandPhase"]);

      expect(guestPokemon.getMoveset()[1].moveId).toBe(MoveId.SWIFT);
      expect(partner.answeredKeys).toContain(
        `${game.scene.currentBattle.waveIndex}:0:LEARN_MOVE:${JSON.stringify(`${guestPokemon.id}:${MoveId.SWIFT}`)}`,
      );
    });

    it("is decided by the owner: the host's own Pokémon asks the host, and the guest's client gets the answer", async () => {
      const r = await start();
      const { ctx, partner } = r;
      const { game } = ctx;
      const hostPokemon = game.scene.getPlayerParty().find(pokemon => ownerOf(pokemon) === "host")!;
      const key = learnMoveKey(game.scene.currentBattle?.waveIndex ?? 1, hostPokemon.id, MoveId.SWIFT);
      const seen = partner.sequencer.awaitDecision({ ...key, wave: 1 });
      game.scene.phaseManager.unshiftNew(
        "LearnMovePhase",
        game.scene.getPlayerParty().indexOf(hostPokemon),
        MoveId.SWIFT,
      );

      await advanceTo(ctx, ["CommandPhase"]);

      const decision = await seen;
      expect(decision.author).toBe("host");
      expect(decision.payload).toEqual({ replaceIndex: 2 });
      expect(hostPokemon.getMoveset()[2].moveId).toBe(MoveId.SWIFT);
    });
  });

  describe("evolution cancel (D10)", () => {
    /** An evolution phase for a Pokémon of this seat, not started, with the cancel button pressed or not */
    async function evolutionOf(r: LinkedRun, seat: "host" | "guest", cancelPressed: boolean) {
      const { game } = r.ctx;
      await advanceTo(r.ctx, ["CommandPhase"]);
      const pokemon = game.scene.getPlayerParty().find(candidate => ownerOf(candidate) === seat)!;
      const evolution = speciesDataRegistry.getEvolutions(pokemon.species.speciesId)[0];
      const phase = new EvolutionPhase(pokemon, evolution, 5);
      (phase as unknown as { evolutionHandler: { cancelled: boolean } }).evolutionHandler = {
        cancelled: cancelPressed,
      };
      const key = evolutionCancelKey(game.scene.currentBattle.waveIndex, pokemon.id, evolution.speciesId);
      const resolve = (): Promise<boolean> =>
        (phase as unknown as { resolveCancelled(): Promise<boolean> }).resolveCancelled();
      return { key, resolve };
    }

    it("is the owner's: the guest stops the evolution of its Pokémon, whatever the host's player presses", async () => {
      const r = await start();
      const { key, resolve } = await evolutionOf(r, "guest", false);
      r.partner.propose(key, { cancel: true });
      await expect(resolve()).resolves.toBe(true);
    });

    it("is the owner's: the host's own Pokémon follows the host's button, and the guest's client gets that answer", async () => {
      const r = await start();
      const { key, resolve } = await evolutionOf(r, "host", true);
      const seen = r.partner.sequencer.awaitDecision(key);
      await expect(resolve()).resolves.toBe(true);
      expect((await seen).payload).toEqual({ cancel: true });
    });

    it("lets a Pokémon of the guest evolve when the guest does not stop it", async () => {
      const r = await start({ policy: { auto: ["EVOLUTION_CANCEL"] } });
      const { resolve } = await evolutionOf(r, "guest", true);
      await expect(resolve()).resolves.toBe(false);
    });
  });

  describe("a forced switch (Roar, D7)", () => {
    /**
     * The host's Pokémon only lowers the first enemy's accuracy, the guest's bites the second down at level 40: the
     * first enemy, which uses Roar, is the only one that moves, so exactly one of our Pokémon is dragged out.
     */
    const roar: Partial<LinkedScenario> = {
      moveset: [MoveId.SAND_ATTACK, MoveId.BITE, MoveId.GROWL, MoveId.TAIL_WHIP],
      configure: game => game.override.startingLevel(40).enemyMoveset(MoveId.ROAR),
    };

    const bitesTheSecondEnemy = (r: () => LinkedRun): PartnerPolicy => ({
      auto: ["TURN_COMMANDS"],
      commands: (_pokemon, slot) => attackCommand(r().ctx.game, slot, MoveId.BITE, 1),
    });

    async function roarTurn(r: LinkedRun) {
      const { ctx } = r;
      const { game } = ctx;
      await advanceTo(ctx, ["CommandPhase"]);
      const before = game.scene.getPlayerField().map(pokemon => pokemon.id);
      queueTurnCommands(ctx);
      await advanceTo(ctx, ["TurnInitPhase", "SelectModifierPhase"]);
      const after = game.scene.getPlayerField().map(pokemon => pokemon.id);
      const dragged = [0, 1].filter(slot => before[slot] !== after[slot]);
      return { before, after, dragged, party: game.scene.getPlayerParty() };
    }

    it("drags a Pokémon out for one from its owner's bench", async () => {
      let r: LinkedRun | null = null;
      r = await start({ ...roar, policy: bitesTheSecondEnemy(() => r!) });
      const { before, after, dragged, party } = await roarTurn(r);
      expect(dragged).toHaveLength(1);
      const out = party.find(pokemon => pokemon.id === before[dragged[0]])!;
      const come = party.find(pokemon => pokemon.id === after[dragged[0]])!;
      expect(ownerOf(come)).toBe(ownerOf(out));
      expect(come.id).not.toBe(out.id);
    });

    it("takes the partner's bench when the owner has none", async () => {
      // The guest has no bench: whoever is dragged out, the Pokémon that comes in is the host's
      let r: LinkedRun | null = null;
      r = await start({
        ...roar,
        species: [SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER, SpeciesId.PIKACHU],
        starterOwners: ["host", "guest", "host", "host"],
        policy: bitesTheSecondEnemy(() => r!),
      });
      const { after, dragged, party } = await roarTurn(r);
      expect(dragged).toHaveLength(1);
      expect(ownerOf(party.find(pokemon => pokemon.id === after[dragged[0]])!)).toBe("host");
    });

    it("fails when nobody has a bench, as upstream", async () => {
      let r: LinkedRun | null = null;
      r = await start({
        ...roar,
        species: [SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE],
        starterOwners: ["host", "guest"],
        policy: bitesTheSecondEnemy(() => r!),
      });
      const { dragged } = await roarTurn(r);
      expect(dragged).toEqual([]);
    });
  });
});
