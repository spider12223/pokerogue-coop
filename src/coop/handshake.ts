/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  type BuildIdentity,
  type CoopRunMode,
  cleanName,
  compareBuild,
  type HelloAckPayload,
  type HelloMismatch,
  type HelloPayload,
  hashCanonical,
  isHelloAckPayload,
  isHelloPayload,
  type PinnedSettings,
} from "#coop/protocol";
import type { MessageTransport, Scheduler, Unsubscribe } from "#coop/transport/transport";
import { systemScheduler } from "#coop/transport/transport";

/**
 * The asymmetric handshake (DECISIONS D1):
 *
 * 1. the host sends `HELLO {build, pinnedSettings, name, mode}`;
 * 2. the guest verifies the build, then applies the host's pinned settings as an in-memory overlay (never saved);
 * 3. the guest replies `HELLO_ACK {build, effectiveSettingsHash, name, accountId}`; the host verifies it (and, in a resumed
 *    run, that the guest is the account the run was saved with, D21) and answers `HELLO_OK`;
 * 4. when the co-op session ends, the overlay is removed (the caller's job; on a failed handshake it is removed here).
 *
 * Wire both sides before the first message can arrive: the transport keeps messages until the first listener
 * subscribes, and the sequencer ignores handshake kinds, so both may listen on the same transport.
 *
 * @module
 */

export type RefuseReason = "mismatch" | "refused" | "malformed" | "timeout";

export type HostHandshakeResult =
  | {
      ok: true;
      remote: BuildIdentity;
      /** The guest's display name, cleaned */
      name: string;
      /** The guest's `"trainerId:secretId"` */
      accountId: string;
    }
  /**
   * - `mismatch`: the guest's `HELLO_ACK` differs from what the host expects (build or effective settings); `REFUSE` sent
   * - `refused`: the guest refused (`REFUSE` received), `mismatches` as it reported them
   * - `malformed`: the guest's answer was not a `HELLO_ACK` payload
   * - `timeout`: no answer in time
   */
  | { ok: false; reason: RefuseReason; mismatches: HelloMismatch[] };

export type GuestHandshakeResult =
  | { ok: true; hello: HelloPayload; effectiveSettingsHash: string }
  | { ok: false; reason: RefuseReason; mismatches: HelloMismatch[] };

/** What the guest does with the host's pinned settings. */
export interface SettingsOverlayPort {
  /**
   * Apply the pinned settings in memory and return the hash of the pinned settings as read back afterwards
   * ({@linkcode hashCanonical} of the effective values).
   */
  apply(pinned: PinnedSettings): string;
  /** Take the overlay off again. Called on a failed handshake; the caller calls it at session end otherwise. */
  remove(): void;
}

export interface HandshakeOptions {
  /** This client's display name (D1); default "Player" */
  name?: string;
  /** Guest: this player's `"trainerId:secretId"`, which a resumed run checks (D21); default empty */
  accountId?: string;
  /** Give up after this long. Default 15 s. */
  timeoutMs?: number;
  scheduler?: Scheduler;
}

export interface HostHandshakeOptions extends HandshakeOptions {
  /**
   * The hash the guest must report as its effective pinned settings.
   * Default: the hash of `pinnedSettings` as sent; pass the hash of the host's own read-back values if they can differ.
   */
  expectedEffectiveSettingsHash?: string;
  /** `resume`: this host continues a saved run (D21); the guest is told. Default `new`. */
  mode?: "new" | "resume";
  /** The kind of run (D39); the guest is told. Default `classic`. */
  runMode?: CoopRunMode;
  /** The guest account the run was saved with (D21): another one is refused, with `accountId` as the field that differs */
  expectedGuestAccountId?: string;
}

/**
 * The host side. Sends `HELLO` and waits for the guest's `HELLO_ACK`.
 */
export function hostHandshake(
  transport: MessageTransport,
  build: BuildIdentity,
  pinnedSettings: PinnedSettings,
  options: HostHandshakeOptions = {},
): Promise<HostHandshakeResult> {
  const scheduler = options.scheduler ?? systemScheduler;
  const expectedHash = options.expectedEffectiveSettingsHash ?? hashCanonical(pinnedSettings);
  return new Promise<HostHandshakeResult>(resolve => {
    let done = false;
    let unsubscribe: Unsubscribe | undefined;

    const finish = (result: HostHandshakeResult): void => {
      if (done) {
        return;
      }
      done = true;
      unsubscribe?.();
      scheduler.clearTimeout(timer);
      resolve(result);
    };
    const refuse = (reason: "mismatch" | "malformed", mismatches: HelloMismatch[]): void => {
      transport.send({ key: null, author: "host", kind: "REFUSE", payload: { mismatches } });
      finish({ ok: false, reason, mismatches });
    };

    const timer = scheduler.setTimeout(
      () => finish({ ok: false, reason: "timeout", mismatches: [] }),
      options.timeoutMs ?? 15_000,
    );

    unsubscribe = transport.onMessage(message => {
      if (done) {
        return;
      }
      switch (message.kind) {
        case "HELLO_ACK": {
          if (!isHelloAckPayload(message.payload)) {
            refuse("malformed", []);
            return;
          }
          const ack: HelloAckPayload = message.payload;
          const mismatches = compareBuild(build, ack.build);
          if (ack.effectiveSettingsHash !== expectedHash) {
            mismatches.push({ field: "effectiveSettingsHash", local: expectedHash, remote: ack.effectiveSettingsHash });
          }
          if (options.expectedGuestAccountId !== undefined && ack.accountId !== options.expectedGuestAccountId) {
            mismatches.push({ field: "accountId", local: options.expectedGuestAccountId, remote: ack.accountId });
          }
          if (mismatches.length > 0) {
            refuse("mismatch", mismatches);
            return;
          }
          transport.send({ key: null, author: "host", kind: "HELLO_OK", payload: null });
          finish({ ok: true, remote: ack.build, name: cleanName(ack.name), accountId: ack.accountId });
          break;
        }
        case "REFUSE":
          finish({ ok: false, reason: "refused", mismatches: readMismatches(message.payload) });
          break;
        default:
          break;
      }
    });
    if (done) {
      unsubscribe();
      return;
    }
    const hello: HelloPayload = {
      build,
      pinnedSettings,
      name: cleanName(options.name),
      mode: options.mode ?? "new",
      runMode: options.runMode ?? "classic",
    };
    transport.send({ key: null, author: "host", kind: "HELLO", payload: hello });
  });
}

/**
 * The guest side. Waits for the host's `HELLO`, verifies the build, applies the overlay and acknowledges.
 */
export function guestHandshake(
  transport: MessageTransport,
  build: BuildIdentity,
  overlay: SettingsOverlayPort,
  options: HandshakeOptions = {},
): Promise<GuestHandshakeResult> {
  const scheduler = options.scheduler ?? systemScheduler;
  return new Promise<GuestHandshakeResult>(resolve => {
    let done = false;
    let overlayApplied = false;
    let hello: HelloPayload | null = null;
    let effectiveHash = "";
    let unsubscribe: Unsubscribe | undefined;

    const finish = (result: GuestHandshakeResult): void => {
      if (done) {
        return;
      }
      done = true;
      unsubscribe?.();
      scheduler.clearTimeout(timer);
      if (!result.ok && overlayApplied) {
        overlay.remove();
      }
      resolve(result);
    };
    const refuse = (reason: "mismatch" | "malformed", mismatches: HelloMismatch[]): void => {
      transport.send({ key: null, author: "guest", kind: "REFUSE", payload: { mismatches } });
      finish({ ok: false, reason, mismatches });
    };

    const timer = scheduler.setTimeout(
      () => finish({ ok: false, reason: "timeout", mismatches: [] }),
      options.timeoutMs ?? 15_000,
    );

    unsubscribe = transport.onMessage(message => {
      if (done) {
        return;
      }
      switch (message.kind) {
        case "HELLO": {
          if (hello !== null) {
            return; // a second HELLO changes nothing
          }
          if (!isHelloPayload(message.payload)) {
            refuse("malformed", []);
            return;
          }
          const received: HelloPayload = message.payload;
          const mismatches = compareBuild(build, received.build);
          if (mismatches.length > 0) {
            refuse("mismatch", mismatches);
            return;
          }
          try {
            effectiveHash = overlay.apply(received.pinnedSettings);
            overlayApplied = true;
          } catch {
            // The overlay refused the pinned settings (unknown key, bad value)
            overlay.remove();
            refuse("malformed", []);
            return;
          }
          hello = received;
          const ack: HelloAckPayload = {
            build,
            effectiveSettingsHash: effectiveHash,
            name: cleanName(options.name),
            accountId: options.accountId ?? "",
          };
          transport.send({ key: null, author: "guest", kind: "HELLO_ACK", payload: ack });
          break;
        }
        case "HELLO_OK":
          if (hello !== null) {
            finish({ ok: true, hello, effectiveSettingsHash: effectiveHash });
          }
          break;
        case "REFUSE":
          finish({ ok: false, reason: "refused", mismatches: readMismatches(message.payload) });
          break;
        default:
          break;
      }
    });
    if (done) {
      unsubscribe();
    }
  });
}

function readMismatches(payload: unknown): HelloMismatch[] {
  const mismatches = (payload as { mismatches?: unknown } | null)?.mismatches;
  return Array.isArray(mismatches) ? (mismatches as HelloMismatch[]) : [];
}
