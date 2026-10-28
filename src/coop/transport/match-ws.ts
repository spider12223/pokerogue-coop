/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { RelayError, type RelayErrorReason, type WebSocketFactory } from "#coop/transport/relay-ws";

/**
 * The client side of matchmaking (D37): one WebSocket to the relay's queue, `?match=<build>` (the messages of
 * `coop-server/src/relay-protocol.ts`, `MatchControlMessage`; `test/coop/relay-stack.test.ts` runs this against the real
 * server). Once matched, the host creates a room as usual and sends its code here; the relay closes the connection
 * ("matched") once the code went to the guest. The guest gets that code. The game then goes through the room, as for players
 * who share a code.
 * @module
 */

/**
 * What a match made of this player. A host's `sendCode` says whether the code reached the partner: `false` if the partner
 * left first (search again: nobody will come to that room).
 */
export type MatchRole = { role: "host"; sendCode(code: string): Promise<boolean> } | { role: "guest"; code: string };

/** Where the search is: in the queue, or matched and waiting for the host's room */
export type MatchStatus = "waiting" | "matched";

export interface MatchSearch {
  /** Resolves when matched; rejects with a {@linkcode RelayError} if the relay refuses or cannot be reached */
  readonly found: Promise<MatchRole>;
  onStatus(listener: (status: MatchStatus) => void): void;
  /** Leave the queue */
  cancel(): void;
}

export interface MatchOptions {
  factory?: WebSocketFactory;
  /** How often the connection says it is alive while it waits. Default 30 s. */
  keepaliveMs?: number;
  /** How long a matched guest waits for the host's room before it tells the relay. Default 15 s. */
  guestWaitMs?: number;
  /** How long a host waits for the relay to take its code. Default 10 s. */
  codeWaitMs?: number;
  /** How often a dropped connection is opened again while it waits (a network blip, a relay that restarted). Default 3. */
  reconnects?: number;
}

const MATCH_PING = '{"t":"match:ping"}';
const WS_OPEN = 1;
/** The relay closes both queue connections with this once the code went */
const CLOSE_MATCHED = 1000;
const defaultFactory: WebSocketFactory = url => new WebSocket(url) as unknown as ReturnType<WebSocketFactory>;

/** Wait in the queue of this build at the relay `baseUrl` (the same address as for rooms) */
export function findMatch(baseUrl: string, build: string, options: MatchOptions = {}): MatchSearch {
  const factory = options.factory ?? defaultFactory;
  const url = `${baseUrl.replace(/\/+$/, "")}/?${new URLSearchParams({ match: build }).toString()}`;
  const guestWaitMs = options.guestWaitMs ?? 15_000;
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
  let reconnectsLeft = options.reconnects ?? 3;
  let socket: ReturnType<WebSocketFactory> | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let keepalive: ReturnType<typeof setInterval> | null = null;
  /** A host's code: whether the relay took it, once it is known */
  let delivered: ((ok: boolean) => void) | null = null;
  let hostOutcome: boolean | null = null;

  const later = (ms: number, action: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      action();
    }, ms);
    timers.add(timer);
  };
  /** The waits, not the keepalive: a player back in the queue still says it is alive */
  const clearWaits = (): void => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
  };
  const stopTimers = (): void => {
    clearWaits();
    if (keepalive !== null) {
      clearInterval(keepalive);
      keepalive = null;
    }
  };
  const status = (value: MatchStatus): void => {
    if (!cancelled) {
      for (const listener of [...listeners]) {
        listener(value);
      }
    }
  };
  const fail = (reason: RelayErrorReason | "closed"): void => {
    stopTimers();
    if (!settled && !cancelled) {
      settled = true;
      rejectFound(new RelayError(reason));
    }
  };
  /** A host's outcome: the code went, or the partner left first */
  const hostDone = (ok: boolean): void => {
    if (hostOutcome === null) {
      hostOutcome = ok;
      delivered?.(ok);
    }
  };

  const connect = (): void => {
    const current = factory(url);
    socket = current;
    let refused = false;
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
                if (hostOutcome !== null) {
                  return Promise.resolve(hostOutcome);
                }
                if (current.readyState !== WS_OPEN) {
                  hostDone(false);
                  return Promise.resolve(false);
                }
                current.send(JSON.stringify({ t: "match:code", code }));
                later(options.codeWaitMs ?? 10_000, () => hostDone(false));
                return new Promise<boolean>(resolve => {
                  delivered = resolve;
                });
              },
            });
          }
          break;
        case "relay:matched":
          status("matched");
          // The host's code does not come: the relay drops a host that had its time, and pairs this player again; a relay
          // that does not answer either is a dead connection, opened again
          later(guestWaitMs, () => {
            if (!settled && socket === current && current.readyState === WS_OPEN) {
              current.send(JSON.stringify({ t: "match:stale" }));
              later(guestWaitMs, () => {
                if (!settled && socket === current) {
                  current.close(1000, "requeue");
                }
              });
            }
          });
          break;
        case "relay:matchLost":
          if (settled) {
            // A host whose guest left: the relay closes this connection next
            hostDone(false);
          } else {
            clearWaits();
            status("waiting");
          }
          break;
        case "relay:matchGuest":
          if (!settled && typeof message.code === "string") {
            settled = true;
            stopTimers();
            resolveFound({ role: "guest", code: message.code });
          }
          break;
        case "relay:error":
          refused = true;
          fail(typeof message.reason === "string" ? (message.reason as RelayErrorReason) : "closed");
          break;
        default:
          break; // queued, pong
      }
    });
    current.addEventListener("close", event => {
      if (socket !== current) {
        return;
      }
      if (settled) {
        // A host: the relay closes once the code went ("matched"); any other close is a partner who left
        hostDone(event.code === CLOSE_MATCHED);
        return;
      }
      if (cancelled || refused) {
        return;
      }
      if (reconnectsLeft > 0) {
        // A blip or a relay that restarted: in the queue again, at its end
        reconnectsLeft--;
        stopTimers();
        status("waiting");
        later(1000 * (4 - reconnectsLeft), () => {
          if (!cancelled && !settled) {
            connect();
          }
        });
        return;
      }
      fail("closed");
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
      listeners.clear();
      const current = socket;
      socket = null;
      current?.close(1000, "cancelled");
      hostDone(false);
    },
  };
}
