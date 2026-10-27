/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { ownerOf } from "#coop/control";
import { turnCommandsKey } from "#coop/decision-keys";
import { safeLegality } from "#coop/legal";
import { gameLegalityView } from "#coop/legal-view";
import { keyId } from "#coop/protocol";
import type { ResyncPayload } from "#coop/resync";
import { rewardWindow } from "#coop/reward-actions";
import { DesyncError } from "#coop/sequencer";
import { modifierTypes } from "#data/data-lists";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { advanceTo, queueTurnCommands } from "#test/helpers/coop-harness";
import {
  attackCommand,
  type LinkedRun,
  type LinkedScenario,
  openLinkedRun,
  openRewardScreen,
  openScreen,
  partnerActs,
} from "#test/helpers/coop-linked";
import { getModifierType } from "#utils/modifier-utils";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * D24 on the real game: a decision that is not legal in the state the simulation is in is not applied by either client. The
 * real client is the host; the scripted guest looks at the same game with the same check, as a second client would, and both
 * raise the same desync. The host then reloads the wave under the next epoch, and nothing throws.
 */

const FOUR = [SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER, SpeciesId.PIKACHU];
const ALTERNATING = ["host", "guest", "host", "guest"] as const;

describe("Co-op: illegal decisions on the real game (D24)", () => {
  let phaserGame: Phaser.Game;
  let run: LinkedRun | null = null;
  /** What each sequencer reported, when it happened: the host's failure is forgotten by its own reload */
  let desyncs: { host: DesyncError[]; guest: DesyncError[] } = { host: [], guest: [] };

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
      species: FOUR,
      starterOwners: [...ALTERNATING],
      configure: game => game.override.startingLevel(40),
      policy: { auto: ["LEARN_MOVE", "EVOLUTION_CANCEL"] },
      names: { mine: "Sam", theirs: "Alex" },
      ...overrides,
    });
    // The guest's client has the same state at the same decision point, so it gets the same verdict. (Here both clients share
    // one game, which moves on as soon as the host reloads; the verdict is taken at the host's decision point and given to
    // the guest's sequencer. `legal-sequencer.test.ts` has two independent checks.)
    const verdicts = new Map<string, string | null>();
    const check = safeLegality(gameLegalityView, error => {
      throw error;
    });
    run.link.sequencer.setLegality((key, payload, author) => {
      const verdict = check(key, payload, author);
      verdicts.set(keyId(key), verdict);
      return verdict;
    });
    run.partner.sequencer.setLegality((key, _payload, _author) => verdicts.get(keyId(key)) ?? null);
    desyncs = { host: [], guest: [] };
    run.link.sequencer.onDesync(error => desyncs.host.push(error));
    run.partner.sequencer.onDesync(error => desyncs.guest.push(error));
    return run;
  }

  /** Both clients stopped at the same decision for the same reason, and the host reloads the wave */
  async function expectBothRejected(r: LinkedRun, reason: RegExp, waiting: Promise<unknown>): Promise<void> {
    try {
      await vi.waitUntil(() => desyncs.host.length > 0 && desyncs.guest.length > 0, { interval: 5, timeout: 6000 });
    } catch (error) {
      throw new Error(
        `the host reported ${desyncs.host.length} desyncs and the guest ${desyncs.guest.length}; the host's own: ${r.link.sequencer.desync?.message}; phase: ${globalScene.phaseManager.getCurrentPhase().phaseName}`,
        { cause: error },
      );
    }
    await expect(waiting).rejects.toBeInstanceOf(DesyncError);
    const [host] = desyncs.host as [DesyncError];
    const [guest] = desyncs.guest as [DesyncError];
    expect(host.message).toMatch(reason);
    expect(guest.message).toBe(host.message);
    expect(guest.seq).toBe(host.seq);
    expect(guest.actual).toEqual(host.actual);
    expect(desyncs.host).toHaveLength(1);
    expect(r.session.desyncMessage ?? host.message).toMatch(/illegal decision/);

    // it is a desync like any other: the host reloads the wave start, and the run goes on
    await vi.waitUntil(() => r.partner.resyncs.length === 1, { interval: 5, timeout: 6000 });
    const message = r.partner.resyncs[0] as ResyncPayload;
    expect(message).toMatchObject({ epoch: 1, reason: "desync" });
    r.partner.beginEpoch(message.epoch, message.seq + 1);
    await advanceTo(r.ctx, ["CommandPhase"]);
    expect(r.link.epoch).toBe(1);
    expect(r.link.sequencer.desync).toBeNull();
  }

  describe("the turn's commands", () => {
    /** The turn's commands are asked for: the phase opens its window and waits for the decisions */
    async function startTurnSync(r: LinkedRun): Promise<void> {
      await advanceTo(r.ctx, ["CoopTurnSyncPhase"]);
      globalScene.phaseManager.getCurrentPhase().start();
    }

    async function toGuestCommands(r: LinkedRun) {
      await advanceTo(r.ctx, ["CommandPhase"]);
      queueTurnCommands(r.ctx);
      const battle = globalScene.currentBattle;
      const guestMon = globalScene.getPlayerField().find(pokemon => ownerOf(pokemon) === "guest")!;
      const key = turnCommandsKey(battle.waveIndex, battle.turn, guestMon.id);
      const waiting = r.partner.sequencer.awaitDecision(key);
      waiting.catch(() => undefined);
      return { guestMon, key, waiting };
    }

    it("refuses a move the Pokémon does not know", async () => {
      const r = await start();
      const { key, waiting } = await toGuestCommands(r);
      expect(
        globalScene.getPlayerField().some(pokemon => pokemon.getMoveset().some(m => m.moveId === MoveId.EXPLOSION)),
      ).toBe(false);
      r.partner.propose(key, attackCommand(r.ctx.game, 1, MoveId.EXPLOSION));
      await startTurnSync(r);
      await expectBothRejected(r, /illegal decision: slot 0 holds move \d+, not 153/, waiting);
    });

    it("refuses a target the move cannot have", async () => {
      const r = await start();
      const { key, waiting } = await toGuestCommands(r);
      const legal = attackCommand(r.ctx.game, 1, MoveId.BITE);
      // the partner's own Pokémon is not a target of the same move at a foe: the move can go to the foes and the ally, not to a seat that is not there
      const payload = {
        ...legal,
        command: { ...legal.command!, targets: [7], move: { ...legal.command!.move!, targets: [7] } },
      };
      r.partner.propose(key, payload);
      await startTurnSync(r);
      await expectBothRejected(r, /illegal decision: targets \[7\]/, waiting);
    });

    it("refuses commands that cannot be read, from a partner that is not what it says it is", async () => {
      const r = await start();
      const { key, waiting } = await toGuestCommands(r);
      r.partner.propose(key, { command: { command: "FIGHT" }, pre: "no" });
      await startTurnSync(r);
      await expectBothRejected(r, /illegal decision: commands that cannot be read/, waiting);
    });
  });

  describe("the reward screen", () => {
    const rare = () => ({ type: getModifierType(modifierTypes.RARE_CANDY), upgradeCount: 0 });

    async function openWindow(r: LinkedRun) {
      await openRewardScreen(r, [rare() as never]);
      const { screen, picker, step } = openScreen();
      // the guest's simulation waits at the same step
      const waiting = r.partner.sequencer.awaitOneOf(
        rewardWindow(globalScene.currentBattle.waveIndex, screen, step, picker),
      );
      waiting.catch(() => undefined);
      return { waiting };
    }

    it("refuses a purchase that cannot be afforded", async () => {
      const r = await start();
      const { waiting } = await openWindow(r);
      globalScene.money = 0;
      partnerActs(r, { t: "buy", index: 0 });
      await expectBothRejected(r, /illegal decision: a purchase that costs more than the money there is/, waiting);
    });

    it("refuses a transfer of items that are not there", async () => {
      const r = await start();
      const { waiting } = await openWindow(r);
      const guestMon = globalScene.getPlayerParty().find(pokemon => ownerOf(pokemon) === "guest")!;
      const hostMon = globalScene.getPlayerParty().find(pokemon => ownerOf(pokemon) === "host")!;
      partnerActs(r, { t: "transfer", from: guestMon.id, to: hostMon.id, items: [{ index: 3, quantity: 1 }] });
      await expectBothRejected(r, /illegal decision: a transfer of items that are not there/, waiting);
    });
  });
});
