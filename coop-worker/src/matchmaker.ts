/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DurableObject } from "cloudflare:workers";
import {
  CLOSE_CODE_MATCH_LOST,
  MATCH_PER_ADDRESS,
  MATCH_PING,
  MATCH_PONG,
  MATCH_QUEUE_MAX,
  MATCH_STALE_MS,
} from "../../coop-server/src/relay-protocol.ts";
import { ADDRESS_HEADER, type Env, isRoomCode, rejectSocket, sendControl, upgradeResponse } from "./shared.ts";

/**
 * The matchmaking queue (D37), one Durable Object for all players: the rules of `coop-server/src/matchmaker.ts`. Its sockets
 * hibernate, so a queue where everyone waits costs nothing while nothing happens: what each player is lives in their socket's
 * attachment, and the keepalive is answered without waking it. Every socket is tagged with its build (to find a partner) and
 * its address (one address keeps at most {@linkcode MATCH_PER_ADDRESS} in the queue).
 */

interface Attachment {
  id: string;
  build: string;
  /** When it came (ms): its place in the queue, lower came first */
  place: number;
  /** `done`: matched or dropped, and closing: nothing it does counts */
  state: "waiting" | "host" | "guest" | "done";
  /** The id of the partner's socket */
  partner: string | null;
  /** When it was matched (ms) */
  pairedAt: number;
  /** Frames other than the keepalive: a client sends one code, or one "stale", at most */
  frames: number;
}

const MAX_FRAMES = 5;
const CLOSE_MATCHED = 1000;
const CLOSE_GONE = 1001;
const CLOSE_POLICY = 1008;
/**
 * A waiting socket whose keepalive (every 30 s) has not come for this long is a connection that died without closing (a
 * phone that lost its signal): it is not given a partner, and it is closed
 */
const SILENT_MS = 75_000;

function attachmentOf(socket: WebSocket): Attachment | null {
  return (socket.deserializeAttachment() as Attachment | null) ?? null;
}

function update(socket: WebSocket, attachment: Attachment): void {
  socket.serializeAttachment(attachment);
}

const addressTag = (address: string): string => `address:${address}`.slice(0, 256);

export class Matchmaker extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(MATCH_PING, MATCH_PONG));
  }

  override async fetch(request: Request): Promise<Response> {
    // The Worker checked the build (`MATCH_BUILD`) and set the address
    const build = new URL(request.url).searchParams.get("match") ?? "";
    const address = addressTag(request.headers.get(ADDRESS_HEADER) ?? "unknown");
    const live = (socket: WebSocket): boolean => attachmentOf(socket)?.state !== "done";
    if (this.ctx.getWebSockets(address).filter(live).length >= MATCH_PER_ADDRESS) {
      return rejectSocket("rateLimited");
    }
    if (this.ctx.getWebSockets().filter(live).length >= MATCH_QUEUE_MAX) {
      return rejectSocket("busy");
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [build, address]);
    const attachment: Attachment = {
      id: crypto.randomUUID(),
      build,
      place: Date.now(),
      state: "waiting",
      partner: null,
      pairedAt: 0,
      frames: 0,
    };
    update(server, attachment);
    sendControl(server, { t: "relay:queued" });
    this.pair(server, attachment);
    return upgradeResponse(client);
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const sender = attachmentOf(socket);
    if (sender === null || sender.state === "done") {
      return;
    }
    if (typeof message !== "string") {
      socket.close(CLOSE_POLICY, "binary");
      return;
    }
    // (the keepalive is answered without this: what comes here counts, a ping sent too often included)
    sender.frames++;
    update(socket, sender);
    if (sender.frames > MAX_FRAMES) {
      socket.close(CLOSE_POLICY, "too many frames");
      return;
    }
    let frame: { t?: unknown; code?: unknown } | null;
    try {
      frame = JSON.parse(message) as { t?: unknown; code?: unknown } | null;
    } catch {
      return;
    }
    if (frame?.t === "match:code") {
      this.code(socket, sender, frame.code);
    } else if (frame?.t === "match:stale") {
      this.stale(socket, sender);
    }
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    try {
      socket.close(); // completes the closing handshake
    } catch {
      // already closed
    }
    this.left(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    this.left(socket);
  }

  /** A matched host's room code: it goes to the guest, and both leave the queue */
  private code(socket: WebSocket, host: Attachment, code: unknown): void {
    const guestSocket = host.partner === null ? undefined : this.socketOf(host.build, host.partner);
    const guest = guestSocket === undefined ? null : attachmentOf(guestSocket);
    if (
      host.state !== "host"
      || guestSocket === undefined
      || guest === null
      || typeof code !== "string"
      || !isRoomCode(code)
    ) {
      return;
    }
    if (guestSocket.readyState !== WebSocket.READY_STATE_OPEN) {
      // The guest is leaving: the code would go nowhere, and the host searches again
      this.left(guestSocket);
      return;
    }
    sendControl(guestSocket, { t: "relay:matchGuest", code });
    update(guestSocket, { ...guest, state: "done" });
    update(socket, { ...host, state: "done" });
    socket.close(CLOSE_MATCHED, "matched");
    guestSocket.close(CLOSE_MATCHED, "matched");
  }

  /** A matched guest whose host's code has not come: a host that had its time is dropped, and the guest is paired again */
  private stale(socket: WebSocket, guest: Attachment): void {
    const hostSocket = guest.partner === null ? undefined : this.socketOf(guest.build, guest.partner);
    if (guest.state !== "guest" || Date.now() - guest.pairedAt < MATCH_STALE_MS) {
      return;
    }
    if (hostSocket !== undefined) {
      const host = attachmentOf(hostSocket);
      if (host !== null) {
        update(hostSocket, { ...host, state: "done" });
      }
      hostSocket.close(CLOSE_CODE_MATCH_LOST, "no code");
    }
    this.requeue(socket, guest);
  }

  /** A player left the queue: a guest left by its host goes back in, in its old place; a host left by its guest searches again */
  private left(socket: WebSocket): void {
    const attachment = attachmentOf(socket);
    if (attachment === null || attachment.state === "done") {
      return;
    }
    update(socket, { ...attachment, state: "done" });
    const partnerSocket = attachment.partner === null ? undefined : this.socketOf(attachment.build, attachment.partner);
    const partner = partnerSocket === undefined ? null : attachmentOf(partnerSocket);
    if (partnerSocket === undefined || partner === null || partner.state === "done") {
      return;
    }
    if (partner.state === "guest") {
      this.requeue(partnerSocket, partner);
    } else {
      // A host whose guest left may be making its room already: nobody will come to it, so it searches again
      update(partnerSocket, { ...partner, state: "done" });
      sendControl(partnerSocket, { t: "relay:matchLost" });
      partnerSocket.close(CLOSE_CODE_MATCH_LOST, "partner left");
    }
  }

  /** A guest whose host is gone: back in the queue in its old place, and paired again if it can be */
  private requeue(socket: WebSocket, guest: Attachment): void {
    const waiting: Attachment = { ...guest, state: "waiting", partner: null };
    update(socket, waiting);
    sendControl(socket, { t: "relay:matchLost" });
    this.pair(socket, waiting);
  }

  /** Match this waiting player with the one of their build who came first and is still there, if any */
  private pair(socket: WebSocket, attachment: Attachment): void {
    if (socket.readyState !== WebSocket.READY_STATE_OPEN) {
      return;
    }
    const now = Date.now();
    let other: { socket: WebSocket; attachment: Attachment } | null = null;
    for (const candidate of this.ctx.getWebSockets(attachment.build)) {
      const state = attachmentOf(candidate);
      if (candidate === socket || state === null || state.state !== "waiting") {
        continue;
      }
      if (candidate.readyState !== WebSocket.READY_STATE_OPEN || this.silent(candidate, state, now)) {
        update(candidate, { ...state, state: "done" });
        candidate.close(CLOSE_GONE, "silent");
        continue;
      }
      if (other === null || state.place < other.attachment.place) {
        other = { socket: candidate, attachment: state };
      }
    }
    if (other === null) {
      return;
    }
    // The one who waited longer creates the room
    const mine = { socket, attachment };
    const [host, guest] = other.attachment.place <= attachment.place ? [other, mine] : [mine, other];
    update(host.socket, { ...host.attachment, state: "host", partner: guest.attachment.id, pairedAt: now });
    update(guest.socket, { ...guest.attachment, state: "guest", partner: host.attachment.id, pairedAt: now });
    sendControl(host.socket, { t: "relay:matchHost" });
    sendControl(guest.socket, { t: "relay:matched" });
  }

  /** Whether a waiting socket has not said it is alive (its keepalive, or its coming) for {@linkcode SILENT_MS} */
  private silent(socket: WebSocket, attachment: Attachment, now: number): boolean {
    const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0;
    return now - Math.max(lastPing, attachment.place) > SILENT_MS;
  }

  private socketOf(build: string, id: string): WebSocket | undefined {
    return this.ctx.getWebSockets(build).find(socket => attachmentOf(socket)?.id === id);
  }
}
