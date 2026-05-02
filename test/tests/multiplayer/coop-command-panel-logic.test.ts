import { type CoopCommandPanelDeps, CoopCommandPanelLogic } from "#app/multiplayer/coop-command-panel-logic";
import type { CancelCommandRequestMessage, RequestCommandMessage } from "#app/multiplayer/network/messages";
import type { BattleSnapshot, PokemonView } from "#app/multiplayer/network/snapshot";
import { describe, expect, it, vi } from "vitest";

function makeRequestCommand(requestId: string): RequestCommandMessage {
  return {
    type: "request-command",
    requestId,
    fieldIndex: 1,
    snapshotTurn: 0,
    allowedCommands: ["FIGHT", "RUN"],
    forcedKind: null,
  };
}

function makeCancelCommandRequest(requestId: string): CancelCommandRequestMessage {
  return { type: "cancel-command-request", requestId, reason: null };
}

function makePokemonView(overrides: Partial<PokemonView> = {}): PokemonView {
  return {
    id: 1,
    species: 25,
    name: "Pikachu",
    level: 50,
    hp: 100,
    maxHp: 100,
    status: null,
    isShiny: false,
    moves: [
      { id: 33, name: "Tackle", ppRemaining: 35, ppMax: 35 },
      { id: 45, name: "Growl", ppRemaining: 40, ppMax: 40 },
    ],
    ...overrides,
  };
}

function makeSnapshot(
  opts: { ownPokemon?: PokemonView | null; foe0?: PokemonView | null; foe1?: PokemonView | null } = {},
): BattleSnapshot {
  return {
    field: {
      slot0: null,
      slot1: opts.ownPokemon === undefined ? makePokemonView() : opts.ownPokemon,
      foe0: opts.foe0 === undefined ? makePokemonView({ id: 100, species: 16, name: "Pidgey" }) : opts.foe0,
      foe1: opts.foe1 === undefined ? makePokemonView({ id: 101, species: 19, name: "Rattata" }) : opts.foe1,
    },
    weather: null,
    recentLog: [],
  };
}

interface DepsHandle {
  deps: CoopCommandPanelDeps;
  sendChooseCommandMock: ReturnType<typeof vi.fn>;
  setRequiresPicker: (fn: (moveId: number) => boolean) => void;
}

function makeDeps(opts: { requiresEnemyPicker?: (moveId: number) => boolean } = {}): DepsHandle {
  const sendChooseCommandMock = vi.fn();
  let requiresEnemyPicker = opts.requiresEnemyPicker ?? ((_id: number) => false);
  const deps: CoopCommandPanelDeps = {
    sendChooseCommand: (command, requestId) => sendChooseCommandMock(command, requestId),
    requiresEnemyPicker: (moveId: number) => requiresEnemyPicker(moveId),
  };
  return {
    deps,
    sendChooseCommandMock,
    setRequiresPicker: fn => {
      requiresEnemyPicker = fn;
    },
  };
}

describe("CoopCommandPanelLogic", () => {
  describe("initial state", () => {
    it("starts in idle", () => {
      const { deps } = makeDeps();
      const logic = new CoopCommandPanelLogic(deps);
      expect(logic.getState().kind).toBe("idle");
    });

    it("getSnapshot returns null before any update", () => {
      const { deps } = makeDeps();
      const logic = new CoopCommandPanelLogic(deps);
      expect(logic.getSnapshot()).toBeNull();
    });
  });

  describe("event handling", () => {
    it("onRequestCommand transitions idle -> request-active.move-select", () => {
      const { deps } = makeDeps();
      const logic = new CoopCommandPanelLogic(deps);
      logic.onRequestCommand(makeRequestCommand("req-1"));
      const state = logic.getState();
      expect(state.kind).toBe("request-active");
      if (state.kind === "request-active") {
        expect(state.requestId).toBe("req-1");
        expect(state.substate).toBe("move-select");
      }
    });

    it("onSnapshotUpdate stores the latest snapshot", () => {
      const { deps } = makeDeps();
      const logic = new CoopCommandPanelLogic(deps);
      const snap = makeSnapshot();
      logic.onSnapshotUpdate(snap);
      expect(logic.getSnapshot()).toBe(snap);
    });
  });

  describe("onMoveSelected", () => {
    it("non-target-picker move sends FIGHT envelope with targets=null and transitions to submitted", () => {
      const { deps, sendChooseCommandMock } = makeDeps({ requiresEnemyPicker: () => false });
      const logic = new CoopCommandPanelLogic(deps);
      logic.onSnapshotUpdate(makeSnapshot());
      logic.onRequestCommand(makeRequestCommand("req-1"));
      logic.onMoveSelected(0);
      expect(sendChooseCommandMock).toHaveBeenCalledWith({ kind: "FIGHT", moveIndex: 0, targets: null }, "req-1");
      const state = logic.getState();
      expect(state.kind).toBe("submitted");
      if (state.kind === "submitted") {
        expect(state.requestId).toBe("req-1");
      }
    });

    it("multi-target-enemy move (both foes alive) opens target picker", () => {
      const { deps, sendChooseCommandMock } = makeDeps({ requiresEnemyPicker: () => true });
      const logic = new CoopCommandPanelLogic(deps);
      logic.onSnapshotUpdate(makeSnapshot());
      logic.onRequestCommand(makeRequestCommand("req-1"));
      logic.onMoveSelected(0);
      expect(sendChooseCommandMock).not.toHaveBeenCalled();
      const state = logic.getState();
      expect(state.kind).toBe("request-active");
      if (state.kind === "request-active") {
        expect(state.substate).toBe("target-select");
        expect(state.pendingMoveIndex).toBe(0);
      }
    });

    it("multi-target-enemy move with only one foe alive auto-defaults (no picker)", () => {
      const { deps, sendChooseCommandMock } = makeDeps({ requiresEnemyPicker: () => true });
      const logic = new CoopCommandPanelLogic(deps);
      logic.onSnapshotUpdate(makeSnapshot({ foe1: null }));
      logic.onRequestCommand(makeRequestCommand("req-1"));
      logic.onMoveSelected(0);
      expect(sendChooseCommandMock).toHaveBeenCalledWith({ kind: "FIGHT", moveIndex: 0, targets: null }, "req-1");
      expect(logic.getState().kind).toBe("submitted");
    });

    it("ignores onMoveSelected when not in request-active state", () => {
      const { deps, sendChooseCommandMock } = makeDeps();
      const logic = new CoopCommandPanelLogic(deps);
      logic.onMoveSelected(0);
      expect(sendChooseCommandMock).not.toHaveBeenCalled();
      expect(logic.getState().kind).toBe("idle");
    });
  });

  describe("onTargetSelected", () => {
    it("sends FIGHT envelope with the chosen battlerIndex and transitions to submitted", () => {
      const { deps, sendChooseCommandMock } = makeDeps({ requiresEnemyPicker: () => true });
      const logic = new CoopCommandPanelLogic(deps);
      logic.onSnapshotUpdate(makeSnapshot());
      logic.onRequestCommand(makeRequestCommand("req-1"));
      logic.onMoveSelected(0);
      logic.onTargetSelected(2);
      expect(sendChooseCommandMock).toHaveBeenCalledWith({ kind: "FIGHT", moveIndex: 0, targets: [2] }, "req-1");
      expect(logic.getState().kind).toBe("submitted");
    });

    it("ignores onTargetSelected when not in target-select substate", () => {
      const { deps, sendChooseCommandMock } = makeDeps();
      const logic = new CoopCommandPanelLogic(deps);
      logic.onRequestCommand(makeRequestCommand("req-1"));
      logic.onTargetSelected(2);
      expect(sendChooseCommandMock).not.toHaveBeenCalled();
    });
  });

  describe("onTargetBack", () => {
    it("returns to move-select substate without sending an envelope", () => {
      const { deps, sendChooseCommandMock } = makeDeps({ requiresEnemyPicker: () => true });
      const logic = new CoopCommandPanelLogic(deps);
      logic.onSnapshotUpdate(makeSnapshot());
      logic.onRequestCommand(makeRequestCommand("req-1"));
      logic.onMoveSelected(0);
      logic.onTargetBack();
      const state = logic.getState();
      expect(state.kind).toBe("request-active");
      if (state.kind === "request-active") {
        expect(state.substate).toBe("move-select");
      }
      expect(sendChooseCommandMock).not.toHaveBeenCalled();
    });
  });

  describe("onRunSelected", () => {
    it("sends RUN envelope and transitions to submitted", () => {
      const { deps, sendChooseCommandMock } = makeDeps();
      const logic = new CoopCommandPanelLogic(deps);
      logic.onRequestCommand(makeRequestCommand("req-1"));
      logic.onRunSelected();
      expect(sendChooseCommandMock).toHaveBeenCalledWith({ kind: "RUN" }, "req-1");
      expect(logic.getState().kind).toBe("submitted");
    });

    it("ignores onRunSelected when in idle state", () => {
      const { deps, sendChooseCommandMock } = makeDeps();
      const logic = new CoopCommandPanelLogic(deps);
      logic.onRunSelected();
      expect(sendChooseCommandMock).not.toHaveBeenCalled();
    });
  });

  describe("onCancelRequest", () => {
    it("transitions request-active -> idle", () => {
      const { deps } = makeDeps();
      const logic = new CoopCommandPanelLogic(deps);
      logic.onRequestCommand(makeRequestCommand("req-1"));
      logic.onCancelRequest(makeCancelCommandRequest("req-1"));
      expect(logic.getState().kind).toBe("idle");
    });

    it("transitions submitted -> idle", () => {
      const { deps } = makeDeps();
      const logic = new CoopCommandPanelLogic(deps);
      logic.onRequestCommand(makeRequestCommand("req-1"));
      logic.onRunSelected();
      expect(logic.getState().kind).toBe("submitted");
      logic.onCancelRequest(makeCancelCommandRequest("req-1"));
      expect(logic.getState().kind).toBe("idle");
    });
  });

  describe("re-issued request after submitted", () => {
    it("transitions submitted -> request-active.move-select with new requestId", () => {
      const { deps } = makeDeps();
      const logic = new CoopCommandPanelLogic(deps);
      logic.onRequestCommand(makeRequestCommand("req-1"));
      logic.onRunSelected();
      expect(logic.getState().kind).toBe("submitted");
      logic.onRequestCommand(makeRequestCommand("req-2"));
      const state = logic.getState();
      expect(state.kind).toBe("request-active");
      if (state.kind === "request-active") {
        expect(state.requestId).toBe("req-2");
        expect(state.substate).toBe("move-select");
      }
    });
  });

  describe("requestId correlation", () => {
    it("the choose-command envelope echoes the requestId from the request-command envelope", () => {
      const { deps, sendChooseCommandMock } = makeDeps();
      const logic = new CoopCommandPanelLogic(deps);
      logic.onRequestCommand(makeRequestCommand("special-id-xyz"));
      logic.onRunSelected();
      const callArgs = sendChooseCommandMock.mock.calls[0];
      expect(callArgs[1]).toBe("special-id-xyz");
    });
  });
});
