/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { GameMode } from "#app/game-mode";
import * as buildInfo from "#coop/build-info";
import { showCoopTitleMenu } from "#coop/lobby";
import { endCoopSession } from "#coop/session";
import { Button } from "#enums/buttons";
import { Challenges } from "#enums/challenges";
import { GameModes } from "#enums/game-modes";
import { UiMode } from "#enums/ui-mode";
import { GameManager } from "#test/framework/game-manager";
import type { OptionSelectUiHandler } from "#ui/option-select-ui-handler";
import i18next from "i18next";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Host a game asks how many players first (DECISIONS D40): 2, or 3 (Beta); then Classic or Endless (D39) */

const CALLBACKS = { onConnected: () => undefined, onCancel: () => undefined };

describe("Co-op: 2 or 3 players (D40)", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;
  let texts: string[];

  const tick = () => new Promise(resolve => setTimeout(resolve, 20));

  function labels(): string[] {
    const handler = game.scene.ui.getHandler() as unknown as { config: { options: { label: string }[] } | null };
    return handler.config?.options.map(option => option.label) ?? [];
  }

  async function until(label: string): Promise<void> {
    for (let i = 0; i < 50 && !labels().includes(label); i++) {
      await tick();
    }
  }

  async function choose(label: string): Promise<void> {
    await until(label);
    const shown = labels();
    const index = shown.indexOf(label);
    expect(index, shown.join(" | ")).toBeGreaterThanOrEqual(0);
    const menu = game.scene.ui.getHandler() as OptionSelectUiHandler;
    menu.setCursor(index);
    (menu as unknown as { unblockInput(): void }).unblockInput();
    menu.processInput(Button.ACTION);
    await tick();
  }

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    texts = [];
    vi.spyOn(game.scene.ui, "showText").mockImplementation((text, _delay, callback) => {
      texts.push(text);
      callback?.();
    });
  });

  afterEach(() => {
    endCoopSession();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("asks how many players first; Cancel goes back to the co-op menu", async () => {
    showCoopTitleMenu(CALLBACKS);
    await tick();
    await choose("Host a game");
    expect(texts.at(-1)).toBe("How many players?");
    expect(labels()).toEqual(["2 players", "3 players (Beta)", i18next.t("menu:cancel")]);

    await choose(i18next.t("menu:cancel"));
    await tick();
    expect(game.scene.ui.mode).toBe(UiMode.OPTION_SELECT);
    expect(labels()).toContain("Host a game");
  });

  it("3 players (Beta), then a mode, creates a room of three", async () => {
    vi.stubEnv("VITE_COOP_RELAY_URL", "ws://relay.test/coop");
    // the test game has its overrides on, which keep a real game from starting (D1)
    vi.spyOn(buildInfo, "overridesAreDefaults").mockReturnValue(true);
    const opened: string[] = [];
    vi.stubGlobal(
      "WebSocket",
      class {
        readyState = 0;
        constructor(url: string) {
          opened.push(url);
        }
        addEventListener(): void {}
        removeEventListener(): void {}
        send(): void {}
        close(): void {}
      },
    );
    showCoopTitleMenu(CALLBACKS);
    await tick();
    await choose("Host a game");
    await choose("3 players (Beta)");
    expect(texts.at(-1)).toBe(i18next.t("menu:selectGameMode"));
    await choose(i18next.t("gameMode:classic"));
    await tick();

    expect(opened).toHaveLength(1);
    const params = new URL(opened[0]).searchParams;
    expect([params.get("role"), params.get("seats")]).toEqual(["host", "3"]);
  });

  it("offers Challenge when hosting (D41); Cancel on the challenge screen asks the mode again", async () => {
    showCoopTitleMenu(CALLBACKS);
    await tick();
    await choose("Host a game");
    await choose("2 players");
    await until(GameMode.getModeName(GameModes.CHALLENGE));
    expect(labels()).toEqual([
      i18next.t("gameMode:classic"),
      i18next.t("gameMode:endless"),
      GameMode.getModeName(GameModes.CHALLENGE),
      i18next.t("menu:cancel"),
    ]);
    await choose(GameMode.getModeName(GameModes.CHALLENGE));
    await tick();
    expect(game.scene.ui.mode).toBe(UiMode.CHALLENGE_SELECT);
    expect(game.scene.gameMode).toMatchObject({ isCoop: true, isChallenge: true });

    const screen = game.scene.ui.getHandler();
    (screen as unknown as { unblockInput?(): void }).unblockInput?.();
    screen.processInput(Button.CANCEL);
    await until(i18next.t("gameMode:endless"));
    expect(labels()).toContain(GameMode.getModeName(GameModes.CHALLENGE));
  });

  it("Start on the challenge screen hosts the game with the challenges that are on (D41)", async () => {
    vi.stubEnv("VITE_COOP_RELAY_URL", "ws://relay.test/coop");
    vi.spyOn(buildInfo, "overridesAreDefaults").mockReturnValue(true);
    const opened: string[] = [];
    vi.stubGlobal(
      "WebSocket",
      class {
        readyState = 0;
        constructor(url: string) {
          opened.push(url);
        }
        addEventListener(): void {}
        removeEventListener(): void {}
        send(): void {}
        close(): void {}
      },
    );
    showCoopTitleMenu(CALLBACKS);
    await tick();
    await choose("Host a game");
    await choose("2 players");
    await choose(GameMode.getModeName(GameModes.CHALLENGE));
    await tick();
    game.scene.gameMode.setChallengeValue(Challenges.INVERSE_BATTLE, 1);
    const screen = game.scene.ui.getHandler() as unknown as {
      hasSelectedChallenge: boolean;
      processInput(b: Button): boolean;
    };
    // (the screen's own refresh draws, which a headless game cannot)
    screen.hasSelectedChallenge = true;
    // Start, then confirm it
    screen.processInput(Button.SUBMIT);
    screen.processInput(Button.SUBMIT);
    await tick();
    expect(opened).toHaveLength(1);
    expect(new URL(opened[0]).searchParams.get("role")).toBe("host");
  });

  it("Find a partner asks Classic or Endless only (D41)", async () => {
    vi.stubEnv("VITE_COOP_RELAY_URL", "ws://relay.test/coop");
    showCoopTitleMenu(CALLBACKS);
    await tick();
    await choose("Find a partner");
    await until(i18next.t("gameMode:endless"));
    expect(labels()).not.toContain(GameMode.getModeName(GameModes.CHALLENGE));
  });

  it("Cancel on the mode question goes back to the players question", async () => {
    showCoopTitleMenu(CALLBACKS);
    await tick();
    await choose("Host a game");
    await choose("3 players (Beta)");
    await choose(i18next.t("menu:cancel"));
    await until("3 players (Beta)");
    expect(texts.at(-1)).toBe("How many players?");
    expect(labels()).toEqual(["2 players", "3 players (Beta)", i18next.t("menu:cancel")]);
  });
});
