/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { speciesDataRegistry } from "#app/global-species-data-registry";
import { ownerOf } from "#coop/control";
import { catchReleaseKey, evolutionCancelKey, learnMoveKey, turnCommandsKey } from "#coop/decision-keys";
import type { Decision, RejectReason } from "#coop/sequencer";
import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { EvolutionPhase } from "#phases/evolution-phase";
import { advanceTo, queueTurnCommands } from "#test/helpers/coop-harness";
import {
  answerSideAction,
  ballThrowingPartner,
  type LinkedRun,
  type LinkedScenario,
  openLinkedRun,
  pickerSkips,
  playerActs,
  rewardScreen,
  toTurnWithOneEnemy,
  winWave,
} from "#test/helpers/coop-linked";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * AFK and take over in a linked run (DECISIONS D17): the real client waits for a partner who does not answer, is
 * offered to take over, does, and the decision is made with the default of its kind. The partner's own answer, if it comes
 * after, is rejected.
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

/** Long enough that a normal wait never reaches them, short enough for a test */
const AFK = { hintMs: 150, takeoverMs: 400, keepWaitingMs: 400 };

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe("Co-op: AFK and take over in a linked run (D17)", () => {
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
      configure: game => game.override.startingLevel(40),
      // the partner answers what keeps the run going, but none of the decisions a test lets it be away for
      policy: { auto: ["TURN_COMMANDS", "SIDE_ACTION"] },
      names: { mine: "Sam", theirs: "Alex" },
      afkTimers: AFK,
      ...overrides,
    });
    return run;
  }

  /** The decisions as the real client receives them, in order */
  function decisionsOf(r: LinkedRun): Decision[] {
    const seen: Decision[] = [];
    r.link.sequencer.onDecision(decision => seen.push(decision));
    return seen;
  }

  /** What the partner is told when it proposes something that was decided already */
  function rejectionsOf(r: LinkedRun): RejectReason[] {
    const reasons: RejectReason[] = [];
    r.partner.sequencer.onProposalRejected(({ reason }) => reasons.push(reason));
    return reasons;
  }

  /** The texts shown to the player */
  function textsOf(r: LinkedRun): string[] {
    const texts: string[] = [];
    const { ui } = r.ctx.game.scene;
    const showText = ui.showText.bind(ui);
    vi.spyOn(ui, "showText").mockImplementation((text, ...rest) => {
      texts.push(text);
      return showText(text, ...rest);
    });
    return texts;
  }

  /** Wait for the offer ("Take over" / "Keep waiting"), and take it */
  async function takeOver(r: LinkedRun): Promise<void> {
    await vi.waitUntil(() => r.ctx.game.scene.ui.mode === UiMode.OPTION_SELECT, { timeout: 5000, interval: 10 });
    r.ctx.game.scene.ui.processInput(Button.ACTION);
  }

  /** Press "yes" on every menu that opens until `done` settles */
  async function chooseFirstUntil(r: LinkedRun, done: Promise<unknown>): Promise<void> {
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    while (!settled) {
      if (r.ctx.game.scene.ui.mode === UiMode.OPTION_SELECT) {
        r.ctx.game.scene.ui.processInput(Button.ACTION);
      }
      await sleep(30);
    }
  }

  it("tells the waiting player, by name, that the partner is still choosing, and offers to take over", async () => {
    const r = await start();
    const texts = textsOf(r);
    const { game } = r.ctx;
    const guestPokemon = game.scene.getPlayerParty().find(p => ownerOf(p) === "guest")!;
    game.scene.phaseManager.unshiftNew(
      "LearnMovePhase",
      game.scene.getPlayerParty().indexOf(guestPokemon),
      MoveId.SWIFT,
    );
    const advancing = advanceTo(r.ctx, ["CommandPhase"]);

    await vi.waitUntil(() => texts.some(text => text.includes("Alex is still choosing")), { timeout: 5000 });
    expect(texts.some(text => text.includes("Alex is away"))).toBe(false);
    await vi.waitUntil(() => game.scene.ui.mode === UiMode.OPTION_SELECT, { timeout: 5000 });
    expect(texts.some(text => text.includes("Alex is away"))).toBe(true);

    // "Keep waiting" is the second option: the offer goes away and comes again
    game.scene.ui.processInput(Button.DOWN);
    game.scene.ui.processInput(Button.ACTION);
    await vi.waitUntil(() => game.scene.ui.mode !== UiMode.OPTION_SELECT, { timeout: 2000, interval: 10 });
    await takeOver(r);
    await advancing;
  });

  describe("what the taker decides", () => {
    it("learn-move: keeps the old moves, and the partner's late answer is rejected", async () => {
      const r = await start();
      const { game } = r.ctx;
      const decisions = decisionsOf(r);
      const rejections = rejectionsOf(r);
      const guestPokemon = game.scene.getPlayerParty().find(p => ownerOf(p) === "guest")!;
      const before = guestPokemon.getMoveset().map(move => move.moveId);
      game.scene.phaseManager.unshiftNew(
        "LearnMovePhase",
        game.scene.getPlayerParty().indexOf(guestPokemon),
        MoveId.SWIFT,
      );
      const advancing = advanceTo(r.ctx, ["CommandPhase"]);

      await takeOver(r);
      await advancing;

      const key = learnMoveKey(game.scene.currentBattle.waveIndex, guestPokemon.id, MoveId.SWIFT);
      const decision = decisions.find(d => d.key.kind === "LEARN_MOVE");
      expect(decision).toMatchObject({ author: "host", takeover: true, payload: { replaceIndex: null }, key });
      expect(guestPokemon.getMoveset().map(move => move.moveId)).toEqual(before);

      // the partner comes back and answers: too late
      r.partner.propose(key, { replaceIndex: 1 });
      await sleep(60);
      expect(rejections).toEqual(["duplicate"]);
      expect(guestPokemon.getMoveset().map(move => move.moveId)).toEqual(before);
      expect(r.session.desyncMessage).toBeNull();
    });

    it("evolution: lets it happen", async () => {
      const r = await start();
      const { game } = r.ctx;
      const decisions = decisionsOf(r);
      await advanceTo(r.ctx, ["CommandPhase"]);
      const pokemon = game.scene.getPlayerParty().find(p => ownerOf(p) === "guest")!;
      const evolution = speciesDataRegistry.getEvolutions(pokemon.species.speciesId)[0];
      const phase = new EvolutionPhase(pokemon, evolution, 5);
      (phase as unknown as { evolutionHandler: { cancelled: boolean } }).evolutionHandler = { cancelled: false };
      const resolving = (phase as unknown as { resolveCancelled(): Promise<boolean> }).resolveCancelled();

      await takeOver(r);

      await expect(resolving).resolves.toBe(false);
      expect(decisions.at(-1)).toMatchObject({
        author: "host",
        takeover: true,
        payload: { cancel: false },
        key: evolutionCancelKey(game.scene.currentBattle.waveIndex, pokemon.id, evolution.speciesId),
      });
    });

    it("catch release: declines the catch of a partner who has three Pokémon and does not answer", async () => {
      let r: LinkedRun | null = null;
      const partner = ballThrowingPartner(() => r!, { auto: ["TURN_COMMANDS", "FAINT_SWITCH"] });
      r = await start({ policy: partner.policy });
      await toTurnWithOneEnemy(r);
      const { game } = r.ctx;
      const decisions = decisionsOf(r);
      const before = game.scene.getPlayerParty().map(p => p.id);
      const owners = r.session.ownership.toJSON();
      const enemy = game.scene.getEnemyField().find(e => e.isActive(true))!;
      const wave = game.scene.currentBattle.waveIndex;
      expect(game.scene.getPlayerParty().filter(p => ownerOf(p) === "guest")).toHaveLength(3);

      partner.throwBall();
      queueTurnCommands(r.ctx);
      answerSideAction(r, true);
      const advancing = advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);
      await takeOver(r);
      await advancing;

      expect(decisions.find(d => d.key.kind === "CATCH_RELEASE")).toMatchObject({
        author: "host",
        takeover: true,
        payload: { release: null },
        key: catchReleaseKey(wave, enemy.id),
      });
      expect(game.scene.getPlayerParty().map(p => p.id)).toEqual(before);
      expect(r.session.ownership.toJSON()).toEqual(owners);
    });

    it("turn commands: the taker chooses the move of the partner's Pokémon from a menu", async () => {
      const r = await start({ policy: { auto: ["SIDE_ACTION"] } });
      const { game } = r.ctx;
      const decisions = decisionsOf(r);
      await advanceTo(r.ctx, ["CommandPhase"]);
      const partnerMon = game.scene.getPlayerParty().find(p => ownerOf(p) === "guest")!;
      const { waveIndex, turn } = game.scene.currentBattle;

      queueTurnCommands(r.ctx);
      const advancing = advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);
      await takeOver(r);
      // the move, then (two enemies) the target
      await chooseFirstUntil(r, advancing);
      await advancing;

      const decision = decisions.find(
        d => d.key.kind === "TURN_COMMANDS" && d.author === "host" && d.takeover === true,
      );
      expect(decision).toBeDefined();
      expect(decision!.key).toEqual(turnCommandsKey(waveIndex, turn, partnerMon.id));
      expect(decision!.payload).toMatchObject({
        command: { move: { move: partnerMon.getMoveset()[0].moveId } },
        pre: { skip: true },
      });
      expect(r.session.desyncMessage).toBeNull();
    });

    it("reward screen: takes the picker's place, and the pick closes the screen", async () => {
      const r = await start();
      const { game } = r.ctx;
      // screen 0: the host's; screen 1: the guest's, who is away
      expect(await winWave(r)).toBe(true);
      pickerSkips(r);
      await advanceTo(r.ctx, ["CommandPhase"]);
      expect(await winWave(r)).toBe(true);
      const decisions = decisionsOf(r);
      const rejections = rejectionsOf(r);
      expect(game.scene.currentBattle.waveIndex).toBe(2);

      // not the picker: the pick is refused on this client's screen
      const phase = rewardScreen(r);
      expect(phase.onSequencedInput(1, 0)).toBe(false);

      await takeOver(r);
      // (the take over starts a moment after the offer's menu is gone)
      await sleep(200);
      playerActs(r, { t: "skip" });
      await advanceTo(r.ctx, ["CommandPhase"]);

      expect(decisions.find(d => d.key.kind === "REWARD_PICK")).toMatchObject({
        author: "host",
        takeover: true,
        payload: { t: "skip" },
      });
      // the guest's own skip, if it comes, is too late
      r.partner.propose({ wave: 2, turn: 0, kind: "REWARD_PICK", ref: "1:0" }, { t: "skip" });
      await sleep(60);
      expect(rejections).toEqual(["duplicate"]);
      expect(r.session.desyncMessage).toBeNull();
    });
  });

  it("closes the question of the player whose decision the partner made, and says so", async () => {
    const r = await start();
    const { game } = r.ctx;
    const texts = textsOf(r);
    const hostPokemon = game.scene.getPlayerParty().find(p => ownerOf(p) === "host")!;
    const key = learnMoveKey(game.scene.currentBattle?.waveIndex ?? 1, hostPokemon.id, MoveId.SWIFT);
    const decisions = decisionsOf(r);

    // the guest takes over for the host's player before the host is even asked: the host holds it until its own player has
    // had the question for the hint's time (D17), and the player does not answer meanwhile
    r.partner.takeOver({ ...key, wave: 1 }, { replaceIndex: null });
    await sleep(40);
    game.scene.phaseManager.unshiftNew(
      "LearnMovePhase",
      game.scene.getPlayerParty().indexOf(hostPokemon),
      MoveId.SWIFT,
    );
    await advanceTo(r.ctx, ["LearnMovePhase"]);
    const learn = game.scene.phaseManager.getCurrentPhase();
    learn.start();
    await vi.waitUntil(() => game.scene.phaseManager.getCurrentPhase() !== learn, { interval: 10, timeout: 8000 });
    await advanceTo(r.ctx, ["CommandPhase"]);

    expect(texts.some(text => text.includes("Alex took over for you"))).toBe(true);
    expect(decisions.find(d => d.key.kind === "LEARN_MOVE")).toMatchObject({ author: "guest", takeover: true });
    expect(hostPokemon.getMoveset().some(move => move.moveId === MoveId.SWIFT)).toBe(false);
    expect(r.session.desyncMessage).toBeNull();
  });
});
