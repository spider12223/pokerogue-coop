/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Concept (both players pick on the starter select, the partner's picks show live and the points are shared) from
 * SunghoLee98/pokerogue `src/coop/coop-starter-selection.ts` (AGPL-3.0-only).
 */

import type { CoopLink, LinkEnd } from "#coop/link/link";
import {
  type CoopStarter,
  type LobbyMessage,
  otherSeat,
  type PlayerCount,
  peers,
  type Seat,
  type SeatRecord,
  type StartPayload,
  startersPerSeat,
} from "#coop/protocol";
import type { AccountSnapshot } from "#coop/sync/account-snapshot";
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
  /** How many players the game has (D40); default 2 */
  players?: PlayerCount;
  link: Pick<CoopLink, "sendLobby" | "onLobby" | "sendStart" | "onStart" | "onEnd"> &
    Partial<Pick<CoopLink, "onChange" | "partnerPresent" | "onPresence">>;
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
  /** The how-manyth ready of its owner */
  gen: number;
}

export class StarterLobby {
  readonly seat: Seat;
  readonly players: PlayerCount;
  /** Each other player's party, by seat: one in a game of two, two in a game of three (D40) */
  readonly partners = new Map<Seat, PartnerState>();

  private readonly options: StarterLobbyOptions;
  private readonly unsubscribes: Unsubscribe[] = [];
  private readonly changeListeners = new Set<() => void>();
  private readonly startListeners = new Set<(start: StartPayload) => void>();

  private ready: Confirmed | null = null;
  /** The confirmed party of each other player who is ready */
  private readonly partnerReadies = new Map<Seat, Confirmed>();
  private start: StartPayload | null = null;
  private ended = false;
  /** Both were ready with too many points together, and the host took both readies back: until this player picks again */
  private resetNotice = false;
  /** The partner's connection dropped and the relay keeps their seat (D20): they may come back */
  private partnerAway = false;
  /** How many times this player confirmed: a reset answers one of them, and an older one is ignored */
  private readyCount = 0;
  /** The last party this player shared, sent again when the partner comes back */
  private lastPicks: { picks: CoopStarter[]; cost: number } | null = null;

  constructor(options: StarterLobbyOptions) {
    this.options = options;
    this.seat = options.seat;
    this.players = options.players ?? 2;
    for (const seat of peers(this.seat, this.players)) {
      this.partners.set(seat, { picks: [], cost: 0, ready: false });
    }
    this.unsubscribes.push(
      options.link.onLobby((message, from) => this.receive(message, from)),
      options.link.onStart(start => this.started(start)),
      options.link.onEnd(end => this.linkEnded(end)),
    );
    const { onChange, onPresence } = options.link;
    if (onChange !== undefined) {
      this.unsubscribes.push(onChange.call(options.link, () => this.presenceChanged()));
    }
    if (this.players === 3 && onPresence !== undefined) {
      // A player of three who leaves the starter select does not come back to it: the lobby is over for all (D40)
      this.unsubscribes.push(
        onPresence.call(options.link, (_seat, present) => {
          if (!present && !this.ended && this.start === null) {
            this.ended = true;
            this.changed();
          }
        }),
      );
    }
  }

  /**
   * The other players' parties as one: in a game of two, the partner's; in a game of three, both partners' picks, their
   * cost together, and ready once both are
   */
  get partner(): PartnerState {
    const all = [...this.partners.values()];
    if (all.length === 1) {
      return all[0]!;
    }
    return {
      picks: all.flatMap(state => state.picks),
      cost: all.reduce((sum, state) => sum + state.cost, 0),
      ready: all.every(state => state.ready),
    };
  }

  /** The partner is away for now: the relay keeps their seat, and they may come back (D20) */
  get away(): boolean {
    return this.partnerAway && !this.ended;
  }

  /** A drop of the partner's connection is not the end: only their leaving, or the room closing, is (D20) */
  private linkEnded(end: LinkEnd): void {
    if (end === "peerLeft" && this.players === 2) {
      this.partnerAway = true;
    } else {
      this.ended = true;
    }
    this.changed();
  }

  /**
   * The partner is back after a drop: what either side sent meanwhile may be lost (the link starts its frames anew), so this
   * player's picks and ready go again; a duplicate changes nothing
   */
  private presenceChanged(): void {
    if (!this.partnerAway || this.options.link.partnerPresent !== true || this.ended) {
      return;
    }
    this.partnerAway = false;
    if (this.start === null) {
      if (this.ready !== null) {
        const { starters, cost, snapshot, events, gen } = this.ready;
        this.options.link.sendLobby({ t: "ready", starters, cost, snapshot, events, gen });
      } else if (this.lastPicks !== null) {
        this.options.link.sendLobby({ t: "picks", ...this.lastPicks });
      }
    } else if (this.seat === "host") {
      // The start itself may be what was lost
      this.options.link.sendStart(this.start);
    }
    this.changed();
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

  /** What the local player may spend: what the partners' parties left of the shared budget */
  get valueLimit(): number {
    return this.options.sharedLimit - this.partner.cost;
  }

  /** How many starters the local player may bring: three in a game of two, two in a game of three (D40) */
  get pickLimit(): number {
    return startersPerSeat(this.players);
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
    this.lastPicks = { picks: [...picks], cost };
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
    if (starters.length === 0 || starters.length > this.pickLimit || cost > this.valueLimit) {
      return false;
    }
    const events = this.options.localEvents();
    const gen = ++this.readyCount;
    this.ready = { starters: [...starters], cost, snapshot, events, gen };
    this.resetNotice = false;
    this.options.link.sendLobby({ t: "ready", starters: [...starters], cost, snapshot, events, gen });
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

  /**
   * @param from - The seat it came from; in a game of three, the host forwards each guest's party to the other guest with
   * the guest's seat in `seat` (D40)
   */
  private receive(message: LobbyMessage, from: Seat = otherSeat(this.seat)): void {
    if (this.start !== null) {
      return;
    }
    if (message.t === "reset") {
      this.receiveReset(message);
      this.changed();
      return;
    }
    const named = "seat" in message ? message.seat : undefined;
    const about = this.players === 3 && from === "host" && named !== undefined ? named : from;
    const state = this.partners.get(about);
    if (about === this.seat) {
      return; // this player's own party, forwarded back
    }
    switch (message.t) {
      case "picks":
        if (state !== undefined && !state.ready) {
          state.picks = message.picks;
          state.cost = message.cost;
        }
        break;
      case "ready":
        if (state === undefined) {
          return;
        }
        state.picks = message.starters;
        state.cost = message.cost;
        state.ready = true;
        this.partnerReadies.set(about, {
          starters: message.starters,
          cost: message.cost,
          snapshot: message.snapshot,
          events: message.events,
          gen: message.gen,
        });
        break;
      case "unready":
        if (state === undefined) {
          return;
        }
        state.ready = false;
        this.partnerReadies.delete(about);
        break;
      case "collection":
        // The partner's Pokémon: `CollectionExchange` takes them
        return;
      case "again":
      case "againCode":
        // The end of a run (D35): not this lobby's
        return;
    }
    if (this.seat === "host" && this.players === 3 && from !== "host") {
      // The guests do not talk to each other: the host passes each one's party on (D40)
      this.options.link.sendLobby({ ...message, seat: from });
    }
    if (message.t === "ready") {
      this.tryStart();
    }
    this.changed();
  }

  /**
   * Host to guest: all were confirmed but too expensive together, so nobody is ready. In a game of three each guest gets its
   * own (`seat`), and sees the other's too
   */
  private receiveReset(message: Extract<LobbyMessage, { t: "reset" }>): void {
    const host = this.partners.get("host");
    if (host !== undefined) {
      host.ready = false;
      this.partnerReadies.delete("host");
    }
    if (message.seat !== undefined && message.seat !== this.seat) {
      const other = this.partners.get(message.seat);
      if (other !== undefined) {
        other.ready = false;
        this.partnerReadies.delete(message.seat);
      }
      return;
    }
    // A reset of an earlier ready of this player (it confirmed again since, with another party) is not this one's
    if (this.ready !== null && message.gen !== this.ready.gen) {
      return;
    }
    this.ready = null;
    this.resetNotice = true;
  }

  /** Host: everyone confirmed, so start. A guest waits for `START`. */
  private tryStart(): void {
    const guests = peers("host", this.players);
    if (
      this.seat !== "host"
      || this.ready === null
      || this.start !== null
      || !guests.every(seat => this.partnerReadies.has(seat))
    ) {
      return;
    }
    const readies = guests.map(seat => [seat, this.partnerReadies.get(seat)!] as const);
    const cost = readies.reduce((sum, [, ready]) => sum + ready.cost, this.ready.cost);
    if (cost > this.options.sharedLimit) {
      // Players added points at the same time: nobody is ready, they choose again
      this.ready = null;
      this.resetNotice = true;
      for (const [seat, ready] of readies) {
        this.partners.get(seat)!.ready = false;
        this.options.link.sendLobby(
          this.players === 3 ? { t: "reset", gen: ready.gen, seat } : { t: "reset", gen: ready.gen },
        );
      }
      this.partnerReadies.clear();
      return;
    }
    const starters: SeatRecord<CoopStarter[]> = { host: this.ready.starters, guest: [] };
    const snapshots: SeatRecord<AccountSnapshot> = { host: this.ready.snapshot, guest: this.ready.snapshot };
    for (const [seat, ready] of readies) {
      starters[seat] = ready.starters;
      snapshots[seat] = ready.snapshot;
    }
    // The run's events are those all clocks have on now: the players may be on either side of an event's start or end, and
    // a client whose clock has the event off has not loaded its pictures
    const start: StartPayload = {
      runSeed: this.options.makeRunSeed(),
      starters,
      snapshots,
      timedEvents: this.options.localEvents().filter(name => readies.every(([, ready]) => ready.events.includes(name))),
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
