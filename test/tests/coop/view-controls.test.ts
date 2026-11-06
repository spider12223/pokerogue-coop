/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { battlerBox } from "#coop/cosmetic/cosmetic-tag";
import {
  boxShiftOf,
  HIDDEN_BOXES_KEY,
  hideButtonOf,
  isBoxHidden,
  loadHiddenBoxes,
  toggleBoxHidden,
} from "#coop/ui/box-hide";
import { coopFieldZoom, FIELD_ZOOM_KEY, loadFieldZoom, onFieldWheel, stepFieldZoom } from "#coop/ui/field-zoom";
import { Button } from "#enums/buttons";
import { SpeciesId } from "#enums/species-id";
import { CFG_KEYBOARD_QWERTY } from "#inputs/cfg-keyboard-qwerty";
import { SettingKeyboard } from "#system/settings-keyboard";
import { GameManager } from "#test/framework/game-manager";
import { advanceTo } from "#test/helpers/coop-harness";
import { type LinkedRun, openLinkedRun, pickerSkips, winWave } from "#test/helpers/coop-linked";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Each player's own view of the battle (DECISIONS D44): a hide button on every HP box, and a zoom of the battlefield. Both
 * change what this client draws only: nothing is sent, nothing of the simulation changes.
 */

const FOUR = [SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER, SpeciesId.PIKACHU];

describe("Co-op: each player's view of the battle (D44)", () => {
  let phaserGame: Phaser.Game;
  let run: LinkedRun | null = null;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    run?.close();
    run = null;
    vi.restoreAllMocks();
    localStorage.removeItem(HIDDEN_BOXES_KEY);
    localStorage.removeItem(FIELD_ZOOM_KEY);
    loadHiddenBoxes();
    loadFieldZoom();
  });

  async function start(): Promise<LinkedRun> {
    run = await openLinkedRun(phaserGame, {
      seat: "host",
      species: FOUR,
      starterOwners: ["host", "guest", "host", "guest"],
      configure: game => game.override.startingLevel(40),
      policy: { auto: ["TURN_COMMANDS", "LEARN_MOVE", "EVOLUTION_CANCEL"] },
    });
    await advanceTo(run.ctx, ["CommandPhase"]);
    return run;
  }

  describe("the hide button of the HP boxes", () => {
    it("is on every box of the field", async () => {
      const r = await start();
      const field = r.ctx.game.scene.getField(true);
      expect(field).toHaveLength(4);
      for (const pokemon of field) {
        expect(hideButtonOf(pokemon.getBattleInfo())).not.toBeNull();
      }
    });

    it("slides an enemy's box off to the left and a player's off to the right; pressed again, it brings it back", async () => {
      const r = await start();
      const scene = r.ctx.game.scene;
      const [enemy] = scene.getEnemyField();
      const [mine] = scene.getPlayerField();
      // (the tests' tweens move nothing: the boxes are where the game's slide-in, `Pokemon.showInfo`, would leave them)
      for (const pokemon of scene.getField(true)) {
        pokemon.getBattleInfo().x += pokemon.isPlayer() ? -150 : 150;
      }

      expect(toggleBoxHidden(enemy)).toBe(true);
      expect(isBoxHidden(enemy)).toBe(true);
      expect(boxShiftOf(enemy.getBattleInfo())).toBeLessThan(0);
      expect(JSON.parse(localStorage.getItem(HIDDEN_BOXES_KEY) ?? "[]")).toEqual(["enemy:0"]);

      expect(toggleBoxHidden(mine)).toBe(true);
      expect(boxShiftOf(mine.getBattleInfo())).toBeGreaterThan(0);

      expect(toggleBoxHidden(enemy)).toBe(true);
      expect(isBoxHidden(enemy)).toBe(false);
      expect(boxShiftOf(enemy.getBattleInfo())).toBe(0);
      expect(JSON.parse(localStorage.getItem(HIDDEN_BOXES_KEY) ?? "[]")).toEqual(["player:0"]);
    });

    it("keeps the place hidden for the next Pokémon there (the next wave's enemy)", async () => {
      const r = await start();
      const scene = r.ctx.game.scene;
      const first = scene.getEnemyField()[0];
      toggleBoxHidden(first);

      expect(await winWave(r)).toBe(true);
      pickerSkips(r);
      await advanceTo(r.ctx, ["CommandPhase"]);

      const next = scene.getEnemyField()[0];
      expect(next).not.toBe(first);
      expect(isBoxHidden(next)).toBe(true);
      expect(boxShiftOf(next.getBattleInfo())).toBeLessThan(0);
      expect(boxShiftOf(scene.getEnemyField()[1].getBattleInfo())).toBe(0);
    });

    it("remembers the hidden places in this browser", async () => {
      localStorage.setItem(HIDDEN_BOXES_KEY, JSON.stringify(["player:1", "nonsense", 3]));
      loadHiddenBoxes();
      const r = await start();
      const [first, second] = r.ctx.game.scene.getPlayerField();
      expect(isBoxHidden(first)).toBe(false);
      expect(isBoxHidden(second)).toBe(true);
      expect(boxShiftOf(second.getBattleInfo())).toBeGreaterThan(0);
    });

    it("is not there in solo play", async () => {
      const game = new GameManager(phaserGame);
      await game.classicMode.startBattle(SpeciesId.BULBASAUR);
      const pokemon = game.scene.getField(true)[0];
      expect(hideButtonOf(pokemon.getBattleInfo())).toBeNull();
      expect(toggleBoxHidden(pokemon)).toBe(false);
    });
  });

  describe("the battlefield zoom", () => {
    /**
     * The field scales the game tweens to, as the game's own zoom (1, or less for a big Pokémon); `tops` gets where the
     * field's top goes, in canvas pixels
     */
    function spyOnFieldScale(r: LinkedRun, tops: number[] = []): number[] {
      const scene = r.ctx.game.scene;
      const scales: number[] = [];
      const add = scene.tweens.add.bind(scene.tweens);
      vi.spyOn(scene.tweens, "add").mockImplementation(((config: { targets: unknown; scale?: number; y?: number }) => {
        if (config.targets === scene.field && config.scale !== undefined) {
          scales.push(config.scale / 6);
          tops.push(config.y ?? Number.NaN);
        }
        return add(config as never);
      }) as never);
      return scales;
    }

    it("shrinks the field around its middle: the enemies stay up, ours come up off the bottom", async () => {
      const r = await start();
      const tops: number[] = [];
      const scales = spyOnFieldScale(r, tops);
      const field = 132 * 6;
      await r.ctx.game.scene.setFieldScale(1);
      expect(stepFieldZoom(true)).toBe(true);
      expect(stepFieldZoom(true)).toBe(true);
      expect(scales.at(-1)).toBeCloseTo(0.8);
      // the middle of the field stays where it was: its top comes down by a tenth, its bottom up by a tenth
      expect(tops.at(-1)).toBeCloseTo(field * 0.1);
    });

    it("moves the marks over a Pokémon (intents, pings, emotes) with the zoomed field", async () => {
      const r = await start();
      const scene = r.ctx.game.scene;
      const [enemy] = scene.getEnemyField();
      const before = battlerBox(enemy);
      Object.assign(scene.field, { x: 384, y: 158.4, scale: 3.6 });
      const after = battlerBox(enemy);
      expect(after.x).toBe(Math.round(384 / 6 + enemy.x * 0.6));
      expect(after.bottom).toBe(Math.round(158.4 / 6 + enemy.y * 0.6));
      expect(after.right - after.left).toBeLessThan(before.right - before.left);
    });

    it("zooms this player's field out to 60% one step a turn of the wheel, and back in", async () => {
      const r = await start();
      const scene = r.ctx.game.scene;
      const scales = spyOnFieldScale(r);
      const base = scene.fieldScaleRequest;

      let t = 1000;
      for (const expected of [0.9, 0.8, 0.7, 0.6]) {
        expect(onFieldWheel(100, (t += 300))).toBe(true);
        expect(coopFieldZoom()).toBeCloseTo(expected);
        expect(scales.at(-1)).toBeCloseTo(base * expected);
      }
      expect(onFieldWheel(100, (t += 300))).toBe(false);
      expect(coopFieldZoom()).toBeCloseTo(0.6);

      expect(onFieldWheel(-100, (t += 300))).toBe(true);
      expect(coopFieldZoom()).toBeCloseTo(0.7);
      expect(scene.fieldScaleRequest).toBe(base);
    });

    it("takes one step for a burst of wheel events (a touchpad)", async () => {
      await start();
      expect(onFieldWheel(40, 1000)).toBe(true);
      expect(onFieldWheel(40, 1050)).toBe(false);
      expect(onFieldWheel(40, 1100)).toBe(false);
      expect(coopFieldZoom()).toBeCloseTo(0.9);
      expect(onFieldWheel(40, 1400)).toBe(true);
      expect(coopFieldZoom()).toBeCloseTo(0.8);
    });

    it("has two keys, numpad minus and plus at first, that can be rebound", async () => {
      expect(CFG_KEYBOARD_QWERTY.settings[SettingKeyboard.BUTTON_COOP_ZOOM_OUT]).toBe(Button.COOP_ZOOM_OUT);
      expect(CFG_KEYBOARD_QWERTY.settings[SettingKeyboard.BUTTON_COOP_ZOOM_IN]).toBe(Button.COOP_ZOOM_IN);
      expect(CFG_KEYBOARD_QWERTY.default["KEY_MINUS"]).toBe(SettingKeyboard.BUTTON_COOP_ZOOM_OUT);
      expect(CFG_KEYBOARD_QWERTY.default["KEY_PLUS"]).toBe(SettingKeyboard.BUTTON_COOP_ZOOM_IN);

      const r = await start();
      const actions = r.ctx.game.scene.uiInputs.getActionsKeyDown();
      actions[Button.COOP_ZOOM_OUT]();
      actions[Button.COOP_ZOOM_OUT]();
      expect(coopFieldZoom()).toBeCloseTo(0.8);
      actions[Button.COOP_ZOOM_IN]();
      expect(coopFieldZoom()).toBeCloseTo(0.9);
    });

    it("is remembered in this browser, and the game's own zoom (a big Pokémon) comes on top of it", async () => {
      const r = await start();
      const scene = r.ctx.game.scene;
      expect(stepFieldZoom(true)).toBe(true);
      expect(localStorage.getItem(FIELD_ZOOM_KEY)).toBe("0.9");

      const scales = spyOnFieldScale(r);
      await scene.setFieldScale(0.75);
      expect(scales.at(-1)).toBeCloseTo(0.75 * 0.9);

      localStorage.setItem(FIELD_ZOOM_KEY, "0.7");
      loadFieldZoom();
      expect(coopFieldZoom()).toBeCloseTo(0.7);
      localStorage.setItem(FIELD_ZOOM_KEY, "banana");
      loadFieldZoom();
      expect(coopFieldZoom()).toBe(1);
    });

    it("does nothing in solo play", async () => {
      const game = new GameManager(phaserGame);
      await game.classicMode.startBattle(SpeciesId.BULBASAUR);
      localStorage.setItem(FIELD_ZOOM_KEY, "0.6");
      loadFieldZoom();
      expect(coopFieldZoom()).toBe(1);
      expect(stepFieldZoom(true)).toBe(false);
      expect(onFieldWheel(100, 5000)).toBe(false);
      game.scene.uiInputs.getActionsKeyDown()[Button.COOP_ZOOM_OUT]();
      expect(localStorage.getItem(FIELD_ZOOM_KEY)).toBe("0.6");
    });
  });
});
