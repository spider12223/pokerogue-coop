/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { settings } from "#app/global-settings-manager";
import type { CosmeticMessage, PaceAt } from "#coop/cosmetic";
import { paceInfo, startPacer, stopPacer } from "#coop/pace-run";
import type { Seat } from "#coop/protocol";
import { Button } from "#enums/buttons";
import { GameSpeed } from "#enums/game-speed";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { advanceTo } from "#test/helpers/coop-harness";
import { type LinkedRun, openLinkedRun } from "#test/helpers/coop-linked";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Pacing in a linked run (DECISIONS D27): the host's screen is the clock of the run's text. The guest's line closes once the
 * host is past it, a press of the guest closes the host's line when the host waits on that same line, and the guest takes
 * the host's speeds while the run lasts.
 *
 * The test scene draws no text (its `showText` calls back at once), so these drive the battle's message box directly, in
 * a phase where lines are shared.
 */

const SIX = [
  SpeciesId.BULBASAUR,
  SpeciesId.SQUIRTLE,
  SpeciesId.CHARMANDER,
  SpeciesId.PIKACHU,
  SpeciesId.MACHOP,
  SpeciesId.GEODUDE,
];

/** The loopback delivers on a later tick */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 30));

describe("Co-op: pacing in a linked run (D27)", () => {
  let phaserGame: Phaser.Game;
  let run: LinkedRun | null = null;
  /** The game speed of this client before the run */
  let gameSpeed: number = GameSpeed.NORMAL;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    stopPacer();
    run?.close();
    run = null;
    vi.restoreAllMocks();
  });

  /** A linked run in its first battle, paced, in a phase whose lines both screens show */
  async function battle(seat: Seat): Promise<LinkedRun> {
    gameSpeed = settings.general.gameSpeed;
    run = await openLinkedRun(phaserGame, {
      seat,
      species: SIX,
      starterOwners: ["host", "guest", "host", "guest", "host", "guest"],
      policy: { auto: ["TURN_COMMANDS", "LEARN_MOVE", "EVOLUTION_CANCEL"] },
    });
    await advanceTo(run.ctx, ["CommandPhase"]);
    startPacer(run.session, run.link);
    // The command menus are each player's own: step into a phase of the battle's text, as a message would
    run.session.pace.phaseStarted("MessagePhase");
    await globalThis.Promise.resolve(run.ctx.game.scene.ui.setMode(UiMode.MESSAGE));
    return run;
  }

  /** Show a line that waits for a press; resolves when it closes */
  function showLine(r: LinkedRun, text: string): { closed: () => boolean } {
    let closed = false;
    r.ctx.game.scene.ui.getMessageHandler().showText(text, 0, () => (closed = true), null, true);
    return { closed: () => closed };
  }

  const position = (): PaceAt => [...paceInfo()!.position] as PaceAt;
  /** The host's `pace`, with this client's own settings unless `game` or `anim` say otherwise */
  const pace = (
    at: PaceAt,
    game: number = settings.general.gameSpeed,
    anim = settings.display.enableMoveAnimations,
  ): CosmeticMessage => ({
    t: "pace",
    at,
    game,
    exp: settings.general.expGainsSpeed,
    hp: settings.general.hpBarSpeed,
    iv: settings.general.hideIvScanner,
    anim,
    stats: settings.display.showStatsOnLevelUp,
  });

  it("guest: a line stays while the host is on it, and closes once the host is past it", async () => {
    const r = await battle("guest");
    const at = position();
    const line = showLine(r, "The wild Pidgey fainted!");
    expect(paceInfo()!.open).toEqual(at);

    r.partner.cosmetic(pace(at));
    await flush();
    expect(line.closed()).toBe(false);

    r.partner.cosmetic(pace([at[0], at[1], at[2] + 1]));
    await flush();
    expect(line.closed()).toBe(true);
    expect(paceInfo()!.position).toEqual([at[0], at[1], at[2] + 1]);
    expect(paceInfo()!.stats.followed).toBe(1);
  });

  it("guest: while behind, a line comes at once and goes by itself", async () => {
    const r = await battle("guest");
    const [checkpoint, phase] = position();
    // The host is a phase ahead already
    r.partner.cosmetic(pace([checkpoint, phase + 1, 0]));
    await flush();
    expect(paceInfo()!.behind).toBe(true);

    const handler = r.ctx.game.scene.ui.getMessageHandler();
    let closed = false;
    // The usual typing delay: the line still shows at once
    handler.showText("Bulbasaur grew to Lv. 6!", null, () => (closed = true), null, true);
    expect(handler.message.text).toContain("Bulbasaur grew to Lv. 6!");
    await vi.waitUntil(() => closed, { timeout: 2000, interval: 20 });
  });

  it("guest: a press tells the host which line it was", async () => {
    const r = await battle("guest");
    const at = position();
    const line = showLine(r, "Go! Squirtle!");
    r.ctx.game.scene.ui.getMessageHandler().processInput(Button.ACTION);
    expect(line.closed()).toBe(true);
    await flush();
    expect(r.partner.paceSeen).toContainEqual({ t: "press", at });
  });

  it("guest: takes the host's game speed and move animations while the run lasts, and gives them back", async () => {
    const r = await battle("guest");
    const animations = settings.display.enableMoveAnimations;
    const other = gameSpeed === GameSpeed.TURBO ? GameSpeed.SLOW : GameSpeed.TURBO;
    r.partner.cosmetic(pace(position(), other, !animations));
    await flush();
    expect(settings.general.gameSpeed).toBe(other);
    expect(settings.display.enableMoveAnimations).toBe(!animations);
    // A value that is not a game speed is not taken
    r.partner.cosmetic(pace(position(), 9));
    await flush();
    expect(settings.general.gameSpeed).toBe(other);
    stopPacer();
    expect(settings.general.gameSpeed).toBe(gameSpeed);
    expect(settings.display.enableMoveAnimations).toBe(animations);
  });

  it("host: a press of the guest closes the line the host waits on, and only that line", async () => {
    const r = await battle("host");
    const at = position();
    const line = showLine(r, "A wild Rattata appeared!");

    // A press for a line the host has not reached does not skip it
    r.partner.cosmetic({ t: "press", at: [at[0], at[1], at[2] + 1] });
    await flush();
    expect(line.closed()).toBe(false);

    r.partner.cosmetic({ t: "press", at });
    await flush();
    expect(line.closed()).toBe(true);
    expect(paceInfo()!.stats.presses).toBe(1);
  });

  it("host: tells the guest where it is, with its speeds", async () => {
    const r = await battle("host");
    const line = showLine(r, "A wild Rattata appeared!");
    r.ctx.game.scene.ui.getMessageHandler().processInput(Button.ACTION);
    expect(line.closed()).toBe(true);
    const at = position();
    await vi.waitUntil(
      () => r.partner.paceSeen.some(m => m.t === "pace" && m.at.join() === at.join() && m.game === gameSpeed),
      { timeout: 2000, interval: 20 },
    );
    // and the host's own lines never close by themselves
    const next = showLine(r, "Go! Bulbasaur!");
    r.partner.cosmetic(pace([at[0] + 5, 0, 0]));
    await flush();
    expect(next.closed()).toBe(false);
  });

  it("host: a burst of phases says where it is twice, at once and with the latest position, not once per phase", async () => {
    const r = await battle("host");
    await new Promise(resolve => setTimeout(resolve, 300));
    const before = r.partner.paceSeen.filter(m => m.t === "pace").length;
    for (let i = 0; i < 8; i++) {
      r.session.pace.phaseStarted("MessagePhase");
    }
    const latest = position();
    await vi.waitUntil(() => r.partner.paceSeen.some(m => m.t === "pace" && m.at.join() === latest.join()), {
      timeout: 2000,
      interval: 10,
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(r.partner.paceSeen.filter(m => m.t === "pace").length - before).toBe(2);
  });
});
