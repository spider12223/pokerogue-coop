/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EvolutionItem } from "#balance/pokemon-evolutions";
import type { DebugBatch } from "#coop/debug/actions";
import { itemCatalog, makeItemType, partyMembersFor } from "#coop/debug/catalog";
import { debugShouldTera } from "#coop/debug/enemy-plan";
import { debugEnemyPlan } from "#coop/debug/hooks";
import { itemId } from "#coop/debug/item-id";
import { writeDebugOverrides } from "#coop/debug/overrides";
import { debugPanelInfo, showDebugSection, startDebugPanel, stopDebugPanel, toggleDebugPanel } from "#coop/debug/panel";
import { clearDebugQueue, debugChanges, queueDebug, queueDebugChange, waitingDebug } from "#coop/debug/queue";
import { placeDebugRewards } from "#coop/debug/rewards";
import { emptyEnemyPlan, emptyWavePlan, type WavePlan } from "#coop/debug/state";
import type { SectionId } from "#coop/debug/view";
import { ownerOf } from "#coop/decisions/control";
import { debugTurnKey } from "#coop/decisions/decision-keys";
import type { Decision } from "#coop/decisions/sequencer";
import type { DecisionKey } from "#coop/protocol";
import { modifierTypes } from "#data/data-lists";
import { Gender } from "#data/gender";
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
import type { EnemyPokemon } from "#field/pokemon";
import { AttackTypeBoosterModifier, PokemonFormChangeItemModifier, PokemonHeldItemModifier } from "#modifiers/modifier";
import type {
  EvolutionItemModifierType,
  FormChangeItemModifierType,
  ModifierTypeOption,
  TmModifierType,
} from "#modifiers/modifier-type";
import { getPlayerModifierTypeOptions, regenerateModifierPoolThresholds } from "#modifiers/modifier-type";
import { advanceTo, openUi, queueTurnCommands, reloadWave } from "#test/helpers/coop-harness";
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
    const plan = {
      ...emptyWavePlan(),
      battle: "wild" as const,
      enemies: [
        { ...emptyEnemyPlan(), species: SpeciesId.MEWTWO, level: 3 },
        { ...emptyEnemyPlan(), species: SpeciesId.MEW, level: 3 },
      ],
    };
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
    const bossOf5 = { ...emptyEnemyPlan(), boss: 3, level: 5 };
    queueDebug({ t: "plan", wave: 2, plan: { ...emptyWavePlan(), battle: "wild", enemies: [bossOf5, bossOf5] } });
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

  /** The host plans wave 2 with the batch that wins wave 1; wave 2's enemies are made */
  async function planWave2(r: LinkedRun, plan: WavePlan): Promise<EnemyPokemon[]> {
    await advanceTo(r.ctx, ["CommandPhase"]);
    queueDebug({ t: "plan", wave: 2, plan });
    await winFirstWave(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    expect(r.ctx.game.scene.currentBattle.waveIndex).toBe(2);
    return r.ctx.game.scene.getEnemyParty();
  }

  /** Everything a plan can set on an enemy, and its id */
  const snapshot = (enemy: EnemyPokemon) => ({
    id: enemy.id,
    species: enemy.species.speciesId,
    fusion: enemy.fusionSpecies?.speciesId ?? null,
    shiny: [enemy.shiny, enemy.variant, enemy.fusionShiny, enemy.fusionVariant],
    level: enemy.level,
    hp: [enemy.hp, enemy.getMaxHp()],
    ability: enemy.getAbility().id,
    nature: enemy.getNature(),
    gender: enemy.gender,
    tera: enemy.teraType,
    moves: enemy.moveset.map(move => move.moveId),
    items: enemy.getHeldItems().map(item => [item.type.id, item.stackCount]),
    boss: enemy.bossSegments,
  });

  it("a wild plan: Charizard fused with Gengar, ★★★, Lv 50, every option; the second enemy is the game's pick", async () => {
    const r = await start({ configure: game => game.override.startingLevel(40).enemyMoveset([]) });
    const [first, second] = await planWave2(r, {
      ...emptyWavePlan(),
      battle: "wild",
      enemies: [
        {
          ...emptyEnemyPlan(),
          species: SpeciesId.CHARIZARD,
          fusion: SpeciesId.GENGAR,
          shiny: 2,
          level: 50,
          ability: AbilityId.INTIMIDATE,
          nature: Nature.TIMID,
          gender: Gender.FEMALE,
          tera: PokemonType.FIRE,
          moves: [MoveId.FLAMETHROWER, 0, 0, 0],
          items: ["LEFTOVERS", "LEFTOVERS"],
        },
      ],
    });
    expect(r.ctx.game.scene.currentBattle.battleType).toBe(BattleType.WILD);
    expect(first.species.speciesId).toBe(SpeciesId.CHARIZARD);
    expect(first.fusionSpecies?.speciesId).toBe(SpeciesId.GENGAR);
    expect([first.shiny, first.variant, first.fusionShiny, first.fusionVariant]).toEqual([true, 2, true, 2]);
    expect(first.level).toBe(50);
    expect(first.hp).toBe(first.getMaxHp());
    expect(first.getAbility().id).toBe(AbilityId.INTIMIDATE);
    expect([first.getNature(), first.gender, first.teraType]).toEqual([Nature.TIMID, Gender.FEMALE, PokemonType.FIRE]);
    expect(first.getMoveset()[0].moveId).toBe(MoveId.FLAMETHROWER);
    expect(first.getHeldItems().find(item => item.type.id === "LEFTOVERS")?.stackCount).toBe(2);
    expect(second.species.speciesId).not.toBe(SpeciesId.CHARIZARD);
    expect(second.isFusion()).toBe(false);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("the host and the guest make the same planned enemies, a random fusion too", async () => {
    const plan: WavePlan = {
      ...emptyWavePlan(),
      battle: "wild",
      enemies: [
        { ...emptyEnemyPlan(), species: SpeciesId.PIKACHU, fusion: "random", shiny: 1, items: ["LEFTOVERS"] },
        { ...emptyEnemyPlan(), level: 9, nature: Nature.BOLD },
      ],
    };
    const host = (await planWave2(await start(), plan)).map(snapshot);
    run?.close();
    run = null;
    clearDebugQueue();
    writeDebugOverrides(null, 0);

    let sent = false;
    const r = await start({
      seat: "guest",
      policy: {
        auto: ["TURN_COMMANDS", "LEARN_MOVE", "EVOLUTION_CANCEL", "DEBUG"],
        other: key => {
          if (key.kind !== "DEBUG" || !String(key.ref).startsWith("t")) {
            return;
          }
          const actions = sent ? [] : [{ t: "plan", wave: 2, plan }, { t: "win" }];
          sent = true;
          return { actions };
        },
      },
    });
    expect(await playTurn(r)).toBe("SelectModifierPhase");
    await openUi(r.ctx, "SelectModifierPhase");
    pickerSkips(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    const guest = r.ctx.game.scene.getEnemyParty().map(snapshot);
    expect(guest).toEqual(host);
    expect(host[0].fusion).not.toBeNull();
    expect(host[0].shiny).toEqual([true, 1, true, 1]);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("boss bars, and “not a boss”", async () => {
    const r = await start({ configure: game => game.override.startingLevel(40) });
    const [mewtwo, other] = await planWave2(r, {
      ...emptyWavePlan(),
      battle: "wild",
      enemies: [
        { ...emptyEnemyPlan(), species: SpeciesId.MEWTWO, boss: 1 },
        { ...emptyEnemyPlan(), boss: 4 },
      ],
    });
    expect(mewtwo.species.speciesId).toBe(SpeciesId.MEWTWO);
    expect(mewtwo.isBoss()).toBe(false);
    expect(other.bossSegments).toBe(4);
  });

  it("a wild plan stops the game's Mystery Encounter roll", async () => {
    const r = await start({ configure: game => game.override.startingLevel(40).mysteryEncounterChance(100) });
    await advanceTo(r.ctx, ["CommandPhase"]);
    queueDebug(
      { t: "jump", v: 12 },
      {
        t: "plan",
        wave: 12,
        plan: { ...emptyWavePlan(), battle: "wild", enemies: [{ ...emptyEnemyPlan(), species: SpeciesId.MEWTWO }] },
      },
    );
    await winFirstWave(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    const battle = r.ctx.game.scene.currentBattle;
    expect(battle.waveIndex).toBe(12);
    expect(battle.battleType).toBe(BattleType.WILD);
    expect(r.ctx.game.scene.getEnemyParty()[0].species.speciesId).toBe(SpeciesId.MEWTWO);
  });

  it("a trainer plan: its members come first, then the trainer's own; six against a small team make no error", async () => {
    const r = await start({ configure: game => game.override.startingLevel(40) });
    const party = await planWave2(r, {
      ...emptyWavePlan(),
      battle: "trainer",
      trainer: TrainerType.YOUNGSTER,
      enemies: [
        { ...emptyEnemyPlan(), species: SpeciesId.DRAGONITE },
        { ...emptyEnemyPlan(), level: 77 },
        ...Array.from({ length: 4 }, () => ({ ...emptyEnemyPlan(), species: SpeciesId.MEW })),
      ],
    });
    const battle = r.ctx.game.scene.currentBattle;
    expect(battle.battleType).toBe(BattleType.TRAINER);
    expect(battle.trainer?.config.trainerType).toBe(TrainerType.YOUNGSTER);
    expect(party.length).toBeGreaterThanOrEqual(2);
    expect(party[0].species.speciesId).toBe(SpeciesId.DRAGONITE);
    expect(party[1].level).toBe(77);
    expect(party[1].species.speciesId).not.toBe(SpeciesId.DRAGONITE);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("a fixed wave keeps its battle; the plan's members are that trainer's", async () => {
    const r = await start({ configure: game => game.override.startingLevel(40) });
    await advanceTo(r.ctx, ["CommandPhase"]);
    queueDebug(
      { t: "jump", v: 5 },
      {
        t: "plan",
        wave: 5,
        plan: { ...emptyWavePlan(), battle: "wild", enemies: [{ ...emptyEnemyPlan(), species: SpeciesId.DRAGONITE }] },
      },
    );
    await winFirstWave(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    const scene = r.ctx.game.scene;
    expect(scene.currentBattle.waveIndex).toBe(5);
    expect(scene.gameMode.isFixedBattle(5)).toBe(true);
    expect(scene.currentBattle.battleType).toBe(BattleType.TRAINER);
    expect(scene.getEnemyParty()[0].species.speciesId).toBe(SpeciesId.DRAGONITE);
  });

  it("a planned Terastallize: on its first turn, once", async () => {
    const r = await start({ configure: game => game.override.startingLevel(40) });
    const [first] = await planWave2(r, {
      ...emptyWavePlan(),
      battle: "wild",
      // (strong enough to live through our attacks: a knocked out Pokémon is no longer Terastallized)
      enemies: [{ ...emptyEnemyPlan(), tera: PokemonType.WATER, level: 100, boss: 5 }],
    });
    expect(first.isTerastallized).toBe(false);
    await playTurn(r);
    expect(first.isTerastallized).toBe(true);
    expect(first.getTeraType()).toBe(PokemonType.WATER);
    await playTurn(r);
    expect(first.isTerastallized).toBe(true);
    expect(r.session.desyncMessage).toBeNull();
  });

  it("a planned Terastallize after a reload of its wave, before its first turn: still on that turn", async () => {
    const r = await start({ configure: game => game.override.startingLevel(40).enemyLevel(0) });
    // (the harness's enemy level override would also level the reloaded enemies: off here)
    const [before] = await planWave2(r, {
      ...emptyWavePlan(),
      battle: "wild",
      // (strong enough to live through our attacks: a knocked out Pokémon is no longer Terastallized)
      enemies: [{ ...emptyEnemyPlan(), tera: PokemonType.WATER, level: 100, boss: 5 }],
    });
    expect(before.isTerastallized).toBe(false);
    reloadWave(r.ctx, 2);
    await advanceTo(r.ctx, ["CommandPhase"]);
    await playTurn(r);
    const after = r.ctx.game.scene.getEnemyParty()[0];
    // (the wave was made again from its save: a new Pokémon, which still Terastallizes on its first turn)
    expect(after).not.toBe(before);
    expect(after.isTerastallized).toBe(true);
    expect(after.getTeraType()).toBe(PokemonType.WATER);
  });

  it("a fixed wave's trainer keeps its planned member as planned: the rival's own set-up does not undo it", async () => {
    const r = await start({ configure: game => game.override.startingLevel(40).enemyMoveset([]) });
    await advanceTo(r.ctx, ["CommandPhase"]);
    queueDebug(
      { t: "jump", v: 8 },
      {
        t: "plan",
        wave: 8,
        plan: {
          ...emptyWavePlan(),
          battle: "trainer",
          enemies: [
            { ...emptyEnemyPlan(), level: 77, tera: PokemonType.WATER, moves: [MoveId.SPLASH, 0, 0, 0], boss: 3 },
            { ...emptyEnemyPlan(), species: SpeciesId.MEW },
          ],
        },
      },
    );
    await winFirstWave(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    const scene = r.ctx.game.scene;
    expect(scene.currentBattle.waveIndex).toBe(8);
    expect(scene.currentBattle.trainer?.config.trainerType).toBe(TrainerType.RIVAL);
    const [starter, second] = scene.getEnemyParty();
    // (the rival's starter is given its own Tera type, ability and moves after it is made: the plan comes after that)
    expect(starter.teraType).toBe(PokemonType.WATER);
    expect(starter.level).toBe(77);
    expect(starter.getMoveset()[0].moveId).toBe(MoveId.SPLASH);
    expect(starter.bossSegments).toBe(3);
    expect(second.species.speciesId).toBe(SpeciesId.MEW);
  });

  it("a planned Tera type holds against the trainer's own Tera set-up", async () => {
    const r = await start({ configure: game => game.override.startingLevel(40) });
    // (an Elite Four member gives one member a Tera of its type when its AI is made: every column is planned)
    const party = await planWave2(r, {
      ...emptyWavePlan(),
      battle: "trainer",
      trainer: TrainerType.LORELEI,
      enemies: Array.from({ length: 6 }, () => ({ ...emptyEnemyPlan(), tera: PokemonType.FAIRY })),
    });
    expect(r.ctx.game.scene.currentBattle.trainer?.config.trainerType).toBe(TrainerType.LORELEI);
    expect(party.map(enemy => enemy.teraType)).toEqual(party.map(() => PokemonType.FAIRY));
  });

  it("a planned nature holds against our lead's Synchronize", async () => {
    const r = await start({
      configure: game => game.override.startingLevel(40).ability(AbilityId.SYNCHRONIZE).nature(Nature.ADAMANT),
    });
    const [first, second] = await planWave2(r, {
      ...emptyWavePlan(),
      battle: "wild",
      enemies: [{ ...emptyEnemyPlan(), nature: Nature.TIMID }],
    });
    expect(first.getNature()).toBe(Nature.TIMID);
    expect(first.hp).toBe(first.getMaxHp());
    // (the game's own Synchronize still works on the enemy without a planned nature)
    expect(second.getNature()).toBe(Nature.ADAMANT);
  });

  it("a planned enemy that fainted does not Terastallize again (once, as a trainer's)", async () => {
    const r = await start({ configure: game => game.override.startingLevel(40) });
    const [first] = await planWave2(r, {
      ...emptyWavePlan(),
      battle: "wild",
      enemies: [{ ...emptyEnemyPlan(), tera: PokemonType.WATER, level: 100, boss: 5 }],
    });
    expect(debugShouldTera(first)).toBe(true);
    r.ctx.game.scene.currentBattle.enemyFaintsHistory.push({ pokemon: first, turn: 1 });
    expect(debugShouldTera(first)).toBe(false);
  });

  it("the same move planned in two slots stays in the first", async () => {
    const r = await start({ configure: game => game.override.startingLevel(40).enemyMoveset([]) });
    const [first] = await planWave2(r, {
      ...emptyWavePlan(),
      battle: "wild",
      enemies: [{ ...emptyEnemyPlan(), moves: [MoveId.FLAMETHROWER, MoveId.FLAMETHROWER, MoveId.SURF, 0] }],
    });
    const moves = first.getMoveset().map(move => move.moveId);
    expect(moves[0]).toBe(MoveId.FLAMETHROWER);
    expect(moves.filter(move => move === MoveId.FLAMETHROWER)).toHaveLength(1);
    expect(moves).toContain(MoveId.SURF);
  });

  it("a tier pick is rolled against the host's exact items of the screen too", async () => {
    const r = await start();
    await advanceTo(r.ctx, ["CommandPhase"]);
    const party = r.ctx.game.scene.getPlayerParty();
    regenerateModifierPoolThresholds(party, ModifierPoolType.PLAYER);
    const options = getPlayerModifierTypeOptions(3, party);
    r.session.debugState.rewards = ["TIER:MASTER", "MASTER_BALL"];
    let others: string[] = [];
    placeDebugRewards(options, party, (_tier, rest) => {
      others = rest.map(option => option.type.id);
      return null;
    });
    expect(others).toContain("MASTER_BALL");
    expect(options[1].type.id).toBe("MASTER_BALL");
  });

  it("a planned Mystery Encounter is the next wave, whatever the wave", async () => {
    const r = await start({ configure: game => game.override.startingLevel(10) });
    await advanceTo(r.ctx, ["CommandPhase"]);
    queueDebug({
      t: "plan",
      wave: 2,
      plan: {
        ...emptyWavePlan(),
        battle: "me",
        encounter: MysteryEncounterType.DEPARTMENT_STORE_SALE,
        // (a column on an encounter's plan is for none of its enemies)
        enemies: [{ ...emptyEnemyPlan(), species: SpeciesId.MEWTWO }],
      },
    });
    await winFirstWave(r);
    await advanceTo(r.ctx, ["MysteryEncounterPhase", "CommandPhase"]);
    const battle = r.ctx.game.scene.currentBattle;
    expect(battle.waveIndex).toBe(2);
    expect(battle.battleType).toBe(BattleType.MYSTERY_ENCOUNTER);
    expect(battle.mysteryEncounter?.encounterType).toBe(MysteryEncounterType.DEPARTMENT_STORE_SALE);
    expect(debugEnemyPlan(2)).toBeNull();
    expect(r.session.debugState.made).toBe(0);
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

  /** Open the debug window (its own document, as `window.open` gives it) on a section */
  function openWindow(section: SectionId): HTMLElement {
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
    showDebugSection(section);
    return popupDoc.getElementById("coopDebug")!;
  }

  /** Type into a search list of the window and pick the first entry that comes up */
  function pickIn(box: HTMLInputElement, text: string): void {
    box.dispatchEvent(new Event("focus"));
    box.value = text;
    box.dispatchEvent(new Event("input"));
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  }

  const columns = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(".cdw-ecol"));

  it("the Waves tab: one pick on a Game's wave plans a wild battle; the summary says so", async () => {
    const r = await start();
    await advanceTo(r.ctx, ["CommandPhase"]);
    const root = openWindow("waves");
    expect(root.querySelector(".cdw-sum")?.textContent).toBe("Wave 2: the game's choice.");
    expect(columns(root)).toHaveLength(2);
    pickIn(columns(root)[0].querySelector<HTMLInputElement>(".cdw-pick input")!, "Charizard");
    expect(waitingDebug()).toEqual([
      {
        t: "plan",
        wave: 2,
        plan: { ...emptyWavePlan(), battle: "wild", enemies: [{ ...emptyEnemyPlan(), species: SpeciesId.CHARIZARD }] },
      },
    ]);
    expect(root.querySelector(".cdw-sum")?.textContent).toBe(
      "Wave 2: wild double battle. Charizard; and the game's pick.",
    );
    expect(root.querySelector(".cdw-seg .cdw-on")?.textContent).toBe("Wild");
  });

  it("the Waves tab: More opens one column, says how many options it holds, and stays open when the window redraws", async () => {
    const r = await start();
    await advanceTo(r.ctx, ["CommandPhase"]);
    const root = openWindow("waves");
    const moreOf = (column: number) => columns(root)[column].querySelector<HTMLButtonElement>(".cdw-morebtn")!;
    expect(root.querySelectorAll(".cdw-morebox")).toHaveLength(0);
    moreOf(0).click();
    expect(root.querySelectorAll(".cdw-morebox")).toHaveLength(1);
    expect(columns(root)[0].querySelector(".cdw-morebox")).not.toBeNull();
    const nature = columns(root)[0].querySelector<HTMLSelectElement>(".cdw-morebox select")!;
    nature.value = String(Nature.TIMID);
    nature.dispatchEvent(new Event("change"));
    expect(waitingDebug()).toEqual([
      {
        t: "plan",
        wave: 2,
        plan: { ...emptyWavePlan(), battle: "wild", enemies: [{ ...emptyEnemyPlan(), nature: Nature.TIMID }] },
      },
    ]);
    expect(moreOf(0).textContent).toContain("(1)");
    await playTurn(r);
    expect(waitingDebug()).toEqual([]);
    expect(r.session.debugState.plans["2"]?.enemies[0]?.nature).toBe(Nature.TIMID);
    expect(root.querySelectorAll(".cdw-morebox")).toHaveLength(1);
    expect(moreOf(0).textContent).toContain("(1)");
  });

  it("the Waves tab: a fixed wave names its battle and plans the trainer's team", async () => {
    const r = await start();
    await advanceTo(r.ctx, ["CommandPhase"]);
    const root = openWindow("waves");
    const wave = root.querySelector<HTMLInputElement>('[data-keep="plan-wave"]')!;
    wave.value = "5";
    wave.dispatchEvent(new Event("change"));
    expect(root.textContent).toContain("Wave 5: the youngster's battle. It always happens.");
    // (no kind to choose: the fixed battle stays)
    expect(Array.from(root.querySelectorAll(".cdw-seg button")).map(b => b.textContent)).not.toContain("Mystery");
    Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .find(b => b.textContent === "+ Add a team member")!
      .click();
    pickIn(columns(root)[0].querySelector<HTMLInputElement>(".cdw-pick input")!, "Dragonite");
    expect(waitingDebug()).toEqual([
      {
        t: "plan",
        wave: 5,
        plan: {
          ...emptyWavePlan(),
          battle: "trainer",
          enemies: [{ ...emptyEnemyPlan(), species: SpeciesId.DRAGONITE }],
        },
      },
    ]);
    expect(root.querySelector(".cdw-sum")?.textContent).toBe(
      "Wave 5: the youngster's battle (fixed). Dragonite; the rest of the team is the trainer's own.",
    );
  });

  it("a pick from a list leaves the box: the window drawn again does not open the list again over what is below", async () => {
    const r = await start();
    await advanceTo(r.ctx, ["CommandPhase"]);
    // (over the game, in this document: a box here can have the focus)
    vi.spyOn(window, "open").mockReturnValue(null);
    startDebugPanel();
    toggleDebugPanel();
    showDebugSection("waves");
    const root = document.getElementById("coopDebug")!;
    const box = columns(root)[0].querySelector<HTMLInputElement>(".cdw-pick input")!;
    box.focus();
    expect(document.activeElement).toBe(box);
    expect(root.querySelectorAll(".cdw-menu")).toHaveLength(1);
    box.value = "Charizard";
    box.dispatchEvent(new Event("input"));
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(waitingDebug()).toHaveLength(1);
    expect(root.querySelectorAll(".cdw-menu")).toHaveLength(0);
    expect((document.activeElement as HTMLElement | null)?.dataset["keep"]).not.toBe("plan-0-species");
  });

  it("the Waves tab: the wave being played is not among the other planned waves", async () => {
    const r = await start();
    const wild = { ...emptyWavePlan(), battle: "wild" as const, enemies: [{ ...emptyEnemyPlan(), level: 9 }] };
    await advanceTo(r.ctx, ["CommandPhase"]);
    queueDebug({ t: "plan", wave: 2, plan: wild }, { t: "plan", wave: 4, plan: wild });
    await winFirstWave(r);
    await advanceTo(r.ctx, ["CommandPhase"]);
    expect(r.ctx.game.scene.currentBattle.waveIndex).toBe(2);
    const root = openWindow("waves");
    expect(Array.from(root.querySelectorAll(".cdw-table td:first-child")).map(cell => cell.textContent)).toEqual([
      "Wave 4",
    ]);
  });

  it("the Waves tab: × on a trainer's member sets it back to the trainer's own, in its place", async () => {
    const r = await start();
    await advanceTo(r.ctx, ["CommandPhase"]);
    const member = (species: SpeciesId) => ({ ...emptyEnemyPlan(), species });
    queueDebugChange("plan", "plan:2", {
      t: "plan",
      wave: 2,
      plan: {
        ...emptyWavePlan(),
        battle: "trainer",
        enemies: [member(SpeciesId.MEW), member(SpeciesId.MEWTWO), member(SpeciesId.DRAGONITE)],
      },
    });
    const root = openWindow("waves");
    const clear = (column: number) =>
      columns(root)[column].querySelector<HTMLButtonElement>(".cdw-ecol-h .cdw-x")!.click();
    clear(0);
    expect(waitingDebug()).toEqual([
      {
        t: "plan",
        wave: 2,
        plan: {
          ...emptyWavePlan(),
          battle: "trainer",
          enemies: [null, member(SpeciesId.MEWTWO), member(SpeciesId.DRAGONITE)],
        },
      },
    ]);
    // (the last one goes; the empty first one stays: it is the trainer's own)
    clear(2);
    expect(waitingDebug()).toEqual([
      {
        t: "plan",
        wave: 2,
        plan: { ...emptyWavePlan(), battle: "trainer", enemies: [null, member(SpeciesId.MEWTWO)] },
      },
    ]);
    expect(columns(root)).toHaveLength(2);
  });

  it("the Waves tab's summary counts the options under More; a boss wave is one boss; a level of 0 reads “game's”", async () => {
    const r = await start();
    await advanceTo(r.ctx, ["CommandPhase"]);
    queueDebugChange("plan", "plan:2", {
      t: "plan",
      wave: 2,
      plan: { ...emptyWavePlan(), battle: "wild", enemies: [{ ...emptyEnemyPlan(), nature: Nature.TIMID }] },
    });
    const root = openWindow("waves");
    expect(root.querySelector(".cdw-sum")?.textContent).toBe(
      "Wave 2: wild double battle. The game's pick, +1 more; and the game's pick.",
    );
    const level = root.querySelector<HTMLInputElement>('[data-keep="plan-1-level"]')!;
    expect([level.value, level.placeholder]).toEqual(["", "game's"]);
    const wave = root.querySelector<HTMLInputElement>('[data-keep="plan-wave"]')!;
    wave.value = "10";
    wave.dispatchEvent(new Event("change"));
    pickIn(columns(root)[0].querySelector<HTMLInputElement>(".cdw-pick input")!, "Mewtwo");
    expect(root.querySelector(".cdw-sum")?.textContent).toBe("Wave 10: wild boss battle. Mewtwo.");
  });

  it("the search still finds the Waves tab's planner", async () => {
    const r = await start();
    await advanceTo(r.ctx, ["CommandPhase"]);
    const root = openWindow("waves");
    const search = root.querySelector<HTMLInputElement>(".cdw-search")!;
    for (const word of ["fusion", "shiny", "terastallize"]) {
      search.value = word;
      search.dispatchEvent(new Event("input"));
      expect(root.querySelectorAll(".cdw-ecol").length, word).toBeGreaterThan(0);
    }
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
