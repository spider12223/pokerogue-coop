/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import type { PartyEdit } from "#coop/party-edit";
import { getCoopSession } from "#coop/session";
import { SpeciesFormChangeItemTrigger } from "#data/form-change-triggers";
import { UiMode } from "#enums/ui-mode";
import type { PlayerPokemon } from "#field/pokemon";
import type { PokemonFormChangeItemModifier } from "#modifiers/modifier";
import type { UiHandler } from "#ui/ui-handler";

/**
 * The game's side of party edits (DECISIONS D28): which of them the party screen offers in a linked run, how an edit is
 * proposed (through the reward screen that is open) and how both clients carry it out.
 *
 * @module
 */

/** The part of `SelectModifierPhase` that takes an edit */
interface EditableRewardScreen {
  proposePartyEdit(edit: PartyEdit): void;
}

/** @returns The reward screen that is open, if the party screen was opened from one in a linked run */
function rewardScreen(): EditableRewardScreen | null {
  if (getCoopSession()?.link == null) {
    return null;
  }
  const phase = globalScene.phaseManager.getCurrentPhase();
  return phase.is("SelectModifierPhase") ? (phase as unknown as EditableRewardScreen) : null;
}

/**
 * Whether this player may change `pokemon` from the party screen now: a linked run, the reward screen, and their own
 * Pokémon. Outside co-op the party screen decides by itself, as in solo play.
 */
export function canEditInCoop(pokemon: PlayerPokemon): boolean {
  const session = getCoopSession();
  return rewardScreen() !== null && session !== null && session.ownership.get(pokemon.id) === session.seat;
}

/** How many Pokémon this player owns */
export function ownCount(): number {
  const session = getCoopSession();
  if (session === null) {
    return globalScene.getPlayerParty().length;
  }
  return globalScene.getPlayerParty().filter(pokemon => session.ownership.get(pokemon.id) === session.seat).length;
}

/**
 * Propose an edit of this player's own Pokémon. Both clients carry it out when it comes back sequenced, and the party screen
 * shows it then.
 * @returns Whether it was proposed (a linked run with the reward screen open)
 */
export function proposePartyEdit(edit: PartyEdit): boolean {
  const screen = rewardScreen();
  if (screen === null) {
    return false;
  }
  screen.proposePartyEdit(edit);
  return true;
}

/** Carry out a sequenced edit (it was checked already, D24): the same on both clients */
export async function applyPartyEdit(edit: PartyEdit): Promise<void> {
  const party = globalScene.getPlayerParty();
  const byId = (id: number): PlayerPokemon | undefined => party.find(pokemon => pokemon.id === id);
  switch (edit.k) {
    case "swap": {
      const [a, b] = [
        party.findIndex(pokemon => pokemon.id === edit.a),
        party.findIndex(pokemon => pokemon.id === edit.b),
      ];
      if (a >= 0 && b >= 0) {
        [party[a], party[b]] = [party[b], party[a]];
      }
      break;
    }
    case "release": {
      const index = party.findIndex(pokemon => pokemon.id === edit.pokemonId);
      if (index >= 0) {
        await globalScene.removePartyMemberModifiers(index);
        party.splice(index, 1)[0].destroy();
        getCoopSession()?.ownership.retain(party.map(pokemon => pokemon.id));
      }
      break;
    }
    case "rename": {
      const pokemon = byId(edit.pokemonId);
      if (pokemon) {
        pokemon.nickname = edit.nickname;
        pokemon.updateInfo();
      }
      break;
    }
    case "evolution": {
      const pokemon = byId(edit.pokemonId);
      if (pokemon) {
        pokemon.pauseEvolutions = edit.paused;
      }
      break;
    }
    case "formItem": {
      const pokemon = byId(edit.pokemonId);
      const modifier = globalScene.findModifier(
        m =>
          m.is("PokemonFormChangeItemModifier")
          && m.pokemonId === edit.pokemonId
          && (m as PokemonFormChangeItemModifier).formChangeItem === edit.item,
      ) as PokemonFormChangeItemModifier | undefined;
      if (pokemon && modifier) {
        modifier.active = edit.active;
        globalScene.triggerPokemonFormChange(pokemon, SpeciesFormChangeItemTrigger, false, true);
      }
      break;
    }
    case "unsplice": {
      await byId(edit.pokemonId)?.unfuse();
      break;
    }
  }
  refreshPartyScreen();
}

/**
 * The party screen, if it is open on either client, shows the party as it is now; under another screen (the summary, a
 * rename, a confirm), it does once it is back on top
 */
function refreshPartyScreen(): void {
  // The party screen's type is not imported: it imports this module
  const party = globalScene.ui.handlers[UiMode.PARTY] as
    | (UiHandler & { coopRefresh(): void; markCoopStale(): void })
    | undefined;
  if (globalScene.ui.mode === UiMode.PARTY) {
    party?.coopRefresh();
  } else {
    party?.markCoopStale();
  }
}
