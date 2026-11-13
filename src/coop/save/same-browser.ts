/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Two players in one browser (two tabs or windows) share one save (DECISIONS D19): the site has no login, so every tab
 * keeps the account under the same key, and each tab's saves write over the other's progress (candies, the candy meter,
 * catches). A player's report (GitHub issue #2) was this. While a session lasts, its tab says it is here on a channel of
 * this browser; a tab that hears another tells its player, once a session. A private window or another browser has a save
 * of its own, and a channel of its own.
 * @module
 */

/** The channel of this browser's co-op tabs */
const CHANNEL = "pokerogue-coop-tabs";

/** `hello`: a session starts in a tab; `here`: a tab with a session answers it */
type TabMessage = { t: "hello" } | { t: "here" };

/**
 * Listen for another co-op tab of this browser while a session lasts.
 * @param onShared - Called once, when another tab of this browser has a session too
 * @returns Stop listening: the session is over
 */
export function watchSameBrowser(onShared: () => void): () => void {
  if (typeof BroadcastChannel === "undefined") {
    return () => {};
  }
  const channel = new BroadcastChannel(CHANNEL);
  // Node (the tests): an open channel must not keep the process alive
  (channel as { unref?: () => void }).unref?.();
  let told = false;
  channel.onmessage = (event: MessageEvent<TabMessage>) => {
    const kind = event.data?.t;
    if (kind !== "hello" && kind !== "here") {
      return;
    }
    // A tab that comes later hears of this one, even when this player was told already
    if (kind === "hello") {
      channel.postMessage({ t: "here" } satisfies TabMessage);
    }
    if (!told) {
      told = true;
      onShared();
    }
  };
  channel.postMessage({ t: "hello" } satisfies TabMessage);
  return () => channel.close();
}
