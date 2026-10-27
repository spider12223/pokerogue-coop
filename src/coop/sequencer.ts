/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EpochChangedError } from "#coop/epoch";
import { type DecisionKey, type Envelope, isDecisionKey, keyId, keysEqual, type Seat } from "#coop/protocol";
import { getCoopSession } from "#coop/session";
import { canTakeOver, DEFAULT_AFK_TIMERS, takeoverPlan } from "#coop/takeover";
import { type MessageTransport, type Scheduler, systemScheduler, type Unsubscribe } from "#coop/transport/transport";

/**
 * The decision sequencer (DECISIONS D2).
 *
 * - The host assigns a strictly increasing `seq` to every state-changing decision.
 * - The guest sends `PROPOSE`; the host validates it and broadcasts `SEQUENCED` to both clients, itself included.
 * - Both clients consume decisions strictly in `seq` order; early arrivals are buffered.
 * - Every decision carries an asserted {@linkcode DecisionKey}. The simulation says what it expects next with
 *   {@linkcode Sequencer.awaitDecision}; a decision that is not what it expects is a {@linkcode DesyncError}.
 *
 * Nothing here knows about the game: keys are compared, never interpreted, and ordering is only ever `seq`.
 * Never derive a key's `turn` from a local counter and never order anything by arrival time or `battle.turn` (D2).
 *
 * @module
 */

/** A sequenced decision, as both clients see it. */
export interface Decision<P = unknown> {
  seq: number;
  key: DecisionKey;
  /** The player that made it */
  author: Seat;
  payload: P;
  /** The author decided for a partner who did not answer (D17) */
  takeover?: true;
}

/** The two clients (or a client and the sequence) disagree about what happens next. The run cannot continue as is. */
export class DesyncError extends Error {
  readonly reason: string;
  /** The keys the simulation was waiting for (empty if it was not waiting for anything) */
  readonly expected: readonly DecisionKey[];
  /** The decision that did not fit */
  readonly actual: DecisionKey | null;
  readonly seq: number | null;

  constructor(
    reason: string,
    detail: { expected?: readonly DecisionKey[]; actual?: DecisionKey | null; seq?: number | null } = {},
  ) {
    const expected = detail.expected ?? [];
    const actual = detail.actual ?? null;
    super(
      `desync: ${reason}`
        + (detail.seq == null ? "" : ` (seq ${detail.seq})`)
        + (expected.length > 0 ? `; expected ${expected.map(keyId).join(" | ")}` : "")
        + (actual ? `; got ${keyId(actual)}` : ""),
    );
    this.name = "DesyncError";
    this.reason = reason;
    this.expected = expected;
    this.actual = actual;
    this.seq = detail.seq ?? null;
  }
}

/**
 * Why the host did not sequence a proposal:
 * - `badKey`, `authorMismatch`, `authorNotAllowed`, `duplicate`: the key or its author is wrong, or the key was used
 *   (`authorNotAllowed` also: a take over of a decision nobody may take over, D17)
 * - `closed`: the window that expected the key was closed by another decision (a late proposal, D9)
 * - `invalid`: the payload does not fit the key (the host's `validatePayload` said no, it is too big, a take over does not
 *   propose its plan's default, or it is not legal in the state the host is in, D24)
 * - `full`: too many proposals wait for decisions the host's simulation has not opened yet
 */
export type RejectReason =
  | "badKey"
  | "authorMismatch"
  | "authorNotAllowed"
  | "duplicate"
  | "closed"
  | "invalid"
  | "full";

/** A proposal the host would not sequence. */
export class ProposalRejectedError extends Error {
  readonly reason: RejectReason;
  readonly key: DecisionKey;

  constructor(reason: RejectReason, key: DecisionKey) {
    super(`proposal rejected: ${reason} (${keyId(key)})`);
    this.name = "ProposalRejectedError";
    this.reason = reason;
    this.key = key;
  }
}

export interface SequencerOptions {
  role: Seat;
  transport: MessageTransport;
  /** Host only: the seats that may author a decision with this key. Default: both. */
  allowedAuthors?: (key: DecisionKey) => readonly Seat[];
  /** The first `seq`. Both clients must agree on it (for example after a resume). Default 1. */
  firstSeq?: number;
  /** Host only: how many proposals may wait for the simulation to open their expectation. Default 1024. */
  maxParked?: number;
  /** How many decisions may arrive ahead of a gap before it counts as a desync. Default 1024. */
  maxEarly?: number;
  /**
   * Host only: whether a proposal's payload fits its key and author (for example, a transfer may only take from the
   * author's own Pokémon). A proposal that does not is rejected as `invalid` and never sequenced.
   */
  validatePayload?: (key: DecisionKey, payload: unknown, author: Seat) => boolean;
  /**
   * Host only: how long the host's simulation must have waited for a decision before the guest may take it over (D17), in
   * ms. Default: the hint time of the session's AFK timers (the guest offers a take over only at the later offer time).
   */
  takeoverAfterMs?: () => number;
  /** Host only: the clock of {@linkcode takeoverAfterMs}. Default: the real one. */
  scheduler?: Scheduler;
}

/** The longest payload the guest may propose, in characters of JSON (a decision is a few dozen) */
export const MAX_PROPOSAL_CHARS = 16_384;

/** How much the parked proposals of the guest may hold together, in characters of JSON */
const MAX_PARKED_CHARS = 262_144;

/** One way out of an open window: the key that closes the window, and who may propose it (default: both). */
export interface WindowEntry {
  key: DecisionKey;
  authors?: readonly Seat[];
}

export interface ProposeOptions {
  /**
   * The author decides for a partner who did not answer (D17). The host then does not check who may author the key; the
   * payload is checked as always, and the first proposal sequenced for a key wins. The host refuses a take over of a kind
   * nobody takes over, and one whose plan is a default payload with another payload. The guest's take over waits on the
   * host until the host's simulation has waited for that decision at least {@linkcode SequencerOptions.takeoverAfterMs}
   * (or the guest is already deciding for the host's player); the host's own answer meanwhile wins.
   */
  takeover?: boolean;
}

export interface AwaitOptions {
  /**
   * Host only: the seats that may author this decision. A proposal by another seat is rejected.
   * Use it to say who owns a decision (D7: control follows the owner of the Pokémon).
   */
  authors?: readonly Seat[];
}

type AnyDecision = Decision<unknown>;

interface Awaiter {
  /** Keys still expected */
  remaining: DecisionKey[];
  collected: AnyDecision[];
  /** `awaitAll`: resolve once every key arrived, in any order */
  all: boolean;
  authors: readonly Seat[] | undefined;
  /** `awaitOneOf`: who may propose each key */
  keyAuthors: Map<string, readonly Seat[] | undefined> | undefined;
  /** `awaitOneOf`: the keys that were not used are closed when the window resolves */
  closeOnResolve: boolean;
  /** Host: when the simulation opened it, on the host's clock (a take over waits for it, D17) */
  openedAt: number;
  resolve: (value: AnyDecision | AnyDecision[]) => void;
  reject: (error: Error) => void;
}

/** How many past `seq`s remember their key, to tell a harmless duplicate from a conflicting one. */
const SEEN_WINDOW = 4096;

/** How many keys the simulation was handed are remembered, to catch one that is awaited a second time */
const CONSUMED_WINDOW = 4096;

const BOTH_SEATS: readonly Seat[] = ["host", "guest"];

/** @returns Whether two values that came from JSON are the same JSON */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (
    typeof a !== "object"
    || typeof b !== "object"
    || a === null
    || b === null
    || Array.isArray(a) !== Array.isArray(b)
  ) {
    return false;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length && keys.every(name => name in right && sameJson(left[name], right[name]))
  );
}

/** @returns The size of a payload in characters of JSON (what it took on the wire) */
function payloadSize(payload: unknown): number {
  try {
    return JSON.stringify(payload)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * The host's check of a take over (D17), whoever proposes it: nobody takes over a trade request, a proposal, its cancel, an
 * accept (the answer of a taker is to decline) or a party edit; a decision whose take over chooses nothing takes exactly
 * the default of its plan.
 * @returns Why it is refused, or `null`
 */
function takeoverRefusal(key: DecisionKey, payload: unknown): RejectReason | null {
  if (!canTakeOver(key.kind) || key.kind === "TRADE_ACCEPT" || key.kind === "TRADE_PROPOSE") {
    return "authorNotAllowed";
  }
  const plan = takeoverPlan(key);
  return plan.mode === "payload" && !sameJson(payload, plan.payload) ? "invalid" : null;
}

export class Sequencer {
  readonly role: Seat;

  private readonly transport: MessageTransport;
  private readonly unsubscribe: Unsubscribe;
  private readonly allowedAuthors: (key: DecisionKey) => readonly Seat[];
  private readonly maxParked: number;
  private readonly maxEarly: number;
  private readonly validatePayload: ((key: DecisionKey, payload: unknown, author: Seat) => boolean) | undefined;
  private readonly takeoverAfterMs: () => number;
  private readonly scheduler: Scheduler;
  /** Host: keys of windows that were closed; a proposal for one is rejected, never parked. */
  private readonly closedKeys = new Set<string>();
  /** Both: whether a decision is legal in the state of the simulation as it is handed over (D24) */
  private legality: ((key: DecisionKey, payload: unknown, author: Seat) => string | null) | null = null;

  /** Host: the `seq` the next accepted proposal gets. */
  private nextAssign: number;
  /** Both: the `seq` the intake expects next. */
  private nextSeq: number;
  /** Arrived ahead of a gap. */
  private readonly early = new Map<number, AnyDecision>();
  /** In order, waiting for the simulation to ask for them. */
  private readonly ready: AnyDecision[] = [];
  private readonly seenKeys = new Map<number, string>();
  private lastConsumed = 0;
  /** Keys handed to the simulation in this epoch, oldest first: awaiting one again would wait forever */
  private readonly consumedKeys = new Set<string>();

  private readonly awaiters: Awaiter[] = [];

  /** Host: keys already sequenced. */
  private readonly sequencedKeys = new Set<string>();
  /**
   * Host: proposals whose expectation the simulation has not opened yet, and take overs of the guest that wait until the
   * host has waited long enough for the decision (D17).
   */
  private parked: Envelope[] = [];
  /** Host: the size of each parked proposal of the guest */
  private readonly parkedSizes = new WeakMap<Envelope, number>();
  /** Host: a take over of the guest was sequenced, and the host's player has not decided anything since (D17) */
  private takeoverStreak = false;
  /** Host: when the next parked take over may be sequenced */
  private takeoverTimer: unknown = null;
  private takeoverDue = Number.POSITIVE_INFINITY;

  private failure: DesyncError | null = null;
  private closed = false;
  private readonly desyncListeners = new Set<(error: DesyncError) => void>();
  private readonly decisionListeners = new Set<(decision: Decision) => void>();
  private readonly rejectListeners = new Set<(info: { key: DecisionKey; reason: RejectReason }) => void>();

  constructor(options: SequencerOptions) {
    this.role = options.role;
    this.transport = options.transport;
    this.allowedAuthors = options.allowedAuthors ?? (() => BOTH_SEATS);
    this.maxParked = options.maxParked ?? 1024;
    this.maxEarly = options.maxEarly ?? 1024;
    this.validatePayload = options.validatePayload;
    this.takeoverAfterMs =
      options.takeoverAfterMs ?? (() => (getCoopSession()?.afkTimers ?? DEFAULT_AFK_TIMERS).hintMs);
    this.scheduler = options.scheduler ?? systemScheduler;
    this.nextAssign = options.firstSeq ?? 1;
    this.nextSeq = options.firstSeq ?? 1;
    this.unsubscribe = this.transport.onMessage(message => this.handleMessage(message));
  }

  /** `seq` of the last decision handed to the simulation, 0 before the first. */
  get lastApplied(): number {
    return this.lastConsumed;
  }

  /** The `seq` the next decision will take: this client's view of where the run is in the sequence */
  get nextExpected(): number {
    return this.role === "host" ? this.nextAssign : this.nextSeq;
  }

  /**
   * Host: take the next `seq` for a message that is sequenced but is not a decision (the `RESYNC`, D18). Both clients carry on
   * after it.
   */
  reserveSeq(): number {
    if (this.role !== "host") {
      throw new Error("Only the host assigns seqs");
    }
    return this.nextAssign++;
  }

  /** Host: make sure the next `seq` is at least `seq` (a host that was reloaded carries on from its slot, D18) */
  ensureSeqAtLeast(seq: number): void {
    if (this.role === "host" && seq > this.nextAssign) {
      this.nextAssign = seq;
      this.nextSeq = Math.max(this.nextSeq, seq);
    }
  }

  /**
   * Both clients: check every decision, just before the simulation gets it, against the state the simulation is in (D24). A
   * decision that is not legal is not delivered: it is a desync ("illegal decision"), so both clients stop at the same place
   * and go through the resync of D13. `null` removes the check.
   * @param check - The reason a decision is not legal, or `null`; it must not throw
   */
  setLegality(check: ((key: DecisionKey, payload: unknown, author: Seat) => string | null) | null): void {
    this.legality = check;
  }

  /**
   * The run is reloaded under a new epoch (D18): forget the old world and carry on from `nextSeq`, which is after the `RESYNC`
   * that caused it. The host's `seq` never goes back. The guest takes the `RESYNC`'s as it is: a host that was closed and
   * reopened carries on from its slot, which is older than what the guest has seen, and the epoch stamp already drops
   * everything of the old world. What awaited a decision rejects with {@linkcode EpochChangedError}; the windows, the closed
   * keys, the parked proposals, the early decisions and a desync are forgotten, and a key of the old epoch can be used again
   * (the wave is played again).
   */
  resetForEpoch(nextSeq: number): void {
    if (this.closed) {
      return;
    }
    const error = new EpochChangedError();
    for (const awaiter of this.awaiters.splice(0)) {
      awaiter.reject(error);
    }
    this.early.clear();
    this.ready.length = 0;
    this.parked = [];
    this.cancelTakeoverCheck();
    this.takeoverStreak = false;
    this.closedKeys.clear();
    this.sequencedKeys.clear();
    this.seenKeys.clear();
    this.consumedKeys.clear();
    this.failure = null;
    this.nextSeq = this.role === "host" ? Math.max(nextSeq, this.nextSeq) : nextSeq;
    this.nextAssign = Math.max(this.nextAssign, nextSeq);
    this.lastConsumed = this.nextSeq - 1;
  }

  /** @returns Whether a decision with this key reached this client (it may not have been asked for yet) */
  hasDecision(key: DecisionKey): boolean {
    const id = keyId(key);
    for (const known of this.seenKeys.values()) {
      if (known === id) {
        return true;
      }
    }
    return false;
  }

  /** Decisions that arrived in order but have not been asked for yet. */
  get readyCount(): number {
    return this.ready.length;
  }

  /** Decisions that arrived ahead of a gap. */
  get earlyCount(): number {
    return this.early.size;
  }

  /** Host: proposals waiting for the simulation to open their expectation. */
  get parkedCount(): number {
    return this.parked.length;
  }

  /** The error that stopped this sequencer, if any. After a desync nothing more is delivered. */
  get desync(): DesyncError | null {
    return this.failure;
  }

  /**
   * Every sequenced decision as this client receives it, in `seq` order, before the simulation asks for it. For tests and
   * the debug API; the simulation never needs it.
   */
  onDecision(listener: (decision: Decision) => void): Unsubscribe {
    this.decisionListeners.add(listener);
    return () => {
      this.decisionListeners.delete(listener);
    };
  }

  onDesync(listener: (error: DesyncError) => void): Unsubscribe {
    this.desyncListeners.add(listener);
    return () => {
      this.desyncListeners.delete(listener);
    };
  }

  /** The host refused a proposal of this client (guest) or a remote one (host). */
  onProposalRejected(listener: (info: { key: DecisionKey; reason: RejectReason }) => void): Unsubscribe {
    this.rejectListeners.add(listener);
    return () => {
      this.rejectListeners.delete(listener);
    };
  }

  /**
   * Make a decision of this client's player.
   * - Guest: sends a `PROPOSE`. A refusal arrives later through {@linkcode onProposalRejected}.
   * - Host: validates and sequences it at once; throws {@linkcode ProposalRejectedError} if it is not acceptable.
   *   If the simulation has not opened the matching expectation yet, the decision waits for it.
   */
  propose(key: DecisionKey, payload: unknown = null, options: ProposeOptions = {}): void {
    this.assertUsable();
    if (!isDecisionKey(key)) {
      throw new TypeError("propose: not a decision key");
    }
    const envelope: Envelope = {
      key,
      author: this.role,
      kind: "PROPOSE",
      payload,
      ...(options.takeover === true ? { takeover: true as const } : {}),
    };
    if (this.role === "guest") {
      this.transport.send(envelope);
      return;
    }
    const rejection = this.hostHandleProposal(envelope, false);
    if (rejection) {
      throw new ProposalRejectedError(rejection, key);
    }
  }

  /**
   * Resolve with the next sequenced decision, which must have this key.
   * Rejects with {@linkcode DesyncError} if the next sequenced decision has another key.
   *
   * Several awaits may be open at once (simultaneous commands): the next decision must then match one of them.
   * Pass an array to accept any of several keys.
   */
  awaitDecision<P = unknown>(
    expected: DecisionKey | readonly DecisionKey[],
    options: AwaitOptions = {},
  ): Promise<Decision<P>> {
    return this.register(expected, false, options) as Promise<Decision<P>>;
  }

  /**
   * An open window with several ways out (the reward screen, D9): resolve with the first sequenced decision that has any
   * of the entries' keys. Each entry says who may propose its key. The keys that were not used are closed: the host
   * rejects a proposal that arrives for one later (`closed`) instead of keeping it, and tells its author.
   */
  awaitOneOf<P = unknown>(entries: readonly WindowEntry[]): Promise<Decision<P>> {
    const keyAuthors = new Map(entries.map(entry => [keyId(entry.key), entry.authors] as const));
    return this.register(
      entries.map(entry => entry.key),
      false,
      {},
      { keyAuthors, closeOnResolve: true },
    ) as Promise<Decision<P>>;
  }

  /**
   * Host: close keys that no window will expect any more. Proposals parked for them are rejected as `closed`, and so are
   * the ones that arrive later.
   */
  closeKeys(keys: readonly DecisionKey[]): void {
    if (this.role !== "host") {
      return;
    }
    const ids = new Set(keys.map(keyId));
    for (const id of ids) {
      this.closedKeys.add(id);
    }
    const stale = this.parked.filter(envelope => envelope.key !== null && ids.has(keyId(envelope.key)));
    this.parked = this.parked.filter(envelope => !stale.includes(envelope));
    for (const envelope of stale) {
      this.rejectParked(envelope, envelope.key!, "closed");
    }
  }

  /**
   * Resolve once a decision for every key has been sequenced, in whatever order they come.
   * @returns The decisions in the order of `keys`
   */
  async awaitAll(keys: readonly DecisionKey[], options: AwaitOptions = {}): Promise<AnyDecision[]> {
    const collected = (await this.register(keys, true, options)) as AnyDecision[];
    return keys.map(key => collected.find(decision => keysEqual(decision.key, key))!);
  }

  /** Stop: reject whatever is still awaited and ignore further messages. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribe();
    this.cancelTakeoverCheck();
    const error = new Error("sequencer closed");
    for (const awaiter of this.awaiters.splice(0)) {
      awaiter.reject(error);
    }
  }

  // #region Awaiting

  private register(
    expected: DecisionKey | readonly DecisionKey[],
    all: boolean,
    options: AwaitOptions,
    window?: { keyAuthors: Map<string, readonly Seat[] | undefined>; closeOnResolve: boolean },
  ): Promise<AnyDecision | AnyDecision[]> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (this.closed) {
      return Promise.reject(new Error("sequencer closed"));
    }
    const keys: DecisionKey[] = Array.isArray(expected)
      ? [...(expected as readonly DecisionKey[])]
      : [expected as DecisionKey];
    if (keys.length === 0 || !keys.every(isDecisionKey)) {
      return Promise.reject(new TypeError("awaitDecision: expected one or more decision keys"));
    }
    // A decision is made once: its key awaited again would wait forever (its proposals are duplicates). Both clients get
    // here at the same point, so both stop, and the run goes through the resync instead of hanging (D13)
    const used = keys.find(key => this.consumedKeys.has(keyId(key)));
    if (used !== undefined) {
      this.fail(new DesyncError("a decision that was already made is awaited again", { expected: keys, actual: used }));
      return Promise.reject(this.failure);
    }
    return new Promise((resolve, reject) => {
      this.awaiters.push({
        remaining: keys,
        collected: [],
        all,
        authors: options.authors,
        keyAuthors: window?.keyAuthors,
        closeOnResolve: window?.closeOnResolve ?? false,
        openedAt: this.role === "host" ? this.scheduler.now() : 0,
        resolve,
        reject,
      });
      if (this.role === "host") {
        this.flushParked();
      }
      this.drain();
    });
  }

  /** Hand ready decisions, in order, to the awaits that expect them. */
  private drain(): void {
    while (!this.failure && this.ready.length > 0 && this.awaiters.length > 0) {
      const head = this.ready[0]!;
      const index = this.awaiters.findIndex(awaiter => awaiter.remaining.some(key => keysEqual(key, head.key)));
      if (index < 0) {
        this.fail(
          new DesyncError("the next sequenced decision is not what the simulation is waiting for", {
            expected: this.awaiters.flatMap(awaiter => awaiter.remaining),
            actual: head.key,
            seq: head.seq,
          }),
        );
        return;
      }
      const awaiter = this.awaiters[index]!;
      const illegal = this.legality?.(head.key, head.payload, head.author) ?? null;
      if (illegal !== null) {
        this.fail(new DesyncError(`illegal decision: ${illegal}`, { actual: head.key, seq: head.seq }));
        return;
      }
      this.ready.shift();
      this.lastConsumed = head.seq;
      this.rememberConsumed(keyId(head.key));
      awaiter.remaining.splice(
        awaiter.remaining.findIndex(key => keysEqual(key, head.key)),
        1,
      );
      awaiter.collected.push(head);
      if (!awaiter.all) {
        this.awaiters.splice(index, 1);
        if (awaiter.closeOnResolve) {
          this.closeKeys(awaiter.remaining);
        }
        awaiter.resolve(head);
      } else if (awaiter.remaining.length === 0) {
        this.awaiters.splice(index, 1);
        awaiter.resolve(awaiter.collected);
      }
    }
  }

  // #endregion

  // #region Intake (both roles)

  private handleMessage(message: Envelope): void {
    if (this.closed || this.failure) {
      return;
    }
    switch (message.kind) {
      case "SEQUENCED":
        if (this.role === "guest" && message.seq !== undefined && message.key !== null) {
          this.receiveSequenced({
            seq: message.seq,
            key: message.key,
            author: message.author,
            payload: message.payload,
            ...(message.takeover === true ? { takeover: true as const } : {}),
          });
        }
        break;
      case "PROPOSE":
        if (this.role === "host") {
          const rejection = this.hostHandleProposal(message, true);
          if (rejection && message.key) {
            this.transport.send({ key: message.key, author: "host", kind: "REJECT", payload: { reason: rejection } });
            this.emitRejected(message.key, rejection);
          }
        }
        break;
      case "REJECT":
        if (this.role === "guest" && message.key) {
          const reason = (message.payload as { reason?: RejectReason } | null)?.reason ?? "badKey";
          this.emitRejected(message.key, reason);
        }
        break;
      default:
        break; // handshake and other kinds are not ours
    }
  }

  private receiveSequenced(decision: AnyDecision): void {
    if (decision.seq < this.nextSeq) {
      this.checkDuplicate(decision);
      return;
    }
    if (decision.seq > this.nextSeq) {
      const waiting = this.early.get(decision.seq);
      if (waiting) {
        this.checkDuplicate(decision, waiting);
      } else if (this.early.size >= this.maxEarly || decision.seq - this.nextSeq > this.maxEarly) {
        // The gap never closes as long as this: the two sides do not count the same
        this.fail(
          new DesyncError("too many decisions ahead of a gap in the sequence", {
            actual: decision.key,
            seq: decision.seq,
          }),
        );
      } else {
        this.early.set(decision.seq, decision);
      }
      return;
    }
    this.accept(decision);
    for (let next = this.early.get(this.nextSeq); next !== undefined; next = this.early.get(this.nextSeq)) {
      this.early.delete(this.nextSeq);
      this.accept(next);
    }
    this.drain();
  }

  private accept(decision: AnyDecision): void {
    this.seenKeys.set(decision.seq, keyId(decision.key));
    this.seenKeys.delete(decision.seq - SEEN_WINDOW);
    this.ready.push(decision);
    this.nextSeq = decision.seq + 1;
    for (const listener of [...this.decisionListeners]) {
      listener(decision);
    }
  }

  /** The same `seq` again is harmless; the same `seq` with another key means the two sides diverged. */
  private checkDuplicate(decision: AnyDecision, previous?: AnyDecision): void {
    const known = previous ? keyId(previous.key) : this.seenKeys.get(decision.seq);
    if (known !== undefined && known !== keyId(decision.key)) {
      this.fail(
        new DesyncError("two different decisions carry the same seq", {
          expected: previous ? [previous.key] : [],
          actual: decision.key,
          seq: decision.seq,
        }),
      );
    }
  }

  // #endregion

  // #region Host: validating and sequencing

  /**
   * @param remote - Whether it came over the transport (so it must be the guest's) or from the host's own `propose`
   * @returns The reason the proposal was not sequenced, or `null` if it was sequenced or is parked
   */
  private hostHandleProposal(envelope: Envelope, remote: boolean): RejectReason | null {
    const key = envelope.key;
    if (key === null || !isDecisionKey(key)) {
      return "badKey";
    }
    const author = envelope.author;
    if (author !== (remote ? "guest" : "host")) {
      return "authorMismatch";
    }
    const takeover = envelope.takeover === true;
    if (takeover) {
      const refusal = takeoverRefusal(key, envelope.payload);
      if (refusal !== null) {
        return refusal;
      }
    } else if (!this.allowedAuthors(key).includes(author)) {
      return "authorNotAllowed";
    }
    const id = keyId(key);
    if (this.closedKeys.has(id)) {
      return "closed";
    }
    if (this.sequencedKeys.has(id)) {
      return "duplicate";
    }
    const twin = this.parked.find(parked => parked.key !== null && keyId(parked.key) === id);
    // The host's player answers while the guest's take over of that decision waits for its time: the answer wins (D17)
    const supersedes = twin !== undefined && !remote && !takeover && twin.takeover === true && twin.author === "guest";
    if (twin !== undefined && !supersedes) {
      return "duplicate";
    }
    const size = remote ? payloadSize(envelope.payload) : 0;
    if (size > MAX_PROPOSAL_CHARS) {
      return "invalid";
    }
    if (this.validatePayload && !this.validatePayload(key, envelope.payload, author)) {
      return "invalid";
    }
    const awaiter = this.awaiterFor(key);
    if (awaiter && !takeover) {
      const allowed = this.authorsFor(awaiter, key);
      if (allowed && !allowed.includes(author)) {
        return "authorNotAllowed";
      }
    }
    // The simulation has not reached this decision yet (the guest is ahead), or a take over of the guest waits for its time
    const hold = !awaiter || (remote && takeover && !this.takeoverRipe(awaiter));
    if (!hold && remote && this.isIllegal(key, envelope)) {
      return "invalid";
    }
    if (hold && !this.hasParkingRoom(size, supersedes ? 1 : 0)) {
      return "full";
    }
    if (supersedes) {
      // Only the guest is told: the host's own screens listen for refusals, and this answer of the host's is not one
      this.parked = this.parked.filter(parked => parked !== twin);
      this.transport.send({ key, author: "host", kind: "REJECT", payload: { reason: "duplicate" } });
    }
    if (!remote && !takeover) {
      // The host's player is there: a take over of theirs waits again (D17)
      this.takeoverStreak = false;
    }
    if (hold) {
      this.parkedSizes.set(envelope, size);
      this.parked.push(envelope);
      if (awaiter) {
        this.scheduleTakeoverCheck(awaiter.openedAt + this.takeoverAfterMs());
      }
      return null;
    }
    this.sequence(envelope, key);
    return null;
  }

  /** Re-examine parked proposals after the simulation opened new expectations, or a take over's time came. */
  private flushParked(): void {
    if (this.parked.length === 0) {
      return;
    }
    const waiting = this.parked;
    this.parked = [];
    let due = Number.POSITIVE_INFINITY;
    for (const envelope of waiting) {
      if (this.failure) {
        return;
      }
      const key = envelope.key;
      const awaiter = key ? this.awaiterFor(key) : undefined;
      if (key && this.closedKeys.has(keyId(key))) {
        this.rejectParked(envelope, key, "closed");
      } else if (!key || !awaiter) {
        this.parked.push(envelope);
      } else if (envelope.takeover !== true && this.authorsFor(awaiter, key)?.includes(envelope.author) === false) {
        this.rejectParked(envelope, key, "authorNotAllowed");
      } else if (envelope.takeover === true && envelope.author === "guest" && !this.takeoverRipe(awaiter)) {
        this.parked.push(envelope);
        due = Math.min(due, awaiter.openedAt + this.takeoverAfterMs());
      } else if (envelope.author === "guest" && this.isIllegal(key, envelope)) {
        this.rejectParked(envelope, key, "invalid");
      } else {
        this.sequence(envelope, key);
      }
    }
    if (due !== Number.POSITIVE_INFINITY) {
      this.scheduleTakeoverCheck(due);
    }
  }

  private awaiterFor(key: DecisionKey): Awaiter | undefined {
    return this.awaiters.find(candidate => candidate.remaining.some(expected => keysEqual(expected, key)));
  }

  /**
   * Whether the guest may take over this open decision now (D17): the host's simulation has waited for it at least the hint
   * time (the guest's own offer comes later still), or the guest is already deciding for the host's player, who has not
   * decided anything since (the reward screen goes on step by step).
   */
  private takeoverRipe(awaiter: Awaiter): boolean {
    return this.takeoverStreak || this.scheduler.now() - awaiter.openedAt >= this.takeoverAfterMs();
  }

  /**
   * The legality check (D24) of a proposal of the guest, just before the host sequences it: the state is the one the
   * decision is applied to, because the host hands a decision it sequences to its simulation at once. An illegal proposal is
   * refused instead of costing both clients a resync.
   */
  private isIllegal(key: DecisionKey, envelope: Envelope): boolean {
    return (this.legality?.(key, envelope.payload, envelope.author) ?? null) !== null;
  }

  /** Whether one more proposal of this size may wait, when `leaving` parked ones make way for it */
  private hasParkingRoom(size: number, leaving: number): boolean {
    if (this.parked.length - leaving >= this.maxParked) {
      return false;
    }
    let total = size;
    for (const parked of this.parked) {
      total += this.parkedSizes.get(parked) ?? 0;
    }
    return total <= MAX_PARKED_CHARS;
  }

  private scheduleTakeoverCheck(due: number): void {
    if (this.closed) {
      return;
    }
    if (this.takeoverTimer !== null) {
      if (this.takeoverDue <= due) {
        return;
      }
      this.scheduler.clearTimeout(this.takeoverTimer);
    }
    this.takeoverDue = due;
    this.takeoverTimer = this.scheduler.setTimeout(
      () => {
        this.takeoverTimer = null;
        this.takeoverDue = Number.POSITIVE_INFINITY;
        if (!this.closed && !this.failure) {
          this.flushParked();
        }
      },
      Math.max(0, due - this.scheduler.now()),
    );
  }

  private cancelTakeoverCheck(): void {
    if (this.takeoverTimer !== null) {
      this.scheduler.clearTimeout(this.takeoverTimer);
      this.takeoverTimer = null;
    }
    this.takeoverDue = Number.POSITIVE_INFINITY;
  }

  private rememberConsumed(id: string): void {
    this.consumedKeys.add(id);
    if (this.consumedKeys.size > CONSUMED_WINDOW) {
      const oldest = this.consumedKeys.values().next().value;
      if (oldest !== undefined) {
        this.consumedKeys.delete(oldest);
      }
    }
  }

  /** Who may propose this key to this awaiter: the window's per-key authors, else the awaiter's */
  private authorsFor(awaiter: Awaiter, key: DecisionKey): readonly Seat[] | undefined {
    return awaiter.keyAuthors === undefined ? awaiter.authors : awaiter.keyAuthors.get(keyId(key));
  }

  private rejectParked(envelope: Envelope, key: DecisionKey, reason: RejectReason): void {
    if (envelope.author === "guest") {
      this.transport.send({ key, author: "host", kind: "REJECT", payload: { reason } });
    }
    this.emitRejected(key, reason);
  }

  private sequence(envelope: Envelope, key: DecisionKey): void {
    const seq = this.nextAssign++;
    this.sequencedKeys.add(keyId(key));
    if (envelope.takeover === true && envelope.author === "guest") {
      this.takeoverStreak = true;
    }
    const takeover = envelope.takeover === true ? { takeover: true as const } : {};
    const decision: AnyDecision = { seq, key, author: envelope.author, payload: envelope.payload, ...takeover };
    this.transport.send({
      seq,
      key,
      author: envelope.author,
      kind: "SEQUENCED",
      payload: envelope.payload,
      ...takeover,
    });
    this.receiveSequenced(decision);
  }

  // #endregion

  private fail(error: DesyncError): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    for (const awaiter of this.awaiters.splice(0)) {
      awaiter.reject(error);
    }
    for (const listener of [...this.desyncListeners]) {
      listener(error);
    }
  }

  private emitRejected(key: DecisionKey, reason: RejectReason): void {
    for (const listener of [...this.rejectListeners]) {
      listener({ key, reason });
    }
  }

  private assertUsable(): void {
    if (this.closed) {
      throw new Error("sequencer closed");
    }
    if (this.failure) {
      throw this.failure;
    }
  }
}
