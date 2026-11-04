/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DurableObject } from "cloudflare:workers";
import {
  CLOSE_CODE_LEAVE,
  CLOSE_CODE_POLICY,
  CLOSE_CODE_REPLACED,
  CLOSE_CODE_ROOM_CLOSED,
  parseRouted,
  type RelayClosedReason,
  type RoomSeats,
  roomSeats,
  routedFrame,
  type Seat,
} from "../../coop-server/src/relay-protocol.ts";
import {
  ACTION_HEADER,
  CODE_HEADER,
  DEFAULTS,
  type Env,
  envNumber,
  isControlFrame,
  isSeat,
  newToken,
  otherSeat,
  rejectSocket,
  sendControl,
  TokenBucket,
  tokensMatch,
  upgradeResponse,
} from "./shared.ts";
import { countRoom, noteFilled } from "./stats.ts";

/**
 * One co-op room on Cloudflare: the seats, tokens and holds of `coop-server`'s `RoomRegistry` and the forwarding of its
 * `relay-server.ts`, for one room code (DECISIONS D20, D22, D23). The protocol is the same, so the game cannot tell the two
 * apart.
 *
 * The sockets use the hibernation API: between two frames the room is not in memory and costs nothing. What must survive
 * that is in storage (the seats, written on a seat change, never per frame) or in each socket's attachment (its seat and when
 * it last forwarded a game frame). A `connected` seat is one with an open socket, so it needs no storage of its own.
 *
 * Unlike `coop-server`, the room does not ping the sockets (a sleeping room cannot): a connection that dies without closing is
 * noticed when the player comes back and takes their seat again.
 */

interface SeatState {
  /** Secret that proves ownership of the seat; `null` while the seat is free */
  token: string | null;
  /** When a seat of a player who is away stops being reserved; `null` while there is no limit */
  heldUntil: number | null;
}

interface RoomState {
  code: string;
  /** 2, or 3 with a second guest (D40); a room stored before D40 has none and is a room of two */
  size?: RoomSeats;
  seats: Partial<Record<Seat, SeatState>>;
  /** When a seat last changed (a game frame is kept in the sockets' attachments) */
  lastActivity: number;
  /** Set once every seat was taken: the room was counted as filled (D43) */
  filled?: boolean;
}

interface Attachment {
  seat: Seat;
  /** The room's size, so a frame is routed without reading storage (D40); none on a socket from before D40: a room of two */
  size?: RoomSeats;
  /** One id per socket, to tell a socket from its replacement */
  id: string;
  /** `false` once the socket was replaced or has closed: nothing it does counts any more */
  current: boolean;
  /** When this socket last forwarded a game frame, written at most once a minute */
  lastFrame: number;
}

/** Largest frame accepted from a client (as `coop-server`) */
const MAX_FRAME_CHARS = 1_048_576;
/** How often a socket's `lastFrame` is written: the idle check needs minutes, not milliseconds */
const FRAME_STAMP_MS = 60_000;
const STATE_KEY = "room";

export class Room extends DurableObject<Env> {
  /** `undefined`: not read from storage yet; `null`: no room */
  private state: RoomState | null | undefined;
  /** Per socket id, what it may still send (memory only: a room that slept starts again full) */
  private readonly buckets = new Map<string, { bucket: TokenBucket; dropped: number }>();

  private get holdMs(): number {
    return envNumber(this.env.HOLD_MS, DEFAULTS.holdMs);
  }

  private get idleMs(): number {
    return envNumber(this.env.IDLE_ROOM_MS, DEFAULTS.idleRoomMs);
  }

  override async fetch(request: Request): Promise<Response> {
    const action = request.headers.get(ACTION_HEADER);
    const code = request.headers.get(CODE_HEADER) ?? "";
    const room = await this.load();
    if (action === "create") {
      const size = new URL(request.url).searchParams.get("seats") === "3" ? 3 : 2;
      return room === null ? this.create(code, size) : new Response(null, { status: 409 });
    }
    if (room === null) {
      return rejectSocket("notFound");
    }
    const params = new URL(request.url).searchParams;
    const seat = params.get("seat");
    const token = params.get("token");
    if (seat !== null || token !== null) {
      if (!isSeat(seat) || token === null || token === "") {
        return rejectSocket("badRequest");
      }
      return this.rejoin(room, seat, token);
    }
    return this.join(room);
  }

  // #region Seats

  private async create(code: string, size: RoomSeats): Promise<Response> {
    const token = newToken();
    const seats: Partial<Record<Seat, SeatState>> = {};
    for (const seat of roomSeats(size)) {
      seats[seat] = { token: null, heldUntil: null };
    }
    seats.host = { token, heldUntil: null };
    this.state = { code, size, seats, lastActivity: Date.now() };
    await this.save();
    countRoom(this.env.STATS, "created", size);
    const socket = this.accept("host", size);
    sendControl(socket.server, { t: "relay:created", code, seat: "host", token });
    return upgradeResponse(socket.client);
  }

  /** Take the first free guest seat. The host seat can only be taken back with its token. */
  private async join(room: RoomState): Promise<Response> {
    const seat = seatsOf(room).find(candidate => candidate !== "host" && room.seats[candidate]?.token === null);
    const guest = seat === undefined ? undefined : room.seats[seat];
    if (seat === undefined || seat === "host" || guest === undefined) {
      return rejectSocket("full");
    }
    const token = newToken();
    guest.token = token;
    guest.heldUntil = null;
    room.lastActivity = Date.now();
    const filled = noteFilled(room);
    await this.save();
    if (filled) {
      countRoom(this.env.STATS, "filled", sizeOf(room));
    }
    const socket = this.accept(seat, sizeOf(room));
    sendControl(socket.server, { t: "relay:joined", code: room.code, seat, token });
    if (sizeOf(room) === 3) {
      // The host of three shakes hands with each guest as it comes (D40)
      for (const peer of this.peersOf(room, seat)) {
        sendControl(peer, { t: "relay:peerJoined", seat });
      }
    }
    this.announcePaired(room);
    if (!this.socketOf("host") && room.seats.host?.token != null) {
      sendControl(socket.server, this.notice(room, "host", { t: "relay:peerLeft", holdMs: null }));
    }
    return upgradeResponse(socket.client);
  }

  /**
   * Take a seat back. Works while the seat is held and also while an older socket of it is still open (the room has not
   * noticed that connection died): the newer connection wins.
   */
  private async rejoin(room: RoomState, seat: Seat, token: string): Promise<Response> {
    const state = room.seats[seat];
    if (state === undefined || state.token === null || !tokensMatch(state.token, token)) {
      return rejectSocket("badToken");
    }
    const previous = this.socketOf(seat);
    if (previous) {
      this.retire(previous);
      previous.close(CLOSE_CODE_REPLACED, "replaced");
    }
    // This player is here again: the seats of the others who are still away are kept for as long as they stay (D20)
    for (const other of Object.values(room.seats)) {
      other.heldUntil = null;
    }
    room.lastActivity = Date.now();
    await this.save();
    const socket = this.accept(seat, sizeOf(room));
    const present = this.peersOf(room, seat);
    sendControl(socket.server, { t: "relay:rejoined", code: room.code, seat, peerPresent: present.length > 0 });
    this.tellPeers(room, seat, { t: "relay:peerBack" });
    this.announcePaired(room);
    for (const other of seatsOf(room)) {
      if (other !== seat && !this.socketOf(other) && room.seats[other]?.token != null) {
        sendControl(socket.server, this.notice(room, other, { t: "relay:peerLeft", holdMs: null }));
      }
    }
    return upgradeResponse(socket.client);
  }

  // #endregion
  // #region Sockets

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = attachmentOf(socket);
    if (!attachment?.current) {
      return;
    }
    if (typeof message !== "string") {
      return; // binary frames are not forwarded
    }
    if (message.length > MAX_FRAME_CHARS) {
      socket.close(1009, "too big");
      return;
    }
    if (!this.allowMessage(socket, attachment)) {
      return;
    }
    const route = routeOf(attachment, message);
    const peer = route === null ? undefined : this.socketOf(route.to);
    // A frame that looks like a relay notice is never forwarded (the frame itself, or what a host frame carries)
    if (route === null || !peer || isControlFrame(attachment.seat === "host" ? route.text : message)) {
      return;
    }
    peer.send(route.text);
    const now = Date.now();
    if (now - attachment.lastFrame >= FRAME_STAMP_MS) {
      attachment.lastFrame = now;
      socket.serializeAttachment(attachment);
    }
  }

  override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    try {
      socket.close(); // completes the closing handshake
    } catch {
      // already closed
    }
    await this.left(socket, code);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.left(socket, 1006);
  }

  /** A socket of the room is gone: the seat is kept, or the room ends ("End session") */
  private async left(socket: WebSocket, code: number): Promise<void> {
    const attachment = attachmentOf(socket);
    if (!attachment?.current) {
      return; // replaced by a newer connection, or the room is gone
    }
    this.retire(socket);
    this.buckets.delete(attachment.id);
    const room = await this.load();
    if (room === null) {
      return;
    }
    const seat = attachment.seat;
    const state = room.seats[seat];
    if (code === CLOSE_CODE_LEAVE) {
      if (sizeOf(room) === 3 && seat !== "host" && state !== undefined) {
        // A guest ended its session (D40): its seat is free, and the other two go on
        state.token = null;
        state.heldUntil = null;
        room.lastActivity = Date.now();
        if (this.peersOf(room, seat).length === 0) {
          // The last one connected left: the seats still reserved run the clock, as on a disconnect
          this.holdAll(room, room.lastActivity);
        }
        await this.save();
        this.tellPeers(room, seat, { t: "relay:peerGone" });
        return;
      }
      // "End session" (D20): the room is over for everyone
      for (const partner of this.peersOf(room, seat)) {
        this.retire(partner);
        sendControl(partner, { t: "relay:closed", reason: "partnerLeft" });
        partner.close(CLOSE_CODE_ROOM_CLOSED, "partnerLeft");
      }
      await this.destroy();
      return;
    }
    const now = Date.now();
    room.lastActivity = Math.max(room.lastActivity, attachment.lastFrame, now);
    if (this.peersOf(room, seat).length > 0) {
      // The others stay: this seat is kept as long as they do (D20)
      if (state !== undefined) {
        state.heldUntil = null;
      }
      this.tellPeers(room, seat, { t: "relay:peerLeft", holdMs: null });
    } else {
      this.holdAll(room, now);
    }
    await this.save();
  }

  /** All are gone: every reserved seat is kept for `holdMs` */
  private holdAll(room: RoomState, now: number): void {
    const until = now + this.holdMs;
    for (const other of Object.values(room.seats)) {
      if (other.token !== null) {
        other.heldUntil = until;
      }
    }
  }

  /** Free the seats whose hold ran out, and close a room that cannot continue or sat idle */
  override async alarm(): Promise<void> {
    const room = await this.load();
    if (room === null) {
      return;
    }
    const now = Date.now();
    for (const seat of seatsOf(room)) {
      const state = room.seats[seat];
      if (state !== undefined && state.heldUntil !== null && now >= state.heldUntil) {
        state.token = null;
        state.heldUntil = null;
        this.tellPeers(room, seat, { t: "relay:peerGone" });
      }
    }
    if (room.seats.host?.token == null) {
      await this.close("hostGone");
    } else if (now - this.lastActivity(room) >= this.idleMs) {
      await this.close("idle");
    } else {
      await this.save();
    }
  }

  // #endregion
  // #region Helpers

  private accept(seat: Seat, size: RoomSeats): { client: WebSocket; server: WebSocket } {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [seat]);
    const attachment: Attachment = { seat, size, id: crypto.randomUUID(), current: true, lastFrame: Date.now() };
    server.serializeAttachment(attachment);
    return { client, server };
  }

  /** The open socket of a seat, if its player is connected */
  private socketOf(seat: Seat): WebSocket | undefined {
    return this.ctx
      .getWebSockets(seat)
      .find(socket => attachmentOf(socket)?.current === true && socket.readyState === WebSocket.READY_STATE_OPEN);
  }

  /** Nothing this socket does counts any more */
  private retire(socket: WebSocket): void {
    const attachment = attachmentOf(socket);
    if (attachment) {
      attachment.current = false;
      socket.serializeAttachment(attachment);
    }
  }

  /** Tell both players the room is complete (again) */
  /** Tell everyone the room is complete (again), once every seat has its player */
  private announcePaired(room: RoomState): void {
    const sockets = seatsOf(room).map(seat => this.socketOf(seat));
    if (sockets.every(socket => socket !== undefined)) {
      for (const socket of sockets) {
        sendControl(socket, { t: "relay:paired" });
      }
    }
  }

  /** The open sockets of the other seats of the room, in seat order */
  private peersOf(room: RoomState, seat: Seat): WebSocket[] {
    return seatsOf(room)
      .filter(other => other !== seat)
      .map(other => this.socketOf(other))
      .filter((socket): socket is WebSocket => socket !== undefined);
  }

  /** A notice about a seat for everyone else in the room; a room of three says which seat (D40) */
  private tellPeers(
    room: RoomState,
    seat: Seat,
    message: { t: "relay:peerLeft"; holdMs: number | null } | { t: "relay:peerBack" } | { t: "relay:peerGone" },
  ): void {
    for (const peer of this.peersOf(room, seat)) {
      sendControl(peer, this.notice(room, seat, message));
    }
  }

  /** A notice about a seat as this room says it: with the seat in a room of three (D40), as before in a room of two */
  private notice<
    M extends { t: "relay:peerLeft"; holdMs: number | null } | { t: "relay:peerBack" } | { t: "relay:peerGone" },
  >(room: RoomState, seat: Seat, message: M): M | (M & { seat: Seat }) {
    return sizeOf(room) === 3 ? { ...message, seat } : message;
  }

  /** The rate of one socket (`coop-server` counts per address over all its sockets; a room sees only its own) */
  private allowMessage(socket: WebSocket, attachment: Attachment): boolean {
    const now = Date.now();
    let entry = this.buckets.get(attachment.id);
    if (entry === undefined) {
      const rate = envNumber(this.env.MESSAGES_PER_SECOND, DEFAULTS.messagesPerSecond);
      const burst = envNumber(this.env.MESSAGE_BURST, DEFAULTS.messageBurst);
      entry = { bucket: new TokenBucket(burst, rate / 1000, now), dropped: 0 };
      this.buckets.set(attachment.id, entry);
    }
    if (entry.bucket.take(now)) {
      return true;
    }
    // The reliable layer of the clients sends it again; a socket that keeps going is not a game
    entry.dropped++;
    if (entry.dropped === envNumber(this.env.MAX_DROPS_PER_SOCKET, DEFAULTS.maxDropsPerSocket)) {
      socket.close(CLOSE_CODE_POLICY, "rate");
    }
    return false;
  }

  /** When something last happened: a seat change, or a game frame of a socket that is still here */
  private lastActivity(room: RoomState): number {
    let last = room.lastActivity;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentOf(socket);
      if (attachment?.current) {
        last = Math.max(last, attachment.lastFrame);
      }
    }
    return last;
  }

  private async close(reason: RelayClosedReason): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      if (attachmentOf(socket)?.current) {
        this.retire(socket);
        sendControl(socket, { t: "relay:closed", reason });
        socket.close(CLOSE_CODE_ROOM_CLOSED, reason);
      }
    }
    await this.destroy();
  }

  private async load(): Promise<RoomState | null> {
    if (this.state === undefined) {
      this.state = (await this.ctx.storage.get<RoomState>(STATE_KEY)) ?? null;
    }
    return this.state;
  }

  /** Write the room and wake it when the next hold ends or when it would count as idle */
  private async save(): Promise<void> {
    const room = this.state;
    if (!room) {
      return;
    }
    await this.ctx.storage.put(STATE_KEY, room);
    const times = Object.values(room.seats)
      .map(state => state.heldUntil)
      .filter((time): time is number => time !== null);
    times.push(this.lastActivity(room) + this.idleMs);
    await this.ctx.storage.setAlarm(Math.min(...times));
  }

  /** The room is over: its code can be used again and its tokens stop working */
  private async destroy(): Promise<void> {
    this.state = null;
    this.buckets.clear();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // #endregion
}

/** How many seats a room has: a room stored before D40 has two */
function sizeOf(room: RoomState): RoomSeats {
  return room.size ?? 2;
}

function seatsOf(room: RoomState): readonly Seat[] {
  return roomSeats(sizeOf(room));
}

/**
 * Where a frame goes and what it says: in a room of two, to the other seat as it is; in a room of three, a host frame to the
 * guest it names, without the name, and a guest frame to the host, with the guest's seat in front (D40)
 */
function routeOf(attachment: Attachment, text: string): { to: Seat; text: string } | null {
  if ((attachment.size ?? 2) === 2) {
    return { to: otherSeat(attachment.seat), text };
  }
  if (attachment.seat !== "host") {
    return { to: "host", text: routedFrame(attachment.seat, text) };
  }
  const routed = parseRouted(text);
  if (routed === null || routed.seat === "host") {
    return null;
  }
  return { to: routed.seat, text: routed.payload };
}

function attachmentOf(socket: WebSocket): Attachment | null {
  return socket.deserializeAttachment() as Attachment | null;
}
