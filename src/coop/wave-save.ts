/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { coopLog } from "#coop/coop-log";
import { COOP_SLOT_VERSION, type CoopSlot, clearCoopSlot, readCoopSlot, writeCoopSlot } from "#coop/coop-slot";
import type { KeyValueStore } from "#coop/seat-store";
import { getCoopSession } from "#coop/session";

/**
 * The wave-start save of a linked run (DECISIONS D19): taken in `EncounterPhase`, where a solo run calls `saveAll`. The host
 * keeps it in its co-op slot and in memory, the guest in memory only. It is what a resync, a rejoin and a resume reload (D13).
 *
 * @module
 */

/** @returns The local storage, or `null` where there is none (a private window that refuses it) */
export function coopStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** @returns The host's co-op slot, or `null` */
export function currentCoopSlot(): CoopSlot | null {
  const store = coopStore();
  return store === null ? null : readCoopSlot(store);
}

/** The run is over, or the slot is not wanted any more (D19) */
export function removeCoopSlot(): void {
  const store = coopStore();
  if (store !== null) {
    clearCoopSlot(store);
  }
}

/**
 * Take the wave-start save of the wave that is about to be played (D19). A no-op in solo play.
 */
export function saveCoopWaveStart(): boolean {
  const session = getCoopSession();
  if (session == null) {
    return true;
  }
  const link = session.link;
  // This player's account is saved at every wave start, as a solo run's `saveAll` saves it: what the run gave it (the dex,
  // caught Pokémon as starters, candies, eggs, vouchers) is not lost when the tab closes before the run ends. It also gives
  // a fresh account its ids at the first wave: they are drawn again at every start of the game until saved, and a saved
  // run is found again by them (D4, D21). The run itself is saved below (D19).
  session.accountSaved = true;
  void globalScene.gameData
    .saveSystem()
    .catch((error: unknown) => console.warn("co-op: saving the account failed:", error));
  const data = globalScene.gameData.getSessionSaveData();
  const json = JSON.stringify(data);
  session.waveSave = { wave: data.waveIndex, epoch: link?.epoch ?? 0, json };
  // Only the host's run with a network has a slot; the guest, and a session without a network (the rules harness), keep the
  // save in memory
  if (link == null || !session.isHost) {
    return true;
  }
  const store = coopStore();
  if (store === null) {
    return true;
  }
  const slot: CoopSlot = {
    version: COOP_SLOT_VERSION,
    savedAt: Date.now(),
    wave: data.waveIndex,
    epoch: link.epoch,
    seq: link.sequencer.nextExpected - 1,
    names: { host: link.name, guest: link.theirName },
    accountIds: { ...session.accountIds },
    session: json,
  };
  if (!writeCoopSlot(store, slot)) {
    // The slot of an earlier wave must not stay: "Continue" would silently take the run back to it (D19). Without a slot
    // there is nothing to continue, which is what is true
    clearCoopSlot(store);
    console.warn("co-op: the wave-start save did not fit in local storage; the saved run is removed");
    coopLog().error("save", "the wave-start save did not fit in local storage: the saved run is removed", {
      wave: data.waveIndex,
    });
  }
  // A full storage does not stop the run: the save in memory still serves a resync
  return true;
}

/**
 * The epoch (and the `seq`) moved on after a reload (D18): the slot keeps them, so a host that is reloaded later starts after
 * them. The save in it stays the same.
 */
export function updateSlotEpoch(epoch: number, seq: number): void {
  const store = coopStore();
  if (store === null) {
    return;
  }
  const slot = readCoopSlot(store);
  if (slot !== null && (slot.epoch < epoch || slot.seq < seq)) {
    writeCoopSlot(store, { ...slot, epoch: Math.max(slot.epoch, epoch), seq: Math.max(slot.seq, seq) });
  }
}
