/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { getPokemonNameWithAffix } from "#app/messages";
import { takeoverCancelLabel } from "#coop/afk";
import { coopText } from "#coop/bridge";
import { showOverlayMenu } from "#coop/overlay";
import { commandTargetPick } from "#coop/sim-rng";
import type { TurnCommandsPayload } from "#coop/turn-commands";
import { allMoves } from "#data/data-lists";
import { Command } from "#enums/command";
import { FieldPosition } from "#enums/field-position";
import { MoveId } from "#enums/move-id";
import { MoveUseMode } from "#enums/move-use-mode";
import type { PlayerPokemon, Pokemon } from "#field/pokemon";
import { getMoveTargets } from "#moves/move-utils";

/**
 * Taking over a Pokémon's command (DECISIONS D17): the waiting player chooses what the partner's Pokémon does with two small
 * menus, the move and then, if the move has a choice of targets, the target. The partner's own command screen belongs to the
 * partner's slot (`CommandPhase` only runs for the player who controls it), so this is the one place a player commands a
 * Pokémon that is not theirs.
 *
 * What comes out is an ordinary `TURN_COMMANDS` payload: a fight command (no Tera, no switch, no Ball or Run).
 *
 * @module
 */

/**
 * Show a menu over the message box.
 * @param onOpen - Called with the function that closes the menu, so the caller can close it if the wait ends first
 * @returns The index chosen, or `null` for "Cancel"
 */
function chooseFrom(title: string, labels: string[], onOpen: (close: () => void) => void): Promise<number | null> {
  const { ui } = globalScene;
  return new Promise(resolve => {
    ui.showText(title, null, undefined, null, false);
    const options = labels.map((label, index) => ({
      label,
      handler: () => {
        resolve(index);
        return true;
      },
    }));
    options.push({
      label: takeoverCancelLabel(),
      handler: () => {
        resolve(null);
        return true;
      },
    });
    onOpen(showOverlayMenu(options, Math.min(options.length, 6)));
  });
}

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The label of a target in the take over menu: its name plus where it stands, so that two enemies of the same species (or
 * an ally and an enemy) can be told apart. Enemies are "Left" or "Right" as they are on screen, the user's side is "ally"
 * (or "self" for the Pokémon that uses the move).
 * @param user - The Pokémon whose command is chosen
 * @param target - A candidate target; `undefined` if the slot is empty (just its name)
 */
export function takeoverTargetLabel(user: Pokemon, target: Pokemon | undefined): string {
  const name = getPokemonNameWithAffix(target);
  if (target === undefined) {
    return name;
  }
  let place: string | null;
  if (target === user) {
    place = coopText("takeOverSelf", "self");
  } else if (target.isPlayer()) {
    place = coopText("takeOverAlly", "ally");
  } else if (target.fieldPosition === FieldPosition.LEFT) {
    place = coopText("takeOverLeft", "Left");
  } else if (target.fieldPosition === FieldPosition.RIGHT) {
    place = coopText("takeOverRight", "Right");
  } else {
    // Alone in the middle: nothing to tell apart
    place = null;
  }
  return place === null ? name : `${name} (${place})`;
}

/**
 * Ask the player what `pokemon`, in field slot `slot`, does this turn.
 * @param isOver - Whether the wait ended meanwhile (the partner's own command came): no further menu opens then
 * @returns The command, or `null` if the player went back or the wait ended
 */
export async function askCommandFor(
  pokemon: PlayerPokemon,
  slot: number,
  onOpen: (close: () => void) => void = () => undefined,
  isOver: () => boolean = () => false,
): Promise<TurnCommandsPayload | null> {
  const name = getPokemonNameWithAffix(pokemon);
  const title = coopText("takeOverCommand", "Take over for {{pokemonName}}: which move?", { pokemonName: name });
  const moveset = pokemon.getMoveset();
  const usable = moveset.map((_, index) => index).filter(index => pokemon.trySelectMove(index, false)[0]);

  for (;;) {
    let cursor: number;
    let moveId: MoveId;
    if (usable.length === 0) {
      // Nothing can be used: the Pokémon struggles. The command names a move slot, as the command phase's does (its
      // cursor is the move the player pressed): the legality check (D24) takes Struggle from a slot, not from none
      moveId = MoveId.STRUGGLE;
      cursor = 0;
    } else {
      const labels = usable.map(index => {
        const move = moveset[index];
        return `${allMoves[move.moveId].name} ${move.getMovePp() - move.ppUsed}/${move.getMovePp()}`;
      });
      const chosen = await chooseFrom(title, labels, onOpen);
      if (chosen === null) {
        return null;
      }
      cursor = usable[chosen];
      moveId = moveset[cursor].moveId;
      await pause(60);
      if (isOver()) {
        return null;
      }
    }

    // a random target (Outrage) is drawn as the command phase draws it, not from the battle's stream (`commandTargetPick`)
    const { targets, multiple } = getMoveTargets(pokemon, moveId, undefined, commandTargetPick(pokemon, moveId));
    let moveTargets = targets;
    if (targets.length > 1 && !multiple) {
      const labels = targets.map(target => takeoverTargetLabel(pokemon, globalScene.getField()[target]));
      const picked = await chooseFrom(
        coopText("takeOverTarget", "{{moveName}}: on which?", { moveName: allMoves[moveId].name }),
        labels,
        onOpen,
      );
      if (picked === null) {
        if (usable.length === 0) {
          return null;
        }
        await pause(60);
        if (isOver()) {
          return null;
        }
        continue;
      }
      moveTargets = [targets[picked]];
    }

    return {
      command: {
        command: Command.FIGHT,
        cursor,
        move: { move: moveId, targets: moveTargets, useMode: MoveUseMode.NORMAL },
      },
      pre: { command: Command.FIGHT, targets: [slot], skip: true },
    };
  }
}
