/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { TimedEventManager } from "#app/timed-event-manager";
import { timedEvents } from "#balance/timed-events";
import { endCoopSession, startCoopSession } from "#coop/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Timed events in co-op (DECISIONS D33): solo play goes by the clock; a co-op run has the events the host chose when it
 * started, whatever either clock says later.
 */

const BUILD = { protocolVersion: 1, gitSha: "x", dirtyHash: "clean", buildMode: "test", overridesHash: "0" } as const;
const HALLOWEEN = "Halloween 26";

describe("Co-op: timed events (DECISIONS D33)", () => {
  // The test setup turns the global manager off; this one is on
  let events: TimedEventManager;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    events = new TimedEventManager();
  });

  afterEach(() => {
    endCoopSession();
    vi.useRealTimers();
  });

  it("goes by the clock in solo play", () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 27)));
    expect(timedEvents.some(event => event.name === HALLOWEEN)).toBe(true);
    expect(events.eventsByClock()).toContain(HALLOWEEN);
    expect(events.activeEvent()?.name).toBe(HALLOWEEN);
    expect(events.getShinyEncounterMultiplier()).toBe(2);

    vi.setSystemTime(new Date(Date.UTC(2026, 10, 20)));
    expect(events.eventsByClock()).not.toContain(HALLOWEEN);
    expect(events.activeEvent()?.name).not.toBe(HALLOWEEN);
  });

  it("has the run's events in co-op, not the clock's", () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 27)));
    const session = startCoopSession({ seat: "guest", runSeed: "seed", build: BUILD });
    // Before `START`, in the lobby: none
    expect(events.activeEvent()).toBeUndefined();
    expect(events.getShinyEncounterMultiplier()).toBe(1);
    // What a player brings to the run is still the clock's
    expect(events.eventsByClock()).toContain(HALLOWEEN);

    session.setTimedEvents([HALLOWEEN]);
    expect(events.activeEvent()?.name).toBe(HALLOWEEN);
    expect(events.getShinyEncounterMultiplier()).toBe(2);
    expect(events.getFixedBattleEventRewards(8)).toContain("SHINY_CHARM");

    // A run started during the event keeps it after the event's end
    vi.setSystemTime(new Date(Date.UTC(2027, 0, 20)));
    expect(events.activeEvent()?.name).toBe(HALLOWEEN);

    // A run started when the two clocks agreed on nothing has no event, whatever the clock says
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 27)));
    session.setTimedEvents([]);
    expect(events.activeEvent()).toBeUndefined();
    expect(events.isEventActive()).toBe(false);
  });

  it("has none while turned off (the tests' own manager)", () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 27)));
    events.disable();
    expect(events.eventsByClock()).toEqual([]);
    startCoopSession({ seat: "host", runSeed: "seed", build: BUILD }).setTimedEvents([HALLOWEEN]);
    expect(events.activeEvent()).toBeUndefined();
  });
});
