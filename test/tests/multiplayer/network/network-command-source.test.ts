import { CoopSession } from "#app/multiplayer/network/coop-session";
import type { ChooseCommandMessage } from "#app/multiplayer/network/messages";
import {
  COOP_DEFAULT_COMMAND_TIMEOUT_MS,
  NetworkCommandSource,
  type NetworkCommandSourceOptions,
} from "#app/multiplayer/network/network-command-source";
import { Command } from "#enums/command";
import { MoveUseMode } from "#enums/move-use-mode";
import type { CommandPhase } from "#phases/command-phase";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stubDefaultTargets = (): number[] => [3];

interface FakeSceneHandle {
  scene: any;
  queueMessageMock: ReturnType<typeof vi.fn>;
  setTurn: (turn: number) => void;
}

function makeFakeScene(): FakeSceneHandle {
  const queueMessageMock = vi.fn();
  const scene = {
    currentBattle: { turn: 5 },
    phaseManager: { queueMessage: queueMessageMock },
  };
  return {
    scene,
    queueMessageMock,
    setTurn: (turn: number) => {
      scene.currentBattle.turn = turn;
    },
  };
}

function makeSource(session: any, opts: NetworkCommandSourceOptions = {}, scene?: any): NetworkCommandSource {
  const sceneToUse = scene ?? makeFakeScene().scene;
  return new NetworkCommandSource(1, session, {
    getDefaultTargets: stubDefaultTargets,
    getScene: () => sceneToUse,
    ...opts,
  });
}

interface MockSessionHandle {
  session: any;
  fire: (event: string, ...args: any[]) => void;
  broadcastSnapshotMock: ReturnType<typeof vi.fn>;
  sendEnvelopeMock: ReturnType<typeof vi.fn>;
}

function makeMockSession(): MockSessionHandle {
  const handlers = new Map<string, Array<(...args: any[]) => void>>();
  const broadcastSnapshotMock = vi.fn().mockResolvedValue(undefined);
  const sendEnvelopeMock = vi.fn().mockResolvedValue(undefined);
  const session = {
    broadcastSnapshot: broadcastSnapshotMock,
    sendEnvelope: sendEnvelopeMock,
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      const arr = handlers.get(event) ?? [];
      arr.push(handler);
      handlers.set(event, arr);
    }),
  };
  const fire = (event: string, ...args: any[]) => {
    const arr = handlers.get(event) ?? [];
    for (const h of arr) {
      h(...args);
    }
  };
  return { session, fire, broadcastSnapshotMock, sendEnvelopeMock };
}

interface FakeMoveOpts {
  moveId: number;
  usable?: boolean;
}

interface FakePhaseOpts {
  fieldIndex?: number;
  moveset?: Array<FakeMoveOpts | null>;
}

function makeFakePhase(opts: FakePhaseOpts = {}) {
  const moveset = (opts.moveset ?? []).map(m =>
    m
      ? {
          moveId: m.moveId,
          isUsable: () => [m.usable ?? true, ""],
        }
      : null,
  );
  return {
    fieldIndex: opts.fieldIndex ?? 1,
    getFieldIndex: () => opts.fieldIndex ?? 1,
    getPokemon: () => ({
      getMoveset: () => moveset,
    }),
    handleCommand: vi.fn().mockReturnValue(true),
    cancel: vi.fn(),
  };
}

function makeChooseCommand(requestId: string, command: ChooseCommandMessage["command"]): ChooseCommandMessage {
  return { type: "choose-command", requestId, command };
}

describe("NetworkCommandSource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("kind is 'network'", () => {
      const { session } = makeMockSession();
      const source = new NetworkCommandSource(1, session);
      expect(source.kind).toBe("network");
    });

    it("exposes the playerSlot", () => {
      const { session } = makeMockSession();
      const source = new NetworkCommandSource(1, session);
      expect(source.playerSlot).toBe(1);
    });

    it("exports a default command-timeout constant of 60_000ms", () => {
      expect(COOP_DEFAULT_COMMAND_TIMEOUT_MS).toBe(60_000);
    });

    it("subscribes to CHOOSE_COMMAND_RECEIVED on the session", () => {
      const { session } = makeMockSession();
      new NetworkCommandSource(1, session);
      expect(session.on).toHaveBeenCalledWith(CoopSession.CHOOSE_COMMAND_RECEIVED, expect.any(Function));
    });

    it("accepts a custom timeoutMs option without throwing", () => {
      const { session } = makeMockSession();
      expect(() => new NetworkCommandSource(1, session, { timeoutMs: 30_000 })).not.toThrow();
    });

    it("accepts a botFillJoiner option without throwing", () => {
      const { session } = makeMockSession();
      expect(() => new NetworkCommandSource(1, session, { botFillJoiner: true })).not.toThrow();
    });
  });

  describe("requestCommand — happy path", () => {
    it("calls broadcastSnapshot before sending the request-command envelope", async () => {
      const { session, broadcastSnapshotMock, sendEnvelopeMock } = makeMockSession();
      const source = makeSource(session);
      const phase = makeFakePhase();
      source.requestCommand(phase as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      expect(broadcastSnapshotMock).toHaveBeenCalled();
      expect(sendEnvelopeMock).toHaveBeenCalled();
      const broadcastOrder = broadcastSnapshotMock.mock.invocationCallOrder[0];
      const sendOrder = sendEnvelopeMock.mock.invocationCallOrder[0];
      expect(broadcastOrder).toBeLessThan(sendOrder);
    });

    it("sends a request-command envelope with the expected fields", async () => {
      const { session, sendEnvelopeMock } = makeMockSession();
      const source = makeSource(session);
      const phase = makeFakePhase();
      source.requestCommand(phase as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      const envelope = sendEnvelopeMock.mock.calls[0][0];
      expect(envelope.type).toBe("request-command");
      expect(envelope.fieldIndex).toBe(1);
      expect(envelope.snapshotTurn).toBe(5);
      expect(envelope.allowedCommands).toEqual(["FIGHT", "RUN"]);
      expect(envelope.forcedKind).toBeNull();
      expect(typeof envelope.requestId).toBe("string");
      expect(envelope.requestId.length).toBeGreaterThan(0);
    });

    it("generates a unique requestId per request", async () => {
      const { session, sendEnvelopeMock, fire } = makeMockSession();
      const source = makeSource(session);
      source.requestCommand(makeFakePhase() as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      const id1 = sendEnvelopeMock.mock.calls[0][0].requestId;
      fire(CoopSession.CHOOSE_COMMAND_RECEIVED, makeChooseCommand(id1, { kind: "RUN" }));
      source.requestCommand(makeFakePhase() as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      const id2 = sendEnvelopeMock.mock.calls[1][0].requestId;
      expect(id1).not.toBe(id2);
    });

    it("snapshotTurn reflects the scene's currentBattle.turn", async () => {
      const { scene, setTurn } = makeFakeScene();
      setTurn(17);
      const { session, sendEnvelopeMock } = makeMockSession();
      const source = makeSource(session, {}, scene);
      source.requestCommand(makeFakePhase() as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      expect(sendEnvelopeMock.mock.calls[0][0].snapshotTurn).toBe(17);
    });
  });

  describe("response handling — FIGHT", () => {
    it("FIGHT response with explicit targets calls phase.handleCommand with that turnMove", async () => {
      const { session, sendEnvelopeMock, fire } = makeMockSession();
      const source = makeSource(session);
      const phase = makeFakePhase({
        moveset: [{ moveId: 33 }, { moveId: 45 }],
      });
      source.requestCommand(phase as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      const requestId = sendEnvelopeMock.mock.calls[0][0].requestId;
      fire(
        CoopSession.CHOOSE_COMMAND_RECEIVED,
        makeChooseCommand(requestId, { kind: "FIGHT", moveIndex: 1, targets: [4] }),
      );
      expect(phase.handleCommand).toHaveBeenCalledWith(
        Command.FIGHT,
        1,
        MoveUseMode.NORMAL,
        expect.objectContaining({ move: 45, targets: [4], useMode: MoveUseMode.NORMAL }),
      );
    });

    it("FIGHT response with targets=null falls back to getDefaultTargets stub", async () => {
      const { session, sendEnvelopeMock, fire } = makeMockSession();
      const source = makeSource(session);
      const phase = makeFakePhase({ moveset: [{ moveId: 33 }] });
      source.requestCommand(phase as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      const requestId = sendEnvelopeMock.mock.calls[0][0].requestId;
      fire(
        CoopSession.CHOOSE_COMMAND_RECEIVED,
        makeChooseCommand(requestId, { kind: "FIGHT", moveIndex: 0, targets: null }),
      );
      expect(phase.handleCommand).toHaveBeenCalledWith(
        Command.FIGHT,
        0,
        MoveUseMode.NORMAL,
        expect.objectContaining({ move: 33, targets: [3], useMode: MoveUseMode.NORMAL }),
      );
    });

    it("FIGHT response with invalid moveIndex resolves with default move", async () => {
      const { session, sendEnvelopeMock, fire } = makeMockSession();
      const source = makeSource(session);
      const phase = makeFakePhase({ moveset: [{ moveId: 33 }] });
      source.requestCommand(phase as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      const requestId = sendEnvelopeMock.mock.calls[0][0].requestId;
      fire(
        CoopSession.CHOOSE_COMMAND_RECEIVED,
        makeChooseCommand(requestId, { kind: "FIGHT", moveIndex: 99, targets: null }),
      );
      expect(phase.handleCommand).toHaveBeenCalled();
      const call = phase.handleCommand.mock.calls[0];
      expect(call[0]).toBe(Command.FIGHT);
      expect(call[1]).toBe(0);
    });
  });

  describe("response handling — RUN", () => {
    it("RUN response calls phase.handleCommand(Command.RUN, -1)", async () => {
      const { session, sendEnvelopeMock, fire } = makeMockSession();
      const source = makeSource(session);
      const phase = makeFakePhase();
      source.requestCommand(phase as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      const requestId = sendEnvelopeMock.mock.calls[0][0].requestId;
      fire(CoopSession.CHOOSE_COMMAND_RECEIVED, makeChooseCommand(requestId, { kind: "RUN" }));
      expect(phase.handleCommand).toHaveBeenCalledWith(Command.RUN, -1);
    });
  });

  describe("response handling — CANCEL (M1 cancel-rollback)", () => {
    it("CANCEL response calls phase.cancel()", async () => {
      const { session, sendEnvelopeMock, fire } = makeMockSession();
      const source = makeSource(session);
      const phase = makeFakePhase();
      source.requestCommand(phase as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      const requestId = sendEnvelopeMock.mock.calls[0][0].requestId;
      fire(CoopSession.CHOOSE_COMMAND_RECEIVED, makeChooseCommand(requestId, { kind: "CANCEL" }));
      expect(phase.cancel).toHaveBeenCalled();
      expect(phase.handleCommand).not.toHaveBeenCalled();
    });

    it("CANCEL clears pending state", async () => {
      const { session, sendEnvelopeMock, fire } = makeMockSession();
      const source = makeSource(session);
      const phase = makeFakePhase();
      source.requestCommand(phase as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      const requestId = sendEnvelopeMock.mock.calls[0][0].requestId;
      fire(CoopSession.CHOOSE_COMMAND_RECEIVED, makeChooseCommand(requestId, { kind: "CANCEL" }));
      fire(CoopSession.CHOOSE_COMMAND_RECEIVED, makeChooseCommand(requestId, { kind: "RUN" }));
      expect(phase.handleCommand).not.toHaveBeenCalled();
    });
  });

  describe("response handling — correlation", () => {
    it("response with non-matching requestId is dropped", async () => {
      const { session, fire } = makeMockSession();
      const source = makeSource(session);
      const phase = makeFakePhase();
      source.requestCommand(phase as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      fire(CoopSession.CHOOSE_COMMAND_RECEIVED, makeChooseCommand("totally-different-id", { kind: "RUN" }));
      expect(phase.handleCommand).not.toHaveBeenCalled();
    });

    it("response after a previous response is dropped (no double-resolution)", async () => {
      const { session, sendEnvelopeMock, fire } = makeMockSession();
      const source = makeSource(session);
      const phase = makeFakePhase();
      source.requestCommand(phase as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      const requestId = sendEnvelopeMock.mock.calls[0][0].requestId;
      fire(CoopSession.CHOOSE_COMMAND_RECEIVED, makeChooseCommand(requestId, { kind: "RUN" }));
      fire(CoopSession.CHOOSE_COMMAND_RECEIVED, makeChooseCommand(requestId, { kind: "RUN" }));
      expect(phase.handleCommand).toHaveBeenCalledTimes(1);
    });

    it("response with no pending request is silently dropped", () => {
      const { session, fire } = makeMockSession();
      makeSource(session);
      expect(() =>
        fire(CoopSession.CHOOSE_COMMAND_RECEIVED, makeChooseCommand("any-id", { kind: "RUN" })),
      ).not.toThrow();
    });
  });

  describe("timeout", () => {
    it("after timeoutMs elapses, calls phase.handleCommand with default move", async () => {
      const { session } = makeMockSession();
      const source = makeSource(session, { timeoutMs: 30_000 });
      const phase = makeFakePhase({ moveset: [{ moveId: 99 }] });
      source.requestCommand(phase as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(phase.handleCommand).toHaveBeenCalledWith(
        Command.FIGHT,
        0,
        MoveUseMode.NORMAL,
        expect.objectContaining({ move: 99, targets: [3] }),
      );
    });

    it("timeout queues a battle-log message", async () => {
      const { scene, queueMessageMock } = makeFakeScene();
      const { session } = makeMockSession();
      const source = makeSource(session, { timeoutMs: 1_000 }, scene);
      const phase = makeFakePhase({ moveset: [{ moveId: 1 }] });
      source.requestCommand(phase as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(queueMessageMock).toHaveBeenCalledWith(expect.stringContaining("Joiner timed out"));
    });

    it("timeout sends cancel-command-request envelope", async () => {
      const { session, sendEnvelopeMock } = makeMockSession();
      const source = makeSource(session, { timeoutMs: 1_000 });
      const phase = makeFakePhase({ moveset: [{ moveId: 1 }] });
      source.requestCommand(phase as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      const requestId = sendEnvelopeMock.mock.calls[0][0].requestId;
      sendEnvelopeMock.mockClear();
      await vi.advanceTimersByTimeAsync(1_000);
      const cancelEnvelope = sendEnvelopeMock.mock.calls.find(c => c[0]?.type === "cancel-command-request");
      expect(cancelEnvelope).toBeDefined();
      expect(cancelEnvelope![0].requestId).toBe(requestId);
    });

    it("with no usable moves, timeout falls back to struggle (cursor=-1)", async () => {
      const { session } = makeMockSession();
      const source = makeSource(session, { timeoutMs: 1_000 });
      const phase = makeFakePhase({ moveset: [{ moveId: 1, usable: false }] });
      source.requestCommand(phase as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(phase.handleCommand).toHaveBeenCalledWith(Command.FIGHT, -1);
    });
  });

  describe("bot-fill mode", () => {
    it("does NOT send any envelope", async () => {
      const { session, sendEnvelopeMock, broadcastSnapshotMock } = makeMockSession();
      const source = makeSource(session, { botFillJoiner: true });
      const phase = makeFakePhase({ moveset: [{ moveId: 7 }] });
      source.requestCommand(phase as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      expect(sendEnvelopeMock).not.toHaveBeenCalled();
      expect(broadcastSnapshotMock).not.toHaveBeenCalled();
    });

    it("calls phase.handleCommand asynchronously with default move", async () => {
      const { session } = makeMockSession();
      const source = makeSource(session, { botFillJoiner: true });
      const phase = makeFakePhase({ moveset: [{ moveId: 7 }] });
      source.requestCommand(phase as unknown as CommandPhase);
      expect(phase.handleCommand).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      expect(phase.handleCommand).toHaveBeenCalledWith(
        Command.FIGHT,
        0,
        MoveUseMode.NORMAL,
        expect.objectContaining({ move: 7 }),
      );
    });
  });

  describe("cancelPending", () => {
    it("does not throw when nothing is pending", () => {
      const { session } = makeMockSession();
      const source = makeSource(session);
      expect(() => source.cancelPending()).not.toThrow();
    });

    it("sends a cancel-command-request envelope with the pending requestId", async () => {
      const { session, sendEnvelopeMock } = makeMockSession();
      const source = makeSource(session);
      source.requestCommand(makeFakePhase() as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      const requestId = sendEnvelopeMock.mock.calls[0][0].requestId;
      sendEnvelopeMock.mockClear();
      source.cancelPending();
      const cancelEnvelope = sendEnvelopeMock.mock.calls.find(c => c[0]?.type === "cancel-command-request");
      expect(cancelEnvelope).toBeDefined();
      expect(cancelEnvelope![0].requestId).toBe(requestId);
    });

    it("clears state without calling phase.handleCommand or phase.cancel", async () => {
      const { session, fire, sendEnvelopeMock } = makeMockSession();
      const source = makeSource(session);
      const phase = makeFakePhase();
      source.requestCommand(phase as unknown as CommandPhase);
      await vi.advanceTimersByTimeAsync(0);
      const requestId = sendEnvelopeMock.mock.calls[0][0].requestId;
      source.cancelPending();
      expect(phase.handleCommand).not.toHaveBeenCalled();
      expect(phase.cancel).not.toHaveBeenCalled();
      fire(CoopSession.CHOOSE_COMMAND_RECEIVED, makeChooseCommand(requestId, { kind: "RUN" }));
      expect(phase.handleCommand).not.toHaveBeenCalled();
    });
  });
});
