import Overrides from "#app/overrides";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import type { CommandPhase } from "#phases/command-phase";
import { GameManager } from "#test/framework/game-manager";
import { InputsHandler } from "#test/framework/inputs-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("Multiplayer: turn resolution gating (hot-seat)", () => {
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

  it("queue holds at CommandPhase(1) after only slot 0 commits", async () => {
    await game.classicMode.startBattle(SpeciesId.RAYQUAZA, SpeciesId.GROUDON);

    const phase0 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    expect(phase0.getFieldIndex()).toBe(0);
    phase0.handleCommand(Command.FIGHT, 2);

    await game.phaseInterceptor.to("CommandPhase", true);

    const current = game.scene.phaseManager.getCurrentPhase();
    expect(current.is("CommandPhase")).toBe(true);
    expect((current as CommandPhase).getFieldIndex()).toBe(1);

    expect(game.scene.currentBattle.turnCommands[0]?.command).toBe(Command.FIGHT);
    expect(game.scene.currentBattle.turnCommands[1]).toBeNull();
  });

  it("does not reach TurnStartPhase before slot 1 commits", async () => {
    await game.classicMode.startBattle(SpeciesId.RAYQUAZA, SpeciesId.GROUDON);

    const phase0 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    phase0.handleCommand(Command.FIGHT, 2);

    await game.phaseInterceptor.to("CommandPhase", true);

    expect(game.phaseInterceptor.log).not.toContain("TurnStartPhase");
    expect(game.phaseInterceptor.log).not.toContain("EnemyCommandPhase");
  });

  it("queue advances past command phases once both slots commit", async () => {
    await game.classicMode.startBattle(SpeciesId.RAYQUAZA, SpeciesId.GROUDON);

    const phase0 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    phase0.handleCommand(Command.FIGHT, 2);

    await game.phaseInterceptor.to("CommandPhase", true);
    const phase1 = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    expect(phase1.getFieldIndex()).toBe(1);
    phase1.handleCommand(Command.FIGHT, 2);

    await game.phaseInterceptor.to("MovePhase", false);

    const current = game.scene.phaseManager.getCurrentPhase();
    expect(current.is("MovePhase")).toBe(true);
    expect(game.phaseInterceptor.log).toContain("TurnStartPhase");
    expect(game.scene.currentBattle.turnCommands[0]?.command).toBe(Command.FIGHT);
    expect(game.scene.currentBattle.turnCommands[1]?.command).toBe(Command.FIGHT);
  });
});
