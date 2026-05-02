import { CoopCommandPanelLogic } from "#app/multiplayer/coop-command-panel-logic";
import { CoopSession } from "#app/multiplayer/network/coop-session";
import type {
  CancelCommandRequestMessage,
  ChooseCommandMessage,
  RequestCommandMessage,
  RunEndMessage,
  StartRunMessage,
  StateSnapshotMessage,
} from "#app/multiplayer/network/messages";
import {
  NetworkCommandSource,
  type NetworkCommandSourceOptions,
} from "#app/multiplayer/network/network-command-source";
import type { BattleSnapshot } from "#app/multiplayer/network/snapshot";
import { Command } from "#enums/command";
import { MoveUseMode } from "#enums/move-use-mode";
import type { CommandPhase } from "#phases/command-phase";
import { type CoopPair, flushBridgeAsync, makeCoopPair } from "#test/helpers/fake-coop-session";
import { beforeEach, describe, expect, it, vi } from "vitest";

function emptySnapshot(): BattleSnapshot {
  return {
    field: { slot0: null, slot1: null, foe0: null, foe1: null },
    weather: null,
    recentLog: [],
  };
}

function makeFakePhase() {
  return {
    fieldIndex: 1,
    getFieldIndex: () => 1,
    getPokemon: () => ({
      getMoveset: () => [
        { moveId: 33, isUsable: () => [true, ""] },
        { moveId: 45, isUsable: () => [true, ""] },
      ],
    }),
    handleCommand: vi.fn().mockReturnValue(true),
    cancel: vi.fn(),
  };
}

function makeFakeScene() {
  return {
    currentBattle: { turn: 5 },
    phaseManager: { queueMessage: vi.fn() },
    getPlayerField: () => [],
    getEnemyField: () => [],
    arena: { weather: null },
    messageLog: { getRecent: () => [] },
  };
}

function ncsOptsForTest(extra: NetworkCommandSourceOptions = {}): NetworkCommandSourceOptions {
  const scene = makeFakeScene();
  return {
    getDefaultTargets: () => [3],
    getScene: () => scene as any,
    ...extra,
  };
}

describe("Coop integration", () => {
  let pair: CoopPair;

  beforeEach(async () => {
    pair = await makeCoopPair();
  });

  describe("session setup", () => {
    it("both sides reach CONNECTED after handshake", () => {
      expect(pair.host.getState().kind).toBe("CONNECTED");
      expect(pair.joiner.getState().kind).toBe("CONNECTED");
    });

    it("host's role is 'host', joiner's role is 'joiner'", () => {
      const hostState = pair.host.getState();
      const joinerState = pair.joiner.getState();
      expect(hostState.kind === "CONNECTED" && hostState.role).toBe("host");
      expect(joinerState.kind === "CONNECTED" && joinerState.role).toBe("joiner");
    });
  });

  describe("start-run envelope", () => {
    it("host sends start-run, joiner emits START_RUN_RECEIVED with correct seed", async () => {
      const handler = vi.fn();
      pair.joiner.on(CoopSession.START_RUN_RECEIVED, handler);
      const envelope: StartRunMessage = {
        type: "start-run",
        seed: "test-seed-12345",
        startingWave: 1,
      };
      await pair.host.sendEnvelope(envelope);
      await flushBridgeAsync();
      expect(handler).toHaveBeenCalledWith(envelope);
    });
  });

  describe("run-end envelope", () => {
    it("host sends run-end, joiner emits RUN_END_RECEIVED", async () => {
      const handler = vi.fn();
      pair.joiner.on(CoopSession.RUN_END_RECEIVED, handler);
      const envelope: RunEndMessage = { type: "run-end", reason: "victory" };
      await pair.host.sendEnvelope(envelope);
      await flushBridgeAsync();
      expect(handler).toHaveBeenCalledWith(envelope);
    });
  });

  describe("state-snapshot envelope", () => {
    it("host's broadcast updates joiner's SnapshotStore and fires SNAPSHOT_UPDATE", async () => {
      const handler = vi.fn();
      pair.joiner.on(CoopSession.SNAPSHOT_UPDATE, handler);
      const snap = emptySnapshot();
      const envelope: StateSnapshotMessage = { type: "state-snapshot", turn: 7, payload: snap };
      await pair.host.sendEnvelope(envelope);
      await flushBridgeAsync();
      expect(pair.joiner.getSnapshotStore().getCurrent()?.turn).toBe(7);
      expect(handler).toHaveBeenCalledWith(snap, 7);
    });
  });

  describe("request-command roundtrip", () => {
    it("NetworkCommandSource.requestCommand on host delivers request-command to joiner", async () => {
      const ncs = new NetworkCommandSource(1, pair.host, ncsOptsForTest());
      const phase = makeFakePhase();
      ncs.requestCommand(phase as unknown as CommandPhase);
      await flushBridgeAsync();
      // Joiner should have received a state-snapshot AND a request-command
      const sent = pair.hostTransport.sent;
      const types = sent.map(s => s.envelope.type);
      expect(types).toContain("state-snapshot");
      expect(types).toContain("request-command");
    });

    it("joiner's CoopCommandPanelLogic transitions to request-active on REQUEST_COMMAND_RECEIVED", async () => {
      const sendChooseCommand = (command: ChooseCommandMessage["command"], requestId: string) => {
        void pair.joiner.sendEnvelope({ type: "choose-command", requestId, command });
      };
      const logic = new CoopCommandPanelLogic({
        sendChooseCommand,
        requiresEnemyPicker: () => false,
      });
      pair.joiner.on(CoopSession.REQUEST_COMMAND_RECEIVED, (env: RequestCommandMessage) => logic.onRequestCommand(env));

      const ncs = new NetworkCommandSource(1, pair.host, ncsOptsForTest());
      const phase = makeFakePhase();
      ncs.requestCommand(phase as unknown as CommandPhase);
      await flushBridgeAsync();

      const state = logic.getState();
      expect(state.kind).toBe("request-active");
    });

    it("end-to-end: joiner picks RUN, host's NetworkCommandSource calls phase.handleCommand(RUN, -1)", async () => {
      const sendChooseCommand = (command: ChooseCommandMessage["command"], requestId: string) => {
        void pair.joiner.sendEnvelope({ type: "choose-command", requestId, command });
      };
      const logic = new CoopCommandPanelLogic({
        sendChooseCommand,
        requiresEnemyPicker: () => false,
      });
      pair.joiner.on(CoopSession.REQUEST_COMMAND_RECEIVED, (env: RequestCommandMessage) => logic.onRequestCommand(env));

      const ncs = new NetworkCommandSource(1, pair.host, ncsOptsForTest());
      const phase = makeFakePhase();
      ncs.requestCommand(phase as unknown as CommandPhase);
      await flushBridgeAsync();

      logic.onRunSelected();
      await flushBridgeAsync();

      expect(phase.handleCommand).toHaveBeenCalledWith(Command.RUN, -1);
    });

    it("end-to-end: joiner picks FIGHT with explicit targets, host resolves with that turnMove", async () => {
      const sendChooseCommand = (command: ChooseCommandMessage["command"], requestId: string) => {
        void pair.joiner.sendEnvelope({ type: "choose-command", requestId, command });
      };
      const logic = new CoopCommandPanelLogic({
        sendChooseCommand,
        requiresEnemyPicker: () => true,
      });
      pair.joiner.on(CoopSession.REQUEST_COMMAND_RECEIVED, (env: RequestCommandMessage) => logic.onRequestCommand(env));
      pair.joiner.on(CoopSession.SNAPSHOT_UPDATE, (snapshot: BattleSnapshot) => logic.onSnapshotUpdate(snapshot));

      // Order matters: ncs.requestCommand auto-broadcasts an empty snapshot from the test fake scene,
      // which would overwrite a populated snapshot if sent first. Send the populated snapshot AFTER
      // ncs.requestCommand so it lands last in the joiner's SnapshotStore.
      const ncs = new NetworkCommandSource(1, pair.host, ncsOptsForTest());
      const phase = makeFakePhase();
      ncs.requestCommand(phase as unknown as CommandPhase);
      await flushBridgeAsync();

      await pair.host.sendEnvelope({
        type: "state-snapshot",
        turn: 1,
        payload: {
          field: {
            slot0: null,
            slot1: {
              id: 1,
              species: 25,
              name: "Pikachu",
              level: 50,
              hp: 100,
              maxHp: 100,
              status: null,
              isShiny: false,
              moves: [{ id: 33, name: "Tackle", ppRemaining: 35, ppMax: 35 }],
            },
            foe0: {
              id: 100,
              species: 16,
              name: "Pidgey",
              level: 5,
              hp: 14,
              maxHp: 15,
              status: null,
              isShiny: false,
              moves: [],
            },
            foe1: {
              id: 101,
              species: 19,
              name: "Rattata",
              level: 5,
              hp: 18,
              maxHp: 18,
              status: null,
              isShiny: false,
              moves: [],
            },
          },
          weather: null,
          recentLog: [],
        },
      });
      await flushBridgeAsync();

      logic.onMoveSelected(0); // opens target picker
      logic.onTargetSelected(2); // picks foe0
      await flushBridgeAsync();

      expect(phase.handleCommand).toHaveBeenCalledWith(
        Command.FIGHT,
        0,
        MoveUseMode.NORMAL,
        expect.objectContaining({ move: 33, targets: [2] }),
      );
    });
  });

  describe("cancel-command-request envelope", () => {
    it("host sends cancel-command-request, joiner panel logic transitions to idle", async () => {
      const sendChooseCommand = (command: ChooseCommandMessage["command"], requestId: string) => {
        void pair.joiner.sendEnvelope({ type: "choose-command", requestId, command });
      };
      const logic = new CoopCommandPanelLogic({
        sendChooseCommand,
        requiresEnemyPicker: () => false,
      });
      pair.joiner.on(CoopSession.REQUEST_COMMAND_RECEIVED, (env: RequestCommandMessage) => logic.onRequestCommand(env));
      pair.joiner.on(CoopSession.CANCEL_COMMAND_REQUEST_RECEIVED, (env: CancelCommandRequestMessage) =>
        logic.onCancelRequest(env),
      );

      const ncs = new NetworkCommandSource(1, pair.host, ncsOptsForTest());
      const phase = makeFakePhase();
      ncs.requestCommand(phase as unknown as CommandPhase);
      await flushBridgeAsync();
      expect(logic.getState().kind).toBe("request-active");

      ncs.cancelPending();
      await flushBridgeAsync();
      expect(logic.getState().kind).toBe("idle");
    });

    it("joiner sends choose-command CANCEL, host's NetworkCommandSource calls phase.cancel()", async () => {
      const sendChooseCommand = (command: ChooseCommandMessage["command"], requestId: string) => {
        void pair.joiner.sendEnvelope({ type: "choose-command", requestId, command });
      };
      const logic = new CoopCommandPanelLogic({
        sendChooseCommand,
        requiresEnemyPicker: () => true,
      });
      pair.joiner.on(CoopSession.REQUEST_COMMAND_RECEIVED, (env: RequestCommandMessage) => logic.onRequestCommand(env));
      pair.joiner.on(CoopSession.SNAPSHOT_UPDATE, (snapshot: BattleSnapshot) => logic.onSnapshotUpdate(snapshot));

      // Set up snapshot with both foes alive so target picker opens
      logic.onSnapshotUpdate({
        field: {
          slot0: null,
          slot1: {
            id: 1,
            species: 25,
            name: "Pikachu",
            level: 50,
            hp: 100,
            maxHp: 100,
            status: null,
            isShiny: false,
            moves: [{ id: 33, name: "Tackle", ppRemaining: 35, ppMax: 35 }],
          },
          foe0: {
            id: 100,
            species: 16,
            name: "Pidgey",
            level: 5,
            hp: 14,
            maxHp: 15,
            status: null,
            isShiny: false,
            moves: [],
          },
          foe1: {
            id: 101,
            species: 19,
            name: "Rattata",
            level: 5,
            hp: 18,
            maxHp: 18,
            status: null,
            isShiny: false,
            moves: [],
          },
        },
        weather: null,
        recentLog: [],
      });

      const ncs = new NetworkCommandSource(1, pair.host, ncsOptsForTest());
      const phase = makeFakePhase();
      ncs.requestCommand(phase as unknown as CommandPhase);
      await flushBridgeAsync();

      // Joiner manually sends a CANCEL via the wire
      const requestId = (
        pair.hostTransport.sent.find(s => s.envelope.type === "request-command")?.envelope as RequestCommandMessage
      ).requestId;
      await pair.joiner.sendEnvelope({
        type: "choose-command",
        requestId,
        command: { kind: "CANCEL" },
      });
      await flushBridgeAsync();

      expect(phase.cancel).toHaveBeenCalled();
      expect(phase.handleCommand).not.toHaveBeenCalled();
    });
  });

  describe("disconnect handling", () => {
    it("peer-leave on host's transport during CONNECTED transitions host coopSession to IDLE", async () => {
      pair.hostTransport.triggerPeerLeave("joiner-peer");
      await flushBridgeAsync();
      expect(pair.host.getState().kind).toBe("IDLE");
    });

    it("peer-leave on joiner's transport during CONNECTED transitions joiner coopSession to IDLE", async () => {
      pair.joinerTransport.triggerPeerLeave("host-peer");
      await flushBridgeAsync();
      expect(pair.joiner.getState().kind).toBe("IDLE");
    });
  });
});
