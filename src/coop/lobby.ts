/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Adapted from SunghoLee98/pokerogue `src/coop/coop-title-menu.ts` (AGPL-3.0-only): the title screen entry, host (get a
 * code and wait) or join (type the code).
 */

import { globalScene } from "#app/global-scene";
import { settings } from "#app/global-settings-manager";
import { stopAllAfkWatchers } from "#coop/afk";
import { coopText } from "#coop/bridge";
import { getLocalBuildIdentity, overridesAreDefaults } from "#coop/build-info";
import { attachCheckpointExchange } from "#coop/checkpoint-exchange";
import { copyText } from "#coop/clipboard";
import { attachCoopLog, setCoopLogServer } from "#coop/coop-diagnostics";
import { coopLog, hookPageIntoCoopLog } from "#coop/coop-log";
import { startCosmeticView, stopCosmeticView } from "#coop/cosmetic-view";
import { getCoopName, setCoopName } from "#coop/display-name";
import { systemImportAvailable } from "#coop/import-account";
import {
  type CoopLink,
  createRoom,
  establishGuest,
  establishHost,
  HandshakeRefusedError,
  type HostRoom,
  joinRoom,
} from "#coop/link";
import { startPacer, stopPacer } from "#coop/pace-run";
import { buildPinnedSettings, createSettingsOverlayPort } from "#coop/pinned-settings";
import { COOP_STARTER_POINTS, keyId, otherSeat, type Seat } from "#coop/protocol";
import { hideReconnectScreen } from "#coop/reconnect-ui";
import { relayUrlFor } from "#coop/relay-url";
import { askAndReport, setReportButtonVisible } from "#coop/report-button";
import { installResync, registerLeaveHandler } from "#coop/resync-run";
import { forgetSeat, saveSeat } from "#coop/seat-store";
import { type CoopSession, endCoopSession, getCoopSession, startCoopSession } from "#coop/session";
import { CollectionExchange, captureCollection, poolCollection, unpoolCollection } from "#coop/shared-collection";
import { StarterLobby } from "#coop/starter-lobby";
import { setTouchEmoteVisible } from "#coop/touch-emote";
import { RelayError } from "#coop/transport/relay-ws";
import { validateProposal } from "#coop/validate";
import { coopStore, currentCoopSlot } from "#coop/wave-save";
import { GameDataType } from "#enums/game-data-type";
import { UiMode } from "#enums/ui-mode";
import type { OptionSelectItem, OptionSelectModeConfig } from "#types/ui-types";
import { randomString } from "#utils/common";
import i18next from "i18next";

/**
 * The co-op entry of the title screen and the lobby behind it (DECISIONS D1, D3).
 * Host: creates a room and shows its code. Join: asks for a code. Once the two clients have shaken hands (builds, pinned
 * settings, D1) the co-op session exists and both go to the co-op starter select.
 *
 * @module
 */

/** The relay that pairs the two clients: `VITE_COOP_RELAY_URL`, or `/coop` of the origin the game came from (D22). */
export function getRelayUrl(): string {
  return relayUrlFor(import.meta.env.VITE_COOP_RELAY_URL, window.location);
}

export interface CoopTitleCallbacks {
  /** Connected: continue to the co-op starter select. The UI is already in message mode. */
  onConnected(): void;
  /** Back to the title screen */
  onCancel(): void;
}

let starterLobby: StarterLobby | null = null;
/** Sends this player's collection and gets the partner's, while the lobby is open (D32) */
let collectionExchange: CollectionExchange | null = null;
/** How long the lobby waits for the partner's collection before opening the starter select without it */
const COLLECTION_TIMEOUT_MS = 15_000;
let joinCode: string | null = null;
/** Stops the resync of the session (D13) */
let stopResync: (() => void) | null = null;
/** What "Continue" does (D21): `rejoin.ts` sets it, so that this module does not import it */
let continueHandler: ((callbacks: CoopTitleCallbacks) => void) | null = null;
/** The code of the last join that did not go through, for the join form to start with */
let lastFailedCode: string | null = null;
/** Stops the co-op log's recording of the session (D26) */
let stopCoopLog: (() => void) | null = null;

export function registerContinueHandler(handler: (callbacks: CoopTitleCallbacks) => void): void {
  continueHandler = handler;
}

/** This player's account, as the handshake and the save name it (D4, D21) */
export function localAccountId(): string {
  const { gameData } = globalScene;
  return `${gameData.trainerId}:${gameData.secretId}`;
}

/** @returns The join code of the room this client hosts, once it exists (the debug API shows it to the test) */
export function getJoinCode(): string | null {
  return joinCode;
}

/** @returns The co-op starter select state of this client, while the lobby is open */
export function getStarterLobby(): StarterLobby | null {
  return getCoopSession() === null ? null : starterLobby;
}

/** Forget the lobby: the run started, or the players left. The starter select shows this player's own Pokémon again. */
export function closeStarterLobby(): void {
  starterLobby?.dispose();
  starterLobby = null;
  collectionExchange?.dispose();
  collectionExchange = null;
  unpoolCollection();
  joinCode = null;
}

/**
 * Leave the lobby or the run for good: the session ends (its overlay comes off, its link closes), the lobby is forgotten, and
 * so is the seat in the room: it was only for coming back (D20).
 */
export function leaveCoop(): void {
  const code = getCoopSession()?.link?.code;
  stopCoopLog?.();
  stopCoopLog = null;
  setReportButtonVisible(false);
  closeStarterLobby();
  stopCosmeticView();
  stopPacer();
  setTouchEmoteVisible(false);
  stopResync?.();
  stopResync = null;
  hideReconnectScreen();
  stopAllAfkWatchers();
  const store = coopStore();
  if (store !== null && code !== undefined && code !== "") {
    forgetSeat(store, code);
  }
  endCoopSession();
}

/**
 * Back to the title screen, from wherever the run was: the session ends and the game starts over from the title, with a line
 * that says why if there is one.
 */
export function returnToTitle(message: string | null): void {
  leaveCoop();
  const { ui } = globalScene;
  const go = (): void => {
    globalScene.reset();
    globalScene.phaseManager.toTitleScreen();
    globalScene.phaseManager.shiftPhase();
  };
  if (message === null) {
    go();
    return;
  }
  void ui.setMode(UiMode.MESSAGE).then(() => ui.showText(message, null, go, null, true));
}

registerLeaveHandler(() => returnToTitle(null));

/** A message for the player explaining why connecting failed. */
export function describeCoopError(error: unknown): string {
  if (error instanceof RelayError) {
    switch (error.reason) {
      case "notFound":
        return coopText("codeNotFound", "That code does not match a game.");
      case "full":
        return coopText("roomFull", "That game already has two players.");
      case "busy":
        return coopText("serverBusy", "The server is full right now. Try again in a minute.");
      case "rateLimited":
        return coopText("tooManyTries", "Too many tries. Wait a minute and try again.");
      case "badRequest":
        return coopText("invalidCode", "That is not a valid code.");
      default:
        return coopText("connectionFailed", "Could not connect.");
    }
  }
  if (error instanceof HandshakeRefusedError) {
    if (error.result.mismatches.some(mismatch => mismatch.field === "accountId")) {
      return coopText("otherGuest", "This saved run belongs to another guest.");
    }
    return error.result.reason === "mismatch" || error.result.reason === "refused"
      ? coopText("versionMismatch", "You and your partner run different versions of the game.")
      : coopText("connectionFailed", "Could not connect.");
  }
  return coopText("connectionFailed", "Could not connect.");
}

/** The title screen entry that opens the co-op menu. */
export function createCoopTitleOption(callbacks: CoopTitleCallbacks): OptionSelectItem {
  return {
    label: coopText("coop", "Co-op"),
    handler: () => {
      showCoopTitleMenu(callbacks);
      return true;
    },
  };
}

/** From choosing Co-op on: the co-op log records, and sends to the relay's server (D26) */
function startLobbyLog(): void {
  hookPageIntoCoopLog();
  coopLog().setContext({ name: getCoopName() });
  setCoopLogServer(getRelayUrl());
}

/** "Report a problem" of the co-op menu: for after a reload, when the button of the session is gone (D26) */
function reportFromTitle(callbacks: CoopTitleCallbacks): void {
  setCoopLogServer(getRelayUrl());
  void askAndReport().then(result => {
    if (result === null) {
      showCoopTitleMenu(callbacks);
      return;
    }
    const { ui } = globalScene;
    ui.setMode(UiMode.MESSAGE);
    ui.showText(
      result === "sent"
        ? coopText("reportSentTitle", "Thank you: the report was sent, and saved to your downloads.")
        : coopText(
            "reportSavedTitle",
            "The report was saved to your downloads. Please send the file to whoever looks after the game.",
          ),
      null,
      () => callbacks.onCancel(),
      null,
      true,
    );
  });
}

/**
 * "Import PokéRogue data" of the co-op menu: an account exported from pokerogue.net, so the players bring their own
 * Pokémon. The file picker opens on the key press that closes the explanation (a browser opens one only right after an input),
 * and the co-op menu comes back under it; choosing a file asks before anything is replaced (`GameData.importData`).
 */
function importFromTitle(callbacks: CoopTitleCallbacks): void {
  const { ui } = globalScene;
  void ui.setMode(UiMode.MESSAGE).then(() =>
    ui.showText(
      // (">", not an arrow: the game's font has none)
      coopText("importHowTo", "On pokerogue.net: Menu > Manage Data > Export Data. Then choose that file here."),
      null,
      () => {
        globalScene.gameData.importData(GameDataType.SYSTEM);
        showCoopTitleMenu(callbacks);
      },
      null,
      true,
    ),
  );
}

/** "Host / Join / Cancel" */
export function showCoopTitleMenu(callbacks: CoopTitleCallbacks): void {
  const slot = continueHandler === null ? null : currentCoopSlot();
  const options: OptionSelectItem[] = [
    ...(slot === null || continueHandler === null
      ? []
      : [
          {
            label: coopText("continueRun", "Continue (wave {{wave}})", { wave: slot.wave }),
            handler: () => {
              continueHandler?.(callbacks);
              return true;
            },
          },
        ]),
    {
      label: coopText("host", "Host a game"),
      handler: () => {
        void hostGame(callbacks);
        return true;
      },
    },
    {
      label: coopText("join", "Join a game"),
      handler: () => {
        showJoinForm(callbacks);
        return true;
      },
    },
    {
      label: coopText("nameOption", "Your name: {{name}}", { name: getCoopName() }),
      handler: () => {
        showNameForm(callbacks);
        return true;
      },
    },
    ...(systemImportAvailable()
      ? [
          {
            label: coopText("importAccount", "Import PokéRogue data"),
            handler: () => {
              importFromTitle(callbacks);
              return true;
            },
          },
        ]
      : []),
    ...(coopLog().all.length === 0
      ? []
      : [
          {
            label: coopText("reportProblem", "Report a problem"),
            handler: () => {
              reportFromTitle(callbacks);
              return true;
            },
          },
        ]),
    {
      label: i18next.t("menu:cancel"),
      handler: () => {
        callbacks.onCancel();
        return true;
      },
    },
  ];
  const config: OptionSelectModeConfig = { options, yOffset: 48 };
  const { ui } = globalScene;
  if (ui.mode === UiMode.OPTION_SELECT) {
    // Back from a form opened from this menu (the name, the join code): reverting the form returned to this mode, but the
    // menu cleared itself when the form opened, and asking for the mode it is already in changes nothing. Draw it again in
    // place, with what changed (the new name)
    ui.getHandler().show([config]);
    return;
  }
  ui.setOverlayMode(UiMode.OPTION_SELECT, config);
}

export function showFailure(error: unknown, callbacks: CoopTitleCallbacks, message?: string): void {
  console.error("co-op connection failed:", error);
  coopLog().error("lobby", "connecting failed", { message: message ?? describeCoopError(error), error });
  leaveCoop();
  const { ui } = globalScene;
  ui.setMode(UiMode.MESSAGE);
  ui.showText(message ?? describeCoopError(error), null, () => callbacks.onCancel(), null, true);
}

/** Show the join code with a cancel button while waiting for the partner. */
export function showJoinCode(code: string, cancel: () => void): void {
  const { ui } = globalScene;
  joinCode = code;
  const waiting = coopText("waitingForPartnerToJoin", "Your join code is {{code}}. Waiting for your partner…", {
    code,
  });
  ui.showText(waiting, null, () => {
    ui.setOverlayMode(UiMode.OPTION_SELECT, {
      options: [
        {
          // The code goes to the clipboard, and the message says whether it did; the menu stays
          label: coopText("copyCode", "Copy code"),
          keepOpen: true,
          handler: () => {
            void copyText(code).then(copied => {
              ui.showText(
                copied
                  ? coopText("codeCopied", "Copied {{code}}. Waiting for your partner…", { code })
                  : coopText("codeNotCopied", "Could not copy. Your join code is {{code}}.", { code }),
                null,
                undefined,
                null,
                false,
              );
            });
            return true;
          },
        },
        {
          label: i18next.t("menu:cancel"),
          handler: () => {
            cancel();
            return true;
          },
        },
      ],
      yOffset: 48,
    });
  });
}

/** What a player is told when the room is over under them: the partner ended it, or the connection could not be restored */
function sessionOver(session: CoopSession, end: "peerGone" | "closed"): void {
  if (session.hasEnded || session.stopped !== null || getStarterLobby() !== null) {
    return; // the starter lobby has its own way of saying so
  }
  const partner = session.partnerName;
  returnToTitle(
    session.link?.closedReason === "idle"
      ? coopText("roomIdle", "The room was closed after a long time without a move.")
      : end === "peerGone"
        ? coopText("partnerEnded", "{{partner}} ended the session.", { partner })
        : coopText("connectionLost", "The connection to {{partner}} was lost.", { partner }),
  );
}

/**
 * Start the co-op session of this client on a link that has shaken hands.
 * @param init - A run that is resumed (D21) has its own seed and accounts
 */
export function beginSession(
  link: CoopLink,
  seat: Seat,
  overlay: ReturnType<typeof createSettingsOverlayPort>,
  init: { runSeed?: string; accountIds?: Record<Seat, string> } = {},
): CoopSession {
  const session = startCoopSession({
    seat,
    // The host's seed is drawn here and sent in `START`; the guest takes it from there (D3)
    runSeed: init.runSeed ?? (seat === "host" ? randomString(24) : "pending"),
    build: getLocalBuildIdentity(),
    overlay,
    ...(init.accountIds === undefined ? {} : { accountIds: init.accountIds }),
  });
  session.link = link;
  // The seat token, so that a reloaded or reopened tab takes the seat back by itself (D20)
  const store = coopStore();
  const identity = link.identity;
  const relayUrl = link.relayUrl;
  if (store !== null && identity !== null && relayUrl !== null) {
    saveSeat(store, {
      code: identity.code,
      seat: identity.seat,
      token: identity.token,
      relayUrl,
      savedAt: Date.now(),
      partnerName: link.partnerName,
    });
  }
  attachCheckpointExchange(session, link);
  stopResync?.();
  stopResync = installResync(session, link);
  link.onEnd(end => {
    if (end === "peerGone" || end === "closed") {
      sessionOver(session, end);
    }
  });
  link.sequencer.onDecision(decision => {
    if (decision.takeover === true) {
      session.takeovers.push({ key: keyId(decision.key), author: decision.author });
    }
  });
  // What the partner's cosmetic messages show; the keys that send ours are buttons of the game (D16), and a touch screen
  // gets its emote button now
  startCosmeticView(link, otherSeat(seat));
  setTouchEmoteVisible(true);
  // The host's screen is the clock of the run's text: the guest's follows it (D27)
  startPacer(session, link);
  // What the session does goes into the co-op log, and the report button is there while it lasts (D26)
  stopCoopLog?.();
  stopCoopLog = attachCoopLog(session, link, getCoopName());
  setReportButtonVisible(true);
  link.sequencer.onDesync(error => {
    session.desyncMessage ??= error.message;
    console.error("co-op desync:", error);
  });
  return session;
}

async function enterLobby(session: CoopSession, link: CoopLink, callbacks: CoopTitleCallbacks): Promise<void> {
  closeStarterLobby();
  const lobby = new StarterLobby({
    seat: session.seat,
    link,
    sharedLimit: COOP_STARTER_POINTS,
    makeRunSeed: () => session.runSeed,
  });
  starterLobby = lobby;
  // The starter select shows the Pokémon of both players (D32): it opens once the partner's are here
  const exchange = new CollectionExchange(link, captureCollection(globalScene.gameData));
  collectionExchange = exchange;
  const partner = await exchange.partnerCollection(COLLECTION_TIMEOUT_MS);
  if (starterLobby !== lobby) {
    // Left while waiting
    return;
  }
  if (partner === null) {
    coopLog().warn("lobby", "no collection from the partner: only this player's Pokémon on the starter select");
  } else {
    poolCollection(globalScene.gameData, partner);
    coopLog().info("lobby", "partner's collection", {
      species: Object.keys(partner.dex).length,
      starters: Object.keys(partner.starters).length,
    });
  }
  globalScene.ui.setMode(UiMode.MESSAGE);
  // The battle message box, whatever the screen is, and its typing too: else "Connecting…" shows again when the run starts
  globalScene.ui.getMessageHandler().showText("", 0);
  // No emotes on the starter select: the button comes back with the first battle
  setTouchEmoteVisible(false);
  callbacks.onConnected();
}

/** Create a room, show its code, and enter the lobby once the guest has joined and the handshake is through. */
async function hostGame(callbacks: CoopTitleCallbacks): Promise<void> {
  const { ui } = globalScene;
  if (!overridesAreDefaults()) {
    showFailure(new Error("overrides in effect"), callbacks);
    return;
  }
  let room: HostRoom | null = null;
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    room?.cancel();
    leaveCoop();
    callbacks.onCancel();
  };

  ui.setMode(UiMode.MESSAGE);
  ui.showText(coopText("gettingJoinCode", "Getting a join code…"));
  startLobbyLog();
  try {
    room = await createRoom(getRelayUrl());
    if (cancelled) {
      return;
    }
    coopLog().setContext({ room: room.identity.code, seat: "host" });
    coopLog().info("lobby", "room created", { code: room.identity.code });
    showJoinCode(room.identity.code, cancel);
    await room.partner;
    if (cancelled) {
      return;
    }
    coopLog().info("lobby", "partner joined", { code: room.identity.code });
    ui.setMode(UiMode.MESSAGE);
    ui.showText(coopText("connecting", "Connecting…"));
    const overlay = createSettingsOverlayPort(settings);
    const pinned = buildPinnedSettings(settings.general.playerGender);
    // The host plays with the pinned settings too (D1, D5)
    const effectiveHash = overlay.apply(pinned);
    let established: Awaited<ReturnType<typeof establishHost>>;
    try {
      established = await establishHost(room, getLocalBuildIdentity(), pinned, {
        expectedEffectiveSettingsHash: effectiveHash,
        sequencer: { validatePayload: validateProposal },
        name: getCoopName(),
      });
    } catch (error) {
      overlay.remove();
      throw error;
    }
    if (cancelled) {
      overlay.remove();
      established.link.close();
      return;
    }
    const session = beginSession(established.link, "host", overlay);
    await enterLobby(session, established.link, callbacks);
  } catch (error) {
    if (!cancelled) {
      room?.cancel();
      showFailure(error, callbacks);
    }
  }
}

/** Join the room with this code, shake hands, and enter the lobby. */
export async function joinGame(rawCode: string, callbacks: CoopTitleCallbacks): Promise<void> {
  const { ui } = globalScene;
  if (!overridesAreDefaults()) {
    showFailure(new Error("overrides in effect"), callbacks);
    return;
  }
  const code = rawCode.trim().toUpperCase();
  // Kept for the join form until a join goes through: a mistyped code is corrected, not typed again
  lastFailedCode = code;
  startLobbyLog();
  coopLog().setContext({ room: code, seat: "guest" });
  coopLog().info("lobby", "joining", { code });
  ui.setMode(UiMode.MESSAGE);
  ui.showText(coopText("connecting", "Connecting…"));
  try {
    const room = await joinRoom(getRelayUrl(), code);
    const overlay = createSettingsOverlayPort(settings);
    let established: Awaited<ReturnType<typeof establishGuest>>;
    try {
      established = await establishGuest(room, getLocalBuildIdentity(), overlay, {
        name: getCoopName(),
        accountId: localAccountId(),
      });
    } catch (error) {
      room.cancel();
      throw error;
    }
    const session = beginSession(established.link, "guest", overlay);
    lastFailedCode = null;
    if (established.hello.mode === "resume") {
      // The host continues a saved run: its wave start arrives next, and `installResync` loads it (D21)
      ui.setMode(UiMode.MESSAGE);
      ui.showText(
        coopText("waitingForResume", "Waiting for {{partner}} to load the saved game…", {
          partner: established.link.partnerName,
        }),
        null,
        undefined,
        null,
        false,
      );
      return;
    }
    await enterLobby(session, established.link, callbacks);
  } catch (error) {
    showFailure(error, callbacks);
  }
}

/** Ask for this player's name (D1), then come back to the co-op menu. */
function showNameForm(callbacks: CoopTitleCallbacks): void {
  const { ui } = globalScene;
  const back = (): void => {
    void ui.revertMode().then(() => showCoopTitleMenu(callbacks));
  };
  void ui.setOverlayMode(
    UiMode.COOP_NAME_FORM,
    {
      buttonActions: [
        (name: string) => {
          setCoopName(name);
          back();
        },
        back,
      ],
    },
    getCoopName(),
  );
}

/** Ask for the join code, connect and enter the lobby; cancel goes back to the co-op menu, as the name form does. */
function showJoinForm(callbacks: CoopTitleCallbacks): void {
  const { ui } = globalScene;
  void ui.setOverlayMode(
    UiMode.COOP_JOIN_FORM,
    {
      buttonActions: [
        (code: string) => void joinGame(code, callbacks),
        () => void ui.revertMode().then(() => showCoopTitleMenu(callbacks)),
      ],
    },
    lastFailedCode ?? "",
  );
}

/** Host: start a game without the menus (the debug API and the end-to-end test use it) */
export function hostGameWithoutMenu(callbacks: CoopTitleCallbacks): Promise<void> {
  return hostGame(callbacks);
}
