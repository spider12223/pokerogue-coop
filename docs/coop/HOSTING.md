<!--
SPDX-FileCopyrightText: 2026 pokerogue-coop contributors

SPDX-License-Identifier: AGPL-3.0-only
-->

# Hosting co-op

Co-op needs two things: the game's files (a static site) and a small WebSocket **relay** that passes the two players' messages
to each other. The relay keeps rooms in memory only; the players' accounts and saves stay in their own browsers.

`coop-server` does both on one port: it serves the production build of the game at `/` and the relay at `/coop` of the same
address, so nothing has to be configured (see [DECISIONS.md](DECISIONS.md), D22).

| Endpoint | |
|---|---|
| `GET /` | the game (the files of `dist/`) |
| `wss://<your host>/coop` | the relay (`ws://` on an `http` page) |
| `GET /healthz` | `{"ok":true,"rooms":1,"sockets":2,"trackedIps":1,"uptimeS":…,"rssMb":…,"cpuMs":…}` |

The server speaks plain HTTP. TLS is the job of whatever stands in front of it: the platform, a tunnel, Caddy.

| Way | Costs | Runs on | Good for |
|---|---|---|---|
| [A free website](#a-free-website-github-pages-and-a-cloudflare-worker) | nothing | GitHub Pages + Cloudflare Workers | everyone: open a link and play |
| [Host from your own PC](#host-from-your-own-pc-windows) | nothing | the host's Windows PC, while it is on | playing with a friend tonight, nothing to set up |
| [Docker](#docker-one-container) | a server | any machine with Docker | your own server, your own limits |

## A free website (GitHub Pages and a Cloudflare Worker)

The game is static files, and GitHub Pages serves them for free (a site of up to 1 GB, about 100 GB of traffic a month;
the build is about 650 MB). Pages cannot run the relay, so the relay runs as a Cloudflare Worker (`coop-worker/`): one
Durable Object per room, asleep between messages. The free plan allows 100,000 requests a day, and the WebSocket messages
of a game count one request per 20, which is enough for many games a day. When a day's quota runs out, new rooms fail until
midnight UTC.

**1. The relay (once).** Needs a free Cloudflare account.

```bash
cd coop-worker
pnpm install --ignore-workspace
pnpm exec wrangler login          # opens the browser: allow wrangler on your account
```

In `coop-worker/wrangler.toml`, set `ALLOWED_ORIGINS` to the address of your Pages site without its path
(`https://<you>.github.io`). Then:

```bash
pnpm exec wrangler deploy
```

It prints the Worker's address, `https://pokerogue-coop-relay.<your subdomain>.workers.dev`. Check it:
`node scripts/smoke.ts wss://pokerogue-coop-relay.<your subdomain>.workers.dev/coop` (with
`ORIGIN=https://<you>.github.io` in the environment) should end with "all 12 checks passed".

**2. The website (once).** In the GitHub repository:

- Settings > Pages > Source: **GitHub Actions**.
- Settings > Secrets and variables > Actions > Variables: `COOP_RELAY_URL` =
  `wss://pokerogue-coop-relay.<your subdomain>.workers.dev/coop`.
- Actions > **Co-op website** > Run workflow (later, every push to `coop` publishes again).

The site is `https://<you>.github.io/pokerogue-coop/`. The game loads from a sub-folder as it is. The players' accounts
and saves stay in their browsers, for that address.

With the GitHub and Wrangler command lines: `gh api -X POST repos/<you>/pokerogue-coop/pages -f build_type=workflow`,
`gh variable set COOP_RELAY_URL --body wss://…/coop`, `gh workflow run coop-pages.yml`.

| Worker variable (`wrangler.toml`) | Default | |
|---|---|---|
| `ALLOWED_ORIGINS` | the Worker's own address | the pages that may use the relay: a comma list, or `*` |
| `HOLD_MS` | 60000 | how long a seat is kept once both players are gone (D20) |
| `IDLE_ROOM_MS` | 1800000 | a room without a game frame for this long is closed |
| `CONNECTIONS_PER_MINUTE`, `ROOMS_PER_MINUTE` | 60, 10 | per address, per Worker instance |
| `MESSAGES_PER_SECOND`, `MESSAGE_BURST`, `MAX_DROPS_PER_SOCKET` | 120, 400, 200 | per socket |

Differences from `coop-server`: the Worker does not ping (a sleeping room does not run), so a connection that dies without
closing is noticed when that player comes back; it does not collect players' logs (`/coop/log` is 404); the limits count
per Worker instance and per room, not per address over the whole relay. The protocol is the same.

`pnpm exec wrangler dev` runs the Worker on this machine (with `--var ALLOWED_ORIGINS:*` for a local page);
`wrangler tail` shows the deployed one's requests live.

## Host from your own PC (Windows)

The pack is a folder with Node, the server, the built game and
[cloudflared](https://github.com/cloudflare/cloudflared). `Start.bat` serves the game on `http://127.0.0.1:8080`, opens a
Cloudflare quick tunnel to it (no account), shows the `https://….trycloudflare.com` link for the friend and copies it,
and opens the game in the host's browser. Closing the window stops both. Nothing is installed, and no port is opened on
the router or the firewall.

- The host plays on `127.0.0.1:8080`, so their accounts and saved runs stay from one start to the next.
- The friend's link is new at every start, and a browser keeps saves per address, so the friend's progress is kept for that
  link only. A saved co-op run can be continued only with the same two accounts.
- `Start.bat -NoTunnel`: this PC only. Logs are in the pack's `logs` folder.

Building the pack (the zip of a release, `.github/workflows/coop-release.yml`, is made the same way):

```bash
VITE_BYPASS_LOGIN=1 VITE_SOURCE_URL=https://github.com/<you>/pokerogue-coop pnpm build
pwsh scripts/pack-windows.ps1          # downloads Node and cloudflared and checks their SHA-256
```

The build must not have `VITE_COOP_RELAY_URL`: the pack's game uses the relay of its own server. The zip is
`pack-out/PokeRogue-Coop-windows.zip`. With programs you already have: `-NodeExe <node.exe> -CloudflaredExe <cloudflared.exe>`.

## Docker (one container)

The build needs a checkout **with its submodules**: `assets/` and `locales/` are git submodules, and a build without them
cannot load.

```bash
git clone --recurse-submodules https://github.com/<you>/pokerogue-coop
cd pokerogue-coop

docker build -t pokerogue-coop \
  --build-arg VITE_SOURCE_URL=https://github.com/<you>/pokerogue-coop \
  --build-arg COOP_GIT_SHA=$(git rev-parse HEAD) .

docker run --rm -p 8080:8080 pokerogue-coop
```

Open <http://localhost:8080>, choose **Co-op** and **Host a game**; the second player opens the same address and **Join a
game** with the code. In a checkout without the submodules: `git submodule update --init --recursive`.

| Build argument | | |
|---|---|---|
| `VITE_SOURCE_URL` | **required** | Where the source of this build is published. The title screen links to it, as the AGPL asks of a service that runs a modified version (D25). A production build without it stops with an error. |
| `COOP_GIT_SHA` | recommended | The commit, for the handshake (both players must run the same build). Without it the build says `unknown`, which still matches itself. |
| `COOP_DIRTY_HASH` | no | `clean` unless you build a tree with changes. |
| `COOP_E2E` | **never in a deploy** | `1` builds the image the browser tests run against: it exposes the debug API `window.__coop`. |

`Dockerfile.dev` is upstream's development image.

## Server settings

All optional; the defaults suit a game among friends.

| Environment variable | Default | |
|---|---|---|
| `PORT` | 8080 in the image, 8787 outside | listen port |
| `STATIC_DIR` | `/app/dist` in the image | the build to serve; without one the server is only a relay |
| `HOLD_MS` | 60000 | how long a seat is kept once **both** players are gone (D20) |
| `ALLOWED_ORIGINS` | the page's own origin | comma list of origins that may open the relay (`*`: all). Needed only when the game is served from another address than the relay |
| `TRUST_PROXY` | `private` | where the player's address comes from: `private` (a connection from this machine or a private network is a proxy, and the client is the first public address of `X-Forwarded-For`), a number of proxies, or `0` (never read the header) |
| `MAX_CONNECTIONS_PER_IP` | 16 | sockets one address may hold |
| `CONNECTIONS_PER_MINUTE` | 60 | connection attempts per address |
| `ROOMS_PER_MINUTE` | 10 | rooms one address may create |
| `MESSAGES_PER_SECOND`, `MESSAGE_BURST` | 120, 400 | what one address may send, over all its sockets |
| `MAX_ROOMS` | 1000 | rooms in all |
| `IDLE_ROOM_MS` | 1800000 | a room without a game frame for this long is closed |

The relay does not log messages, tokens or addresses (a short salted hash stands for an address).

## Players' logs

The players' games keep a co-op log: the lobby, every decision of the run, the partner leaving and coming back, resyncs,
errors, and a note when a game sat still for a minute. Started with `CLIENT_LOGS=1`, the server collects it: one JSON line per
entry on its standard output, and in daily files when `LOG_DIR` is set.

```bash
docker run -d --name pokerogue -p 8080:8080 --restart unless-stopped \
  -e CLIENT_LOGS=1 -e LOG_DIR=/logs -v ~/coop-logs:/logs pokerogue-coop
```

| Variable | Default | |
|---|---|---|
| `CLIENT_LOGS` | off | `1` collects the players' logs. Off, `/coop/log` answers 404 and the games keep their log to themselves |
| `LOG_DIR` | none | also write `client-YYYY-MM-DD.jsonl` files there (mount a volume to keep them) |
| `LOG_MAX_BYTES` | 209715200 (200 MiB) | the files are kept under this; the oldest goes first |

Reading them:

```bash
docker logs -f pokerogue
docker exec pokerogue node coop-server/scripts/log-view.ts --rooms /logs/client-2026-10-26.jsonl
docker exec pokerogue node coop-server/scripts/log-view.ts --room ABCD12 /logs/client-2026-10-26.jsonl
```

`log-view.ts` prints both players of a room as one timeline; `--seat`, `--kind`, `--session`, `--level` and `--data` narrow
it down or show the data in full. A player who pressed **Report a problem** shows up as a `report` line with their note and a
snapshot of their game. Turn `CLIENT_LOGS` on only for players who know: the log has their display names and what they chose
in the run (no accounts, tokens or addresses).

## Sharing a server that runs at home

Run the container as above and make it reachable for your friend.

**Cloudflare quick tunnel** (no account; the address changes every time):

```bash
cloudflared tunnel --url http://localhost:8080
```

It prints `https://<words>.trycloudflare.com`. Send that address; both of you open it. For an address that stays, make a
named tunnel in a Cloudflare account and point it at `http://localhost:8080`.

**Tailscale** (both on the same tailnet): `http://your-machine:8080` works as it is. `tailscale serve --bg 8080` gives an
`https://your-machine.<tailnet>.ts.net` address; `tailscale funnel 8080` makes it public (a room is then protected only by its
code).

**Same network:** `http://192.168.x.x:8080`.

## A server on the internet

The steps below follow each service's documentation; only the Docker image and the Cloudflare quick tunnel have been run.

**Railway:** deploy from the GitHub repository (it finds the `Dockerfile`); set `VITE_SOURCE_URL` (passed to the build) and
generate a domain. `PORT` is set by Railway. If its clone lacks the submodules, build the image in CI and deploy the image.

**Fly.io:**

```bash
fly launch --no-deploy --dockerfile Dockerfile --internal-port 8080
fly deploy --build-arg VITE_SOURCE_URL=https://github.com/<you>/pokerogue-coop --build-arg COOP_GIT_SHA=$(git rev-parse HEAD)
```

`fly.toml` needs `[http_service]` with `internal_port = 8080` and `force_https = true`. Keep **one** machine: rooms live in its
memory.

**A VPS:** `docker run -d --name coop --restart unless-stopped -p 127.0.0.1:8080:8080 pokerogue-coop` and Caddy in front:

```
game.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy passes WebSockets and `X-Forwarded-For` by itself. With nginx, add `proxy_http_version 1.1;`,
`proxy_set_header Upgrade $http_upgrade;`, `proxy_set_header Connection "upgrade";`,
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` and `proxy_read_timeout 3600s;` to `location /`.

## Updating

Build and run the new image. `index.html` is served `no-cache` and the hashed files `immutable`, so a reload gets the new
build. Both players must run the same build: a client with an old page is told that the versions differ and reloads. A run in
progress is not lost: the host's browser keeps its wave-start save, and **Co-op > Continue** resumes it with the same partner.

## When it does not connect

| Sign | Look at |
|---|---|
| "Could not connect." at once | `GET /healthz` on the same address; a proxy that does not pass WebSocket upgrades (see nginx above); a page on `https` with a relay on `ws` (mixed content) |
| "Could not connect." only for the second player | `ALLOWED_ORIGINS` if the page and the relay are on different addresses; the rate limits (`429`, the server's "refused ip" line) if many players share one proxy |
| "The server is full right now" | `MAX_ROOMS` |
| "Too many tries" | the rate limits: wait a minute |
| "You and your partner run different versions" | one of you has an old page: reload with Ctrl+F5 |
