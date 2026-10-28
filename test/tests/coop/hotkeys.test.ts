/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { bindCoopHotkeys, coopSettingLabel } from "#coop/hotkey-names";
import { openEmoteWheel, pingNow } from "#coop/hotkeys";
import { showOverlayMenu } from "#coop/overlay";
import { pingHint } from "#coop/text";
import { setTouchEmoteVisible, TOUCH_EMOTE_CLASS } from "#coop/touch-emote";
import { Button } from "#enums/buttons";
import { PartyUiMode } from "#enums/party-ui-mode";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { CFG_KEYBOARD_QWERTY } from "#inputs/cfg-keyboard-qwerty";
import { SettingKeyboard, settingKeyboardDefaults, settingKeyboardOptions } from "#system/settings-keyboard";
import { advanceTo } from "#test/helpers/coop-harness";
import { type LinkedRun, openLinkedRun } from "#test/helpers/coop-linked";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The two hotkeys of the cosmetic channel are buttons of the game (DECISIONS D16): the player moves them in the keyboard
 * settings like any other, they do their work in a linked run, and a touch screen has a button for the emote wheel.
 */

describe("Co-op: the ping and emote hotkeys are buttons that can be rebound (D16)", () => {
  let phaserGame: Phaser.Game;
  let run: LinkedRun | null = null;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    run?.close();
    run = null;
    vi.restoreAllMocks();
  });

  describe("the keyboard settings", () => {
    it("have a row for each, a key at first (P and Q), and a button each", () => {
      expect(Object.keys(settingKeyboardOptions)).toEqual(
        expect.arrayContaining([SettingKeyboard.BUTTON_COOP_PING, SettingKeyboard.BUTTON_COOP_EMOTE]),
      );
      expect(Object.keys(settingKeyboardDefaults)).toEqual(
        expect.arrayContaining([SettingKeyboard.BUTTON_COOP_PING, SettingKeyboard.BUTTON_COOP_EMOTE]),
      );
      expect(CFG_KEYBOARD_QWERTY.settings[SettingKeyboard.BUTTON_COOP_PING]).toBe(Button.COOP_PING);
      expect(CFG_KEYBOARD_QWERTY.settings[SettingKeyboard.BUTTON_COOP_EMOTE]).toBe(Button.COOP_EMOTE);
      expect(CFG_KEYBOARD_QWERTY.default["KEY_P"]).toBe(SettingKeyboard.BUTTON_COOP_PING);
      // (a development build keeps Q for its own button)
      expect(CFG_KEYBOARD_QWERTY.default["KEY_Q"]).toBe(SettingKeyboard.BUTTON_COOP_EMOTE);
      // the chat box (D38): H
      expect(Object.keys(settingKeyboardOptions)).toContain(SettingKeyboard.BUTTON_COOP_CHAT);
      expect(Object.keys(settingKeyboardDefaults)).toContain(SettingKeyboard.BUTTON_COOP_CHAT);
      expect(CFG_KEYBOARD_QWERTY.settings[SettingKeyboard.BUTTON_COOP_CHAT]).toBe(Button.COOP_CHAT);
      expect(CFG_KEYBOARD_QWERTY.default["KEY_H"]).toBe(SettingKeyboard.BUTTON_COOP_CHAT);
      // (upstream's tests take B for a key that is not bound)
      expect(CFG_KEYBOARD_QWERTY.default["KEY_B"]).toBe(-1);
    });

    it("are named for the player, in English where the game has no translation", () => {
      expect(coopSettingLabel("buttonCoopPing")).toEqual({ defaultValue: "Co-op: ping" });
      expect(coopSettingLabel("buttonCoopEmote")).toEqual({ defaultValue: "Co-op: emote" });
      expect(coopSettingLabel("buttonCoopChat")).toEqual({ defaultValue: "Co-op: chat" });
      expect(coopSettingLabel("buttonCycleTera")).toEqual({});
    });

    it("are not bound to a key twice by default, and nothing of upstream's lost its key", () => {
      const used = Object.values(CFG_KEYBOARD_QWERTY.default).filter(setting => setting !== -1);
      expect(new Set(used).size).toBe(used.length);
      expect(CFG_KEYBOARD_QWERTY.default["KEY_C"]).toBe(SettingKeyboard.BUTTON_STATS);
      expect(CFG_KEYBOARD_QWERTY.default["KEY_ESC"]).toBe(SettingKeyboard.BUTTON_MENU);
    });
  });

  describe("the hint of a waiting player", () => {
    it("says the key the player set, and says what to do when there is none", () => {
      expect(pingHint()).toBe("Press P to nudge them.");
      expect(pingHint("ARROW UP")).toBe("Press ARROW UP to nudge them.");
      expect(pingHint(null)).toMatch(/keyboard settings/);
    });
  });

  describe("in a linked run", () => {
    async function start(): Promise<LinkedRun> {
      run = await openLinkedRun(phaserGame, {
        seat: "host",
        species: [SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER, SpeciesId.PIKACHU],
        starterOwners: ["host", "guest", "host", "guest"],
        configure: game => game.override.startingLevel(40),
        policy: { auto: ["TURN_COMMANDS", "LEARN_MOVE", "EVOLUTION_CANCEL"] },
        names: { mine: "Sam", theirs: "Alex" },
      });
      return run;
    }

    const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 30));

    it("pings with the ping button of the game: the partner is told", async () => {
      const r = await start();
      await advanceTo(r.ctx, ["CommandPhase"]);
      const actions = r.ctx.game.scene.uiInputs.getActionsKeyDown();
      actions[Button.COOP_PING]();
      await flush();
      expect(r.partner.cosmeticsSeen.filter(message => message.t === "ping")).toHaveLength(1);
    });

    it("opens the emote wheel with the emote button, and sends the one that is chosen", async () => {
      const r = await start();
      await advanceTo(r.ctx, ["CommandPhase"]);
      await r.ctx.game.scene.ui.setMode(UiMode.COMMAND, 0);
      r.ctx.game.scene.uiInputs.getActionsKeyDown()[Button.COOP_EMOTE]();
      await flush();
      expect(r.ctx.game.scene.ui.mode).toBe(UiMode.OPTION_SELECT);
    });

    it("a pad pings and opens the emote wheel with its triggers (cycle gender, cycle ability) outside the starter screen", async () => {
      const r = await start();
      await advanceTo(r.ctx, ["CommandPhase"]);
      await r.ctx.game.scene.ui.setMode(UiMode.COMMAND, 0);
      const actions = r.ctx.game.scene.uiInputs.getActionsKeyDown();
      actions[Button.CYCLE_GENDER]();
      await flush();
      expect(r.partner.cosmeticsSeen.filter(message => message.t === "ping")).toHaveLength(1);
      actions[Button.CYCLE_ABILITY]();
      await flush();
      expect(r.ctx.game.scene.ui.mode).toBe(UiMode.OPTION_SELECT);
    });

    it("pings on a Mystery Encounter's options (D29), where the emote wheel stays closed", async () => {
      const r = await start();
      await advanceTo(r.ctx, ["CommandPhase"]);
      const { ui } = r.ctx.game.scene;
      vi.spyOn(ui, "mode", "get").mockReturnValue(UiMode.MYSTERY_ENCOUNTER);
      expect(pingNow()).toBe(true);
      await flush();
      expect(r.partner.cosmeticsSeen.filter(message => message.t === "ping").at(-1)).toMatchObject({
        at: { k: "none" },
      });
      expect(openEmoteWheel()).toBe(false);
    });

    it("do not open the emote wheel over a screen that is fading out", async () => {
      const r = await start();
      await advanceTo(r.ctx, ["CommandPhase"]);
      const { ui } = r.ctx.game.scene;
      await ui.setMode(UiMode.COMMAND, 0);
      vi.spyOn(ui, "pendingCoopTransition", "get").mockReturnValue(new Promise<void>(() => {}));
      expect(openEmoteWheel()).toBe(false);
      expect(ui.mode).toBe(UiMode.COMMAND);
    });

    it("a menu asked for while a mode change fades goes over the screen it brings, and closes back to that one", async () => {
      const r = await start();
      await advanceTo(r.ctx, ["CommandPhase"]);
      const { ui } = r.ctx.game.scene;
      await ui.setMode(UiMode.PARTY, PartyUiMode.CHECK, -1, () => {});
      expect(ui.mode).toBe(UiMode.PARTY);
      // the party fades out to the message box: the menu asked for meanwhile waits for it
      const leaving = ui.setMode(UiMode.MESSAGE);
      expect(ui.pendingCoopTransition).not.toBeNull();
      let chosen = false;
      showOverlayMenu([
        {
          label: "A",
          handler: () => {
            chosen = true;
            return true;
          },
        },
      ]);
      expect(ui.mode).toBe(UiMode.PARTY);
      await leaving;
      await flush();
      expect(ui.mode).toBe(UiMode.OPTION_SELECT);
      (ui.getHandler() as unknown as { config: { options: { handler: () => boolean }[] } }).config.options[0].handler();
      await flush();
      expect(chosen).toBe(true);
      expect(ui.mode).toBe(UiMode.MESSAGE);
    });

    it("a menu closed before it could open does not open", async () => {
      const r = await start();
      await advanceTo(r.ctx, ["CommandPhase"]);
      const { ui } = r.ctx.game.scene;
      await ui.setMode(UiMode.PARTY, PartyUiMode.CHECK, -1, () => {});
      const leaving = ui.setMode(UiMode.MESSAGE);
      const close = showOverlayMenu([{ label: "A", handler: () => true }]);
      close();
      await leaving;
      await flush();
      expect(ui.mode).toBe(UiMode.MESSAGE);
    });

    it("do nothing outside a run: the same buttons in a solo game are quiet", async () => {
      const r = await start();
      await advanceTo(r.ctx, ["CommandPhase"]);
      r.session.link?.close();
      const before = r.partner.cosmeticsSeen.length;
      r.ctx.game.scene.uiInputs.getActionsKeyUp()[Button.COOP_PING]();
      await flush();
      expect(r.partner.cosmeticsSeen).toHaveLength(before);
    });
  });
});

describe("Co-op: the emote button of a touch screen (D16)", () => {
  it("is shown while a run is linked and taken away when it is over", () => {
    document.body.innerHTML = '<div id="touchControls"><div id="coopEmoteTouch" data-key="COOP_EMOTE"></div></div>';
    const pad = document.getElementById("touchControls")!;
    expect(pad.classList.contains(TOUCH_EMOTE_CLASS)).toBe(false);
    setTouchEmoteVisible(true);
    expect(pad.classList.contains(TOUCH_EMOTE_CLASS)).toBe(true);
    setTouchEmoteVisible(true);
    expect(pad.classList.contains(TOUCH_EMOTE_CLASS)).toBe(true);
    setTouchEmoteVisible(false);
    expect(pad.classList.contains(TOUCH_EMOTE_CLASS)).toBe(false);
  });

  it("is a button of the pad that the game's touch controls bind to the emote button, and the ping beside it", () => {
    expect(Object.hasOwn(Button, "COOP_EMOTE")).toBe(true);
    // `TouchControl` binds every element with a `data-key` and looks the name up in `Button`
    expect(Button[Button.COOP_EMOTE]).toBe("COOP_EMOTE");
    expect(Button[Button.COOP_PING]).toBe("COOP_PING");
  });

  it("does nothing where there is no page, and nothing breaks where the pad is missing", () => {
    document.body.innerHTML = "";
    expect(() => setTouchEmoteVisible(true)).not.toThrow();
  });
});

describe("Co-op: a keyboard mapping saved before the co-op keys existed", () => {
  /** What a player who never touched the keys has saved: P and Q unbound */
  const saved = (): Record<string, unknown> => ({
    KEY_ARROW_UP: "BUTTON_UP",
    KEY_C: "BUTTON_STATS",
    KEY_P: -1,
    KEY_Q: -1,
  });

  it("gets P and Q back for ping and emote", () => {
    const custom = saved();
    expect(bindCoopHotkeys(custom, false)).toBe(true);
    expect(custom["KEY_P"]).toBe(SettingKeyboard.BUTTON_COOP_PING);
    expect(custom["KEY_Q"]).toBe(SettingKeyboard.BUTTON_COOP_EMOTE);
    expect(custom["KEY_C"]).toBe("BUTTON_STATS");
  });

  it("gets H for the chat box (D38), which came later, if H is free", () => {
    const custom = {
      ...saved(),
      KEY_P: SettingKeyboard.BUTTON_COOP_PING,
      KEY_Q: SettingKeyboard.BUTTON_COOP_EMOTE,
      KEY_H: -1,
    };
    expect(bindCoopHotkeys(custom, false)).toBe(true);
    expect(custom["KEY_H"]).toBe(SettingKeyboard.BUTTON_COOP_CHAT);
    const taken = { ...saved(), KEY_H: "BUTTON_CYCLE_SHINY" };
    bindCoopHotkeys(taken, false);
    expect(taken["KEY_H"]).toBe("BUTTON_CYCLE_SHINY");
  });

  it("leaves Q to a development build's own button", () => {
    const custom = saved();
    bindCoopHotkeys(custom, true);
    expect(custom["KEY_P"]).toBe(SettingKeyboard.BUTTON_COOP_PING);
    expect(custom["KEY_Q"]).toBe(-1);
  });

  it("leaves alone a key the player gave to something else, and buttons the player moved on purpose", () => {
    const custom = { ...saved(), KEY_P: "BUTTON_CYCLE_SHINY", KEY_Q: -1, KEY_L: SettingKeyboard.BUTTON_COOP_EMOTE };
    bindCoopHotkeys(custom, false);
    expect(custom["KEY_P"]).toBe("BUTTON_CYCLE_SHINY");
    expect(custom["KEY_Q"]).toBe(-1);
    expect(custom["KEY_L"]).toBe(SettingKeyboard.BUTTON_COOP_EMOTE);
  });

  it("changes nothing in a mapping that is not a keyboard's, or that is done", () => {
    const pad: Record<string, unknown> = { RC_S: "BUTTON_ACTION" };
    expect(bindCoopHotkeys(pad, false)).toBe(false);
    expect(pad).toEqual({ RC_S: "BUTTON_ACTION" });
    const done = { KEY_P: SettingKeyboard.BUTTON_COOP_PING, KEY_Q: SettingKeyboard.BUTTON_COOP_EMOTE };
    expect(bindCoopHotkeys(done, false)).toBe(false);
  });
});
