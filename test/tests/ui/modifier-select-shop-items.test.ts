/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { BattleScene } from "#app/battle-scene";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { SelectModifierPhase } from "#phases/select-modifier-phase";
import { GameManager } from "#test/framework/game-manager";
import { initSceneWithoutEncounterPhase } from "#test/utils/game-manager-utils";
import { ModifierSelectUiHandler } from "#ui/modifier-select-ui-handler";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The shop row of the reward screen appears as the rewards do: each item grows in with its name and price. A guard for a
 * screen left during its animation (co-op) looked at the item's Poké Ball, which only a reward has, so every shop item
 * stayed invisible.
 */
describe("UI - ModifierSelectUiHandler - shop items", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;
  let scene: BattleScene;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    scene = game.scene;
  });

  it("shows each shop item: its icon, name and price appear", async () => {
    initSceneWithoutEncounterPhase(scene, [SpeciesId.ABRA, SpeciesId.VOLCARONA]);
    scene.currentBattle.waveIndex = 25;
    const tweened = new Set<unknown>();
    const add = scene.tweens.add;
    vi.spyOn(scene.tweens, "add").mockImplementation(config => {
      const targets = (config as { targets?: unknown }).targets;
      for (const target of Array.isArray(targets) ? targets : [targets]) {
        tweened.add(target);
      }
      return add.call(scene.tweens, config);
    });

    scene.phaseManager.unshiftPhase(new SelectModifierPhase());
    await game.phaseInterceptor.to("SelectModifierPhase");
    expect(scene.ui.mode).toBe(UiMode.MODIFIER_SELECT);
    const handler = scene.ui.handlers.find(h => h instanceof ModifierSelectUiHandler) as ModifierSelectUiHandler;
    await vi.waitFor(() => expect(handler["awaitingActionInput"]).toBe(true));

    const shop = handler.shopOptionsRows.flat();
    expect(shop.length).toBeGreaterThan(0);
    for (const option of shop) {
      const parts = option as unknown as { itemContainer: unknown; itemText: unknown; itemCostText: unknown };
      expect(tweened.has(parts.itemContainer), `${option.modifierTypeOption.type?.name}: the icon`).toBe(true);
      expect(tweened.has(parts.itemText), `${option.modifierTypeOption.type?.name}: the name`).toBe(true);
      expect(tweened.has(parts.itemCostText), `${option.modifierTypeOption.type?.name}: the price`).toBe(true);
    }
  });
});
