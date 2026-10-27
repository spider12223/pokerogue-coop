/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ownerOf } from "#coop/control";
import { COSMETIC_LIMITS, type CosmeticMessage } from "#coop/cosmetic";
import { getCosmeticView } from "#coop/cosmetic-view";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { advanceTo, queueTurnCommands } from "#test/helpers/coop-harness";
import {
  type LinkedRun,
  type LinkedScenario,
  openLinkedRun,
  openScreen,
  pickerSkips,
  winWave,
} from "#test/helpers/coop-linked";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The cosmetic channel in a linked run (DECISIONS D16): the partner's intents, cursor, pings and emotes are shown,
 * the real client's own go to the partner, and whatever floods the channel changes nothing of the simulation.
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

/** The loopback delivers on a later tick */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20));

describe("Co-op: the cosmetic channel in a linked run (D16)", () => {
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
      ...overrides,
    });
    return run;
  }

  const partnerMon = (r: LinkedRun) => r.ctx.game.scene.getPlayerParty().find(p => ownerOf(p) === "guest")!;
  const myMon = (r: LinkedRun) => r.ctx.game.scene.getPlayerParty().find(p => ownerOf(p) === "host")!;

  it("shows the partner's intent for its own Pokémon, and drops one for the real client's", async () => {
    const r = await start();
    await advanceTo(r.ctx, ["CommandPhase"]);
    const view = getCosmeticView()!;
    expect(view).not.toBeNull();

    r.partner.cosmetic({ t: "intent", pokemonId: partnerMon(r).id, move: 44, target: 2, ready: false });
    r.partner.cosmetic({ t: "intent", pokemonId: myMon(r).id, move: 44, target: 2, ready: false });
    await flush();

    expect([...view.intents.keys()]).toEqual([partnerMon(r).id]);
    expect(view.intents.get(partnerMon(r).id)).toMatchObject({ move: 44, target: 2, ready: false });
    // a ghost marker is on the screen
    expect(view.describe().drawn).toBeGreaterThan(0);

    // the partner changes its mind, and then is ready
    r.partner.cosmetic({ t: "intent", pokemonId: partnerMon(r).id, move: 44, target: 3, ready: true });
    await flush();
    expect(view.intents.get(partnerMon(r).id)).toMatchObject({ target: 3, ready: true });
  });

  it("clears the markers when the turn starts, and drops what the partner has not announced any more", async () => {
    const r = await start();
    await advanceTo(r.ctx, ["CommandPhase"]);
    const view = getCosmeticView()!;
    r.partner.cosmetic({ t: "intent", pokemonId: partnerMon(r).id, move: 44, target: 2, ready: true });
    await flush();
    expect(view.intents.size).toBe(1);

    queueTurnCommands(r.ctx);
    await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);

    expect(view.intents.size).toBe(0);
    expect(view.describe().drawn).toBe(0);
  });

  it("tells the partner what the real client's player is choosing, and that they are ready", async () => {
    const r = await start();
    await advanceTo(r.ctx, ["CommandPhase"]);
    queueTurnCommands(r.ctx);
    await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);

    // the real client's Pokémon is announced, with a move, and then as ready with the command that was proposed
    await vi.waitUntil(() => r.partner.cosmeticsSeen.some(m => m.t === "intent" && m.ready), { timeout: 2000 });
    const intents = r.partner.cosmeticsSeen.filter(
      (m): m is Extract<CosmeticMessage, { t: "intent" }> => m.t === "intent",
    );
    expect(intents.every(m => m.pokemonId === myMon(r).id)).toBe(true);
    expect(intents.some(m => m.move !== null && !m.ready)).toBe(true);
    expect(intents.filter(m => m.ready).at(-1)).toMatchObject({ pokemonId: myMon(r).id, move: expect.any(Number) });
  });

  it("mirrors the cursor of the reward screen that is open, and drops one of another screen", async () => {
    const r = await start();
    expect(await winWave(r)).toBe(true);
    const view = getCosmeticView()!;
    expect(openScreen().screen).toBe(0);

    r.partner.cosmetic({ t: "cursor", screen: 0, row: 1, col: 2 });
    await flush();
    expect(view.cursor).toEqual({ screen: 0, row: 1, col: 2 });
    // the screen shows it: a cursor in the partner's color, on the other side of the option than this player's
    expect((r.ctx.game.scene.ui.handlers[UiMode.MODIFIER_SELECT] as any).partnerCursorObj).not.toBeNull();

    r.partner.cosmetic({ t: "cursor", screen: 7, row: 1, col: 0 });
    await flush();
    expect(view.cursor).toEqual({ screen: 0, row: 1, col: 2 });

    // the next screen's cursor is kept for when this client opens it (the partner is a moment ahead)
    r.partner.cosmetic({ t: "cursor", screen: 1, row: 1, col: 0 });
    await flush();
    expect(view.cursor).toEqual({ screen: 1, row: 1, col: 0 });

    // and the real client's own cursor went to the partner
    expect(r.partner.cosmeticsSeen.some(m => m.t === "cursor" && m.screen === 0)).toBe(true);

    // the cursor is gone with the screen
    pickerSkips(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    expect(view.cursor).toBeNull();
  });

  it("puts the item under the partner's cursor in their color, and a pinged one while the ping is shown", async () => {
    const r = await start();
    expect(await winWave(r)).toBe(true);
    const handler = r.ctx.game.scene.ui.handlers[UiMode.MODIFIER_SELECT] as any;
    // the screen's opening is over (it draws the partner's cursor at its end)
    await vi.waitFor(() => expect(handler.awaitingActionInput).toBe(true));
    const options = handler.options as { setPartnerTint(tint: number | null): void }[];
    expect(options.length).toBeGreaterThan(2);
    const tints = options.map(option => vi.spyOn(option, "setPartnerTint"));
    const lastTint = (index: number): number | null | undefined => tints[index].mock.calls.at(-1)?.[0];
    const PARTNER = 0x8fd3ff;

    handler.setPartnerCursor(1, 2);
    expect(handler.partnerTarget).toBe(options[2]);
    expect(lastTint(2)).toBe(PARTNER);

    // the cursor moves on: the item it left loses the color
    handler.setPartnerCursor(1, 0);
    expect(handler.partnerTarget).toBe(options[0]);
    expect(lastTint(2)).toBeNull();
    expect(lastTint(0)).toBe(PARTNER);

    // a ping keeps its item in the color while it is shown, even when the cursor passes over it and leaves
    handler.pingOption(false, 1, "Alex: !");
    expect(lastTint(1)).toBe(PARTNER);
    handler.setPartnerCursor(1, 1);
    handler.setPartnerCursor(1, 0);
    expect(lastTint(1)).toBe(PARTNER);

    // a ping on the item under the cursor: when it is over, the item keeps the color of the cursor
    handler.pingOption(false, 0, "Alex: !");
    await flush();
    expect(lastTint(0)).toBe(PARTNER);
    // and the other ping is over: its item lost the color
    expect(lastTint(1)).toBeNull();

    // on a button, no item has the color
    handler.setPartnerCursor(0, 1);
    expect(handler.partnerTarget).toBeNull();
    expect(lastTint(0)).toBeNull();
  });

  it("shows a ping and an emote with the partner's name, and keeps to the limits", async () => {
    const r = await start({ names: { mine: "Sam", theirs: "Alex" } });
    await advanceTo(r.ctx, ["CommandPhase"]);
    const view = getCosmeticView()!;
    expect(r.link.partnerName).toBe("Alex");

    r.partner.cosmetic({ t: "ping", at: { k: "enemy", index: 0 } });
    r.partner.cosmetic({ t: "emote", id: 3 });
    await flush();
    expect(view.pings).toMatchObject([{ name: "Alex", at: { k: "enemy", index: 0 } }]);
    expect(view.emotes).toMatchObject([{ name: "Alex", id: 3 }]);

    // a flood of pings and emotes: only the burst gets through, the rest is dropped and counted
    for (let i = 0; i < 100; i++) {
      r.partner.cosmetic({ t: "ping", at: { k: "none" } });
      r.partner.cosmetic({ t: "emote", id: i % 6 });
    }
    await flush();
    const { stats } = r.link.cosmeticReceiver;
    expect(stats.accepted.ping).toBeLessThanOrEqual(COSMETIC_LIMITS.ping.burst + 1);
    expect(stats.accepted.emote).toBeLessThanOrEqual(COSMETIC_LIMITS.emote.burst + 1);
    expect(stats.limited.ping).toBeGreaterThan(90);
    expect(stats.limited.emote).toBeGreaterThan(90);
  });

  describe("flooding the channel", () => {
    /** Play two waves, with the partner sending whatever `noise` says before each turn and at each reward screen */
    async function play(noise: (r: LinkedRun) => void): Promise<{
      hashes: string[];
      rng: string[];
      kinds: string[];
      stats: LinkedRun["link"]["cosmeticReceiver"]["stats"];
    }> {
      const r = await start();
      for (let wave = 0; wave < 2; wave++) {
        noise(r);
        await flush();
        expect(await winWave(r)).toBe(true);
        noise(r);
        await flush();
        pickerSkips(r);
        await advanceTo(r.ctx, ["CommandPhase"]);
      }
      const result = {
        hashes: r.session.checkpoints.entries.map(checkpoint => checkpoint.hash),
        rng: r.session.trace.dump().map(entry => entry.rng),
        kinds: r.session.checkpoints.entries.map(checkpoint => checkpoint.kind),
        stats: { ...r.link.cosmeticReceiver.stats },
      };
      r.close();
      run = null;
      return result;
    }

    it("leaves every checkpoint hash and every RNG state of the run unchanged, and the limits hold", async () => {
      const control = await play(() => undefined);
      expect(control.kinds).toEqual(expect.arrayContaining(["turn", "waveStart", "rewards", "waveEnd"]));

      const flooded = await play(r => {
        const mine = partnerMon(r).id;
        for (let i = 0; i < 500; i++) {
          r.partner.cosmetic({ t: "intent", pokemonId: mine, move: i % 200, target: i % 4, ready: i % 3 === 0 });
          r.partner.cosmetic({ t: "intent", pokemonId: myMon(r).id, move: 1, target: 1, ready: true });
          r.partner.cosmetic({ t: "cursor", screen: 0, row: i % 3, col: i % 5 });
          r.partner.cosmetic({ t: "ping", at: { k: "party", pokemonId: mine } });
          r.partner.cosmetic({ t: "emote", id: i % 6 });
          r.partner.cosmetic({ t: "ping", at: { k: "reward", index: 99 } });
          r.partner.cosmetic({ t: "emote", id: 1000 });
          r.partner.cosmetic("not even an object");
        }
      });

      expect(flooded.hashes).toEqual(control.hashes);
      expect(flooded.rng).toEqual(control.rng);
      // it really was a flood, and nearly all of it was dropped
      const total = Object.values(flooded.stats.accepted).reduce((sum, count) => sum + count, 0);
      const limited = Object.values(flooded.stats.limited).reduce((sum, count) => sum + count, 0);
      expect(limited + flooded.stats.malformed).toBeGreaterThan(5000);
      expect(total).toBeLessThan(150);
      expect(flooded.stats.accepted.intent).toBeLessThanOrEqual(4 * (COSMETIC_LIMITS.intent.burst + 1) + 20);
      expect(flooded.stats.accepted.ping).toBeLessThanOrEqual(4 * (COSMETIC_LIMITS.ping.burst + 1) + 5);
    });
  });
});
