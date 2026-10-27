/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { settings } from "#app/global-settings-manager";
import { getLocalBuildIdentity, overridesAreDefaults } from "#coop/build-info";
import type { CoopSlot } from "#coop/coop-slot";
import { getCoopName } from "#coop/display-name";
import {
  createRoom,
  establishGuest,
  establishHost,
  HandshakeRefusedError,
  type HostRoom,
  type RejoinedRoom,
  rejoinRoom,
} from "#coop/link";
import {
  beginSession,
  type CoopTitleCallbacks,
  describeCoopError,
  getRelayUrl,
  leaveCoop,
  localAccountId,
  registerContinueHandler,
  returnToTitle,
  showFailure,
  showJoinCode,
} from "#coop/lobby";
import { buildPinnedSettings, createSettingsOverlayPort } from "#coop/pinned-settings";
import { hideReconnectScreen, showReconnectScreen } from "#coop/reconnect-ui";
import { issueResync } from "#coop/resync-run";
import { CoopSaveRefusedError, checkSaveBlock } from "#coop/save-block";
import { forgetSeat, newestSeat } from "#coop/seat-store";
import { getCoopSession } from "#coop/session";
import { coopText } from "#coop/text";
import { RelayError } from "#coop/transport/relay-ws";
import { validateProposal } from "#coop/validate";
import { coopStore, currentCoopSlot, removeCoopSlot } from "#coop/wave-save";
import { UiMode } from "#enums/ui-mode";

/**
 * Rejoin and resume (DECISIONS D20, D21): getting back into a co-op run after a tab was reloaded or closed, or after the
 * players left it.
 * - {@linkcode tryAutoRejoin}: at boot, a client that has a seat token takes its seat in the same room, shakes hands, and gets
 *   the wave start reloaded (the host from its own slot, the guest from the host);
 * - {@linkcode hostContinue}: "Co-op, Continue" of the host: a new room for the run in the co-op slot; the guest joins it with
 *   the code, and it must be the same guest.
 *
 * @module
 */

/** How long a player who opened the game waits for the partner before "End session" is offered */
const BOOT_END_SESSION_AFTER_MS = 10_000;

/** @returns The run seed in a saved session */
function seedOf(slot: CoopSlot): string {
  try {
    const seed = (JSON.parse(slot.session) as { seed?: unknown }).seed;
    return typeof seed === "string" && seed.length > 0 ? seed : "pending";
  } catch {
    return "pending";
  }
}

/** Start the host's session on a link that shook hands, with the run of its slot loaded under the next epoch (D21) */
function resumeFromSlot(
  established: Awaited<ReturnType<typeof establishHost>>,
  slot: CoopSlot,
  overlay: ReturnType<typeof createSettingsOverlayPort>,
  reason: "resume" | "rejoin",
): void {
  const { link } = established;
  const session = beginSession(link, "host", overlay, { runSeed: seedOf(slot), accountIds: slot.accountIds });
  session.waveSave = { wave: slot.wave, epoch: slot.epoch, json: slot.session };
  // the epoch and the seq go on from where the slot left them (D18)
  link.channel.setEpoch(slot.epoch);
  link.sequencer.ensureSeqAtLeast(slot.seq + 1);
  session.timing["handshakeAt"] = Date.now();
  issueResync(session, reason, { wave: slot.wave, json: slot.session });
}

// #region Rejoin at boot (D20)

/**
 * At boot, before the title screen shows its options: take the seat of the last room back, if there is one.
 * @returns Whether the rejoin took over the screen. If `false`, the title screen goes on as usual.
 */
export async function tryAutoRejoin(): Promise<boolean> {
  const store = coopStore();
  if (store === null || getCoopSession() !== null) {
    return false;
  }
  const record = newestSeat(store);
  if (record === null || !overridesAreDefaults()) {
    return false;
  }
  const { ui } = globalScene;
  const startedAt = Date.now();
  let room: RejoinedRoom;
  await ui.setMode(UiMode.MESSAGE);
  ui.showText(
    coopText("rejoining", "Reconnecting to the co-op game {{code}}…", { code: record.code }),
    null,
    undefined,
    null,
    false,
  );
  try {
    room = await rejoinRoom(record.relayUrl, record);
  } catch (error) {
    ui.clearText();
    if (!(error instanceof RelayError) || error.reason !== "closed") {
      // the room is gone or the seat is no longer ours; a relay that did not answer might be back later, so that keeps it
      forgetSeat(store, record.code);
    }
    return false;
  }

  const partner = record.partnerName ?? coopText("yourPartner", "your partner");
  const { seat } = record;
  const slot = seat === "host" ? currentCoopSlot() : null;
  if (seat === "host" && (slot === null || slot.accountIds.host !== localAccountId())) {
    room.relay.leave();
    forgetSeat(store, record.code);
    returnToTitle(coopText("noSavedRun", "There is no saved run of yours to resume."));
    return true;
  }

  /** The player ended the wait (End session): the socket closing next is theirs, not the partner's ending */
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    room.relay.leave();
    forgetSeat(store, record.code);
    returnToTitle(coopText("sessionEnded", "You ended the session."));
  };
  // the partner is away too: wait for them, with the code and the way out
  const waiting = setTimeout(() => {
    // A player who opens the game may have no partner to wait for: the way out comes sooner than in a run (D20)
    showReconnectScreen({
      partner,
      code: record.code,
      back: false,
      onEnd: cancel,
      endAfterMs: BOOT_END_SESSION_AFTER_MS,
    });
  }, 400);
  try {
    await room.paired;
  } catch (error) {
    clearTimeout(waiting);
    hideReconnectScreen();
    if (cancelled) {
      return true;
    }
    if (error instanceof Error && error.message === "room closed") {
      // The relay closed the room: the partner ended it
      forgetSeat(store, record.code);
      returnToTitle(coopText("partnerEnded", "{{partner}} ended the session.", { partner }));
      return true;
    }
    // This client's own connection dropped (or the relay restarted): the seat is kept, a reload tries again (D20)
    room.relay.close();
    returnToTitle(coopText("rejoinConnectionLost", "The connection was lost. Reload the page to try again."));
    return true;
  }
  clearTimeout(waiting);
  hideReconnectScreen();
  ui.showText(coopText("connecting", "Connecting…"), null, undefined, null, false);

  const overlay = createSettingsOverlayPort(settings);
  try {
    if (seat === "host") {
      const pinned = buildPinnedSettings(settings.general.playerGender);
      const effectiveHash = overlay.apply(pinned);
      const established = await establishHost(room, getLocalBuildIdentity(), pinned, {
        expectedEffectiveSettingsHash: effectiveHash,
        sequencer: { validatePayload: validateProposal },
        name: getCoopName(),
        mode: "resume",
        expectedGuestAccountId: slot!.accountIds.guest,
      });
      resumeFromSlot(established, slot!, overlay, "rejoin");
      getCoopSession()!.timing["rejoinStartedAt"] = startedAt;
    } else {
      const established = await establishGuest(room, getLocalBuildIdentity(), overlay, {
        name: getCoopName(),
        accountId: localAccountId(),
      });
      const session = beginSession(established.link, "guest", overlay);
      session.timing["rejoinStartedAt"] = startedAt;
      session.timing["handshakeAt"] = Date.now();
      session.awaitingReload = true;
      // the host sends the wave start; `installResync` applies it as soon as it arrives
      ui.showText(
        coopText("waitingForResume", "Waiting for {{partner}}…", { partner: established.link.partnerName }),
        null,
        undefined,
        null,
        false,
      );
    }
  } catch (error) {
    overlay.remove();
    room.cancel();
    if (error instanceof HandshakeRefusedError) {
      forgetSeat(store, record.code);
    }
    returnToTitle(describeCoopError(error));
  }
  return true;
}

// #endregion

// #region Continue (D21)

/**
 * "Co-op, Continue": a new room for the run in the co-op slot. The guest joins with the code; the handshake refuses any guest
 * but the one the run was saved with, and then both load the wave start (D21).
 */
/** @returns Why the saved run cannot be loaded by this build, or `null` if it can */
function slotRefusal(slot: CoopSlot): string | null {
  try {
    const data = globalScene.gameData.parseSessionData(slot.session);
    checkSaveBlock(data.coop, { accountIds: slot.accountIds });
    return null;
  } catch (error) {
    return error instanceof CoopSaveRefusedError
      ? error.message
      : coopText("slotDamaged", "The save is damaged or from another version.");
  }
}

/** The saved run cannot be loaded: say why, and offer to delete it so that "Continue" is not a dead end */
function offerToDelete(reason: string, callbacks: CoopTitleCallbacks): void {
  const { ui } = globalScene;
  void ui.setMode(UiMode.MESSAGE).then(() =>
    ui.showText(
      coopText("slotUnusable", "This saved co-op run can't be continued: {{reason}} Delete it?", { reason }),
      null,
      () =>
        ui.setModeWithoutClear(UiMode.CONFIRM, {
          yesHandler: () => {
            removeCoopSlot();
            callbacks.onCancel();
          },
          noHandler: () => callbacks.onCancel(),
        }),
    ),
  );
}

export async function hostContinue(callbacks: CoopTitleCallbacks): Promise<void> {
  const { ui } = globalScene;
  const slot = currentCoopSlot();
  if (slot === null) {
    showFailure(new Error("no co-op slot"), callbacks);
    return;
  }
  if (!overridesAreDefaults()) {
    showFailure(new Error("overrides in effect"), callbacks);
    return;
  }
  if (slot.accountIds.host !== localAccountId()) {
    showFailure(
      new Error("another account"),
      callbacks,
      coopText("otherHost", "This co-op run was saved with another account."),
    );
    return;
  }
  const unusable = slotRefusal(slot);
  if (unusable !== null) {
    // A run this build cannot load (another version, a damaged save) would leave both players stuck after the partner
    // joins: the host is told, and may delete it (D21)
    offerToDelete(unusable, callbacks);
    return;
  }
  let room: HostRoom | null = null;
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    room?.cancel();
    leaveCoop();
    callbacks.onCancel();
  };

  ui.setMode(UiMode.MESSAGE);
  ui.showText(coopText("gettingJoinCode", "Getting a join code…"));
  try {
    room = await createRoom(getRelayUrl());
    if (cancelled) {
      return;
    }
    showJoinCode(room.identity.code, cancel);
    await room.partner;
    if (cancelled) {
      return;
    }
    ui.setMode(UiMode.MESSAGE);
    ui.showText(coopText("connecting", "Connecting…"));
    const overlay = createSettingsOverlayPort(settings);
    const pinned = buildPinnedSettings(settings.general.playerGender);
    const effectiveHash = overlay.apply(pinned);
    let established: Awaited<ReturnType<typeof establishHost>>;
    try {
      established = await establishHost(room, getLocalBuildIdentity(), pinned, {
        expectedEffectiveSettingsHash: effectiveHash,
        sequencer: { validatePayload: validateProposal },
        name: getCoopName(),
        mode: "resume",
        expectedGuestAccountId: slot.accountIds.guest,
      });
    } catch (error) {
      overlay.remove();
      throw error;
    }
    if (cancelled) {
      overlay.remove();
      established.link.close();
      return;
    }
    resumeFromSlot(established, slot, overlay, "resume");
  } catch (error) {
    if (!cancelled) {
      room?.cancel();
      showFailure(error, callbacks);
    }
  }
}

registerContinueHandler(hostContinue);

// #endregion
