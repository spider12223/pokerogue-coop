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

describe("CoopSession snapshot routing", () => {
  function emptySnapshot() {
    return {
      field: { slot0: null, slot1: null, foe0: null, foe1: null },
      weather: null,
      recentLog: [] as string[],
    };
  }

  async function makeConnectedSession() {
    const transports: FakeTransport[] = [];
    const session = new CoopSession({
      transportFactory: (opts: TrysteroTransportOptions) => {
        const fake = makeFakeTransport(opts);
        transports.push(fake);
        return fake as unknown as TrysteroTransport;
      },
      joinTimeoutMs: 30_000,
    });
    await session.host();
    const t = transports[0];
    t.triggerPeerJoin("peer-J");
    t.triggerEnvelope({ type: "hello", version: COOP_PROTOCOL_VERSION, role: "joiner" }, "peer-J");
    return { session, transport: t };
  }

  it("stores a received state-snapshot in the SnapshotStore", async () => {
    const { session, transport } = await makeConnectedSession();
    const snap = emptySnapshot();
    transport.triggerEnvelope({ type: "state-snapshot", turn: 5, payload: snap }, "peer-J");
    const stored = session.getSnapshotStore().getCurrent();
    expect(stored).not.toBeNull();
    expect(stored?.snapshot).toEqual(snap);
    expect(stored?.turn).toBe(5);
  });

  it("emits SNAPSHOT_UPDATE when a state-snapshot is received", async () => {
    const { session, transport } = await makeConnectedSession();
    const handler = vi.fn();
    session.on(CoopSession.SNAPSHOT_UPDATE, handler);
    const snap = emptySnapshot();
    transport.triggerEnvelope({ type: "state-snapshot", turn: 2, payload: snap }, "peer-J");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(snap, 2);
  });

  it("the latest snapshot wins after multiple receipts", async () => {
    const { session, transport } = await makeConnectedSession();
    transport.triggerEnvelope({ type: "state-snapshot", turn: 1, payload: emptySnapshot() }, "peer-J");
    transport.triggerEnvelope({ type: "state-snapshot", turn: 2, payload: emptySnapshot() }, "peer-J");
    transport.triggerEnvelope({ type: "state-snapshot", turn: 3, payload: emptySnapshot() }, "peer-J");
    expect(session.getSnapshotStore().getCurrent()?.turn).toBe(3);
  });
});

describe("CoopSession command envelope routing", () => {
  async function makeConnectedSession() {
    const transports: FakeTransport[] = [];
    const session = new CoopSession({
      transportFactory: (opts: TrysteroTransportOptions) => {
        const fake = makeFakeTransport(opts);
        transports.push(fake);
        return fake as unknown as TrysteroTransport;
      },
      joinTimeoutMs: 30_000,
    });
    await session.host();
    const t = transports[0];
    t.triggerPeerJoin("peer-J");
    t.triggerEnvelope({ type: "hello", version: COOP_PROTOCOL_VERSION, role: "joiner" }, "peer-J");
    return { session, transport: t };
  }

  it("emits REQUEST_COMMAND_RECEIVED when a request-command envelope arrives", async () => {
    const { session, transport } = await makeConnectedSession();
    const handler = vi.fn();
    session.on(CoopSession.REQUEST_COMMAND_RECEIVED, handler);
    const env = {
      type: "request-command" as const,
      requestId: "req-1",
      fieldIndex: 1 as const,
      snapshotTurn: 0,
      allowedCommands: ["FIGHT" as const],
      forcedKind: null,
    };
    transport.triggerEnvelope(env, "peer-J");
    expect(handler).toHaveBeenCalledWith(env);
  });

  it("emits CHOOSE_COMMAND_RECEIVED when a choose-command envelope arrives", async () => {
    const { session, transport } = await makeConnectedSession();
    const handler = vi.fn();
    session.on(CoopSession.CHOOSE_COMMAND_RECEIVED, handler);
    const env = {
      type: "choose-command" as const,
      requestId: "req-1",
      command: { kind: "RUN" as const },
    };
    transport.triggerEnvelope(env, "peer-J");
    expect(handler).toHaveBeenCalledWith(env);
  });

  it("emits CANCEL_COMMAND_REQUEST_RECEIVED when a cancel-command-request envelope arrives", async () => {
    const { session, transport } = await makeConnectedSession();
    const handler = vi.fn();
    session.on(CoopSession.CANCEL_COMMAND_REQUEST_RECEIVED, handler);
    const env = {
      type: "cancel-command-request" as const,
      requestId: "req-1",
      reason: "host timeout",
    };
    transport.triggerEnvelope(env, "peer-J");
    expect(handler).toHaveBeenCalledWith(env);
  });

  it("sendEnvelope routes through transport.sendEnvelope when CONNECTED", async () => {
    const { session, transport } = await makeConnectedSession();
    transport.sendEnvelope.mockClear();
    const env = { type: "ping" as const, nonce: 42 };
    await session.sendEnvelope(env);
    expect(transport.sendEnvelope).toHaveBeenCalledWith(env, undefined);
  });

  it("sendEnvelope is a no-op when transport is closed", async () => {
    const { session } = await makeConnectedSession();
    await session.disconnect();
    await expect(session.sendEnvelope({ type: "ping", nonce: 1 })).resolves.toBeUndefined();
  });

  it("sendEnvelope to a specific peer forwards the targetPeer arg", async () => {
    const { session, transport } = await makeConnectedSession();
    transport.sendEnvelope.mockClear();
    await session.sendEnvelope({ type: "ping", nonce: 1 }, "peer-J");
    expect(transport.sendEnvelope).toHaveBeenCalledWith({ type: "ping", nonce: 1 }, "peer-J");
  });

  it("emits START_RUN_RECEIVED when a start-run envelope arrives", async () => {
    const { session, transport } = await makeConnectedSession();
    const handler = vi.fn();
    session.on(CoopSession.START_RUN_RECEIVED, handler);
    const env = { type: "start-run" as const, seed: "abc-123", startingWave: 1 };
    transport.triggerEnvelope(env, "peer-J");
    expect(handler).toHaveBeenCalledWith(env);
  });

  it("emits RUN_END_RECEIVED when a run-end envelope arrives with reason", async () => {
    const { session, transport } = await makeConnectedSession();
    const handler = vi.fn();
    session.on(CoopSession.RUN_END_RECEIVED, handler);
    const env = { type: "run-end" as const, reason: "victory" };
    transport.triggerEnvelope(env, "peer-J");
    expect(handler).toHaveBeenCalledWith(env);
  });

  it("emits RUN_END_RECEIVED when a run-end envelope arrives with null reason", async () => {
    const { session, transport } = await makeConnectedSession();
    const handler = vi.fn();
    session.on(CoopSession.RUN_END_RECEIVED, handler);
    const env = { type: "run-end" as const, reason: null };
    transport.triggerEnvelope(env, "peer-J");
    expect(handler).toHaveBeenCalledWith(env);
  });

  it("multiple distinct envelope types trigger their respective events", async () => {
    const { session, transport } = await makeConnectedSession();
    const startRun = vi.fn();
    const runEnd = vi.fn();
    const requestCmd = vi.fn();
    session.on(CoopSession.START_RUN_RECEIVED, startRun);
    session.on(CoopSession.RUN_END_RECEIVED, runEnd);
    session.on(CoopSession.REQUEST_COMMAND_RECEIVED, requestCmd);
    transport.triggerEnvelope({ type: "start-run", seed: "x", startingWave: 1 }, "peer-J");
    transport.triggerEnvelope({ type: "run-end", reason: null }, "peer-J");
    transport.triggerEnvelope(
      {
        type: "request-command",
        requestId: "r-1",
        fieldIndex: 1,
        snapshotTurn: 0,
        allowedCommands: ["FIGHT"],
        forcedKind: null,
      },
      "peer-J",
    );
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(runEnd).toHaveBeenCalledTimes(1);
    expect(requestCmd).toHaveBeenCalledTimes(1);
  });
});
