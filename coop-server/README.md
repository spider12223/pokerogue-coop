<!--
SPDX-FileCopyrightText: 2026 pokerogue-coop contributors

SPDX-License-Identifier: AGPL-3.0-only
-->

# coop-server

A dumb WebSocket relay for 2-player co-op, and the server of a deploy (DECISIONS D22, D23). It pairs two sockets by a
6-character room code and forwards text frames between them. It never looks at game messages and holds no game logic:
sequencing, reliability and desync handling are done by the clients (`src/coop/`, `docs/coop/DECISIONS.md`). With `STATIC_DIR` it also
serves the production build of the game, so one container on one port is the whole thing (`docs/coop/HOSTING.md`).

```bash
pnpm install                         # from the repository root (this is a pnpm workspace package)
PORT=8787 pnpm --filter pokerogue-coop-server start                      # the relay only (development: the game is on `pnpm start:dev`)
STATIC_DIR=dist PORT=8080 pnpm --filter pokerogue-coop-server start      # the relay and the built game (after `pnpm build`)
pnpm typecheck:coop-server           # from the root
pnpm test:coop                       # from the root: runs coop-server/test too
node coop-server/scripts/load-test.ts 200 30 10   # 200 rooms for 30 s, 10 frames a second per player, on loopback
```

For development, the game (on Vite's port 8000) connects to this relay with `VITE_COOP_RELAY_URL=ws://localhost:8787/coop`
(already in `.env.development`), and the relay must let that page in: `pnpm coop:server` from the root starts it with
`ALLOWED_ORIGINS=http://localhost:8000`. `pnpm coop:serve` serves the built game and the relay on one port (8080).

| Env | Default | |
|---|---|---|
| `PORT` | 8787 | listen port |
| `HOST` | all addresses | the address to listen on |
| `STATIC_DIR` | none | a build of the game to serve (`GET /`, with the cache rules of `docs/coop/HOSTING.md`) |
| `HOLD_MS` | 60000 | how long a disconnected seat stays reserved once both players are gone |
| `ALLOWED_ORIGINS` | the page's own origin | comma list of origins that may connect; `*` allows all. A client without an `Origin` header (a script) is allowed |
| `TRUST_PROXY` | `private` | `private`, a number of proxies, or `0`: where the player's address comes from (`docs/coop/HOSTING.md`) |
| `MAX_CONNECTIONS_PER_IP`, `CONNECTIONS_PER_MINUTE`, `ROOMS_PER_MINUTE` | 16, 60, 10 | per address (`429` over them; a room over the limit gets `relay:error rateLimited`) |
| `MESSAGES_PER_SECOND`, `MESSAGE_BURST`, `MAX_DROPS_PER_SOCKET` | 120, 400, 200 | per address, over all its sockets; frames over the rate are dropped (the clients resend), and a socket that keeps going is closed (1008) |
| `MAX_ROOMS` | 1000 | rooms in all (`relay:error busy` over it) |
| `IDLE_ROOM_MS` | 1800000 | a room without a game frame for this long is closed (`relay:closed idle`) |

`GET /healthz` answers `{"ok":true,"rooms":…,"sockets":…,"trackedIps":…,"uptimeS":…,"rssMb":…,"cpuMs":…}`.
Logs name rooms, seats and reasons, never a message, a token or an address (a short salted hash stands for an address).

## Protocol

Connect with a WebSocket to `/coop?<query>` (the path of the relay, DECISIONS D22; any other path is `404`):

| Query | Meaning |
|---|---|
| `role=host` | create a room; the host seat is yours |
| `code=ABC234` | join that room as guest (first free guest seat) |
| `code=ABC234&seat=host\|guest&token=<hex>` | take your seat back after a dropped connection |

The relay answers with JSON control frames (`{"t":"relay:..."}`, declared in `src/relay-protocol.ts`):

| Frame | When |
|---|---|
| `relay:created {code, seat:"host", token}` | room created |
| `relay:joined {code, seat:"guest", token}` | guest joined |
| `relay:rejoined {code, seat, peerPresent}` | seat taken back |
| `relay:paired` | both seats connected (sent to both, every time it becomes true) |
| `relay:peerLeft {holdMs}` | partner's connection dropped; their seat is held for `holdMs` |
| `relay:peerBack` | partner took their seat back |
| `relay:peerGone` | partner's hold expired; they cannot come back |
| `relay:closed {reason}` | the room is closed: `hostGone` (the host did not return), `partnerLeft` (End session), `idle` (nothing for `IDLE_ROOM_MS`) |
| `relay:error {reason}` | `notFound`, `full`, `badRequest`, `badToken`, `busy`, `rateLimited`; the socket is then closed (4002) |

Everything else a client sends is forwarded verbatim to the partner. Not forwarded: binary frames, frames while the
partner is away (the clients' reliable layer resends), and any frame whose `t` starts with `relay:` (clients cannot forge
control frames). Frames over 1 MiB close the connection (1009).

## Seats, tokens, holds

- Creating a room or joining returns a **seat token** (128 random bits). The code only lets someone take the free guest
  seat; the token is the only way back into an existing seat.
- A dropped connection reserves the seat for `HOLD_MS` (default 60 s). Rejoining with the token within that time resumes
  the room. A rejoin also works while the relay has not noticed the old connection died: the newer connection wins and
  the old one is closed with code 4000.
- Hold expiry frees the seat and invalidates its token. A guest seat can then be taken by a new guest with the code. The
  host seat cannot: the host is the sequencer, so the room is closed.
- The relay pings every socket every 30 s and drops one that did not answer the previous ping.

## Not in scope

Authentication beyond code + token, TLS (terminate it in front), persistence. A room code is a shared secret between two
friends, not an access control; the limits make guessing one pointless (60 attempts a minute from one address, against
about 10^9 codes), they do not make a room private.

Structure adapted from SunghoLee98/pokerogue `coop-server/` (AGPL-3.0-only); seat tokens, per-seat holds, the rejoin flow, the
static files and the limits are new.
