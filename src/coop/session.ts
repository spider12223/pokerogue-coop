/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { AccountSnapshot, CoopAccountSnapshot } from "#coop/account-snapshot";
import { type Checkpoint, CheckpointLog } from "#coop/checkpoint-log";
import type { SettingsOverlayPort } from "#coop/handshake";
import type { RewardView } from "#coop/legal";
import type { CoopLink } from "#coop/link";
import type { MeQuestion } from "#coop/me-choice";
import { defaultStarterOwners, OwnerMap } from "#coop/ownership";
import { PaceTracker } from "#coop/pace";
import { PhaseTrace } from "#coop/phase-trace";
import { type BuildIdentity, type DecisionKey, otherSeat, type Seat } from "#coop/protocol";
import {
  type MismatchInfo,
  type ReportPayload,
  ResyncBook,
  type ResyncMessage,
  type ResyncReason,
  type ResyncStopPayload,
} from "#coop/resync";
import { COOP_SAVE_VERSION, type CoopSaveBlock, checkSaveBlock } from "#coop/save-block";
import { type AfkTimers, DEFAULT_AFK_TIMERS } from "#coop/takeover";

/**
 * The co-op session of this client (DECISIONS D1-D5). It exists for exactly as long as a co-op run: `null` in solo
 * play, so every co-op branch in the game is `if (isCoop())` and solo play stays byte-identical.
 *
 * This module must stay free of game imports: simulation code (`battle.ts`, `pokemon.ts`, ...) imports it, so a
 * dependency back into the game would create a cycle.
 *
 * @module
 */

/** A stand-in for the account's identity until the lobby supplies the real one: the TID/SID pair is unique per account. */
export function accountIdOf(account: AccountSnapshot): string {
  return `${account.trainerId}:${account.secretId}`;
}

/**
 * Who picks on the reward screen with this index (D9): the host on screens `0, 2, 4, ...`, the guest on the others.
 * The index counts reward screens, not waves: every tenth wave has none.
 */
export function rewardPickerOf(rewardPickCount: number): Seat {
  return rewardPickCount % 2 === 0 ? "host" : "guest";
}

export interface CoopSessionInit {
  seat: Seat;
  /**
   * The host's run seed from `START` (D3). A session that starts in the lobby, before `START`, passes any placeholder
   * and sets the real one with {@linkcode CoopSession.setRunSeed}.
   */
  runSeed: string;
  build: BuildIdentity;
  /** The pinned-settings overlay this client applied in the handshake; removed when the session ends */
  overlay?: SettingsOverlayPort | null;
  /** Both accounts, frozen at run start (D4); can also be set later with {@linkcode CoopSession.setAccountSnapshot} */
  accountSnapshot?: CoopAccountSnapshot | null;
  /** Who the two players are; defaults to the TID/SID pair of each account in the snapshot */
  accountIds?: Record<Seat, string>;
  /** Who owns each starter, in party order (D7); defaults to three each, the host's first */
  starterOwners?: readonly Seat[];
}

/** How long this client waited for its partner's decisions, for the debug API and the latency report */
export interface WaitStats {
  /** Turns whose commands were synced */
  turns: number;
  /** Total time spent waiting for the partner's commands after the local ones were done, in ms */
  waitedMs: number;
  /** The longest single wait */
  maxWaitedMs: number;
  /** Waits that lasted no time at all: the partner's decisions were already there */
  instant: number;
  /** The wait of each turn, in ms (0 when the partner's commands were already there) */
  samples: number[];
}

export class CoopSession {
  public readonly seat: Seat;
  private seed: string;
  public readonly build: BuildIdentity;
  private overlay: SettingsOverlayPort | null;
  private snapshot: CoopAccountSnapshot | null;
  private readonly explicitAccountIds: Record<Seat, string> | null;
  /** Who owns which Pokémon (D7); a Pokémon that is not in it belongs to nobody (enemies) */
  public readonly ownership = new OwnerMap();
  /** Who owns each starter, in party order: the run is set up with it */
  private owners: readonly Seat[];
  /** Reward screens started so far (D9); lives in the save block */
  public rewardPickCount = 0;
  /** The step of the open reward screen: how many of its decisions were sequenced so far (D9); not saved */
  public rewardStep = 0;
  /** The reward screen that is open, as the legality check sees it (D24); `null` while none is */
  public rewardLegality: (() => RewardView) | null = null;
  /** The biomes the picker may choose from while the Map is open (D24); `null` while none is */
  public biomeChoices: readonly number[] | null = null;
  /** A trade was requested on the reward screen that is open or just closed (D11); the trade phase clears it. Not saved. */
  public tradeRequested = false;
  /** The trade phase for that request is queued (D11); not saved */
  public tradeQueued = false;
  /** Trades accepted so far (D11); lives in the save block */
  public trades = 0;
  /** The reward screen this client took over (D17): its player picks for the partner there. Not saved. */
  public rewardTakeover: number | null = null;
  /** The decisions that were made for a partner who did not answer, as `keyId` and who made them (D17); for the debug API */
  public readonly takeovers: { key: string; author: Seat }[] = [];
  /** When a waiting player is told the partner is slow, and may take over (D17); dev and test builds can change them */
  public afkTimers: AfkTimers = { ...DEFAULT_AFK_TIMERS };
  /** The state hashes this client has passed in the current epoch (D13, D18); the ones of the epochs before are in `checkpointHistory` */
  public readonly checkpoints = new CheckpointLog();
  /** The logs of the epochs before this one, oldest first */
  public readonly checkpointHistory: { epoch: number; entries: Checkpoint[] }[] = [];
  /** The latest wave-start save (D19): the host's is what a resync sends; the guest's is kept in memory only */
  public waveSave: { wave: number; epoch: number; json: string } | null = null;
  /** The reload this client must do at its next safe point (D13): the host's `RESYNC`, or the one the host issued */
  public pendingResync: ResyncMessage | null = null;
  /** The clients disagree and a reload is wanted (D13); forgotten when the epoch changes */
  public resyncWanted: { reason: "mismatch" | "desync"; wave: number; mismatch: MismatchInfo | null } | null = null;
  /** Guest: the request for a reload was sent */
  public resyncRequested = false;
  /** Host: the desyncs of each wave (D13) */
  public readonly resyncBook = new ResyncBook();
  /** The reloads of this run, oldest first (what the debug API and the report show) */
  public readonly resyncs: { epoch: number; reason: ResyncReason; wave: number }[] = [];
  /** A reload is under way (`CoopResyncPhase` is loading the save) */
  public reloading = false;
  /** A decision gate is waiting (D20): what runs here can be abandoned */
  public atGate = false;
  /**
   * Guest: the host chose to retry the wave after a wipe (D4a) and its `RESYNC` is on the way; the game over phase that waits
   * for it can be abandoned. Forgotten when the epoch changes.
   */
  public retryPending = false;
  /** The run was stopped (D13): the third desync of a wave. Nothing is decided any more. */
  public stopped: ResyncStopPayload | null = null;
  /** The checkpoints that differed when the run stopped */
  public stopMismatch: MismatchInfo | null = null;
  /** The partner's side of the report, after a stop (D13) */
  public partnerReport: ReportPayload | null = null;
  /** What every decision does first (D20): wait for the partner, or reload. Set by `installResync`. */
  public beforeDecision: (() => Promise<void>) | null = null;
  /** Called when two checkpoints of the same index differ (D13). Set by `installResync`. */
  public onMismatch: ((local: Checkpoint | null, remote: Checkpoint) => void) | null = null;
  /** After this many ms of waiting for a partner the player may end the session (D20); `null`: the default of a minute */
  public reconnectEndMs: number | null = null;
  /** This client's own account was saved in this run (D19), at a wave start: a fresh account has no saved ids until it is */
  public accountSaved = false;
  /** When the pieces of a rejoin and a reload happened, ms since the epoch (the debug API shows them) */
  public readonly timing: Record<string, number> = {};
  /** Called with each checkpoint as it is taken: this is how a client reports it to its partner */
  public onCheckpoint: ((checkpoint: Checkpoint) => void) | null = null;
  /** The phase trace (see `src/coop/phase-trace.ts`): what the desync report is made of */
  public readonly trace = new PhaseTrace();
  /** Where this client is in the text of the run, and where the host is (D27) */
  public readonly pace = new PaceTracker();
  /** The encounter decisions of the wave so far (D29): the `n` of the next `ME_CHOICE` key. Not saved. */
  public meStep = 0;
  /** Who makes the choices of the encounter that is open: the host, or the player who goes in a one-Pokémon one (D29) */
  public meChooser: Seat = "host";
  /** The choice an encounter asks right now, as the legality check of the answer sees it (D24, D29) */
  public meQuestion: MeQuestion | null = null;
  /** The lone wild enemy of the encounter battle that is on, made stronger, by `pokemon.id` (D29). Not saved. */
  public meLoneEnemy: number | null = null;
  /** While both players chose a Ball or a Run this turn: the Pokémon the host may pick from (D8, D24). Not saved. */
  public sidePick: number[] | null = null;
  /** The connection to the partner; `null` in a session without a network (tests of the rules) */
  public link: CoopLink | null = null;
  /** The decision keys the simulation is waiting for right now (the decision window, D2); for the debug API */
  public openWindow: readonly DecisionKey[] = [];
  /** The partner's checkpoints that arrived before this client reached them, by index */
  public readonly remoteCheckpoints = new Map<number, Checkpoint>();
  /** Why the clients can no longer be trusted to agree (a desync or a failed decision); `null` while all is well */
  public desyncMessage: string | null = null;
  /** The first checkpoint on which the two clients differ, if any (D13) */
  public checkpointMismatch: { local: Checkpoint | null; remote: Checkpoint } | null = null;
  public readonly waits: WaitStats = { turns: 0, waitedMs: 0, maxWaitedMs: 0, instant: 0, samples: [] };
  private ended = false;
  /** The timed events of the run (D33) */
  private events: string[] = [];
  /** The trainer types of the run's trainer battles so far (D34) */
  private trainers: number[] = [];

  constructor(init: CoopSessionInit) {
    this.seat = init.seat;
    this.seed = init.runSeed;
    this.build = init.build;
    this.overlay = init.overlay ?? null;
    this.snapshot = init.accountSnapshot ?? null;
    this.explicitAccountIds = init.accountIds ?? null;
    this.owners = init.starterOwners ?? defaultStarterOwners();
  }

  public get starterOwners(): readonly Seat[] {
    return this.owners;
  }

  /** `START` told who picked which starter: the run is set up with these owners. */
  public setStarterOwners(owners: readonly Seat[]): void {
    this.owners = owners;
  }

  /** The host's seed of the run (D3) */
  public get runSeed(): string {
    return this.seed;
  }

  /** The host's seed arrived with `START`: use it instead of the placeholder the lobby session started with. */
  public setRunSeed(seed: string): void {
    this.seed = seed;
  }

  /** The two accounts as of run start. @throws If none was set: the simulation must not fall back to live data */
  public get accountSnapshot(): CoopAccountSnapshot {
    if (this.snapshot === null) {
      throw new Error("The co-op session has no account snapshot");
    }
    return this.snapshot;
  }

  public setAccountSnapshot(snapshot: CoopAccountSnapshot): void {
    this.snapshot = snapshot;
  }

  /** The timed events of the run (D33): `START` brings them, a saved run keeps them. None until the run starts. */
  public get timedEvents(): readonly string[] {
    return this.events;
  }

  public setTimedEvents(names: readonly string[]): void {
    this.events = [...names];
  }

  /** The trainer types the run has met (D34): a biome's next trainer is another one while it has one */
  public get metTrainers(): readonly number[] {
    return this.trainers;
  }

  /** A wave's trainer battle was generated (D34) */
  public noteTrainer(type: number): void {
    if (!this.trainers.includes(type)) {
      this.trainers.push(type);
    }
  }

  /** A new run starts: it has met no trainer yet */
  public clearMetTrainers(): void {
    this.trainers = [];
  }

  public get accountIds(): Record<Seat, string> {
    if (this.explicitAccountIds !== null) {
      return this.explicitAccountIds;
    }
    const { host, guest } = this.accountSnapshot;
    return { host: accountIdOf(host), guest: accountIdOf(guest) };
  }

  /**
   * @returns The player whose account a Pokémon-level read uses (D4): its owner. What has no owner (an enemy) is read
   * as the host's, the world-level account. Use {@linkcode OwnerMap.require} where a missing owner is a bug.
   */
  public ownerOf(pokemonId: number): Seat {
    return this.ownership.get(pokemonId) ?? "host";
  }

  /**
   * A reward screen starts (D9).
   * @returns The screen's index (its `ref` in decision keys), and who picks on it
   */
  public beginRewardScreen(): { index: number; picker: Seat } {
    const index = this.rewardPickCount++;
    this.rewardStep = 0;
    return { index, picker: rewardPickerOf(index) };
  }

  /** @returns The picker of the most recent reward screen (the host before any): who decides the biome (D10) */
  public get lastRewardPicker(): Seat {
    return this.rewardPickCount === 0 ? "host" : rewardPickerOf(this.rewardPickCount - 1);
  }

  /**
   * @param partyIds - The `pokemon.id`s of the party: the owners of Pokémon that left it are not saved
   * @returns The `coop` block of a session save
   */
  public toSaveBlock(partyIds: Iterable<number>): CoopSaveBlock {
    const owners = new OwnerMap();
    for (const id of partyIds) {
      owners.set(id, this.ownership.require(id));
    }
    return {
      version: COOP_SAVE_VERSION,
      accountIds: { ...this.accountIds },
      owners: owners.toJSON(),
      rewardPickCount: this.rewardPickCount,
      trades: this.trades,
      accounts: this.accountSnapshot,
      events: [...this.events],
      trainers: [...this.trainers],
    };
  }

  /**
   * Take the state of a saved co-op run: the owner map, the reward counter and the account snapshots.
   * @throws {@linkcode CoopSaveRefusedError} If the block is damaged or belongs to two other accounts
   */
  public restoreFromSaveBlock(block: unknown): void {
    // The accounts of this session must be the saved pair (if it knows them yet)
    checkSaveBlock(block, { accountIds: this.knownAccountIds() });
    const saved = block as CoopSaveBlock;
    this.snapshot = saved.accounts;
    this.ownership.load(saved.owners);
    this.rewardPickCount = saved.rewardPickCount;
    this.trades = saved.trades;
    this.events = saved.events ?? [];
    this.trainers = saved.trainers ?? [];
  }

  /**
   * The run is reloaded under a new epoch (D18): the log of the old one is kept apart, and what belonged to the old world is
   * forgotten: its windows, the partner's checkpoints that were not compared yet, the mismatch that caused the reload.
   * @param oldEpoch - The epoch that ends
   */
  public beginEpoch(oldEpoch: number): void {
    if (this.checkpoints.entries.length > 0) {
      this.checkpointHistory.push({ epoch: oldEpoch, entries: [...this.checkpoints.entries] });
    }
    this.checkpoints.clear();
    this.remoteCheckpoints.clear();
    this.pace.reset();
    this.meStep = 0;
    this.meChooser = "host";
    this.meQuestion = null;
    this.meLoneEnemy = null;
    this.sidePick = null;
    this.checkpointMismatch = null;
    this.desyncMessage = null;
    this.openWindow = [];
    this.rewardStep = 0;
    this.rewardLegality = null;
    this.biomeChoices = null;
    this.tradeRequested = false;
    this.tradeQueued = false;
    this.rewardTakeover = null;
    this.pendingResync = null;
    this.resyncWanted = null;
    this.resyncRequested = false;
    this.retryPending = false;
  }

  /** @returns Who the two players are, or `null` while this session does not know yet (no ids and no snapshot) */
  public knownAccountIds(): Record<Seat, string> | null {
    return this.explicitAccountIds ?? (this.snapshot === null ? null : this.accountIds);
  }

  public get isHost(): boolean {
    return this.seat === "host";
  }

  public get partnerSeat(): Seat {
    return otherSeat(this.seat);
  }

  /** The display names of the two players, by seat (D1); the seat's own for a session without a network */
  public get names(): Record<Seat, string> {
    const mine = this.link?.name ?? "Host";
    const theirs = this.link?.theirName ?? "Guest";
    return this.seat === "host" ? { host: mine, guest: theirs } : { host: theirs, guest: mine };
  }

  /** What to call the partner in texts (D1); `"Your partner"` in a session without a network */
  public get partnerName(): string {
    return this.link?.partnerName ?? "Your partner";
  }

  public get hasEnded(): boolean {
    return this.ended;
  }

  /** End the session: the settings overlay comes off and this stops being the active session. Safe to call twice. */
  public end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.overlay?.remove();
    this.overlay = null;
    this.link?.close();
    this.link = null;
    if (activeSession === this) {
      activeSession = null;
    }
  }
}

let activeSession: CoopSession | null = null;

/** @returns The active co-op session, or `null` in solo play */
export function getCoopSession(): CoopSession | null {
  return activeSession;
}

/** @returns Whether this client is in a co-op run */
export function isCoop(): boolean {
  return activeSession !== null;
}

/**
 * @returns The active co-op session
 * @throws If there is none (a co-op-only code path was reached in solo play)
 */
export function requireCoopSession(): CoopSession {
  if (activeSession === null) {
    throw new Error("No co-op session is active");
  }
  return activeSession;
}

/**
 * Decide whether a saved session may be loaded now: a co-op save only inside a co-op session of the same two accounts,
 * a solo save only outside one.
 * @param block - The `coop` block of the save, if it has one
 * @throws {@linkcode CoopSaveRefusedError} If not; its message is for the player
 */
export function checkSessionSaveBlock(block: unknown): void {
  checkSaveBlock(block, activeSession === null ? null : { accountIds: activeSession.knownAccountIds() });
}

/**
 * Guard for the features DECISIONS D12 turns off in co-op v1 (eggs, the Global Trade System, ...): they must not run
 * there, because they draw from unseeded values or write to one account only.
 * @param what - The feature, for the error message
 * @throws If a co-op session is active
 */
export function assertNotCoop(what: string): void {
  if (activeSession !== null) {
    throw new Error(`${what} is not available in co-op (DECISIONS D12)`);
  }
}

/**
 * Make a new co-op session the active one.
 * @throws If a session is already active; end it first
 */
export function startCoopSession(init: CoopSessionInit): CoopSession {
  if (activeSession !== null) {
    throw new Error("A co-op session is already active");
  }
  activeSession = new CoopSession(init);
  return activeSession;
}

/** End the active co-op session, if any */
export function endCoopSession(): void {
  activeSession?.end();
}
