/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EvolutionItem } from "#balance/pokemon-evolutions";
import type { DebugBatch } from "#coop/debug/actions";
import { itemCatalog, makeItemType, partyMembersFor } from "#coop/debug/catalog";
import { itemId } from "#coop/debug/item-id";
import { writeDebugOverrides } from "#coop/debug/overrides";
import { debugPanelInfo, showDebugSection, startDebugPanel, stopDebugPanel, toggleDebugPanel } from "#coop/debug/panel";
import { clearDebugQueue, debugChanges, queueDebug, queueDebugChange, waitingDebug } from "#coop/debug/queue";
import { emptyWavePlan } from "#coop/debug/state";
import { ownerOf } from "#coop/decisions/control";
import { debugTurnKey } from "#coop/decisions/decision-keys";
import type { Decision } from "#coop/decisions/sequencer";
import type { DecisionKey } from "#coop/protocol";
import { modifierTypes } from "#data/data-lists";
import { TerrainType } from "#data/terrain";
import { AbilityId } from "#enums/ability-id";
import { BattleType } from "#enums/battle-type";
import { BerryType } from "#enums/berry-type";
import { BiomeId } from "#enums/biome-id";
import { FormChangeItem } from "#enums/form-change-item";
import { ModifierPoolType } from "#enums/modifier-pool-type";
import { ModifierTier } from "#enums/modifier-tier";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { Nature } from "#enums/nature";
import { PokeballType } from "#enums/pokeball";
import { PokemonType } from "#enums/pokemon-type";
import { SpeciesId } from "#enums/species-id";
import { Stat } from "#enums/stat";
import { StatusEffect } from "#enums/status-effect";
import { TrainerType } from "#enums/trainer-type";
import { WeatherType } from "#enums/weather-type";
import { AttackTypeBoosterModifier, PokemonFormChangeItemModifier, PokemonHeldItemModifier } from "#modifiers/modifier";
import type {
  EvolutionItemModifierType,
  FormChangeItemModifierType,
  ModifierTypeOption,
  TmModifierType,
} from "#modifiers/modifier-type";
import { getPlayerModifierTypeOptions, regenerateModifierPoolThresholds } from "#modifiers/modifier-type";
import { advanceTo, openUi, queueTurnCommands } from "#test/helpers/coop-harness";
import {
  type LinkedRun,
  type LinkedScenario,
  openLinkedRun,
  openScreen,
  pickerSkips,
  rewardScreen,
  winWave,
} from "#test/helpers/coop-linked";
import { getModifierPoolForType } from "#utils/modifier-utils";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The host's debug menu (DECISIONS D42): its cheats travel as a sequenced `DEBUG` decision of the host, in the window of
 * the turn's commands or of a reward screen's step, and every client carries them out at the same point.
 */

const SIX = [
  SpeciesId.BULBASAUR,
  SpeciesId.SQUIRTLE,
  SpeciesId.CHARMANDER,
  SpeciesId.PIKACHU,
  SpeciesId.MACHOP,
  SpeciesId.GEODUDE,
];

describe("Co-op: the host's debug menu (D42)", () => {
  let phaserGame: Phaser.Game;
  let run: LinkedRun | null = null;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    stopDebugPanel();
    run?.close();
    run = null;
    clearDebugQueue();
    writeDebugOverrides(null, 0);
    vi.restoreAllMocks();
  });

  async function start(overrides: Partial<LinkedScenario> = {}): Promise<LinkedRun> {
    run = await openLinkedRun(phaserGame, {
      seat: "host",
      species: SIX,
      starterOwners: ["host", "guest", "host", "guest", "host", "guest"],
      configure: game => game.override.startingLevel(40),
      policy: { auto: ["TURN_COMMANDS", "LEARN_MOVE", "EVOLUTION_CANCEL"] },
      ...overrides,
    });
    // (the host turned the menu on: both sides of a real run know it from the handshake)
    (run.session as { debug: boolean }).debug = true;
    return run;
  }

  const guestMon = (r: LinkedRun) => r.ctx.game.scene.getPlayerParty().find(p => ownerOf(p) === "guest")!;

  /** Play one turn of plain attacks */
  async function playTurn(r: LinkedRun): Promise<string> {
    await advanceTo(r.ctx, ["CommandPhase"]);
    queueTurnCommands(r.ctx);
    return await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);
  }

  it("the host's cheats go with the turn: the guest gets the same batch, and they are carried out", async () => {
    const r = await start({ configure: game => game.override.startingLevel(5) });
    const seen: Decision[] = [];
    r.partner.sequencer.onDecision(decision => seen.push(decision));
    await advanceTo(r.ctx, ["CommandPhase"]);
    const target = guestMon(r);
    const batch: DebugBatch = {
      actions: [
        { t: "level", p: target.id, v: 60 },
        { t: "ivs", p: target.id, v: [31, 31, 31, 31, 31, 31] },
        { t: "item", p: target.id, item: "LEFTOVERS", count: 2 },
        { t: "move", p: target.id, slot: 1, v: MoveId.SPLASH },
        { t: "money", v: 123_456 },
        { t: "mode", mode: "noDamage", v: true },
      ],
    };
    queueDebug(...batch.actions);
    queueTurnCommands(r.ctx);
    await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);

    const debug = seen.filter(decision => decision.key.kind === "DEBUG");
    expect(debug.map(decision => decision.payload)).toEqual([batch]);
    expect(debug[0].author).toBe("host");
    expect(target.level).toBe(60);
    expect(target.ivs).toEqual([31, 31, 31, 31, 31, 31]);
    expect(target.getHeldItems().find(item => item.type.id === "LEFTOVERS")?.stackCount).toBe(2);
    expect(target.getMoveset()[1].moveId).toBe(MoveId.SPLASH);
    expect(r.ctx.game.scene.money).toBeGreaterThanOrEqual(123_456);
    // our side took no damage in that turn
    for (const pokemon of r.ctx.game.scene.getPlayerField()) {
      expect(pokemon.hp, pokemon.name).toBe(pokemon.getMaxHp());
    }
    expect(r.session.debugState.modes.noDamage).toBe(true);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("a turn without cheats still has the host's (empty) batch; the guest cannot send one", async () => {
    const r = await start();
    const rejected: string[] = [];
    r.partner.sequencer.onProposalRejected(({ key, reason }) => rejected.push(`${key.kind}:${reason}`));
    const seen: DecisionKey[] = [];
    r.partner.sequencer.onDecision(decision => seen.push(decision.key));
    await advanceTo(r.ctx, ["CommandPhase"]);
    const { waveIndex, turn } = r.ctx.game.scene.currentBattle;
    r.partner.propose(debugTurnKey(waveIndex, turn), { actions: [{ t: "money", v: 1 }] });
    queueTurnCommands(r.ctx);
    await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);

    expect(rejected.filter(entry => entry.startsWith("DEBUG:"))).toHaveLength(1);
    expect(seen.filter(key => key.kind === "DEBUG")).toEqual([debugTurnKey(waveIndex, turn)]);
    expect(r.ctx.game.scene.money).not.toBe(1);
  });

  it("“win” ends the wave at once; the plan of the next wave makes its enemies", async () => {
    const r = await start({ configure: game => game.override.startingLevel(5) });
    await advanceTo(r.ctx, ["CommandPhase"]);
    const plan = { ...emptyWavePlan(), battle: "wild" as const, species: [SpeciesId.MEWTWO, SpeciesId.MEW], level: 3 };
    queueDebug({ t: "plan", wave: 2, plan }, { t: "win" });
    queueTurnCommands(r.ctx);
    expect(await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"])).toBe("SelectModifierPhase");
    expect(r.ctx.game.scene.currentBattle.waveIndex).toBe(1);

    await openUi(r.ctx, "SelectModifierPhase");
    pickerSkips(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    const wave = r.ctx.game.scene.currentBattle;
    expect(wave.waveIndex).toBe(2);
    expect(r.ctx.game.scene.getEnemyParty().map(enemy => [enemy.species.speciesId, enemy.level])).toEqual([
      [SpeciesId.MEWTWO, 3],
      [SpeciesId.MEW, 3],
    ]);
    // the plan was for that wave only
    expect(r.session.debugState.plans).toEqual({ "2": plan });
    expect(r.session.desyncMessage).toBeNull();
  });

  it("a jump: the wave after this one is the one the host chose", async () => {
    const r = await start();
    await advanceTo(r.ctx, ["CommandPhase"]);
    queueDebug({ t: "jump", v: 23 }, { t: "win" });
    queueTurnCommands(r.ctx);
    await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);
    await openUi(r.ctx, "SelectModifierPhase");
    pickerSkips(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    expect(r.ctx.game.scene.currentBattle.waveIndex).toBe(23);
    expect(r.session.debugState.jump).toBeNull();
    expect(r.session.desyncMessage).toBeNull();
  });

  it("on a reward screen the host's cheats go at once: the items it chose replace the screen's", async () => {
    const r = await start();
    expect(await winWave(r)).toBe(true);
    const before = rewardScreen(r) as unknown as { typeOptions: ModifierTypeOption[] };
    const step = r.session.rewardStep;
    // five: more than the screen's three, and items used at once (a ball, a candy, a potion) as well as held ones
    const items = ["MASTER_BALL", "RARE_CANDY", "POTION", "LEFTOVERS", "MEMORY_MUSHROOM"];
    queueDebug({ t: "rewards", items }, { t: "money", v: 9_999 });
    await vi.waitUntil(() => r.ctx.game.scene.phaseManager.getCurrentPhase() !== (before as unknown), {
      interval: 5,
      timeout: 4000,
    });
    expect(r.session.rewardStep).toBe(step + 1);
    expect(r.ctx.game.scene.money).toBe(9_999);
    await openUi(r.ctx, "SelectModifierPhase");
    const after = rewardScreen(r) as unknown as { typeOptions: ModifierTypeOption[] };
    expect(after.typeOptions.map(option => option.type.id)).toEqual(items);
    // the items were for that screen: the next is the game's again
    expect(r.session.debugState.rewards).toBeNull();
    pickerSkips(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("every party, bag and field cheat in one batch: the turn goes on, nothing breaks", async () => {
    const r = await start({ configure: game => game.override.startingLevel(20) });
    await advanceTo(r.ctx, ["CommandPhase"]);
    const scene = r.ctx.game.scene;
    const [first, second] = scene.getPlayerField();
    const bench = scene.getPlayerParty().filter(p => !p.isOnField());
    const benchGuest = bench.find(p => ownerOf(p) === "guest")!;
    const benchHost = bench.find(p => ownerOf(p) === "host")!;
    queueDebug(
      { t: "species", p: first.id, v: SpeciesId.CHARIZARD, form: 0 },
      { t: "fusion", p: first.id, v: SpeciesId.GENGAR, form: 0 },
      { t: "shiny", p: first.id, shiny: true, variant: 2 },
      { t: "ability", p: first.id, v: AbilityId.LEVITATE },
      { t: "passive", p: first.id, v: AbilityId.INTIMIDATE },
      { t: "nature", p: first.id, v: Nature.ADAMANT },
      { t: "friendship", p: first.id, v: 255 },
      { t: "gender", p: first.id, v: 1 },
      { t: "tera", p: first.id, v: PokemonType.DRAGON },
      { t: "heal", p: null },
      { t: "item", p: null, item: "EXP_SHARE", count: 2 },
      { t: "balls", ball: PokeballType.MASTER_BALL, v: 42 },
      { t: "owner", p: benchGuest.id, seat: "host" },
      { t: "remove", p: benchHost.id },
      { t: "add", seat: "guest", species: SpeciesId.EEVEE, form: 0, level: 30, shiny: true, variant: 1, seed: 99 },
      { t: "weather", v: WeatherType.RAIN },
      { t: "terrain", v: TerrainType.GRASSY },
      { t: "stages", side: "party", v: 6 },
      { t: "enemy", e: null, what: "level", v: 2 },
      { t: "status", side: "enemy", v: StatusEffect.PARALYSIS },
      { t: "mode", mode: "exp", v: 5 },
    );
    queueTurnCommands(r.ctx);
    await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);

    expect(first.species.speciesId).toBe(SpeciesId.CHARIZARD);
    expect(first.fusionSpecies?.speciesId).toBe(SpeciesId.GENGAR);
    expect([first.shiny, first.variant]).toEqual([true, 2]);
    expect(first.getAbility().id).toBe(AbilityId.LEVITATE);
    expect(first.getPassiveAbility().id).toBe(AbilityId.INTIMIDATE);
    expect(first.getNature()).toBe(Nature.ADAMANT);
    expect(first.teraType).toBe(PokemonType.DRAGON);
    expect(scene.pokeballCounts[PokeballType.MASTER_BALL]).toBe(42);
    expect(scene.findModifier(m => m.type.id === "EXP_SHARE")?.getStackCount()).toBe(2);
    expect(ownerOf(benchGuest)).toBe("host");
    expect(scene.getPlayerParty()).not.toContain(benchHost);
    const eevee = scene.getPlayerParty().find(p => p.species.speciesId === SpeciesId.EEVEE)!;
    expect([eevee.level, eevee.shiny, ownerOf(eevee)]).toEqual([30, true, "guest"]);
    expect(scene.arena.weather?.weatherType).toBe(WeatherType.RAIN);
    expect(scene.arena.terrain?.terrainType).toBe(TerrainType.GRASSY);
    expect(second.getStatStage(Stat.ATK)).toBe(6);
    expect(r.session.debugState.modes.exp).toBe(5);
    expect(r.session.desyncMessage).toBeNull();
    // the battle goes on
    await advanceTo(r.ctx, ["CommandPhase", "SelectModifierPhase"]);
  });

  it("a planned trainer and biome: the next wave is that trainer, in that biome", async () => {
    const r = await start({ configure: game => game.override.startingLevel(40) });
    await advanceTo(r.ctx, ["CommandPhase"]);
    queueDebug(
      { t: "plan", wave: 2, plan: { ...emptyWavePlan(), battle: "trainer", trainer: TrainerType.YOUNGSTER } },
      { t: "biome", v: BiomeId.BEACH },
      { t: "win" },
    );
    queueTurnCommands(r.ctx);
    await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);
    await openUi(r.ctx, "SelectModifierPhase");
    pickerSkips(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    const battle = r.ctx.game.scene.currentBattle;
    expect(battle.waveIndex).toBe(2);
    expect(battle.battleType).toBe(BattleType.TRAINER);
    expect(battle.trainer?.config.trainerType).toBe(TrainerType.YOUNGSTER);
    expect(r.ctx.game.scene.arena.biomeId).toBe(BiomeId.BEACH);
    expect(r.session.debugState.biome).toBeNull();
    expect(r.session.desyncMessage).toBeNull();
  });

  /** Win wave 1 at once and skip its reward screen: the next wave is made */
  async function winFirstWave(r: LinkedRun): Promise<void> {
    queueDebug({ t: "win" });
    queueTurnCommands(r.ctx);
    await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"]);
    await openUi(r.ctx, "SelectModifierPhase");
    pickerSkips(r);
  }

  it("“win” in a trainer battle: the trainer's Pokémon that wait are out too, and the wave is won", async () => {
    const r = await start({ configure: game => game.override.startingLevel(10) });
    await advanceTo(r.ctx, ["CommandPhase"]);
    queueDebug({
      t: "plan",
      wave: 2,
      plan: { ...emptyWavePlan(), battle: "trainer", trainer: TrainerType.ACE_TRAINER },
    });
    await winFirstWave(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    expect(r.ctx.game.scene.currentBattle.battleType).toBe(BattleType.TRAINER);
    expect(r.ctx.game.scene.getEnemyParty().length).toBeGreaterThan(2);

    queueDebug({ t: "win" });
    queueTurnCommands(r.ctx);
    expect(await advanceTo(r.ctx, ["TurnInitPhase", "SelectModifierPhase"])).toBe("SelectModifierPhase");
    expect(r.ctx.game.scene.currentBattle.waveIndex).toBe(2);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("“Full HP” on a boss brings back its health bars too, after “1 HP” broke them", async () => {
    const r = await start({ configure: game => game.override.startingLevel(10) });
    await advanceTo(r.ctx, ["CommandPhase"]);
    queueDebug({ t: "plan", wave: 2, plan: { ...emptyWavePlan(), battle: "wild", boss: 3, level: 5 } });
    await winFirstWave(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    const boss = r.ctx.game.scene.getEnemyField().find(enemy => enemy.isActive(true))!;
    expect(boss.bossSegments).toBe(3);

    queueDebug({ t: "enemy", e: null, what: "hp1", v: 0 }, { t: "enemy", e: null, what: "heal", v: 0 });
    // (our side does nothing this turn: Splash)
    queueTurnCommands(r.ctx);
    await advanceTo(r.ctx, ["TurnStartPhase"]);
    expect(boss.hp).toBe(boss.getMaxHp());
    expect(boss.bossSegmentIndex).toBe(boss.bossSegments - 1);
  });

  it("a planned Mystery Encounter is the next wave, whatever the wave", async () => {
    const r = await start({ configure: game => game.override.startingLevel(10) });
    await advanceTo(r.ctx, ["CommandPhase"]);
    queueDebug({
      t: "plan",
      wave: 2,
      plan: { ...emptyWavePlan(), battle: "me", encounter: MysteryEncounterType.DEPARTMENT_STORE_SALE },
    });
    await winFirstWave(r);
    await advanceTo(r.ctx, ["MysteryEncounterPhase", "CommandPhase"]);
    const battle = r.ctx.game.scene.currentBattle;
    expect(battle.waveIndex).toBe(2);
    expect(battle.battleType).toBe(BattleType.MYSTERY_ENCOUNTER);
    expect(battle.mysteryEncounter?.encounterType).toBe(MysteryEncounterType.DEPARTMENT_STORE_SALE);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("the host's items on the guest's reward screen: redrawn on both, and the guest still picks", async () => {
    const r = await start({ configure: game => game.override.startingLevel(40) });
    // screen 0 is the host's: skipped; screen 1, the guest's, is the one changed
    expect(await winWave(r)).toBe(true);
    pickerSkips(r);
    expect(await winWave(r)).toBe(true);
    expect(openScreen().picker).toBe("guest");
    const before = r.ctx.game.scene.phaseManager.getCurrentPhase();
    queueDebug({ t: "rewards", items: ["MASTER_BALL", "POTION", "RARE_CANDY", "LEFTOVERS"] });
    await vi.waitUntil(() => r.ctx.game.scene.phaseManager.getCurrentPhase() !== before, {
      interval: 5,
      timeout: 4000,
    });
    await openUi(r.ctx, "SelectModifierPhase");
    const after = rewardScreen(r) as unknown as { typeOptions: ModifierTypeOption[] };
    expect(after.typeOptions.map(option => option.type.id)).toEqual([
      "MASTER_BALL",
      "POTION",
      "RARE_CANDY",
      "LEFTOVERS",
    ]);
    expect(openScreen().picker).toBe("guest");
    // the guest picks the Potion's place (skips), and the run goes on
    pickerSkips(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("the item catalog lists every item of the game's random families one by one, drawing no random number", async () => {
    const r = await start();
    await advanceTo(r.ctx, ["CommandPhase"]);
    const random = Phaser.Math.RND.state();
    const catalog = itemCatalog();
    expect(Phaser.Math.RND.state()).toBe(random);
    const ids = catalog.map(item => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      itemId("RARE_FORM_CHANGE_ITEM", FormChangeItem.CHARIZARDITE_X),
      itemId("EVOLUTION_ITEM", EvolutionItem.THUNDER_STONE),
      itemId("ATTACK_TYPE_BOOSTER", PokemonType.FIRE),
      itemId("BERRY", BerryType.SITRUS),
      itemId("MINT", Nature.ADAMANT),
      itemId("TERA_SHARD", PokemonType.STELLAR),
      itemId("TEMP_STAT_STAGE_BOOSTER", Stat.ATK),
      itemId("BASE_STAT_BOOSTER", Stat.HP),
      itemId("RARE_SPECIES_STAT_BOOSTER", "LIGHT_BALL"),
      "RARE_CANDY",
      "MEGA_BRACELET",
    ]) {
      expect(ids).toContain(id);
    }
    // a TM of each move the game has a TM of, in its tier
    expect(catalog.filter(item => item.family === "tms" && item.id.endsWith(`:${MoveId.EARTHQUAKE}`))).toHaveLength(1);
    // what the game picks at random stays offered as such
    expect(catalog.find(item => item.id === "EVOLUTION_ITEM")?.family).toBe("random");
    expect(catalog.find(item => item.id === itemId("ATTACK_TYPE_BOOSTER", PokemonType.FIRE))?.held).toBe(true);
    for (const item of catalog.filter(entry => entry.family !== "random")) {
      expect(item.name, item.id).not.toMatch(/undefined|modifierType:|^$/);
      expect(makeItemType(item.id), item.id).not.toBeNull();
    }
    // who on the team an item is for
    const party = r.ctx.game.scene.getPlayerParty();
    const pikachu = party.find(pokemon => pokemon.species.speciesId === SpeciesId.PIKACHU)!;
    expect(partyMembersFor(itemId("EVOLUTION_ITEM", EvolutionItem.THUNDER_STONE), party)).toEqual([pikachu]);
    expect(partyMembersFor(itemId("RARE_FORM_CHANGE_ITEM", FormChangeItem.CHARIZARDITE_X), party)).toEqual([]);
  });

  it("the next reward screen offers the exact items the host chose: a Mega Stone, an evolution item, a TM", async () => {
    const r = await start();
    expect(await winWave(r)).toBe(true);
    const before = r.ctx.game.scene.phaseManager.getCurrentPhase();
    const wave = r.ctx.game.scene.currentBattle.waveIndex;
    const earthquake = itemCatalog().find(item => item.family === "tms" && item.id.endsWith(`:${MoveId.EARTHQUAKE}`))!;
    const change = queueDebugChange("Rewards", "rewards", {
      t: "rewards",
      items: [
        itemId("RARE_FORM_CHANGE_ITEM", FormChangeItem.CHARIZARDITE_X),
        itemId("EVOLUTION_ITEM", EvolutionItem.FIRE_STONE),
        earthquake.id,
      ],
    });
    await vi.waitUntil(() => r.ctx.game.scene.phaseManager.getCurrentPhase() !== before, {
      interval: 5,
      timeout: 4000,
    });
    await openUi(r.ctx, "SelectModifierPhase");
    const types = (rewardScreen(r) as unknown as { typeOptions: ModifierTypeOption[] }).typeOptions.map(
      option => option.type,
    );
    expect((types[0] as FormChangeItemModifierType).formChangeItem).toBe(FormChangeItem.CHARIZARDITE_X);
    expect((types[1] as EvolutionItemModifierType).evolutionItem).toBe(EvolutionItem.FIRE_STONE);
    expect((types[2] as TmModifierType).moveId).toBe(MoveId.EARTHQUAKE);
    // the host's change log: applied on that reward screen
    expect(debugChanges().find(entry => entry.id === change.id)).toMatchObject({
      state: "applied",
      where: { wave, turn: null },
    });
    pickerSkips(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    expect(r.session.desyncMessage).toBeNull();
  });

  /** The ids of the reward pool's Master tier */
  const masterIds = () =>
    new Set(getModifierPoolForType(ModifierPoolType.PLAYER)[ModifierTier.MASTER].map(entry => entry.modifierType.id));

  it("the tier picks come first among the game's picks, Master first; a tier pick is no item to give", async () => {
    await start();
    const picks = itemCatalog()
      .filter(item => item.family === "random")
      .slice(0, 5);
    expect(picks.map(item => item.id)).toEqual([
      "TIER:MASTER",
      "TIER:ROGUE",
      "TIER:ULTRA",
      "TIER:GREAT",
      "TIER:COMMON",
    ]);
    expect(picks.map(item => item.name)).toEqual([
      "Master-tier item (the game picks)",
      "Rogue-tier item (the game picks)",
      "Ultra-tier item (the game picks)",
      "Great-tier item (the game picks)",
      "Common-tier item (the game picks)",
    ]);
    expect(makeItemType("TIER:MASTER")).toBeNull();
  });

  it("the next reward screen: a Master-tier pick and an exact item, at their places", async () => {
    const r = await start();
    expect(await winWave(r)).toBe(true);
    const before = r.ctx.game.scene.phaseManager.getCurrentPhase();
    queueDebug({ t: "rewards", items: ["TIER:MASTER", "LEFTOVERS"] });
    await vi.waitUntil(() => r.ctx.game.scene.phaseManager.getCurrentPhase() !== before, {
      interval: 5,
      timeout: 4000,
    });
    await openUi(r.ctx, "SelectModifierPhase");
    const ids = (rewardScreen(r) as unknown as { typeOptions: ModifierTypeOption[] }).typeOptions.map(
      option => option.type.id,
    );
    expect(masterIds()).toContain(ids[0]);
    expect(ids[1]).toBe("LEFTOVERS");
    pickerSkips(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("as the guest: the host's tier pick and item are on this client's reward screen too", async () => {
    let sent = false;
    const r = await start({
      seat: "guest",
      policy: {
        auto: ["TURN_COMMANDS", "LEARN_MOVE", "EVOLUTION_CANCEL", "DEBUG"],
        other: key => {
          if (key.kind !== "DEBUG" || !String(key.ref).startsWith("t")) {
            return;
          }
          const actions = sent ? [] : [{ t: "rewards", items: ["LEFTOVERS", "TIER:MASTER"] }, { t: "win" }];
          sent = true;
          return { actions };
        },
      },
    });
    expect(await playTurn(r)).toBe("SelectModifierPhase");
    await openUi(r.ctx, "SelectModifierPhase");
    const ids = (rewardScreen(r) as unknown as { typeOptions: ModifierTypeOption[] }).typeOptions.map(
      option => option.type.id,
    );
    expect(ids[0]).toBe("LEFTOVERS");
    expect(masterIds()).toContain(ids[1]);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("the same state and the same random numbers roll the same tier picks", async () => {
    const r = await start();
    await advanceTo(r.ctx, ["CommandPhase"]);
    const party = r.ctx.game.scene.getPlayerParty();
    regenerateModifierPoolThresholds(party, ModifierPoolType.PLAYER);
    const roll = (): string[] => {
      r.session.debugState.rewards = ["TIER:MASTER", "TIER:ROGUE", "TIER:ULTRA"];
      return getPlayerModifierTypeOptions(3, party).map(option => option.type.id);
    };
    const random = Phaser.Math.RND.state();
    const first = roll();
    Phaser.Math.RND.state(random);
    expect(roll()).toEqual(first);
    expect(masterIds()).toContain(first[0]);
    expect(r.session.debugState.rewards).toBeNull();
  });

  it("a tier pick on a screen of guaranteed items only (a Mystery Encounter's) takes its first option", async () => {
    const r = await start();
    await advanceTo(r.ctx, ["CommandPhase"]);
    r.session.debugState.rewards = ["TIER:MASTER"];
    regenerateModifierPoolThresholds(r.ctx.game.scene.getPlayerParty(), ModifierPoolType.PLAYER);
    const options = getPlayerModifierTypeOptions(1, r.ctx.game.scene.getPlayerParty(), undefined, {
      guaranteedModifierTypeFuncs: [modifierTypes.POTION],
      fillRemaining: false,
    });
    expect(options).toHaveLength(1);
    expect(masterIds()).toContain(options[0].type.id);
  });

  it("the host gives exact held items: Charcoal and a Mega Stone; the change log says the turn", async () => {
    const r = await start({ configure: game => game.override.startingLevel(5) });
    await advanceTo(r.ctx, ["CommandPhase"]);
    const target = guestMon(r);
    const change = queueDebugChange(
      "Items",
      null,
      { t: "item", p: target.id, item: itemId("ATTACK_TYPE_BOOSTER", PokemonType.FIRE), count: 2 },
      { t: "item", p: target.id, item: itemId("RARE_FORM_CHANGE_ITEM", FormChangeItem.CHARIZARDITE_X), count: 1 },
    );
    const turn = r.ctx.game.scene.currentBattle.turn;
    await playTurn(r);
    const held = r.ctx.game.scene.findModifiers(
      modifier => modifier instanceof PokemonHeldItemModifier && modifier.pokemonId === target.id,
    );
    const booster = held.find(modifier => modifier instanceof AttackTypeBoosterModifier);
    expect(booster?.moveType).toBe(PokemonType.FIRE);
    expect(booster?.stackCount).toBe(2);
    const stone = held.find(modifier => modifier instanceof PokemonFormChangeItemModifier);
    expect(stone?.formChangeItem).toBe(FormChangeItem.CHARIZARDITE_X);
    expect(debugChanges().find(entry => entry.id === change.id)).toMatchObject({
      state: "applied",
      where: { wave: 1, turn },
    });
    expect(r.session.desyncMessage).toBeNull();
  });

  it("F8 opens the debug window beside the game: both teams live; one click is one change; pending, then applied", async () => {
    const r = await start({ configure: game => game.override.startingLevel(5) });
    await advanceTo(r.ctx, ["CommandPhase"]);
    const popupDoc = document.implementation.createHTMLDocument("");
    const popup = {
      document: popupDoc,
      closed: false,
      focus: () => {},
      close: () => {
        popup.closed = true;
      },
    };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    startDebugPanel();
    toggleDebugPanel();
    expect(debugPanelInfo()).toMatchObject({ open: true, kind: "window", section: "pokemon" });
    const root = popupDoc.getElementById("coopDebug")!;
    const scene = r.ctx.game.scene;
    expect(root.querySelectorAll(".cdw-live .cdw-mon")).toHaveLength(
      scene.getPlayerParty().length + scene.getEnemyField().filter(enemy => enemy.isActive(true)).length,
    );
    // One click, one change: the first Pokémon to level 100; a second change to its level replaces the first
    const first = scene.getPlayerParty()[0];
    const buttons = (selector: string) => Array.from(root.querySelectorAll<HTMLButtonElement>(selector));
    buttons(".cdw-who button")
      .find(node => node.textContent === "Lv 100")!
      .click();
    expect(waitingDebug()).toEqual([{ t: "level", p: first.id, v: 100 }]);
    expect(root.querySelector(".cdw-log .cdw-pending")?.textContent).toContain("100");
    buttons(".cdw-f button")
      .find(node => node.textContent === "50")!
      .click();
    expect(waitingDebug()).toEqual([{ t: "level", p: first.id, v: 50 }]);
    // F8 again brings the window forward; it stays open
    toggleDebugPanel();
    expect(debugPanelInfo()?.open).toBe(true);

    await playTurn(r);
    expect(first.level).toBe(50);
    const applied = root.querySelector(".cdw-log .cdw-applied");
    expect(applied?.textContent).toContain("50");
    expect(applied?.querySelector("small")?.textContent).toContain("turn");
    expect(waitingDebug()).toEqual([]);
  });

  it("a browser that blocks the window gets it over the game; the catalog puts a Mega Stone on the next reward screen in one click", async () => {
    await start();
    vi.spyOn(window, "open").mockReturnValue(null);
    startDebugPanel();
    toggleDebugPanel();
    expect(debugPanelInfo()).toMatchObject({ open: true, kind: "overlay" });
    const root = document.getElementById("coopDebug")!;
    expect(root.hidden).toBe(false);
    showDebugSection("rewards");
    const megaStone = itemId("RARE_FORM_CHANGE_ITEM", FormChangeItem.CHARIZARDITE_X);
    const fireStone = itemId("EVOLUTION_ITEM", EvolutionItem.FIRE_STONE);
    root.querySelector<HTMLButtonElement>('[data-family="forms"]')!.click();
    root.querySelector<HTMLButtonElement>(`[data-item="${megaStone}"]`)!.click();
    expect(waitingDebug()).toEqual([{ t: "rewards", items: [megaStone] }]);
    root.querySelector<HTMLButtonElement>('[data-family="evolution"]')!.click();
    root.querySelector<HTMLButtonElement>(`[data-item="${fireStone}"]`)!.click();
    // the list is one change: the newest replaces the one that waited
    expect(waitingDebug()).toEqual([{ t: "rewards", items: [megaStone, fireStone] }]);
    expect(debugChanges().filter(entry => entry.state === "pending")).toHaveLength(1);
    // F8 closes the panel over the game
    toggleDebugPanel();
    expect(root.hidden).toBe(true);
    expect(debugPanelInfo()?.open).toBe(false);
  });

  it("on an open reward screen, an item picked in the catalog joins the host's items the screen already shows", async () => {
    const r = await start();
    expect(await winWave(r)).toBe(true);
    vi.spyOn(window, "open").mockReturnValue(null);
    startDebugPanel();
    toggleDebugPanel();
    showDebugSection("rewards");
    const root = document.getElementById("coopDebug")!;
    const megaStone = itemId("RARE_FORM_CHANGE_ITEM", FormChangeItem.CHARIZARDITE_X);
    const fireStone = itemId("EVOLUTION_ITEM", EvolutionItem.FIRE_STONE);
    const redrawn = async (before: unknown): Promise<void> => {
      await vi.waitUntil(() => r.ctx.game.scene.phaseManager.getCurrentPhase() !== before, {
        interval: 5,
        timeout: 4000,
      });
      await openUi(r.ctx, "SelectModifierPhase");
    };
    let before: unknown = r.ctx.game.scene.phaseManager.getCurrentPhase();
    root.querySelector<HTMLButtonElement>('[data-family="forms"]')!.click();
    root.querySelector<HTMLButtonElement>(`[data-item="${megaStone}"]`)!.click();
    await redrawn(before);
    // (the window draws the new screen's step)
    showDebugSection("rewards");
    before = r.ctx.game.scene.phaseManager.getCurrentPhase();
    root.querySelector<HTMLButtonElement>('[data-family="evolution"]')!.click();
    root.querySelector<HTMLButtonElement>(`[data-item="${fireStone}"]`)!.click();
    expect(debugChanges().at(-1)?.actions).toEqual([{ t: "rewards", items: [megaStone, fireStone] }]);
    await redrawn(before);
    const types = (rewardScreen(r) as unknown as { typeOptions: ModifierTypeOption[] }).typeOptions.map(
      option => option.type,
    );
    expect((types[0] as FormChangeItemModifierType).formChangeItem).toBe(FormChangeItem.CHARIZARDITE_X);
    expect((types[1] as EvolutionItemModifierType).evolutionItem).toBe(EvolutionItem.FIRE_STONE);
    pickerSkips(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("the Mega Stones come first among the form change items", async () => {
    await start();
    const forms = itemCatalog().filter(item => item.family === "forms");
    expect(forms[0].id.startsWith("RARE_FORM_CHANGE_ITEM:")).toBe(true);
    const lastMega = forms.findLastIndex(item => item.id.startsWith("RARE_FORM_CHANGE_ITEM:"));
    const firstOther = forms.findIndex(item => item.id.startsWith("FORM_CHANGE_ITEM:"));
    expect(lastMega).toBeLessThan(firstOther);
  });

  it("as the guest: the host's batch is carried out on this client too", async () => {
    let sent = false;
    const r = await start({
      seat: "guest",
      policy: {
        auto: ["TURN_COMMANDS", "LEARN_MOVE", "EVOLUTION_CANCEL", "DEBUG"],
        other: key => {
          if (key.kind !== "DEBUG" || !String(key.ref).startsWith("t")) {
            return;
          }
          const mine = run!.ctx.game.scene.getPlayerParty().find(p => ownerOf(p) === "guest")!;
          const actions = sent ? [] : [{ t: "level", p: mine.id, v: 77 }, { t: "allShiny" }];
          sent = true;
          return { actions };
        },
      },
    });
    await playTurn(r);
    const mine = r.ctx.game.scene.getPlayerParty().find(p => ownerOf(p) === "guest")!;
    expect(mine.level).toBe(77);
    expect(r.ctx.game.scene.getPlayerParty().every(pokemon => pokemon.shiny)).toBe(true);
    expect(r.session.desyncMessage).toBeNull();
  });
});
