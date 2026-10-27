/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { settings } from "#app/global-settings-manager";
import { guestHandshake, hostHandshake } from "#coop/handshake";
import {
  buildPinnedSettings,
  createSettingsOverlayPort,
  PINNED_SETTING_KEYS,
  readPinnedSettings,
} from "#coop/pinned-settings";
import { type BuildIdentity, hashCanonical } from "#coop/protocol";
import { endCoopSession, getCoopSession, isCoop, startCoopSession } from "#coop/session";
import { createLoopbackPair } from "#coop/transport/loopback";
import { ReliableTransport } from "#coop/transport/reliable";
import { BattleStyle } from "#enums/battle-style";
import { ExpNotification } from "#enums/exp-notification";
import { PlayerGender } from "#enums/player-gender";
import { defaultSettings } from "#system/default-settings";
import { SettingsManager } from "#system/settings-manager";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const LS_KEY = "coop-overlay-test-settings";

const build: BuildIdentity = {
  protocolVersion: 1,
  gitSha: "a6995c571a092e762ea036589bb6f3a8fa4f5dbd",
  dirtyHash: "clean",
  buildMode: "test",
  overridesHash: "00000000000000",
};

/** What a player who likes tutorials, the SWITCH style and fast text has saved. */
function guestPreferences(manager: SettingsManager): void {
  manager.update("general", "battleStyle", BattleStyle.SWITCH);
  manager.update("general", "enableTutorials", true);
  manager.update("general", "skipSeenDialogues", true);
  manager.update("general", "manualMessageClear", true);
  manager.update("general", "partyExpNotificationMode", ExpNotification.ONLY_LEVEL_UP);
  manager.update("general", "playerGender", PlayerGender.FEMALE);
  manager.update("general", "gameSpeed", 3);
}

function savedGeneral(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(LS_KEY)!).general;
}

describe("Co-op settings overlay (DECISIONS D1, D5)", () => {
  let manager: SettingsManager;

  beforeEach(() => {
    localStorage.removeItem(LS_KEY);
    manager = new SettingsManager(LS_KEY, structuredClone(defaultSettings));
    guestPreferences(manager);
  });

  afterEach(() => {
    localStorage.removeItem(LS_KEY);
  });

  it("applies: the pinned values are in effect, local-only settings are untouched", () => {
    manager.applyOverlay(buildPinnedSettings(PlayerGender.MALE) as never);

    expect(manager.hasOverlay).toBe(true);
    expect(manager.general.battleStyle).toBe(BattleStyle.SET);
    expect(manager.general.enableTutorials).toBe(false);
    expect(manager.general.skipSeenDialogues).toBe(false);
    expect(manager.general.manualMessageClear).toBe(false);
    expect(manager.general.partyExpNotificationMode).toBe(ExpNotification.SKIP);
    expect(manager.general.enableRetries).toBe(false);
    expect(manager.general.levelMoveConfirmation).toBe(true);
    expect(manager.general.playerGender).toBe(PlayerGender.MALE);
    expect(manager.general.gameSpeed).toBe(3);
    expect(manager.isPlayerFemale).toBe(false);
  });

  it("is never persisted, however often the settings are saved", () => {
    manager.applyOverlay(buildPinnedSettings(PlayerGender.MALE) as never);
    manager.update("general", "gameSpeed", 4); // saves
    manager.update("display", "hideUsername", true); // saves

    expect(savedGeneral()).toMatchObject({
      battleStyle: BattleStyle.SWITCH,
      enableTutorials: true,
      skipSeenDialogues: true,
      manualMessageClear: true,
      partyExpNotificationMode: ExpNotification.ONLY_LEVEL_UP,
      playerGender: PlayerGender.FEMALE,
      gameSpeed: 4,
    });
    expect(manager.persistedGeneral).toMatchObject({
      battleStyle: BattleStyle.SWITCH,
      playerGender: PlayerGender.FEMALE,
    });

    // a fresh start (a reload mid-session) sees the player's own settings
    const reloaded = new SettingsManager(LS_KEY, structuredClone(defaultSettings));
    expect(reloaded.general.battleStyle).toBe(BattleStyle.SWITCH);
    expect(reloaded.general.enableTutorials).toBe(true);
    expect(reloaded.general.playerGender).toBe(PlayerGender.FEMALE);
    expect(reloaded.hasOverlay).toBe(false);
  });

  it("keeps the overlay in effect when the player changes an overlaid setting, and saves their choice underneath", () => {
    manager.applyOverlay(buildPinnedSettings(PlayerGender.MALE) as never);
    manager.update("general", "battleStyle", BattleStyle.SWITCH);
    manager.update("general", "enableTutorials", false);

    expect(manager.general.battleStyle).toBe(BattleStyle.SET);
    expect(savedGeneral()["battleStyle"]).toBe(BattleStyle.SWITCH);
    expect(savedGeneral()["enableTutorials"]).toBe(false);

    manager.removeOverlay();
    expect(manager.general.battleStyle).toBe(BattleStyle.SWITCH);
    expect(manager.general.enableTutorials).toBe(false);
  });

  it("is removed at session end: the player's own settings are back, nothing was written", () => {
    const before = localStorage.getItem(LS_KEY);
    manager.applyOverlay(buildPinnedSettings(PlayerGender.MALE) as never);
    manager.removeOverlay();

    expect(manager.hasOverlay).toBe(false);
    expect(manager.general.battleStyle).toBe(BattleStyle.SWITCH);
    expect(manager.general.enableTutorials).toBe(true);
    expect(manager.general.skipSeenDialogues).toBe(true);
    expect(manager.general.playerGender).toBe(PlayerGender.FEMALE);
    expect(localStorage.getItem(LS_KEY)).toBe(before);
  });

  it("keeps the original values when a second overlay is applied on top of the first", () => {
    manager.applyOverlay({ battleStyle: BattleStyle.SET });
    manager.applyOverlay({ battleStyle: BattleStyle.SET, enableTutorials: false });
    manager.removeOverlay();
    expect(manager.general.battleStyle).toBe(BattleStyle.SWITCH);
    expect(manager.general.enableTutorials).toBe(true);
  });

  it("refuses an unknown setting without applying anything", () => {
    expect(() => manager.applyOverlay({ nonsense: 1 } as never)).toThrow("Unknown general setting: nonsense");
    expect(manager.hasOverlay).toBe(false);
  });

  describe("through the handshake and the session", () => {
    afterEach(() => {
      endCoopSession();
    });

    async function shakeHands(pinned: ReturnType<typeof buildPinnedSettings>) {
      const [rawHost, rawGuest] = createLoopbackPair();
      const overlay = createSettingsOverlayPort(manager);
      const [host, guest] = await Promise.all([
        hostHandshake(new ReliableTransport(rawHost), build, pinned),
        guestHandshake(new ReliableTransport(rawGuest), build, overlay),
      ]);
      return { host, guest, overlay };
    }

    it("the guest ends up with the host's pinned settings; the host's check passes", async () => {
      const pinned = buildPinnedSettings(PlayerGender.MALE);
      const { host, guest } = await shakeHands(pinned);

      expect(host.ok).toBe(true);
      expect(guest.ok && guest.effectiveSettingsHash).toBe(hashCanonical(pinned));
      expect(readPinnedSettings(manager)).toEqual(pinned);
      expect([...Object.keys(pinned)].sort()).toEqual(Array.from(PINNED_SETTING_KEYS).sort());
    });

    it("ending the session removes the overlay", async () => {
      const { guest, overlay } = await shakeHands(buildPinnedSettings(PlayerGender.MALE));
      expect(guest.ok).toBe(true);
      startCoopSession({ seat: "guest", runSeed: "seed", build, overlay });
      expect(isCoop()).toBe(true);
      expect(manager.general.battleStyle).toBe(BattleStyle.SET);

      getCoopSession()!.end();

      expect(isCoop()).toBe(false);
      expect(manager.hasOverlay).toBe(false);
      expect(manager.general.battleStyle).toBe(BattleStyle.SWITCH);
      expect(manager.general.playerGender).toBe(PlayerGender.FEMALE);
    });

    it("a pinned setting the guest does not know is refused and nothing stays applied", async () => {
      const { host, guest } = await shakeHands({ ...buildPinnedSettings(PlayerGender.MALE), nonsense: 1 });
      expect(host.ok).toBe(false);
      expect(guest).toMatchObject({ ok: false, reason: "malformed" });
      expect(manager.hasOverlay).toBe(false);
      expect(manager.general.battleStyle).toBe(BattleStyle.SWITCH);
    });
  });
});

describe("Co-op settings overlay and the system save", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
  });

  afterEach(() => {
    settings.removeOverlay();
  });

  it("saves the player's own gender, not the host's pinned one", () => {
    settings.update("general", "playerGender", PlayerGender.FEMALE);
    settings.applyOverlay({ playerGender: PlayerGender.MALE });
    expect(settings.general.playerGender).toBe(PlayerGender.MALE);

    expect(game.scene.gameData.getSystemSaveData().gender).toBe(PlayerGender.FEMALE);
  });
});
