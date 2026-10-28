/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { HostRoom } from "#coop/link";
import { playAgainNetwork, startPlayAgain } from "#coop/play-again";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { advanceTo } from "#test/helpers/coop-harness";
import {
  answerEndScreen,
  attackCommand,
  type LinkedRun,
  type LinkedScenario,
  openLinkedRun,
  playToRunEnd,
} from "#test/helpers/coop-linked";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, type MockInstance, vi } from "vitest";

/**
 * "Play again" on the end screen of a co-op run (D35): both answers travel on the run's link; once both want to, the host
 * creates the new room and sends its code, and the title screen starts the new game (the host waits in the room, the guest
 * joins it). The relay is not reached here: creating a room, hosting in it and joining it are stand-ins.
 */

const room = { identity: { code: "ABC234", seat: "host", token: "t" }, cancel: () => undefined } as unknown as HostRoom;

const SIX = [
  SpeciesId.BULBASAUR,
  SpeciesId.SQUIRTLE,
  SpeciesId.CHARMANDER,
  SpeciesId.PIKACHU,
  SpeciesId.MACHOP,
  SpeciesId.GEODUDE,
];

const callbacks = { onConnected: () => undefined, onCancel: () => undefined };

describe("Co-op: Play again at the end of a run (D35)", () => {
  let phaserGame: Phaser.Game;
  let run: LinkedRun | null = null;
  let stand: {
    createRoom: MockInstance<typeof playAgainNetwork.createRoom>;
    hostAgain: MockInstance<typeof playAgainNetwork.host>;
    joinGame: MockInstance<typeof playAgainNetwork.join>;
  };

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    run?.close();
    run = null;
    // nothing is left for the next title screen
    startPlayAgain(callbacks);
    vi.restoreAllMocks();
  });

  /** Every turn both field Pokémon faint, until no one is left; the host ends the run (no retry) */
  async function start(seat: LinkedScenario["seat"]): Promise<LinkedRun> {
    run = await openLinkedRun(phaserGame, {
      seat,
      species: SIX,
      starterOwners: ["host", "guest", "host", "guest", "host", "guest"],
      configure: game => game.override.startingLevel(40),
      faints: [1, 2, 3].map(turn => ({ wave: 1, turn, slots: [0, 1] as (0 | 1)[] })),
      names: { mine: "Sam", theirs: "Alex" },
      policy: {
        auto: ["TURN_COMMANDS", "FAINT_SWITCH", "LEARN_MOVE", "EVOLUTION_CANCEL"],
        commands: (_pokemon, slot) => attackCommand(run!.ctx.game, slot, MoveId.MEMENTO),
      },
    });
    // (after the run is open: opening it restores every mock)
    stand = {
      createRoom: vi.spyOn(playAgainNetwork, "createRoom").mockResolvedValue(room),
      hostAgain: vi.spyOn(playAgainNetwork, "host").mockResolvedValue(),
      joinGame: vi.spyOn(playAgainNetwork, "join").mockResolvedValue(),
    };
    return run;
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

  it("host: both want to; the host makes the room, sends its code, and waits in it at the title screen", async () => {
    const r = await start("host");
    const shown = spyOnTexts(r);
    expect(await playToRunEnd(r)).toBe(false);
    // the partner answers before this client's end screen asks: the answer is kept
    r.partner.sendLobby({ t: "again", want: true });
    const toTitle = advanceTo(r.ctx, ["TitlePhase"]);

    expect(await answerEndScreen(r, true)).toEqual(["Play again with Alex", "Back to title"]);
    expect(shown).toContain("Co-op run ended. Alex wants to play again!");
    await vi.waitUntil(() => r.partner.lobbySeen.some(message => message.t === "againCode"), {
      interval: 5,
      timeout: 10_000,
    });
    expect(r.partner.lobbySeen).toEqual([
      { t: "again", want: true },
      { t: "againCode", code: "ABC234" },
    ]);
    expect(shown).toContain("Starting a new game with Alex…");
    // the guest leaves the old room with the code: the host goes on
    r.partner.bye();
    expect(await toTitle).toBe("TitlePhase");

    expect(startPlayAgain(callbacks)).toBe(true);
    expect(stand.hostAgain).toHaveBeenCalledWith(callbacks, room, "Alex");
    expect(stand.joinGame).not.toHaveBeenCalled();
    // once only
    expect(startPlayAgain(callbacks)).toBe(false);
  });

  it("guest: it waits for the host's answer, then for the code, and joins the new room", async () => {
    const r = await start("guest");
    const shown = spyOnTexts(r);
    expect(await playToRunEnd(r)).toBe(false);
    const toTitle = advanceTo(r.ctx, ["TitlePhase"]);

    await answerEndScreen(r, true);
    await vi.waitUntil(() => shown.includes("Waiting for Alex…"), { interval: 5, timeout: 10_000 });
    expect(r.partner.lobbySeen).toEqual([{ t: "again", want: true }]);
    r.partner.sendLobby({ t: "again", want: true });
    await vi.waitUntil(() => shown.includes("Starting a new game with Alex…"), { interval: 5, timeout: 10_000 });
    r.partner.sendLobby({ t: "againCode", code: "ABC234" });
    expect(await toTitle).toBe("TitlePhase");

    expect(startPlayAgain(callbacks)).toBe(true);
    expect(stand.joinGame).toHaveBeenCalledWith("ABC234", callbacks);
    expect(stand.createRoom).not.toHaveBeenCalled();
  });

  it("the partner goes back to the title: this player is told, and nothing starts", async () => {
    const r = await start("host");
    const shown = spyOnTexts(r);
    expect(await playToRunEnd(r)).toBe(false);
    const toTitle = advanceTo(r.ctx, ["TitlePhase"]);

    await answerEndScreen(r, true);
    r.partner.sendLobby({ t: "again", want: false });
    expect(await toTitle).toBe("TitlePhase");

    expect(shown).toContain("Alex went back to the title.");
    expect(stand.createRoom).not.toHaveBeenCalled();
    expect(startPlayAgain(callbacks)).toBe(false);
  });

  it("the partner leaves the room before answering: this player is told, and nothing starts", async () => {
    const r = await start("guest");
    const shown = spyOnTexts(r);
    expect(await playToRunEnd(r)).toBe(false);
    const toTitle = advanceTo(r.ctx, ["TitlePhase"]);

    await answerEndScreen(r, true);
    r.partner.bye();
    expect(await toTitle).toBe("TitlePhase");

    expect(shown).toContain("Alex left the game.");
    expect(startPlayAgain(callbacks)).toBe(false);
  });

  it("Back to title tells the partner, and nothing starts", async () => {
    const r = await start("host");
    expect(await playToRunEnd(r)).toBe(false);
    const toTitle = advanceTo(r.ctx, ["TitlePhase"]);

    await answerEndScreen(r, false);
    expect(await toTitle).toBe("TitlePhase");

    expect(r.partner.lobbySeen).toEqual([{ t: "again", want: false }]);
    expect(stand.createRoom).not.toHaveBeenCalled();
    expect(startPlayAgain(callbacks)).toBe(false);
  });
});
