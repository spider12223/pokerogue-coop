/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Concept (both players pick on the starter select, the partner's picks show live and the points are shared) from
 * SunghoLee98/pokerogue `src/coop/coop-starter-selection.ts` (AGPL-3.0-only).
 */

import type { AccountSnapshot } from "#coop/account-snapshot";
import type { CoopLink } from "#coop/link";
import {
  type CoopStarter,
  type LobbyMessage,
  type Seat,
  STARTERS_PER_SEAT_MAX,
  type StartPayload,
} from "#coop/protocol";
import type { Unsubscribe } from "#coop/transport/transport";

/**
 * The co-op starter select, as a state machine without UI (DECISIONS D3, D4, D7). Both players pick at once:
 * - they share one point budget and each picks up to {@linkcode STARTERS_PER_SEAT_MAX}
 * - a player's picks are sent as they change, so the partner sees them (faded) and the points are taken at once
 * - each presses ready with their final starters, their account and the timed events their clock has on; the host then
 *   sends `START` with the events both have on (D33)
 *
 * No game imports. What a party costs depends on the account it is picked from (candy reductions), so each player reports
 * the cost of their own party and nobody recomputes the other's.
 *
 * @module
 */

export interface PartnerState {
  picks: CoopStarter[];
  /** What the partner's party takes of the shared budget (ready or not) */
  cost: number;
  ready: boolean;
}

export interface StarterLobbyOptions {
  seat: Seat;
  link: Pick<CoopLink, "sendLobby" | "onLobby" | "sendStart" | "onStart" | "onEnd">;
  /** The points both players share */
  sharedLimit: number;
  /** Host: the seed of the run, drawn when the run starts */
  makeRunSeed(): string;
  /** The names of the timed events this client's clock has on (D33) */
  localEvents(): string[];
}

interface Confirmed {
  starters: CoopStarter[];
  /** What the party costs, as its owner reported it */
  cost: number;
  snapshot: AccountSnapshot;
  /** The timed events its owner's clock had on */
  events: string[];
}

export class StarterLobby {
  readonly seat: Seat;
  readonly partner: PartnerState = { picks: [], cost: 0, ready: false };

  private readonly options: StarterLobbyOptions;
  private readonly unsubscribes: Unsubscribe[] = [];
  private readonly changeListeners = new Set<() => void>();
  private readonly startListeners = new Set<(start: StartPayload) => void>();

  private ready: Confirmed | null = null;
  private partnerReady: Confirmed | null = null;
  private start: StartPayload | null = null;
  private ended = false;
  /** Both were ready with too many points together, and the host took both readies back: until this player picks again */
  private resetNotice = false;

  constructor(options: StarterLobbyOptions) {
    this.options = options;
    this.seat = options.seat;
    this.unsubscribes.push(
      options.link.onLobby(message => this.receive(message)),
      options.link.onStart(start => this.started(start)),
      options.link.onEnd(() => {
        this.ended = true;
        this.changed();
      }),
    );
  }

  /** Whether the local player confirmed their party */
  get localReady(): boolean {
    return this.ready !== null;
  }

  /** The partner left (or the room closed) */
  get closed(): boolean {
    return this.ended;
  }

  /** Set once the run starts: on both clients */
  get startInfo(): StartPayload | null {
    return this.start;
  }

  /** What the local player may spend: what the partner's party left of the shared budget */
  get valueLimit(): number {
    return this.options.sharedLimit - this.partner.cost;
  }

  get sharedLimit(): number {
    return this.options.sharedLimit;
  }

  /** Both players were ready at once with more points together than the budget, so neither is ready any more */
  get wasReset(): boolean {
    return this.resetNotice;
  }

  onChange(listener: () => void): Unsubscribe {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  onStart(listener: (start: StartPayload) => void): Unsubscribe {
    this.startListeners.add(listener);
    return () => {
      this.startListeners.delete(listener);
    };
  }

  /**
   * The party changed: tell the partner, who shows it faded and has the points taken. Ignored while ready.
   * @param cost - What it costs
   */
  setPicks(picks: readonly CoopStarter[], cost: number): void {
    if (this.ready !== null || this.start !== null || this.ended) {
      return;
    }
    this.resetNotice = false;
    this.options.link.sendLobby({ t: "picks", picks: [...picks], cost });
  }

  /**
   * Confirm the party.
   * @returns Whether it was accepted: at least one and at most three starters, and within the points the partner left
   */
  setReady(starters: readonly CoopStarter[], cost: number, snapshot: AccountSnapshot): boolean {
    if (this.start !== null || this.ended) {
      return false;
    }
    if (starters.length === 0 || starters.length > STARTERS_PER_SEAT_MAX || cost > this.valueLimit) {
      return false;
    }
    const events = this.options.localEvents();
    this.ready = { starters: [...starters], cost, snapshot, events };
    this.resetNotice = false;
    this.options.link.sendLobby({ t: "ready", starters: [...starters], cost, snapshot, events });
    this.tryStart();
    this.changed();
    return true;
  }

  /** Take the confirmation back, to change the party */
  cancelReady(): void {
    if (this.ready === null || this.start !== null) {
      return;
    }
    this.ready = null;
    this.options.link.sendLobby({ t: "unready" });
    this.changed();
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe();
    }
    this.changeListeners.clear();
    this.startListeners.clear();
  }

  private receive(message: LobbyMessage): void {
    if (this.start !== null) {
      return;
    }
    switch (message.t) {
      case "picks":
        if (!this.partner.ready) {
          this.partner.picks = message.picks;
          this.partner.cost = message.cost;
        }
        break;
      case "ready":
        this.partner.picks = message.starters;
        this.partner.cost = message.cost;
        this.partner.ready = true;
        this.partnerReady = {
          starters: message.starters,
          cost: message.cost,
          snapshot: message.snapshot,
          events: message.events,
        };
        this.tryStart();
        break;
      case "unready":
        this.partner.ready = false;
        this.partnerReady = null;
        break;
      case "reset":
        // Both were confirmed but too expensive together
        this.ready = null;
        this.partner.ready = false;
        this.partnerReady = null;
        this.resetNotice = true;
        break;
      case "collection":
        // The partner's Pokémon: `CollectionExchange` takes them
        return;
    }
    this.changed();
  }

  /** Host: both confirmed, so start. A guest waits for `START`. */
  private tryStart(): void {
    if (this.seat !== "host" || this.ready === null || this.partnerReady === null || this.start !== null) {
      return;
    }
    const starters = { host: this.ready.starters, guest: this.partnerReady.starters };
    if (this.ready.cost + this.partnerReady.cost > this.options.sharedLimit) {
      // Both players added points at the same time: nobody is ready, they choose again
      this.ready = null;
      this.partner.ready = false;
      this.partnerReady = null;
      this.resetNotice = true;
      this.options.link.sendLobby({ t: "reset" });
      return;
    }
    // The run's events are those both clocks have on now: the two players may be on either side of an event's start or
    // end, and a client whose clock has the event off has not loaded its pictures
    const guestEvents = this.partnerReady.events;
    const start: StartPayload = {
      runSeed: this.options.makeRunSeed(),
      starters,
      snapshots: { host: this.ready.snapshot, guest: this.partnerReady.snapshot },
      timedEvents: this.options.localEvents().filter(name => guestEvents.includes(name)),
    };
    this.options.link.sendStart(start);
    this.started(start);
  }

  private started(start: StartPayload): void {
    if (this.start !== null) {
      return;
    }
    this.start = start;
    for (const listener of [...this.startListeners]) {
      listener(start);
    }
    this.changed();
  }

  private changed(): void {
    for (const listener of [...this.changeListeners]) {
      listener();
    }
  }
}
