import Overrides from "#app/overrides";
import { TurnCommandManager } from "#app/turn-command-manager";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#app/global-scene", () => ({
  globalScene: {
    coopSession: {},
    coopMode: "single",
    inputController: { getAllSources: () => [] },
  },
}));

import { globalScene } from "#app/global-scene";

describe("TurnCommandManager", () => {
  let tcm: TurnCommandManager;

  beforeEach(() => {
    tcm = new TurnCommandManager();
    (globalScene as any).coopSession = {};
    (globalScene as any).coopMode = "single";
    vi.spyOn(Overrides, "LOCAL_HOTSEAT_OVERRIDE", "get").mockReturnValue(false);
    vi.spyOn(Overrides, "COOP_NETWORKED_OVERRIDE", "get").mockReturnValue(false);
    vi.spyOn(Overrides, "COOP_BOT_FILL_JOINER", "get").mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("init methods", () => {
    it("initSinglePlayer registers LocalUiCommandSource for slot 0; slot 1 maps to the same owner", () => {
      tcm.initSinglePlayer();
      const s0 = tcm.getCommandSource({ kind: "field-slot", fieldIndex: 0 });
      expect(s0.kind).toBe("local-ui");
      expect(s0.playerSlot).toBe(0);
      const s1 = tcm.getCommandSource({ kind: "field-slot", fieldIndex: 1 });
      expect(s1).toBe(s0);
    });

    it("initHotseat registers LocalUiCommandSource for both slots", () => {
      tcm.initHotseat();
      const s0 = tcm.getCommandSource({ kind: "field-slot", fieldIndex: 0 });
      const s1 = tcm.getCommandSource({ kind: "field-slot", fieldIndex: 1 });
      expect(s0.kind).toBe("local-ui");
      expect(s1.kind).toBe("local-ui");
      expect(s0.playerSlot).toBe(0);
      expect(s1.playerSlot).toBe(1);
    });

    it("initCoopHost registers LocalUiCommandSource for slot 0 and NetworkCommandSource for slot 1", () => {
      tcm.initCoopHost();
      const s0 = tcm.getCommandSource({ kind: "field-slot", fieldIndex: 0 });
      const s1 = tcm.getCommandSource({ kind: "field-slot", fieldIndex: 1 });
      expect(s0.kind).toBe("local-ui");
      expect(s0.playerSlot).toBe(0);
      expect(s1.kind).toBe("network");
      expect(s1.playerSlot).toBe(1);
    });

    it("initCoopJoiner registers LocalUiCommandSource for slot 1; slot 0 throws", () => {
      tcm.initCoopJoiner();
      const s1 = tcm.getCommandSource({ kind: "field-slot", fieldIndex: 1 });
      expect(s1.kind).toBe("local-ui");
      expect(s1.playerSlot).toBe(1);
      expect(() => tcm.getCommandSource({ kind: "field-slot", fieldIndex: 0 })).toThrow();
    });
  });

  describe("refreshFromOverrides routing (override-driven)", () => {
    it("routes to initCoopHost when COOP_NETWORKED_OVERRIDE === 'host'", () => {
      vi.spyOn(Overrides, "COOP_NETWORKED_OVERRIDE", "get").mockReturnValue("host");
      tcm.refreshFromOverrides();
      expect(tcm.getCommandSource({ kind: "field-slot", fieldIndex: 1 }).kind).toBe("network");
    });

    it("routes to initCoopJoiner when COOP_NETWORKED_OVERRIDE === 'joiner'", () => {
      vi.spyOn(Overrides, "COOP_NETWORKED_OVERRIDE", "get").mockReturnValue("joiner");
      tcm.refreshFromOverrides();
      const s1 = tcm.getCommandSource({ kind: "field-slot", fieldIndex: 1 });
      expect(s1.kind).toBe("local-ui");
      expect(() => tcm.getCommandSource({ kind: "field-slot", fieldIndex: 0 })).toThrow();
    });

    it("routes to initHotseat when LOCAL_HOTSEAT_OVERRIDE === true and no coop override set", () => {
      vi.spyOn(Overrides, "LOCAL_HOTSEAT_OVERRIDE", "get").mockReturnValue(true);
      tcm.refreshFromOverrides();
      const s0 = tcm.getCommandSource({ kind: "field-slot", fieldIndex: 0 });
      const s1 = tcm.getCommandSource({ kind: "field-slot", fieldIndex: 1 });
      expect(s0.kind).toBe("local-ui");
      expect(s1.kind).toBe("local-ui");
      expect(s0.playerSlot).toBe(0);
      expect(s1.playerSlot).toBe(1);
    });

    it("routes to initSinglePlayer when no flags set", () => {
      tcm.refreshFromOverrides();
      const s = tcm.getCommandSource({ kind: "field-slot", fieldIndex: 0 });
      expect(s.kind).toBe("local-ui");
      expect(s.playerSlot).toBe(0);
    });
  });
});
