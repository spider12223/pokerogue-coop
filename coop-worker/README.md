<!--
SPDX-FileCopyrightText: 2026 pokerogue-coop contributors

SPDX-License-Identifier: AGPL-3.0-only
-->

# coop-worker

The co-op relay as a Cloudflare Worker, for a game served as static files (GitHub Pages). Same protocol as
[`coop-server`](../coop-server/README.md) at `/coop`, so the game cannot tell them apart: one Durable Object per room code
keeps the seats, tokens and holds, and sleeps between messages (WebSocket hibernation).

| File | |
|---|---|
| `src/worker.ts` | the entry: `/healthz`, origin check, rough per-address limits, routes `/coop` to the room of the code |
| `src/room.ts` | the room (`Room`, a Durable Object): create, join, rejoin, forward, holds and the idle close (alarms) |
| `src/shared.ts` | codes, tokens, the control-frame filter, the token bucket, the settings |
| `scripts/smoke.ts` | walks through the protocol against any relay: `node scripts/smoke.ts wss://<relay>/coop` |
| `wrangler.toml` | the Worker, its Durable Object, and the settings (`ALLOWED_ORIGINS` first of all) |

```bash
pnpm install --ignore-workspace         # its own packages, not part of the game's workspace
pnpm exec wrangler dev --var "ALLOWED_ORIGINS:*"   # on this machine, http://127.0.0.1:8787/coop
pnpm exec tsc -p tsconfig.json          # type check
pnpm exec wrangler deploy               # to your Cloudflare account (after `pnpm exec wrangler login`)
```

Deploying it with the website: [docs/coop/HOSTING.md](../docs/coop/HOSTING.md), "A free website".
