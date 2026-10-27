/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { controllerOf, ownerOf } from "#coop/control";
import { isCoopSaveBlock } from "#coop/save-block";
import type { RejectReason } from "#coop/sequencer";
import { tradeDoneKey, tradeKey, tradeRequestKey } from "#coop/trade";
import { validateProposal } from "#coop/validate";
import { modifierTypes } from "#data/data-lists";
import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { PokemonHeldItemModifier } from "#modifiers/modifier";
import { ModifierTypeOption, TmModifierType } from "#modifiers/modifier-type";
import type { CoopTradePhase } from "#phases/coop-trade-phase";
import { advanceTo, openUi } from "#test/helpers/coop-harness";
import {
  type LinkedRun,
  type LinkedScenario,
  openLinkedRun,
  openRewardScreen,
  openScreen,
  pickerSkips,
  playerActs,
  winWave,
} from "#test/helpers/coop-linked";
import type { CoopTradeUiHandler, TradeScreenActions } from "#ui/coop-trade-ui-handler";
import { getModifierType } from "#utils/modifier-utils";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Trading between the waves (DECISIONS D11): the request on the reward screen, the trade screen after it, and what an
 * accepted trade does. One real client (the host), a scripted guest.
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

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

interface TradePhaseInternals {
  actions(): TradeScreenActions;
  state: { step: number; pending: unknown; done: { host: boolean; guest: boolean }; finished: boolean };
}

describe("Co-op: trading (D11)", () => {
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
      policy: { auto: ["TURN_COMMANDS", "LEARN_MOVE", "EVOLUTION_CANCEL"] },
      names: { mine: "Sam", theirs: "Alex" },
      ...overrides,
    });
    return run;
  }

  const party = (r: LinkedRun) => r.ctx.game.scene.getPlayerParty();
  const mine = (r: LinkedRun) => party(r).filter(p => ownerOf(p) === "host");
  const theirs = (r: LinkedRun) => party(r).filter(p => ownerOf(p) === "guest");
  const wave = (r: LinkedRun) => r.ctx.game.scene.currentBattle.waveIndex;
  /** The phases this client started, in order (the phase trace; the interceptor's own log does not see them) */
  const started = (r: LinkedRun) => r.session.trace.dump().map(entry => entry.phaseName);

  /** A trade was asked for on the open reward screen by the partner (or by the real client's player) */
  async function request(r: LinkedRun, by: "partner" | "me" = "partner"): Promise<void> {
    const { screen, step } = openScreen();
    if (by === "partner") {
      r.partner.propose(tradeRequestKey(wave(r), screen, step), null);
    } else {
      (
        r.ctx.game.scene.phaseManager.getCurrentPhase() as unknown as {
          onSequencedInput(r: number, c: number): boolean;
        }
      ).onSequencedInput(0, 4);
    }
    await vi.waitUntil(() => r.session.tradeRequested, { timeout: 3000 });
  }

  /** Win the wave, ask for a trade, skip the reward: the trade screen is up */
  async function toTradeScreen(r: LinkedRun, by: "partner" | "me" = "partner"): Promise<TradePhaseInternals> {
    expect(await winWave(r)).toBe(true);
    await request(r, by);
    pickerSkips(r);
    await advanceTo(r.ctx, ["CoopTradePhase"]);
    await openUi(r.ctx, "CoopTradePhase");
    expect(r.ctx.game.scene.ui.mode).toBe(UiMode.COOP_TRADE);
    return r.ctx.game.scene.phaseManager.getCurrentPhase() as unknown as TradePhaseInternals;
  }

  const screen = (r: LinkedRun) => r.ctx.game.scene.ui.handlers[UiMode.COOP_TRADE] as CoopTradeUiHandler;

  /** Both players say they are done */
  async function bothDone(r: LinkedRun, phase: TradePhaseInternals): Promise<void> {
    phase.actions().done(true);
    await vi.waitUntil(() => phase.state.done.host, { timeout: 3000 });
    r.partner.propose(tradeDoneKey(wave(r), phase.state.step, "guest"), { done: true });
    await advanceTo(r.ctx, ["CommandPhase"]);
  }

  describe("the request", () => {
    it("is made on the reward screen by either player, once, and the screen goes on", async () => {
      const r = await start();
      expect(await winWave(r)).toBe(true);
      expect(r.session.tradeRequested).toBe(false);

      await request(r, "me");
      expect(r.session.tradeRequested).toBe(true);
      // it took a step, and the screen is still open
      expect(openScreen().step).toBe(1);
      expect(r.ctx.game.scene.phaseManager.getCurrentPhase().phaseName).toBe("SelectModifierPhase");
      // a second one from the other player is the same request: nothing more happens
      await request(r, "partner");
      pickerSkips(r);
      await advanceTo(r.ctx, ["CoopTradePhase"]);
      expect(r.session.tradeQueued).toBe(true);
      expect(r.session.desyncMessage).toBeNull();
    });

    it("has no trade phase when nobody asked", async () => {
      const r = await start();
      expect(await winWave(r)).toBe(true);
      pickerSkips(r);
      await advanceTo(r.ctx, ["CommandPhase"]);
      expect(started(r)).not.toContain("CoopTradePhase");
    });

    it("is rejected when it comes after the reward screen closed", async () => {
      const r = await start();
      const rejections: RejectReason[] = [];
      r.partner.sequencer.onProposalRejected(({ reason }) => rejections.push(reason));
      expect(await winWave(r)).toBe(true);
      const { screen: openedScreen, step } = openScreen();
      const closedWave = wave(r);
      pickerSkips(r);
      await advanceTo(r.ctx, ["CommandPhase"]);

      // the guest's request was on its way when the host skipped
      r.partner.propose(tradeRequestKey(closedWave, openedScreen, step), null);
      await sleep(80);

      expect(rejections).toEqual(["closed"]);
      expect(r.session.tradeRequested).toBe(false);
      expect(started(r)).not.toContain("CoopTradePhase");
    });

    it("runs after what the pick queued: the partner's learn-move comes first", async () => {
      const r = await start({
        policy: { auto: ["TURN_COMMANDS", "LEARN_MOVE", "EVOLUTION_CANCEL"], learnMove: () => 1 },
      });
      await openRewardScreen(r, [new ModifierTypeOption(new TmModifierType(MoveId.SWIFT), 0)]);
      await request(r, "partner");
      const target = theirs(r)[0];
      expect(target.getMoveset()).toHaveLength(4);

      playerActs(r, { t: "pick", index: 0, target: target.id });
      await advanceTo(r.ctx, ["CoopTradePhase"]);

      // the TM was taught (the guest chose the slot) before the trade screen opens
      expect(target.getMoveset()[1].moveId).toBe(MoveId.SWIFT);
      const log = started(r);
      expect(log).toContain("LearnMovePhase");
      expect(log).not.toContain("CoopTradePhase");
    });
  });

  describe("on the trade screen", () => {
    it("swaps two Pokémon 1-for-1: the owners change, the party does not, and both clients end the screen when both are done", async () => {
      const r = await start();
      const phase = await toTradeScreen(r);
      const order = party(r).map(p => p.id);
      const [give] = mine(r);
      const [want] = theirs(r);

      expect(phase.actions().propose(give.id, want.id)).toBe(true);
      await vi.waitUntil(() => phase.state.pending !== null, { timeout: 3000 });
      expect(screen(r).describe().mode).toBe("wait");
      r.partner.propose(tradeKey(wave(r), "TRADE_ACCEPT", phase.state.step), null);
      await vi.waitUntil(() => ownerOf(give) === "guest", { timeout: 3000 });

      expect(ownerOf(want)).toBe("host");
      expect(party(r).map(p => p.id)).toEqual(order);
      expect(r.session.trades).toBe(1);
      expect(mine(r)).toHaveLength(3);
      expect(theirs(r)).toHaveLength(3);

      // the screen goes on until both are done
      phase.actions().done(true);
      await vi.waitUntil(() => phase.state.done.host, { timeout: 3000 });
      expect(r.ctx.game.scene.ui.mode).toBe(UiMode.COOP_TRADE);
      r.partner.propose(tradeDoneKey(wave(r), phase.state.step, "guest"), { done: true });
      await advanceTo(r.ctx, ["CommandPhase"]);
      expect(r.session.tradeRequested).toBe(false);
      expect(r.session.desyncMessage).toBeNull();
    });

    it("can be played with the buttons: pick yours, pick theirs, propose", async () => {
      const r = await start();
      const phase = await toTradeScreen(r, "me");
      const { ui } = r.ctx.game.scene;
      const press = (button: Button) => ui.processInput(button);
      const [give] = mine(r);
      const [want] = theirs(r);

      press(Button.ACTION); // select the first of mine
      // with nothing of theirs picked it is a gift
      expect(screen(r).describe()).toMatchObject({ actions: ["Give", "Done"], deal: { gives: give.id, gets: null } });
      press(Button.RIGHT);
      press(Button.ACTION); // and the first of theirs
      expect(screen(r).describe()).toMatchObject({
        give: give.id,
        want: want.id,
        mode: "compose",
        actions: ["Propose", "Done"],
        deal: { gives: give.id, gets: want.id },
      });
      press(Button.DOWN);
      press(Button.DOWN);
      press(Button.DOWN); // to the actions, on the first
      expect(screen(r).describe().cursor).toMatchObject({ side: 2, action: 0 });
      press(Button.DOWN); // to Done, and back up
      expect(screen(r).describe().cursor).toMatchObject({ side: 2, action: 1 });
      press(Button.UP);
      press(Button.ACTION); // Propose

      await vi.waitUntil(() => phase.state.pending !== null, { timeout: 3000 });
      expect(screen(r).describe()).toMatchObject({ mode: "wait", actions: ["Withdraw"] });
      press(Button.ACTION); // Withdraw
      await vi.waitUntil(() => phase.state.pending === null, { timeout: 3000 });
      expect(ownerOf(give)).toBe("host");
      expect(screen(r).describe().mode).toBe("compose");
    });

    it("lets the host answer the partner's proposal: accept", async () => {
      const r = await start();
      const phase = await toTradeScreen(r);
      const give = theirs(r)[1];
      const want = mine(r)[1];

      r.partner.propose(tradeKey(wave(r), "TRADE_PROPOSE", 0), { give: give.id, want: want.id });
      await vi.waitUntil(() => phase.state.pending !== null, { timeout: 3000 });
      expect(screen(r).describe().mode).toBe("answer");
      expect(screen(r).describe().actions).toEqual(["Accept", "Decline"]);
      phase.actions().answer(true);
      await vi.waitUntil(() => ownerOf(give) === "host", { timeout: 3000 });

      expect(ownerOf(want)).toBe("guest");
      expect(r.session.trades).toBe(1);
    });

    it("puts the cursor on Accept when the partner proposes, and A answers", async () => {
      const r = await start();
      const phase = await toTradeScreen(r);
      const give = theirs(r)[1];
      const want = mine(r)[1];
      // composing: the cursor is on the lists
      expect(screen(r).describe().cursor.side).toBe(0);

      r.partner.propose(tradeKey(wave(r), "TRADE_PROPOSE", 0), { give: give.id, want: want.id });
      await vi.waitUntil(() => phase.state.pending !== null, { timeout: 3000 });
      expect(screen(r).describe()).toMatchObject({ mode: "answer", cursor: { side: 2, action: 0 } });
      expect(screen(r).describe().status).toMatch(/offers/);

      r.ctx.game.scene.ui.processInput(Button.ACTION); // Accept
      await vi.waitUntil(() => ownerOf(give) === "host", { timeout: 3000 });
      expect(ownerOf(want)).toBe("guest");
      // nothing is open any more: the cursor is back on the lists, not on Done
      expect(screen(r).describe()).toMatchObject({ mode: "compose", cursor: { side: 0, action: 0 } });
    });

    it("puts the cursor on Withdraw for this player's own proposal, and back on the lists after it", async () => {
      const r = await start();
      const phase = await toTradeScreen(r);
      const { ui } = r.ctx.game.scene;

      ui.processInput(Button.ACTION); // pick the first of mine
      ui.processInput(Button.RIGHT);
      ui.processInput(Button.ACTION); // and the first of theirs: a 1-for-1 trade
      ui.processInput(Button.DOWN);
      ui.processInput(Button.DOWN);
      ui.processInput(Button.DOWN); // to the actions
      ui.processInput(Button.ACTION); // Propose
      await vi.waitUntil(() => phase.state.pending !== null, { timeout: 3000 });
      expect(screen(r).describe()).toMatchObject({
        mode: "wait",
        cursor: { side: 2, action: 0 },
        actions: ["Withdraw"],
      });

      r.partner.propose(tradeKey(wave(r), "TRADE_DECLINE", phase.state.step), null);
      await vi.waitUntil(() => phase.state.pending === null, { timeout: 3000 });
      expect(screen(r).describe()).toMatchObject({ mode: "compose", cursor: { side: 0 } });
    });

    it("says it is waiting for the partner after Done, and when the partner is done first", async () => {
      const r = await start();
      const phase = await toTradeScreen(r);
      expect(screen(r).describe().status).toMatch(/^Pick yours/);

      phase.actions().done(true);
      await vi.waitUntil(() => phase.state.done.host, { timeout: 3000 });
      expect(screen(r).describe().status).toBe("Waiting for Alex to finish…");

      // taking it back brings the help again
      phase.actions().done(false);
      await vi.waitUntil(() => !phase.state.done.host, { timeout: 3000 });
      expect(screen(r).describe().status).toMatch(/^Pick yours/);

      r.partner.propose(tradeDoneKey(wave(r), phase.state.step, "guest"), { done: true });
      await vi.waitUntil(() => phase.state.done.guest, { timeout: 3000 });
      expect(screen(r).describe().status).toBe("Alex is done.");
    });

    it("lets the host decline: nothing changes", async () => {
      const r = await start();
      const phase = await toTradeScreen(r);
      const owners = r.session.ownership.toJSON();

      r.partner.propose(tradeKey(wave(r), "TRADE_PROPOSE", 0), { give: theirs(r)[0].id, want: mine(r)[0].id });
      await vi.waitUntil(() => phase.state.pending !== null, { timeout: 3000 });
      phase.actions().answer(false);
      await vi.waitUntil(() => phase.state.pending === null, { timeout: 3000 });

      expect(r.session.ownership.toJSON()).toEqual(owners);
      expect(r.session.trades).toBe(0);
      expect(screen(r).describe().notice).toMatch(/declined/);
    });

    it("keeps the held items on their Pokémon: they go to the new owner with it", async () => {
      const r = await start();
      const [give] = mine(r);
      const item = getModifierType(modifierTypes.LEFTOVERS).newModifier(give) as PokemonHeldItemModifier;
      r.ctx.game.scene.addModifier(item);
      const heldBy = (id: number) =>
        r.ctx.game.scene.findModifiers(m => m instanceof PokemonHeldItemModifier && m.pokemonId === id);
      expect(heldBy(give.id)).toHaveLength(1);

      const phase = await toTradeScreen(r);
      phase.actions().propose(give.id, theirs(r)[0].id);
      await vi.waitUntil(() => phase.state.pending !== null, { timeout: 3000 });
      r.partner.propose(tradeKey(wave(r), "TRADE_ACCEPT", phase.state.step), null);
      await vi.waitUntil(() => ownerOf(give) === "guest", { timeout: 3000 });

      expect(heldBy(give.id)).toHaveLength(1);
      // and it is the new owner's to move now (D9), not the old one's
      const transfer = { t: "transfer", from: give.id, to: theirs(r)[1].id, items: [{ index: 0, quantity: 1 }] };
      const key = { wave: wave(r), turn: 0, kind: "REWARD_TRANSFER", ref: "9:9" } as const;
      expect(validateProposal(key, transfer, "guest")).toBe(true);
      expect(validateProposal(key, transfer, "host")).toBe(false);
    });

    describe("a gift", () => {
      /** Four Pokémon for the host and two for the guest */
      const lopsided: Partial<LinkedScenario> = { starterOwners: ["host", "host", "host", "host", "guest", "guest"] };

      it("is free, whatever the counts: three each, and the host gives one away", async () => {
        const r = await start();
        const phase = await toTradeScreen(r);
        const [give] = mine(r);
        expect(mine(r)).toHaveLength(3);

        expect(phase.actions().propose(give.id, null)).toBe(true);
        await vi.waitUntil(() => phase.state.pending !== null, { timeout: 3000 });
        // the screen calls it what it is
        expect(screen(r).describe().status).toMatch(/you give/i);
        r.partner.propose(tradeKey(wave(r), "TRADE_ACCEPT", phase.state.step), null);
        await vi.waitUntil(() => ownerOf(give) === "guest", { timeout: 3000 });

        expect(mine(r)).toHaveLength(2);
        expect(theirs(r)).toHaveLength(4);
      });

      it("never takes a player's last one: refused by the host, and by the player's own screen", async () => {
        const r = await start(lopsided);
        const rejections: RejectReason[] = [];
        r.partner.sequencer.onProposalRejected(({ reason }) => rejections.push(reason));
        const phase = await toTradeScreen(r);

        // the guest has two: it may give one, even to the host who has more
        const [first, last] = theirs(r);
        r.partner.propose(tradeKey(wave(r), "TRADE_PROPOSE", 0), { give: first.id, want: null });
        await vi.waitUntil(() => phase.state.pending !== null, { timeout: 3000 });
        phase.actions().answer(true);
        await vi.waitUntil(() => ownerOf(first) === "host", { timeout: 3000 });
        expect(mine(r)).toHaveLength(5);

        // ... but not the one it has left
        r.partner.propose(tradeKey(wave(r), "TRADE_PROPOSE", phase.state.step), { give: last.id, want: null });
        await sleep(80);
        expect(rejections).toEqual(["invalid"]);
        expect(phase.state.pending).toBeNull();
        expect(ownerOf(last)).toBe("guest");
      });

      it("of a player's last one is refused on their own screen, with a line that says why", async () => {
        // the host brings one Pokémon, the guest five
        const r = await start({ starterOwners: ["host", "guest", "guest", "guest", "guest", "guest"] });
        const phase = await toTradeScreen(r);
        expect(phase.actions().propose(mine(r)[0].id, null)).toBe(false);
        expect(screen(r).describe().notice).toMatch(/at least one/i);
        expect(phase.state.pending).toBeNull();
      });
    });
  });

  describe("after the trade", () => {
    it("the arrange step puts the traded Pokémon in the slot of its new owner", async () => {
      const r = await start();
      const phase = await toTradeScreen(r);
      const [hostFirst] = mine(r);
      const [guestFirst] = theirs(r);
      expect(r.ctx.game.scene.getPlayerField().map(p => p.id)).toEqual([hostFirst.id, guestFirst.id]);

      // the host trades its first for the guest's first
      phase.actions().propose(hostFirst.id, guestFirst.id);
      await vi.waitUntil(() => phase.state.pending !== null, { timeout: 3000 });
      r.partner.propose(tradeKey(wave(r), "TRADE_ACCEPT", phase.state.step), null);
      await vi.waitUntil(() => ownerOf(hostFirst) === "guest", { timeout: 3000 });
      await bothDone(r, phase);

      // the host's first legal Pokémon is the one it got, the guest's the one it got
      const field = r.ctx.game.scene.getPlayerField();
      expect(field.map(p => p.id)).toEqual([guestFirst.id, hostFirst.id]);
      expect([controllerOf(0), controllerOf(1)]).toEqual(["host", "guest"]);
      expect(ownerOf(field[0])).toBe("host");
      expect(ownerOf(field[1])).toBe("guest");
      expect(r.session.desyncMessage).toBeNull();
    });

    it("the owners are in the save, and survive loading it", async () => {
      const r = await start();
      const phase = await toTradeScreen(r);
      const [give] = mine(r);
      const [want] = theirs(r);
      phase.actions().propose(give.id, want.id);
      await vi.waitUntil(() => phase.state.pending !== null, { timeout: 3000 });
      r.partner.propose(tradeKey(wave(r), "TRADE_ACCEPT", phase.state.step), null);
      await vi.waitUntil(() => r.session.trades === 1, { timeout: 3000 });

      const saved = JSON.parse(JSON.stringify(r.ctx.game.scene.gameData.getSessionSaveData()));
      expect(isCoopSaveBlock(saved.coop)).toBe(true);
      expect(saved.coop.trades).toBe(1);
      expect(saved.coop.owners[String(give.id)]).toBe("guest");
      expect(saved.coop.owners[String(want.id)]).toBe("host");

      r.session.ownership.load({});
      r.session.trades = 0;
      r.session.restoreFromSaveBlock(saved.coop);
      expect(ownerOf(give)).toBe("guest");
      expect(ownerOf(want)).toBe("host");
      expect(r.session.trades).toBe(1);
    });
  });

  it("offers to decline for a partner who does not answer a proposal, and does", async () => {
    const r = await start({ afkTimers: { hintMs: 100, takeoverMs: 250, keepWaitingMs: 250 } });
    const phase = await toTradeScreen(r);
    const owners = r.session.ownership.toJSON();
    const decisions: { takeover?: true; key: { kind: string } }[] = [];
    r.link.sequencer.onDecision(decision => decisions.push(decision));

    phase.actions().propose(mine(r)[0].id, theirs(r)[0].id);
    await vi.waitUntil(() => r.ctx.game.scene.ui.mode === UiMode.OPTION_SELECT, { timeout: 5000, interval: 10 });
    r.ctx.game.scene.ui.processInput(Button.ACTION);
    await vi.waitUntil(() => phase.state.pending === null && decisions.some(d => d.key.kind === "TRADE_DECLINE"), {
      timeout: 5000,
    });

    expect(decisions.find(d => d.key.kind === "TRADE_DECLINE")).toMatchObject({ takeover: true });
    expect(r.session.ownership.toJSON()).toEqual(owners);
    expect((phase as unknown as CoopTradePhase).phaseName).toBe("CoopTradePhase");
  });
});
