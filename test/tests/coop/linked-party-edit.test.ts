/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ownerOf } from "#coop/control";
import { type PartyEdit, partyEditKey } from "#coop/party-edit";
import { requireCoopSession } from "#coop/session";
import { modifierTypes } from "#data/data-lists";
import { Button } from "#enums/buttons";
import { PartyUiMode } from "#enums/party-ui-mode";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { PlayerPokemon } from "#field/pokemon";
import { ModifierTypeOption } from "#modifiers/modifier-type";
import { type LinkedRun, openLinkedRun, openRewardScreen, openScreen, untilStep } from "#test/helpers/coop-linked";
import { PartyOption, type PartyUiHandler } from "#ui/party-ui-handler";
import { getModifierType } from "#utils/modifier-utils";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Party edits on the reward screen (DECISIONS D28): each player reorders, releases, renames … their own Pokémon, as a
 * sequenced decision of the reward window; both clients carry it out. One real client (the host), a scripted guest.
 */

const SIX = [
  SpeciesId.BULBASAUR,
  SpeciesId.SQUIRTLE,
  SpeciesId.CHARMANDER,
  SpeciesId.PIKACHU,
  SpeciesId.MACHOP,
  SpeciesId.GEODUDE,
];

describe("Co-op: party edits on the reward screen (D28)", () => {
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

  /** A linked run with a reward screen open and nothing decided on it */
  async function atRewards(seat: "host" | "guest" = "host"): Promise<LinkedRun> {
    run = await openLinkedRun(phaserGame, {
      seat,
      species: SIX,
      starterOwners: ["host", "guest", "host", "guest", "host", "guest"],
      configure: game => game.override.startingLevel(40),
      policy: { auto: ["TURN_COMMANDS", "LEARN_MOVE", "EVOLUTION_CANCEL"] },
    });
    await openRewardScreen(run, [new ModifierTypeOption(getModifierType(modifierTypes.RARE_CANDY), 0)]);
    return run;
  }

  const party = (r: LinkedRun): PlayerPokemon[] => r.ctx.game.scene.getPlayerParty();
  const ids = (r: LinkedRun): number[] => party(r).map(pokemon => pokemon.id);
  const own = (r: LinkedRun, seat: "host" | "guest"): PlayerPokemon[] => party(r).filter(p => ownerOf(p) === seat);

  /** The guest makes an edit in the open step */
  function partnerEdits(r: LinkedRun, edit: PartyEdit): void {
    const { screen, step } = openScreen();
    r.partner.propose(partyEditKey(r.ctx.game.scene.currentBattle.waveIndex, screen, step), edit);
  }

  it("carries out the partner's edits of its own Pokémon: a swap, a rename, a pause, a release", async () => {
    const r = await atRewards();
    const [first, second, third] = own(r, "guest");
    const before = ids(r);

    partnerEdits(r, { k: "swap", a: first.id, b: third.id });
    await untilStep(1);
    expect(ids(r).indexOf(third.id)).toBe(before.indexOf(first.id));
    expect(ids(r).indexOf(first.id)).toBe(before.indexOf(third.id));

    partnerEdits(r, { k: "rename", pokemonId: second.id, nickname: btoa("Shelly") });
    await untilStep(2);
    expect(second.nickname).toBe(btoa("Shelly"));

    partnerEdits(r, { k: "evolution", pokemonId: second.id, paused: true });
    await untilStep(3);
    expect(second.pauseEvolutions).toBe(true);

    partnerEdits(r, { k: "release", pokemonId: first.id });
    await untilStep(4);
    expect(ids(r)).not.toContain(first.id);
    expect(requireCoopSession().ownership.get(first.id)).toBeUndefined();
    expect(party(r)).toHaveLength(5);
    // the screen is still open: the picker has not picked
    expect(r.ctx.game.scene.phaseManager.getCurrentPhase().is("SelectModifierPhase")).toBe(true);
  });

  it("refuses an edit of the other player's Pokémon, and the release of a player's last one", async () => {
    const r = await atRewards();
    const rejected: string[] = [];
    r.partner.sequencer.onProposalRejected(({ key, reason }) => rejected.push(`${key.kind}:${reason}`));

    partnerEdits(r, { k: "release", pokemonId: own(r, "host")[0].id });
    await vi.waitUntil(() => rejected.length === 1, { interval: 5, timeout: 4000 });
    expect(rejected).toEqual(["PARTY_EDIT:invalid"]);
    expect(party(r)).toHaveLength(6);
    expect(r.session.rewardStep).toBe(0);
  });

  it("sends the real client's own edit through the reward screen; it comes back and is carried out", async () => {
    const r = await atRewards();
    const [first, , third] = own(r, "host");
    const before = ids(r);
    const screen = r.ctx.game.scene.phaseManager.getCurrentPhase() as unknown as {
      proposePartyEdit(edit: PartyEdit): void;
    };
    screen.proposePartyEdit({ k: "swap", a: first.id, b: third.id });
    await untilStep(1);
    expect(ids(r).indexOf(first.id)).toBe(before.indexOf(third.id));
  });

  it("proposes the guest's edit again in the next step when the host's decision took the step first", async () => {
    // The real client is the guest here: its proposal travels, the scripted host's is sequenced at once
    const r = await atRewards("guest");
    const mine = own(r, "guest")[1];
    const screen = r.ctx.game.scene.phaseManager.getCurrentPhase() as unknown as {
      proposePartyEdit(edit: PartyEdit): void;
    };
    screen.proposePartyEdit({ k: "rename", pokemonId: mine.id, nickname: btoa("Second") });
    partnerEdits(r, { k: "rename", pokemonId: own(r, "host")[0].id, nickname: btoa("First") });
    await untilStep(2);
    expect(own(r, "host")[0].nickname).toBe(btoa("First"));
    expect(mine.nickname).toBe(btoa("Second"));
  });

  it("offers reorder, release and rename for the player's own Pokémon only", async () => {
    const r = await atRewards();
    const { ui } = r.ctx.game.scene;
    await ui.setMode(UiMode.PARTY, PartyUiMode.CHECK, -1, () => {});
    const handler = ui.getHandler() as PartyUiHandler;
    const shown = (): PartyOption[] => (handler as unknown as { options: PartyOption[] }).options;
    // (a loaded machine may take a moment before the screen takes the press: wait for the menu)
    const optionsAt = async (cursor: number): Promise<PartyOption[]> => {
      handler.setCursor(cursor);
      await vi.waitUntil(
        () => {
          if (shown().length === 0) {
            handler.processInput(Button.ACTION);
          }
          return shown().length > 0;
        },
        { interval: 20, timeout: 4000 },
      );
      const options = [...shown()];
      handler.processInput(Button.CANCEL);
      return options;
    };
    const mine = await optionsAt(ids(r).indexOf(own(r, "host")[2].id));
    expect(mine).toEqual(expect.arrayContaining([PartyOption.SWITCH, PartyOption.RELEASE, PartyOption.RENAME]));
    const theirs = await optionsAt(ids(r).indexOf(own(r, "guest")[2].id));
    expect(theirs).not.toContain(PartyOption.SWITCH);
    expect(theirs).not.toContain(PartyOption.RELEASE);
    expect(theirs).not.toContain(PartyOption.RENAME);
    expect(theirs).toContain(PartyOption.SUMMARY);
  });
});
