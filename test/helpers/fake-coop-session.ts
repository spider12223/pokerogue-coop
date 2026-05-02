import { CoopSession } from "#app/multiplayer/network/coop-session";
import { COOP_PROTOCOL_VERSION, type Envelope } from "#app/multiplayer/network/messages";
import type {
  EnvelopeHandler,
  PeerJoinHandler,
  PeerLeaveHandler,
  TrysteroTransport,
  TrysteroTransportOptions,
} from "#app/multiplayer/network/transport";
import { vi } from "vitest";

export interface BridgedTransport {
  options: TrysteroTransportOptions;
  joinHandlers: PeerJoinHandler[];
  leaveHandlers: PeerLeaveHandler[];
  envelopeHandlers: EnvelopeHandler[];
  sent: Array<{ envelope: Envelope; targetPeer: string | undefined }>;
  opened: boolean;
  closed: boolean;
  bridge: BridgedTransport | null;
  peerName: string;
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  isOpen: ReturnType<typeof vi.fn>;
  sendEnvelope: ReturnType<typeof vi.fn>;
  onPeerJoin: ReturnType<typeof vi.fn>;
  onPeerLeave: ReturnType<typeof vi.fn>;
  onEnvelope: ReturnType<typeof vi.fn>;
  triggerPeerJoin: (peerId: string) => void;
  triggerPeerLeave: (peerId: string) => void;
  triggerEnvelope: (envelope: Envelope, peerId: string) => void;
}

export function makeBridgedTransport(opts: TrysteroTransportOptions, peerName: string): BridgedTransport {
  const transport: BridgedTransport = {
    options: opts,
    joinHandlers: [],
    leaveHandlers: [],
    envelopeHandlers: [],
    sent: [],
    opened: false,
    closed: false,
    bridge: null,
    peerName,
    open: vi.fn(),
    close: vi.fn(),
    isOpen: vi.fn(),
    sendEnvelope: vi.fn(),
    onPeerJoin: vi.fn(),
    onPeerLeave: vi.fn(),
    onEnvelope: vi.fn(),
    triggerPeerJoin: () => {},
    triggerPeerLeave: () => {},
    triggerEnvelope: () => {},
  };
  transport.open.mockImplementation(() => {
    transport.opened = true;
  });
  transport.close.mockImplementation(async () => {
    transport.closed = true;
    transport.opened = false;
  });
  transport.isOpen.mockImplementation(() => transport.opened && !transport.closed);
  transport.sendEnvelope.mockImplementation(async (envelope: Envelope, targetPeer?: string) => {
    transport.sent.push({ envelope, targetPeer });
    if (transport.bridge && transport.bridge.opened && !transport.bridge.closed) {
      const target = transport.bridge;
      const sourceName = transport.peerName;
      queueMicrotask(() => {
        if (target.opened && !target.closed) {
          target.triggerEnvelope(envelope, sourceName);
        }
      });
    }
  });
  transport.onPeerJoin.mockImplementation((h: PeerJoinHandler) => transport.joinHandlers.push(h));
  transport.onPeerLeave.mockImplementation((h: PeerLeaveHandler) => transport.leaveHandlers.push(h));
  transport.onEnvelope.mockImplementation((h: EnvelopeHandler) => transport.envelopeHandlers.push(h));
  transport.triggerPeerJoin = (peerId: string) => {
    for (const h of transport.joinHandlers) {
      h(peerId);
    }
  };
  transport.triggerPeerLeave = (peerId: string) => {
    for (const h of transport.leaveHandlers) {
      h(peerId);
    }
  };
  transport.triggerEnvelope = (envelope: Envelope, peerId: string) => {
    for (const h of transport.envelopeHandlers) {
      h(envelope, peerId);
    }
  };
  return transport;
}

export interface CoopPair {
  host: CoopSession;
  joiner: CoopSession;
  hostTransport: BridgedTransport;
  joinerTransport: BridgedTransport;
  code: string;
}

export async function makeCoopPair(): Promise<CoopPair> {
  let hostTransport!: BridgedTransport;
  let joinerTransport!: BridgedTransport;

  const host = new CoopSession({
    transportFactory: (transportOpts: TrysteroTransportOptions) => {
      hostTransport = makeBridgedTransport(transportOpts, "host-peer");
      return hostTransport as unknown as TrysteroTransport;
    },
    joinTimeoutMs: 30_000,
  });

  const joiner = new CoopSession({
    transportFactory: (transportOpts: TrysteroTransportOptions) => {
      joinerTransport = makeBridgedTransport(transportOpts, "joiner-peer");
      return joinerTransport as unknown as TrysteroTransport;
    },
    joinTimeoutMs: 30_000,
  });

  const code = await host.host();

  // Wire the bridge AFTER hostTransport exists but BEFORE joiner.join (so joiner's hello can bridge to host).
  // We can't wire joinerTransport yet because it doesn't exist.
  await joiner.join(code);

  hostTransport.bridge = joinerTransport;
  joinerTransport.bridge = hostTransport;

  // Both peers see the other join. Each side's onPeerJoin handler sends a hello envelope via its transport,
  // which (now that bridges are wired and dispatching via queueMicrotask) arrives async on the other side.
  hostTransport.triggerPeerJoin("joiner-peer");
  joinerTransport.triggerPeerJoin("host-peer");

  await flushBridgeAsync();

  return { host, joiner, hostTransport, joinerTransport, code };
}

export async function flushBridgeAsync(): Promise<void> {
  // Flush enough microtask rounds to cover bridge → onEnvelope → state transition → potential follow-up sends.
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

export const TEST_PROTOCOL_VERSION = COOP_PROTOCOL_VERSION;
