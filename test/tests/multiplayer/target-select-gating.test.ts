import Overrides from "#app/overrides";
import { BattlerIndex } from "#enums/battler-index";
import { Button } from "#enums/buttons";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { CFG_KEYBOARD_QWERTY } from "#inputs/cfg-keyboard-qwerty";
import type { CommandPhase } from "#phases/command-phase";
import type { SelectTargetPhase } from "#phases/select-target-phase";
import { GameManager } from "#test/framework/game-manager";
import { InputsHandler } from "#test/framework/inputs-handler";
import type { TargetSelectUiHandler } from "#ui/target-select-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("Multiplayer: SelectTargetPhase input gating (hot-seat)", () => {
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

  it("drops a P2 keymap key during slot-0's SelectTargetPhase (cursor unchanged)", async () => {
    await game.classicMode.startBattle(SpeciesId.RAYQUAZA, SpeciesId.GROUDON);

    const phase0 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    phase0.handleCommand(Command.FIGHT, 0);

    await game.phaseInterceptor.to("SelectTargetPhase", true);
    const phase = game.scene.phaseManager.getCurrentPhase() as SelectTargetPhase;
    expect(phase.fieldIndex).toBe(0);

    const handler = game.scene.ui.getHandler() as TargetSelectUiHandler;
    const cursorBefore = handler.getCursor();
    expect(cursorBefore).toBe(BattlerIndex.ENEMY);

    await game.inputsHandler.pressKeyboardKeyForSlot(1, CFG_KEYBOARD_QWERTY.deviceMapping.KEY_D, 50);

    expect(handler.getCursor()).toBe(cursorBefore);
  });

  it("accepts a P1 keymap key during slot-0's SelectTargetPhase (cursor changes)", async () => {
    await game.classicMode.startBattle(SpeciesId.RAYQUAZA, SpeciesId.GROUDON);

    const phase0 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    phase0.handleCommand(Command.FIGHT, 0);

    await game.phaseInterceptor.to("SelectTargetPhase", true);
    const handler = game.scene.ui.getHandler() as TargetSelectUiHandler;
    expect(handler.getCursor()).toBe(BattlerIndex.ENEMY);

    await game.inputsHandler.pressKeyboardKeyForSlot(0, CFG_KEYBOARD_QWERTY.deviceMapping.KEY_ARROW_RIGHT, 50);

    expect(handler.getCursor()).toBe(BattlerIndex.ENEMY_2);
  });

  it("drops a P1 keymap key during slot-1's SelectTargetPhase (cursor unchanged)", async () => {
    await game.classicMode.startBattle(SpeciesId.RAYQUAZA, SpeciesId.GROUDON);

    const phase0 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    phase0.handleCommand(Command.FIGHT, 0);

    await game.phaseInterceptor.to("SelectTargetPhase", true);
    (game.scene.ui.getHandler() as TargetSelectUiHandler).processInput(Button.ACTION);

    await game.phaseInterceptor.to("CommandPhase", true);
    const phase1 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    expect(phase1.getFieldIndex()).toBe(1);
    phase1.handleCommand(Command.FIGHT, 0);

    await game.phaseInterceptor.to("SelectTargetPhase", true);
    const phase = game.scene.phaseManager.getCurrentPhase() as SelectTargetPhase;
    expect(phase.fieldIndex).toBe(1);

    const handler = game.scene.ui.getHandler() as TargetSelectUiHandler;
    const cursorBefore = handler.getCursor();
    expect(cursorBefore).toBe(BattlerIndex.ENEMY);

    await game.inputsHandler.pressKeyboardKeyForSlot(0, CFG_KEYBOARD_QWERTY.deviceMapping.KEY_ARROW_RIGHT, 50);

    expect(handler.getCursor()).toBe(cursorBefore);
  });

  it("accepts a P2 keymap key during slot-1's SelectTargetPhase (cursor changes)", async () => {
    await game.classicMode.startBattle(SpeciesId.RAYQUAZA, SpeciesId.GROUDON);

    const phase0 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    phase0.handleCommand(Command.FIGHT, 0);

    await game.phaseInterceptor.to("SelectTargetPhase", true);
    (game.scene.ui.getHandler() as TargetSelectUiHandler).processInput(Button.ACTION);

    await game.phaseInterceptor.to("CommandPhase", true);
    const phase1 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    phase1.handleCommand(Command.FIGHT, 0);

    await game.phaseInterceptor.to("SelectTargetPhase", true);
    const handler = game.scene.ui.getHandler() as TargetSelectUiHandler;
    expect(handler.getCursor()).toBe(BattlerIndex.ENEMY);

    await game.inputsHandler.pressKeyboardKeyForSlot(1, CFG_KEYBOARD_QWERTY.deviceMapping.KEY_D, 50);

    expect(handler.getCursor()).toBe(BattlerIndex.ENEMY_2);
  });
});
