/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { pokerogueApi } from "#api/api";
import { UiMode } from "#enums/ui-mode";
import { GameManager } from "#test/framework/game-manager";
import type { TitleUiHandler } from "#ui/title-ui-handler";
import i18next from "i18next";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The title screen's "Players Online" in co-op (DECISIONS D46): the website's relay says how many players are connected
 * to it; without a relay built in (solo builds, the Windows pack) the game asks what it always asked.
 */

describe("Co-op: players online on the title screen (D46)", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(async () => {
    game = new GameManager(phaserGame);
    await game.runToTitle();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /** The title's label, set back to the game's "?", and its update */
  function title(): { label: { text: string }; update: () => void } {
    const handler = game.scene.ui.handlers[UiMode.TITLE] as TitleUiHandler;
    const fields = handler as unknown as { playerCountLabel: { text: string; setText(text: string): unknown } };
    fields.playerCountLabel.setText(`? ${i18next.t("menu:playersOnline")}`);
    return {
      label: fields.playerCountLabel,
      update: () => (handler as unknown as { updateTitleStats(): void }).updateTitleStats(),
    };
  }

  it("shows the count of the website's relay", async () => {
    vi.stubEnv("VITE_COOP_RELAY_URL", "wss://relay.example.dev/coop");
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ players: 12 }));
    vi.stubGlobal("fetch", fetcher);
    const stats = vi.spyOn(pokerogueApi, "getGameTitleStats");
    const { label, update } = title();
    update();
    await vi.waitFor(() => expect(label.text).toBe(`12 ${i18next.t("menu:playersOnline")}`));
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://relay.example.dev/coop/online");
    expect(stats).not.toHaveBeenCalled();
  });

  it("keeps the '?' when the relay gives no count", async () => {
    vi.stubEnv("VITE_COOP_RELAY_URL", "wss://relay.example.dev/coop");
    const fetcher = vi.fn<typeof fetch>(async () => new Response("Not found", { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    const { label, update } = title();
    update();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://relay.example.dev/coop/online");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(label.text).toBe(`? ${i18next.t("menu:playersOnline")}`);
  });

  it("asks the relay nothing without one built in, and the game's own stats as before", async () => {
    vi.stubEnv("VITE_COOP_RELAY_URL", "");
    const fetcher = vi.fn(async () => Response.json({ players: 12 }));
    vi.stubGlobal("fetch", fetcher);
    const stats = vi.spyOn(pokerogueApi, "getGameTitleStats").mockResolvedValue(null);
    const { label, update } = title();
    update();
    await vi.waitFor(() => expect(stats).toHaveBeenCalledOnce());
    expect(fetcher).not.toHaveBeenCalled();
    expect(label.text).toBe(`? ${i18next.t("menu:playersOnline")}`);
  });
});
