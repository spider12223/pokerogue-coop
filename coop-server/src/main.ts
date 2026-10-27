/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DEFAULT_MAX_DIR_BYTES } from "./client-logs.ts";
import { DEFAULT_LIMITS, type RelayLimits } from "./limits.ts";
import { DEFAULT_HOLD_MS } from "./relay-protocol.ts";
import { startRelayServer } from "./relay-server.ts";

/** A number from the environment, or the default when it is unset or not a number */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** `TRUST_PROXY`: unset or `private`: a proxy is whatever connects from a private network (the default); a number: that many proxies */
function trustProxyFromEnv(raw: string | undefined): number | "private" {
  if (raw === undefined || raw.trim() === "" || raw.trim().toLowerCase() === "private") {
    return "private";
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : "private";
}

const port = envNumber("PORT", 8787);
const holdMs = envNumber("HOLD_MS", DEFAULT_HOLD_MS);
const staticDir = process.env["STATIC_DIR"] === "" ? undefined : process.env["STATIC_DIR"];
const allowedRaw = process.env["ALLOWED_ORIGINS"];
const allowedOrigins =
  allowedRaw === undefined || allowedRaw.trim() === ""
    ? null
    : allowedRaw
        .split(",")
        .map(origin => origin.trim().replace(/\/+$/, ""))
        .filter(origin => origin.length > 0);

const limits: RelayLimits = {
  maxConnectionsPerIp: envNumber("MAX_CONNECTIONS_PER_IP", DEFAULT_LIMITS.maxConnectionsPerIp),
  connectionsPerMinute: envNumber("CONNECTIONS_PER_MINUTE", DEFAULT_LIMITS.connectionsPerMinute),
  roomsPerMinute: envNumber("ROOMS_PER_MINUTE", DEFAULT_LIMITS.roomsPerMinute),
  messagesPerSecond: envNumber("MESSAGES_PER_SECOND", DEFAULT_LIMITS.messagesPerSecond),
  messageBurst: envNumber("MESSAGE_BURST", DEFAULT_LIMITS.messageBurst),
  maxDropsPerSocket: envNumber("MAX_DROPS_PER_SOCKET", DEFAULT_LIMITS.maxDropsPerSocket),
  maxRooms: envNumber("MAX_ROOMS", DEFAULT_LIMITS.maxRooms),
  idleRoomMs: envNumber("IDLE_ROOM_MS", DEFAULT_LIMITS.idleRoomMs),
};

// The client diagnostics log (D26): off unless CLIENT_LOGS=1; LOG_DIR also keeps it in daily files, LOG_MAX_BYTES caps them
const logDir = process.env["LOG_DIR"];
const clientLogs = {
  enabled: process.env["CLIENT_LOGS"] === "1",
  ...(logDir === undefined || logDir === "" ? {} : { dir: logDir }),
  maxDirBytes: envNumber("LOG_MAX_BYTES", DEFAULT_MAX_DIR_BYTES),
};
/** The relay's own lines, with the time (the client lines carry theirs) */
const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);

const host = process.env["HOST"];
const relay = await startRelayServer({
  port,
  ...(host === undefined || host === "" ? {} : { host }),
  holdMs,
  ...(staticDir === undefined ? {} : { staticDir }),
  limits,
  allowedOrigins,
  trustProxy: trustProxyFromEnv(process.env["TRUST_PROXY"]),
  clientLogs,
  log,
});
console.log(
  `coop server listening on :${relay.port} (relay at /coop, health at /healthz, ${
    staticDir === undefined ? "no static files" : `files from ${staticDir}`
  }; seat hold ${holdMs} ms, origins ${allowedOrigins === null ? "same origin" : allowedOrigins.join(",")}; client logs ${
    clientLogs.enabled ? `on${logDir ? ` (files in ${logDir})` : ""}` : "off"
  })`,
);

const shutdown = (): void => {
  void relay.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
