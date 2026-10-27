/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Scheduler } from "#coop/transport/transport";
import { systemScheduler } from "#coop/transport/transport";

/**
 * The cosmetic channel (DECISIONS D16): intents, cursors, pings and emotes. They only change what the partner sees, travel
 * as unsequenced `COSMETIC` messages without numbering or resend, and never touch sim state.
 *
 * Everything that arrives is untrusted: {@linkcode isCosmeticMessage} drops what is malformed and
 * {@linkcode CosmeticReceiver} drops what is over its rate limit. Everything this client sends goes through
 * {@linkcode CosmeticSender}, which keeps to the same limits.
 *
 * No game imports, so it runs in Node.
 *
 * @module
 */

/** What a ping points at. Indices are field positions (0 or 1) or option positions of the screen. */
export type CosmeticTarget =
  | { k: "enemy"; index: number }
  | { k: "ally"; index: number }
  | { k: "party"; pokemonId: number }
  | { k: "reward"; index: number }
  | { k: "shop"; index: number }
  | { k: "none" };

/** A place in the text of the run (D27): checkpoint, phase, prompt; see `src/coop/pace.ts` */
export type PaceAt = [checkpoint: number, phase: number, prompt: number];

/**
 * - `intent`: what the sender is about to command with `pokemonId`: the move and the target (a `BattlerIndex`) they are
 *   looking at, or `null` for none; `ready` once the command was proposed
 * - `cursor`: where the sender's cursor is on reward screen `screen`
 * - `meCursor` (the chooser, D29): the option the sender's cursor is on, on a Mystery Encounter's screen; `step` is the
 *   encounter's question (`session.meStep` when it was asked)
 * - `ping`: the sender points at something
 * - `emote`: one of {@linkcode EMOTE_COUNT}
 * - `pace` (host, D27): where the host is in the text, and its game speed, EXP bar speed, HP bar speed, IV Scanner,
 *   move animation and level-up stats settings, which the guest follows
 * - `press` (guest, D27): the guest pressed on the line at `at`
 */
export type CosmeticMessage =
  | { t: "intent"; pokemonId: number; move: number | null; target: number | null; ready: boolean }
  | { t: "cursor"; screen: number; row: number; col: number }
  | { t: "meCursor"; step: number; index: number }
  | { t: "ping"; at: CosmeticTarget }
  | { t: "emote"; id: number }
  | { t: "pace"; at: PaceAt; game: number; exp: number; hp: number; iv: boolean; anim: boolean; stats: boolean }
  | { t: "press"; at: PaceAt };

export type CosmeticKind = CosmeticMessage["t"];

export const COSMETIC_KINDS: readonly CosmeticKind[] = [
  "intent",
  "cursor",
  "meCursor",
  "ping",
  "emote",
  "pace",
  "press",
];

export const EMOTE_COUNT = 6;

const isInt = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

function isCosmeticTarget(value: unknown): value is CosmeticTarget {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const target = value as Record<string, unknown>;
  switch (target["k"]) {
    case "none":
      return true;
    case "enemy":
    case "ally":
      return isInt(target["index"], 0, 1);
    case "party":
      return isInt(target["pokemonId"], 0, Number.MAX_SAFE_INTEGER);
    case "reward":
    case "shop":
      return isInt(target["index"], 0, 31);
    default:
      return false;
  }
}

function isPaceAt(value: unknown): value is PaceAt {
  return Array.isArray(value) && value.length === 3 && value.every(part => isInt(part, 0, 10_000_000));
}

/** @returns Whether this is a well-formed cosmetic message: plain numbers in range, nothing else */
export function isCosmeticMessage(value: unknown): value is CosmeticMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value as Record<string, unknown>;
  switch (message["t"]) {
    case "intent":
      return (
        isInt(message["pokemonId"], 0, Number.MAX_SAFE_INTEGER)
        && (message["move"] === null || isInt(message["move"], 0, 10_000))
        && (message["target"] === null || isInt(message["target"], 0, 3))
        && typeof message["ready"] === "boolean"
      );
    case "cursor":
      return isInt(message["screen"], 0, 10_000) && isInt(message["row"], 0, 8) && isInt(message["col"], 0, 31);
    case "meCursor":
      return isInt(message["step"], 0, 10_000) && isInt(message["index"], 0, 8);
    case "ping":
      return isCosmeticTarget(message["at"]);
    case "emote":
      return isInt(message["id"], 0, EMOTE_COUNT - 1);
    case "pace":
      return (
        isPaceAt(message["at"])
        && isInt(message["game"], 1, 10)
        && isInt(message["exp"], 0, 3)
        && isInt(message["hp"], 0, 3)
        && typeof message["iv"] === "boolean"
        && typeof message["anim"] === "boolean"
        && typeof message["stats"] === "boolean"
      );
    case "press":
      return isPaceAt(message["at"]);
    default:
      return false;
  }
}

// #region Rate limits (D16)

export interface CosmeticLimit {
  /** Sustained rate, per second */
  perSecond: number;
  /** How many may come at once after a quiet time */
  burst: number;
}

/** What the sender keeps to; the receiver allows a little more (see {@linkcode CosmeticReceiver}) */
export const COSMETIC_LIMITS: Readonly<Record<CosmeticKind, CosmeticLimit>> = {
  intent: { perSecond: 10, burst: 5 },
  cursor: { perSecond: 10, burst: 5 },
  meCursor: { perSecond: 10, burst: 5 },
  ping: { perSecond: 1, burst: 3 },
  emote: { perSecond: 1 / 1.5, burst: 2 },
  pace: { perSecond: 8, burst: 4 },
  press: { perSecond: 5, burst: 3 },
};

/** A token bucket on an injectable clock */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly limit: CosmeticLimit,
    now: number,
  ) {
    this.tokens = limit.burst;
    this.last = now;
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.last);
    this.tokens = Math.min(this.limit.burst, this.tokens + (elapsed / 1000) * this.limit.perSecond);
    this.last = now;
  }

  /** @returns Whether one more may go at `now`; if so, it is counted */
  public take(now: number): boolean {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** @returns How long until one is available at `now`, in ms (0 if now) */
  public waitMs(now: number): number {
    this.refill(now);
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.limit.perSecond) * 1000);
  }
}

export interface CosmeticStats {
  accepted: Record<CosmeticKind, number>;
  /** Malformed, or of an unknown kind */
  malformed: number;
  /** Well-formed but over the limit */
  limited: Record<CosmeticKind, number>;
}

function emptyKindCounts(): Record<CosmeticKind, number> {
  return { intent: 0, cursor: 0, meCursor: 0, ping: 0, emote: 0, pace: 0, press: 0 };
}

/** A token bucket for each kind, at `limit(kind)` */
function bucketsOf(limit: (kind: CosmeticKind) => CosmeticLimit, now: number): Record<CosmeticKind, TokenBucket> {
  const buckets = {} as Record<CosmeticKind, TokenBucket>;
  for (const kind of COSMETIC_KINDS) {
    buckets[kind] = new TokenBucket(limit(kind), now);
  }
  return buckets;
}

/** The kinds that are an event (each one counts) rather than a state (only the latest counts) */
const EVENT_KINDS: ReadonlySet<CosmeticKind> = new Set(["ping", "emote", "press"]);

// #endregion

// #region Receiving

/**
 * The receiving side: validate each message and enforce the limits again, whatever the sender claims to do. A peer that
 * floods gets its messages dropped, never queued.
 */
export class CosmeticReceiver {
  public readonly stats: CosmeticStats = { accepted: emptyKindCounts(), malformed: 0, limited: emptyKindCounts() };
  private readonly buckets: Record<CosmeticKind, TokenBucket>;

  /**
   * @param scheduler - The clock
   * @param slack - How much more than the sender's limit to allow, so messages that the network bunched up are not lost
   * (default: one more at once and a quarter more sustained)
   */
  constructor(
    private readonly scheduler: Scheduler = systemScheduler,
    slack = { burst: 1, rate: 1.25 },
  ) {
    this.buckets = bucketsOf(kind => {
      const limit = COSMETIC_LIMITS[kind];
      return { perSecond: limit.perSecond * slack.rate, burst: limit.burst + slack.burst };
    }, scheduler.now());
  }

  /** @returns The message if it is well-formed and within its limit, else `null` (and the drop is counted) */
  public accept(value: unknown): CosmeticMessage | null {
    if (!isCosmeticMessage(value)) {
      this.stats.malformed++;
      return null;
    }
    if (!this.buckets[value.t].take(this.scheduler.now())) {
      this.stats.limited[value.t]++;
      return null;
    }
    this.stats.accepted[value.t]++;
    return value;
  }
}

// #endregion

// #region Sending

/**
 * The sending side: keeps to {@linkcode COSMETIC_LIMITS}. A state that changes often (an intent, a cursor, the pace) is
 * not dropped when over the limit but held and sent when the limit allows, so the partner ends on the latest one (a
 * `ready` badge is never lost); an event (a ping, an emote, a press) that is over the limit is refused.
 */
export class CosmeticSender {
  private readonly buckets: Record<CosmeticKind, TokenBucket>;
  /** The latest held message of a state kind, by kind and subject */
  private readonly held = new Map<string, CosmeticMessage>();
  private timer: unknown = null;
  private closed = false;

  constructor(
    private readonly sink: (message: CosmeticMessage) => void,
    private readonly scheduler: Scheduler = systemScheduler,
  ) {
    this.buckets = bucketsOf(kind => COSMETIC_LIMITS[kind], scheduler.now());
  }

  /**
   * Send a message, or hold it if it is a state and the limit is reached.
   * @returns Whether it was sent or is held; `false` if it was refused (a ping or an emote over the limit, or a bad message)
   */
  public send(message: CosmeticMessage): boolean {
    if (this.closed || !isCosmeticMessage(message)) {
      return false;
    }
    const now = this.scheduler.now();
    if (EVENT_KINDS.has(message.t)) {
      if (!this.buckets[message.t].take(now)) {
        return false;
      }
      this.sink(message);
      return true;
    }
    const subject = message.t === "intent" ? `intent:${message.pokemonId}` : message.t;
    if (this.held.size === 0 && this.buckets[message.t].take(now)) {
      this.sink(message);
      return true;
    }
    this.held.set(subject, message);
    this.armTimer();
    return true;
  }

  /** Drop what is held (the state it described is gone) */
  public clearHeld(): void {
    this.held.clear();
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  public close(): void {
    this.closed = true;
    this.clearHeld();
  }

  private armTimer(): void {
    if (this.timer !== null || this.held.size === 0) {
      return;
    }
    const now = this.scheduler.now();
    const wait = Math.max(5, ...[...this.held.values()].map(message => this.buckets[message.t].waitMs(now)));
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  private flush(): void {
    const now = this.scheduler.now();
    for (const [subject, message] of [...this.held]) {
      if (this.buckets[message.t].take(now)) {
        this.held.delete(subject);
        this.sink(message);
      }
    }
    this.armTimer();
  }
}

// #endregion
