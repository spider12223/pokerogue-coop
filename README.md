<!--
SPDX-FileCopyrightText: 2024-2026 Pagefault Games
SPDX-FileCopyrightText: 2026 pokerogue-coop contributors

SPDX-License-Identifier: CC-BY-NC-SA-4.0
-->

<div align="center"><picture><img src="https://github.com/pagefaultgames/pokerogue-assets/blob/beta/images/logo.png?raw=true" width="300" alt="PokéRogue"></picture>

**PokéRogue Co-op**: two players, one run, every battle a double battle.

[![GNU AGPLv3 License Static Badge](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
</div>

This is a fork of [PokéRogue](https://github.com/pagefaultgames/pokerogue), the browser Pokémon roguelite by Pagefault
Games, that adds **online co-op for two players**. Each player brings three Pokémon and commands one side of the field;
both choose their moves at the same time, share the rewards, catch and trade Pokémon, and keep what they catch in their own
account. Single player is unchanged.

It is a fan project, not affiliated with Pagefault Games, Nintendo, Game Freak or The Pokémon Company.

## Play

| Way | How |
|---|---|
| **Website** | Open **<https://spider12223.github.io/pokerogue-coop/>**, choose **Co-op**, host or join with a code. Nothing to install. |
| **Host from your own PC** (Windows) | Download `PokeRogue-Coop-windows.zip` from [Releases](https://github.com/spider12223/pokerogue-coop/releases/latest), unzip it and double-click `Start.bat`; it shows a link to send to your friend. |
| **Your own server or website** | A Docker image on one port, or your own copy of the website. See [docs/coop/HOSTING.md](docs/coop/HOSTING.md). |

Then read [docs/coop/HOW-TO-PLAY.md](docs/coop/HOW-TO-PLAY.md): starting a game, battles, rewards, trading, Mystery
Encounters, importing your pokerogue.net account, and what to do when something goes wrong.

## How co-op works

Both players run the full game in their own browser. A small relay (`coop-server/`) passes messages between them; it never
runs the game.

- **Lockstep.** Both games simulate the same battle from the same seed. Only the players' choices travel, and every choice
  that both games must agree on (a command, a reward, a switch, a catch) is numbered by the host before either game uses it.
- **Checks.** Each game hashes its state at fixed points; a difference reloads both games from the host's save of the
  current wave.
- **Ownership.** Every Pokémon belongs to one player; the field slot, the party screen, rewards and catches follow from that.
- **Reconnects.** A player who drops comes back into the same room; both games continue from the start of the wave.

The full design (every rule and why) is in [docs/coop/DECISIONS.md](docs/coop/DECISIONS.md); the code map is in
[docs/coop/ARCHITECTURE.md](docs/coop/ARCHITECTURE.md).

## Build from source

Needs [Node.js](https://nodejs.org) 24.9 or newer and [pnpm](https://pnpm.io) 10.

```bash
git clone --recurse-submodules https://github.com/<you>/pokerogue-coop
cd pokerogue-coop
pnpm install
```

`assets/` and `locales/` are git submodules: without `--recurse-submodules`, run `git submodule update --init --recursive`.

| Task | Command |
|---|---|
| Game with hot reload | `pnpm start:dev` (http://localhost:8000) |
| Relay for the dev game | `pnpm coop:server` (in a second terminal) |
| Production build | `VITE_BYPASS_LOGIN=1 VITE_SOURCE_URL=<this repo's URL> pnpm build` (into `dist/`) |
| Serve `dist/` and the relay on one port | `pnpm coop:serve` (http://localhost:8080) |
| Docker image | `docker build -t pokerogue-coop --build-arg VITE_SOURCE_URL=<this repo's URL> .` |

A production build stops without `VITE_SOURCE_URL` (an `http(s)` address): the title screen links to the source, as the
AGPL asks of anyone who hosts a modified version. `VITE_BYPASS_LOGIN=1` keeps the accounts in the browser (there is no
account server). In PowerShell: `$env:VITE_BYPASS_LOGIN="1"; $env:VITE_SOURCE_URL="https://github.com/<you>/pokerogue-coop"; pnpm build`.

## Tests

| Suite | Command |
|---|---|
| Co-op unit and two-client tests | `pnpm test:coop` |
| Same-seed replay of whole waves | `pnpm test:ste` |
| Everything, including upstream's suite | `pnpm test:silent` |
| Browser tests (Playwright, two real browsers) | `pnpm e2e` |
| Type check (game and relay) | `pnpm typecheck` and `pnpm typecheck:coop-server` |

## Layout

| Path | What |
|---|---|
| `src/coop/` | co-op logic: session, transport, sequencer, ownership, rewards, trade, resync, lobby |
| `src/phases/coop-*.ts`, `src/ui/handlers/coop-*.ts` | co-op phases and screens |
| `coop-server/` | the relay and static server (Node, `ws`) |
| `coop-worker/` | the same relay as a Cloudflare Worker, for the website |
| `pack/windows/`, `scripts/pack-windows.ps1` | the double-click pack for Windows |
| `.github/workflows/coop-*.yml` | publish the website, build the pack for a release |
| `test/coop/`, `test/tests/coop/` | co-op tests; `test/helpers/coop-*.ts` drive two linked games |
| `test/e2e/` | Playwright tests |
| `docs/coop/` | how to play, hosting, design, architecture |

Everything else is upstream PokéRogue. Co-op code paths are gated by `isCoop()`, so a single-player game runs the upstream
code.

## Credits

- [PokéRogue](https://github.com/pagefaultgames/pokerogue) by Pagefault Games and its contributors: the game this is built
  on. Their credits are in [CREDITS.md](CREDITS.md).
- [SunghoLee98/pokerogue](https://github.com/SunghoLee98/pokerogue): an earlier lockstep co-op fork; files adapted from it say
  so in their header.

## Licensing

Licensing follows upstream PokéRogue, which seeks to be [REUSE compliant](https://reuse.software/): copyright and licensing
information for each file is in the file itself or in a `REUSE.toml` file. In short (from upstream's README):

- All source code belonging to the project, unless otherwise noted, is licensed under
  [AGPL-v3.0-only](LICENSES/AGPL-3.0-only.txt).
- Documentation (Markdown files and comments documenting source code) is licensed under
  [CC-BY-NC-SA-4.0](LICENSES/CC-BY-NC-SA-4.0.txt), unless a file says otherwise.
- Auto-generated files and files of insignificant originality are licensed under [CC0-1.0](LICENSES/CC0-1.0.txt).
- To the extent that the assets are licensable, they are licensed under [CC-BY-NC-SA-4.0](LICENSES/CC-BY-NC-SA-4.0.txt)
  unless otherwise noted; exceptions are in `REUSE.toml` files. Files in `assets/` that are not explicitly licensed should be
  considered to have _no_ licensing or copyright information.

If you host this game, the AGPL asks you to offer its source to your players: set `VITE_SOURCE_URL` to the repository you
build from.
