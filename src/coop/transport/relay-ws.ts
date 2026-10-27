/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Concept (WebSocket transport through a pairing relay) from SunghoLee98/pokerogue
 * `src/coop/relay-websocket-transport.ts` (AGPL-3.0-only); the seat-token rejoin flow is new.
 */

import type { Seat } from "#coop/protocol";
import type { CloseInfo, RawTransport, Unsubscribe } from "#coop/transport/transport";

/**
 * Client side of the relay protocol declared in `coop-server/src/relay-protocol.ts`. The two are kept in sync by
 * `test/coop/relay-stack.test.ts`, which runs this client against the real server.
 */
export type RelayErrorReason = "notFound" | "full" | "badRequest" | "badToken" | "busy" | "rateLimited";

export type RelayEvent =
  | { t: "relay:paired" }
  /** `holdMs`: how long the partner's seat is kept once this player is gone too; `null`: for as long as this player stays */
  | { t: "relay:peerLeft"; holdMs: number | null }
  | { t: "relay:peerBack" }
  | { t: "relay:peerGone" }
  | { t: "relay:closed"; reason: "hostGone" | "partnerLeft" | "idle" };

type RelayControlMessage =
  | { t: "relay:created"; code: string; seat: "host"; token: string }
  | { t: "relay:joined"; code: string; seat: "guest"; token: string }
  | { t: "relay:rejoined"; code: string; seat: Seat; peerPresent: boolean }
  | { t: "relay:error"; reason: RelayErrorReason }
  | RelayEvent;

/** How to enter the relay: create a room as host, join one by code as guest, or take a seat back with its token. */
export type RelayConnectRequest =
  | { mode: "create" }
  | { mode: "join"; code: string }
  | { mode: "rejoin"; code: string; seat: Seat; token: string };

/** Who the relay says we are. Keep `token`: it is the only way back into the seat after a dropped connection. */
export interface RelayIdentity {
  code: string;
  seat: Seat;
  token: string;
  /** Rejoin only: whether the partner is connected right now */
  peerPresent?: boolean;
}

export class RelayError extends Error {
  readonly reason: RelayErrorReason | "closed";

  constructor(reason: RelayErrorReason | "closed") {
    super(`relay: ${reason}`);
    this.name = "RelayError";
    this.reason = reason;
  }
}

/** The part of the WHATWG `WebSocket` this transport uses (browsers, Node >= 22 and `ws` all fit). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const WS_OPEN = 1;

/** The close code that ends a room (`CLOSE_CODE_LEAVE` of the relay's protocol) */
export const CLOSE_CODE_LEAVE = 4003;

const defaultFactory: WebSocketFactory = url => new WebSocket(url) as unknown as WebSocketLike;

function buildUrl(baseUrl: string, request: RelayConnectRequest): string {
  const params = new URLSearchParams();
  if (request.mode === "create") {
    params.set("role", "host");
  } else {
    params.set("code", request.code);
    if (request.mode === "rejoin") {
      params.set("seat", request.seat);
      params.set("token", request.token);
    }
  }
  return `${baseUrl.replace(/\/+$/, "")}/?${params.toString()}`;
}

/**
 * A {@linkcode RawTransport} over one WebSocket to the relay. Frames the relay did not generate are the partner's.
 * It does not reconnect by itself: when {@linkcode onClose} fires, connect again with
 * `{ mode: "rejoin", code, seat, token }` and hand the new transport to {@linkcode ReliableTransport.attach}.
 */
export class RelayWsTransport implements RawTransport {
  /** Resolves when the relay confirmed the room/seat; rejects with {@linkcode RelayError}. */
  readonly ready: Promise<RelayIdentity>;

  private readonly socket: WebSocketLike;
  private readonly frameListeners = new Set<(frame: string) => void>();
  private readonly closeListeners = new Set<(info: CloseInfo) => void>();
  private readonly eventListeners = new Set<(event: RelayEvent) => void>();
  private settled = false;
  private resolveReady!: (identity: RelayIdentity) => void;
  private rejectReady!: (error: RelayError) => void;

  private constructor(baseUrl: string, request: RelayConnectRequest, factory: WebSocketFactory) {
    this.ready = new Promise<RelayIdentity>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A caller that only uses the frames never awaits `ready`: do not turn its rejection into an unhandled one.
    this.ready.catch(() => {});

    this.socket = factory(buildUrl(baseUrl, request));
    this.socket.addEventListener("message", event => {
      if (typeof event.data === "string") {
        this.receive(event.data, request);
      }
    });
    this.socket.addEventListener("close", event => {
      this.fail(new RelayError("closed"));
      const info: CloseInfo = { code: event.code };
      if (event.reason) {
        info.reason = event.reason;
      }
      for (const listener of [...this.closeListeners]) {
        listener(info);
      }
    });
    this.socket.addEventListener("error", () => {
      // The close event follows and carries the outcome.
    });
  }

  /** Open a connection to the relay at `baseUrl` (for example `ws://localhost:8787`). */
  static connect(
    baseUrl: string,
    request: RelayConnectRequest,
    factory: WebSocketFactory = defaultFactory,
  ): RelayWsTransport {
    return new RelayWsTransport(baseUrl, request, factory);
  }

  get isOpen(): boolean {
    return this.socket.readyState === WS_OPEN;
  }

  send(frame: string): void {
    if (!this.isOpen) {
      throw new Error("relay connection is not open");
    }
    this.socket.send(frame);
  }

  onFrame(listener: (frame: string) => void): Unsubscribe {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  onClose(listener: (info: CloseInfo) => void): Unsubscribe {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  /** Relay notices: the partner left, came back, or the room closed. */
  onRelayEvent(listener: (event: RelayEvent) => void): Unsubscribe {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  /** Leave for good ("End session", D20): the relay closes the room at once and tells the partner */
  leave(): void {
    this.socket.close(CLOSE_CODE_LEAVE, "leave");
  }

  private receive(text: string, request: RelayConnectRequest): void {
    // Control frames always start like this (the relay writes `t` first); the relay drops client frames that do.
    if (!text.startsWith('{"t":"relay:')) {
      for (const listener of [...this.frameListeners]) {
        listener(text);
      }
      return;
    }
    let message: RelayControlMessage;
    try {
      message = JSON.parse(text) as RelayControlMessage;
    } catch {
      return;
    }
    switch (message.t) {
      case "relay:created":
      case "relay:joined":
        this.settle({ code: message.code, seat: message.seat, token: message.token });
        break;
      case "relay:rejoined":
        if (request.mode === "rejoin") {
          this.settle({
            code: message.code,
            seat: message.seat,
            token: request.token,
            peerPresent: message.peerPresent,
          });
        }
        break;
      case "relay:error":
        this.fail(new RelayError(message.reason));
        break;
      default:
        for (const listener of [...this.eventListeners]) {
          listener(message);
        }
    }
  }

  private settle(identity: RelayIdentity): void {
    if (!this.settled) {
      this.settled = true;
      this.resolveReady(identity);
    }
  }

  private fail(error: RelayError): void {
    if (!this.settled) {
      this.settled = true;
      this.rejectReady(error);
    }
  }
}
