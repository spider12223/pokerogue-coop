/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as buildInfo from "#coop/build-info";
import { COOP_SLOT_VERSION, readCoopSlot, writeCoopSlot } from "#coop/coop-slot";
import { localAccountId, matchBuild, showCoopTitleMenu } from "#coop/lobby";
import { endCoopSession } from "#coop/session";
import { removeCoopSlot } from "#coop/wave-save";
import { Button } from "#enums/buttons";
import { UiMode } from "#enums/ui-mode";
import { GameManager } from "#test/framework/game-manager";
import type { OptionSelectUiHandler } from "#ui/option-select-ui-handler";
import i18next from "i18next";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Choosing the kind of run (DECISIONS D39): Host a game and Find a partner ask Classic or Endless; the queue of Find a
 * partner is the mode's; Continue says which kind the saved run is.
 */

const CALLBACKS = { onConnected: () => undefined, onCancel: () => undefined };
/** What the relay takes as a queue's key (`MATCH_BUILD` in `coop-server/src/relay-protocol.ts`) */
const MATCH_BUILD = /^[A-Za-z0-9._+-]{1,64}$/;

describe("Co-op: Classic or Endless (D39)", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;
  let texts: string[];

  const tick = () => new Promise(resolve => setTimeout(resolve, 20));

  function labels(): string[] {
    const handler = game.scene.ui.getHandler() as unknown as { config: { options: { label: string }[] } | null };
    return handler.config?.options.map(option => option.label) ?? [];
  }

  /** Wait for the menu to show this entry (the mode changes in between are asynchronous) */
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
    removeCoopSlot();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("Host a game asks Classic or Endless first; Cancel goes back to the co-op menu", async () => {
    showCoopTitleMenu(CALLBACKS);
    await tick();
    await choose("Host a game");
    expect(texts.at(-1)).toBe(i18next.t("menu:selectGameMode"));
    expect(labels()).toEqual([i18next.t("gameMode:classic"), i18next.t("gameMode:endless"), i18next.t("menu:cancel")]);

    await choose(i18next.t("menu:cancel"));
    await tick();
    expect(game.scene.ui.mode).toBe(UiMode.OPTION_SELECT);
    expect(labels()).toContain("Host a game");
  });

  it("Find a partner asks too, and waits in the queue of the kind chosen", async () => {
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
    await choose("Find a partner");
    expect(labels()).toContain(i18next.t("gameMode:endless"));
    await choose(i18next.t("gameMode:endless"));
    await tick();

    expect(opened).toHaveLength(1);
    expect(new URL(opened[0]).searchParams.get("match")).toBe(matchBuild("endless"));
    // the two kinds never meet in the queue, and both keys are ones the relay takes
    expect(matchBuild("endless")).not.toBe(matchBuild("classic"));
    for (const key of [matchBuild("classic"), matchBuild("endless")]) {
      expect(key).toMatch(MATCH_BUILD);
    }
    // stop looking
    await choose(i18next.t("menu:cancel"));
  });

  it("Continue says when the saved run is Endless; a slot from before is Classic", async () => {
    const slot = {
      version: COOP_SLOT_VERSION,
      savedAt: 1,
      wave: 340,
      epoch: 0,
      seq: 0,
      names: { host: "Sam", guest: "Alex" },
      accountIds: { host: localAccountId(), guest: "1:2" },
      session: "{}",
    } as const;
    writeCoopSlot(localStorage, { ...slot, runMode: "endless" });
    expect(readCoopSlot(localStorage)?.runMode).toBe("endless");
    showCoopTitleMenu(CALLBACKS);
    await tick();
    expect(labels()[0]).toBe("Continue (Endless, wave 340)");

    writeCoopSlot(localStorage, slot);
    expect(readCoopSlot(localStorage)).not.toBeNull();
    game.scene.ui.getHandler().clear();
    showCoopTitleMenu(CALLBACKS);
    await tick();
    expect(labels()[0]).toBe("Continue (wave 340)");

    // a damaged kind is a damaged slot
    writeCoopSlot(localStorage, { ...slot, runMode: "daily" as never });
    expect(readCoopSlot(localStorage)).toBeNull();
  });
});
