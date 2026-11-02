/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { type AgainAnswer, listenForAgain } from "#coop/again-answer";
import { challengesOn } from "#coop/challenge-pick";
import { coopLog } from "#coop/coop-log";
import { createRoom, type HostRoom } from "#coop/link";
import { type CoopTitleCallbacks, getRelayUrl, hostAgain, joinGame, quietRunEnd } from "#coop/lobby";
import type { CoopChallenge, CoopRunMode, PlayerCount, Seat } from "#coop/protocol";
import { getCoopSession } from "#coop/session";
import { coopText } from "#coop/text";
import { UiMode } from "#enums/ui-mode";
import type { OptionSelectItem } from "#types/ui-types";
import { fixedInt } from "#utils/common";

/**
 * "Play again" at the end of a co-op run (DECISIONS D35). Both players are asked on the end screen, and their answers travel
 * on the run's link (`LOBBY` `again`). Once both want to, the host creates a new room and sends its code (`againCode`); both
 * leave the old room, and from the title screen the host waits in the new one while the guest joins it by itself. From there
 * it is a new game: a new handshake, a new session and the starter select. Nothing here touches the run, which is over.
 * @module
 */

/** How long the host waits for the guest to leave the old room once the code is sent, before going on anyway */
const LEAVE_WAIT_MS = 10_000;
/** How long the guest waits for the new room's code */
const CODE_WAIT_MS = 20_000;
/** How long a closing line stays, whatever the game speed */
const LINE_MS = 2500;

/** What the title screen starts after the run; module state, so it outlives `globalScene.reset()` */
type Pending =
  | { seat: "host"; room: HostRoom; partner: string; runMode: CoopRunMode; challenges?: CoopChallenge[] }
  | { seat: "guest"; code: string };
let pending: Pending | null = null;

let answer: AgainAnswer | null = null;

/** How this client reaches the relay for the new game; a test puts stand-ins here */
export const playAgainNetwork = {
  createRoom: (url: string, seats: PlayerCount = 2): Promise<HostRoom> =>
    createRoom(url, seats === 3 ? { seats: 3 } : {}),
  host: hostAgain,
  join: joinGame,
};

/**
 * The run is over, on both clients at the same point (D4a): the partner leaving from now on is the end screen's to say, and
 * what only a run needs stops. The partner's answer has been listened for since the session began (`again-answer.ts`).
 */
export function beginRunEnd(): void {
  const session = getCoopSession();
  if (session === null) {
    return;
  }
  session.runOver = true;
  quietRunEnd();
  answer = session.link === null || session.link.isClosed ? null : listenForAgain(session.link);
}

function endAnswer(): void {
  answer?.dispose();
  answer = null;
}

/**
 * The end screen of a co-op run: "Co-op run ended", then play again with the partner or go back to the title
 * @returns Resolves when this client goes to the title screen; {@linkcode startPlayAgain} then starts the new game if both
 * wanted one
 */
export function askPlayAgain(): Promise<void> {
  const { ui } = globalScene;
  const session = getCoopSession();
  const link = session?.link ?? null;
  const partnerAnswer = answer;
  const ended = coopText("runEnded", "Co-op run ended");
  if (session === null || link === null || link.isClosed || partnerAnswer === null || partnerAnswer.gone) {
    // No partner to play again with: the line of a run's end, as before
    endAnswer();
    return new Promise(resolve => ui.showText(ended, null, () => resolve(), fixedInt(LINE_MS)));
  }
  const partner = session.partnerName;
  const couldNot = coopText("againFailed", "Could not start a new game with {{partner}}.", { partner });
  // The host of three (D40) hears each guest; the new game is with those who want it: of three, or of two
  const ofThree = session.isHost && link.players === 3;
  const guests = ["guest", "guest2"] as const;
  const answered = (): boolean =>
    guests.every(seat => partnerAnswer.wantBy.has(seat) || partnerAnswer.goneBy.has(seat));
  const wanting = (): Seat[] =>
    guests.filter(seat => partnerAnswer.wantBy.get(seat) === true && !partnerAnswer.goneBy.has(seat));

  return new Promise<void>(resolve => {
    /** This player's answer; `null` while the menu is open */
    let mine: boolean | null = null;
    /** Both want to play again: the new room is on its way */
    let agreed = false;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (message: string | null): void => {
      if (done) {
        return;
      }
      done = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      endAnswer();
      if (message === null) {
        resolve();
        return;
      }
      // As the end line used to be: read, then the title screen, with no press needed
      void ui.setMode(UiMode.MESSAGE).then(() => ui.showText(message, null, () => resolve(), fixedInt(LINE_MS)));
    };

    const menu = (text: string, options: OptionSelectItem[]): void => {
      void ui.setMode(UiMode.MESSAGE).then(() =>
        ui.showText(
          text,
          null,
          () =>
            ui.setOverlayMode(UiMode.OPTION_SELECT, {
              options,
              yOffset: 48,
              inputDelay: 500,
              blockCancelButton: true,
            }),
          null,
          false,
        ),
      );
    };

    const backToTitle: OptionSelectItem = {
      label: coopText("againNo", "Back to title"),
      handler: () => {
        choose(false);
        return true;
      },
    };

    const choose = (want: boolean): void => {
      if (done || mine !== null) {
        return;
      }
      mine = want;
      link.sendLobby({ t: "again", want });
      coopLog().info("lobby", "play again", { want, partner: partnerAnswer.want });
      if (!want) {
        finish(null);
      } else if (ofThree) {
        heard();
      } else if (partnerAnswer.want === true) {
        bothWant();
      } else {
        menu(coopText("againWaitingAnswer", "Waiting for {{partner}}…", { partner }), [backToTitle]);
      }
    };

    const bothWant = (): void => {
      agreed = true;
      void ui
        .setMode(UiMode.MESSAGE)
        .then(() =>
          ui.showText(
            coopText("againStarting", "Starting a new game with {{partner}}…", { partner }),
            null,
            undefined,
            null,
            false,
          ),
        );
      if (session.isHost) {
        const players: PlayerCount = ofThree && wanting().length === 2 ? 3 : 2;
        const names = ofThree
          ? wanting()
              .map(seat => session.nameOf(seat))
              .join(" & ")
          : partner;
        void playAgainNetwork.createRoom(getRelayUrl(), players).then(
          room => {
            if (done || (!ofThree && partnerAnswer.gone)) {
              room.cancel();
              finish(couldNot);
              return;
            }
            // The new game is the same kind of run (D39), with the same challenges (D41)
            const mode = globalScene.gameMode;
            pending = mode.isChallenge
              ? { seat: "host", room, partner: names, runMode: "challenge", challenges: challengesOn(mode) }
              : { seat: "host", room, partner: names, runMode: mode.isEndless ? "endless" : "classic" };
            link.sendLobby({ t: "againCode", code: room.identity.code });
            // The guest leaves the old room as soon as it has the code; until then that room carries it
            timer = setTimeout(() => finish(null), LEAVE_WAIT_MS);
          },
          (error: unknown) => {
            coopLog().warn("lobby", "no room to play again", { error: String(error) });
            link.sendLobby({ t: "again", want: false });
            finish(couldNot);
          },
        );
      } else {
        timer = setTimeout(() => finish(couldNot), CODE_WAIT_MS);
        heard();
      }
    };

    /** Once both want to: the guest leaving the old room (host), or the code coming in (guest), goes on to the title */
    const heardAfterAgreeing = (): void => {
      const gaveUp = partnerAnswer.gone || partnerAnswer.want === false;
      if (session.isHost) {
        // The guest leaves the old room once it has the code: the title screen goes on with the new room
        if (gaveUp) {
          finish(partnerAnswer.gone && pending !== null ? null : couldNot);
        }
      } else if (partnerAnswer.code !== null) {
        pending = { seat: "guest", code: partnerAnswer.code };
        finish(null);
      } else if (gaveUp) {
        finish(couldNot);
      }
    };

    /** What the partner said or did since the last look */
    const heard = (): void => {
      if (done) {
        return;
      }
      if (ofThree) {
        heardOfThree();
        return;
      }
      if (agreed) {
        heardAfterAgreeing();
        return;
      }
      if (partnerAnswer.gone) {
        finish(coopText("againPartnerLeft", "{{partner}} left the game.", { partner }));
      } else if (partnerAnswer.want === false) {
        finish(coopText("againPartnerDeclined", "{{partner}} went back to the title.", { partner }));
      } else if (partnerAnswer.want === true && mine === true) {
        bothWant();
      } else if (partnerAnswer.want === true && mine === null) {
        // The menu stays; its line says the partner is in
        ui.showText(
          coopText("againPartnerWants", "{{ended}}. {{partner}} wants to play again!", { ended, partner }),
          null,
          undefined,
          null,
          false,
        );
      }
    };
    /** The host of three (D40): once every guest answered (or left), a new game with those who want it */
    const heardOfThree = (): void => {
      if (agreed) {
        // they leave the old room as soon as they have the code: then the title screen goes on with the new room
        if (wanting().every(seat => partnerAnswer.goneBy.has(seat))) {
          finish(null);
        }
        return;
      }
      if (mine !== true || !answered()) {
        return;
      }
      if (wanting().length === 0) {
        finish(coopText("againNobody", "Nobody else wants to play again."));
        return;
      }
      bothWant();
    };

    partnerAnswer.onChange = heard;

    menu(
      partnerAnswer.want === true
        ? coopText("againPartnerWants", "{{ended}}. {{partner}} wants to play again!", { ended, partner })
        : ended,
      [
        {
          label: coopText("againYes", "Play again with {{partner}}", { partner }),
          handler: () => {
            choose(true);
            return true;
          },
        },
        backToTitle,
      ],
    );
  });
}

/**
 * At the title screen after a run: start the new game both players chose on the end screen
 * @returns Whether it took over the screen
 */
export function startPlayAgain(callbacks: CoopTitleCallbacks): boolean {
  const next = pending;
  pending = null;
  if (next === null) {
    return false;
  }
  if (next.seat === "host") {
    void (next.challenges === undefined
      ? playAgainNetwork.host(callbacks, next.room, next.partner, next.runMode)
      : playAgainNetwork.host(callbacks, next.room, next.partner, next.runMode, next.challenges));
  } else {
    void playAgainNetwork.join(next.code, callbacks);
  }
  return true;
}
