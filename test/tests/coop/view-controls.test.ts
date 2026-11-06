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
import { enemyBoxPlaceForThree } from "#coop/ui/three-field";
import { Gender } from "#data/gender";
import { Button } from "#enums/buttons";
import { FieldPosition } from "#enums/field-position";
import { SpeciesId } from "#enums/species-id";
import { CFG_KEYBOARD_QWERTY } from "#inputs/cfg-keyboard-qwerty";
import { SettingKeyboard } from "#system/settings-keyboard";
import { GameManager } from "#test/framework/game-manager";
import { advanceTo } from "#test/helpers/coop-harness";
import { type LinkedRun, openLinkedRun, pickerSkips, winWave } from "#test/helpers/coop-linked";
import { MockText } from "#test/mocks/mocks-container/mock-text";
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

    it("is an eye: an enemy's on its level's row, before its type badge", async () => {
      const r = await start();
      const [enemy] = r.ctx.game.scene.getEnemyField();
      const enemyEye = hideButtonOf(enemy.getBattleInfo())!;
      // the enemy's type badge starts at -15; the type effectiveness window goes to its right, so nothing is there
      expect(enemyEye.x).toBeLessThan(-15 - 3);
      expect(enemyEye.x).toBeGreaterThan(-30);
      expect(enemyEye.y).toBe(-5);
    });

    type Part = { x: number; displayWidth: number; visible?: boolean };
    type NameRow = Record<"nameText" | "genderText" | "shinyIcon", Part> & { levelContainer: { y: number } };

    /** Lay parts of a box's name row out, as the game would (the tests' texts are not measured) */
    function layNameRow(info: unknown, parts: Partial<Record<keyof NameRow, [x: number, width: number]>>): NameRow {
      const row = info as NameRow;
      for (const [name, [x, width]] of Object.entries(parts) as [keyof NameRow, [number, number]][]) {
        const part = row[name] as Part;
        part.x = x;
        Object.defineProperty(part, "displayWidth", { configurable: true, value: width });
      }
      return row;
    }

    it("is an eye next to our name, on its row: after the gender sign, or after the last icon there", async () => {
      const r = await start();
      const [mine] = r.ctx.game.scene.getPlayerField();
      const info = mine.getBattleInfo();
      // "Bulbasaur" and its gender sign
      const row = layNameRow(info, { nameText: [-115, 37], genderText: [-78, 5] });
      await mine.updateInfo(true);
      // the eye (7 by 5, with an outline of 1 around it) starts 1 past the gender sign
      expect(hideButtonOf(info)!.x - 4).toBe(-73 + 1);
      expect(hideButtonOf(info)!.y).toBe(Math.round(row.levelContainer.y));
      // a shiny's star after it: the eye follows when the box is updated
      layNameRow(info, { shinyIcon: [-72, 8] });
      row.shinyIcon.visible = true;
      await mine.updateInfo(true);
      expect(hideButtonOf(info)!.x - 4).toBe(-64 + 1);
    });

    type TypeIcons = Record<"type1Icon" | "type2Icon", Phaser.GameObjects.Sprite>;

    /**
     * Our box is away: the eye is just before our type icons (which move with the box's size), by the lower one (its art:
     * rows 1 to 13)
     */
    function expectBesideLowerTypeIcon(info: Phaser.GameObjects.Container): void {
      const eye = hideButtonOf(info as never)!;
      const { type1Icon: first, type2Icon: lower } = info as unknown as TypeIcons;
      expect(eye.x).toBeLessThan(first.x - 3);
      expect(eye.x).toBeGreaterThan(first.x - 10);
      expect(eye.y).toBeGreaterThanOrEqual(lower.y + 1);
      expect(eye.y).toBeLessThanOrEqual(lower.y + 13);
    }

    it("leaves a box of ours that is away as its type icons, whole at the edge, with the closed eye before them, at either size", async () => {
      const r = await start();
      const scene = r.ctx.game.scene;
      const [mine] = scene.getPlayerField();
      const info = mine.getBattleInfo();
      const first = (info as unknown as TypeIcons).type1Icon;
      // (the tests' tweens move nothing: the box is put where the game's slides would leave it)
      info.x -= 150;
      expect(toggleBoxHidden(mine)).toBe(true);
      info.x += boxShiftOf(info);
      // doubles' small box, then the full one (a Pokémon alone in the middle)
      for (const center of [false, true]) {
        if (center) {
          // (at once, without a duration, as the summon phase does; its promise never settles then)
          mine.setFieldPosition(FieldPosition.CENTER).catch(() => undefined);
        }
        expectBesideLowerTypeIcon(info);
        // the type icons' art (20 wide) ends at the screen's edge: whole, and nothing after it (in the small box our name
        // starts right after it)
        const typesEnd = info.x + (first.x + 20) * info.scaleX;
        expect(Math.abs(typesEnd - scene.scaledCanvas.width)).toBeLessThanOrEqual(0.5);
      }
    });

    it("a boss's box in a battle of three starts where the other enemy's does, on screen (D40)", () => {
      // (box art 130 wide, a boss's 178, at 5/6; showing a boss's box brings it 48 further right, `Pokemon.showInfo`)
      const [normal] = enemyBoxPlaceForThree(0, false);
      const [boss] = enemyBoxPlaceForThree(0, true);
      const normalLeft = normal - 130 * (5 / 6);
      const bossLeft = boss + 48 - 178 * (5 / 6);
      expect(bossLeft).toBeCloseTo(normalLeft);
      expect(bossLeft).toBeGreaterThanOrEqual(0);
    });

    type LevelBox = { setLevelDisplay(level: number): void; levelContainer: { x: number } };

    it("makes room for the eye after an enemy's level of three digits", async () => {
      const r = await start();
      const box = r.ctx.game.scene.getEnemyField()[0].getBattleInfo() as unknown as LevelBox;
      box.setLevelDisplay(99);
      const two = box.levelContainer.x;
      box.setLevelDisplay(100);
      expect(box.levelContainer.x).toBe(two - 8);
    });

    type NameBox = { updateNameText(p: unknown): void; nameText: { text: string } };

    /**
     * Measure the tests' texts while `check` runs: a mock text starts empty (a Phaser text has its content) and has no width
     * (here 6 a letter, about the boxes' font)
     */
    async function measuringTexts(r: LinkedRun, check: () => void | Promise<void>): Promise<void> {
      const { add } = r.ctx.game.scene;
      const make = add.text.bind(add);
      vi.spyOn(add, "text").mockImplementation((x, y, content, style) => {
        const made = make(x, y, content, style);
        (made as unknown as MockText).text = String(content);
        return made;
      });
      Object.defineProperty(MockText.prototype, "displayWidth", {
        configurable: true,
        get(this: MockText) {
          return this.text.length * 6;
        },
      });
      try {
        await check();
      } finally {
        delete (MockText.prototype as unknown as { displayWidth?: number }).displayWidth;
      }
    }

    it("shortens a long enemy name more before a level of four digits (Endless): that level moves one further for the eye", async () => {
      const r = await start();
      const [enemy] = r.ctx.game.scene.getEnemyField();
      const box = enemy.getBattleInfo() as unknown as NameBox;
      vi.spyOn(enemy, "getNameToRender").mockReturnValue("Abcdefghijkl");
      await measuringTexts(r, () => {
        enemy.level = 100;
        box.updateNameText(enemy);
        const three = box.nameText.text;
        enemy.level = 1000;
        box.updateNameText(enemy);
        expect(box.nameText.text.length).toBeLessThan(three.length);
      });
    });

    it("shortens a long name of ours sooner than an enemy's of the same name and level: our eye goes after it", async () => {
      const r = await start();
      const [mine] = r.ctx.game.scene.getPlayerField();
      const [enemy] = r.ctx.game.scene.getEnemyField();
      const names: string[] = [];
      await measuringTexts(r, () => {
        for (const pokemon of [mine, enemy]) {
          vi.spyOn(pokemon, "getNameToRender").mockReturnValue("Abcdefghijkl");
          vi.spyOn(pokemon, "isShiny").mockReturnValue(false);
          pokemon.gender = Gender.MALE;
          pokemon.level = 20;
          const box = pokemon.getBattleInfo() as unknown as NameBox;
          box.updateNameText(pokemon);
          names.push(box.nameText.text);
        }
      });
      const [ours, theirs] = names;
      expect(ours.length).toBeLessThan(theirs.length);
    });

    it("leaves an enemy's level where it is in solo play", async () => {
      const game = new GameManager(phaserGame);
      await game.classicMode.startBattle(SpeciesId.BULBASAUR);
      const solo = game.scene.getEnemyField()[0].getBattleInfo() as unknown as LevelBox;
      solo.setLevelDisplay(99);
      const soloTwo = solo.levelContainer.x;
      solo.setLevelDisplay(100);
      expect(solo.levelContainer.x).toBe(soloTwo);
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
