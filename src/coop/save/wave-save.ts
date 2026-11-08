/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { challengesOn } from "#coop/link/challenge-pick";
import { makeStorageRoom, notSavedText, reportNotSaved, saveCoopAccount } from "#coop/save/account-save";
import { COOP_SLOT_VERSION, type CoopSlot, clearCoopSlot, readCoopSlot, writeCoopSlot } from "#coop/save/coop-slot";
import type { RewardResume } from "#coop/save/save-block";
import type { KeyValueStore } from "#coop/save/seat-store";
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

/** @returns The slot of the host's save file this run is saved in (D19), or `null` (no session, or nothing saved yet) */
export function currentCoopSlot(): CoopSlot | null {
  const store = coopStore();
  const session = getCoopSession();
  return store === null || session === null ? null : readCoopSlot(store, session.file);
}

/** The run is over, or its saved run is not wanted any more (D19): its save file goes */
export function removeCoopSlot(file: number): void {
  const store = coopStore();
  if (store !== null) {
    clearCoopSlot(store, file);
  }
}

/**
 * Take the wave-start save of the wave that is about to be played (D19). A no-op in solo play.
 */
export function saveCoopWaveStart(resumeAt?: RewardResume): boolean {
  const session = getCoopSession();
  if (session == null) {
    return true;
  }
  const link = session.link;
  // This player's account is saved at every wave start, as a solo run's `saveAll` saves it: what the run gave it (the dex,
  // caught Pokémon as starters, candies, eggs, vouchers) is not lost when the tab closes before the run ends. It also gives
  // a fresh account its ids at the first wave: they are drawn again at every start of the game until saved, and a saved
  // run is found again by them (D4, D21). The run itself is saved below (D19). A browser that refuses it is told about
  // (`account-save.ts`).
  session.accountSaved = true;
  void saveCoopAccount();
  const data = globalScene.gameData.getSessionSaveData();
  if (resumeAt !== undefined && data.coop !== undefined) {
    // A reward-screen save (D19): a reload goes back to the screen
    data.coop.resumeAt = resumeAt;
  }
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
    // (a run of three keeps the third seat's name, even while it is played with two: D40)
    names:
      link.players === 3
        ? link.names
        : {
            host: link.name,
            guest: link.theirName,
            ...(session.accountIds.guest2 === undefined
              ? {}
              : { guest2: currentCoopSlot()?.names.guest2 ?? "Player 3" }),
          },
    accountIds: { ...session.accountIds },
    players: link.players,
    // (a host whose page is reloaded in the middle of the run keeps the run's debug menu, D42)
    debug: session.debug,
    session: json,
    ...(globalScene.gameMode.isChallenge
      ? { runMode: "challenge", challenges: challengesOn() }
      : { runMode: globalScene.gameMode.isEndless ? "endless" : "classic" }),
  };
  // A full storage first makes room (the co-op log gives its copy up), and the file is written again
  if (!writeCoopSlot(store, slot, session.file) && !(makeStorageRoom() && writeCoopSlot(store, slot, session.file))) {
    // The slot of an earlier wave must not stay: "Continue" would silently take the run back to it (D19). Without a slot
    // there is nothing to continue, which is what is true, and the host is told so
    clearCoopSlot(store, session.file);
    console.warn("co-op: the wave-start save did not fit in local storage; the saved run is removed");
    reportNotSaved(
      "run",
      notSavedText("run"),
      "the wave-start save did not fit in local storage: the saved run is removed",
      { wave: data.waveIndex },
    );
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
  const session = getCoopSession();
  if (store === null || session === null) {
    return;
  }
  const slot = readCoopSlot(store, session.file);
  if (slot !== null && (slot.epoch < epoch || slot.seq < seq)) {
    writeCoopSlot(store, { ...slot, epoch: Math.max(slot.epoch, epoch), seq: Math.max(slot.seq, seq) }, session.file);
  }
}
