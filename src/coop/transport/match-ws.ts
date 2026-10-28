/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { RelayError, type RelayErrorReason, type WebSocketFactory } from "#coop/transport/relay-ws";

/**
 * The client side of matchmaking (D37): one WebSocket to the relay's queue, `?match=<build>` (the messages of
 * `coop-server/src/relay-protocol.ts`, `MatchControlMessage`; `test/coop/relay-stack.test.ts` runs this against the real
 * server). Once matched, the host creates a room as usual and sends its code here; the guest gets that code. The game then
 * goes through the room, as for players who share a code.
 * @module
 */

/** What a match made of this player */
export type MatchRole = { role: "host"; sendCode(code: string): void } | { role: "guest"; code: string };

/** Where the search is: in the queue, or matched and waiting for the host's room */
export type MatchStatus = "waiting" | "matched";

export interface MatchSearch {
  /** Resolves when matched; rejects with a {@linkcode RelayError} if the relay refuses or the connection is lost */
  readonly found: Promise<MatchRole>;
  onStatus(listener: (status: MatchStatus) => void): void;
  /** Leave the queue (a host also does once its room exists and the code is sent, or when it could not make one) */
  cancel(): void;
}

export interface MatchOptions {
  factory?: WebSocketFactory;
  /** How often the connection says it is alive while it waits. Default 30 s. */
  keepaliveMs?: number;
  /** How long a matched guest waits for the host's room before it goes back in the queue. Default 20 s. */
  guestWaitMs?: number;
}

const MATCH_PING = '{"t":"match:ping"}';
const WS_OPEN = 1;
const defaultFactory: WebSocketFactory = url => new WebSocket(url) as unknown as ReturnType<WebSocketFactory>;

/** Wait in the queue of this build at the relay `baseUrl` (the same address as for rooms) */
export function findMatch(baseUrl: string, build: string, options: MatchOptions = {}): MatchSearch {
  const factory = options.factory ?? defaultFactory;
  const url = `${baseUrl.replace(/\/+$/, "")}/?${new URLSearchParams({ match: build }).toString()}`;
  const listeners = new Set<(status: MatchStatus) => void>();
  let resolveFound!: (role: MatchRole) => void;
  let rejectFound!: (error: RelayError) => void;
  const found = new Promise<MatchRole>((resolve, reject) => {
    resolveFound = resolve;
    rejectFound = reject;
  });
  found.catch(() => {});
  let settled = false;
  let cancelled = false;
  let socket: ReturnType<WebSocketFactory> | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let guestWait: ReturnType<typeof setTimeout> | null = null;

  const status = (value: MatchStatus): void => {
    for (const listener of [...listeners]) {
      listener(value);
    }
  };
  const stopTimers = (): void => {
    if (keepalive !== null) {
      clearInterval(keepalive);
      keepalive = null;
    }
    if (guestWait !== null) {
      clearTimeout(guestWait);
      guestWait = null;
    }
  };
  const fail = (reason: RelayErrorReason | "closed"): void => {
    stopTimers();
    if (!settled && !cancelled) {
      settled = true;
      rejectFound(new RelayError(reason));
    }
  };

  const connect = (): void => {
    const current = factory(url);
    socket = current;
    current.addEventListener("open", () => {
      keepalive = setInterval(() => {
        if (current.readyState === WS_OPEN) {
          current.send(MATCH_PING);
        }
      }, options.keepaliveMs ?? 30_000);
    });
    current.addEventListener("message", event => {
      if (socket !== current || typeof event.data !== "string") {
        return;
      }
      let message: { t?: unknown; code?: unknown; reason?: unknown };
      try {
        message = JSON.parse(event.data) as typeof message;
      } catch {
        return;
      }
      switch (message.t) {
        case "relay:matchHost":
          if (!settled) {
            settled = true;
            status("matched");
            resolveFound({
              role: "host",
              sendCode: code => {
                if (current.readyState === WS_OPEN) {
                  current.send(JSON.stringify({ t: "match:code", code }));
                }
              },
            });
          }
          break;
        case "relay:matched":
          status("matched");
          // A host that never makes its room (its page froze) must not hold this player: back in the queue
          guestWait = setTimeout(() => {
            if (!settled && !cancelled && socket === current) {
              stopTimers();
              socket = null;
              current.close(1000, "requeue");
              status("waiting");
              connect();
            }
          }, options.guestWaitMs ?? 20_000);
          break;
        case "relay:matchLost":
          if (guestWait !== null) {
            clearTimeout(guestWait);
            guestWait = null;
          }
          status("waiting");
          break;
        case "relay:matchGuest":
          if (!settled && typeof message.code === "string") {
            settled = true;
            stopTimers();
            resolveFound({ role: "guest", code: message.code });
          }
          break;
        case "relay:error":
          fail(typeof message.reason === "string" ? (message.reason as RelayErrorReason) : "closed");
          break;
        default:
          break; // queued, pong
      }
    });
    current.addEventListener("close", () => {
      if (socket === current) {
        fail("closed");
      }
    });
    current.addEventListener("error", () => {
      // The close event follows
    });
  };

  connect();
  return {
    found,
    onStatus(listener) {
      listeners.add(listener);
    },
    cancel() {
      cancelled = true;
      stopTimers();
      const current = socket;
      socket = null;
      current?.close(1000, "cancelled");
    },
  };
}
