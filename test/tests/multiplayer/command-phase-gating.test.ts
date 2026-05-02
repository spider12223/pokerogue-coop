import Overrides from "#app/overrides";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { CFG_KEYBOARD_QWERTY } from "#inputs/cfg-keyboard-qwerty";
import type { CommandPhase } from "#phases/command-phase";
import { GameManager } from "#test/framework/game-manager";
import { InputsHandler } from "#test/framework/inputs-handler";
import type { CommandUiHandler } from "#ui/command-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("Multiplayer: CommandPhase input gating (hot-seat)", () => {
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
  });

  it("drops a P2 keymap key during P1's CommandPhase (cursor unchanged)", async () => {
    await game.classicMode.startBattle(SpeciesId.RAYQUAZA, SpeciesId.GROUDON);

    const phase = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    expect(phase.is("CommandPhase")).toBe(true);
    expect(phase.getFieldIndex()).toBe(0);

    const handler = game.scene.ui.getHandler() as CommandUiHandler;
    handler.setCursor(Command.FIGHT);
    const cursorBefore = handler.getCursor();

    await game.inputsHandler.pressKeyboardKey(CFG_KEYBOARD_QWERTY.deviceMapping.KEY_S, 50);

    expect(handler.getCursor()).toBe(cursorBefore);
  });

  it("accepts a P1 keymap key during P1's CommandPhase (cursor changes)", async () => {
    await game.classicMode.startBattle(SpeciesId.RAYQUAZA, SpeciesId.GROUDON);

    const phase = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    expect(phase.getFieldIndex()).toBe(0);

    const handler = game.scene.ui.getHandler() as CommandUiHandler;
    handler.setCursor(Command.FIGHT);

    await game.inputsHandler.pressKeyboardKey(CFG_KEYBOARD_QWERTY.deviceMapping.KEY_ARROW_DOWN, 50);

    expect(handler.getCursor()).toBe(Command.POKEMON);
  });

  it("drops a P1 keymap key during P2's CommandPhase (cursor unchanged)", async () => {
    await game.classicMode.startBattle(SpeciesId.RAYQUAZA, SpeciesId.GROUDON);

    const phase0 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    phase0.handleCommand(Command.FIGHT, 2);

    await game.phaseInterceptor.to("CommandPhase", true);
    const phase1 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    expect(phase1.getFieldIndex()).toBe(1);

    const handler = game.scene.ui.getHandler() as CommandUiHandler;
    handler.setCursor(Command.FIGHT);
    const cursorBefore = handler.getCursor();

    await game.inputsHandler.pressKeyboardKey(CFG_KEYBOARD_QWERTY.deviceMapping.KEY_ARROW_DOWN, 50);

    expect(handler.getCursor()).toBe(cursorBefore);
  });
});
