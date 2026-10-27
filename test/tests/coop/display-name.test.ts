/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { getCoopName, setCoopName } from "#coop/display-name";
import { showCoopTitleMenu } from "#coop/lobby";
import { Button } from "#enums/buttons";
import { UiMode } from "#enums/ui-mode";
import { GameManager } from "#test/framework/game-manager";
import type { CoopJoinFormUiHandler } from "#ui/coop-join-form-ui-handler";
import type { CoopNameFormUiHandler } from "#ui/coop-name-form-ui-handler";
import type { OptionSelectUiHandler } from "#ui/option-select-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * The display name of the player (DECISIONS D1): the one they used last is kept in the browser, is what the handshake
 * sends, and is in the name form when it is opened again. The co-op menu comes back after the form, with the new name.
 */
describe("Co-op: the last-used display name", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    localStorage.removeItem("coopDisplayName");
  });

  const tick = () => new Promise(resolve => setTimeout(resolve, 20));

  /** The co-op menu as it is on screen: whether it is shown, and its labels */
  function menuOnScreen(): { mode: string; visible: boolean; labels: string[] } {
    const handler = game.scene.ui.getHandler() as unknown as {
      config: { options: { label: string }[] } | null;
      optionSelectContainer: { visible: boolean };
    };
    return {
      mode: UiMode[game.scene.ui.mode],
      visible: handler.optionSelectContainer?.visible ?? false,
      labels: handler.config?.options.map(option => option.label) ?? [],
    };
  }

  /** Open the co-op menu, and choose the option whose label has `text` with the menu's own input (as a player does) */
  async function choose(text: string): Promise<void> {
    if (game.scene.ui.mode !== UiMode.OPTION_SELECT) {
      showCoopTitleMenu({ onConnected: () => undefined, onCancel: () => undefined });
      await tick();
    }
    const menu = game.scene.ui.getHandler() as OptionSelectUiHandler;
    const index = menuOnScreen().labels.findIndex(label => label.includes(text));
    expect(index, menuOnScreen().labels.join(" | ")).toBeGreaterThanOrEqual(0);
    // (a real input takes the focus 50 ms after a form opens; the headless one has no focus to take)
    for (const mode of [UiMode.COOP_NAME_FORM, UiMode.COOP_JOIN_FORM]) {
      for (const input of (game.scene.ui.handlers[mode] as unknown as { inputs: { setFocus?: () => void }[] }).inputs) {
        input.setFocus = () => undefined;
      }
    }
    menu.setCursor(index);
    (menu as unknown as { unblockInput(): void }).unblockInput();
    menu.processInput(Button.ACTION);
    await tick();
  }

  it("is 'Player' until one was typed, then the last one, cleaned", () => {
    localStorage.removeItem("coopDisplayName");
    expect(getCoopName()).toBe("Player");
    expect(setCoopName("  Sam  ")).toBe("Sam");
    expect(getCoopName()).toBe("Sam");
    expect(setCoopName("Alex")).toBe("Alex");
    expect(getCoopName()).toBe("Alex");
    // nothing printable: it is not lost, and not blank
    expect(setCoopName("   ")).toBe("Player");
  });

  it("is the one the co-op menu shows and the name form opens with", async () => {
    game = new GameManager(phaserGame);
    setCoopName("Robin");
    await choose("Your name");

    expect(game.scene.ui.mode).toBe(UiMode.COOP_NAME_FORM);
    const form = game.scene.ui.getHandler() as CoopNameFormUiHandler;
    expect((form as unknown as { inputs: { text: string }[] }).inputs[0]?.text).toBe("Robin");
  });

  it("saving a name brings the co-op menu back, with the new name on it (it was a blank screen)", async () => {
    game = new GameManager(phaserGame);
    setCoopName("Robin");
    await choose("Your name");
    (game.scene.ui.getHandler() as CoopNameFormUiHandler).submitName("Sam");
    await tick();

    expect(getCoopName()).toBe("Sam");
    const menu = menuOnScreen();
    expect(menu.mode).toBe("OPTION_SELECT");
    expect(menu.visible).toBe(true);
    expect(menu.labels).toContain("Your name: Sam");
    // and it works again: the form opens with the new name
    await choose("Your name");
    expect((game.scene.ui.getHandler() as unknown as { inputs: { text: string }[] }).inputs[0]?.text).toBe("Sam");
  });

  it("cancelling the name form or the join form brings the co-op menu back", async () => {
    game = new GameManager(phaserGame);
    setCoopName("Robin");
    for (const option of ["Your name", "Join a game"]) {
      await choose(option);
      const form = game.scene.ui.getHandler() as CoopNameFormUiHandler | CoopJoinFormUiHandler;
      // the form's Cancel button
      (form as unknown as { cancelAction: () => void }).cancelAction();
      await tick();

      const menu = menuOnScreen();
      expect(menu.mode, option).toBe("OPTION_SELECT");
      expect(menu.visible, option).toBe(true);
      expect(menu.labels, option).toContain("Your name: Robin");
    }
  });
});
