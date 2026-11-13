/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { settings } from "#app/global-settings-manager";
import { CoopLink } from "#coop/link/link";
import { createLoopbackPair } from "#coop/transport/loopback";
import { ReliableTransport } from "#coop/transport/reliable";
import { chatNote, startChat, stopChat } from "#coop/ui/chat";
import { version } from "#package.json";
import { defaultSettings } from "#system/default-settings";
import { SettingsManager } from "#system/settings-manager";
import { coopSettingsUiItems } from "#ui/settings-ui-items";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The Co-op tab of the settings (DECISIONS D47): the two co-op switches, moved there from General, and what each player
 * sees of the co-op screens.
 */
describe("Co-op: the Co-op tab of the settings", () => {
  const key = "coopSettingsTest";

  afterEach(() => {
    localStorage.removeItem(key);
  });

  it("has an item for every co-op setting", () => {
    expect(coopSettingsUiItems.map(item => item.key).sort()).toEqual([...Object.keys(defaultSettings.coop)].sort());
  });

  it("brings the 3-player and debug switches saved under General along, without touching the defaults", () => {
    const meta = { gameVersion: version };
    localStorage.setItem(key, JSON.stringify({ meta, general: { coopThreePlayers: true, coopDebugMenu: true } }));
    const moved = new SettingsManager(key, defaultSettings);
    expect(moved.coop).toMatchObject({ threePlayers: true, debugMenu: true });
    expect(moved.general).not.toHaveProperty("coopThreePlayers");
    expect(moved.general).not.toHaveProperty("coopDebugMenu");
    expect(defaultSettings.coop).toMatchObject({ threePlayers: false, debugMenu: false });

    // A Co-op tab saved since wins over what General had
    localStorage.setItem(key, JSON.stringify({ meta, general: { coopDebugMenu: true }, coop: { debugMenu: false } }));
    expect(new SettingsManager(key, defaultSettings).coop.debugMenu).toBe(false);
  });
});

describe("Co-op: the Co-op tab's chat settings", () => {
  let mine: CoopLink;
  let theirs: CoopLink;
  const root = (): HTMLElement => document.getElementById("coopChat")!;

  beforeEach(() => {
    const [near, far] = createLoopbackPair();
    mine = new CoopLink({
      seat: "host",
      reliable: new ReliableTransport(near),
      names: { mine: "Sam", theirs: "Alex" },
    });
    theirs = new CoopLink({
      seat: "guest",
      reliable: new ReliableTransport(far),
      names: { mine: "Alex", theirs: "Sam" },
    });
    startChat(mine, "Sam");
  });

  afterEach(() => {
    settings.update("coop", "chatPopups", true);
    settings.update("coop", "chatButton", true);
    stopChat();
    mine.close();
    theirs.close();
    sessionStorage.clear();
  });

  it("pop-ups off: a note goes in the box only", () => {
    settings.update("coop", "chatPopups", false);
    chatNote("Alex released Rattata.");
    expect(root().querySelector(".coop-chat-toasts")!.children).toHaveLength(0);
    expect(root().querySelector(".coop-chat-log")!.textContent).toContain("Alex released Rattata.");

    settings.update("coop", "chatPopups", true);
    chatNote("Alex released Pidgey.");
    expect(root().querySelector(".coop-chat-toasts")!.children).toHaveLength(1);
  });

  it("button off: the button goes at once, and comes back", () => {
    const button = (): HTMLButtonElement => root().querySelector(".coop-chat-toggle")!;
    expect(button().hidden).toBe(false);
    settings.update("coop", "chatButton", false);
    expect(button().hidden).toBe(true);
    settings.update("coop", "chatButton", true);
    expect(button().hidden).toBe(false);
  });
});
