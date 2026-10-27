/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { getPokemonNameWithAffix } from "#app/messages";
import {
  controllerOf,
  coopSwitchFilter,
  deciderOf,
  isAllowedSwitch,
  isPartnersPokemon,
  legalBench,
  notYourPokemonText,
  ownerOf,
  requireOwnerOf,
  switchTargets,
} from "#coop/control";
import { endCoopSession, requireCoopSession } from "#coop/session";
import { takeoverTargetLabel } from "#coop/takeover-command";
import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { PartyUiMode } from "#enums/party-ui-mode";
import { PlayerGender } from "#enums/player-gender";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { PlayerPokemon } from "#field/pokemon";
import {
  accountWith,
  advanceTo,
  type ClientConfig,
  type CoopRun,
  Decider,
  openCoopRun,
  type SharedRun,
} from "#test/helpers/coop-harness";
import { PartyOption, type PartyUiHandler } from "#ui/handlers/party-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The decider functions, on a real co-op party. Starters are named by owner: H1..H3 are the host's, G1..G3 the
 * guest's. At the start of a wave the party is H1 G1 H2 G2 H3 G3 and slot 0 and 1 hold H1 and G1.
 */

const ACCOUNT = accountWith({ trainerId: 111, secretId: 222 });

const SHARED: SharedRun = {
  runSeed: "co-op-m3-control",
  snapshot: { host: ACCOUNT, guest: ACCOUNT },
  hostPlayerGender: PlayerGender.MALE,
};

const HOST: ClientConfig = {
  seat: "host",
  liveAccount: ACCOUNT,
  localSettings: {},
  applyOverlay: true,
  bypassSnapshot: false,
  stallMs: 20_000,
};

describe("Co-op: who owns, controls and decides (D7, D9, D10)", () => {
  let phaserGame: Phaser.Game;
  let run: CoopRun | null = null;
  let party: PlayerPokemon[];
  const [H1, G1, H2, G2, H3, G3] = [0, 1, 2, 3, 4, 5];

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(async () => {
    run = await openCoopRun(phaserGame, SHARED, HOST, Decider.recording(), {
      species: [
        SpeciesId.BULBASAUR,
        SpeciesId.SQUIRTLE,
        SpeciesId.CHARMANDER,
        SpeciesId.PIKACHU,
        SpeciesId.MACHOP,
        SpeciesId.GEODUDE,
      ],
      waves: 0,
      moveset: [MoveId.BITE, MoveId.GROWL, MoveId.TAIL_WHIP, MoveId.LEER],
      faints: [],
      faintMove: MoveId.MEMENTO,
      starterOwners: ["host", "guest", "host", "guest", "host", "guest"],
    });
    await advanceTo(run.ctx, ["CommandPhase"]);
    party = run.ctx.game.scene.getPlayerParty();
  });

  afterEach(() => {
    run?.close();
    run = null;
  });

  const faint = (...indices: number[]): void => {
    for (const index of indices) {
      party[index].hp = 0;
    }
  };

  const ids = (pokemon: PlayerPokemon[]): number[] => pokemon.map(p => party.indexOf(p));

  it("starts with the host's Pokémon in slot 0 and the guest's in slot 1", () => {
    expect(party.map(p => requireOwnerOf(p))).toEqual(["host", "guest", "host", "guest", "host", "guest"]);
    expect([controllerOf(0), controllerOf(1)]).toEqual(["host", "guest"]);
    expect(ids(legalBench())).toEqual([H2, G2, H3, G3]);
  });

  it("an enemy has no owner, and neither has an empty or a fainted slot a controller", () => {
    const [enemy] = run!.ctx.game.scene.getEnemyField();
    expect(ownerOf(enemy)).toBeNull();
    expect(ownerOf(party[G2])).toBe("guest");
    faint(G1);
    expect(controllerOf(1)).toBeNull();
    expect(controllerOf(0)).toBe("host");
  });

  describe("switchTargets", () => {
    it("voluntary: the controller's own bench", () => {
      expect(ids(switchTargets(0, "voluntary"))).toEqual([H2, H3]);
      expect(ids(switchTargets(1, "voluntary"))).toEqual([G2, G3]);
    });

    it("voluntary: nothing for a slot nobody controls", () => {
      faint(G1);
      expect(switchTargets(1, "voluntary")).toEqual([]);
    });

    it("faint: the owner's bench", () => {
      faint(G1);
      expect(ids(switchTargets(1, "faint"))).toEqual([G2, G3]);
      faint(H1);
      expect(ids(switchTargets(0, "faint"))).toEqual([H2, H3]);
    });

    it("faint: the owner's bench is skipped over its fainted Pokémon", () => {
      faint(G1, G2);
      expect(ids(switchTargets(1, "faint"))).toEqual([G3]);
    });

    it("faint: with no bench of the owner's, the partner's", () => {
      faint(G1, G2, G3);
      expect(ids(switchTargets(1, "faint"))).toEqual([H2, H3]);
      // and the owner does not change: the guest's fainted Pokémon is still the guest's
      expect(requireOwnerOf(party[G1])).toBe("guest");
    });

    it("faint: with no bench at all, nothing (upstream behaviour)", () => {
      faint(G1, H2, G2, H3, G3);
      expect(switchTargets(1, "faint")).toEqual([]);
      expect(switchTargets(0, "voluntary")).toEqual([]);
    });
  });

  it("isAllowedSwitch follows the targets", () => {
    expect(isAllowedSwitch(0, H2, "voluntary")).toBe(true);
    expect(isAllowedSwitch(0, G2, "voluntary")).toBe(false);
    expect(isAllowedSwitch(1, G3, "voluntary")).toBe(true);
    expect(isAllowedSwitch(0, 99, "voluntary")).toBe(false);
    faint(G1);
    expect(isAllowedSwitch(1, G2, "faint")).toBe(true);
    expect(isAllowedSwitch(1, H2, "faint")).toBe(false);
  });

  describe("deciderOf", () => {
    it("commands: the controller of the slot", () => {
      expect(deciderOf({ kind: "TURN_COMMANDS", fieldIndex: 0 })).toBe("host");
      expect(deciderOf({ kind: "TURN_COMMANDS", fieldIndex: 1 })).toBe("guest");
      faint(G1);
      expect(deciderOf({ kind: "TURN_COMMANDS", fieldIndex: 1 })).toBeNull();
    });

    it("a faint switch: whoever owns the Pokémon that may be sent out", () => {
      faint(G1);
      expect(deciderOf({ kind: "FAINT_SWITCH", fieldIndex: 1 })).toBe("guest");
      faint(G2, G3);
      expect(deciderOf({ kind: "FAINT_SWITCH", fieldIndex: 1 })).toBe("host");
      faint(H2, H3);
      expect(deciderOf({ kind: "FAINT_SWITCH", fieldIndex: 1 })).toBeNull();
    });

    it("learn move and evolution: the owner of the Pokémon, wherever it is", () => {
      expect(deciderOf({ kind: "LEARN_MOVE", pokemonId: party[G3].id })).toBe("guest");
      expect(deciderOf({ kind: "EVOLUTION_CANCEL", pokemonId: party[H3].id })).toBe("host");
      expect(() => deciderOf({ kind: "LEARN_MOVE", pokemonId: -1 })).toThrow();
    });

    it("the catch is released by the one that threw it (the controller of the slot)", () => {
      expect(deciderOf({ kind: "CATCH_RELEASE", fieldIndex: 1 })).toBe("guest");
    });

    it("trades: the proposer proposes, the other accepts, both may cancel; the shop is for both", () => {
      expect(deciderOf({ kind: "TRADE_PROPOSE", proposer: "guest" })).toBe("guest");
      expect(deciderOf({ kind: "TRADE_ACCEPT", proposer: "guest" })).toBe("host");
      expect(deciderOf({ kind: "TRADE_CANCEL" })).toBe("either");
      expect(deciderOf({ kind: "SHOP_BUY" })).toBe("either");
    });

    it("rewards and the biome: the picker of the screen that is open, alternating, host first", () => {
      const session = requireCoopSession();
      const base = session.rewardPickCount;
      expect(deciderOf({ kind: "BIOME" })).toBe(session.lastRewardPicker);
      session.beginRewardScreen();
      const first = deciderOf({ kind: "REWARD_PICK" });
      expect(deciderOf({ kind: "REROLL" })).toBe(first);
      expect(deciderOf({ kind: "REWARD_TARGET" })).toBe(first);
      expect(deciderOf({ kind: "BIOME" })).toBe(first);
      session.beginRewardScreen();
      expect(deciderOf({ kind: "REWARD_PICK" })).toBe(first === "host" ? "guest" : "host");
      expect(session.rewardPickCount).toBe(base + 2);
    });
  });

  describe("coopSwitchFilter", () => {
    const upstream = (pokemon: PlayerPokemon): string | null => (pokemon.isAllowedInBattle() ? null : "fainted");

    it("lets through what upstream and the ownership rule allow", () => {
      const filter = coopSwitchFilter(1, "voluntary", upstream);
      expect(filter(party[G2])).toBeNull();
      expect(filter(party[G3])).toBeNull();
    });

    it("refuses the partner's Pokémon, with a message", () => {
      const filter = coopSwitchFilter(1, "voluntary", upstream);
      expect(filter(party[H2])).toEqual(expect.any(String));
      expect(filter(party[H2])).not.toBe("fainted");
    });

    it("says that a refused Pokémon is the partner's, and keeps the generic message for one that is not", () => {
      const filter = coopSwitchFilter(0, "voluntary", upstream);
      const partners = filter(party[G2]);
      expect(partners).toBe(notYourPokemonText(party[G2]));
      expect(partners).toContain(requireCoopSession().partnerName);
      expect(partners).toContain(getPokemonNameWithAffix(party[G2], false));
      // The host's own H2 is refused for the guest's slot, but it is not the partner's from where the host sits
      const generic = coopSwitchFilter(1, "voluntary", upstream)(party[H2]);
      expect(generic).toEqual(expect.any(String));
      expect(generic).not.toBe(notYourPokemonText(party[H2]));
    });

    it("keeps the upstream message first", () => {
      faint(G2);
      expect(coopSwitchFilter(1, "faint", upstream)(party[G2])).toBe("fainted");
    });

    it("on a faint, the partner's Pokémon are allowed once the owner's bench is empty", () => {
      faint(G1, G2, G3);
      const filter = coopSwitchFilter(1, "faint", upstream);
      expect(filter(party[H2])).toBeNull();
      expect(filter(party[H3])).toBeNull();
    });
  });

  describe("the party screen", () => {
    /**
     * The options the party screen offers for the first Pokémon, on the reward screen or not
     * @param prepare - Runs on the handler before the options are built
     */
    async function checkOptions(
      rewardScreen: boolean,
      prepare?: (handler: PartyUiHandler) => void,
      mode: PartyUiMode = PartyUiMode.CHECK,
    ): Promise<PartyOption[]> {
      const { game } = run!.ctx;
      if (rewardScreen) {
        const current = game.scene.phaseManager.getCurrentPhase();
        vi.spyOn(game.scene.phaseManager, "getCurrentPhase").mockReturnValue({
          is: (name: string) => name === "SelectModifierPhase",
          phaseName: "SelectModifierPhase",
        } as unknown as typeof current);
      }
      await game.scene.ui.setMode(UiMode.PARTY, mode, -1, () => {});
      const handler = game.scene.ui.getHandler() as PartyUiHandler;
      // Setting the same UI mode again does not show the handler again, so a call for another party mode sets it here
      (handler as unknown as { partyUiMode: PartyUiMode }).partyUiMode = mode;
      prepare?.(handler);
      handler.updateOptions();
      return [...(handler as unknown as { options: PartyOption[] }).options];
    }

    /** Makes the first Pokémon a fusion that has a form change item, which is what Unsplice and the toggles need */
    const withFusionAndFormItem = (handler: PartyUiHandler): void => {
      party[H1].fusionSpecies = party[G1].species;
      vi.spyOn(handler, "getFormChangeItemsModifiers").mockReturnValue([
        { active: false, type: { name: "Test Form Item" } } as unknown as ReturnType<
          PartyUiHandler["getFormChangeItemsModifiers"]
        >[number],
      ]);
    };

    const isFormChangeToggle = (option: PartyOption): boolean =>
      option >= PartyOption.FORM_CHANGE_ITEM && option < PartyOption.MOVE_1;

    it("offers no reorder and no release in a co-op run", async () => {
      expect(await checkOptions(false)).not.toContain(PartyOption.SWITCH);
      expect(await checkOptions(true)).not.toContain(PartyOption.RELEASE);
    });

    it("still offers both in a solo run", async () => {
      endCoopSession();
      expect(await checkOptions(false)).toContain(PartyOption.SWITCH);
      expect(await checkOptions(true)).toContain(PartyOption.RELEASE);
    });

    it("offers no option that changes a Pokémon on this client alone in a co-op run (check, on the reward screen)", async () => {
      const options = await checkOptions(true, withFusionAndFormItem);
      // what only reads stays
      expect(options).toContain(PartyOption.SUMMARY);
      expect(options).toContain(PartyOption.POKEDEX);
      expect(options).toContain(PartyOption.CANCEL);
      // what writes the nickname, pauseEvolutions, the fusion or the form does not
      expect(options).not.toContain(PartyOption.RENAME);
      expect(options).not.toContain(PartyOption.UNPAUSE_EVOLUTION);
      expect(options).not.toContain(PartyOption.UNSPLICE);
      expect(options.some(isFormChangeToggle)).toBe(false);
    });

    it("offers no Rename, Pause evolutions or Unsplice on the other modes of a co-op run either", async () => {
      for (const mode of [PartyUiMode.SELECT, PartyUiMode.MODIFIER, PartyUiMode.SPLICE, PartyUiMode.SWITCH]) {
        const options = await checkOptions(false, withFusionAndFormItem, mode);
        expect(options, `mode ${mode}`).toContain(PartyOption.SUMMARY);
        expect(options, `mode ${mode}`).not.toContain(PartyOption.RENAME);
        expect(options, `mode ${mode}`).not.toContain(PartyOption.UNPAUSE_EVOLUTION);
        expect(options, `mode ${mode}`).not.toContain(PartyOption.UNSPLICE);
      }
    });

    it("still offers all of them in a solo run", async () => {
      endCoopSession();
      const options = await checkOptions(true, withFusionAndFormItem);
      expect(options).toContain(PartyOption.RENAME);
      expect(options).toContain(PartyOption.UNPAUSE_EVOLUTION);
      expect(options).toContain(PartyOption.UNSPLICE);
      expect(options.some(isFormChangeToggle)).toBe(true);
      expect(await checkOptions(false, withFusionAndFormItem, PartyUiMode.SPLICE)).toContain(PartyOption.UNSPLICE);
    });

    describe("whose Pokémon is whose", () => {
      const PARTNER_COLOR = "#8fd3ff";
      type NamedSlot = { slotName: { color?: string } };
      const slotsOf = (handler: PartyUiHandler): NamedSlot[] =>
        (handler as unknown as { partySlots: NamedSlot[] }).partySlots;

      it("draws the partner's Pokémon in the partner colour, and still does after the slots are rebuilt", async () => {
        await checkOptions(false);
        const handler = run!.ctx.game.scene.ui.getHandler() as PartyUiHandler;
        const colors = () => slotsOf(handler).map(slot => slot.slotName.color);
        // the host sits here: the guest's Pokémon (odd indices) are the partner's
        expect(colors().map(color => color === PARTNER_COLOR)).toEqual([false, true, false, true, false, true]);
        handler.clearPartySlots();
        handler.populatePartySlots();
        expect(colors().map(color => color === PARTNER_COLOR)).toEqual([false, true, false, true, false, true]);
      });

      it("marks nothing in a solo run", async () => {
        endCoopSession();
        await checkOptions(false);
        const handler = run!.ctx.game.scene.ui.getHandler() as PartyUiHandler;
        expect(slotsOf(handler).some(slot => slot.slotName.color === PARTNER_COLOR)).toBe(false);
        expect(party.some(pokemon => isPartnersPokemon(pokemon))).toBe(false);
      });

      it("tells the partner's Pokémon from the player's own and from enemies", () => {
        expect(party.map(pokemon => isPartnersPokemon(pokemon))).toEqual([false, true, false, true, false, true]);
        expect(isPartnersPokemon(run!.ctx.game.scene.getEnemyField()[0])).toBe(false);
      });
    });

    it("says why a partner's Pokémon cannot be picked on the item screens", async () => {
      const { game } = run!.ctx;
      await game.scene.ui.setMode(UiMode.PARTY, PartyUiMode.MODIFIER_TRANSFER);
      const handler = game.scene.ui.getHandler() as PartyUiHandler;
      const showText = vi.spyOn(handler, "showText");
      const playError = vi.spyOn(game.scene.ui, "playError");
      handler.setCursor(G1);
      expect(handler.processInput(Button.ACTION)).toBe(false);
      expect(playError).toHaveBeenCalled();
      expect(showText).toHaveBeenCalledWith(
        notYourPokemonText(party[G1]),
        undefined,
        expect.any(Function),
        undefined,
        true,
      );
    });
  });

  describe("the take over target menu (4)", () => {
    it("tells two enemies of the same species apart by their side, and an ally from an enemy", () => {
      const [user, ally] = [party[H1], party[G1]];
      const [left, right] = run!.ctx.game.scene.getEnemyField();
      const labels = [left, right].map(enemy => takeoverTargetLabel(user, enemy));
      expect(new Set(labels).size).toBe(2);
      expect(labels[0]).toContain("Left");
      expect(labels[1]).toContain("Right");
      expect(takeoverTargetLabel(user, ally)).toContain("ally");
      expect(takeoverTargetLabel(user, user)).toContain("self");
      expect(takeoverTargetLabel(user, undefined)).toBe(getPokemonNameWithAffix(undefined));
    });
  });

  it("control follows the Pokémon: a partner's Pokémon sent into a slot is commanded by its own owner", () => {
    faint(G1);
    const owners = requireCoopSession().ownership.toJSON();
    // H2 covers for the guest's G1: move it into slot 1 (the party order is the field order)
    [party[G1], party[H2]] = [party[H2], party[G1]];
    expect(controllerOf(1)).toBe("host");
    expect(requireCoopSession().ownership.toJSON()).toEqual(owners);
  });
});
