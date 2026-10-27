/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { ownerOf } from "#coop/control";
import { learnMoveKey } from "#coop/decision-keys";
import { keyId } from "#coop/protocol";
import { rewardPickerOf } from "#coop/session";
import { modifierTypes } from "#data/data-lists";
import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import {
  getPlayerShopModifierTypeOptionsForWave,
  ModifierTypeOption,
  PokemonModifierType,
  TmModifierType,
} from "#modifiers/modifier-type";
import { advanceTo, openUi } from "#test/helpers/coop-harness";
import {
  type LinkedRun,
  type LinkedScenario,
  openLinkedRun,
  openRewardScreen,
  openScreen,
  partnerActs,
  pickerSkips,
  playerActs,
  rewardScreen,
  untilStep,
  winWave,
} from "#test/helpers/coop-linked";
import { getModifierType } from "#utils/modifier-utils";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The reward screen as a sequenced window (DECISIONS D9). One real client (the host), a scripted guest.
 * The host picks on the screens 0, 2, 4, ..., the guest on 1, 3, 5, ...
 */

const SIX = [
  SpeciesId.BULBASAUR,
  SpeciesId.SQUIRTLE,
  SpeciesId.CHARMANDER,
  SpeciesId.PIKACHU,
  SpeciesId.MACHOP,
  SpeciesId.GEODUDE,
];

/** Strong enough that one bite takes a wild or trainer Pokémon down: a wave is a turn or two */
const strong: Partial<LinkedScenario> = { configure: game => game.override.startingLevel(40) };

describe("Co-op: the reward screen (D9)", () => {
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
      ...strong,
      policy: { auto: ["TURN_COMMANDS", "LEARN_MOVE", "EVOLUTION_CANCEL"] },
      ...overrides,
    });
    return run;
  }

  const guestMon = (r: LinkedRun) => r.ctx.game.scene.getPlayerParty().find(p => ownerOf(p) === "guest")!;
  const hostMon = (r: LinkedRun) => r.ctx.game.scene.getPlayerParty().find(p => ownerOf(p) === "host")!;
  const option = (type: ReturnType<typeof getModifierType>) => new ModifierTypeOption(type, 0);

  it("alternates the picker per reward screen, and an X0 wave has none", async () => {
    const r = await start({
      configure: game => game.override.startingLevel(40).startingWave(7),
    });
    const pickers: string[] = [];
    const waves: number[] = [];
    while (r.session.rewardPickCount < 6) {
      const open = await winWave(r);
      if (open) {
        pickers.push(openScreen().picker);
        waves.push(r.ctx.game.scene.currentBattle.waveIndex);
        pickerSkips(r);
      }
    }
    await advanceTo(r.ctx, ["CommandPhase"]);

    expect(pickers).toEqual(["host", "guest", "host", "guest", "host", "guest"]);
    // waves 7, 8, 9, then 11, 12, 13: the tenth has fixed rewards and no screen
    expect(waves).toEqual([7, 8, 9, 11, 12, 13]);
    expect(r.session.rewardPickCount).toBe(6);
    expect(pickers.every((picker, screen) => picker === rewardPickerOf(screen))).toBe(true);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("lets the picker choose a Pokémon of the partner for the reward", async () => {
    const r = await start();
    await openRewardScreen(r, [option(getModifierType(modifierTypes.RARE_CANDY))]);
    const target = guestMon(r);
    const level = target.level;
    expect(openScreen()).toMatchObject({ screen: 0, picker: "host", step: 0 });

    playerActs(r, { t: "pick", index: 0, target: target.id });
    await advanceTo(r.ctx, ["CommandPhase"]);

    expect(target.level).toBe(level + 1);
    expect(hostMon(r).level).toBe(level);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("lets the other player buy from the shop, choosing the target, while the screen stays open", async () => {
    const r = await start();
    await openRewardScreen(r, [option(getModifierType(modifierTypes.RARE_CANDY))]);
    const { game } = r.ctx;
    game.scene.money = 5000;
    const shop = getPlayerShopModifierTypeOptionsForWave(
      game.scene.currentBattle.waveIndex,
      game.scene.getWaveMoneyAmount(1),
    );
    const index = shop.findIndex(item => item.type instanceof PokemonModifierType && item.cost <= game.scene.money);
    expect(index).toBeGreaterThanOrEqual(0);
    const money = game.scene.money;

    // the guest is not the picker of screen 0, but it may buy
    expect(openScreen().picker).toBe("host");
    partnerActs(r, { t: "buy", index, target: guestMon(r).id });
    await untilStep(1);

    expect(game.scene.money).toBeLessThan(money);
    expect(rewardScreen(r)).toBeDefined();
    expect(game.scene.phaseManager.getCurrentPhase().phaseName).toBe("SelectModifierPhase");

    // the host buys too (it is the picker, and either may buy), then picks
    playerActs(r, { t: "buy", index, target: hostMon(r).id });
    await untilStep(2);
    pickerSkips(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("rejects a buy that arrives after the pick closed the screen, and tells the buyer", async () => {
    const r = await start();
    await openRewardScreen(r, [option(getModifierType(modifierTypes.RARE_CANDY))]);
    const rejected: string[] = [];
    r.partner.sequencer.onProposalRejected(({ key, reason }) => rejected.push(`${key.kind}:${reason}`));

    playerActs(r, { t: "skip" });
    await advanceTo(r.ctx, ["CommandPhase"]);
    // the buy was on its way when the picker skipped
    r.partner.propose(
      { wave: r.ctx.game.scene.currentBattle.waveIndex, turn: 0, kind: "SHOP_BUY", ref: "0:0" },
      { t: "buy", index: 0, target: guestMon(r).id },
    );

    await vi.waitUntil(() => rejected.length > 0, { interval: 5, timeout: 4000 });
    expect(rejected).toEqual(["SHOP_BUY:closed"]);
  });

  it("lets the picker reroll: the same screen again, with the money taken, and the step goes on", async () => {
    const r = await start();
    await openRewardScreen(r, [option(getModifierType(modifierTypes.RARE_CANDY))]);
    const { game } = r.ctx;
    game.scene.money = 5000;
    const screen = r.session.rewardPickCount;
    const phase = game.scene.phaseManager.getCurrentPhase();

    playerActs(r, { t: "reroll" });
    await vi.waitUntil(() => game.scene.phaseManager.getCurrentPhase() !== phase, { interval: 5, timeout: 4000 });

    expect(game.scene.money).toBeLessThan(5000);
    // a reroll is not a new screen: the picker stays, and the step goes on
    expect(r.session.rewardPickCount).toBe(screen);
    expect(r.session.rewardStep).toBe(1);
    expect(game.scene.phaseManager.getCurrentPhase().phaseName).toBe("SelectModifierPhase");
    // the new screen is the next phase: start it, and its window opens in step 1
    await openUi(r.ctx, "SelectModifierPhase");
    expect(r.session.openWindow.map(key => key.ref)).toContain(`${screen - 1}:1`);

    // it can be closed as usual
    pickerSkips(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("lets the picker lock the rarities with a Lock Capsule", async () => {
    const r = await start();
    await openRewardScreen(r, [option(getModifierType(modifierTypes.RARE_CANDY))]);
    const { game } = r.ctx;
    game.scene.addModifier(getModifierType(modifierTypes.LOCK_CAPSULE).newModifier()!);
    expect(game.scene.lockModifierTiers).toBe(false);

    playerActs(r, { t: "lock" });
    await untilStep(1);
    expect(game.scene.lockModifierTiers).toBe(true);

    playerActs(r, { t: "lock" });
    await untilStep(2);
    expect(game.scene.lockModifierTiers).toBe(false);
  });

  it("lets only the picker pick, reroll and lock", async () => {
    const r = await start();
    await openRewardScreen(r, [option(getModifierType(modifierTypes.RARE_CANDY))]);
    const rejected: string[] = [];
    r.partner.sequencer.onProposalRejected(({ key, reason }) => rejected.push(`${key.kind}:${reason}`));

    // screen 0: the host picks; the guest tries all three
    partnerActs(r, { t: "pick", index: 0, target: guestMon(r).id });
    partnerActs(r, { t: "reroll" });
    partnerActs(r, { t: "lock" });
    await vi.waitUntil(() => rejected.length === 3, { interval: 5, timeout: 4000 });

    expect(rejected.sort()).toEqual([
      "REROLL:authorNotAllowed",
      "REWARD_LOCK:authorNotAllowed",
      "REWARD_PICK:authorNotAllowed",
    ]);
    expect(r.session.rewardStep).toBe(0);
  });

  it("gives the buttons of the picker to the picker only, on the screen of the one who is not", async () => {
    const r = await start();
    // screen 0: the host skips; screen 1 is the guest's
    expect(await winWave(r)).toBe(true);
    pickerSkips(r);
    expect(await winWave(r)).toBe(true);
    expect(openScreen()).toMatchObject({ screen: 1, picker: "guest" });

    const propose = vi.spyOn(r.link.sequencer, "propose");
    const screen = rewardScreen(r);
    expect(screen.onSequencedInput(1, 0)).toBe(false); // the free pick
    expect(screen.onSequencedInput(0, 0)).toBe(false); // reroll
    expect(screen.onSequencedInput(0, 3)).toBe(false); // Lock Capsule
    expect(propose).not.toHaveBeenCalled();

    // the guest picks, which closes the screen on the host's client too
    pickerSkips(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    expect(r.session.rewardPickCount).toBe(2);
  });

  it("refuses to move an item from the other player's Pokémon, and takes one from the author's own", async () => {
    const r = await start();
    await openRewardScreen(r, [option(getModifierType(modifierTypes.RARE_CANDY))]);
    const rejected: string[] = [];
    r.partner.sequencer.onProposalRejected(({ key, reason }) => rejected.push(`${key.kind}:${reason}`));

    // the guest takes from the host's Pokémon
    partnerActs(r, { t: "transfer", from: hostMon(r).id, to: guestMon(r).id, items: [{ index: 0, quantity: 1 }] });
    await vi.waitUntil(() => rejected.length === 1, { interval: 5, timeout: 4000 });
    expect(rejected).toEqual(["REWARD_TRANSFER:invalid"]);
    expect(r.session.rewardStep).toBe(0);

    // from its own it is allowed, if there is something to take
    r.ctx.game.scene.addModifier(getModifierType(modifierTypes.LEFTOVERS).newModifier(guestMon(r))!, true);
    partnerActs(r, { t: "transfer", from: guestMon(r).id, to: hostMon(r).id, items: [{ index: 0, quantity: 1 }] });
    await untilStep(1);
    expect(rejected).toHaveLength(1);
  });

  it("applies a pick after the switch back to the screen, so the message mode is the last one entered (a learn-move prompt hung on the picker's client)", async () => {
    const r = await start();
    await openRewardScreen(r, [option(getModifierType(modifierTypes.LEFTOVERS))]);
    const { ui, tweens } = r.ctx.game.scene;
    // The fades of the browser take their time (the test scene's tweens finish at once): the host sequences its own pick
    // before the screen's switch is over
    vi.spyOn(tweens, "add").mockImplementation(config => {
      const { duration, onComplete } = config as { duration?: number; onComplete?: () => void };
      setTimeout(() => onComplete?.(), duration ?? 0);
      return undefined as never;
    });
    // the picker takes the item, and the party screen opens
    expect(rewardScreen(r).onSequencedInput(1, 0)).toBe(true);
    await vi.waitUntil(() => ui.mode === UiMode.PARTY, { interval: 5, timeout: 5000 });
    const entered: string[] = [];
    for (const mode of [UiMode.MESSAGE, UiMode.MODIFIER_SELECT]) {
      const handler = ui.handlers[mode];
      const show = handler.show.bind(handler);
      vi.spyOn(handler, "show").mockImplementation(args => {
        entered.push(UiMode[mode]);
        return show(args);
      });
    }

    // the Pokémon is chosen: the screen switches back, and the host's pick comes back at once
    const party = ui.handlers[UiMode.PARTY] as unknown as { selectCallback(slot: number, option: number): void };
    party.selectCallback(r.ctx.game.scene.getPlayerParty().indexOf(hostMon(r)), 0);
    await vi.waitUntil(() => entered.includes("MESSAGE"), { interval: 5, timeout: 5000 });
    await new Promise(resolve => setTimeout(resolve, 700)); // a late switch would land here

    expect(entered.at(-1)).toBe("MESSAGE");
    expect(entered.lastIndexOf("MODIFIER_SELECT")).toBeLessThan(entered.indexOf("MESSAGE"));
    expect(r.session.desyncMessage).toBeNull();
  });

  it("gives the screen back to the player who is not picking after a cancel (it stopped answering until the pick)", async () => {
    const r = await start();
    // the next screen is the guest's to pick: this client (the host) watches it
    r.session.rewardPickCount = 1;
    await openRewardScreen(r, [option(getModifierType(modifierTypes.LEFTOVERS))]);
    expect(openScreen()).toMatchObject({ screen: 1, picker: "guest" });
    const handler = r.ctx.game.scene.ui.handlers[UiMode.MODIFIER_SELECT] as unknown as {
      awaitingActionInput: boolean;
      processInput(button: Button): boolean;
    };
    await vi.waitUntil(() => handler.awaitingActionInput, { interval: 5, timeout: 5000 });

    handler.processInput(Button.CANCEL);
    expect(handler.awaitingActionInput).toBe(true);
    // the rewards row answers with a word on who picks, and the screen still answers after it
    expect(rewardScreen(r).onSequencedInput(1, 0)).toBe(false);
    expect(handler.awaitingActionInput).toBe(true);
    expect(r.ctx.game.scene.ui.getHandler()).toBe(handler);
    partnerActs(r, { t: "skip" });
    await advanceTo(r.ctx, ["CommandPhase"]);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("sends the learn-move prompt of a TM used on the partner's Pokémon to the partner", async () => {
    const r = await start({
      policy: { auto: ["TURN_COMMANDS", "LEARN_MOVE", "EVOLUTION_CANCEL"], learnMove: () => 1 },
    });
    await openRewardScreen(r, [option(new TmModifierType(MoveId.SWIFT))]);
    const target = guestMon(r);
    const { waveIndex } = r.ctx.game.scene.currentBattle;
    expect(target.getMoveset()).toHaveLength(4);

    playerActs(r, { t: "pick", index: 0, target: target.id });
    await advanceTo(r.ctx, ["CommandPhase"]);

    // the guest answered, and the move is in the slot it chose, on the host's client
    expect(r.partner.answeredKeys).toContain(keyId(learnMoveKey(waveIndex, target.id, MoveId.SWIFT)));
    expect(target.getMoveset()[1].moveId).toBe(MoveId.SWIFT);
    expect(globalScene.currentBattle.waveIndex).toBe(waveIndex);
  });
});
