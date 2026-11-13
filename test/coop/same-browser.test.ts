/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { watchSameBrowser } from "#coop/save/same-browser";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Two co-op tabs of one browser share one save (D19, a player's report: GitHub issue #2). Each tab's session listens on the
 * browser's channel; a tab that hears another tells its player, once a session. Here each watch stands for a tab.
 */
describe("Co-op tabs of one browser", () => {
  const stops: (() => void)[] = [];

  afterEach(() => {
    for (const stop of stops.splice(0)) {
      stop();
    }
  });

  /** Let the channel deliver what was posted */
  const settle = () => new Promise(resolve => setTimeout(resolve, 50));

  it("tells both players, whichever tab came first, and each only once", async () => {
    const first = vi.fn();
    stops.push(watchSameBrowser(first));
    await settle();
    expect(first).not.toHaveBeenCalled();

    const second = vi.fn();
    stops.push(watchSameBrowser(second));
    await vi.waitFor(() => {
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    });

    // A third tab hears of the others; the two are not told again
    const third = vi.fn();
    stops.push(watchSameBrowser(third));
    await vi.waitFor(() => expect(third).toHaveBeenCalledTimes(1));
    await settle();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("a tab whose session ended neither hears nor is heard", async () => {
    const ended = vi.fn();
    const stop = watchSameBrowser(ended);
    stop();
    const later = vi.fn();
    stops.push(watchSameBrowser(later));
    await settle();
    expect(ended).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
  });

  it("a session alone in its browser is told nothing", async () => {
    const alone = vi.fn();
    stops.push(watchSameBrowser(alone));
    await settle();
    expect(alone).not.toHaveBeenCalled();
  });
});
