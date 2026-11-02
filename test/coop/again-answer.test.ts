/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { AgainAnswer } from "#coop/again-answer";
import type { CoopLink } from "#coop/link";
import type { LobbyMessage, Seat } from "#coop/protocol";
import { describe, expect, it } from "vitest";

/** The end screen's answers (DECISIONS D35) in a game of three (D40): the host hears each guest; a guest hears the host */

function fakeLink(seat: Seat) {
  let lobby: ((message: LobbyMessage, from: Seat) => void) | null = null;
  let presence: ((seat: Seat, present: boolean) => void) | null = null;
  const link = {
    seat,
    players: 3,
    onLobby: (listener: typeof lobby) => {
      lobby = listener;
      return () => undefined;
    },
    onPresence: (listener: typeof presence) => {
      presence = listener;
      return () => undefined;
    },
    onEnd: () => () => undefined,
  } as unknown as CoopLink;
  return {
    link,
    say: (message: LobbyMessage, from: Seat) => lobby!(message, from),
    leaves: (who: Seat) => presence!(who, false),
  };
}

describe("Play again in a game of three (D40)", () => {
  it("the host hears each guest's answer, and who left", () => {
    const { link, say, leaves } = fakeLink("host");
    const answer = new AgainAnswer(link);
    say({ t: "again", want: true }, "guest2");
    say({ t: "again", want: false }, "guest");
    expect([...answer.wantBy]).toEqual([
      ["guest2", true],
      ["guest", false],
    ]);
    leaves("guest2");
    expect([...answer.goneBy]).toEqual(["guest2"]);
  });

  it("a guest goes by the host's answer only", () => {
    const { link, say } = fakeLink("guest");
    const answer = new AgainAnswer(link);
    say({ t: "again", want: false }, "guest2");
    expect(answer.want).toBeNull();
    say({ t: "again", want: true }, "host");
    expect(answer.want).toBe(true);
  });
});
