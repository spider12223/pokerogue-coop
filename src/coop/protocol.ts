/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Co-op wire protocol: envelope, decision keys and the HELLO handshake payload (DECISIONS D1, D2).
 *
 * Independent of `globalScene` and of Phaser: everything in `src/coop/protocol.ts`, `transport/` and `sequencer.ts`
 * must run in plain Node so the tests can drive both clients in one process.
 *
 * @module
 */

import {
  type AccountSnapshot,
  type CoopAccountSnapshot,
  isAccountSnapshot,
  isCoopAccountSnapshot,
} from "#coop/account-snapshot";

/** Bumped whenever a message shape changes incompatibly. Peers with different versions refuse to connect. */
export const COOP_PROTOCOL_VERSION = 4;

/** The two players. The host is the sequencer (D2). */
export type Seat = "host" | "guest";

/** Both seats, host first */
export const SEATS: readonly Seat[] = ["host", "guest"];

export function otherSeat(seat: Seat): Seat {
  return seat === "host" ? "guest" : "host";
}

/**
 * Every state-changing decision that goes through the sequencer (D2).
 * Prompts are decisions too: nothing that changes the simulation may bypass the sequencer.
 */
export const DECISION_KINDS = [
  "TURN_COMMANDS",
  "FAINT_SWITCH",
  "PIVOT_SWITCH",
  "SIDE_ACTION",
  "REWARD_PICK",
  "REWARD_TARGET",
  "SHOP_BUY",
  "REROLL",
  "REWARD_LOCK",
  "REWARD_TRANSFER",
  "LEARN_MOVE",
  "EVOLUTION_CANCEL",
  "BIOME",
  "CATCH_RELEASE",
  "TRADE_REQUEST",
  "TRADE_PROPOSE",
  "TRADE_ACCEPT",
  "TRADE_DECLINE",
  "TRADE_CANCEL",
  "TRADE_DONE",
  "PARTY_EDIT",
  "ME_CHOICE",
  "SIDE_PICK",
  "RETRY",
] as const;

export type DecisionKind = (typeof DECISION_KINDS)[number];

/** `ref` of decisions that do not concern a slot or a Pokémon. */
export const NO_REF = -1;

/**
 * The asserted identity of a decision. Both clients derive it from their own simulation; a mismatch with the
 * sequenced decision is a desync (D2).
 *
 * Never build `wave`/`turn` from a local counter: `wave` is `currentBattle.waveIndex` and `turn` is
 * `currentBattle.turn` *at the moment the decision is opened*, and the key is only ever compared, never used to
 * order anything (ordering is `seq`).
 */
export interface DecisionKey {
  wave: number;
  /** `battle.turn` for `TURN_COMMANDS` and `FAINT_SWITCH`; `0` for every prompt decision (D2) */
  turn: number;
  kind: DecisionKind;
  /**
   * What the decision is about, unique within the wave: a field slot (0 or 1) or a `pokemon.id`, or a composite string
   * such as `"${pokemonId}:${moveId}"` (learn-move) or `"${rewardPickCount}"` (reward screen), see D2.
   * {@linkcode NO_REF} if it is about nothing in particular.
   */
  ref: DecisionRef;
}

export type DecisionRef = number | string;

export function keyId(key: DecisionKey): string {
  // A string ref is quoted, so `"1"` and `1` are different keys
  const ref = typeof key.ref === "string" ? JSON.stringify(key.ref) : key.ref;
  return `${key.wave}:${key.turn}:${key.kind}:${ref}`;
}

export function keysEqual(a: DecisionKey, b: DecisionKey): boolean {
  return a.wave === b.wave && a.turn === b.turn && a.kind === b.kind && a.ref === b.ref;
}

export function isDecisionKey(value: unknown): value is DecisionKey {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const key = value as Record<string, unknown>;
  return (
    Number.isInteger(key["wave"])
    && Number.isInteger(key["turn"])
    && (Number.isInteger(key["ref"]) || (typeof key["ref"] === "string" && key["ref"].length > 0))
    && typeof key["kind"] === "string"
    && (DECISION_KINDS as readonly string[]).includes(key["kind"])
  );
}

/**
 * Message kinds on the wire.
 * - `HELLO` (host), `HELLO_ACK` (guest), `HELLO_OK` (host), `REFUSE` (either): the asymmetric handshake (D1)
 * - `START`: host to guest, carries the run seed, the starters of both seats and both account snapshots (D3, D4)
 * - `LOBBY`: either way, before the run: the starter select (live picks, ready), see {@linkcode LobbyMessage}
 * - `CHECKPOINT`: either way, a state-hash checkpoint the sender passed (D13), see {@linkcode CheckpointMessage}
 * - `PROPOSE`: guest to host, a decision the guest wants sequenced
 * - `SEQUENCED`: host to guest, a decision with its `seq`; the host applies it locally at the same moment
 * - `REJECT`: host to guest, a `PROPOSE` that was not sequenced
 * - `COSMETIC`: either way, an unsequenced message that only changes what the partner sees (D16); it is sent without
 *   numbering or resend, so it may be lost
 * - `RESYNC_REQUEST`: guest to host, the clients disagree and the guest asks for a reload (D13)
 * - `RESYNC`: host to guest, sequenced (it takes a `seq`) but without a key: both clients reload the wave start in its save
 *   under its epoch (D13, D18), or stop (the third desync of a wave)
 * - `REPORT`: either way, after a stop: this client's phase trace and checkpoints for the report (D13)
 * - `BYE`: orderly leave
 */
export const MESSAGE_KINDS = [
  "HELLO",
  "HELLO_ACK",
  "HELLO_OK",
  "REFUSE",
  "START",
  "LOBBY",
  "CHECKPOINT",
  "PROPOSE",
  "SEQUENCED",
  "REJECT",
  "COSMETIC",
  "RESYNC_REQUEST",
  "RESYNC",
  "REPORT",
  "BYE",
] as const;

export type MessageKind = (typeof MESSAGE_KINDS)[number];

/**
 * The message envelope.
 * - `seq`: only on `SEQUENCED`; assigned by the host, strictly increasing from 1 (or `firstSeq`)
 * - `key`: the decision key for `PROPOSE`/`SEQUENCED`/`REJECT`, `null` otherwise
 * - `author`: the player that made the decision (for `SEQUENCED`, the original author, relayed by the host) or
 *   that sent the message
 * - `takeover`: on `PROPOSE` and `SEQUENCED`: the author decided for a partner who did not answer (D17)
 * - `epoch`: the epoch of the sender (D18); a message without one is epoch 0
 */
export interface Envelope<P = unknown> {
  seq?: number;
  key: DecisionKey | null;
  author: Seat;
  kind: MessageKind;
  payload: P;
  takeover?: true;
  epoch?: number;
}

export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const env = value as Record<string, unknown>;
  if (env["author"] !== "host" && env["author"] !== "guest") {
    return false;
  }
  if (typeof env["kind"] !== "string" || !(MESSAGE_KINDS as readonly string[]).includes(env["kind"])) {
    return false;
  }
  if (env["key"] !== null && !isDecisionKey(env["key"])) {
    return false;
  }
  if (env["seq"] !== undefined && !(Number.isInteger(env["seq"]) && (env["seq"] as number) >= 1)) {
    return false;
  }
  if (env["takeover"] !== undefined && env["takeover"] !== true) {
    return false;
  }
  if (env["epoch"] !== undefined && !(Number.isInteger(env["epoch"]) && (env["epoch"] as number) >= 0)) {
    return false;
  }
  if (env["kind"] === "SEQUENCED" && (env["seq"] === undefined || env["key"] === null)) {
    return false;
  }
  // a RESYNC takes a seq (D18) but has no key
  if (env["kind"] === "RESYNC" && (env["seq"] === undefined || env["key"] !== null)) {
    return false;
  }
  if ((env["kind"] === "PROPOSE" || env["kind"] === "REJECT") && env["key"] === null) {
    return false;
  }
  return true;
}

// #region HELLO (D1)

/** Settings that D5 pins to the host's values. Plain values only: they are compared and hashed. */
export type PinnedSettings = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Which build a client runs. Both clients must be identical on every field (D1):
 * - `protocolVersion`: {@linkcode COOP_PROTOCOL_VERSION}
 * - `gitSha` and `dirtyHash`: the commit, plus a hash of `git diff HEAD` at build time (`"clean"` if there was none)
 * - `buildMode`: Vite mode plus `VITE_BYPASS_LOGIN`, e.g. `"development+bypass"`
 * - `overridesHash`: {@linkcode hashCanonical} of `activeOverrides`, which must equal the defaults
 */
export interface BuildIdentity {
  protocolVersion: number;
  gitSha: string;
  dirtyHash: string;
  buildMode: string;
  overridesHash: string;
}

/**
 * The asymmetric handshake (D1):
 * 1. host -> guest `HELLO` ({@linkcode HelloPayload}: the host's build and the settings D5 pins)
 * 2. the guest verifies the build and applies the pinned settings as an in-memory overlay (never saved)
 * 3. guest -> host `HELLO_ACK` ({@linkcode HelloAckPayload}); the host verifies it, then answers `HELLO_OK`
 * Either side answers a mismatch with `REFUSE`.
 */
export interface HelloPayload {
  build: BuildIdentity;
  pinnedSettings: PinnedSettings;
  /** The host's display name (D1): cosmetic */
  name: string;
  /** `resume`: the host continues a saved run, so the guest waits for its save instead of the lobby (D21) */
  mode: "new" | "resume";
}

export interface HelloAckPayload {
  build: BuildIdentity;
  /** {@linkcode hashCanonical} of the pinned settings as the guest reads them back after applying the overlay */
  effectiveSettingsHash: string;
  /** The guest's display name (D1): cosmetic */
  name: string;
  /** `"trainerId:secretId"` of the guest's account: a resumed run takes only the guest it was saved with (D21) */
  accountId: string;
}

/** The longest display name */
export const MAX_NAME_LENGTH = 16;
/** The name of a player who set none */
export const DEFAULT_NAME = "Player";

/**
 * Make a display name safe to show (D1): control characters out, whitespace collapsed, at most
 * {@linkcode MAX_NAME_LENGTH} characters.
 * @returns The name, or {@linkcode DEFAULT_NAME} if nothing printable is left
 */
export function cleanName(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_NAME;
  }
  const cleaned = value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, MAX_NAME_LENGTH).trim() || DEFAULT_NAME;
}

/** @returns How to call the partner: their name, or with " (2)" if both players chose the same one */
export function partnerDisplayName(mine: string, theirs: string): string {
  return theirs === mine ? `${theirs} (2)` : theirs;
}

export interface HelloMismatch {
  /** `protocolVersion`, `gitSha`, `dirtyHash`, `buildMode`, `overridesHash` or `effectiveSettingsHash` */
  field: string;
  local: unknown;
  remote: unknown;
}

const BUILD_FIELDS = ["protocolVersion", "gitSha", "dirtyHash", "buildMode", "overridesHash"] as const;

export function isBuildIdentity(value: unknown): value is BuildIdentity {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const build = value as Record<string, unknown>;
  return (
    typeof build["protocolVersion"] === "number"
    && typeof build["gitSha"] === "string"
    && typeof build["dirtyHash"] === "string"
    && typeof build["buildMode"] === "string"
    && typeof build["overridesHash"] === "string"
  );
}

export function isHelloPayload(value: unknown): value is HelloPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const hello = value as Record<string, unknown>;
  const settings = hello["pinnedSettings"];
  return (
    isBuildIdentity(hello["build"])
    && typeof settings === "object"
    && settings !== null
    && !Array.isArray(settings)
    && typeof hello["name"] === "string"
    && (hello["mode"] === "new" || hello["mode"] === "resume")
  );
}

export function isHelloAckPayload(value: unknown): value is HelloAckPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const ack = value as Record<string, unknown>;
  return (
    isBuildIdentity(ack["build"])
    && typeof ack["effectiveSettingsHash"] === "string"
    && typeof ack["name"] === "string"
    && typeof ack["accountId"] === "string"
  );
}

/** @returns Every build field on which the two builds differ; empty if the clients run the same build */
export function compareBuild(local: BuildIdentity, remote: BuildIdentity): HelloMismatch[] {
  const mismatches: HelloMismatch[] = [];
  for (const field of BUILD_FIELDS) {
    if (local[field] !== remote[field]) {
      mismatches.push({ field, local: local[field], remote: remote[field] });
    }
  }
  return mismatches;
}

// #endregion

// #region START and the lobby (D3, D4)

/**
 * One starter as the starter select produced it. Plain JSON: it mirrors `Starter` in `@types/save-data`, which this module
 * cannot import. The owner generated all of it from their own account (IVs, nature, shininess, ...), so both clients
 * create the same Pokémon from it.
 */
export interface CoopStarter {
  speciesId: number;
  shiny: boolean;
  variant: number;
  formIndex: number;
  female?: boolean | undefined;
  abilityIndex: number;
  passive: boolean;
  nature: number;
  moveset?: number[] | undefined;
  pokerus: boolean;
  nickname?: string | undefined;
  teraType?: number | undefined;
  ivs: number[];
}

export function isCoopStarter(value: unknown): value is CoopStarter {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const starter = value as Record<string, unknown>;
  return (
    Number.isInteger(starter["speciesId"])
    && typeof starter["shiny"] === "boolean"
    && Number.isInteger(starter["variant"])
    && Number.isInteger(starter["formIndex"])
    && (starter["female"] === undefined || typeof starter["female"] === "boolean")
    && Number.isInteger(starter["abilityIndex"])
    && typeof starter["passive"] === "boolean"
    && Number.isInteger(starter["nature"])
    && (starter["moveset"] === undefined
      || (Array.isArray(starter["moveset"]) && starter["moveset"].every(move => Number.isInteger(move))))
    && typeof starter["pokerus"] === "boolean"
    && (starter["nickname"] === undefined || typeof starter["nickname"] === "string")
    && (starter["teraType"] === undefined || Number.isInteger(starter["teraType"]))
    && Array.isArray(starter["ivs"])
    && starter["ivs"].every(iv => Number.isInteger(iv))
  );
}

/** How many starters a seat brings (D7: an equal share of a party of six). */
export const STARTERS_PER_SEAT_MAX = 3;

/**
 * `START`, host to guest: everything both clients need to build the same run (D3, D4).
 * - `runSeed`: host-generated; both clients assign it to `globalScene.seed`
 * - `starters`: each seat's starters, in the order the owner picked them
 * - `snapshots`: both accounts as of now (D4); the sim never reads live `gameData` in co-op
 */
export interface StartPayload {
  runSeed: string;
  starters: Record<Seat, CoopStarter[]>;
  snapshots: CoopAccountSnapshot;
}

export function isStartPayload(value: unknown): value is StartPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const start = value as Record<string, unknown>;
  const starters = start["starters"] as Record<string, unknown> | null;
  return (
    typeof start["runSeed"] === "string"
    && start["runSeed"].length > 0
    && typeof starters === "object"
    && starters !== null
    && SEATS.every(seat => {
      const list = starters[seat];
      return (
        Array.isArray(list) && list.length > 0 && list.length <= STARTERS_PER_SEAT_MAX && list.every(isCoopStarter)
      );
    })
    && isCoopAccountSnapshot(start["snapshots"])
  );
}

/**
 * `LOBBY` payloads: the co-op starter select, before the run exists.
 * - `picks`: the sender's current party, tentatively (the partner shows it faded); `cost` is what it costs of the shared
 *   point budget
 * - `ready`: the sender confirmed these starters, with the account the run will use
 * - `unready`: the sender took the confirmation back
 * - `reset`: host to guest, both parties were confirmed but together cost more than the shared budget: nobody is ready
 */
export type LobbyMessage =
  | { t: "picks"; picks: CoopStarter[]; cost: number }
  | { t: "ready"; starters: CoopStarter[]; cost: number; snapshot: AccountSnapshot }
  | { t: "unready" }
  | { t: "reset" };

export function isLobbyMessage(value: unknown): value is LobbyMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value as Record<string, unknown>;
  const isList = (list: unknown): boolean =>
    Array.isArray(list) && list.length <= STARTERS_PER_SEAT_MAX && list.every(isCoopStarter);
  switch (message["t"]) {
    case "picks":
      return isList(message["picks"]) && typeof message["cost"] === "number";
    case "ready":
      return (
        isList(message["starters"]) && typeof message["cost"] === "number" && isAccountSnapshot(message["snapshot"])
      );
    case "unready":
    case "reset":
      return true;
    default:
      return false;
  }
}

/** `CHECKPOINT` payload: a state-hash checkpoint the sender passed (D13). Compared with the receiver's own. */
export interface CheckpointMessage {
  index: number;
  kind: string;
  wave: number;
  turn: number;
  phaseName: string;
  hash: string;
}

export function isCheckpointMessage(value: unknown): value is CheckpointMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const checkpoint = value as Record<string, unknown>;
  return (
    Number.isInteger(checkpoint["index"])
    && typeof checkpoint["kind"] === "string"
    && Number.isInteger(checkpoint["wave"])
    && Number.isInteger(checkpoint["turn"])
    && typeof checkpoint["phaseName"] === "string"
    && typeof checkpoint["hash"] === "string"
  );
}

// #endregion

// #region Canonical JSON and hashing

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of [...Object.keys(record)].sort()) {
      out[key] = sortKeys(record[key]);
    }
    return out;
  }
  return value;
}

/** JSON with object keys sorted recursively, so equal data always serializes identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * A fast non-cryptographic 53-bit hash (cyrb53) of the canonical JSON of `value`, as 14 hex digits.
 * For comparing states between two trusted clients (D1 overrides hash, D13 state hash), not for security.
 */
export function hashCanonical(value: unknown): string {
  const text = canonicalJson(value);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value53 = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return value53.toString(16).padStart(14, "0");
}

// #endregion
