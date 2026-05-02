import { CoopSession } from "#app/multiplayer/network/coop-session";
import { COOP_PROTOCOL_VERSION, type Envelope } from "#app/multiplayer/network/messages";
import type {
  EnvelopeHandler,
  PeerJoinHandler,
  PeerLeaveHandler,
  TrysteroTransport,
  TrysteroTransportOptions,
} from "#app/multiplayer/network/transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeTransport {
  options: TrysteroTransportOptions;
  joinHandlers: PeerJoinHandler[];
  leaveHandlers: PeerLeaveHandler[];
  envelopeHandlers: EnvelopeHandler[];
  sent: Array<{ envelope: Envelope; targetPeer: string | undefined }>;
  opened: boolean;
  closed: boolean;
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

function makeFakeTransport(opts: TrysteroTransportOptions): FakeTransport {
  const fake: FakeTransport = {
    options: opts,
    joinHandlers: [],
    leaveHandlers: [],
    envelopeHandlers: [],
    sent: [],
    opened: false,
    closed: false,
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
  fake.open.mockImplementation(() => {
    fake.opened = true;
  });
  fake.close.mockImplementation(async () => {
    fake.closed = true;
    fake.opened = false;
  });
  fake.isOpen.mockImplementation(() => fake.opened && !fake.closed);
  fake.sendEnvelope.mockImplementation(async (envelope: Envelope, targetPeer?: string) => {
    fake.sent.push({ envelope, targetPeer });
  });
  fake.onPeerJoin.mockImplementation((h: PeerJoinHandler) => fake.joinHandlers.push(h));
  fake.onPeerLeave.mockImplementation((h: PeerLeaveHandler) => fake.leaveHandlers.push(h));
  fake.onEnvelope.mockImplementation((h: EnvelopeHandler) => fake.envelopeHandlers.push(h));
  fake.triggerPeerJoin = (peerId: string) => {
    for (const h of fake.joinHandlers) {
      h(peerId);
    }
  };
  fake.triggerPeerLeave = (peerId: string) => {
    for (const h of fake.leaveHandlers) {
      h(peerId);
    }
  };
  fake.triggerEnvelope = (envelope: Envelope, peerId: string) => {
    for (const h of fake.envelopeHandlers) {
      h(envelope, peerId);
    }
  };
  return fake;
}

function makeSession(): { session: CoopSession; transports: FakeTransport[] } {
  const transports: FakeTransport[] = [];
  const session = new CoopSession({
    transportFactory: (opts: TrysteroTransportOptions) => {
      const fake = makeFakeTransport(opts);
      transports.push(fake);
      return fake as unknown as TrysteroTransport;
    },
    joinTimeoutMs: 30_000,
  });
  return { session, transports };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("CoopSession state machine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in IDLE", () => {
    const { session } = makeSession();
    expect(session.getState().kind).toBe("IDLE");
  });

  describe("host()", () => {
    it("transitions IDLE -> HOSTING and returns a valid code", async () => {
      const { session, transports } = makeSession();
      const code = await session.host();
      expect(typeof code).toBe("string");
      expect(code.length).toBe(6);
      const state = session.getState();
      expect(state.kind).toBe("HOSTING");
      if (state.kind === "HOSTING") {
        expect(state.code).toBe(code);
      }
      expect(transports).toHaveLength(1);
      expect(transports[0].open).toHaveBeenCalled();
    });

    it("opens transport with the generated code", async () => {
      const { session, transports } = makeSession();
      const code = await session.host();
      expect(transports[0].options.roomCode).toBe(code);
    });

    it("emits state-change", async () => {
      const { session } = makeSession();
      const handler = vi.fn();
      session.on(CoopSession.STATE_CHANGE, handler);
      await session.host();
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ kind: "HOSTING" }));
    });

    it("rejects host() if already in another state", async () => {
      const { session } = makeSession();
      await session.host();
      await expect(session.host()).rejects.toThrow();
    });
  });

  describe("join()", () => {
    it("transitions IDLE -> JOINING with a valid code", async () => {
      const { session, transports } = makeSession();
      await session.join("ABC234");
      const state = session.getState();
      expect(state.kind).toBe("JOINING");
      if (state.kind === "JOINING") {
        expect(state.code).toBe("ABC234");
      }
      expect(transports[0].options.roomCode).toBe("ABC234");
    });

    it("normalizes the input code (lowercase + whitespace)", async () => {
      const { session, transports } = makeSession();
      await session.join("  abc234  ");
      expect(transports[0].options.roomCode).toBe("ABC234");
    });

    it("transitions to ERROR on invalid code without opening transport", async () => {
      const { session, transports } = makeSession();
      await session.join("BAD");
      const state = session.getState();
      expect(state.kind).toBe("ERROR");
      if (state.kind === "ERROR") {
        expect(state.recoverable).toBe(true);
      }
      expect(transports).toHaveLength(0);
    });

    it("times out to ERROR after joinTimeoutMs", async () => {
      const { session } = makeSession();
      await session.join("ABC234");
      vi.advanceTimersByTime(30_000);
      await flushMicrotasks();
      const state = session.getState();
      expect(state.kind).toBe("ERROR");
      if (state.kind === "ERROR") {
        expect(state.recoverable).toBe(true);
        expect(state.lastCode).toBe("ABC234");
      }
    });
  });

  describe("handshake to CONNECTED", () => {
    it("HOSTING -> CONNECTED on peer join + valid hello received", async () => {
      const { session, transports } = makeSession();
      const code = await session.host();
      const t = transports[0];
      t.triggerPeerJoin("peer-J");
      expect(t.sent[0]?.envelope).toEqual({ type: "hello", version: COOP_PROTOCOL_VERSION, role: "host" });
      expect(t.sent[0]?.targetPeer).toBe("peer-J");
      t.triggerEnvelope({ type: "hello", version: COOP_PROTOCOL_VERSION, role: "joiner" }, "peer-J");
      const state = session.getState();
      expect(state.kind).toBe("CONNECTED");
      if (state.kind === "CONNECTED") {
        expect(state.role).toBe("host");
        expect(state.peerId).toBe("peer-J");
        expect(state.code).toBe(code);
      }
    });

    it("JOINING -> CONNECTED on peer join + valid hello received", async () => {
      const { session, transports } = makeSession();
      await session.join("ABC234");
      const t = transports[0];
      t.triggerPeerJoin("peer-H");
      t.triggerEnvelope({ type: "hello", version: COOP_PROTOCOL_VERSION, role: "host" }, "peer-H");
      const state = session.getState();
      expect(state.kind).toBe("CONNECTED");
      if (state.kind === "CONNECTED") {
        expect(state.role).toBe("joiner");
        expect(state.peerId).toBe("peer-H");
      }
    });

    it("CONNECTED clears the join timeout (no spurious ERROR after timeout window)", async () => {
      const { session, transports } = makeSession();
      await session.join("ABC234");
      const t = transports[0];
      t.triggerPeerJoin("peer-H");
      t.triggerEnvelope({ type: "hello", version: COOP_PROTOCOL_VERSION, role: "host" }, "peer-H");
      vi.advanceTimersByTime(60_000);
      await flushMicrotasks();
      expect(session.getState().kind).toBe("CONNECTED");
    });

    it("rejects hello with mismatched protocol version", async () => {
      const { session, transports } = makeSession();
      await session.host();
      const t = transports[0];
      t.triggerPeerJoin("peer-J");
      t.triggerEnvelope({ type: "hello", version: "different-version", role: "joiner" }, "peer-J");
      await flushMicrotasks();
      const state = session.getState();
      expect(state.kind).toBe("ERROR");
      if (state.kind === "ERROR") {
        expect(state.recoverable).toBe(false);
      }
    });
  });

  describe("cancel() / disconnect()", () => {
    it("HOSTING + cancel() -> IDLE and closes transport", async () => {
      const { session, transports } = makeSession();
      await session.host();
      await session.cancel();
      expect(session.getState().kind).toBe("IDLE");
      expect(transports[0].close).toHaveBeenCalled();
    });

    it("JOINING + cancel() -> IDLE and clears timeout", async () => {
      const { session, transports } = makeSession();
      await session.join("ABC234");
      await session.cancel();
      expect(session.getState().kind).toBe("IDLE");
      vi.advanceTimersByTime(60_000);
      await flushMicrotasks();
      expect(session.getState().kind).toBe("IDLE");
      expect(transports[0].close).toHaveBeenCalled();
    });

    it("CONNECTED + disconnect() -> IDLE, sends disconnect message, closes transport", async () => {
      const { session, transports } = makeSession();
      await session.host();
      const t = transports[0];
      t.triggerPeerJoin("peer-J");
      t.triggerEnvelope({ type: "hello", version: COOP_PROTOCOL_VERSION, role: "joiner" }, "peer-J");
      await session.disconnect();
      expect(session.getState().kind).toBe("IDLE");
      expect(t.sent.some(s => s.envelope.type === "disconnect")).toBe(true);
      expect(t.close).toHaveBeenCalled();
    });

    it("CONNECTED + onPeerLeave -> IDLE", async () => {
      const { session, transports } = makeSession();
      await session.host();
      const t = transports[0];
      t.triggerPeerJoin("peer-J");
      t.triggerEnvelope({ type: "hello", version: COOP_PROTOCOL_VERSION, role: "joiner" }, "peer-J");
      t.triggerPeerLeave("peer-J");
      await flushMicrotasks();
      expect(session.getState().kind).toBe("IDLE");
    });

    it("CONNECTED + remote disconnect message -> IDLE", async () => {
      const { session, transports } = makeSession();
      await session.host();
      const t = transports[0];
      t.triggerPeerJoin("peer-J");
      t.triggerEnvelope({ type: "hello", version: COOP_PROTOCOL_VERSION, role: "joiner" }, "peer-J");
      t.triggerEnvelope({ type: "disconnect", reason: null }, "peer-J");
      await flushMicrotasks();
      expect(session.getState().kind).toBe("IDLE");
    });
  });

  describe("retry() / dismiss()", () => {
    it("ERROR (recoverable) + retry() -> JOINING with last code", async () => {
      const { session } = makeSession();
      await session.join("ABC234");
      vi.advanceTimersByTime(30_000);
      await flushMicrotasks();
      expect(session.getState().kind).toBe("ERROR");
      await session.retry();
      const state = session.getState();
      expect(state.kind).toBe("JOINING");
      if (state.kind === "JOINING") {
        expect(state.code).toBe("ABC234");
      }
    });

    it("ERROR (non-recoverable) + retry() -> stays ERROR", async () => {
      const { session, transports } = makeSession();
      await session.host();
      const t = transports[0];
      t.triggerPeerJoin("peer-J");
      t.triggerEnvelope({ type: "hello", version: "different", role: "joiner" }, "peer-J");
      await flushMicrotasks();
      expect(session.getState().kind).toBe("ERROR");
      await session.retry();
      expect(session.getState().kind).toBe("ERROR");
    });

    it("ERROR + dismiss() -> IDLE", async () => {
      const { session } = makeSession();
      await session.join("BAD");
      expect(session.getState().kind).toBe("ERROR");
      session.dismiss();
      expect(session.getState().kind).toBe("IDLE");
    });
  });
});
