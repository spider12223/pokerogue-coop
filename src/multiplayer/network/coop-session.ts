import { COOP_PROTOCOL_VERSION, type Envelope } from "#app/multiplayer/network/messages";
import { generateRoomCode, isValidRoomCode, normalizeRoomCode } from "#app/multiplayer/network/room-code";
import { TrysteroTransport, type TrysteroTransportOptions } from "#app/multiplayer/network/transport";
import Phaser from "phaser";

export const COOP_APP_ID = "pokerogue-coop-v1";
export const COOP_JOIN_TIMEOUT_MS = 30_000;

export type CoopRole = "host" | "joiner";

export type CoopState =
  | { kind: "IDLE" }
  | { kind: "HOSTING"; code: string }
  | { kind: "JOINING"; code: string }
  | { kind: "CONNECTED"; code: string; role: CoopRole; peerId: string }
  | { kind: "ERROR"; reason: string; recoverable: boolean; lastCode?: string };

export type TransportFactory = (options: TrysteroTransportOptions) => TrysteroTransport;

const defaultTransportFactory: TransportFactory = options => new TrysteroTransport(options);

export interface CoopSessionOptions {
  transportFactory?: TransportFactory;
  joinTimeoutMs?: number;
  protocolVersion?: string;
}

export class CoopSession extends Phaser.Events.EventEmitter {
  public static readonly STATE_CHANGE = "state-change";

  private readonly transportFactory: TransportFactory;
  private readonly joinTimeoutMs: number;
  private readonly protocolVersion: string;

  private state: CoopState = { kind: "IDLE" };
  private transport: TrysteroTransport | null = null;
  private joinTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: CoopSessionOptions = {}) {
    super();
    this.transportFactory = opts.transportFactory ?? defaultTransportFactory;
    this.joinTimeoutMs = opts.joinTimeoutMs ?? COOP_JOIN_TIMEOUT_MS;
    this.protocolVersion = opts.protocolVersion ?? COOP_PROTOCOL_VERSION;
  }

  getState(): CoopState {
    return this.state;
  }

  async host(): Promise<string> {
    if (this.state.kind !== "IDLE") {
      throw new Error(`CoopSession: cannot host from state ${this.state.kind}`);
    }
    const code = generateRoomCode();
    this.openTransport(code, "host");
    this.setState({ kind: "HOSTING", code });
    return code;
  }

  async join(rawCode: string): Promise<void> {
    if (this.state.kind !== "IDLE") {
      throw new Error(`CoopSession: cannot join from state ${this.state.kind}`);
    }
    const code = normalizeRoomCode(rawCode);
    if (!isValidRoomCode(code)) {
      this.setState({ kind: "ERROR", reason: "Invalid room code", recoverable: true, lastCode: code });
      return;
    }
    try {
      this.openTransport(code, "joiner");
    } catch (err) {
      this.setState({
        kind: "ERROR",
        reason: `Failed to open transport: ${String(err)}`,
        recoverable: false,
        lastCode: code,
      });
      return;
    }
    this.setState({ kind: "JOINING", code });
    this.joinTimer = setTimeout(() => this.onJoinTimeout(code), this.joinTimeoutMs);
  }

  async cancel(): Promise<void> {
    if (this.state.kind !== "HOSTING" && this.state.kind !== "JOINING") {
      return;
    }
    await this.teardown();
    this.setState({ kind: "IDLE" });
  }

  async disconnect(): Promise<void> {
    if (this.state.kind !== "CONNECTED") {
      return;
    }
    if (this.transport?.isOpen()) {
      try {
        await this.transport.sendEnvelope({ type: "disconnect", reason: null });
      } catch {}
    }
    await this.teardown();
    this.setState({ kind: "IDLE" });
  }

  async retry(): Promise<void> {
    if (this.state.kind !== "ERROR" || !this.state.recoverable) {
      return;
    }
    const lastCode = this.state.lastCode;
    this.setState({ kind: "IDLE" });
    if (lastCode && isValidRoomCode(lastCode)) {
      await this.join(lastCode);
    }
  }

  dismiss(): void {
    if (this.state.kind !== "ERROR") {
      return;
    }
    this.setState({ kind: "IDLE" });
  }

  async destroy(): Promise<void> {
    await this.teardown();
    this.state = { kind: "IDLE" };
    this.removeAllListeners();
  }

  private openTransport(code: string, role: CoopRole): void {
    const transport = this.transportFactory({ appId: COOP_APP_ID, roomCode: code });
    transport.onPeerJoin(peerId => this.onPeerJoin(peerId, role));
    transport.onPeerLeave(peerId => this.onPeerLeave(peerId));
    transport.onEnvelope((envelope, peerId) => this.onEnvelope(envelope, peerId, role, code));
    transport.open();
    this.transport = transport;
  }

  private onPeerJoin(peerId: string, role: CoopRole): void {
    if (this.state.kind !== "HOSTING" && this.state.kind !== "JOINING") {
      return;
    }
    if (!this.transport?.isOpen()) {
      return;
    }
    void this.transport
      .sendEnvelope({ type: "hello", version: this.protocolVersion, role }, peerId)
      .catch(() => {});
  }

  private onPeerLeave(_peerId: string): void {
    if (this.state.kind === "CONNECTED") {
      void this.teardown().then(() => this.setState({ kind: "IDLE" }));
    }
  }

  private onEnvelope(envelope: Envelope, peerId: string, role: CoopRole, code: string): void {
    if (envelope.type === "hello") {
      if (envelope.version !== this.protocolVersion) {
        void this.teardown().then(() =>
          this.setState({
            kind: "ERROR",
            reason: `Protocol version mismatch (peer=${envelope.version}, local=${this.protocolVersion})`,
            recoverable: false,
          }),
        );
        return;
      }
      if (this.state.kind === "HOSTING" || this.state.kind === "JOINING") {
        this.clearJoinTimer();
        this.setState({ kind: "CONNECTED", code, role, peerId });
      }
      return;
    }
    if (envelope.type === "disconnect") {
      if (this.state.kind === "CONNECTED") {
        void this.teardown().then(() => this.setState({ kind: "IDLE" }));
      }
      return;
    }
  }

  private onJoinTimeout(code: string): void {
    this.joinTimer = null;
    if (this.state.kind !== "JOINING") {
      return;
    }
    void this.teardown().then(() =>
      this.setState({
        kind: "ERROR",
        reason: `No host found with code ${code}`,
        recoverable: true,
        lastCode: code,
      }),
    );
  }

  private clearJoinTimer(): void {
    if (this.joinTimer !== null) {
      clearTimeout(this.joinTimer);
      this.joinTimer = null;
    }
  }

  private async teardown(): Promise<void> {
    this.clearJoinTimer();
    const transport = this.transport;
    this.transport = null;
    if (transport) {
      await transport.close();
    }
  }

  private setState(next: CoopState): void {
    this.state = next;
    this.emit(CoopSession.STATE_CHANGE, next);
  }
}
