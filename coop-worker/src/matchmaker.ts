/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DurableObject } from "cloudflare:workers";
import { MATCH_PING, MATCH_PONG, MATCH_QUEUE_MAX } from "../../coop-server/src/relay-protocol.ts";
import { type Env, isRoomCode, rejectSocket, sendControl, upgradeResponse } from "./shared.ts";

/**
 * The matchmaking queue (D37), one Durable Object for all players: the rules of `coop-server/src/matchmaker.ts`. Its sockets
 * hibernate, so a queue where everyone waits costs nothing while nothing happens: what each player is lives in their socket's
 * attachment, and the keepalive is answered without waking it.
 */

interface Attachment {
  id: string;
  build: string;
  /** Place in the queue: lower came first */
  place: number;
  /** `done`: matched and closing, nothing it does counts */
  state: "waiting" | "host" | "guest" | "done";
  /** The id of the partner's socket */
  partner: string | null;
  /** Frames other than pings: a client sends one code at most */
  frames: number;
}

const MAX_FRAMES = 5;
const CLOSE_MATCHED = 1000;
const CLOSE_POLICY = 1008;

function attachmentOf(socket: WebSocket): Attachment | null {
  return (socket.deserializeAttachment() as Attachment | null) ?? null;
}

function update(socket: WebSocket, attachment: Attachment): void {
  socket.serializeAttachment(attachment);
}

export class Matchmaker extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(MATCH_PING, MATCH_PONG));
  }

  override async fetch(request: Request): Promise<Response> {
    // The Worker checked it (`MATCH_BUILD`)
    const build = new URL(request.url).searchParams.get("match") ?? "";
    if (this.ctx.getWebSockets().length >= MATCH_QUEUE_MAX) {
      return rejectSocket("busy");
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [build]);
    const attachment: Attachment = {
      id: crypto.randomUUID(),
      build,
      place: Date.now(),
      state: "waiting",
      partner: null,
      frames: 0,
    };
    update(server, attachment);
    sendControl(server, { t: "relay:queued" });
    this.pair(server, attachment);
    return upgradeResponse(client);
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const host = attachmentOf(socket);
    if (host === null || typeof message !== "string" || message === MATCH_PING) {
      return;
    }
    host.frames++;
    update(socket, host);
    if (host.frames > MAX_FRAMES) {
      socket.close(CLOSE_POLICY, "too many frames");
      return;
    }
    let frame: { t?: unknown; code?: unknown } | null;
    try {
      frame = JSON.parse(message) as { t?: unknown; code?: unknown } | null;
    } catch {
      return;
    }
    const code = frame?.t === "match:code" ? frame.code : null;
    const guestSocket = host.partner === null ? undefined : this.socketOf(host.build, host.partner);
    if (host.state !== "host" || guestSocket === undefined || typeof code !== "string" || !isRoomCode(code)) {
      return;
    }
    sendControl(guestSocket, { t: "relay:matchGuest", code });
    const guest = attachmentOf(guestSocket);
    if (guest !== null) {
      update(guestSocket, { ...guest, state: "done" });
    }
    update(socket, { ...host, state: "done" });
    socket.close(CLOSE_MATCHED, "matched");
    guestSocket.close(CLOSE_MATCHED, "matched");
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

  /** A player left the queue: a partner who was waiting for their room goes back in, in their old place */
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
    const waiting: Attachment = { ...partner, state: "waiting", partner: null };
    update(partnerSocket, waiting);
    sendControl(partnerSocket, { t: "relay:matchLost" });
    this.pair(partnerSocket, waiting);
  }

  /** Match this waiting player with the one of their build who came first, if any */
  private pair(socket: WebSocket, attachment: Attachment): void {
    let other: { socket: WebSocket; attachment: Attachment } | null = null;
    for (const candidate of this.ctx.getWebSockets(attachment.build)) {
      const state = attachmentOf(candidate);
      if (
        candidate !== socket
        && state !== null
        && state.state === "waiting"
        && candidate.readyState === WebSocket.READY_STATE_OPEN
        && (other === null || state.place < other.attachment.place)
      ) {
        other = { socket: candidate, attachment: state };
      }
    }
    if (other === null) {
      return;
    }
    // The one who waited longer creates the room
    const mine = { socket, attachment };
    const [host, guest] = other.attachment.place <= attachment.place ? [other, mine] : [mine, other];
    update(host.socket, { ...host.attachment, state: "host", partner: guest.attachment.id });
    update(guest.socket, { ...guest.attachment, state: "guest", partner: host.attachment.id });
    sendControl(host.socket, { t: "relay:matchHost" });
    sendControl(guest.socket, { t: "relay:matched" });
  }

  private socketOf(build: string, id: string): WebSocket | undefined {
    return this.ctx.getWebSockets(build).find(socket => attachmentOf(socket)?.id === id);
  }
}
