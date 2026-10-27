# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
#
# SPDX-License-Identifier: AGPL-3.0-only
#
# The co-op game in one container on one port (DECISIONS D22): `coop-server` serves the production build of the game and
# the WebSocket relay at /coop of the same origin. TLS is somebody else's job (the platform, a tunnel): this speaks HTTP.
#
#   docker build -t pokerogue-coop --build-arg VITE_SOURCE_URL=https://github.com/you/pokerogue-coop \
#     --build-arg COOP_GIT_SHA=$(git rev-parse HEAD) .
#   docker run --rm -p 8080:8080 pokerogue-coop
#
# The build context must be a checkout with its submodules (assets/ and locales/): `git submodule update --init --recursive`.
# The upstream development image is `Dockerfile.dev`.

ARG NODE_VERSION=24

# ---------------------------------------------------------------------------------------------------------------------
# Build: the game, with pnpm
# ---------------------------------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate

# Dependencies first: they change less often than the code. (`--ignore-scripts`: the repository's postinstall sets up git
# hooks, and there is no .git here.)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY coop-server/package.json ./coop-server/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

COPY . .
# The assets and the texts are git submodules: a context without them builds a game that cannot load
RUN (test -d assets/images && test -d locales/en) \
    || (echo "assets/ or locales/ is empty: run 'git submodule update --init --recursive' and build again" >&2; exit 1)

# Where the source of this build is published (DECISIONS D25: a production build fails without it)
ARG VITE_SOURCE_URL
# The commit, for the handshake (D1): both players run the same image, so they get the same identity. There is no .git here.
ARG COOP_GIT_SHA=
ARG COOP_DIRTY_HASH=
# 1: the image of the browser tests, which has the debug API (window.__coop). Never deploy it.
ARG COOP_E2E=0
# A deploy has no account server: the saves stay in the browser
ENV VITE_BYPASS_LOGIN=1 \
    VITE_SOURCE_URL=${VITE_SOURCE_URL} \
    VITE_COOP_E2E=${COOP_E2E} \
    COOP_GIT_SHA=${COOP_GIT_SHA} \
    COOP_DIRTY_HASH=${COOP_DIRTY_HASH}
RUN pnpm build

# The relay's one dependency, with its links resolved (pnpm links packages; the runtime has no pnpm)
RUN mkdir -p /out/node_modules && cp -rL coop-server/node_modules/ws /out/node_modules/ws

# ---------------------------------------------------------------------------------------------------------------------
# Runtime: node, the server (it runs TypeScript as it is), the build
# ---------------------------------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/dist
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./coop-server/node_modules
COPY --chown=node:node coop-server/package.json ./coop-server/package.json
COPY --chown=node:node coop-server/src ./coop-server/src
# The reader of the players' logs (D26): docker exec pokerogue node coop-server/scripts/log-view.ts ...
COPY --chown=node:node coop-server/scripts/log-view.ts ./coop-server/scripts/log-view.ts
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "coop-server/src/main.ts"]
