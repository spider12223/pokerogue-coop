/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Adapted from SunghoLee98/pokerogue `src/coop/coop-title-menu.ts` (AGPL-3.0-only): the title screen entry, host (get a
 * code and wait) or join (type the code).
 */

import { GameMode } from "#app/game-mode";
import { timedEventManager } from "#app/global-event-manager";
import { globalScene } from "#app/global-scene";
import { settings } from "#app/global-settings-manager";
import { isDev } from "#constants/app-constants";
import { startCosmeticView, stopCosmeticView } from "#coop/cosmetic/cosmetic-view";
import { setTouchEmoteVisible } from "#coop/cosmetic/touch-emote";
import { writeDebugOverrides } from "#coop/debug/overrides";
import { startDebugPanel, stopDebugPanel } from "#coop/debug/panel";
import { clearDebugQueue } from "#coop/debug/queue";
import { coopText } from "#coop/decisions/bridge";
import { validateProposal } from "#coop/decisions/validate";
import { attachCoopLog, setCoopLogServer } from "#coop/diagnostics/coop-diagnostics";
import { coopLog, hookPageIntoCoopLog } from "#coop/diagnostics/coop-log";
import { askAndReport, setReportButtonVisible } from "#coop/diagnostics/report-button";
import { listenForAgain } from "#coop/link/again-answer";
import { getLocalBuildIdentity, overridesAreDefaults } from "#coop/link/build-info";
import { openCoopChallengePick } from "#coop/link/challenge-pick";
import { getCoopName, setCoopName } from "#coop/link/display-name";
import {
  type CoopLink,
  createRoom,
  establishGuest,
  establishHost,
  HandshakeRefusedError,
  type HostRoom,
  joinRoom,
} from "#coop/link/link";
import { buildPinnedSettings, createSettingsOverlayPort } from "#coop/link/pinned-settings";
import { CollectionExchange, captureCollection, poolCollection, unpoolCollection } from "#coop/link/shared-collection";
import { StarterLobby } from "#coop/link/starter-lobby";
import {
  type CoopChallenge,
  type CoopRunMode,
  hashCanonical,
  keyId,
  type PlayerCount,
  type Seat,
  type SeatRecord,
  seatsFor,
  starterPoints,
} from "#coop/protocol";
import type { CoopSlot } from "#coop/save/coop-slot";
import { systemImportAvailable } from "#coop/save/import-account";
import { installResync, registerBeforeReload, registerLeaveHandler } from "#coop/save/resync-run";
import { pickCoopFile, savedCoopRuns } from "#coop/save/save-files";
import { forgetSeat, saveSeat } from "#coop/save/seat-store";
import { coopStore } from "#coop/save/wave-save";
import { type CoopSession, endCoopSession, getCoopSession, startCoopSession } from "#coop/session";
import { attachCheckpointExchange } from "#coop/sync/checkpoint-exchange";
import { findMatch, type MatchRole } from "#coop/transport/match-ws";
import { relayUrlFor } from "#coop/transport/relay-url";
import { RelayError } from "#coop/transport/relay-ws";
import { stopAllAfkWatchers } from "#coop/ui/afk";
import { startChat, stopChat } from "#coop/ui/chat";
import { copyText } from "#coop/ui/clipboard";
import { listenForFieldWheel } from "#coop/ui/field-zoom";
import { startPacer, stopPacer } from "#coop/ui/pace-run";
import { coloredName } from "#coop/ui/player-colors";
import { hidePlayersLine, showPlayersLine } from "#coop/ui/players-line";
import { hideReconnectScreen } from "#coop/ui/reconnect-ui";
import { GameDataType } from "#enums/game-data-type";
import { GameModes } from "#enums/game-modes";
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
/** What "Continue" does with the save file picked (D21): `rejoin.ts` sets it, so that this module does not import it */
let continueHandler: ((callbacks: CoopTitleCallbacks, file: number) => void) | null = null;
/** The code of the last join that did not go through, for the join form to start with */
let lastFailedCode: string | null = null;
/** Stops the co-op log's recording of the session (D26) */
let stopCoopLog: (() => void) | null = null;

export function registerContinueHandler(handler: (callbacks: CoopTitleCallbacks, file: number) => void): void {
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
  hidePlayersLine();
  const link = getCoopSession()?.link;
  // A tab whose seat another tab took leaves that tab's seat in the store (it is using it)
  const code = link?.wasReplaced ? undefined : link?.code;
  stopCoopLog?.();
  stopCoopLog = null;
  setReportButtonVisible(false);
  stopChat();
  stopDebugPanel();
  clearDebugQueue();
  writeDebugOverrides(null, 0);
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
 * Every screen of the run comes off: the ones under the screen on top (the command menu under the game's menu, the battle
 * under a confirm), the chain back to them, and the battle's line in the message box. The title screen clears only the
 * screen on top, and a plain `reset()` none (D20)
 */
export function clearRunScreens(): void {
  const { ui } = globalScene;
  ui.clearScreensUnder();
  ui.resetModeChain();
  ui.getMessageHandler().clearText();
}

/**
 * Back to the title screen, from wherever the run was: the session ends and the game starts over from the title, with a line
 * that says why if there is one.
 */
export function returnToTitle(message: string | null): void {
  leaveCoop();
  const { ui } = globalScene;
  clearRunScreens();
  const go = (): void => {
    clearRunScreens();
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

/**
 * The run is over (D35): what only a run needs stops (the text pacing, the reconnect and resync screens, the take-over clocks,
 * the partner's cursors and emotes), and the link stays for the end screen's "Play again"
 */
export function quietRunEnd(): void {
  stopPacer();
  stopResync?.();
  stopResync = null;
  hideReconnectScreen();
  stopAllAfkWatchers();
  stopCosmeticView();
  setTouchEmoteVisible(false);
}
// A guest whose START was lost is brought into the run by the reload: its starter select's lobby and pooled collection go
registerBeforeReload(() => closeStarterLobby());

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

/**
 * Size of the co-op menu: with all its rows (eight) at full size it runs off the top of the screen. At 5/6 each pixel of the
 * window and the font is still a whole number of canvas pixels (the game draws at 6x).
 */
const COOP_MENU_SCALE = 5 / 6;

/** "Host / Join / Cancel" */
export function showCoopTitleMenu(callbacks: CoopTitleCallbacks): void {
  // The host's saved runs, one per save file (D19, D21)
  const saved = continueHandler === null ? [] : savedCoopRuns().filter(slot => slot !== null);
  // A new run asks which file it goes in, unless no file has a run: then the first (D19)
  const inFile = (go: (file: number) => void): void =>
    saved.length === 0 ? go(1) : pickCoopFile("new", go, () => showCoopTitleMenu(callbacks));
  const options: OptionSelectItem[] = [
    ...(saved.length === 0 || continueHandler === null
      ? []
      : [
          {
            label:
              saved.length === 1
                ? continueLabel(saved[0])
                : coopText("continueRuns", "Continue ({{count}} saved runs)", { count: saved.length }),
            handler: () => {
              pickCoopFile(
                "continue",
                file => continueHandler?.(callbacks, file),
                () => showCoopTitleMenu(callbacks),
              );
              return true;
            },
          },
        ]),
    {
      label: coopText("host", "Host a game"),
      handler: () => {
        // How many players first, then the kind of run; Cancel on the second asks the first again (D40). The players are
        // asked only with 3-Player Co-op (Beta) on in the settings. A challenge run's challenges are picked last, on the
        // challenge screen, whose Cancel asks the kind again (D41)
        const threePlayers = settings.general.coopThreePlayers;
        const host = (): void => (threePlayers ? askPlayers(callbacks, players => kind(players)) : kind(2));
        const kind = (players: PlayerCount): void =>
          askRunMode(
            callbacks,
            runMode =>
              inFile(file =>
                runMode === "challenge"
                  ? openCoopChallengePick(
                      challenges => void hostGame(callbacks, runMode, undefined, players, challenges, file),
                      () => kind(players),
                    )
                  : void hostGame(callbacks, runMode, undefined, players, undefined, file),
              ),
            threePlayers ? host : undefined,
            true,
          );
        host();
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
    ...(matchmakingAvailable()
      ? [
          {
            label: coopText("findPartner", "Find a partner"),
            handler: () => {
              // As for hosting: the player may end up hosting, and the run then goes in the file picked here (D19)
              askRunMode(callbacks, runMode => inFile(file => void findPartner(callbacks, runMode, file)));
              return true;
            },
          },
        ]
      : []),
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
  showMenu({ options, yOffset: 48, scale: COOP_MENU_SCALE });
}

/** Show a menu of the co-op title screen, over whatever menu was there */
function showMenu(config: OptionSelectModeConfig): void {
  const { ui } = globalScene;
  if (ui.mode === UiMode.OPTION_SELECT) {
    // Back from a form opened from this menu (the name, the join code), or on from one of its entries: the menu cleared
    // itself, and asking for the mode it is already in changes nothing. Draw it again in place, with what changed
    ui.getHandler().show([config]);
    return;
  }
  ui.setOverlayMode(UiMode.OPTION_SELECT, config);
}

/** 2 or 3 players (D40), asked first when hosting (and at Continue of a run of three); Cancel goes back to the co-op menu */
export function askPlayers(callbacks: CoopTitleCallbacks, chosen: (players: PlayerCount) => void): void {
  const { ui } = globalScene;
  const option = (players: PlayerCount, label: string): OptionSelectItem => ({
    label,
    handler: () => {
      chosen(players);
      return true;
    },
  });
  // Out of the co-op menu first: it clears itself once the entry that led here returns, and would take this one with it
  void ui.setMode(UiMode.MESSAGE).then(() =>
    ui.showText(coopText("howManyPlayers", "How many players?"), null, () =>
      showMenu({
        options: [
          option(2, coopText("twoPlayers", "2 players")),
          option(3, coopText("threePlayers", "3 players (Beta)")),
          {
            label: i18next.t("menu:cancel"),
            handler: () => {
              void ui.setMode(UiMode.MESSAGE).then(() => {
                ui.clearText();
                showCoopTitleMenu(callbacks);
              });
              return true;
            },
          },
        ],
        yOffset: 48,
      }),
    ),
  );
}

/**
 * Classic or Endless (D39), asked before hosting and before looking for a partner; and Challenge when hosting (D41)
 * @param back - What Cancel does; default: back to the co-op menu
 * @param withChallenge - Offer a challenge run too
 */
function askRunMode(
  callbacks: CoopTitleCallbacks,
  chosen: (runMode: CoopRunMode) => void,
  back?: () => void,
  withChallenge = false,
): void {
  const { ui } = globalScene;
  const labels: Record<CoopRunMode, string> = {
    classic: i18next.t("gameMode:classic"),
    endless: i18next.t("gameMode:endless"),
    challenge: GameMode.getModeName(GameModes.CHALLENGE),
  };
  const option = (runMode: CoopRunMode): OptionSelectItem => ({
    label: labels[runMode],
    handler: () => {
      chosen(runMode);
      return true;
    },
  });
  // Out of the co-op menu first: it clears itself once the entry that led here returns, and would take this one with it
  void ui.setMode(UiMode.MESSAGE).then(() =>
    ui.showText(i18next.t("menu:selectGameMode"), null, () =>
      showMenu({
        options: [
          option("classic"),
          option("endless"),
          ...(withChallenge ? [option("challenge")] : []),
          {
            label: i18next.t("menu:cancel"),
            handler: () => {
              void ui.setMode(UiMode.MESSAGE).then(() => {
                ui.clearText();
                if (back === undefined) {
                  showCoopTitleMenu(callbacks);
                } else {
                  back();
                }
              });
              return true;
            },
          },
        ],
        yOffset: 48,
      }),
    ),
  );
}

/**
 * Who is in a room of three and who is still to come (D40): each name in its player's colour with a tick, "…" for a free
 * seat. The host leaves itself out
 */
function playersLine(names: Partial<Record<Seat, string>>, withHost: boolean): string {
  return seatsFor(3)
    .filter(seat => withHost || seat !== "host")
    .map(seat => {
      const name = names[seat];
      return name === undefined ? "…" : `${coloredName(seat, name)} ✓`;
    })
    .join("  ");
}

/** The host's waiting text in a room of three (D40); who has joined is on the line under it (`showPlayersLine`) */
function hostWaitingText(code: string): string {
  return coopText("waitingForPlayersHost", "Your join code is {{code}}. Waiting for players:", { code });
}

/**
 * A new run takes the place of the saved one at its first wave (D19): with a saved run, the player is asked first, as a solo
 * New Game over a saved run asks
 */
/** The Continue entry of a saved run, when it is the only one: its kind and wave (a run of three says so, D40) */
function continueLabel(slot: CoopSlot): string {
  if (slot.accountIds.guest2 !== undefined) {
    return coopText("continueThreeRun", "Continue (3 players, wave {{wave}})", { wave: slot.wave });
  }
  switch (slot.runMode) {
    case "endless":
      return coopText("continueEndlessRun", "Continue (Endless, wave {{wave}})", { wave: slot.wave });
    case "challenge":
      return coopText("continueChallengeRun", "Continue (Challenge, wave {{wave}})", { wave: slot.wave });
    default:
      return coopText("continueRun", "Continue (wave {{wave}})", { wave: slot.wave });
  }
}

export function showFailure(error: unknown, callbacks: CoopTitleCallbacks, message?: string): void {
  console.error("co-op connection failed:", error);
  coopLog().error("lobby", "connecting failed", { message: message ?? describeCoopError(error), error });
  leaveCoop();
  const { ui } = globalScene;
  ui.setMode(UiMode.MESSAGE);
  ui.showText(message ?? describeCoopError(error), null, () => callbacks.onCancel(), null, true);
}

/**
 * Show the join code with a cancel button while waiting for the partner.
 * @param waiting - What the message says; by default, the code and that the partner is awaited
 * @param copy - Whether "Copy code" is offered (not for a match: nobody types that code)
 */
export function showJoinCode(code: string, cancel: () => void, waiting?: string, copy = true): void {
  const { ui } = globalScene;
  joinCode = code;
  waiting ??= coopText("waitingForPartnerToJoin", "Your join code is {{code}}. Waiting for your partner…", {
    code,
  });
  const copyOption: OptionSelectItem[] = copy
    ? [
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
      ]
    : [];
  ui.showText(waiting, null, () => {
    ui.setOverlayMode(UiMode.OPTION_SELECT, {
      options: [
        ...copyOption,
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
  if (session.hasEnded || session.runOver || session.stopped !== null || getStarterLobby() !== null) {
    return; // the starter lobby and the end of the run have their own way of saying so
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
  init: {
    runSeed?: string;
    accountIds?: SeatRecord<string>;
    runMode?: CoopRunMode;
    challenges?: readonly CoopChallenge[];
    /** The host's debug menu is on (D42) */
    debug?: boolean;
    /** The host's co-op save file of the run (D19) */
    file?: number;
  } = {},
): CoopSession {
  const session = startCoopSession({
    seat,
    // The host's seed is drawn here and sent in `START`; the guest takes it from there (D3)
    runSeed: init.runSeed ?? (seat === "host" ? randomString(24) : "pending"),
    build: getLocalBuildIdentity(),
    overlay,
    ...(init.accountIds === undefined ? {} : { accountIds: init.accountIds }),
    ...(init.runMode === undefined ? {} : { runMode: init.runMode }),
    ...(init.challenges === undefined ? {} : { challenges: init.challenges }),
    ...(init.debug === true ? { debug: true } : {}),
    ...(init.file === undefined ? {} : { file: init.file }),
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
      // what a reloaded host resumes (D19, D20)
      ...(seat === "host" ? { file: session.file } : {}),
    });
  }
  attachCheckpointExchange(session, link);
  // The partner's answer on the end screen of the run (D35) can come before this client's run has ended
  listenForAgain(link);
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
  // In a game of three a guest shows the host's for now; the emotes of three come with the screen texts (D40)
  startCosmeticView(link, seat === "host" ? "guest" : "host");
  setTouchEmoteVisible(true);
  // The host's screen is the clock of the run's text: the guest's follows it (D27)
  startPacer(session, link);
  // What the session does goes into the co-op log, and the report button is there while it lasts (D26)
  stopCoopLog?.();
  stopCoopLog = attachCoopLog(session, link, getCoopName());
  setReportButtonVisible(true);
  // The chat box (D38), for the whole session
  startChat(link, getCoopName());
  // The wheel zooms this player's battlefield (D44)
  listenForFieldWheel();
  // The host's debug menu (D42): only the host's, and only with the menu on; nothing of an earlier run's is in effect
  clearDebugQueue();
  writeDebugOverrides(null, 0);
  if (seat === "host" && session.debug) {
    startDebugPanel();
  } else {
    stopDebugPanel();
  }
  link.sequencer.onDesync(error => {
    session.desyncMessage ??= error.message;
    console.error("co-op desync:", error);
  });
  return session;
}

async function enterLobby(session: CoopSession, link: CoopLink, callbacks: CoopTitleCallbacks): Promise<void> {
  closeStarterLobby();
  hidePlayersLine();
  const lobby = new StarterLobby({
    seat: session.seat,
    players: link.players,
    link,
    // 15 points for two, 20 for three (D32, D40)
    sharedLimit: starterPoints(link.players),
    makeRunSeed: () => session.runSeed,
    localEvents: () => timedEventManager.eventsByClock(),
  });
  starterLobby = lobby;
  // The starter select shows the Pokémon of both players (D32): it opens once the partner's are here
  const exchange = new CollectionExchange(link, captureCollection(globalScene.gameData));
  collectionExchange = exchange;
  // Both partners' in a game of three (D40)
  const partners = await exchange.partnerCollections(COLLECTION_TIMEOUT_MS);
  if (starterLobby !== lobby) {
    // Left while waiting
    return;
  }
  if (partners.length === 0) {
    coopLog().warn("lobby", "no collection from the partner: only this player's Pokémon on the starter select");
  } else {
    poolCollection(globalScene.gameData, partners);
    for (const partner of partners) {
      coopLog().info("lobby", "partner's collection", {
        species: Object.keys(partner.dex).length,
        starters: Object.keys(partner.starters).length,
      });
    }
  }
  globalScene.ui.setMode(UiMode.MESSAGE);
  // The battle message box, whatever the screen is, and its typing too: else "Connecting…" shows again when the run starts
  globalScene.ui.getMessageHandler().showText("", 0);
  // No emotes on the starter select: the button comes back with the first battle
  setTouchEmoteVisible(false);
  callbacks.onConnected();
}

/**
 * Create a room, show its code, and enter the lobby once the guest has joined and the handshake is through.
 * @param runMode - The kind of run (D39); the guest is told in the handshake
 * @param ready - A room the host already created, whose guest joins it by themselves ("Play again", D35; a match, D37), and
 * what the screen says meanwhile
 */
async function hostGame(
  callbacks: CoopTitleCallbacks,
  runMode: CoopRunMode,
  ready?: {
    room: HostRoom;
    waiting: string;
    why: string;
    copy?: boolean;
    /** How long the partner may take to come (a match); after it the room ends and `onNoPartner` runs */
    partnerWaitMs?: number;
    onNoPartner?: () => void;
  },
  players: PlayerCount = 2,
  /** A challenge run's challenges (D41) */
  challenges?: CoopChallenge[],
  /** The host's co-op save file the run goes in (D19) */
  file = 1,
): Promise<void> {
  const { ui } = globalScene;
  if (!overridesAreDefaults()) {
    showFailure(new Error("overrides in effect"), callbacks);
    return;
  }
  let room: HostRoom | null = null;
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    if ((ready !== undefined || room?.seats === 3) && room !== null) {
      // A room whose partner joins by themselves (a match, Play again), or a room of three a guest may be waiting in (D40):
      // they are told at once, not left waiting in it
      endRoom(room);
    } else {
      room?.cancel();
    }
    leaveCoop();
    callbacks.onCancel();
  };

  ui.setMode(UiMode.MESSAGE);
  ui.showText(coopText("gettingJoinCode", "Getting a join code…"));
  startLobbyLog();
  try {
    room = ready?.room ?? (await createRoom(getRelayUrl(), players === 3 ? { seats: 3 } : {}));
    if (cancelled) {
      return;
    }
    const code = room.identity.code;
    const three = room.seats === 3;
    coopLog().setContext({ room: code, seat: "host" });
    coopLog().info("lobby", ready === undefined ? "room created" : `room created ${ready.why}`, { code });
    showJoinCode(code, cancel, three ? hostWaitingText(code) : ready?.waiting, ready?.copy ?? true);
    if (three) {
      showPlayersLine(playersLine({}, false));
    }
    // In a room of three the host shakes hands with each guest as it comes (D40), below
    if (!three) {
      if (!(await partnerWithin(room, ready?.partnerWaitMs))) {
        if (!cancelled) {
          cancelled = true;
          coopLog().info("lobby", "the partner did not come", { code });
          endRoom(room);
          ready?.onNoPartner?.();
        }
        return;
      }
      if (cancelled) {
        return;
      }
      coopLog().info("lobby", "partner joined", { code: room.identity.code });
      ui.setMode(UiMode.MESSAGE);
      ui.showText(coopText("connecting", "Connecting…"));
    }
    const overlay = createSettingsOverlayPort(settings);
    const pinned = buildPinnedSettings(settings.general.playerGender);
    // The host plays with the pinned settings too (D1, D5)
    const effectiveHash = overlay.apply(pinned);
    // The debug menu (D42) as the handshake tells it, and the session says the same (the handshake can take a while)
    const debug = settings.general.coopDebugMenu;
    let established: Awaited<ReturnType<typeof establishHost>>;
    try {
      established = await establishHost(room, getLocalBuildIdentity(), pinned, {
        expectedEffectiveSettingsHash: effectiveHash,
        sequencer: { validatePayload: validateProposal },
        name: getCoopName(),
        runMode,
        ...(challenges === undefined ? {} : { challenges }),
        debug,
        ...(three
          ? {
              onProgress: (names: Partial<Record<Seat, string>>) => {
                if (!cancelled) {
                  coopLog().info("lobby", "players", { guests: Object.keys(names).length });
                  showPlayersLine(playersLine(names, false));
                }
              },
            }
          : {}),
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
    const session = beginSession(established.link, "host", overlay, {
      runMode,
      ...(challenges === undefined ? {} : { challenges }),
      debug,
      file,
    });
    await enterLobby(session, established.link, callbacks);
  } catch (error) {
    if (!cancelled) {
      if (room?.seats === 3) {
        // A guest who is through may be waiting in it: the room ends for them too (D40)
        endRoom(room);
      } else {
        room?.cancel();
      }
      showFailure(error, callbacks);
    }
  }
}

/**
 * A guest of three waits until the room is full (D40): who is in, in their colours, as the host's roster says.
 * @returns Whether it is; `false` if the link ended first
 */
function rosterComplete(link: CoopLink): Promise<boolean> {
  const { ui } = globalScene;
  return new Promise(resolve => {
    const show = (): void => {
      ui.setMode(UiMode.MESSAGE);
      ui.showText(coopText("waitingForPlayersGuest", "Waiting for players:"), 0, undefined, null, false);
      showPlayersLine(playersLine(link.knownNames, true));
    };
    const stops = [
      link.onRoster(() => {
        if (link.rosterComplete) {
          done(true);
        } else {
          show();
        }
      }),
      link.onEnd(() => done(false)),
    ];
    const done = (complete: boolean): void => {
      for (const stop of stops) {
        stop();
      }
      hidePlayersLine();
      resolve(complete);
    };
    if (link.rosterComplete) {
      done(true);
    } else if (link.isClosed) {
      done(false);
    } else {
      show();
    }
  });
}

/**
 * Join the room with this code, shake hands, and enter the lobby.
 * @param match - A code the relay gave a match (D37): if the join fails, `onFailed` runs (it searches again) instead of the
 * failure screen, and the join form does not keep the code (the player never saw it)
 */
export async function joinGame(
  rawCode: string,
  callbacks: CoopTitleCallbacks,
  match?: { onFailed: () => void },
): Promise<void> {
  const { ui } = globalScene;
  if (!overridesAreDefaults()) {
    showFailure(new Error("overrides in effect"), callbacks);
    return;
  }
  const code = rawCode.trim().toUpperCase();
  // Kept for the join form until a join goes through: a mistyped code is corrected, not typed again
  if (match === undefined) {
    lastFailedCode = code;
  }
  startLobbyLog();
  coopLog().setContext({ room: code, seat: "guest" });
  coopLog().info("lobby", "joining", { code });
  ui.setMode(UiMode.MESSAGE);
  ui.showText(coopText("connecting", "Connecting…"));
  try {
    const room = await joinRoom(getRelayUrl(), code);
    // `guest2` in a room of three (D40)
    coopLog().setContext({ room: code, seat: room.identity.seat });
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
    const session = beginSession(established.link, established.link.seat, overlay, {
      runMode: established.hello.runMode,
      ...(established.hello.challenges === undefined ? {} : { challenges: established.hello.challenges }),
      debug: established.hello.debug === true,
    });
    lastFailedCode = null;
    if (established.hello.mode === "resume") {
      // The host continues a saved run: its wave start arrives next, and `installResync` loads it (D21)
      session.awaitingReload = true;
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
    if (!(await rosterComplete(established.link))) {
      return; // the room ended under the guest: the session's end says so
    }
    await enterLobby(session, established.link, callbacks);
  } catch (error) {
    if (match === undefined) {
      showFailure(error, callbacks);
      return;
    }
    coopLog().info("lobby", "could not join the match's room", { error: String(error) });
    if (getCoopSession() !== null) {
      leaveCoop();
    }
    match.onFailed();
  }
}

/** How long a matched host waits for its partner to come into the room (D37) before it searches again */
const MATCH_PARTNER_WAIT_MS = 30_000;

/** @returns Whether the partner came into the room, within `ms` if it is given */
function partnerWithin(room: HostRoom, ms: number | undefined): Promise<boolean> {
  const came = room.partner.then(() => true);
  if (ms === undefined) {
    return came;
  }
  return Promise.race([came, new Promise<boolean>(resolve => setTimeout(() => resolve(false), ms))]);
}

/**
 * Whether "Find a partner" is offered (D37): with the public relay of the website (and in development). A self-hosted relay
 * (the Windows pack, Docker) has only the players who were given its address: there is nobody to find there.
 */
function matchmakingAvailable(): boolean {
  return isDev || (import.meta.env.VITE_COOP_RELAY_URL ?? "") !== "";
}

/** The queue this build waits in (D37): only an identical build can pair (D1), and only players who chose the same kind of run (D39) */
export function matchBuild(runMode: CoopRunMode): string {
  return hashCanonical({ build: getLocalBuildIdentity(), runMode });
}

/** What a player who could not be paired is told: the relay's own reasons, or that it could not be reached */
function matchFailureText(error: unknown): string {
  if (error instanceof RelayError && (error.reason === "rateLimited" || error.reason === "busy")) {
    return describeCoopError(error);
  }
  return coopText("matchFailed", "Could not look for a partner right now. Try again in a minute.");
}

/** End a room that nobody will come to, for good: a late partner is told at once instead of waiting in it */
function endRoom(room: HostRoom): void {
  try {
    room.relay.leave();
  } catch {
    room.cancel();
  }
}

/**
 * "Find a partner" (D37): wait in the relay's queue with the players of this build. Once matched, the player who waited
 * longer hosts a room as usual and the other joins it by its code, without anyone sharing it; from there it is a new game. A
 * match that does not become a game (the partner left, or never came) searches again by itself.
 * @param runMode - The kind of run (D39): only a partner who chose the same is found
 * @param again - Why it searches again, said before the clock
 */
async function findPartner(
  callbacks: CoopTitleCallbacks,
  runMode: CoopRunMode,
  file: number,
  again?: string,
): Promise<void> {
  const { ui } = globalScene;
  if (!overridesAreDefaults()) {
    showFailure(new Error("overrides in effect"), callbacks);
    return;
  }
  startLobbyLog();
  coopLog().info("lobby", again === undefined ? "looking for a partner" : "looking for a partner again");
  const search = findMatch(getRelayUrl(), matchBuild(runMode));
  let cancelled = false;
  /** Matched: from here the screen is the game's start, not the search's */
  let matched = false;
  let settled = false;
  let seconds = 0;
  const line = (): string => {
    if (matched) {
      return coopText("matchFound", "Found a partner! Getting the game ready…");
    }
    const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    return again === undefined
      ? coopText("matchLooking", "Looking for a partner… {{clock}}", { clock })
      : `${again} ${clock}`;
  };
  const draw = (): void => {
    if (!cancelled && !settled) {
      ui.showText(line(), 0, undefined, null, false);
    }
  };
  const ticker = setInterval(() => {
    seconds++;
    if (!matched) {
      draw();
    }
  }, 1000);
  search.onStatus(status => {
    matched = status === "matched";
    draw();
  });
  // The menu goes up once the screen is the message's (the co-op menu fades out first); the clock updates the line under it
  await ui.setMode(UiMode.MESSAGE);
  draw();
  ui.setOverlayMode(UiMode.OPTION_SELECT, {
    options: [
      {
        label: i18next.t("menu:cancel"),
        handler: () => {
          cancelled = true;
          clearInterval(ticker);
          search.cancel();
          coopLog().info("lobby", "stopped looking for a partner");
          ui.setMode(UiMode.MESSAGE).then(() => {
            ui.clearText();
            showCoopTitleMenu(callbacks);
          });
          return true;
        },
      },
    ],
    yOffset: 48,
  });
  let role: MatchRole;
  try {
    role = await search.found;
  } catch (error) {
    clearInterval(ticker);
    search.cancel();
    if (!cancelled) {
      showFailure(error, callbacks, matchFailureText(error));
    }
    return;
  }
  clearInterval(ticker);
  settled = true;
  if (cancelled) {
    search.cancel();
    return;
  }
  coopLog().info("lobby", "found a partner", { role: role.role });
  const searchAgain = (why: string): void => {
    void findPartner(callbacks, runMode, file, why);
  };
  if (role.role === "guest") {
    search.cancel();
    await joinGame(role.code, callbacks, {
      onFailed: () => searchAgain(coopText("matchJoinFailed", "Could not reach your partner. Looking again…")),
    });
    return;
  }
  let room: HostRoom;
  try {
    room = await createRoom(getRelayUrl());
  } catch (error) {
    // The relay closes the queue's connection, and the partner goes back in the queue
    search.cancel();
    if (!cancelled) {
      showFailure(error, callbacks, matchFailureText(error));
    }
    return;
  }
  const delivered = await role.sendCode(room.identity.code);
  search.cancel();
  if (cancelled) {
    endRoom(room);
    return;
  }
  if (!delivered) {
    coopLog().info("lobby", "the partner left before the room was made");
    endRoom(room);
    searchAgain(coopText("matchPartnerLeft", "Your partner left. Looking again…"));
    return;
  }
  await hostGame(
    callbacks,
    runMode,
    {
      room,
      waiting: coopText("matchWaiting", "Found a partner! Waiting for them to connect…"),
      why: "for a match",
      // nobody types this code: the relay gave it to the partner
      copy: false,
      partnerWaitMs: MATCH_PARTNER_WAIT_MS,
      onNoPartner: () => searchAgain(coopText("matchNoShow", "Your partner did not connect. Looking again…")),
    },
    2,
    undefined,
    file,
  );
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

/**
 * Host, after "Play again" (D35): wait in the room created at the end of the last run for the partner, who joins it by
 * themselves, then enter the lobby as for a new game
 */
export function hostAgain(
  callbacks: CoopTitleCallbacks,
  room: HostRoom,
  partner: string,
  runMode: CoopRunMode = "classic",
  challenges?: CoopChallenge[],
  /** The save file of the run that ended: the new one goes in it (D19) */
  file = 1,
): Promise<void> {
  const waiting = coopText("againWaiting", "Waiting for {{partner}} to join the new game (code {{code}})…", {
    partner,
    code: room.identity.code,
  });
  // (a room of three when both guests of a game of three want to play again, D40)
  return hostGame(callbacks, runMode, { room, waiting, why: "to play again" }, room.seats, challenges, file);
}
