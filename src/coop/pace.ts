/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Pacing (DECISIONS D27): the host's screen is the clock of the run's text. Each client knows where it is in the text by a
 * position, and the guest closes a line by itself once the host is past it.
 *
 * A position is `[checkpoint, phase, prompt]`: the D13 checkpoints taken in this epoch, the phases started since the last
 * one, and the shared prompts closed in the current phase. Between two checkpoints both clients run the same phases
 * (lockstep), so the same position names the same line on both. It is never a key of the simulation: a position that is
 * off only changes when a line closes on the guest's screen.
 *
 * No game imports, so it runs in Node.
 *
 * @module
 */

/** Where a client is in the text of the run */
export type PacePosition = readonly [checkpoint: number, phase: number, prompt: number];

/** @returns Negative if `a` comes first, positive if `b` does, 0 if they are the same place */
export function comparePositions(a: PacePosition, b: PacePosition): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function samePosition(a: PacePosition, b: PacePosition): boolean {
  return comparePositions(a, b) === 0;
}

/**
 * The command menus: each player has their own, and how many of these phases a client runs is its player's doing (the
 * target selection of a move that has one, a cancel that opens the menu again). Their lines are not shared, and they are
 * not counted.
 */
const PRIVATE_PHASES: ReadonlySet<string> = new Set(["CommandPhase", "SelectTargetPhase"]);

/** A shared prompt that is open: the line at `at` waits for a press */
export interface PromptTicket {
  readonly id: number;
  readonly at: PacePosition;
}

/** A shared prompt as it was shown, for the tests that compare both screens */
export interface PromptRecord {
  readonly at: PacePosition;
  readonly text: string;
}

/** How many prompts {@linkcode PaceTracker.prompts} keeps */
const PROMPT_LOG_SIZE = 200;

/**
 * Where this client is in the text of the run, and (on the guest) where the host is. The game tells it what happens: a
 * phase starts, a checkpoint is taken, a prompt opens or closes, a player answers a question of their own.
 */
export class PaceTracker {
  private checkpoint = 0;
  private phase = 0;
  private prompt = 0;
  private phaseName = "";
  private nextTicket = 1;
  private open: PromptTicket | null = null;
  /** The questions of this player that are open (the decider's side of a decision): their lines are not shared */
  private readonly privateSpans = new Set<number>();
  private nextSpan = 1;
  /** The host's position as it last told it (guest only) */
  private leaderAt: PacePosition | null = null;
  /** The number of phases of each checkpoint's stretch in this epoch, for the tests that compare both seats */
  public readonly segments: number[] = [];
  /** The latest shared prompts, oldest first */
  public readonly prompts: PromptRecord[] = [];
  /** Called when the position changes (the host sends it) */
  public onMove: (() => void) | null = null;

  public get position(): PacePosition {
    return [this.checkpoint, this.phase, this.prompt];
  }

  /** The host's position, as far as the guest knows it */
  public get leader(): PacePosition | null {
    return this.leaderAt;
  }

  /** The shared prompt that is open, if any */
  public get openPrompt(): PromptTicket | null {
    return this.open;
  }

  /**
   * Whether the lines shown now are this player's own: a question of theirs is open, or it is a command menu. Before the
   * first checkpoint of an epoch (the lobby, a reload) the clients run different phases, so nothing is shared yet.
   */
  public get isPrivate(): boolean {
    return this.privateSpans.size > 0 || PRIVATE_PHASES.has(this.phaseName) || this.checkpoint === 0;
  }

  public phaseStarted(name: string): void {
    this.phaseName = name;
    if (PRIVATE_PHASES.has(name)) {
      return;
    }
    this.phase++;
    this.prompt = 0;
    this.onMove?.();
  }

  public checkpointTaken(): void {
    this.segments.push(this.phase);
    this.checkpoint++;
    this.phase = 0;
    this.prompt = 0;
    this.onMove?.();
  }

  /**
   * A question of this player opens (the decider's side of a co-op decision): the lines it shows are not shared.
   * @returns What closes it again; calling it twice, or after {@linkcode reset}, does nothing
   */
  public enterPrivate(): () => void {
    const span = this.nextSpan++;
    this.privateSpans.add(span);
    return () => {
      this.privateSpans.delete(span);
    };
  }

  /**
   * A line waits for a press.
   * @param text - What it says, for the log
   * @returns Its ticket if it is shared (the guest follows it, a press of either player closes it), else `null`
   */
  public promptOpened(text: string): PromptTicket | null {
    if (this.isPrivate) {
      return null;
    }
    this.open = { id: this.nextTicket++, at: this.position };
    this.prompts.push({ at: this.open.at, text });
    if (this.prompts.length > PROMPT_LOG_SIZE) {
      this.prompts.shift();
    }
    return this.open;
  }

  /** A shared line closed, by a press or because the host was past it */
  public promptClosed(ticket: PromptTicket): void {
    if (this.open?.id === ticket.id) {
      this.open = null;
    }
    if (samePosition(ticket.at, this.position)) {
      this.prompt++;
      this.onMove?.();
    }
  }

  /** Guest: the host said where it is. Positions only go forward within an epoch. */
  public setLeader(at: PacePosition): void {
    if (this.leaderAt === null || comparePositions(at, this.leaderAt) > 0) {
      this.leaderAt = at;
    }
  }

  /** Guest: whether the host is past `at` */
  public isPast(at: PacePosition): boolean {
    return this.leaderAt !== null && this.leaderAt[0] > 0 && comparePositions(this.leaderAt, at) > 0;
  }

  /** Guest: the host is past what this screen shows, and what it shows is not this player's own */
  public get behind(): boolean {
    return !this.isPrivate && this.isPast(this.position);
  }

  /**
   * Host: whether a press of the guest on the line at `at` is a press on the line this screen waits on (it then closes
   * it). A press for any other line is too late or too early, and does nothing.
   */
  public pressFits(at: PacePosition): boolean {
    return this.open !== null && !this.isPrivate && samePosition(this.open.at, at) && samePosition(at, this.position);
  }

  /** A new epoch (D18): everything starts again from the reload, and what the host said belongs to the old world */
  public reset(): void {
    this.checkpoint = 0;
    this.phase = 0;
    this.prompt = 0;
    this.phaseName = "";
    this.open = null;
    this.privateSpans.clear();
    this.leaderAt = null;
    this.segments.length = 0;
  }
}
