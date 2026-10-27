/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ownerOf } from "#coop/control";
import { MARK_COLORS } from "#coop/cosmetic-tag";
import { type MeChoice, meChoiceKey } from "#coop/me-choice";
import type { Seat } from "#coop/protocol";
import { requireCoopSession } from "#coop/session";
import { Button } from "#enums/buttons";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { Stat } from "#enums/stat";
import { UiMode } from "#enums/ui-mode";
import type { PlayerPokemon } from "#field/pokemon";
import type { MysteryEncounterPhase } from "#phases/mystery-encounter-phases";
import { advanceTo, openUi } from "#test/helpers/coop-harness";
import { type LinkedRun, openLinkedRun } from "#test/helpers/coop-linked";
import type { MysteryEncounterUiHandler } from "#ui/mystery-encounter-ui-handler";
import type { PartyUiHandler } from "#ui/party-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Mystery Encounters in a linked run (DECISIONS D29): the host makes the encounter's choices as sequenced decisions and both
 * clients carry them out; encounter battles are two against two (a lone wild Pokémon against two is made stronger); a
 * Pokémon the chooser picks is one of their own.
 */

const SIX = [
  SpeciesId.BULBASAUR,
  SpeciesId.SQUIRTLE,
  SpeciesId.CHARMANDER,
  SpeciesId.PIKACHU,
  SpeciesId.MACHOP,
  SpeciesId.GEODUDE,
];

describe("Co-op: Mystery Encounters in a linked run (D29)", () => {
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

  /**
   * A linked run whose first wave is this encounter
   * @param before - What happens before its first screen runs (the partner's answer to the question of who goes)
   */
  async function encounter(
    type: MysteryEncounterType,
    seat: Seat = "host",
    before?: (r: LinkedRun) => void,
  ): Promise<LinkedRun> {
    const wave = 16;
    run = await openLinkedRun(phaserGame, {
      seat,
      species: SIX,
      starterOwners: ["host", "guest", "host", "guest", "host", "guest"],
      configure: game =>
        game.override
          .startingLevel(40)
          .startingWave(wave)
          .mysteryEncounterChance(100)
          .mysteryEncounter(type)
          .disableTrainerWaves(),
      policy: { auto: ["TURN_COMMANDS", "LEARN_MOVE", "EVOLUTION_CANCEL"] },
    });
    await advanceTo(run.ctx, ["MysteryEncounterPhase"]);
    if (before !== undefined) {
      // an answer given before the phase runs: the encounter may be over at once
      before(run);
      return run;
    }
    // the phase starts and waits: for the chooser's pick, or for the decision
    await openUi(run.ctx, "MysteryEncounterPhase");
    return run;
  }

  /** The partner's answer to the first question of the encounter, sent before it is asked (it waits for it, D2) */
  const firstAnswer =
    (choice: MeChoice) =>
    (r: LinkedRun): void =>
      r.partner.propose(meChoiceKey(r.ctx.game.scene.currentBattle.waveIndex, 0), choice);

  const phase = (r: LinkedRun): MysteryEncounterPhase =>
    r.ctx.game.scene.phaseManager.getCurrentPhase() as unknown as MysteryEncounterPhase;

  /** Wait for `done`; a timeout says where the game is */
  async function until(r: LinkedRun, what: string, done: () => boolean): Promise<void> {
    try {
      await vi.waitUntil(done, { interval: 10, timeout: 4000 });
    } catch {
      const { scene } = r.ctx.game;
      const session = requireCoopSession();
      throw new Error(
        `never ${what}: phase ${scene.phaseManager.getCurrentPhase().phaseName}, mode ${UiMode[scene.ui.mode]}, question ${JSON.stringify(session.meQuestion)}, step ${session.meStep}, desync ${session.desyncMessage}`,
      );
    }
  }

  /** `advanceTo`, with where the game is if it stalls */
  async function advance(r: LinkedRun, targets: Parameters<typeof advanceTo>[1]): Promise<void> {
    try {
      await advanceTo(r.ctx, targets);
    } catch (error) {
      const { scene } = r.ctx.game;
      const session = requireCoopSession();
      throw new Error(
        `${(error as Error).message}: mode ${UiMode[scene.ui.mode]}, question ${JSON.stringify(session.meQuestion)}, step ${session.meStep}, window ${session.openWindow.map(key => `${key.kind}:${key.ref}`)}`,
      );
    }
  }

  /** The real client's player picks option `index` of the encounter's screen, once it asks */
  async function pickOption(r: LinkedRun, index: number): Promise<void> {
    await until(r, `picked option ${index}`, () => phase(r).coopPick?.(index) === true);
  }

  /** The scripted partner (the host here) answers the encounter's open question, once the real client asks it */
  async function partnerChooses(r: LinkedRun, choice: MeChoice): Promise<void> {
    await until(r, `asked a ${choice.k}`, () => requireCoopSession().meQuestion?.k === choice.k);
    const step = requireCoopSession().meStep - 1;
    r.partner.propose(meChoiceKey(r.ctx.game.scene.currentBattle.waveIndex, step), choice);
  }

  const own = (r: LinkedRun, seat: Seat): PlayerPokemon[] =>
    r.ctx.game.scene.getPlayerParty().filter(pokemon => ownerOf(pokemon) === seat);

  it("the host picks the option; a lone wild Pokémon fights two, stronger", async () => {
    const r = await encounter(MysteryEncounterType.SLUMBERING_SNORLAX);
    await pickOption(r, 0);
    await advance(r, ["CommandPhase"]);
    const { scene } = r.ctx.game;
    expect(scene.currentBattle.double).toBe(true);
    const [snorlax] = scene.getEnemyField();
    expect(scene.getEnemyField()).toHaveLength(1);
    expect(requireCoopSession().meLoneEnemy).toBe(snorlax.id);
    expect(snorlax.isBoss()).toBe(true);
    expect(snorlax.getStatStage(Stat.ATK)).toBeGreaterThanOrEqual(1);
    expect(snorlax.getStatStage(Stat.SPD)).toBeGreaterThanOrEqual(1);
    // each player's lead is in their slot
    expect(scene.getPlayerField().map(pokemon => ownerOf(pokemon))).toEqual(["host", "guest"]);
  });

  it("the guest waits while the host chooses, and carries out the host's pick", async () => {
    const r = await encounter(MysteryEncounterType.SLUMBERING_SNORLAX, "guest");
    // the guest's own pick does not count
    expect(phase(r).coopPick(1)).toBe(false);
    await partnerChooses(r, { k: "option", index: 0 });
    await advance(r, ["CommandPhase"]);
    expect(r.ctx.game.scene.currentBattle.double).toBe(true);
    expect(r.ctx.game.scene.getEnemyField()).toHaveLength(1);
    expect(requireCoopSession().meLoneEnemy).toBe(r.ctx.game.scene.getEnemyField()[0].id);
  });

  it("a trainer of an encounter sends out two at a time", async () => {
    const r = await encounter(MysteryEncounterType.MYSTERIOUS_CHALLENGERS);
    await pickOption(r, 0);
    await advance(r, ["CommandPhase"]);
    const { scene } = r.ctx.game;
    expect(scene.currentBattle.double).toBe(true);
    expect(scene.currentBattle.trainer).toBeDefined();
    expect(scene.getEnemyField()).toHaveLength(2);
    expect(requireCoopSession().meLoneEnemy).toBeNull();
  });

  it("the chooser picks one of their own Pokémon; the partner's are refused on the screen", async () => {
    const r = await encounter(MysteryEncounterType.PART_TIMER);
    await pickOption(r, 0);
    const { scene } = r.ctx.game;
    await until(r, "showed the party", () => scene.ui.mode === UiMode.PARTY);
    const party = scene.ui.getHandler() as PartyUiHandler;
    const pickSlot = (slot: number): void => {
      party.setCursor(slot);
      party.processInput(Button.ACTION);
      party.processInput(Button.ACTION);
    };
    const theirs = scene.getPlayerParty().indexOf(own(r, "guest")[1]);
    pickSlot(theirs);
    // still asking: the partner's Pokémon cannot be the one, and the screen says why
    expect(requireCoopSession().meQuestion?.k).toBe("pokemon");
    await until(r, "said that one is the partner's", () => {
      const message = party as unknown as { awaitingActionInput: boolean };
      return message.awaitingActionInput;
    });
    party.processInput(Button.ACTION);
    const mine = own(r, "host")[1];
    await until(r, "showed the party again", () => scene.ui.mode === UiMode.PARTY);
    pickSlot(scene.getPlayerParty().indexOf(mine));
    await until(r, "cut the PP", () => mine.moveset.every(move => move.getMovePp() - move.ppUsed <= 2));
    expect(own(r, "guest")[1].moveset.some(move => move.getMovePp() - move.ppUsed > 2)).toBe(true);
  });

  it("the guest carries out the host's Pokémon pick; a pick of the guest's Pokémon is illegal on both (D24)", async () => {
    const r = await encounter(MysteryEncounterType.PART_TIMER, "guest");
    const desyncs: string[] = [];
    r.link.sequencer.onDesync(error => desyncs.push(error.message));
    await partnerChooses(r, { k: "option", index: 0 });
    await partnerChooses(r, { k: "pokemon", pokemonId: own(r, "guest")[0].id });
    await until(r, "found the pick illegal", () => desyncs.length > 0);
    expect(desyncs[0]).toMatch(/illegal decision.*may not be chosen/);
  });

  it("the chooser's cursor on the options goes to the partner (D16)", async () => {
    const r = await encounter(MysteryEncounterType.SLUMBERING_SNORLAX);
    await until(r, "asked the option", () => phase(r).coopChoosing());
    const step = requireCoopSession().meStep - 1;
    const sent = (): number[] =>
      r.partner.cosmeticsSeen.flatMap(m => (m.t === "meCursor" && m.step === step ? [m.index] : []));
    await until(r, "sent where the cursor is", () => sent().includes(0));
    (r.ctx.game.scene.ui.getHandler() as MysteryEncounterUiHandler).processInput(Button.RIGHT);
    await until(r, "sent the move", () => sent().includes(1));
  });

  it("the waiting player's cursor follows the chooser's, in the partner's color", async () => {
    const r = await encounter(MysteryEncounterType.SLUMBERING_SNORLAX, "guest");
    await until(r, "asked the option", () => requireCoopSession().meQuestion?.k === "option");
    const handler = r.ctx.game.scene.ui.getHandler() as MysteryEncounterUiHandler;
    // who the player waits for is under the description: the message box is under the options on this screen
    const line = (handler as unknown as { queryTextObject: { text: string } }).queryTextObject;
    await until(r, "said who chooses", () => /is choosing/.test(line.text));
    expect(r.ctx.game.scene.ui.getMessageHandler().message.text).not.toMatch(/is choosing/);
    const cursorObj = (handler as unknown as { cursorObj: Phaser.GameObjects.Image }).cursorObj;
    const tint = vi.spyOn(cursorObj, "setTint");
    const untint = vi.spyOn(cursorObj, "clearTint");
    r.partner.cosmetic({ t: "meCursor", step: requireCoopSession().meStep - 1, index: 1 });
    await until(r, "followed the chooser", () => handler.getCursor() === 1);
    expect(tint).toHaveBeenCalledWith(MARK_COLORS.partner);
    // the player can still look at another option; it is their own cursor again
    handler.processInput(Button.LEFT);
    expect(handler.getCursor()).toBe(0);
    expect(untint).toHaveBeenCalled();
  });

  it("who goes in a one-Pokémon encounter: the host can skip it, and nobody fights", async () => {
    const r = await encounter(MysteryEncounterType.FUN_AND_GAMES, "guest", firstAnswer({ k: "who", seat: null }));
    await advance(r, ["SelectModifierPhase"]);
    expect(r.ctx.game.scene.getEnemyField()).toHaveLength(0);
    expect(requireCoopSession().meStep).toBe(1);
  });

  it("who goes: the one who goes makes the encounter's choices", async () => {
    const r = await encounter(MysteryEncounterType.FUN_AND_GAMES, "guest", firstAnswer({ k: "who", seat: "guest" }));
    await openUi(r.ctx, "MysteryEncounterPhase");
    await until(r, "showed the options", () => requireCoopSession().meQuestion?.k === "option");
    expect(requireCoopSession().meChooser).toBe("guest");
    // the guest's pick counts now
    await pickOption(r, 1);
    await advance(r, ["SelectModifierPhase"]);
  });
});
