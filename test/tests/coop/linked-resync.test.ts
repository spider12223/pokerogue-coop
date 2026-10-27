/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { COOP_SLOT_KEY } from "#coop/coop-slot";
import { hideReconnectScreen, isEndSessionOffered, reconnectScreenText, showReconnectScreen } from "#coop/reconnect-ui";
import type { ResyncPayload } from "#coop/resync";
import { reportOf } from "#coop/resync-run";
import { isCoopSaveBlock } from "#coop/save-block";
import { currentCoopSlot } from "#coop/wave-save";
import { Button } from "#enums/buttons";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { advanceTo, queueTurnCommands } from "#test/helpers/coop-harness";
import { type LinkedRun, type LinkedScenario, openLinkedRun, pickerSkips, winWave } from "#test/helpers/coop-linked";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Resync (DECISIONS D13, D18, D19): the wave-start save, the resync after a checkpoint that differs, the third desync
 * of a wave, and the epoch. One real client, a scripted partner at the other end of the link.
 */

const FOUR = [SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER, SpeciesId.PIKACHU];
const ALTERNATING = ["host", "guest", "host", "guest"] as const;

describe("Co-op: save and resync (D13, D18, D19)", () => {
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
      species: FOUR,
      starterOwners: [...ALTERNATING],
      configure: game => game.override.startingLevel(40),
      policy: { auto: ["TURN_COMMANDS", "LEARN_MOVE", "EVOLUTION_CANCEL"] },
      names: { mine: "Sam", theirs: "Alex" },
      ...overrides,
    });
    return run;
  }

  describe("the wave-start save (D19)", () => {
    it("is the host's co-op slot, written where a solo run saves, and no solo slot is touched", async () => {
      const r = await start();
      // what a solo player has: two session slots
      localStorage.setItem("sessionData_Guest", "a solo run");
      localStorage.setItem("sessionData1_Guest", "another solo run");
      const writes = vi.spyOn(localStorage, "setItem");
      const removals = vi.spyOn(localStorage, "removeItem");

      await advanceTo(r.ctx, ["CommandPhase"]);

      const slot = currentCoopSlot();
      expect(slot).not.toBeNull();
      expect(slot).toMatchObject({
        version: 1,
        wave: 1,
        epoch: 0,
        names: { host: "Sam", guest: "Alex" },
        accountIds: r.session.accountIds,
      });
      // the same text as the save in memory, with the co-op block of D4 and D7
      expect(slot!.session).toBe(r.session.waveSave!.json);
      const saved = JSON.parse(slot!.session);
      expect(saved.waveIndex).toBe(1);
      expect(isCoopSaveBlock(saved.coop)).toBe(true);
      expect(saved.party).toHaveLength(FOUR.length);
      // the wave start wrote the co-op slot, and the player's own account (once: a fresh one has no saved ids yet); no
      // session slot is written or removed, and the solo slots are byte for byte what they were
      const written = writes.mock.calls.map(call => String(call[0]));
      expect(written).toContain(COOP_SLOT_KEY);
      expect(written.filter(key => key.startsWith("sessionData"))).toEqual([]);
      expect(written.filter(key => key !== COOP_SLOT_KEY && !key.startsWith("data_"))).toEqual([]);
      expect(removals.mock.calls.map(call => String(call[0])).filter(key => key.startsWith("sessionData"))).toEqual([]);
      expect(localStorage.getItem("sessionData_Guest")).toBe("a solo run");
      expect(localStorage.getItem("sessionData1_Guest")).toBe("another solo run");
    });

    it("is written again at the start of the next wave, with the epoch and the last seq", async () => {
      const r = await start();
      await advanceTo(r.ctx, ["CommandPhase"]);
      const first = currentCoopSlot()!;
      expect(first.wave).toBe(1);

      expect(await winWave(r)).toBe(true);
      pickerSkips(r);
      await advanceTo(r.ctx, ["CommandPhase"]);

      const second = currentCoopSlot()!;
      expect(second.wave).toBe(2);
      expect(second.session).not.toBe(first.session);
      expect(second.seq).toBeGreaterThan(first.seq); // the turn commands and the reward screen were decisions
      expect(second.seq).toBe(r.link.sequencer.nextExpected - 1);
      expect(second.epoch).toBe(r.link.epoch);
      expect(JSON.parse(second.session).coop.rewardPickCount).toBe(1);
    });

    it("is kept in memory only by the guest: it has no slot", async () => {
      const r = await start({ seat: "guest", starterOwners: ["host", "guest", "host", "guest"] });
      await advanceTo(r.ctx, ["CommandPhase"]);
      expect(r.session.waveSave).toMatchObject({ wave: 1, epoch: 0 });
      expect(JSON.parse(r.session.waveSave!.json).waveIndex).toBe(1);
      expect(currentCoopSlot()).toBeNull();
      expect(localStorage.getItem(COOP_SLOT_KEY)).toBeUndefined();
    });
  });

  describe("the waiting screen (D20)", () => {
    it("says who is away and the room code, offers to end the session after a while, and ends it when chosen", async () => {
      const r = await start();
      await advanceTo(r.ctx, ["CommandPhase"]);
      const onEnd = vi.fn();

      showReconnectScreen({ partner: "Alex", code: "ABC234", back: false, onEnd, endAfterMs: 40 });
      expect(reconnectScreenText()).toBe("Waiting for Alex to reconnect…\nRoom code: ABC234");
      expect(isEndSessionOffered()).toBe(false);

      // after the wait, the way out is offered
      await vi.waitUntil(() => isEndSessionOffered(), { interval: 5, timeout: 4000 });
      expect(r.ctx.game.scene.ui.mode).toBe(UiMode.OPTION_SELECT);

      // "End session" is the first option
      r.ctx.game.scene.ui.processInput(Button.ACTION);
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(reconnectScreenText()).toBeNull();
    });

    it("says that the partner is back; the way out comes only after a longer wait: the reload is on its way", async () => {
      const r = await start();
      await advanceTo(r.ctx, ["CommandPhase"]);
      showReconnectScreen({ partner: "Alex", code: "ABC234", back: false, onEnd: vi.fn(), endAfterMs: 50 });
      showReconnectScreen({ partner: "Alex", code: "ABC234", back: true, onEnd: vi.fn(), endAfterMs: 50 });
      expect(reconnectScreenText()).toBe("Alex is back. Getting the game ready…");
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(isEndSessionOffered()).toBe(false);
      // a reload that never comes does not trap the player (three times the usual wait)
      await vi.waitUntil(() => isEndSessionOffered(), { interval: 10, timeout: 1000 });
      hideReconnectScreen();
      expect(reconnectScreenText()).toBeNull();
    });
  });

  describe("the guest applies the host's RESYNC (D13, D18)", () => {
    it("loads the save it carries, takes the epoch and goes on from the seq after it", async () => {
      const r = await start({ seat: "guest" });
      await advanceTo(r.ctx, ["CommandPhase"]);
      const waveStart = r.session.checkpoints.entries[0]!;
      const save = r.session.waveSave!.json; // (the host's save of the wave is the same state)
      expect(r.link.epoch).toBe(0);

      // the host sequences a RESYNC: it takes seq 5, and brings epoch 1
      const message: ResyncPayload = { epoch: 1, seq: 5, wave: 1, reason: "rejoin", save };
      r.partner.channel.sendAt(1, { key: null, seq: 5, author: "host", kind: "RESYNC", payload: message });
      await vi.waitUntil(() => r.link.epoch === 1, { interval: 5, timeout: 4000 });
      expect(r.session.resyncs).toEqual([{ epoch: 1, reason: "rejoin", wave: 1 }]);
      expect(r.link.sequencer.nextExpected).toBe(6);

      // the host's client applies it too, and the wave starts again with the state it started with
      r.partner.beginEpoch(1, 6);
      await advanceTo(r.ctx, ["CommandPhase"]);
      expect(r.session.checkpoints.entries[0]).toMatchObject({ kind: "waveStart", wave: 1, hash: waveStart.hash });
      expect(r.session.checkpointHistory).toHaveLength(1);

      // a turn of the new epoch: the decisions are the ones after the RESYNC
      const seen: number[] = [];
      r.link.sequencer.onDecision(decision => seen.push(decision.seq));
      queueTurnCommands(r.ctx);
      await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toBe(6);
      expect(r.session.desyncMessage).toBeNull();
    });

    it("holds off while a phase runs that cannot be abandoned, and does it at the next safe point", async () => {
      const r = await start({ seat: "guest" });
      await advanceTo(r.ctx, ["CommandPhase"]);
      const save = r.session.waveSave!.json;
      // an animation is running (not a decision, not the player's commands): a reload now would abandon it halfway
      const real = r.ctx.game.scene.phaseManager.getCurrentPhase;
      vi.spyOn(r.ctx.game.scene.phaseManager, "getCurrentPhase").mockReturnValue({ phaseName: "MovePhase" } as never);
      r.partner.channel.sendAt(1, {
        key: null,
        seq: 2,
        author: "host",
        kind: "RESYNC",
        payload: { epoch: 1, seq: 2, wave: 1, reason: "rejoin", save } satisfies ResyncPayload,
      });
      await vi.waitUntil(() => r.session.pendingResync !== null, { interval: 5, timeout: 4000 });
      await new Promise(resolve => setTimeout(resolve, 600)); // beyond the poll of the resync (250 ms)
      expect(r.link.epoch).toBe(0);
      expect(r.session.resyncs).toHaveLength(0);

      // the phase that runs is one that waits for the player: now it is safe
      vi.mocked(r.ctx.game.scene.phaseManager.getCurrentPhase).mockImplementation(
        real.bind(r.ctx.game.scene.phaseManager),
      );
      await vi.waitUntil(() => r.link.epoch === 1, { interval: 10, timeout: 4000 });
      expect(r.session.pendingResync).toBeNull();
    });
  });

  describe("a checkpoint that differs (D13, D18)", () => {
    /** The partner reports the checkpoint of this index with a hash that is not the real client's */
    async function disagree(r: LinkedRun, index: number): Promise<void> {
      const local = r.session.checkpoints.entries[index] ?? r.session.checkpointHistory.at(-1)!.entries[index]!;
      r.partner.sendCheckpoint({
        index,
        kind: local.kind,
        wave: local.wave,
        turn: local.turn,
        phaseName: local.phaseName,
        hash: "badbadbadbadba",
      });
    }

    /** Both clients carry out the reload: the partner applies the `RESYNC` it was sent, the real client runs its phase */
    async function reload(r: LinkedRun, which = 0): Promise<ResyncPayload> {
      await vi.waitUntil(() => r.partner.resyncs.length > which, { interval: 5, timeout: 4000 });
      const message = r.partner.resyncs[which] as ResyncPayload;
      r.partner.beginEpoch(message.epoch, message.seq + 1);
      await advanceTo(r.ctx, ["CommandPhase"]);
      return message;
    }

    it("makes the host reload the wave start under the next epoch, and the hashes of the new epoch are the old ones", async () => {
      const r = await start();
      await advanceTo(r.ctx, ["CommandPhase"]);
      const waveStart = r.session.checkpoints.entries[0]!;
      const saveBefore = r.session.waveSave!.json;
      expect(r.link.epoch).toBe(0);

      await disagree(r, 0);
      await vi.waitUntil(() => r.session.resyncs.length === 1, { interval: 5, timeout: 4000 });
      const message = await reload(r);

      // the host sequenced a RESYNC with the save of this wave: it takes the next seq, and the epoch goes up by one
      expect(message).toMatchObject({ epoch: 1, wave: 1, reason: "mismatch" });
      expect(message.save).toBe(saveBefore);
      expect(message.seq).toBeGreaterThanOrEqual(1);
      expect(r.link.epoch).toBe(1);
      expect(r.session.resyncs).toEqual([{ epoch: 1, reason: "mismatch", wave: 1 }]);
      expect(r.session.checkpointMismatch).toBeNull();
      expect(r.session.desyncMessage).toBeNull();

      // the log of the old epoch is kept apart; the new one starts from 0 with the wave start of the same wave
      expect(r.session.checkpointHistory).toHaveLength(1);
      expect(r.session.checkpointHistory[0]!.epoch).toBe(0);
      const again = r.session.checkpoints.entries[0]!;
      expect(again).toMatchObject({ index: 0, kind: "waveStart", wave: 1 });
      expect(again.hash).toBe(waveStart.hash); // the reload is faithful: the same state
      expect(r.session.waveSave).toMatchObject({ wave: 1, epoch: 1 });
    });

    it("drops what the partner sent in the old epoch, and goes on with the new one: the next turn is decided and hashed", async () => {
      const r = await start();
      await advanceTo(r.ctx, ["CommandPhase"]);
      await disagree(r, 0);
      await vi.waitUntil(() => r.partner.resyncs.length === 1, { interval: 5, timeout: 4000 });
      expect(r.link.epoch).toBe(1);

      // the partner has not applied the RESYNC yet: its checkpoint is of the old epoch, and the host drops it. It is not
      // a new mismatch, and not a second reload.
      const droppedBefore = r.link.channel.stats.droppedOlder;
      await disagree(r, 0);
      await vi.waitUntil(() => r.link.channel.stats.droppedOlder > droppedBefore, { interval: 5, timeout: 4000 });
      expect(r.session.checkpointMismatch).toBeNull();
      expect(r.session.resyncs).toHaveLength(1);

      // the partner applies it, and the new epoch works: a turn is commanded by both and hashed
      const message = r.partner.resyncs[0] as ResyncPayload;
      r.partner.beginEpoch(message.epoch, message.seq + 1);
      await advanceTo(r.ctx, ["CommandPhase"]);
      queueTurnCommands(r.ctx);
      await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);
      expect(r.session.desyncMessage).toBeNull();
      // the log of the new epoch has the start of the wave, the first turn and the end of the wave, all taken after the reload
      expect(r.session.checkpoints.entries.map(c => c.kind)).toEqual(
        expect.arrayContaining(["waveStart", "turn", "waveEnd"]),
      );
      // the partner reports the same hashes as the host from there on: nothing differs
      for (const entry of r.session.checkpoints.entries) {
        r.partner.sendCheckpoint({ ...entry });
      }
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(r.session.checkpointMismatch).toBeNull();
      expect(r.session.resyncs).toHaveLength(1);
    });

    it("is asked for by the guest, and the host decides", async () => {
      const r = await start();
      await advanceTo(r.ctx, ["CommandPhase"]);
      expect(r.partner.resyncs).toHaveLength(0);
      r.partner.sendResyncRequest({ reason: "mismatch", wave: 1, mismatch: null });
      const message = await reload(r);
      expect(message).toMatchObject({ epoch: 1, reason: "mismatch" });
      expect(r.link.epoch).toBe(1);
    });

    it("stops the run at the third desync of the same wave, and has a report with both traces and the two hashes", async () => {
      const r = await start();
      await advanceTo(r.ctx, ["CommandPhase"]);

      // the first and the second desync of wave 1 are resynced
      for (let strike = 1; strike <= 2; strike++) {
        await disagree(r, 0);
        const message = await reload(r, strike - 1);
        expect(message.epoch).toBe(strike);
        expect(r.session.resyncBook.desyncsOf(1)).toBe(strike);
      }
      expect(r.session.stopped).toBeNull();

      // the third is not
      await disagree(r, 0);
      await vi.waitUntil(() => r.partner.resyncs.length === 3, { interval: 5, timeout: 4000 });
      const stop = r.partner.resyncs[2]!;
      expect(stop).toMatchObject({ stop: true, epoch: 3, wave: 1 });
      expect(r.session.stopped).toMatchObject({ stop: true, wave: 1 });
      expect(r.session.resyncBook.desyncsOf(1)).toBe(3);
      expect(r.link.epoch).toBe(3);
      // no reload: the save of the wave is still the one in the slot
      expect(currentCoopSlot()!.wave).toBe(1);

      // the partner's side of the report arrives, and the report has both
      r.partner.beginEpoch(3, stop.seq + 1);
      r.partner.channel.send({
        key: null,
        author: "guest",
        kind: "REPORT",
        payload: {
          mismatch: {
            index: 0,
            kind: "waveStart",
            wave: 1,
            turn: 1,
            phaseName: "EncounterPhase",
            local: "guesthash",
            remote: "hosthash",
          },
          trace: [{ index: 0, wave: 1, turn: 1, phaseName: "EncounterPhase", rng: "0".repeat(14) }],
          checkpoints: [],
        },
      });
      await vi.waitUntil(() => r.session.partnerReport !== null, { interval: 5, timeout: 4000 });
      const report = reportOf(r.session)!;
      expect(report).toMatchObject({ seat: "host", wave: 1, epoch: 3, names: { host: "Sam", guest: "Alex" } });
      expect(report.traces.host!.length).toBeGreaterThan(0);
      expect(report.traces.guest).toHaveLength(1);
      expect(report.mismatch).toMatchObject({ kind: "waveStart", wave: 1, remote: "badbadbadbadba" });
      expect(report.partnerMismatch).toMatchObject({ local: "guesthash" });
      expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    });
  });
});
