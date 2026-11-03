/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { writeDebugOverrides } from "#coop/debug/overrides";
import { clearDebugQueue, queueDebug } from "#coop/debug/queue";
import { partyEditKey } from "#coop/party-edit";
import { kindOfAction, type RewardAction, rewardKey } from "#coop/reward-actions";
import { endCoopSession, requireCoopSession } from "#coop/session";
import { tradeDoneKey, tradeKey, tradeRequestKey } from "#coop/trade";
import { BattlerIndex } from "#enums/battler-index";
import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { advanceTo, openUi, queueTurnCommands } from "#test/helpers/coop-harness";
import {
  controllers,
  type LinkedRunOfThree,
  openLinkedRunOfThree,
  openScreen,
  rewardScreen,
  untilStep,
} from "#test/helpers/coop-linked";
import type { ConfirmUiHandler } from "#ui/confirm-ui-handler";
import type { CoopTradeUiHandler } from "#ui/coop-trade-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A linked battle of a game of three (DECISIONS D40): the real client is the host, the two guests are scripted on a hub of
 * one channel each; every decision goes through the sequencer, which has three seats.
 */

const SIX = [
  SpeciesId.BULBASAUR,
  SpeciesId.SQUIRTLE,
  SpeciesId.CHARMANDER,
  SpeciesId.PIKACHU,
  SpeciesId.MACHOP,
  SpeciesId.GEODUDE,
];

describe("Co-op: a linked battle of three (D40)", () => {
  let phaserGame: Phaser.Game;
  let run: LinkedRunOfThree | null = null;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    run?.close();
    run = null;
    endCoopSession();
  });

  async function start(): Promise<LinkedRunOfThree> {
    run = await openLinkedRunOfThree(phaserGame, {
      species: SIX,
      starterOwners: ["host", "host", "guest", "guest", "guest2", "guest2"],
      policy: { auto: ["TURN_COMMANDS", "FAINT_SWITCH", "LEARN_MOVE", "EVOLUTION_CANCEL"] },
      configure: game => game.override.startingLevel(20),
    });
    return run;
  }

  it("each player commands the Pokémon of their own slot, and all three act in the turn", async () => {
    const r = await start();
    await advanceTo(r.ctx, ["CommandPhase"]);
    expect(controllers()).toEqual(["host", "guest", "guest2"]);
    const field = r.ctx.game.scene.getPlayerField();
    expect(field.map(pokemon => pokemon.getBattlerIndex())).toEqual([
      BattlerIndex.PLAYER,
      BattlerIndex.PLAYER_2,
      BattlerIndex.PLAYER_3,
    ]);

    queueTurnCommands(r.ctx);
    await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);
    // the host's own command and each guest's sequenced one were all used
    for (const pokemon of field) {
      expect(pokemon.getLastXMoves(1)[0]?.move, `${pokemon.name} acted`).toBe(MoveId.BITE);
    }
    // nobody's command went to an enemy's place: the enemies chose their own
    expect(r.session.link?.players).toBe(3);
  });

  /** Play turns until a reward screen is up */
  async function toRewardScreen(r: LinkedRunOfThree): Promise<void> {
    for (let turn = 0; turn < 12; turn++) {
      const reached = await advanceTo(r.ctx, ["CommandPhase", "SelectModifierPhase"]);
      if (reached === "SelectModifierPhase") {
        return;
      }
      queueTurnCommands(r.ctx);
      await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);
      if (r.ctx.game.scene.phaseManager.getCurrentPhase().is("SelectModifierPhase")) {
        return;
      }
    }
    throw new Error("no reward screen in 12 turns");
  }

  /** The picker of the open screen skips it: the host itself, or a guest through its sequencer */
  function pickerSkips(r: LinkedRunOfThree): void {
    const { picker, screen } = openScreen();
    const skip: RewardAction = { t: "skip" };
    if (picker === "host") {
      (rewardScreen(r as never) as { propose(action: RewardAction): void }).propose(skip);
    } else {
      r.partners
        .get(picker)!
        .propose(
          rewardKey(
            r.ctx.game.scene.currentBattle.waveIndex,
            kindOfAction(skip),
            screen,
            requireCoopSession().rewardStep,
          ),
          skip,
        );
    }
  }

  it("the reward screens go round: the host picks, then the guest, then the second guest (D40)", async () => {
    const r = await start();
    const pickers: string[] = [];
    for (let wave = 1; wave <= 3; wave++) {
      await toRewardScreen(r);
      await openUi(r.ctx, "SelectModifierPhase");
      await vi.waitUntil(() => requireCoopSession().rewardPickCount === wave, { interval: 10, timeout: 8000 });
      pickers.push(openScreen().picker);
      const step = requireCoopSession().rewardStep;
      pickerSkips(r);
      await untilStep(step + 1);
    }
    expect(pickers).toEqual(["host", "guest", "guest2"]);
  });

  it("aiming at the second guest's Pokémon asks first in a game of three too (D8, amended)", async () => {
    const r = await start();
    await advanceTo(r.ctx, ["CommandPhase"]);
    const { game } = r.ctx;
    const said: string[] = [];
    const showText = game.scene.ui.showText.bind(game.scene.ui);
    vi.spyOn(game.scene.ui, "showText").mockImplementation((text, ...rest) => {
      said.push(text);
      showText(text, ...rest);
    });
    game.move.select(MoveId.BITE, 0, BattlerIndex.PLAYER_3);
    game.onNextPrompt("SelectTargetPhase", UiMode.CONFIRM, () => {
      const handler = game.scene.ui.getHandler() as ConfirmUiHandler;
      (handler as unknown as { unblockInput(): void }).unblockInput();
      handler.setCursor(0);
      handler.processInput(Button.ACTION);
    });
    await advanceTo(r.ctx, ["TurnStartPhase"]);
    expect(said.some(text => text.startsWith("Use Bite on"))).toBe(true);
    expect(game.scene.currentBattle.turnCommands[BattlerIndex.PLAYER]).toMatchObject({
      targets: [BattlerIndex.PLAYER_3],
    });
  });

  it("the host's debug menu works in a game of three: the batch goes with the turn (D42)", async () => {
    const r = await start();
    (r.session as { debug: boolean }).debug = true;
    await advanceTo(r.ctx, ["CommandPhase"]);
    const target = r.ctx.game.scene.getPlayerParty().find(p => r.session.ownership.get(p.id) === "guest2")!;
    queueDebug({ t: "level", p: target.id, v: 42 }, { t: "money", v: 777 });
    queueTurnCommands(r.ctx);
    await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);
    expect(target.level).toBe(42);
    expect(r.ctx.game.scene.money).toBeGreaterThanOrEqual(777);
    expect(r.session.desyncMessage).toBeNull();
    clearDebugQueue();
    writeDebugOverrides(null, 0);
  });

  it("a guest releases another guest's Pokémon from the reward screen; its owner keeps one (D28, amended)", async () => {
    const r = await start();
    await toRewardScreen(r);
    await openUi(r.ctx, "SelectModifierPhase");
    await vi.waitUntil(() => requireCoopSession().rewardPickCount === 1, { interval: 10, timeout: 8000 });
    const wave = r.ctx.game.scene.currentBattle.waveIndex;
    const owned = (seat: string) =>
      r.ctx.game.scene.getPlayerParty().filter(pokemon => r.session.ownership.get(pokemon.id) === seat);
    const released = owned("guest2").find(pokemon => !pokemon.isOnField()) ?? owned("guest2")[1];
    const { screen, step } = openScreen();
    r.partners.get("guest")!.propose(partyEditKey(wave, screen, step), { k: "release", pokemonId: released.id });
    await untilStep(step + 1);
    expect(owned("guest2").map(pokemon => pokemon.id)).not.toContain(released.id);
    expect(owned("guest2")).toHaveLength(1);

    // its last one cannot go
    const rejected: string[] = [];
    r.partners.get("guest")!.sequencer.onProposalRejected(({ key, reason }) => rejected.push(`${key.kind}:${reason}`));
    r.partners
      .get("guest")!
      .propose(partyEditKey(wave, screen, step + 1), { k: "release", pokemonId: owned("guest2")[0].id });
    await vi.waitUntil(() => rejected.length === 1, { interval: 10, timeout: 4000 });
    expect(rejected).toEqual(["PARTY_EDIT:invalid"]);
    expect(owned("guest2")).toHaveLength(1);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("a trade of three: the guests trade with each other; the host watches, then all three are done (D40)", async () => {
    const r = await start();
    await toRewardScreen(r);
    await openUi(r.ctx, "SelectModifierPhase");
    await vi.waitUntil(() => requireCoopSession().rewardPickCount === 1, { interval: 10, timeout: 8000 });
    const wave = r.ctx.game.scene.currentBattle.waveIndex;
    const guest = r.partners.get("guest")!;
    const guest2 = r.partners.get("guest2")!;
    // the second guest asks for the trade screen; the host skips the reward
    const { screen, step } = openScreen();
    guest2.propose(tradeRequestKey(wave, screen, step), null);
    await vi.waitUntil(() => r.session.tradeRequested, { timeout: 3000 });
    pickerSkips(r);
    await advanceTo(r.ctx, ["CoopTradePhase"]);
    await openUi(r.ctx, "CoopTradePhase");
    expect(r.ctx.game.scene.ui.mode).toBe(UiMode.COOP_TRADE);
    const phase = r.ctx.game.scene.phaseManager.getCurrentPhase() as unknown as {
      state: { step: number; finished: boolean };
    };
    const owners = () => r.ctx.game.scene.getPlayerParty().map(pokemon => r.session.ownership.get(pokemon.id));
    const ownedBy = (seat: string) =>
      r.ctx.game.scene.getPlayerParty().filter(pokemon => r.session.ownership.get(pokemon.id) === seat);
    const give = ownedBy("guest")[0].id;
    const want = ownedBy("guest2")[0].id;

    guest.propose(tradeKey(wave, "TRADE_PROPOSE", phase.state.step), { give, want, to: "guest2" });
    await vi.waitUntil(() => phase.state.step === 1, { timeout: 3000 });
    // the host is neither side: it watches, with nothing to press
    const handler = r.ctx.game.scene.ui.handlers[UiMode.COOP_TRADE] as CoopTradeUiHandler;
    const seen = handler.describe();
    expect(seen.mode).toBe("watch");
    expect(seen.actions).toEqual([]);
    guest2.propose(tradeKey(wave, "TRADE_ACCEPT", phase.state.step), null);
    await vi.waitUntil(() => phase.state.step === 2, { timeout: 3000 });
    expect(r.session.ownership.get(give)).toBe("guest2");
    expect(r.session.ownership.get(want)).toBe("guest");
    expect(owners().filter(seat => seat === "host")).toHaveLength(2);

    // done: the host, then each guest; the phase ends with the third
    (r.ctx.game.scene.phaseManager.getCurrentPhase() as unknown as { actions(): { done(done: boolean): void } })
      .actions()
      .done(true);
    await vi.waitUntil(() => phase.state.step === 3, { timeout: 3000 });
    guest.propose(tradeDoneKey(wave, 3, "guest"), { done: true });
    await vi.waitUntil(() => phase.state.step === 4, { timeout: 3000 });
    expect(phase.state.finished).toBe(false);
    guest2.propose(tradeDoneKey(wave, 4, "guest2"), { done: true });
    await advanceTo(r.ctx, ["CommandPhase"]);
    expect(r.session.desyncMessage).toBeNull();
  });
});
