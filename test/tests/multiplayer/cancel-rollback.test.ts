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

describe("Multiplayer: CommandPhase cancel rollback (hot-seat)", () => {
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

  it("slot 0 cancel is a no-op (phase remains current)", async () => {
    await game.classicMode.startBattle(SpeciesId.RAYQUAZA, SpeciesId.GROUDON);

    const phase0 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    expect(phase0.getFieldIndex()).toBe(0);

    phase0.cancel();

    const after = game.scene.phaseManager.getCurrentPhase();
    expect(after).toBe(phase0);
    expect(after.is("CommandPhase")).toBe(true);
    expect((after as CommandPhase).getFieldIndex()).toBe(0);
  });

  it("slot 1 cancel re-pushes both CommandPhases and lands on slot 0", async () => {
    await game.classicMode.startBattle(SpeciesId.RAYQUAZA, SpeciesId.GROUDON);

    const phase0 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    phase0.handleCommand(Command.FIGHT, 2);

    await game.phaseInterceptor.to("CommandPhase", true);
    const phase1 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    expect(phase1.getFieldIndex()).toBe(1);

    phase1.cancel();

    await game.phaseInterceptor.to("CommandPhase", true);
    const newPhase0 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    expect(newPhase0.is("CommandPhase")).toBe(true);
    expect(newPhase0.getFieldIndex()).toBe(0);
    expect(newPhase0).not.toBe(phase0);
  });

  it("post-cancel, P1 input drives the new CommandPhase(0); P2 input is dropped", async () => {
    await game.classicMode.startBattle(SpeciesId.RAYQUAZA, SpeciesId.GROUDON);

    const phase0 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    phase0.handleCommand(Command.FIGHT, 2);

    await game.phaseInterceptor.to("CommandPhase", true);
    const phase1 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    phase1.cancel();

    await game.phaseInterceptor.to("CommandPhase", true);
    const newPhase0 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    expect(newPhase0.getFieldIndex()).toBe(0);

    const handler = game.scene.ui.getHandler() as CommandUiHandler;
    handler.setCursor(Command.FIGHT);

    await game.inputsHandler.pressKeyboardKeyForSlot(1, CFG_KEYBOARD_QWERTY.deviceMapping.KEY_S, 50);
    expect(handler.getCursor()).toBe(Command.FIGHT);

    await game.inputsHandler.pressKeyboardKeyForSlot(0, CFG_KEYBOARD_QWERTY.deviceMapping.KEY_ARROW_DOWN, 50);
    expect(handler.getCursor()).toBe(Command.POKEMON);
  });
});
