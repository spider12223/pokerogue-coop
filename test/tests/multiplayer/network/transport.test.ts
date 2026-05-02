import { COOP_PROTOCOL_VERSION, type Envelope } from "#app/multiplayer/network/messages";
import { TrysteroTransport } from "#app/multiplayer/network/transport";
import type { ActionReceiver, ActionSender, DataPayload, Room } from "trystero/nostr";
import { beforeEach, describe, expect, it, vi } from "vitest";

class MockRoom {
  public peerJoinHandler: ((peerId: string) => void) | null = null;
  public peerLeaveHandler: ((peerId: string) => void) | null = null;
  public actionReceiver: ((data: any, peerId: string, metadata?: any) => void) | null = null;
  public actionName: string | null = null;
  public sentMessages: Array<{ data: any; targetPeers?: string | string[] | null }> = [];
  public leaveCalled = 0;

  makeAction<T extends DataPayload = DataPayload>(name: string): [ActionSender<T>, ActionReceiver<T>, any] {
    this.actionName = name;
    const send: ActionSender<T> = async (data, targetPeers) => {
      this.sentMessages.push({ data, targetPeers: targetPeers as any });
      return [];
    };
    const receive: ActionReceiver<T> = handler => {
      this.actionReceiver = handler as any;
    };
    return [send, receive, () => {}];
  }

  onPeerJoin(fn: (peerId: string) => void): void {
    this.peerJoinHandler = fn;
  }

  onPeerLeave(fn: (peerId: string) => void): void {
    this.peerLeaveHandler = fn;
  }

  ping(_id: string): Promise<number> {
    return Promise.resolve(0);
  }

  async leave(): Promise<void> {
    this.leaveCalled += 1;
  }

  getPeers() {
    return {} as any;
  }

  addStream() {
    return [];
  }
  removeStream() {}
  addTrack() {
    return [];
  }
  removeTrack() {}
  replaceTrack() {
    return [];
  }
  onPeerStream() {}
  onPeerTrack() {}

  simulatePeerJoin(peerId: string) {
    this.peerJoinHandler?.(peerId);
  }
  simulatePeerLeave(peerId: string) {
    this.peerLeaveHandler?.(peerId);
  }
  simulateMessage(data: any, peerId: string) {
    this.actionReceiver?.(data, peerId);
  }
}

function makeFactory(mock: MockRoom) {
  return vi.fn((_config, _roomId) => mock as unknown as Room);
}

describe("TrysteroTransport", () => {
  let mock: MockRoom;
  let transport: TrysteroTransport;

  beforeEach(() => {
    mock = new MockRoom();
    transport = new TrysteroTransport({
      appId: "test-app",
      roomCode: "ABC234",
      roomFactory: makeFactory(mock),
    });
  });

  it("does not call the room factory until open() is invoked", () => {
    expect(transport.isOpen()).toBe(false);
  });

  it("opens a room with appId and roomCode", () => {
    const factory = vi.fn((_c, _r) => mock as unknown as Room);
    const t = new TrysteroTransport({
      appId: "pokerogue-coop-v1",
      roomCode: "XYZ234",
      roomFactory: factory,
    });
    t.open();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({ appId: "pokerogue-coop-v1" }, "XYZ234");
    expect(t.isOpen()).toBe(true);
  });

  it("registers a single 'msg' action on the room", () => {
    transport.open();
    expect(mock.actionName).toBe("msg");
  });

  it("forwards onPeerJoin to registered handlers", () => {
    transport.open();
    const handler = vi.fn();
    transport.onPeerJoin(handler);
    mock.simulatePeerJoin("peer-A");
    expect(handler).toHaveBeenCalledWith("peer-A");
  });

  it("forwards onPeerLeave to registered handlers", () => {
    transport.open();
    const handler = vi.fn();
    transport.onPeerLeave(handler);
    mock.simulatePeerLeave("peer-B");
    expect(handler).toHaveBeenCalledWith("peer-B");
  });

  it("forwards valid envelopes to envelope handlers", () => {
    transport.open();
    const handler = vi.fn();
    transport.onEnvelope(handler);
    const envelope: Envelope = { type: "hello", version: COOP_PROTOCOL_VERSION, role: "host" };
    mock.simulateMessage(envelope, "peer-A");
    expect(handler).toHaveBeenCalledWith(envelope, "peer-A");
  });

  it("drops malformed envelopes silently", () => {
    transport.open();
    const handler = vi.fn();
    transport.onEnvelope(handler);
    mock.simulateMessage({ type: "garbage", foo: 1 }, "peer-A");
    mock.simulateMessage(null, "peer-A");
    mock.simulateMessage({ type: "hello" }, "peer-A");
    expect(handler).not.toHaveBeenCalled();
  });

  it("sendEnvelope writes through the makeAction sender", async () => {
    transport.open();
    const envelope: Envelope = { type: "ping", nonce: 99 };
    await transport.sendEnvelope(envelope);
    expect(mock.sentMessages).toHaveLength(1);
    expect(mock.sentMessages[0].data).toEqual(envelope);
  });

  it("sendEnvelope can target a specific peer", async () => {
    transport.open();
    const envelope: Envelope = { type: "ping", nonce: 1 };
    await transport.sendEnvelope(envelope, "peer-A");
    expect(mock.sentMessages[0].targetPeers).toBe("peer-A");
  });

  it("sendEnvelope throws if called before open", async () => {
    await expect(transport.sendEnvelope({ type: "ping", nonce: 1 })).rejects.toThrow();
  });

  it("close() calls room.leave() and resets state", async () => {
    transport.open();
    expect(transport.isOpen()).toBe(true);
    await transport.close();
    expect(mock.leaveCalled).toBe(1);
    expect(transport.isOpen()).toBe(false);
  });

  it("close() is idempotent", async () => {
    transport.open();
    await transport.close();
    await transport.close();
    expect(mock.leaveCalled).toBe(1);
  });

  it("open() after close() opens a fresh room", async () => {
    transport.open();
    await transport.close();
    const newMock = new MockRoom();
    const t = new TrysteroTransport({
      appId: "test-app",
      roomCode: "ABC234",
      roomFactory: makeFactory(newMock),
    });
    t.open();
    expect(t.isOpen()).toBe(true);
  });
});
