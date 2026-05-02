import Overrides from "#app/overrides";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { CFG_KEYBOARD_QWERTY } from "#inputs/cfg-keyboard-qwerty";
import type { CommandPhase } from "#phases/command-phase";
import { GameManager } from "#test/framework/game-manager";
import { InputsHandler } from "#test/framework/inputs-handler";
import { holdOn } from "#test/utils/game-manager-utils";
import type { CommandUiHandler } from "#ui/command-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("Multiplayer: held-key isolation across slot transition (hot-seat)", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.inputsHandler = new InputsHandler(game.scene);
    vi.spyOn(Overrides, "LOCAL_HOTSEAT_OVERRIDE", "get").mockReturnValue(true);
    game.override
      .battleStyle("double")
      .startingLevel(100)
      .startingWave(1)
      .moveset([MoveId.TACKLE, MoveId.GROWL, MoveId.SPLASH, MoveId.HARDEN])
      .enemyMoveset(MoveId.SPLASH)
      .enemyLevel(5);
  });

  afterEach(() => {
    game.inputsHandler?.destroy();
    game.scene.input.keyboard?.emit("keyup", { keyCode: CFG_KEYBOARD_QWERTY.deviceMapping.KEY_ARROW_DOWN });
  });

  it("P1 holding a key across slot transition does not bleed into slot 1's cursor", async () => {
    await game.classicMode.startBattle(SpeciesId.RAYQUAZA, SpeciesId.GROUDON);

    const phase0 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    expect(phase0.getFieldIndex()).toBe(0);

    const handler = game.scene.ui.getHandler() as CommandUiHandler;
    handler.setCursor(Command.FIGHT);

    game.scene.input.keyboard?.emit("keydown", { keyCode: CFG_KEYBOARD_QWERTY.deviceMapping.KEY_ARROW_DOWN });
    expect(handler.getCursor()).toBe(Command.POKEMON);

    phase0.handleCommand(Command.FIGHT, 2);

    await game.phaseInterceptor.to("CommandPhase", true);
    const phase1 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    expect(phase1.getFieldIndex()).toBe(1);

    const slot1CursorBefore = handler.getCursor();
    expect(slot1CursorBefore).toBe(Command.FIGHT);

    await holdOn(350);

    expect(handler.getCursor()).toBe(slot1CursorBefore);
  });

  it("P1's repeat timer is cleared after slot transition (no stale events queued)", async () => {
    await game.classicMode.startBattle(SpeciesId.RAYQUAZA, SpeciesId.GROUDON);

    const phase0 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    const handler = game.scene.ui.getHandler() as CommandUiHandler;
    handler.setCursor(Command.FIGHT);

    game.scene.input.keyboard?.emit("keydown", { keyCode: CFG_KEYBOARD_QWERTY.deviceMapping.KEY_ARROW_DOWN });
    phase0.handleCommand(Command.FIGHT, 2);

    await game.phaseInterceptor.to("CommandPhase", true);

    await holdOn(300);

    const slot1CursorAfterRepeat = handler.getCursor();
    expect(slot1CursorAfterRepeat).toBe(Command.FIGHT);

    await holdOn(300);

    expect(handler.getCursor()).toBe(Command.FIGHT);
  });
});
