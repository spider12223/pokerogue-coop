/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Where the relay is (DECISIONS D22): `VITE_COOP_RELAY_URL` if one was built in, else `/coop` of the origin the game was
 * loaded from, over `wss` when the page is `https` and over `ws` when it is `http`. A deploy is one container on one origin,
 * so there is nothing to configure and no mixed content.
 * @param configured - `VITE_COOP_RELAY_URL`
 * @param location - The page's `protocol` and `host` (host and port)
 */
export function relayUrlFor(configured: string | undefined, location: { protocol: string; host: string }): string {
  if (configured !== undefined && configured.trim() !== "") {
    return configured.trim();
  }
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/coop`;
}

/**
 * Where the co-op log goes (DECISIONS D26): `/log` under the relay's path, on the same server, over `https` when the relay is
 * `wss` (and `http` for `ws`).
 * @param relayUrl - The relay's URL, as {@linkcode relayUrlFor} gives it
 */
export function logUrlFor(relayUrl: string): string {
  return `${relayUrl.replace(/^ws(s?):/i, "http$1:").replace(/\/+$/, "")}/log`;
}
