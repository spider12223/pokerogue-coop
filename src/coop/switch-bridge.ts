/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { coopDecide } from "#coop/bridge";
import { coopSwitchFilter, deciderOf, isAllowedSwitch, type SwitchReason } from "#coop/control";
import { faintSwitchKey, pivotSwitchKey } from "#coop/decision-keys";
import { DesyncError } from "#coop/sequencer";
import type { PartyUiMode } from "#enums/party-ui-mode";
import { UiMode } from "#enums/ui-mode";
import { PartyOption, PartyUiHandler } from "#ui/party-ui-handler";

/**
 * Who replaces a Pokémon that leaves its slot, as a sequenced decision (DECISIONS D7): the replacement after a faint
 * and after a pivot (U-turn, Eject Button, ...).
 *
 * @module
 */

/** The replacement: a party index, or `null` if nobody comes in (a switch that was declined or is impossible). */
export interface SwitchPayload {
  partyIndex: number | null;
  /** The switch passes the baton */
  baton: boolean;
}

export function isSwitchPayload(value: unknown): value is SwitchPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  return (
    (payload["partyIndex"] === null || Number.isInteger(payload["partyIndex"])) && typeof payload["baton"] === "boolean"
  );
}

/**
 * Decide who goes into the slot `fieldIndex`, whose Pokémon left it.
 * - faint: the owner of the fainted Pokémon picks from their bench, else the partner from theirs
 * - voluntary (a pivot): the controller of the slot picks from their own bench
 *
 * The decider sees the party screen; the other client waits. Both return the same payload, already checked against
 * the rules, so nobody can be sent into a slot they may not take.
 *
 * @param leavingId - The `pokemon.id` of the Pokémon that left the slot: the key's ref
 * @param partyMode - The party screen to show the decider
 */
export async function coopDecideSwitch(options: {
  fieldIndex: number;
  reason: SwitchReason;
  leavingId: number;
  partyMode: PartyUiMode;
}): Promise<SwitchPayload> {
  const { fieldIndex, reason, leavingId, partyMode } = options;
  const { waveIndex: wave, turn } = globalScene.currentBattle;
  const faint = reason === "faint";
  const key = faint ? faintSwitchKey(wave, turn, leavingId) : pivotSwitchKey(wave, turn, leavingId);
  const decider = faint
    ? deciderOf({ kind: "FAINT_SWITCH", fieldIndex })
    : deciderOf({ kind: "PIVOT_SWITCH", fieldIndex });
  if (decider === null || decider === "either") {
    throw new DesyncError("a switch with nobody to decide it was opened", { actual: key });
  }

  const decision = await coopDecide<SwitchPayload>({
    key,
    decider,
    ask: () =>
      new Promise<SwitchPayload>(resolve => {
        globalScene.ui.setMode(
          UiMode.PARTY,
          partyMode,
          fieldIndex,
          (slotIndex: number, option: PartyOption) => {
            const valid =
              slotIndex >= globalScene.currentBattle.getBattlerCount()
              && slotIndex < 6
              && isAllowedSwitch(fieldIndex, slotIndex, reason);
            resolve({ partyIndex: valid ? slotIndex : null, baton: option === PartyOption.PASS_BATON });
          },
          coopSwitchFilter(fieldIndex, reason, PartyUiHandler.FilterNonFainted),
        );
      }),
    isPayload: isSwitchPayload,
  });

  const { partyIndex } = decision.payload;
  if (partyIndex !== null && !isAllowedSwitch(fieldIndex, partyIndex, reason)) {
    // The decider's client checked this too: a payload that fails here came from a client that disagrees about the party
    throw new DesyncError("a sequenced switch sends a Pokémon this client may not send into the slot", {
      actual: decision.key,
      seq: decision.seq,
    });
  }
  return decision.payload;
}
