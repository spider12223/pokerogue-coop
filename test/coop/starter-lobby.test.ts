/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { AccountSnapshot } from "#coop/account-snapshot";
import type { LinkEnd } from "#coop/link";
import type { CoopStarter, LobbyMessage, StartPayload } from "#coop/protocol";
import { StarterLobby } from "#coop/starter-lobby";
import { describe, expect, it } from "vitest";

/** The starter select's lobby over a link that drops and comes back (D20) */

const SNAPSHOT: AccountSnapshot = {
  trainerId: 1,
  secretId: 2,
  unlocked: { eviolite: false, miniBlackHole: false },
  caught: {},
  eggMoves: {},
};

const STARTER: CoopStarter = {
  speciesId: 1,
  shiny: false,
  variant: 0,
  formIndex: 0,
  abilityIndex: 0,
  passive: false,
  nature: 0,
  pokerus: false,
  ivs: [31, 31, 31, 31, 31, 31],
};

/** The lobby's side of a link, driven by the test */
function fakeLink() {
  const sent: LobbyMessage[] = [];
  const starts: StartPayload[] = [];
  let lobby: ((message: LobbyMessage) => void) | null = null;
  let end: ((end: LinkEnd) => void) | null = null;
  let change: (() => void) | null = null;
  const link = {
    partnerPresent: true,
    sendLobby: (message: LobbyMessage) => void sent.push(message),
    onLobby: (listener: (message: LobbyMessage) => void) => {
      lobby = listener;
      return () => undefined;
    },
    sendStart: (start: StartPayload) => void starts.push(start),
    onStart: () => () => undefined,
    onEnd: (listener: (end: LinkEnd) => void) => {
      end = listener;
      return () => undefined;
    },
    onChange: (listener: () => void) => {
      change = listener;
      return () => undefined;
    },
  };
  return {
    link,
    sent,
    starts,
    receive: (message: LobbyMessage) => lobby?.(message),
    drop: (reason: LinkEnd) => {
      link.partnerPresent = false;
      end?.(reason);
    },
    back: () => {
      link.partnerPresent = true;
      change?.();
    },
  };
}

function lobbyOn(seat: "host" | "guest", fake: ReturnType<typeof fakeLink>): StarterLobby {
  return new StarterLobby({
    seat,
    link: fake.link as never,
    sharedLimit: 15,
    makeRunSeed: () => "seed",
    localEvents: () => [],
  });
}

describe("Co-op: a reset of the shared points (D32)", () => {
  it("is ignored by a guest that confirmed again since: it answers an older ready", () => {
    const fake = fakeLink();
    const lobby = lobbyOn("guest", fake);
    lobby.setReady([STARTER], 9, SNAPSHOT);
    // the guest takes it back and confirms a cheaper party before the host's answer to the first comes
    lobby.cancelReady();
    lobby.setReady([STARTER], 3, SNAPSHOT);
    fake.receive({ t: "reset", gen: 1 });
    expect(lobby.localReady).toBe(true);
    expect(lobby.wasReset).toBe(false);
    // the answer to this ready does count
    fake.receive({ t: "reset", gen: 2 });
    expect(lobby.localReady).toBe(false);
    expect(lobby.wasReset).toBe(true);
  });
});

describe("Co-op: the starter select when a connection drops (D20)", () => {
  it("a drop that keeps the seat is not the end: the partner is away, and the lobby goes on when they are back", () => {
    const fake = fakeLink();
    const lobby = lobbyOn("guest", fake);
    fake.drop("peerLeft");
    expect(lobby.closed).toBe(false);
    expect(lobby.away).toBe(true);
    fake.back();
    expect(lobby.away).toBe(false);
    expect(lobby.setReady([STARTER], 3, SNAPSHOT)).toBe(true);
  });

  it("leaving, or the room closing, is the end", () => {
    for (const reason of ["peerGone", "closed"] as const) {
      const fake = fakeLink();
      const lobby = lobbyOn("guest", fake);
      fake.drop(reason);
      expect(lobby.closed, reason).toBe(true);
    }
  });

  it("sends the picks and the ready again when the partner is back: what was sent meanwhile may be lost", () => {
    const fake = fakeLink();
    const lobby = lobbyOn("guest", fake);
    lobby.setPicks([STARTER], 3);
    fake.drop("peerLeft");
    fake.back();
    expect(fake.sent.at(-1)).toEqual({ t: "picks", picks: [STARTER], cost: 3 });

    lobby.setReady([STARTER], 3, SNAPSHOT);
    fake.drop("peerLeft");
    fake.back();
    expect(fake.sent.at(-1)).toMatchObject({ t: "ready", starters: [STARTER], cost: 3 });
  });

  it("host: sends the start again when the partner is back, in case that is what was lost", () => {
    const fake = fakeLink();
    const lobby = lobbyOn("host", fake);
    fake.receive({ t: "ready", starters: [STARTER], cost: 3, snapshot: SNAPSHOT, events: [], gen: 1 });
    lobby.setReady([STARTER], 3, SNAPSHOT);
    expect(fake.starts).toHaveLength(1);
    fake.drop("peerLeft");
    fake.back();
    expect(fake.starts).toHaveLength(2);
    expect(fake.starts[1]).toEqual(fake.starts[0]);
  });
});
