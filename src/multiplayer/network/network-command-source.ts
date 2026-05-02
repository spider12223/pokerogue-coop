import type { CommandSource } from "#app/multiplayer/command-source";
import type { PlayerSlot } from "#app/multiplayer/input-role";
import type { CoopSession } from "#app/multiplayer/network/coop-session";
import type { CommandPhase } from "#phases/command-phase";

export const COOP_DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

export interface NetworkCommandSourceOptions {
  timeoutMs?: number;
  botFillJoiner?: boolean;
}

interface PendingRequest {
  requestId: string;
  phase: CommandPhase;
  timer: ReturnType<typeof setTimeout> | null;
}

export class NetworkCommandSource implements CommandSource {
  public readonly kind = "network" as const;

  private pending: PendingRequest | null = null;
  private readonly timeoutMs: number;
  private readonly botFillJoiner: boolean;

  constructor(
    public readonly playerSlot: PlayerSlot,
    private readonly session: CoopSession,
    opts: NetworkCommandSourceOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? COOP_DEFAULT_COMMAND_TIMEOUT_MS;
    this.botFillJoiner = opts.botFillJoiner ?? false;
  }

  requestCommand(_phase: CommandPhase): void {}

  cancelPending(): void {
    if (this.pending?.timer) {
      clearTimeout(this.pending.timer);
    }
    this.pending = null;
  }
}
