/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { speciesDataRegistry } from "#app/global-species-data-registry";
import { ownerOf } from "#coop/control";
import { biomeKey, catchReleaseKey, turnCommandsKey } from "#coop/decision-keys";
import { keyId } from "#coop/protocol";
import type { Decision } from "#coop/sequencer";
import { getCoopSession } from "#coop/session";
import { commandToWire } from "#coop/turn-commands";
import { modifierTypes } from "#data/data-lists";
import { BiomeId } from "#enums/biome-id";
import { Button } from "#enums/buttons";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { PokeballType } from "#enums/pokeball";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { Unlockables } from "#enums/unlockables";
import { SelectBiomePhase } from "#phases/select-biome-phase";
import * as ribbonMethods from "#system/ribbon-methods";
import { advanceTo, queueTurnCommands } from "#test/helpers/coop-harness";
import {
  answerSideAction,
  attackCommand,
  ballThrowingPartner,
  type LinkedRun,
  type LinkedScenario,
  openLinkedRun,
  pickerSkips,
  playToRunEnd,
  toTurnWithOneEnemy,
  winWave,
} from "#test/helpers/coop-linked";
import type { OptionSelectUiHandler } from "#ui/option-select-ui-handler";
import { getModifierType } from "#utils/modifier-utils";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Biome choice, catching with the cap of 3 per seat, Tera as a side resource (D8), and the account writes of each
 * client. One real client (the host), a scripted guest.
 */

const SIX = [
  SpeciesId.BULBASAUR,
  SpeciesId.SQUIRTLE,
  SpeciesId.CHARMANDER,
  SpeciesId.PIKACHU,
  SpeciesId.MACHOP,
  SpeciesId.GEODUDE,
];
const ALTERNATING = ["host", "guest", "host", "guest", "host", "guest"] as const;

describe("Co-op: between the waves and the end of the run (D4a, D8, D10)", () => {
  let phaserGame: Phaser.Game;
  let run: LinkedRun | null = null;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    run?.close();
    run = null;
    vi.restoreAllMocks();
  });

  async function start(overrides: Partial<LinkedScenario> = {}): Promise<LinkedRun> {
    run = await openLinkedRun(phaserGame, {
      seat: "host",
      species: SIX,
      starterOwners: [...ALTERNATING],
      configure: game => game.override.startingLevel(40),
      policy: { auto: ["TURN_COMMANDS", "LEARN_MOVE", "EVOLUTION_CANCEL"] },
      ...overrides,
    });
    return run;
  }

  const partyIds = (r: LinkedRun) => r.ctx.game.scene.getPlayerParty().map(p => p.id);

  /** Record the biomes the Map offers when the biome is chosen as a decision */
  function spyOnBiomeChoices(): number[][] {
    type Choosing = { chooseBiomeSequenced(biomes: number[]): void };
    const prototype = SelectBiomePhase.prototype as unknown as Choosing;
    const choices: number[][] = [];
    const real = prototype.chooseBiomeSequenced;
    vi.spyOn(prototype, "chooseBiomeSequenced").mockImplementation(function (this: SelectBiomePhase, biomes: number[]) {
      choices.push([...biomes]);
      return real.call(this, biomes);
    });
    return choices;
  }

  describe("the biome after a wave (D10)", () => {
    /** Starting in a biome that leads to several, with a Map: the biome after wave 10 is chosen */
    const withMap: Partial<LinkedScenario> = {
      configure: game => game.override.startingLevel(40).startingWave(10).startingBiome(BiomeId.PLAINS),
    };

    async function giveMap(r: LinkedRun): Promise<void> {
      r.ctx.game.scene.addModifier(getModifierType(modifierTypes.MAP).newModifier()!);
    }

    it("is chosen by the picker of the most recent reward screen: the host, before any screen", async () => {
      const r = await start(withMap);
      const choices = spyOnBiomeChoices();
      await giveMap(r);
      const { game } = r.ctx;
      const seen: Decision[] = [];
      r.link.sequencer.onDecision(decision => seen.push(decision));

      // the host chooses the second of the biomes on offer (the harness answers the biome screen with the cursor it keeps)
      r.ctx.report.biomesChosen = 1;
      await winWave(r);
      await advanceTo(r.ctx, ["CommandPhase"]);

      expect(choices).toHaveLength(1);
      expect(choices[0].length).toBeGreaterThan(1);
      const decision = seen.find(candidate => keyId(candidate.key) === keyId(biomeKey(10)));
      expect(decision?.author).toBe("host");
      expect(decision?.payload).toEqual({ biome: choices[0][1] });
      expect(game.scene.arena.biomeId).toBe(choices[0][1]);
      expect(r.session.desyncMessage).toBeNull();
    });

    it("is chosen by the guest when the guest picked last, and the host waits", async () => {
      // waves 8 and 9 have a reward screen each: the host picks on the first, the guest on the second
      const r = await start({
        configure: game => game.override.startingLevel(40).startingWave(8).startingBiome(BiomeId.PLAINS),
      });
      const choices = spyOnBiomeChoices();
      await giveMap(r);
      const { game } = r.ctx;
      expect(await winWave(r)).toBe(true);
      pickerSkips(r);
      expect(await winWave(r)).toBe(true);
      pickerSkips(r);
      expect(r.session.rewardPickCount).toBe(2);
      expect(r.session.lastRewardPicker).toBe("guest");

      const wave10 = winWave(r);
      await vi.waitUntil(() => choices.length === 1, { interval: 5, timeout: 20000 });
      r.partner.propose(biomeKey(10), { biome: choices[0][1] });
      await wave10;
      await advanceTo(r.ctx, ["CommandPhase"]);

      expect(game.scene.arena.biomeId).toBe(choices[0][1]);
      expect(r.session.desyncMessage).toBeNull();
    });
  });

  describe("catching (D10)", () => {
    it("adds the catch to the thrower when it has fewer than three Pokémon, and the thrower owns it", async () => {
      let r: LinkedRun | null = null;
      const partner = ballThrowingPartner(() => r!);
      r = await start({
        species: [SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER, SpeciesId.PIKACHU],
        starterOwners: ["host", "guest", "host", "guest"],
        policy: partner.policy,
      });
      await toTurnWithOneEnemy(r);
      const { game } = r.ctx;
      const caught = vi.spyOn(game.scene.gameData, "setPokemonCaught");
      expect(partyIds(r)).toHaveLength(4);

      game.doThrowPokeball(PokeballType.MASTER_BALL);
      await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);

      const party = game.scene.getPlayerParty();
      expect(party).toHaveLength(5);
      expect(ownerOf(party.at(-1)!)).toBe("host");
      // every Pokémon of the party has an owner, and nobody else has one
      expect(Object.keys(r.session.ownership.toJSON()).map(Number).sort()).toEqual([...partyIds(r)].sort());
      // the host threw it: the host's account got the catch
      expect(caught).toHaveBeenCalled();
      expect(r.session.desyncMessage).toBeNull();
    });

    it("leaves the catch with the partner's account when the partner threw the ball", async () => {
      let r: LinkedRun | null = null;
      const partner = ballThrowingPartner(() => r!);
      r = await start({
        species: [SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER, SpeciesId.PIKACHU],
        starterOwners: ["host", "guest", "host", "guest"],
        policy: partner.policy,
      });
      await toTurnWithOneEnemy(r);
      const { game } = r.ctx;
      const caught = vi.spyOn(game.scene.gameData, "setPokemonCaught");

      partner.throwBall();
      queueTurnCommands(r.ctx);
      answerSideAction(r, true);
      await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);

      const party = game.scene.getPlayerParty();
      expect(party).toHaveLength(5);
      expect(ownerOf(party.at(-1)!)).toBe("guest");
      // the guest threw it: its client writes the catch, the host's only saw the Pokémon
      expect(caught).not.toHaveBeenCalled();
    });

    it("asks a thrower who has three to release one of their own, and the catch takes its place", async () => {
      let r: LinkedRun | null = null;
      const partner = ballThrowingPartner(() => r!, {
        catchRelease: mine => mine.at(-1)!.id,
      });
      r = await start({ policy: partner.policy });
      await toTurnWithOneEnemy(r);
      const { game } = r.ctx;
      const guestPokemon = game.scene.getPlayerParty().filter(p => ownerOf(p) === "guest");
      expect(guestPokemon).toHaveLength(3);
      const released = guestPokemon.at(-1)!.id;
      const enemy = game.scene.getEnemyField().find(e => e.isActive(true))!;
      const { waveIndex } = game.scene.currentBattle;

      partner.throwBall();
      queueTurnCommands(r.ctx);
      answerSideAction(r, true);
      await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);

      const party = game.scene.getPlayerParty();
      expect(party).toHaveLength(6);
      expect(partyIds(r)).not.toContain(released);
      expect(party.filter(p => ownerOf(p) === "guest")).toHaveLength(3);
      expect(party.filter(p => ownerOf(p) === "host")).toHaveLength(3);
      expect(r.session.ownership.has(released)).toBe(false);
      expect(r.partner.answeredKeys).toContain(keyId(catchReleaseKey(waveIndex, enemy.id)));
      expect(r.session.desyncMessage).toBeNull();
    });

    it("lets a thrower who has three decline the catch: nothing changes", async () => {
      let r: LinkedRun | null = null;
      const partner = ballThrowingPartner(() => r!, { catchRelease: () => null });
      r = await start({ policy: partner.policy });
      await toTurnWithOneEnemy(r);
      const { game } = r.ctx;
      const before = partyIds(r);
      const owners = r.session.ownership.toJSON();

      partner.throwBall();
      queueTurnCommands(r.ctx);
      answerSideAction(r, true);
      await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);

      expect(partyIds(r)).toEqual(before);
      expect(r.session.ownership.toJSON()).toEqual(owners);
      expect(game.scene.getEnemyField().filter(e => e.isActive(true))).toHaveLength(0);
    });

    it("asks the host the same when the host threw and has three, and the host can decline through its own screen", async () => {
      let r: LinkedRun | null = null;
      const partner = ballThrowingPartner(() => r!);
      r = await start({ policy: partner.policy });
      await toTurnWithOneEnemy(r);
      const { game } = r.ctx;
      const before = partyIds(r);
      const enemy = game.scene.getEnemyField().find(e => e.isActive(true))!;
      const { waveIndex } = game.scene.currentBattle;
      const seen: Decision[] = [];
      r.link.sequencer.onDecision(decision => seen.push(decision));

      // The throw first (the prompts are first in, first out), then "The party is full": the host answers No
      game.doThrowPokeball(PokeballType.MASTER_BALL);
      game.onNextPrompt("AttemptCapturePhase", UiMode.OPTION_SELECT, () => {
        const handler = game.scene.ui.getHandler() as OptionSelectUiHandler;
        (handler as unknown as { unblockInput(): void }).unblockInput();
        handler.setCursor(3);
        handler.processInput(Button.ACTION);
      });
      await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);

      // the host's answer was sequenced, with its key, and it is the same on both clients
      const key = keyId(catchReleaseKey(waveIndex, enemy.id));
      const answer = seen.find(decision => keyId(decision.key) === key);
      expect(answer).toMatchObject({ author: "host", payload: { release: null } });
      expect(partyIds(r)).toEqual(before);
    });
  });

  describe("Tera is a side resource (D8)", () => {
    const tera = (slot: number) => commandToWire({ command: Command.TERA, targets: [slot] });

    async function turnWithBothTera(order: "guest first" | "host first") {
      const r = await start();
      const { ctx, partner } = r;
      const { game } = ctx;
      // Terastallization needs the Tera Orb, and a decision that uses it without one is not legal (D24)
      game.scene.addModifier(getModifierType(modifierTypes.TERA_ORB).newModifier()!, true);
      const notices: string[] = [];
      const showText = game.scene.ui.showText.bind(game.scene.ui);
      vi.spyOn(game.scene.ui, "showText").mockImplementation((text, ...rest) => {
        notices.push(text);
        return showText(text, ...rest);
      });
      await advanceTo(ctx, ["CommandPhase"]);
      const battle = game.scene.currentBattle;
      const [first, second] = game.scene.getPlayerField();
      const hostKey = turnCommandsKey(battle.waveIndex, battle.turn, first.id);
      const guestKey = turnCommandsKey(battle.waveIndex, battle.turn, second.id);
      const guestTera = { ...attackCommand(game, 1), pre: tera(1) };

      queueTurnCommands(ctx);
      // (only when the host goes first: an awaiter for a key that comes second would see the first as a desync)
      const hostSeen = order === "host first" ? partner.sequencer.awaitDecision(hostKey) : null;
      if (order === "guest first") {
        partner.propose(guestKey, guestTera);
      }
      // the host's player chose Tera too: the command phase of the first slot made it
      await advanceTo(ctx, ["CoopTurnSyncPhase"]);
      battle.preTurnCommands[0] = { command: Command.TERA, targets: [0] };
      const reached = advanceTo(ctx, ["TurnStartPhase"]);
      if (order === "host first") {
        await hostSeen;
        partner.propose(guestKey, guestTera);
      }
      await reached;
      return { r, battle, notices };
    }

    it("lets the first by seq keep it and clears the flag of the other: the guest's was first", async () => {
      const { r, battle, notices } = await turnWithBothTera("guest first");
      expect(battle.preTurnCommands[1]).toMatchObject({ command: Command.TERA });
      expect(battle.preTurnCommands[1]?.skip).not.toBe(true);
      // the host's is cleared, and the host is told
      expect(battle.preTurnCommands[0]).toMatchObject({ command: Command.FIGHT, skip: true });
      expect(notices.some(text => text.includes("Terastallized first"))).toBe(true);
      expect(r.session.desyncMessage).toBeNull();
    });

    it("lets the first by seq keep it and clears the flag of the other: the host's was first", async () => {
      const { battle } = await turnWithBothTera("host first");
      expect(battle.preTurnCommands[0]).toMatchObject({ command: Command.TERA });
      expect(battle.preTurnCommands[0]?.skip).not.toBe(true);
      expect(battle.preTurnCommands[1]).toMatchObject({ command: Command.FIGHT, skip: true });
    });
  });

  describe("account writes (D4a)", () => {
    it("writes the dex only for the Pokémon the player owns; the partner's are only seen", async () => {
      const r = await start();
      const { game } = r.ctx;
      await advanceTo(r.ctx, ["CommandPhase"]);
      const caught = vi.spyOn(game.scene.gameData, "setPokemonCaught").mockResolvedValue(false);
      const seen = vi.spyOn(game.scene.gameData, "setPokemonSeen");
      const mine = game.scene.getPlayerParty().find(p => ownerOf(p) === "host")!;
      const theirs = game.scene.getPlayerParty().find(p => ownerOf(p) === "guest")!;
      const evolutionOf = (pokemon: typeof mine) => speciesDataRegistry.getEvolutions(pokemon.species.speciesId)[0];

      await theirs.evolve(evolutionOf(theirs), theirs.getSpeciesForm());
      expect(caught).not.toHaveBeenCalled();
      expect(seen).toHaveBeenCalledWith(theirs, false);

      await mine.evolve(evolutionOf(mine), mine.getSpeciesForm());
      expect(caught).toHaveBeenCalledTimes(1);
      expect(caught).toHaveBeenCalledWith(mine, false);
    });
  });

  describe("the end of the run (D4a)", () => {
    /** Wave 200 in the last biome, with Pokémon that take the boss down in one hit */
    const finalBoss: Partial<LinkedScenario> = {
      configure: game => game.override.startingLevel(10000).startingWave(200).startingBiome(BiomeId.END),
    };

    /** The ribbons a client writes, as the species of the Pokémon they were awarded for */
    function spyOnRibbons(): number[] {
      const awarded: number[] = [];
      vi.spyOn(ribbonMethods, "awardRibbonsToSpeciesLine").mockImplementation(species => {
        awarded.push(species);
      });
      return awarded;
    }

    it("the final boss wave is two of ours against one boss, and winning it is a victory for the run", async () => {
      const r = await start(finalBoss);
      const { game } = r.ctx;
      await advanceTo(r.ctx, ["CommandPhase"]);
      const battle = game.scene.currentBattle;
      expect(battle.waveIndex).toBe(200);
      expect(battle.double).toBe(true);
      expect(game.scene.getEnemyField().filter(enemy => enemy.isActive(true))).toHaveLength(1);
      expect(game.scene.getPlayerField().filter(pokemon => pokemon.isActive(true))).toHaveLength(2);
      // both players command a Pokémon against the one boss
      expect(new Set([0, 1].map(slot => ownerOf(game.scene.getPlayerField()[slot])))).toEqual(
        new Set(["host", "guest"]),
      );

      expect(await playToRunEnd(r)).toBe(true);
      expect(r.session.desyncMessage).toBeNull();
    });

    it("a victory gives each client the ribbons of its own Pokémon only, and no classic-win unlock", async () => {
      const r = await start(finalBoss);
      const { game } = r.ctx;
      const awarded = spyOnRibbons();
      const achievement = vi.spyOn(game.scene, "validateAchv");
      await advanceTo(r.ctx, ["CommandPhase"]);
      const mine = game.scene.getPlayerParty().filter(pokemon => ownerOf(pokemon) === "host");
      expect(mine).toHaveLength(3);

      expect(await playToRunEnd(r)).toBe(true);
      await game.phaseInterceptor.to("PostGameOverPhase", false);

      expect(awarded.sort()).toEqual(mine.map(pokemon => pokemon.species.speciesId).sort());
      expect(game.phaseInterceptor.phaseLog).not.toContain("UnlockPhase");
      expect(game.phaseInterceptor.phaseLog).not.toContain("GameOverModifierRewardPhase");
      expect(achievement).not.toHaveBeenCalledWith(expect.objectContaining({ id: "CLASSIC_VICTORY" }));
      expect(game.scene.gameData.unlocks[Unlockables.ENDLESS_MODE]).toBe(false);
    });

    it("counts a victory as a co-op clear of this account, and writes the run to its history with both names", async () => {
      const r = await start({ ...finalBoss, names: { mine: "Sam", theirs: "Alex" } });
      const { game } = r.ctx;
      spyOnRibbons();
      expect(game.scene.gameData.gameStats.coopRunsWon).toBe(0);
      await advanceTo(r.ctx, ["CommandPhase"]);

      expect(await playToRunEnd(r)).toBe(true);
      await game.phaseInterceptor.to("PostGameOverPhase", false);
      await vi.waitUntil(async () => Object.keys(await game.scene.gameData.getRunHistoryData()).length === 1, {
        interval: 5,
        timeout: 4000,
      });

      expect(game.scene.gameData.gameStats.coopRunsWon).toBe(1);
      const [entry] = Object.values(await game.scene.gameData.getRunHistoryData());
      expect(entry).toMatchObject({ isVictory: true, coop: { names: { host: "Sam", guest: "Alex" }, seat: "host" } });
      // the system data is where the counter lives: it was saved with it
      expect(JSON.parse(JSON.stringify(game.scene.gameData.gameStats)).coopRunsWon).toBe(1);
    });

    it("writes a lost run to the history too, with the names the other way round for the guest, and counts no clear", async () => {
      const r = await start({
        names: { mine: "Alex", theirs: "Sam" },
        seat: "guest",
        faints: [1, 2, 3].map(turn => ({ wave: 1, turn, slots: [0, 1] as (0 | 1)[] })),
        policy: {
          auto: ["TURN_COMMANDS", "FAINT_SWITCH", "LEARN_MOVE", "EVOLUTION_CANCEL"],
          commands: (_pokemon, slot) => attackCommand(r.ctx.game, slot, MoveId.MEMENTO),
        },
      });
      const { game } = r.ctx;

      expect(await playToRunEnd(r)).toBe(false);
      await game.phaseInterceptor.to("PostGameOverPhase", false);
      await vi.waitUntil(async () => Object.keys(await game.scene.gameData.getRunHistoryData()).length === 1, {
        interval: 5,
        timeout: 4000,
      });
      const [entry] = Object.values(await game.scene.gameData.getRunHistoryData());
      expect(entry).toMatchObject({ isVictory: false, coop: { names: { host: "Sam", guest: "Alex" }, seat: "guest" } });
      expect(game.scene.gameData.gameStats.coopRunsWon).toBe(0);
    });

    it("a wipe is a game over for both players, with no ribbons", async () => {
      // every turn both field Pokémon faint (the host's by itself, the guest's as the partner commands), until no one is left
      const r = await start({
        faints: [1, 2, 3].map(turn => ({ wave: 1, turn, slots: [0, 1] as (0 | 1)[] })),
        policy: {
          auto: ["TURN_COMMANDS", "FAINT_SWITCH", "LEARN_MOVE", "EVOLUTION_CANCEL"],
          commands: (_pokemon, slot) => attackCommand(r.ctx.game, slot, MoveId.MEMENTO),
        },
      });
      const { game } = r.ctx;
      const awarded = spyOnRibbons();

      expect(await playToRunEnd(r)).toBe(false);
      expect(game.scene.getPlayerParty().every(pokemon => pokemon.isFainted())).toBe(true);
      await game.phaseInterceptor.to("PostGameOverPhase", false);
      expect(awarded).toEqual([]);
      expect(r.session.desyncMessage).toBeNull();
    });

    it("ends the co-op session and returns to the title screen with a message; nothing is saved to a solo slot", async () => {
      const r = await start({
        faints: [1, 2, 3].map(turn => ({ wave: 1, turn, slots: [0, 1] as (0 | 1)[] })),
        policy: {
          auto: ["TURN_COMMANDS", "FAINT_SWITCH", "LEARN_MOVE", "EVOLUTION_CANCEL"],
          commands: (_pokemon, slot) => attackCommand(r.ctx.game, slot, MoveId.MEMENTO),
        },
      });
      const { game } = r.ctx;
      const shown: string[] = [];
      const showText = game.scene.ui.showText.bind(game.scene.ui);
      vi.spyOn(game.scene.ui, "showText").mockImplementation((text, ...rest) => {
        shown.push(text);
        return showText(text, ...rest);
      });
      const system = vi.spyOn(game.scene.gameData, "saveSystem");
      const session = vi.spyOn(game.scene.gameData, "saveAll");
      const clearSession = vi.spyOn(game.scene.gameData, "tryClearSession");

      expect(await playToRunEnd(r)).toBe(false);
      await game.phaseInterceptor.to("TitlePhase", false);

      expect(shown).toContain("Co-op run ended");
      expect(getCoopSession()).toBeNull();
      expect(system).toHaveBeenCalled();
      expect(session).not.toHaveBeenCalled();
      expect(clearSession).not.toHaveBeenCalled();
    });
  });
});
