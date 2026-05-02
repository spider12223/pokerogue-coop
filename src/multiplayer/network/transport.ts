import type { Envelope } from "#app/multiplayer/network/messages";
import { parseEnvelope } from "#app/multiplayer/network/messages";
import {
  type ActionReceiver,
  type ActionSender,
  joinRoom as defaultJoinRoom,
  type JoinRoomConfig,
  type Room,
} from "trystero/nostr";

export type RoomFactory = (config: JoinRoomConfig, roomId: string) => Room;

export interface TrysteroTransportOptions {
  appId: string;
  roomCode: string;
  roomFactory?: RoomFactory;
}

export type PeerJoinHandler = (peerId: string) => void;
export type PeerLeaveHandler = (peerId: string) => void;
export type EnvelopeHandler = (envelope: Envelope, peerId: string) => void;

export class TrysteroTransport {
  private readonly appId: string;
  private readonly roomCode: string;
  private readonly roomFactory: RoomFactory;
  private room: Room | null = null;
  private send: ActionSender<Envelope> | null = null;
  private receive: ActionReceiver<Envelope> | null = null;
  private peerJoinHandlers: PeerJoinHandler[] = [];
  private peerLeaveHandlers: PeerLeaveHandler[] = [];
  private envelopeHandlers: EnvelopeHandler[] = [];
  private leaving = false;

  constructor(options: TrysteroTransportOptions) {
    this.appId = options.appId;
    this.roomCode = options.roomCode;
    this.roomFactory = options.roomFactory ?? (defaultJoinRoom as unknown as RoomFactory);
  }

  open(): void {
    if (this.room) {
      return;
    }
    this.room = this.roomFactory({ appId: this.appId }, this.roomCode);
    const [send, receive] = this.room.makeAction<Envelope>("msg");
    this.send = send;
    this.receive = receive;

    this.room.onPeerJoin(peerId => {
      for (const h of this.peerJoinHandlers) {
        h(peerId);
      }
    });
    this.room.onPeerLeave(peerId => {
      for (const h of this.peerLeaveHandlers) {
        h(peerId);
      }
    });
    this.receive((data, peerId) => {
      const envelope = parseEnvelope(data);
      if (!envelope) {
        return;
      }
      for (const h of this.envelopeHandlers) {
        h(envelope, peerId);
      }
    });
  }

  async close(): Promise<void> {
    if (!this.room || this.leaving) {
      return;
    }
    this.leaving = true;
    try {
      await this.room.leave();
    } finally {
      this.room = null;
      this.send = null;
      this.receive = null;
      this.peerJoinHandlers = [];
      this.peerLeaveHandlers = [];
      this.envelopeHandlers = [];
      this.leaving = false;
    }
  }

  isOpen(): boolean {
    return this.room !== null && !this.leaving;
  }

  onPeerJoin(handler: PeerJoinHandler): void {
    this.peerJoinHandlers.push(handler);
  }

  onPeerLeave(handler: PeerLeaveHandler): void {
    this.peerLeaveHandlers.push(handler);
  }

  onEnvelope(handler: EnvelopeHandler): void {
    this.envelopeHandlers.push(handler);
  }

  async sendEnvelope(envelope: Envelope, targetPeer?: string): Promise<void> {
    if (!this.send) {
      throw new Error("TrysteroTransport: cannot send before open()");
    }
    await this.send(envelope, targetPeer);
  }
}
