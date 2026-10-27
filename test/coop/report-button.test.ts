/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { CoopLog, type CoopLogEnvironment, setCoopLog } from "#coop/coop-log";
import { reportProblem, SEND_TIMEOUT_MS } from "#coop/report-button";
import { afterEach, describe, expect, it, vi } from "vitest";

// The snapshot reads the game; this test has none
vi.mock("#coop/coop-diagnostics", () => ({ gameSnapshot: () => ({ phase: "CommandPhase", wave: 7 }) }));

/** A browser whose server answers with `post`; the log's own timers never go off */
function browser(post: CoopLogEnvironment["post"], store = new Map<string, string>()): CoopLogEnvironment {
  return {
    storage: {
      getItem: key => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
      removeItem: key => void store.delete(key),
    },
    now: () => new Date(Date.parse("2026-10-27T12:00:00Z")),
    post,
    beacon: () => false,
    setTimer: () => 0,
    clearTimer: () => {},
    sessionId: () => "tab1",
    userAgent: "test-browser",
  };
}

describe("Report a problem (D26): what the player is told", () => {
  afterEach(() => {
    setCoopLog(null);
    vi.useRealTimers();
  });

  it("says 'sent' when the server took the report, which has the note and the snapshot", async () => {
    const bodies: string[] = [];
    const log = new CoopLog(
      browser((_url, body) => {
        bodies.push(body);
        return Promise.resolve(204);
      }),
    );
    log.setServer("/coop/log");
    setCoopLog(log);
    expect(await reportProblem("  the menu froze  ", false)).toBe("sent");
    expect(log.all.at(-1)).toMatchObject({
      kind: "report",
      msg: "the menu froze",
      data: { phase: "CommandPhase", wave: 7 },
    });
    expect(bodies).toHaveLength(1);
  });

  it("says 'saved' when this report did not get through, though the log reached the server in an earlier session", async () => {
    const store = new Map([["coopLog", JSON.stringify({ next: 10, sentUpTo: 10, entries: [] })]]);
    const log = new CoopLog(browser(() => Promise.reject(new Error("offline")), store));
    log.setServer("/coop/log");
    setCoopLog(log);
    expect(log.serverCollects).toBe(true);
    expect(await reportProblem(null, false)).toBe("saved");
    expect(log.all.at(-1)).toMatchObject({ kind: "report", msg: "a problem was reported" });
  });

  it("says 'saved' when the server does not answer in time", async () => {
    vi.useFakeTimers();
    const log = new CoopLog(browser(() => new Promise<number>(() => {})));
    log.setServer("/coop/log");
    setCoopLog(log);
    const result = reportProblem("stuck", false);
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    expect(await result).toBe("saved");
  });

  it("says 'saved' when there is no server to send to", async () => {
    const log = new CoopLog(browser(() => Promise.resolve(204)));
    setCoopLog(log);
    expect(await reportProblem("no server", false)).toBe("saved");
  });
});
