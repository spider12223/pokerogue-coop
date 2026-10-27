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
import { rewardWindow } from "#coop/reward-actions";
import type { DesyncError } from "#coop/sequencer";
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
 * real client is the host; it checks a guest's proposal before it sequences it, and refuses an illegal one: nothing is
 * sequenced, nobody desyncs, and the decision is still to come.
 */

const FOUR = [SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER, SpeciesId.PIKACHU];
const ALTERNATING = ["host", "guest", "host", "guest"] as const;

describe("Co-op: illegal decisions on the real game (D24)", () => {
  let phaserGame: Phaser.Game;
  let run: LinkedRun | null = null;
  /** What each sequencer reported, when it happened */
  let desyncs: { host: DesyncError[]; guest: DesyncError[] } = { host: [], guest: [] };
  /** The host's verdicts, by key */
  let verdicts = new Map<string, string | null>();
  /** What the host refused of the scripted guest's proposals */
  let refused: { key: unknown; reason: string }[] = [];

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
    verdicts = new Map<string, string | null>();
    refused = [];
    run.partner.sequencer.onProposalRejected(info => refused.push(info));
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

  /**
   * The host refused the guest's proposal for `reason` before sequencing it: the guest is told (`invalid`), nothing is
   * sequenced, neither client desyncs, and the decision is still open
   */
  async function expectRefused(r: LinkedRun, reason: RegExp, waiting: Promise<unknown>): Promise<void> {
    try {
      await vi.waitUntil(() => refused.length > 0, { interval: 5, timeout: 6000 });
    } catch (error) {
      throw new Error(
        `nothing was refused; desyncs: host ${desyncs.host.length}, guest ${desyncs.guest.length}; phase: ${globalScene.phaseManager.getCurrentPhase().phaseName}`,
        { cause: error },
      );
    }
    expect(refused[0].reason).toBe("invalid");
    const reasons = [...verdicts.values()].filter((verdict): verdict is string => verdict !== null);
    expect(
      reasons.some(verdict => reason.test(verdict)),
      `verdicts: ${reasons.join(" | ")}`,
    ).toBe(true);
    let settled: string | null = null;
    waiting.then(
      value => {
        settled = `resolved ${JSON.stringify(value)}`;
      },
      error => {
        settled = `rejected ${error}`;
      },
    );
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(settled).toBeNull();
    expect(desyncs.host).toHaveLength(0);
    expect(desyncs.guest).toHaveLength(0);
    expect(r.link.sequencer.desync).toBeNull();
    expect(r.partner.resyncs).toHaveLength(0);
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
      // The guest's simulation waits for every slot's commands at once, as `CoopTurnSyncPhase` does: the host's own may be
      // sequenced first
      for (const pokemon of globalScene.getPlayerField()) {
        if (pokemon !== guestMon) {
          r.partner.sequencer
            .awaitDecision(turnCommandsKey(battle.waveIndex, battle.turn, pokemon.id))
            .catch(() => undefined);
        }
      }
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
      await expectRefused(r, /slot 0 holds move \d+, not 153/, waiting);
    });

    it("refuses a target the move cannot have", async () => {
      const r = await start();
      const { guestMon, key, waiting } = await toGuestCommands(r);
      const legal = attackCommand(r.ctx.game, 1, MoveId.BITE);
      // Bite goes to a foe or the ally, never to the user itself
      const self = guestMon.getBattlerIndex();
      const payload = {
        ...legal,
        command: { ...legal.command!, targets: [self], move: { ...legal.command!.move!, targets: [self] } },
      };
      r.partner.propose(key, payload);
      await startTurnSync(r);
      await expectRefused(r, /targets \[\d\] that move \d+ cannot have/, waiting);
    });

    it("refuses commands that cannot be read, from a partner that is not what it says it is", async () => {
      const r = await start();
      const { key, waiting } = await toGuestCommands(r);
      r.partner.propose(key, { command: { command: "FIGHT" }, pre: "no" });
      await startTurnSync(r);
      await expectRefused(r, /commands that cannot be read/, waiting);
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
      await expectRefused(r, /a purchase that costs more than the money there is/, waiting);
    });

    it("refuses a transfer of items that are not there", async () => {
      const r = await start();
      const { waiting } = await openWindow(r);
      const guestMon = globalScene.getPlayerParty().find(pokemon => ownerOf(pokemon) === "guest")!;
      const hostMon = globalScene.getPlayerParty().find(pokemon => ownerOf(pokemon) === "host")!;
      partnerActs(r, { t: "transfer", from: guestMon.id, to: hostMon.id, items: [{ index: 3, quantity: 1 }] });
      await expectRefused(r, /a transfer of items that are not there/, waiting);
    });
  });
});
