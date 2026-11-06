/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { CoopLink } from "#coop/link/link";
import type { LobbyMessage, Seat } from "#coop/protocol";

/**
 * What the partner answered on the end screen of a run (D35), heard from the start of the session on: a partner whose game
 * got to the end first can answer before this client's run has ended. One per link; `play-again.ts` reads it.
 * @module
 */

export class AgainAnswer {
  /** Whether they want to play again; `null` until they said */
  public want: boolean | null = null;
  /** The new room's code (from the host) */
  public code: string | null = null;
  /** They left the room for good, or the room is gone */
  public gone = false;
  public onChange: (() => void) | null = null;
  /** The host of three (D40): each guest's answer, and the guests who left */
  public readonly wantBy = new Map<Seat, boolean>();
  public readonly goneBy = new Set<Seat>();
  private readonly unsubscribes: (() => void)[];

  constructor(private readonly link: CoopLink) {
    this.unsubscribes = [
      link.onLobby((message, from) => this.receive(message, from)),
      link.onPresence((seat, present) => {
        // A guest of three who left does not come back to the end screen (D40)
        if (!present && link.seat === "host") {
          this.goneBy.add(seat);
          this.onChange?.();
        }
      }),
      link.onEnd(end => {
        // A dropped socket may come back (`peerLeft`); a partner who left, or a room that closed, does not
        if (end !== "peerLeft") {
          this.gone = true;
          this.onChange?.();
        }
      }),
    ];
  }

  private receive(message: LobbyMessage, from: Seat): void {
    if (message.t === "again") {
      if (this.link.players === 3) {
        this.wantBy.set(from, message.want);
        // a guest of three answers to the host only
        if (this.link.seat !== "host" && from !== "host") {
          return;
        }
      }
      this.want = message.want;
    } else if (message.t === "againCode") {
      this.code = message.code;
    } else {
      return;
    }
    this.onChange?.();
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe();
    }
    this.onChange = null;
  }
}

const answers = new WeakMap<CoopLink, AgainAnswer>();

/** Listen for the partner's answer on this link, from now on (once per link) */
export function listenForAgain(link: CoopLink): AgainAnswer {
  let answer = answers.get(link);
  if (answer === undefined) {
    answer = new AgainAnswer(link);
    answers.set(link, answer);
  }
  return answer;
}
