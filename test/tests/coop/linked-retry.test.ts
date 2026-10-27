/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { deciderOf } from "#coop/control";
import { retryKey } from "#coop/decision-keys";
import { keyId } from "#coop/protocol";
import type { ResyncPayload } from "#coop/resync";
import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { advanceTo } from "#test/helpers/coop-harness";
import {
  attackCommand,
  type LinkedRun,
  type LinkedScenario,
  openLinkedRun,
  playToRunEnd,
} from "#test/helpers/coop-linked";
import type { OptionSelectUiHandler } from "#ui/option-select-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The retry after a wipe (DECISIONS D4a, amended; D13, D18): the host chooses to play the wave again from its start or to end
 * the run, as a sequenced decision. A retry is the reload of a resync with the reason `retry`. One real client, a scripted
 * partner at the other end of the link.
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

describe("Co-op: the retry after a wipe (D4a)", () => {
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

  /** Every turn both field Pokémon faint (the real client's by itself, the partner's as it commands), until no one is left */
  async function start(overrides: Partial<LinkedScenario> = {}): Promise<LinkedRun> {
    run = await openLinkedRun(phaserGame, {
      seat: "host",
      species: SIX,
      starterOwners: [...ALTERNATING],
      configure: game => game.override.startingLevel(40),
      faints: [1, 2, 3].map(turn => ({ wave: 1, turn, slots: [0, 1] as (0 | 1)[] })),
      names: { mine: "Sam", theirs: "Alex" },
      retry: "menu",
      ...overrides,
      policy: {
        auto: ["TURN_COMMANDS", "FAINT_SWITCH", "LEARN_MOVE", "EVOLUTION_CANCEL"],
        commands: (_pokemon, slot) => attackCommand(run!.ctx.game, slot, MoveId.MEMENTO),
        ...overrides.policy,
      },
    });
    return run;
  }

  /** What the wave starts with: each Pokémon's HP, the first checkpoint and the save */
  function waveStartOf(r: LinkedRun) {
    return {
      hp: r.ctx.game.scene.getPlayerParty().map(pokemon => [pokemon.id, pokemon.hp]),
      hash: r.session.checkpoints.entries[0]!.hash,
      save: r.session.waveSave!.json,
    };
  }

  /** The host's menu after the wipe: wait for it (and for its input delay), then choose */
  async function answerMenu(r: LinkedRun, retry: boolean): Promise<string[]> {
    const { scene } = r.ctx.game;
    await vi.waitUntil(
      () => scene.phaseManager.getCurrentPhase().is("GameOverPhase") && scene.ui.mode === UiMode.OPTION_SELECT,
      { interval: 5, timeout: 6000 },
    );
    const handler = scene.ui.getHandler() as OptionSelectUiHandler;
    const internals = handler as unknown as { blockInput: boolean; config: { options: { label: string }[] } };
    const labels = internals.config.options.map(option => option.label);
    await vi.waitUntil(() => !internals.blockInput, { interval: 10, timeout: 4000 });
    handler.setCursor(retry ? 0 : 1);
    handler.processInput(Button.ACTION);
    return labels;
  }

  /** The texts the real client shows from now on */
  function spyOnTexts(r: LinkedRun): string[] {
    const { ui } = r.ctx.game.scene;
    const shown: string[] = [];
    const showText = ui.showText.bind(ui);
    vi.spyOn(ui, "showText").mockImplementation((text, ...rest) => {
      shown.push(text);
      return showText(text, ...rest);
    });
    return shown;
  }

  it("(a) the host retries: both clients reload the wave start under the next epoch, and no run is written", async () => {
    const r = await start();
    const { game } = r.ctx;
    await advanceTo(r.ctx, ["CommandPhase"]);
    const before = waveStartOf(r);
    const history = vi.spyOn(game.scene.gameData, "saveRunHistory");
    const shown = spyOnTexts(r);
    expect(deciderOf({ kind: "RETRY" })).toBe("host");
    expect(r.link.epoch).toBe(0);

    expect(await playToRunEnd(r)).toBe(false);
    expect(game.scene.getPlayerParty().every(pokemon => pokemon.isFainted())).toBe(true);
    const next = advanceTo(r.ctx, ["CommandPhase", "PostGameOverPhase"]);
    next.catch(() => undefined);

    // the host is asked, with the two choices; Co-op does not read the retry setting (it is pinned off)
    expect(await answerMenu(r, true)).toEqual(["Retry the wave", "End the run"]);
    expect(shown).toContain("Your party is out of usable Pokémon. Retry the wave from its start?");

    // the host sequenced the decision, then a RESYNC with the save of the wave and the next epoch
    await vi.waitUntil(() => r.partner.resyncs.length === 1, { interval: 5, timeout: 4000 });
    const message = r.partner.resyncs[0] as ResyncPayload;
    expect(message).toMatchObject({ epoch: 1, wave: 1, reason: "retry" });
    expect(message.save).toBe(before.save);
    r.partner.beginEpoch(message.epoch, message.seq + 1);

    expect(await next).toBe("CommandPhase");
    expect(shown).toContain("Retrying the wave…");
    expect(game.scene.currentBattle.waveIndex).toBe(1);
    expect(r.link.epoch).toBe(1);
    expect(r.session.resyncs).toEqual([{ epoch: 1, reason: "retry", wave: 1 }]);
    // not a desync strike
    expect(r.session.resyncBook.desyncsOf(1)).toBe(0);
    // the party is back as it was at the start of the wave: the same state, the same hash
    expect(game.scene.getPlayerParty().map(pokemon => [pokemon.id, pokemon.hp])).toEqual(before.hp);
    expect(r.session.checkpoints.entries[0]).toMatchObject({ kind: "waveStart", wave: 1, hash: before.hash });
    // nothing of the end of a run happened
    expect(history).not.toHaveBeenCalled();
    expect(Object.keys(await game.scene.gameData.getRunHistoryData())).toHaveLength(0);
    expect(game.scene.gameData.gameStats.coopRunsWon).toBe(0);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("(b) the host ends the run: it ends as before, and nothing is reloaded", async () => {
    const r = await start();
    const { game } = r.ctx;
    await advanceTo(r.ctx, ["CommandPhase"]);

    expect(await playToRunEnd(r)).toBe(false);
    const next = advanceTo(r.ctx, ["CommandPhase", "PostGameOverPhase"]);
    next.catch(() => undefined);
    await answerMenu(r, false);

    expect(await next).toBe("PostGameOverPhase");
    await vi.waitUntil(async () => Object.keys(await game.scene.gameData.getRunHistoryData()).length === 1, {
      interval: 5,
      timeout: 4000,
    });
    const [entry] = Object.values(await game.scene.gameData.getRunHistoryData());
    expect(entry).toMatchObject({ isVictory: false, coop: { names: { host: "Sam", guest: "Alex" }, seat: "host" } });
    expect(r.partner.resyncs).toHaveLength(0);
    expect(r.link.epoch).toBe(0);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("(c) the guest waits for the host's answer, and reloads with the host's RESYNC when it comes", async () => {
    const r = await start({
      seat: "guest",
      names: { mine: "Alex", theirs: "Sam" },
      policy: { other: key => (key.kind === "RETRY" ? { retry: true } : undefined) },
    });
    const { game } = r.ctx;
    await advanceTo(r.ctx, ["CommandPhase"]);
    const before = waveStartOf(r);
    const history = vi.spyOn(game.scene.gameData, "saveRunHistory");
    const shown = spyOnTexts(r);

    expect(await playToRunEnd(r)).toBe(false);
    const next = advanceTo(r.ctx, ["CommandPhase", "PostGameOverPhase"]);
    next.catch(() => undefined);

    // the scripted host retries; the guest only waits for its reload, which may come at any moment now
    await vi.waitUntil(() => r.session.retryPending, { interval: 5, timeout: 6000 });
    expect(shown).toContain("Sam is deciding whether to retry the wave…");
    expect(r.partner.answeredKeys).toContain(keyId(retryKey(1)));
    expect(r.link.epoch).toBe(0);
    expect(game.scene.phaseManager.getCurrentPhase().is("GameOverPhase")).toBe(true);

    const message = r.partner.resync("retry", 1, before.save);
    expect(await next).toBe("CommandPhase");
    expect(r.link.epoch).toBe(1);
    expect(r.link.sequencer.nextExpected).toBe(message.seq + 1);
    expect(r.session.resyncs).toEqual([{ epoch: 1, reason: "retry", wave: 1 }]);
    expect(r.session.retryPending).toBe(false);
    expect(game.scene.getPlayerParty().map(pokemon => [pokemon.id, pokemon.hp])).toEqual(before.hp);
    expect(r.session.checkpoints.entries[0]).toMatchObject({ kind: "waveStart", wave: 1, hash: before.hash });
    expect(history).not.toHaveBeenCalled();
    expect(r.session.desyncMessage).toBeNull();
  });

  it("(c) the guest also reloads when the host's RESYNC follows its answer at once", async () => {
    let save = "";
    const r = await start({
      seat: "guest",
      policy: {
        other: key => {
          if (key.kind !== "RETRY") {
            return;
          }
          // the decision is sequenced when this returns; the RESYNC goes out right behind it, as the game's host does
          queueMicrotask(() => run!.partner.resync("retry", 1, save));
          return { retry: true };
        },
      },
    });
    const { game } = r.ctx;
    await advanceTo(r.ctx, ["CommandPhase"]);
    const before = waveStartOf(r);
    save = before.save;

    expect(await playToRunEnd(r)).toBe(false);
    expect(await advanceTo(r.ctx, ["CommandPhase", "PostGameOverPhase"])).toBe("CommandPhase");
    expect(r.link.epoch).toBe(1);
    expect(r.session.resyncs).toEqual([{ epoch: 1, reason: "retry", wave: 1 }]);
    expect(game.scene.getPlayerParty().map(pokemon => [pokemon.id, pokemon.hp])).toEqual(before.hp);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("(c) the guest ends the run with the host when the host does not retry", async () => {
    const r = await start({ seat: "guest" });
    const { game } = r.ctx;
    await advanceTo(r.ctx, ["CommandPhase"]);

    expect(await playToRunEnd(r)).toBe(false);
    expect(await advanceTo(r.ctx, ["CommandPhase", "PostGameOverPhase"])).toBe("PostGameOverPhase");
    expect(r.partner.answeredKeys).toContain(keyId(retryKey(1)));
    expect(r.link.epoch).toBe(0);
    expect(game.scene.gameData.gameStats.coopRunsWon).toBe(0);
  });

  it("is not asked without a wave-start save to go back to: the run ends as before", async () => {
    const r = await start();
    await advanceTo(r.ctx, ["CommandPhase"]);
    r.session.waveSave = null;

    expect(await playToRunEnd(r)).toBe(false);
    // (the real menu is on: a question would hold the game over phase until the advance stalls)
    expect(await advanceTo(r.ctx, ["CommandPhase", "PostGameOverPhase"])).toBe("PostGameOverPhase");
    expect(r.session.openWindow).toEqual([]);
    expect(r.partner.resyncs).toHaveLength(0);
  });
});
