/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Envelope } from "#coop/protocol";

export type Unsubscribe = () => void;

export interface CloseInfo {
  code?: number;
  reason?: string;
}

/**
 * A duplex channel of text frames that may lose, duplicate or reorder them: a WebSocket through the relay
 * ({@linkcode RelayWsTransport}) or an in-process pair ({@linkcode createLoopbackPair}).
 */
export interface RawTransport {
  readonly isOpen: boolean;
  send(frame: string): void;
  onFrame(listener: (frame: string) => void): Unsubscribe;
  onClose(listener: (info: CloseInfo) => void): Unsubscribe;
  close(code?: number, reason?: string): void;
}

/**
 * An ordered, exactly-once channel of envelopes: what the sequencer talks to.
 * {@linkcode ReliableTransport} builds one on top of a {@linkcode RawTransport}.
 *
 * Messages that arrive while nobody listens are kept and handed to the first listener, so a client can wire its
 * consumers (handshake, sequencer) in any order without losing early messages. Messages are delivered to every
 * listener present at delivery time; consumers ignore the kinds they do not handle.
 */
export interface MessageTransport {
  send(message: Envelope): void;
  onMessage(listener: (message: Envelope) => void): Unsubscribe;
}

/** Timers and clock, injectable so tests can run virtual time. */
export interface Scheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const systemScheduler: Scheduler = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  now: () => Date.now(),
};
