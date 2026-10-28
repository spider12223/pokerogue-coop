/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Concept (create a room, show its code, the guest joins by code) from SunghoLee98/pokerogue `src/coop/coop-connect.ts`
 * (AGPL-3.0-only); the asymmetric handshake and the sequencer wiring are new.
 */

import { coopLog } from "#coop/coop-log";
import { type CosmeticMessage, CosmeticReceiver, CosmeticSender } from "#coop/cosmetic";
import { EpochTransport } from "#coop/epoch";
import {
  type GuestHandshakeResult,
  guestHandshake,
  type HostHandshakeResult,
  hostHandshake,
  type SettingsOverlayPort,
} from "#coop/handshake";
import {
  type BuildIdentity,
  type ChatPayload,
  type CheckpointMessage,
  cleanName,
  DEFAULT_NAME,
  type Envelope,
  isChatPayload,
  isCheckpointMessage,
  isLobbyMessage,
  isStartPayload,
  type LobbyMessage,
  type PinnedSettings,
  partnerDisplayName,
  type Seat,
  type StartPayload,
} from "#coop/protocol";
import {
  isReportPayload,
  isResyncMessage,
  isResyncRequest,
  type ReportPayload,
  type ResyncMessage,
  type ResyncRequestPayload,
} from "#coop/resync";
import { Sequencer, type SequencerOptions } from "#coop/sequencer";
import {
  RelayError,
  type RelayEvent,
  type RelayIdentity,
  RelayWsTransport,
  type WebSocketFactory,
} from "#coop/transport/relay-ws";
import { type ReliableOptions, ReliableTransport } from "#coop/transport/reliable";
import { type Scheduler, systemScheduler, type Unsubscribe } from "#coop/transport/transport";

/**
 * A co-op connection after the handshake: the reliable channel to the partner and what runs on it (DECISIONS D2).
 * - the {@linkcode Sequencer}: every state-changing decision of the run
 * - the lobby, `START` and checkpoint messages: what happens around the run
 * - the epoch (D18) and the pairing: when the partner leaves and comes back the link starts the channel again, shakes
 *   hands again and tells the game that it has to reload (D20)
 *
 * No game imports, so two links can run in one Node process (tests) and the game layer wires them to the scene.
 *
 * @module
 */

export type LinkEnd = "peerLeft" | "peerGone" | "closed";

/** What a link needs to shake hands again when the partner comes back (D20) */
export interface RelinkContext {
  build: BuildIdentity;
  /** Host: the pinned settings it sends (D1) and the hash the guest must report back */
  pinned?: PinnedSettings;
  expectedEffectiveSettingsHash?: string;
  /** Guest: the overlay that applies them */
  overlay?: SettingsOverlayPort;
  /** This player's `"trainerId:secretId"` (D21) */
  accountId?: string;
  /** Host: the guest account that may take the seat again (D21) */
  expectedGuestAccountId?: string;
  timeoutMs?: number;
}

/** How to reach the relay again when this client's own connection drops (D20) */
export interface LinkConnection {
  url: string;
  identity: RelayIdentity;
  webSocketFactory?: WebSocketFactory;
}

/** The relay's close codes (`coop-server/src/relay-protocol.ts`): the seat was taken by a newer connection, the room was closed */
const CLOSE_CODE_REPLACED = 4000;
const CLOSE_CODE_ROOM_CLOSED = 4001;

/** How long this client waits between two attempts to get its seat back, at first and at most */
const RECONNECT_FIRST_MS = 400;
const RECONNECT_MAX_MS = 3000;

export class CoopLink {
  readonly seat: Seat;
  readonly sequencer: Sequencer;
  /** The join code of the room */
  readonly code: string;
  /** This player's display name (D1) */
  readonly name: string;
  /** What to call the partner: their display name, told apart from this one's if equal (D1) */
  readonly partnerName: string;
  /** The partner's name as they sent it */
  readonly theirName: string;
  /** What the cosmetic channel received and dropped (D16), for tests and the debug API */
  readonly cosmeticReceiver: CosmeticReceiver;
  /** The epoch of this link (D18) and what it dropped or held back */
  readonly channel: EpochTransport;

  private readonly cosmeticSender: CosmeticSender;
  private readonly cosmeticListeners = new Set<(message: CosmeticMessage) => void>();
  private readonly reliable: ReliableTransport;
  private relay: RelayWsTransport | null;
  private readonly lobbyListeners = new Set<(message: LobbyMessage) => void>();
  private readonly startListeners = new Set<(payload: StartPayload) => void>();
  private readonly checkpointListeners = new Set<(checkpoint: CheckpointMessage) => void>();
  private readonly resyncListeners = new Set<(message: ResyncMessage) => void>();
  private readonly resyncRequestListeners = new Set<(request: ResyncRequestPayload) => void>();
  private readonly reportListeners = new Set<(report: ReportPayload) => void>();
  private readonly chatListeners = new Set<(chat: ChatPayload) => void>();
  /** A `RESYNC` that arrived while nobody listened for it: the host sends it right behind its `HELLO_OK` (D20) */
  private earlyResync: ResyncMessage | null = null;
  private readonly endListeners = new Set<(end: LinkEnd) => void>();
  private readonly changeListeners = new Set<() => void>();
  private readonly unsubscribes: Unsubscribe[] = [];
  private relayUnsubscribes: Unsubscribe[] = [];
  private readonly context: RelinkContext | null;
  private readonly connection: LinkConnection | null;
  private readonly scheduler: Scheduler;
  private present = true;
  /** The relay closed this connection because another took its seat (D20) */
  private replaced = false;
  /** Why the relay closed the room under this client, if it did (D23: `idle` is a room that was silent for too long) */
  closedReason: "hostGone" | "partnerLeft" | "idle" | null = null;
  private resyncNeeded = false;
  private relinkRefusal: string | null = null;
  private reconnecting = false;
  private closed = false;

  constructor(options: {
    seat: Seat;
    reliable: ReliableTransport;
    relay?: RelayWsTransport | null;
    code?: string;
    sequencer?: Omit<SequencerOptions, "role" | "transport">;
    /** This player's display name and the partner's, as the handshake told them (D1) */
    names?: { mine: string; theirs: string };
    /** The clock of the cosmetic limits (D16); default: the real one */
    scheduler?: Scheduler;
    /** What it takes to shake hands again when the partner comes back (D20); without it the game reloads without a handshake */
    context?: RelinkContext;
    /** How to get this client's own seat back after its connection dropped (D20) */
    connection?: LinkConnection;
  }) {
    this.seat = options.seat;
    this.reliable = options.reliable;
    this.relay = options.relay ?? null;
    this.code = options.code ?? "";
    this.scheduler = options.scheduler ?? systemScheduler;
    this.context = options.context ?? null;
    this.connection = options.connection ?? null;
    this.name = cleanName(options.names?.mine ?? DEFAULT_NAME);
    this.theirName = cleanName(options.names?.theirs ?? DEFAULT_NAME);
    this.partnerName = partnerDisplayName(this.name, this.theirName);
    this.cosmeticReceiver = new CosmeticReceiver(options.scheduler);
    this.cosmeticSender = new CosmeticSender(
      message => this.sendVolatile({ key: null, author: this.seat, kind: "COSMETIC", payload: message }),
      options.scheduler,
    );
    this.channel = new EpochTransport(this.reliable);
    this.sequencer = new Sequencer({ role: this.seat, transport: this.channel, ...options.sequencer });
    this.unsubscribes.push(this.channel.onMessage(message => this.route(message)));
    this.watchRelay();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** The epoch this link is in (D18) */
  get epoch(): number {
    return this.channel.epoch;
  }

  /** Whether the partner is connected right now */
  get partnerPresent(): boolean {
    return this.present;
  }

  /**
   * The partner came back (or this client's connection did) and the handshake is through: the world of this client is the
   * old one, and a `RESYNC` has to reload it before anything else is decided (D20)
   */
  get needsResync(): boolean {
    return this.resyncNeeded;
  }

  /** Why the handshake after a return was refused, if it was */
  get refusal(): string | null {
    return this.relinkRefusal;
  }

  /** Envelopes sent and not yet acknowledged (diagnostics) */
  get pending(): number {
    return this.reliable.pending;
  }

  /** Another tab took this seat (D20): the seat in the store is that tab's now */
  get wasReplaced(): boolean {
    return this.replaced;
  }

  /** The seat token and relay of this connection, for the seat store (D20) */
  get identity(): RelayIdentity | null {
    return this.connection?.identity ?? null;
  }

  get relayUrl(): string | null {
    return this.connection?.url ?? null;
  }

  sendLobby(message: LobbyMessage): void {
    this.send({ key: null, author: this.seat, kind: "LOBBY", payload: message });
  }

  onLobby(listener: (message: LobbyMessage) => void): Unsubscribe {
    this.lobbyListeners.add(listener);
    return () => {
      this.lobbyListeners.delete(listener);
    };
  }

  /** Host only: start the run on the guest's side */
  sendStart(payload: StartPayload): void {
    if (this.seat !== "host") {
      throw new Error("Only the host starts the run");
    }
    this.send({ key: null, author: "host", kind: "START", payload });
  }

  onStart(listener: (payload: StartPayload) => void): Unsubscribe {
    this.startListeners.add(listener);
    return () => {
      this.startListeners.delete(listener);
    };
  }

  /**
   * Send a cosmetic message (D16): it never waits for, or delays, a decision, and it may be lost. A state that changes
   * often is held back to the limit; a ping or an emote over the limit is refused.
   * @returns Whether it was sent or is held
   */
  sendCosmetic(message: CosmeticMessage): boolean {
    return this.cosmeticSender.send(message);
  }

  /** Drop the intents that are held back: what they described is over (D16) */
  clearHeldCosmetics(): void {
    this.cosmeticSender.clearHeld();
  }

  /** The partner's cosmetic messages that are well-formed and within the limits (D16) */
  onCosmetic(listener: (message: CosmeticMessage) => void): Unsubscribe {
    this.cosmeticListeners.add(listener);
    return () => {
      this.cosmeticListeners.delete(listener);
    };
  }

  sendCheckpoint(checkpoint: CheckpointMessage): void {
    this.send({ key: null, author: this.seat, kind: "CHECKPOINT", payload: checkpoint });
  }

  onCheckpoint(listener: (checkpoint: CheckpointMessage) => void): Unsubscribe {
    this.checkpointListeners.add(listener);
    return () => {
      this.checkpointListeners.delete(listener);
    };
  }

  // #region Epochs and resync (D13, D18)

  /** Guest: ask the host to reload the run because the clients disagree (D13) */
  sendResyncRequest(request: ResyncRequestPayload): void {
    this.send({ key: null, author: this.seat, kind: "RESYNC_REQUEST", payload: request });
  }

  /** Host: the clients' `RESYNC_REQUEST`s (D13) */
  onResyncRequest(listener: (request: ResyncRequestPayload) => void): Unsubscribe {
    this.resyncRequestListeners.add(listener);
    return () => {
      this.resyncRequestListeners.delete(listener);
    };
  }

  /**
   * Host: tell the guest to reload (or to stop) under `message.epoch` (D13, D18). The message takes `message.seq`, which the
   * host took with {@linkcode Sequencer.reserveSeq}. Nothing changes on this client: the game applies the message at the same
   * time, with {@linkcode beginEpoch}.
   */
  sendResync(message: ResyncMessage): void {
    if (this.seat !== "host") {
      throw new Error("Only the host sequences a RESYNC");
    }
    if (!this.closed) {
      this.channel.sendAt(message.epoch, {
        key: null,
        seq: message.seq,
        author: "host",
        kind: "RESYNC",
        payload: message,
      });
    }
  }

  /** Guest: the `RESYNC`s of the host. The message has the epoch and the `seq` of its envelope. */
  onResync(listener: (message: ResyncMessage) => void): Unsubscribe {
    this.resyncListeners.add(listener);
    if (this.earlyResync !== null) {
      const early = this.earlyResync;
      this.earlyResync = null;
      queueMicrotask(() => listener(early));
    }
    return () => {
      this.resyncListeners.delete(listener);
    };
  }

  /** After a stop: this client's side of the report (D13) */
  sendReport(report: ReportPayload): void {
    this.send({ key: null, author: this.seat, kind: "REPORT", payload: report });
  }

  onReport(listener: (report: ReportPayload) => void): Unsubscribe {
    this.reportListeners.add(listener);
    return () => {
      this.reportListeners.delete(listener);
    };
  }

  /** A line of the chat box (D38): reliable, outside the simulation and its epochs */
  sendChat(text: string): void {
    this.send({ key: null, author: this.seat, kind: "CHAT", payload: { text } satisfies ChatPayload });
  }

  onChat(listener: (chat: ChatPayload) => void): Unsubscribe {
    this.chatListeners.add(listener);
    return () => {
      this.chatListeners.delete(listener);
    };
  }

  /**
   * The run was reloaded under a new epoch (D18): from now on this link sends and accepts that epoch only, the sequencer
   * has a clean world and carries on from `nextSeq` (the `seq` after the `RESYNC`).
   */
  beginEpoch(epoch: number, nextSeq: number): void {
    // The sequencer first: setting the epoch hands it what the host sent in its new world while this client was finishing
    // the old one, and that must reach a clean sequencer
    this.sequencer.resetForEpoch(nextSeq);
    this.channel.setEpoch(epoch);
    this.resyncNeeded = false;
    this.notifyChange();
  }

  // #endregion

  // #region The partner leaves and comes back (D20)

  /** Something about the pairing changed: the partner left or came back, the handshake is through, a reload happened */
  onChange(listener: () => void): Unsubscribe {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /** Resolves the next time {@linkcode onChange} fires */
  untilChange(): Promise<void> {
    return new Promise(resolve => {
      const stop = this.onChange(() => {
        stop();
        resolve();
      });
    });
  }

  // #endregion

  /** The partner left, their seat expired, or the connection closed. */
  onEnd(listener: (end: LinkEnd) => void): Unsubscribe {
    this.endListeners.add(listener);
    return () => {
      this.endListeners.delete(listener);
    };
  }

  close(): void {
    this.shutdown(false);
  }

  /** "End session" (D20): leave the room for good. The relay closes it and tells the partner. */
  leave(): void {
    this.shutdown(true);
  }

  private shutdown(leave: boolean): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cosmeticSender.close();
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe();
    }
    this.unwatchRelay();
    this.sequencer.close();
    this.reliable.close();
    if (leave) {
      this.relay?.leave();
    } else {
      this.relay?.close();
    }
    this.notifyChange();
  }

  private send(envelope: Envelope): void {
    if (!this.closed) {
      this.channel.send(envelope);
    }
  }

  private sendVolatile(envelope: Envelope): void {
    if (!this.closed && this.present) {
      this.channel.sendVolatile(envelope);
    }
  }

  private route(message: Envelope): void {
    switch (message.kind) {
      case "LOBBY":
        if (isLobbyMessage(message.payload) && message.author !== this.seat) {
          for (const listener of [...this.lobbyListeners]) {
            listener(message.payload);
          }
        }
        break;
      case "START":
        if (this.seat === "guest" && message.author === "host" && isStartPayload(message.payload)) {
          for (const listener of [...this.startListeners]) {
            listener(message.payload);
          }
        }
        break;
      case "CHECKPOINT":
        if (isCheckpointMessage(message.payload) && message.author !== this.seat) {
          for (const listener of [...this.checkpointListeners]) {
            listener(message.payload);
          }
        }
        break;
      case "RESYNC_REQUEST":
        if (this.seat === "host" && message.author === "guest" && isResyncRequest(message.payload)) {
          for (const listener of [...this.resyncRequestListeners]) {
            listener(message.payload);
          }
        }
        break;
      case "RESYNC":
        if (
          this.seat === "guest"
          && message.author === "host"
          && message.seq !== undefined
          && isResyncMessage(message.payload)
          && message.payload.seq === message.seq
          && message.payload.epoch === (message.epoch ?? 0)
        ) {
          if (this.resyncListeners.size === 0) {
            // the game side wires its listener right after the handshake: keep the newest until it does
            this.earlyResync = message.payload;
          }
          for (const listener of [...this.resyncListeners]) {
            listener(message.payload);
          }
        }
        break;
      case "REPORT":
        if (isReportPayload(message.payload) && message.author !== this.seat) {
          for (const listener of [...this.reportListeners]) {
            listener(message.payload);
          }
        }
        break;
      case "COSMETIC": {
        const accepted = message.author === this.seat ? null : this.cosmeticReceiver.accept(message.payload);
        if (accepted !== null) {
          for (const listener of [...this.cosmeticListeners]) {
            try {
              listener(accepted);
            } catch (error) {
              console.error("co-op: a cosmetic listener failed:", error);
            }
          }
        }
        break;
      }
      case "CHAT":
        if (isChatPayload(message.payload) && message.author !== this.seat) {
          for (const listener of [...this.chatListeners]) {
            listener(message.payload);
          }
        }
        break;
      case "BYE":
        this.emitEnd("peerGone");
        break;
      default:
        break; // decisions are the sequencer's, the handshake is over
    }
  }

  // #region The relay connection

  private watchRelay(): void {
    const relay = this.relay;
    if (relay === null) {
      return;
    }
    this.relayUnsubscribes.push(
      relay.onRelayEvent(event => this.relayEvent(event)),
      relay.onClose(info => this.connectionLost(relay, info.code)),
    );
  }

  private unwatchRelay(): void {
    for (const unsubscribe of this.relayUnsubscribes.splice(0)) {
      unsubscribe();
    }
  }

  private relayEvent(event: RelayEvent): void {
    switch (event.t) {
      case "relay:peerLeft":
        // Nothing sent from now on reaches the new pairing: what was unacknowledged waits, and is dropped by the reset (D20)
        this.present = false;
        this.reliable.detach();
        this.notifyChange();
        this.emitEnd("peerLeft");
        break;
      case "relay:paired":
        void this.relink();
        break;
      case "relay:peerGone":
      case "relay:closed":
        if (event.t === "relay:closed") {
          this.closedReason = event.reason;
        }
        this.present = false;
        this.notifyChange();
        this.emitEnd("peerGone");
        break;
      default:
        break; // `peerBack` comes with a `paired`
    }
  }

  /** The partner is here again (or this client got its seat back): a new pairing, a new handshake, and then a reload */
  private async relink(): Promise<void> {
    const relay = this.relay;
    if (this.closed || relay === null) {
      return;
    }
    this.present = true;
    this.relinkRefusal = null;
    // The host's RESYNC can follow its HELLO_OK in the same breath: a reload that has happened by the time this handshake
    // is through is the one this client was waiting for
    const epochBefore = this.channel.epoch;
    this.reliable.reset();
    this.reliable.attach(relay);
    const context = this.context;
    if (context === null) {
      this.resyncNeeded = true;
      this.notifyChange();
      return;
    }
    let result: HostHandshakeResult | GuestHandshakeResult;
    try {
      const timeoutMs = context.timeoutMs === undefined ? {} : { timeoutMs: context.timeoutMs };
      if (this.seat === "host") {
        result = await hostHandshake(this.reliable, context.build, context.pinned ?? {}, {
          name: this.name,
          mode: "resume",
          ...timeoutMs,
          ...(context.expectedEffectiveSettingsHash === undefined
            ? {}
            : { expectedEffectiveSettingsHash: context.expectedEffectiveSettingsHash }),
          ...(context.expectedGuestAccountId === undefined
            ? {}
            : { expectedGuestAccountId: context.expectedGuestAccountId }),
        });
      } else if (context.overlay === undefined) {
        throw new Error("a guest link needs its settings overlay to shake hands again");
      } else {
        result = await guestHandshake(this.reliable, context.build, context.overlay, {
          name: this.name,
          ...timeoutMs,
          ...(context.accountId === undefined ? {} : { accountId: context.accountId }),
        });
      }
    } catch (error) {
      console.error("co-op: the handshake after a return failed:", error);
      coopLog().error("link", "the handshake after a return failed", error);
      this.relinkRefusal = String(error);
      this.notifyChange();
      this.emitEnd("closed");
      return;
    }
    if (this.closed) {
      return;
    }
    if (!result.ok) {
      this.relinkRefusal = result.reason;
      this.notifyChange();
      this.emitEnd("closed");
      return;
    }
    if (this.channel.epoch === epochBefore) {
      this.resyncNeeded = true;
    }
    this.notifyChange();
  }

  /** This client's own connection to the relay dropped (D20): get the seat back, and pair again */
  private connectionLost(relay: RelayWsTransport, code: number | undefined): void {
    if (this.closed || this.relay !== relay) {
      return;
    }
    this.present = false;
    this.reliable.detach();
    this.notifyChange();
    // Another connection took this seat with the same token (the player opened the game in a second tab, or the relay room
    // was closed under them): fighting for the seat back would make the two tabs take it from each other for ever
    if (this.connection === null || code === CLOSE_CODE_REPLACED || code === CLOSE_CODE_ROOM_CLOSED) {
      this.replaced = code === CLOSE_CODE_REPLACED;
      this.emitEnd("closed");
      return;
    }
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    const connection = this.connection;
    if (connection === null || this.reconnecting) {
      return;
    }
    this.reconnecting = true;
    let wait = RECONNECT_FIRST_MS;
    try {
      while (!this.closed) {
        await new Promise<void>(resolve => this.scheduler.setTimeout(resolve, wait));
        wait = Math.min(RECONNECT_MAX_MS, wait * 2);
        if (this.closed) {
          return;
        }
        const relay = RelayWsTransport.connect(
          connection.url,
          {
            mode: "rejoin",
            code: connection.identity.code,
            seat: connection.identity.seat,
            token: connection.identity.token,
          },
          connection.webSocketFactory,
        );
        // The relay says `paired` right after `rejoined`, possibly in the same read: keep what it says until this link listens
        const early: RelayEvent[] = [];
        const stopEarly = relay.onRelayEvent(event => early.push(event));
        try {
          await relay.ready;
        } catch (error) {
          stopEarly();
          relay.close();
          if (error instanceof RelayError && (error.reason === "notFound" || error.reason === "badToken")) {
            // The room is gone: nothing to come back to
            this.emitEnd("closed");
            return;
          }
          continue; // the relay is not reachable yet
        }
        stopEarly();
        if (this.closed) {
          relay.close();
          return;
        }
        this.unwatchRelay();
        this.relay = relay;
        this.watchRelay();
        // If the partner is there, the relay pairs the two again and `relink` takes it from there
        for (const event of early) {
          this.relayEvent(event);
        }
        return;
      }
    } finally {
      this.reconnecting = false;
    }
  }

  // #endregion

  private notifyChange(): void {
    for (const listener of [...this.changeListeners]) {
      listener();
    }
  }

  private emitEnd(end: LinkEnd): void {
    for (const listener of [...this.endListeners]) {
      listener(end);
    }
  }
}

// #region Rooms

export interface RoomOptions {
  /** Default: the global `WebSocket` */
  webSocketFactory?: WebSocketFactory;
  reliable?: ReliableOptions;
}

/** A room the host created and is waiting in. */
export interface HostRoom {
  readonly identity: RelayIdentity;
  readonly relay: RelayWsTransport;
  readonly reliable: ReliableTransport;
  readonly url: string;
  readonly webSocketFactory?: WebSocketFactory | undefined;
  /** Resolves when the guest joined (and again does not: the first pairing only); rejects if the room closed first */
  readonly partner: Promise<void>;
  cancel(): void;
}

/** A room the guest joined. */
export interface GuestRoom {
  readonly identity: RelayIdentity;
  readonly relay: RelayWsTransport;
  readonly reliable: ReliableTransport;
  readonly url: string;
  readonly webSocketFactory?: WebSocketFactory | undefined;
  cancel(): void;
}

/**
 * Create a room at the relay.
 * @param url - The relay, for example `ws://localhost:8787`
 * @throws `RelayError` if the relay refuses
 */
export async function createRoom(url: string, options: RoomOptions = {}): Promise<HostRoom> {
  const relay = RelayWsTransport.connect(url, { mode: "create" }, options.webSocketFactory);
  // Register before the code is shown: the guest can join the moment it is
  const partner = new Promise<void>((resolve, reject) => {
    relay.onRelayEvent(event => {
      if (event.t === "relay:paired") {
        resolve();
      } else if (event.t === "relay:closed") {
        reject(new Error("room closed"));
      }
    });
    relay.onClose(() => reject(new Error("relay connection closed")));
  });
  partner.catch(() => {});
  let identity: RelayIdentity;
  try {
    identity = await relay.ready;
  } catch (error) {
    relay.close();
    throw error;
  }
  const reliable = new ReliableTransport(relay, options.reliable);
  return {
    identity,
    relay,
    reliable,
    url,
    webSocketFactory: options.webSocketFactory,
    partner,
    cancel: () => {
      reliable.close();
      relay.close();
    },
  };
}

/**
 * Join a room by its code.
 * @throws `RelayError` (`notFound`, `full`, `badRequest`) if the relay refuses
 */
export async function joinRoom(url: string, code: string, options: RoomOptions = {}): Promise<GuestRoom> {
  const relay = RelayWsTransport.connect(url, { mode: "join", code }, options.webSocketFactory);
  let identity: RelayIdentity;
  try {
    identity = await relay.ready;
  } catch (error) {
    relay.close();
    throw error;
  }
  const reliable = new ReliableTransport(relay, options.reliable);
  return {
    identity,
    relay,
    reliable,
    url,
    webSocketFactory: options.webSocketFactory,
    cancel: () => {
      reliable.close();
      relay.close();
    },
  };
}

/** A seat taken back after the tab was reloaded or reopened (D20): the same room, the same seat */
export interface RejoinedRoom {
  readonly identity: RelayIdentity;
  readonly relay: RelayWsTransport;
  readonly reliable: ReliableTransport;
  readonly url: string;
  readonly webSocketFactory?: WebSocketFactory | undefined;
  /** Resolves when both seats are connected (the partner is there already, or comes back); rejects if the room closed */
  readonly paired: Promise<void>;
  cancel(): void;
}

/**
 * Take a seat back with its token.
 * @throws `RelayError` (`notFound`, `badToken`, `badRequest`, or `closed` if the relay is not reachable)
 */
export async function rejoinRoom(
  url: string,
  seat: { code: string; seat: Seat; token: string },
  options: RoomOptions = {},
): Promise<RejoinedRoom> {
  const relay = RelayWsTransport.connect(url, { mode: "rejoin", ...seat }, options.webSocketFactory);
  // The relay says `paired` right after `rejoined`: listen before anything else runs
  const paired = new Promise<void>((resolve, reject) => {
    relay.onRelayEvent(event => {
      if (event.t === "relay:paired") {
        resolve();
      } else if (event.t === "relay:closed") {
        reject(new Error("room closed"));
      }
    });
    relay.onClose(() => reject(new Error("relay connection closed")));
  });
  paired.catch(() => {});
  let identity: RelayIdentity;
  try {
    identity = await relay.ready;
  } catch (error) {
    relay.close();
    throw error;
  }
  const reliable = new ReliableTransport(relay, options.reliable);
  return {
    identity,
    relay,
    reliable,
    url,
    webSocketFactory: options.webSocketFactory,
    paired,
    cancel: () => {
      reliable.close();
      relay.close();
    },
  };
}

export class HandshakeRefusedError extends Error {
  readonly result: Exclude<HostHandshakeResult | GuestHandshakeResult, { ok: true }>;

  constructor(result: Exclude<HostHandshakeResult | GuestHandshakeResult, { ok: true }>) {
    const fields = result.mismatches.map(mismatch => mismatch.field).join(", ");
    super(`co-op handshake failed: ${result.reason}${fields ? ` (${fields})` : ""}`);
    this.name = "HandshakeRefusedError";
    this.result = result;
  }
}

export interface EstablishedHost {
  link: CoopLink;
  remote: BuildIdentity;
  /** What to call the guest (D1) */
  partnerName: string;
}

/**
 * Host: shake hands with the guest who joined, then wire the link.
 * @throws {@linkcode HandshakeRefusedError} If the builds or the effective pinned settings differ, or the guest is silent
 */
export async function establishHost(
  room: HostRoom | RejoinedRoom,
  build: BuildIdentity,
  pinned: PinnedSettings,
  options: {
    expectedEffectiveSettingsHash?: string;
    timeoutMs?: number;
    sequencer?: Omit<SequencerOptions, "role" | "transport">;
    /** This player's display name (D1) */
    name?: string;
    scheduler?: Scheduler;
    /** `resume`: this host continues a saved run (D21); default `new` */
    mode?: "new" | "resume";
    /** The guest account that may join (D21); another one is refused */
    expectedGuestAccountId?: string;
  } = {},
): Promise<EstablishedHost> {
  const result = await hostHandshake(room.reliable, build, pinned, {
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.expectedGuestAccountId === undefined ? {} : { expectedGuestAccountId: options.expectedGuestAccountId }),
    ...(options.expectedEffectiveSettingsHash === undefined
      ? {}
      : { expectedEffectiveSettingsHash: options.expectedEffectiveSettingsHash }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  if (!result.ok) {
    throw new HandshakeRefusedError(result);
  }
  const link = new CoopLink({
    seat: "host",
    reliable: room.reliable,
    relay: room.relay,
    code: room.identity.code,
    names: { mine: options.name ?? DEFAULT_NAME, theirs: result.name },
    context: {
      build,
      pinned,
      ...(options.expectedEffectiveSettingsHash === undefined
        ? {}
        : { expectedEffectiveSettingsHash: options.expectedEffectiveSettingsHash }),
      ...(options.expectedGuestAccountId === undefined
        ? { expectedGuestAccountId: result.accountId }
        : { expectedGuestAccountId: options.expectedGuestAccountId }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
    connection: {
      url: room.url,
      identity: room.identity,
      ...(room.webSocketFactory === undefined ? {} : { webSocketFactory: room.webSocketFactory }),
    },
    ...(options.sequencer === undefined ? {} : { sequencer: options.sequencer }),
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
  });
  return { link, remote: result.remote, partnerName: link.partnerName };
}

export interface EstablishedGuest {
  link: CoopLink;
  /** The host's build and the pinned settings it sent; the overlay is applied */
  hello: { build: BuildIdentity; pinnedSettings: PinnedSettings; mode: "new" | "resume" };
}

/**
 * Guest: shake hands with the host, apply its pinned settings as the overlay, then wire the link.
 * @throws {@linkcode HandshakeRefusedError} If the builds differ or the host is silent (the overlay is removed again)
 */
export async function establishGuest(
  room: GuestRoom | RejoinedRoom,
  build: BuildIdentity,
  overlay: SettingsOverlayPort,
  options: {
    timeoutMs?: number;
    sequencer?: Omit<SequencerOptions, "role" | "transport">;
    /** This player's display name (D1) */
    name?: string;
    scheduler?: Scheduler;
    /** This player's `"trainerId:secretId"` (D21) */
    accountId?: string;
  } = {},
): Promise<EstablishedGuest> {
  const result = await guestHandshake(room.reliable, build, overlay, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
  });
  if (!result.ok) {
    throw new HandshakeRefusedError(result);
  }
  const link = new CoopLink({
    seat: "guest",
    reliable: room.reliable,
    relay: room.relay,
    code: room.identity.code,
    names: { mine: options.name ?? DEFAULT_NAME, theirs: result.hello.name },
    context: {
      build,
      overlay,
      ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
    connection: {
      url: room.url,
      identity: room.identity,
      ...(room.webSocketFactory === undefined ? {} : { webSocketFactory: room.webSocketFactory }),
    },
    ...(options.sequencer === undefined ? {} : { sequencer: options.sequencer }),
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
  });
  return { link, hello: result.hello };
}

// #endregion
