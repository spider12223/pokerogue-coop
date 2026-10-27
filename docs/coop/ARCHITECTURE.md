<!--
SPDX-FileCopyrightText: 2026 pokerogue-coop contributors

SPDX-License-Identifier: AGPL-3.0-only
-->

# How co-op works in the code

This page is for contributors. It explains how the two-player co-op mode is built: the server, the network layers, how
a decision travels from one player's screen into both simulations, how the clients notice and repair a desync, and how
it is tested. It ends with a map of `src/coop/` and pointers for common changes.

The rules themselves (who decides what, which keys, which checks) are in [DECISIONS.md](DECISIONS.md). References such as
"D13" point to its sections, and the code cites them the same way. Paths are relative to the repository root; module
names without a directory are in `src/coop/`.

## The big picture

```text
   host's browser                                                  guest's browser
 +------------------------------+                              +------------------------------+
 | game phases (src/phases/)    |                              | game phases (src/phases/)    |
 |   coopDecide, windows        |                              |   coopDecide, windows        |
 | CoopSession (session.ts)     |                              | CoopSession                  |
 | CoopLink (link.ts)           |                              | CoopLink                     |
 |   Sequencer: assigns seq     |                              |   Sequencer: applies by seq  |
 |   EpochTransport             |                              |   EpochTransport             |
 |   ReliableTransport          |                              |   ReliableTransport          |
 |   RelayWsTransport ----------+---> coop-server, /coop <-----+---------- RelayWsTransport  |
 +------------------------------+     pairs and forwards,      +------------------------------+
                                      never reads a message
```

- **Lockstep.** Both browsers run the whole game from the same run seed. No game state crosses the network, only
  decisions. The host is authoritative over the *order* of decisions, not over the state.
- **A decision's path.** The player's screen → a proposal (`PROPOSE` from the guest, a local call on the host) → the
  host's sequencer checks it and gives it the next `seq` → `SEQUENCED` to both clients → each client checks it for
  legality and applies it when its own simulation asks for it.
- **Desync detection.** Both clients hash the simulation state at fixed points and exchange the hashes. On a mismatch
  (or a decision that does not fit) both reload the start of the wave from the host's save, under a new epoch.
- **Solo play is untouched.** Every co-op branch is behind `isCoop()` (a co-op session exists) or `isLinked()` (the
  session has a network). Solo play runs the upstream code paths: the full upstream test suite stays green, and tests
  compare solo save slots byte for byte.

## The relay server (`coop-server/`)

`coop-server/` is a small Node package in the pnpm workspace (`pokerogue-coop-server`). In production it is the whole
deploy: one HTTP server on one port serves the built game from `STATIC_DIR` and the relay at `/coop` (D22).

- The relay pairs two WebSockets by a 6-character room code: `role=host` creates a room, `code=…` joins it, and
  `code=…&seat=…&token=…` takes a seat back. It forwards text frames between the two verbatim and never parses them.
  Its own messages are `relay:*` control frames (created, joined, paired, peerLeft, peerBack, peerGone, closed, error),
  which clients cannot forge.
- Seats survive dropped connections: each seat has a token, and a held seat can be taken back (D20). If the host's seat
  expires the room is closed, because the host is the sequencer.
- It is hardened for the open internet (D23): per-IP limits, the Origin check, the client's address behind a proxy.
- It answers `GET /healthz`, and collects client logs at `POST /coop/log` only when started with `CLIENT_LOGS=1` (D26).
- `coop-server/README.md` documents the wire protocol, the environment variables and the commands.
  [HOSTING.md](HOSTING.md) covers running it.

| File | What it does |
|---|---|
| `coop-server/src/main.ts` | Reads the environment and starts the server |
| `coop-server/src/relay-server.ts` | The HTTP server: the relay at `/coop`, `/healthz`, the client log endpoint, the static files, heartbeats |
| `coop-server/src/room-registry.ts` | Rooms, seats, seat tokens and holds; holds no sockets, so it is tested with an injected clock |
| `coop-server/src/relay-protocol.ts` | The `relay:*` control frames; the client side is `src/coop/transport/relay-ws.ts` |
| `coop-server/src/limits.ts` | Per-IP limits, the client's address behind a proxy, the Origin rule |
| `coop-server/src/static.ts` | The files of the build, with their cache rules |
| `coop-server/src/client-logs.ts` | `POST /coop/log`, off by default |
| `coop-server/scripts/load-test.ts` | Many rooms on loopback, to measure the relay |
| `coop-server/scripts/log-view.ts` | Prints the client log lines of a room as one timeline |
| `coop-server/test/` | The server's tests, run by `pnpm test:coop` |

`coop-worker/` is the same relay as a Cloudflare Worker, for the website on GitHub Pages: one Durable Object per room
code (`src/room.ts`) with the seats of `RoomRegistry` in its storage, sleeping between frames. It imports
`relay-protocol.ts`, so the two cannot drift apart on the wire; `coop-worker/scripts/smoke.ts` runs the same protocol
walk against either. It is its own package outside the workspace (`pnpm install --ignore-workspace`), so the game's
install does not pull in Wrangler.

## The transport stack

Each client reaches its partner through three layers. None of them imports game code.

1. **`transport/relay-ws.ts`**, `RelayWsTransport`: a `RawTransport` (text frames that may be lost) over a WebSocket to
   the relay. It creates, joins or rejoins a room. The relay drops frames while the partner is away.
2. **`transport/reliable.ts`**, `ReliableTransport`: turns a raw transport into a `MessageTransport` with per-sender
   numbering, selective acks, resend with backoff, deduplication and in-order, exactly-once delivery. It moves to a new
   connection after a reconnect and starts its numbering again on a new pairing (D20). `sendVolatile` sends without a
   number or a resend; the cosmetic channel uses it.
3. **`epoch.ts`**, `EpochTransport`: stamps the current epoch on every envelope and keeps messages of another epoch away
   from the simulation. Older ones are dropped; newer ones wait until the `RESYNC` that brings their epoch has been
   applied; a `RESYNC` always passes (D18).

Every message is an `Envelope` (`protocol.ts`): `kind` (`HELLO`, `LOBBY`, `START`, `PROPOSE`, `SEQUENCED`, `REJECT`,
`CHECKPOINT`, `COSMETIC`, `RESYNC_REQUEST`, `RESYNC`, `REPORT`, …), `author`, `key` (a decision key or `null`),
`payload`, and optionally `seq`, `epoch` and `takeover`. A message shape that changes incompatibly bumps
`COOP_PROTOCOL_VERSION`, and the handshake refuses a partner on another version.

Tests replace the bottom layer: `transport/loopback.ts` (`createLoopbackPair`) is an in-process pair that drops,
duplicates and reorders frames from a seed, and `test/coop/manual-link.ts` lets a test decide when each message arrives.

## The link and the handshake

- **`link.ts`** creates or joins a room (`createRoom`, `joinRoom`, `rejoinRoom`) and shakes hands (`establishHost`,
  `establishGuest`). The result is a `CoopLink`: the channel, the epoch, the `Sequencer`, and the rest of the traffic of
  a run (lobby messages, `START`, checkpoints, cosmetic messages, resync requests and reports). It notices when the
  partner leaves and comes back, re-pairs and repeats the handshake, and tells the game that a reload is due
  (`partnerPresent`, `needsResync`).
- **`handshake.ts`** is the asymmetric handshake of D1. The host sends `HELLO` with its build, pinned settings, name and
  mode. The guest checks the build, applies the settings as an in-memory overlay (`pinned-settings.ts`, through a port
  into the settings manager) and answers `HELLO_ACK`. The host checks that (and, for a resumed run, the guest's account)
  and answers `HELLO_OK` or `REFUSE`. `build-info.ts` gives the local build identity, which
  `plugins/vite/coop-build-identity.ts` computes at build time.
- **`lobby.ts`** is the game side: the title screen's Co-op entry, host or join, the room code, and `beginSession`, which
  creates the `CoopSession` and wires everything to it (the checkpoint exchange, the resync, the cosmetic view, the pacer,
  the co-op log, the seat token).
- **The starter select** is `starter-lobby.ts` (a state machine without UI: live picks, a shared point budget, ready,
  then the host's `START` with the run seed, both parties and both account snapshots) and `starter-select-coop.ts` (its
  view in the upstream screen).
- **`rejoin.ts`**: a tab that loads with a seat token in `localStorage` (`seat-store.ts`) takes its seat back at boot
  (D20), and the host's "Continue" opens a new room for the run in its co-op slot (D21).

## The session

`session.ts` holds `CoopSession`, the singleton of a co-op run (`null` in solo play). It carries the seat, the link,
the owner map (`ownership.ts`), the account snapshots (D4), the run seed, `rewardPickCount`, the open window, the
checkpoint log and phase trace, the pacing tracker, the resync bookkeeping and the display names. It imports no game
code, because simulation code (`src/battle.ts`, `src/field/pokemon.ts`) imports it.

- `isCoop()`: a co-op session exists.
- `isLinked()` (`bridge.ts`): the session has a link, so decisions are sequenced. A session without one is the offline
  rules harness that some tests use.

## The sequencer and decision keys

`sequencer.ts` is the core of the lockstep (D2). It knows nothing about the game: it compares keys and orders by `seq`.

- **The simulation says what it expects.** `awaitDecision(key)` opens a window of one key. `awaitOneOf(entries)` opens a
  window of several keys in which the first sequenced one closes the others (the reward screen, the trade screen).
  `awaitAll(keys)` waits for every key, in any order. Each entry can name the seats allowed to author it.
- **Proposals.** On the guest, `propose(key, payload)` sends `PROPOSE`; on the host it goes straight into sequencing.
  The host checks the key, the author (skipped for `takeover: true`), duplicates and closed keys, and the payload
  (`validatePayload`, wired to `validateProposal` in `validate.ts`). A proposal for a window the host's own simulation
  has not opened yet (the guest is ahead) is parked until it opens. A refused one comes back as `REJECT`, and the
  proposer sees a `ProposalRejectedError` with the reason.
- **Sequencing.** An accepted proposal gets the next `seq` and goes out as `SEQUENCED`; the host applies it at the same
  moment. Both clients deliver decisions strictly in `seq` order and buffer early ones.
- **Legality.** Just before the simulation gets a decision, both clients run the check installed with `setLegality`:
  `checkDecisionLegal` (`legal.ts`) over the game's read-only `LegalityView` (`legal-view.ts`), D24. An illegal decision
  is not applied.
- **Failure.** A key outside the window, two decisions with the same `seq`, an unreadable payload or an illegal decision
  is a `DesyncError`, reported through `onDesync`. The resync takes it from there.
- **Epochs.** `resetForEpoch` forgets the windows, closed keys, parked proposals and early decisions; whatever was
  waiting rejects with `EpochChangedError`. `reserveSeq` and `ensureSeqAtLeast` serve the `RESYNC`, which takes a `seq`
  but has no key.

Keys are built by small functions, never by hand in a phase: `decision-keys.ts` (turn commands, side action, side pick,
faint and pivot switch, biome, catch release, learn-move, evolution, retry), `reward-actions.ts` (`rewardKey`,
`rewardWindow`), `trade.ts` (`tradeKey`, `tradeDoneKey`, `tradeRequestKey`), `party-edit.ts` (`partyEditKey`) and
`me-choice.ts` (`meChoiceKey`). The payload types and their guards sit next to them (`prompt-payloads.ts`,
`turn-commands.ts`, `retry.ts`, …). D2 has the full table of kinds, keys and deciders.

## How a phase asks for a decision

Most decisions go through one helper, `coopDecide` in `bridge.ts`. This is the learn-move prompt
(`src/phases/learn-move-phase.ts`, shortened):

```ts
if (isLinked()) {
  const owner = deciderOf({ kind: "LEARN_MOVE", pokemonId: pokemon.id });
  coopDecide<LearnMovePayload>({
    key: learnMoveKey(globalScene.currentBattle.waveIndex, pokemon.id, this.moveId),
    decider: owner,
    // only on the owner's client: the same screens as in solo play, but nothing is changed yet
    ask: async () => ({ replaceIndex: await this.askReplaceIndex(move, pokemon) }),
    // only on the partner's client
    wait: () => globalScene.ui.showText(coopText("partnerDecidesLearn", "{{partner}} is deciding…", { partner })),
    isPayload: isLearnMovePayload,
  })
    .then(({ payload }) => this.learnMove(payload.replaceIndex /* … */)) // both clients
    .catch(reportBridgeError);
}
```

What `coopDecide` does:

1. **Gate.** It awaits `coopGate()`: while the partner is away or a reload is due, it shows the waiting screen and does
   not go on (D20). If the run was reloaded meanwhile, it throws `EpochChangedError`, which `reportBridgeError` ignores.
2. **Window.** It adds the key to the session's open window and calls `awaitDecision`.
3. **Ask or wait.** On the decider's client it calls `ask()` and proposes the answer (`proposeUnlessLate`: a proposal
   that lost to a take over is dropped quietly). On the other client it calls `wait()` and starts an `AfkWatcher`, which
   hints at 30 s and offers **Take over** at 90 s (D17). What a take over proposes comes from `takeoverPlan`: a fixed
   payload, the same question asked here (`ask`), or the phase's own screen (`custom`, through `request.takeover`).
4. **Apply.** Both clients get the same sequenced `Decision` back, check its payload with `isPayload`, and the phase
   applies it. The UI never changes the simulation directly in a linked run: only a sequenced decision does.

The other entry points follow the same pattern:

| Where | What |
|---|---|
| `switch-bridge.ts`, `coopDecideSwitch` | Faint and pivot replacements (D7), used by `switch-phase.ts` and `field/pokemon.ts` |
| `me-run.ts`, `meDecide` | Every choice of a Mystery Encounter as an `ME_CHOICE` (D29) |
| `src/phases/coop-turn-sync-phase.ts` | The turn: a window with one `TURN_COMMANDS` key per Pokémon on the field, all open at once; each client proposes the commands of the Pokémon it controls. Side actions and the side pick go through `coopDecide`; the Tera rule (D8) |
| `src/phases/select-modifier-phase.ts` | The reward screen: a `rewardWindow` per step with `awaitOneOf` (D9, D11, D28) |
| `src/phases/coop-trade-phase.ts` | The trade screen: `TradeState` gives the window of each step (D11) |

Who decides is never decided in a phase: `deciderOf` in `control.ts` answers it from the owner map, the controller of
a slot, the reward picker or the seat (D7, D9, D10). The host's validation (`validate.ts`) and both clients' legality
check (`legal.ts`) are separate on purpose: the first refuses a bad proposal before anyone applies it, the second makes
sure a sequenced decision that is still bad is refused identically on both sides.

## Determinism

- `sim-rng.ts`: `simRandInt` gives each simulation site that upstream draws from `Math.random` its own seeded stream in
  co-op, and keeps the unseeded draw in solo play. `commandTargetPick` draws the random target of a move like Outrage
  from its own stream, because only the chooser's client runs that command phase. `applyCoopRunSeed` applies the run seed.
- `sim-account.ts`: `simAccount()` is the live `gameData` in solo play and the run-start snapshot in co-op (D4).
  `writesForSeat` and `writesForPokemon` decide whether this client writes an account change (D4a).
- `pokemon-id.ts`: a colliding `pokemon.id` is redrawn the same way on both clients (D3).
- Call-site tests (`test/coop/rng-call-sites.test.ts`, `test/coop/account-call-sites.test.ts`) list every unseeded
  draw, wall-clock read and direct `gameData` read left in `src/`, each with its reason. Adding one fails them until it is
  listed with a reason, or made deterministic.

## Checkpoints, desyncs and resync

1. **Checkpoints.** `checkpoints.ts` hooks the hash points of D13 (`TurnInitPhase`, `EncounterPhase`, the reward options
   of `SelectModifierPhase`, `BattleEndPhase`). Each takes `state-hash.ts`'s hash into the session's `CheckpointLog`
   (`checkpoint-log.ts`). `tracePhaseStart` records every phase start in the `PhaseTrace` (`phase-trace.ts`) for reports.
2. **Exchange.** `checkpoint-exchange.ts` sends each checkpoint to the partner and compares it with the partner's of the
   same index, whichever arrives first. A mismatch calls `session.onMismatch`.
3. **Asking for a reload.** `resync-run.ts`, installed by `installResync`, turns a mismatch or a `DesyncError` into
   `wantResync`. A guest sends `RESYNC_REQUEST`; the host takes note.
4. **The safe point.** A reload abandons the running phase, so it waits for a safe point (`isSafePoint`): a decision
   gate, an open window, the command menus, the title screen, or a run that is already stuck on a desync.
5. **The reload.** The host's `issueResync` sends a `RESYNC` with the next `seq`, the new epoch and its wave-start save
   (or, on the third desync of a wave, `stop: true`). Both clients run `applyResync`: the link and the sequencer begin
   the new epoch, and `PhaseManager.coopRestartWith` replaces whatever runs with `CoopResyncPhase`
   (`src/phases/coop-resync-phase.ts`). That phase loads the save (`GameData.loadCoopSession`) and goes the way a solo
   retry goes: `EncounterPhase` with the loaded flag and the summon phases.
6. **Three strikes.** `ResyncBook` (`resync.ts`) counts the desyncs of each wave. On a stop both clients exchange their
   phase traces (`REPORT`) and offer a downloadable report.

Rejoin (D20), resume (D21) and the retry after a wipe (D4a) are the same reload with another reason.

## The cosmetic channel

Everything that only changes what the partner sees travels as `COSMETIC` (D16): intents and ready marks in battle, the
reward cursor, the encounter cursor, pings, emotes, and the pacing messages (D27).

- `cosmetic.ts` defines the messages, validates them and rate-limits them on both ends (`CosmeticSender`,
  `CosmeticReceiver`, a `TokenBucket` per kind). The link sends them with `sendVolatile`: no number, no resend.
- `cosmetic-view.ts` draws what arrives (ghost markers, check marks, the reward cursor, pings, emotes), with the field
  tags of `cosmetic-tag.ts`.
- `hotkeys.ts` handles the ping and emote buttons (`Button.COOP_PING`, `Button.COOP_EMOTE`), which are remappable game
  buttons (`hotkey-names.ts`); `touch-emote.ts` shows their touch buttons.
- They never touch the simulation: no RNG, no hashed state, no phase queue. `test/tests/coop/linked-cosmetic.test.ts`
  floods them and checks that every checkpoint hash is unchanged.

**Pacing** (D27) rides on the same channel. `pace.ts` (`PaceTracker`, pure) knows where a client is in the run's text;
`pace-run.ts` is the game side: `MessageUiHandler.showPrompt` reports each line that waits for a press, the host sends
`pace`, and the guest closes the lines the host is past and follows its speed settings.

## Saving

- **The wave-start save.** `saveCoopWaveStart` (`wave-save.ts`) runs in `EncounterPhase`, where a solo run calls
  `saveAll`. It saves this player's account, then the session save with its `coop` block (`save-block.ts`: the owner
  map, the account snapshots, `rewardPickCount`, …). The host writes it to its co-op slot; the guest keeps it in memory.
- **The co-op slot.** `coop-slot.ts` reads and writes the `localStorage` key `coopSlot` (never a solo slot): the save,
  both names and accounts, the last epoch and `seq` (D19). `updateSlotEpoch` keeps the epoch and `seq` current after a
  reload. The slot is removed when the run ends.
- **Loading.** A resync loads the save with `GameData.loadCoopSession`. `save-block.ts` refuses a co-op save in a solo
  game, a solo save in a co-op game, and a save of two other accounts.

## Diagnostics

- **The co-op log** (`coop-log.ts`, pure): what this browser's co-op sessions did, kept in memory and `localStorage`, and
  sent to the server if it collects logs (D26). `coop-diagnostics.ts` decides what a session writes into it and adds a
  snapshot of the game to a report; `report-button.ts` is the "Report a problem" button.
- **`window.__coop`** (`debug-api.ts`): the state of this client's co-op layer and inputs for the browser tests (press a
  button, read the screen and the phase, change the AFK timers, corrupt one HP value to force a desync, leave). Only dev
  and test builds install it, plus the browser-test image built with `COOP_E2E=1`; production builds do not even emit
  the module (`src/main.ts`).
- **`stall-detector.ts`** (dev only): dumps both clients after 20 s without progress.

## Tests

| Command | What runs |
|---|---|
| `pnpm test:coop:node` | Node-only tests, no Phaser: `test/coop/` and `coop-server/test/` (`vitest.coop.config.ts`) |
| `pnpm test:coop:game` | Tests that drive the real game: `test/tests/coop/` |
| `pnpm test:coop` | Both of the above |
| `pnpm test:ste` | The long runs, START-TO-ETERNATUS (a few minutes; or `COOP_STE=1` with any Vitest command) |
| `pnpm e2e` | Playwright, two browsers against the real relay (`pnpm e2e:quick` for the smoke and battle specs) |
| `pnpm test` | The whole game test suite, upstream's tests included, which must stay green |

- **Node tests** (`test/coop/`) cover the pure modules: the protocol, the transports, the sequencer (including a stress
  test), the handshake, epochs, keys, legality, take over, trade, cosmetics, pacing, the relay stack end to end
  (`relay-stack.test.ts` runs the real client transport against the real relay). Several iterate over `DECISION_KINDS`,
  so a new kind needs its cases there. Helpers: `fake-scheduler.ts` (virtual time), `manual-link.ts`,
  `legal-fixtures.ts`.
- **Record and replay** (`test/helpers/coop-harness.ts`, `test/tests/coop/replay.test.ts`). One client is a fresh game
  scene (`GameManager`) with its own account, local settings and co-op session. A scenario is played on it by a driver
  that takes every decision from a `Decider`: the policy while recording (as the host), the recorded log while replaying
  (as the guest). Both clients must pass the same state-hash checkpoints. The harness restores the real battle RNG,
  because the test framework's max-roll stub would hide every battle-RNG desync.
- **A scripted partner** (`test/helpers/coop-linked.ts`). One real game client whose decisions go through the sequencer,
  and a `ScriptedPartner` on the other end of an in-process link: the other seat's sequencer, which answers what the
  real client waits for, or what the test makes it propose, when the test says. `openLinkedRun` sets it up. The
  `test/tests/coop/linked-*.test.ts` files use it for battles, rewards, trades, take over, resync, legality, pacing,
  party edits, encounters and retries.
- **START-TO-ETERNATUS (STE)**, whole classic runs from the starters to the final boss with nobody at the keys:
  - STE-replay (`ste.test.ts`): the host plays and logs every decision; a second client with the guest's account and
    other local settings replays it to the same hashes.
  - STE-linked and STE-twin (`ste-linked.test.ts`): the real client plays the host against a scripted guest, then the
    same run as the guest against a scripted host. The two runs must pass the same checkpoints, which catches anything
    the owner's code path changes on one client alone.
  - The encounter tour (`ste-encounters.test.ts`): every Mystery Encounter, every option, played with the real client as
    the chooser and as the waiting player.
- **End to end** (`test/e2e/`, Playwright). `coop-client.ts` starts the real relay and two browser clients and drives
  them through `window.__coop`. `playwright.config.ts` starts the dev server; with `E2E_BASE_URL` the specs run against
  a game that is already running, such as a container built with `COOP_E2E=1`. Screenshots go to
  `test-results/screenshots/`.

## Module map

"Pure" means the module imports no game code (no `globalScene`, no Phaser), so both clients can run in one Node process
in tests. Keep it that way: nothing in a pure module may import a game module, directly or through another co-op module.

### Protocol and transport

| Module | What it does | Rules | Pure |
|---|---|---|---|
| `protocol.ts` | `Envelope` and message kinds, `DecisionKey`, `keyId`, `DECISION_KINDS`, `NO_REF`, the `HELLO`/`HELLO_ACK` payloads, `BuildIdentity`, the `START` payload, canonical JSON and its hash, `COOP_PROTOCOL_VERSION` | D1, D2, D3 | yes |
| `transport/transport.ts` | The `RawTransport`, `MessageTransport` and `Scheduler` interfaces | D2 | yes |
| `transport/relay-ws.ts` | The relay's WebSocket client: create, join, rejoin with a seat token | D2, D20 | yes |
| `transport/reliable.ts` | Numbering, selective acks, resend, dedupe, in-order delivery, volatile sends, a new pairing | D2, D20 | yes |
| `transport/loopback.ts` | An in-process transport pair with seeded drop, duplicate and reorder | D14 | yes |
| `epoch.ts` | `EpochTransport` (stamps the epoch; drops older, holds newer, a `RESYNC` always passes), `EpochChangedError` | D18 | yes |
| `relay-url.ts` | `relayUrlFor` (`VITE_COOP_RELAY_URL`, else `/coop` of the page's origin, `wss` on `https`), `logUrlFor` | D22, D26 | yes |

### Connection and session

| Module | What it does | Rules | Pure |
|---|---|---|---|
| `link.ts` | `CoopLink`: channel, epoch, sequencer, lobby, `START`, checkpoints, cosmetics, resync messages, partner presence and relink; `createRoom`, `joinRoom`, `rejoinRoom`, `establishHost`, `establishGuest` | D1, D2, D18, D20 | yes |
| `handshake.ts` | `hostHandshake`, `guestHandshake`: build check, the settings overlay through a port, the resume account check | D1, D21 | yes |
| `build-info.ts` | The local `BuildIdentity`: `gitSha` and `dirtyHash` from the build, the mode, the overrides hash | D1 | no |
| `pinned-settings.ts` | The pinned values, their validation, the overlay port for the settings manager | D5 | yes |
| `session.ts` | `CoopSession` (`null` in solo), `isCoop()`, `requireCoopSession`, `startCoopSession`, `endCoopSession`, `rewardPickerOf` | D1–D5 | yes |
| `lobby.ts` | The title screen's Co-op entry: host or join, the code, the handshake, `beginSession`, leaving | D1, D20 | no |
| `starter-lobby.ts` | The co-op starter select as a state machine: live picks, shared points, ready, `START` | D3, D4, D7 | yes |
| `starter-select-coop.ts` | The partner's picks, the shared limit and ready on the starter select screen | D3, D7 | no |
| `display-name.ts` | The player's display name, stored locally | D1 | yes |
| `clipboard.ts` | `copyText`, for the lobby's "Copy code" button | | yes |

### Decisions

| Module | What it does | Rules | Pure |
|---|---|---|---|
| `sequencer.ts` | `Sequencer`: `seq`, windows (`awaitDecision`, `awaitOneOf`, `awaitAll`), validation, parking, `REJECT`, take over, legality (`setLegality`), epochs (`resetForEpoch`, `reserveSeq`), `DesyncError` | D2, D17, D18, D24 | yes |
| `decision-keys.ts` | The keys of turn, switch and prompt decisions | D2 | yes |
| `prompt-payloads.ts` | Payloads of the prompts (learn-move, evolution, biome, catch release) and their guards | D2, D10 | yes |
| `turn-commands.ts` | A turn command on the wire and back; side action and side pick payloads | D2, D8 | yes |
| `bridge.ts` | `coopDecide`, `coopGate`, `isLinked`, `proposeUnlessLate`, the take over of bridge decisions, the waiting text | D2, D17 | no |
| `switch-bridge.ts` | `coopDecideSwitch`: faint and pivot replacements as decisions | D7 | no |
| `control.ts` | `ownerOf`, `controllerOf`, `switchTargets`, `deciderOf`, the party screen's switch filter | D7, D9, D10 | no |
| `validate.ts` | `validateProposal`: the host's check before it sequences | D2, D4a, D9, D10, D11, D28 | yes |
| `legal.ts` | `checkDecisionLegal` over a `LegalityView`, for every kind; never throws | D24 | yes |
| `legal-view.ts` | The game's `LegalityView`, read from `globalScene` when a decision is applied | D24 | no |

### Rules of the run

| Module | What it does | Rules | Pure |
|---|---|---|---|
| `ownership.ts` | The owner map `pokemon.id → seat`, `interleaveStarters` (the party order of a run) | D7 | yes |
| `arrange-plan.ts` | The wave-start arrange order: each seat's first legal Pokémon, the partner covers | D7 | yes |
| `arrange.ts` | `arrangeCoopParty`: the arrange step on the real party | D7 | no |
| `doubles.ts` | Forced doubles: which trainers have a usable `DOUBLE` variant | D6 | no |
| `reward-actions.ts` | The reward screen's actions, `rewardKey`, `rewardWindow`, who may make which, `isValidRewardProposal` | D2, D9 | yes |
| `trade.ts` | `checkTradeProposal` (gifts, counts), `applyTrade`, `TradeState` (the window of each trade step), the trade keys | D11 | yes |
| `party-edit.ts` | `PartyEdit` (swap, release, rename, evolution pause, form item, unsplice), `checkPartyEdit`, `partyEditKey` | D28 | yes |
| `party-edit-run.ts` | Which edits the party screen offers, `proposePartyEdit`, `applyPartyEdit` | D28 | no |
| `me-choice.ts` | `MeChoice`, `MeQuestion`, `checkMeChoice`, `meChoiceKey` | D29 | yes |
| `me-run.ts` | `meDecide`, the co-op encounter selection helpers, the seeded requirement check, who goes, the 2v2 battles, `passOwnership` | D29 | no |
| `retry.ts` | The `RETRY` payload of a wipe (`isRetryPayload`) | D4a, D13 | yes |
| `save-block.ts` | The `coop` block of the session save; refuses a co-op save in solo, a solo save in co-op, other accounts | D4, D7, D13 | yes |

### Determinism and desync detection

| Module | What it does | Rules | Pure |
|---|---|---|---|
| `sim-rng.ts` | `simRandInt` (a seeded stream per unseeded site), `commandTargetPick`, `applyCoopRunSeed` | D3 | no |
| `sim-account.ts` | `simAccount()`, `ownerSeat`, `captureAccountSnapshot`, `writesForSeat`, `writesForPokemon` | D4, D4a | no |
| `account-snapshot.ts` | `CoopAccountSnapshot`: both accounts at run start, as plain JSON | D4 | yes |
| `pokemon-id.ts` | Deterministic redraw until a `pokemon.id` is unique | D3 | yes |
| `state-hash.ts` | The hashed state: parties, fields, modifiers, RNG states, seeds, pinned settings, reward options | D9, D13 | no |
| `checkpoints.ts` | `coopCheckpoint` at the hash points, `coopRewardOptionsReady`, `tracePhaseStart` | D13 | no |
| `checkpoint-log.ts` | `Checkpoint`, `CheckpointLog`, the first-mismatch search | D13 | yes |
| `checkpoint-exchange.ts` | Sends each checkpoint's hash to the partner and compares | D13 | yes |
| `phase-trace.ts` | A ring buffer of phase starts (wave, turn, phase, RNG hash), its diff and dump | D13 | yes |

### Resync, saving and reconnecting

| Module | What it does | Rules | Pure |
|---|---|---|---|
| `resync.ts` | `ResyncPayload`, `RESYNC_REQUEST`, `REPORT`, `ResyncBook` (three strikes per wave), the report | D13 | yes |
| `resync-run.ts` | `installResync`, `wantResync`, `issueResync`, `applyResync`, the gate behind `coopGate`, the stop | D13, D18, D20, D24 | no |
| `wave-save.ts` | `saveCoopWaveStart` (in `EncounterPhase`), the slot, `updateSlotEpoch` | D19 | no |
| `coop-slot.ts` | The host's co-op slot (`coopSlot`): the wave-start save, the epoch, the last `seq`, both names and accounts | D19 | yes |
| `seat-store.ts` | Seat tokens (`coopSeat:<code>`) for the automatic rejoin at boot | D20 | yes |
| `rejoin.ts` | `tryAutoRejoin` (at boot), `hostContinue` ("Co-op, Continue") | D20, D21 | no |
| `reconnect-ui.ts` | The waiting screen: the partner, the room code, "End session" after 60 s | D20 | no |

### Cosmetics, take over and pacing

| Module | What it does | Rules | Pure |
|---|---|---|---|
| `cosmetic.ts` | The `COSMETIC` messages (`intent`, `cursor`, `meCursor`, `ping`, `emote`, `pace`, `press`), their validation, sender and receiver rate limits | D16, D27, D29 | yes |
| `cosmetic-view.ts` | Draws what the channel brings: ghost markers, check marks, the reward and encounter cursors, pings, emotes | D16, D29 | no |
| `cosmetic-tag.ts` | The framed tags and pointers that the cosmetic view draws on the field | D16 | no |
| `hotkeys.ts` | What the ping and emote buttons do, and on which screens | D16 | no |
| `hotkey-names.ts` | The ping and emote rows of the keyboard settings, their default keys (P, Q), the key name in hints | D16 | no |
| `labels.ts` | Co-op words in upstream screens: the "Co-op Clears" row of the stats, both names in the run history | D4a | yes |
| `touch-emote.ts` | The touch screen's ping and emote buttons (`#coopEmoteTouch`, `#coopPingTouch` in `index.html`) | D16 | yes |
| `takeover.ts` | `takeoverPlan` (what a take over decides per kind), `canTakeOver`, `AfkClock`, the default timers | D17 | yes |
| `afk.ts` | `AfkWatcher`: the hint at 30 s and the offer at 90 s | D17 | no |
| `overlay.ts` | `showOverlayMenu`: a small menu over whatever is on screen (the take over offer and menus, the emote wheel) | D16, D17 | no |
| `takeover-command.ts` | The menus that choose a move and a target for the partner's Pokémon | D17 | no |
| `pace.ts` | `PaceTracker`: positions in the text, shared lines, whether the guest is behind, whether a press fits | D27 | yes |
| `pace-run.ts` | The game side of pacing: line reports, `pace` and `press`, the speed overlay, `whenCoopBehind` | D27 | no |
| `text.ts` | `coopText`, `pingHint`: every co-op UI string | | yes |

### Diagnostics and other

| Module | What it does | Rules | Pure |
|---|---|---|---|
| `coop-log.ts` | The co-op log: entries, memory and `localStorage`, batched upload | D26 | yes |
| `coop-diagnostics.ts` | What the log records of a session, the game snapshot of a report, the stall note | D26 | no |
| `report-button.ts` | "Report a problem" (`#coopReport` in `index.html`) and the downloadable log | D26 | no |
| `debug-api.ts` | `window.__coop`, in dev, test and `COOP_E2E` builds only | D17, D22 | no |
| `stall-detector.ts` | Dev only: a dump of both clients after 20 s without progress | | no |
| `source-link.ts` | `sourceUrlOf`: the title screen's Source link (the build insists on one: `plugins/vite/require-source-url.ts`) | D25 | yes |
| `import-account.ts` | Reads an account exported from pokerogue.net (`.prsv` or JSON), fits a newer version's into this one | D31 | no |

### Game-side files outside `src/coop/`

| File | What co-op does there | Rules |
|---|---|---|
| `src/phases/coop-turn-sync-phase.ts` | Collects the turn's commands, side actions, side pick, the Tera rule, intents, the take over of a turn | D8, D16, D17 |
| `src/phases/coop-trade-phase.ts` | The trade phase after a reward screen | D11 |
| `src/phases/coop-resync-phase.ts` | The reload of the wave start, in a session that keeps its link | D13, D18, D20, D21 |
| `src/ui/handlers/coop-trade-ui-handler.ts` | The trade screen (`UiMode.COOP_TRADE`) | D11 |
| `src/ui/handlers/coop-join-form-ui-handler.ts`, `coop-name-form-ui-handler.ts` | The room code form and the display name form | D1 |
| `src/phases/select-modifier-phase.ts` | The reward screen as a window: pick, reroll, lock, buy, transfer, trade request, party edit | D9, D11, D28 |
| `src/phases/learn-move-phase.ts`, `evolution-phase.ts`, `select-biome-phase.ts`, `attempt-capture-phase.ts`, `switch-phase.ts` | Prompts and switches through the bridge | D7, D10 |
| `src/phases/encounter-phase.ts`, `turn-init-phase.ts`, `battle-end-phase.ts` | The wave-start save and the checkpoints | D13, D19 |
| `src/phases/game-over-phase.ts`, `post-game-over-phase.ts` | The shared run end and the retry after a wipe | D4a |
| `src/phases/egg-lapse-phase.ts`, `egg-summary-phase.ts`, `trainer-victory-phase.ts`, `victory-phase.ts` | Eggs, vouchers, the rewards of a lone encounter enemy | D29, D30 |
| `src/phases/mystery-encounter-phases.ts`, `src/data/mystery-encounters/utils/encounter-phase-utils.ts`, `encounter-pokemon-utils.ts` | Mystery Encounters | D29 |
| `src/battle-scene.ts` | `checkIsDouble`: every co-op battle is a double | D6 |
| `src/phase-manager.ts` | `coopRestartWith`: replaces whatever runs with the resync phase | D13 |
| `src/system/game-data.ts` | `loadCoopSession`; the run history entry with both names | D4a, D13, D19 |
| `src/ui/handlers/message-ui-handler.ts` | `showPrompt` reports each line to the pacer | D27 |
| `plugins/vite/coop-build-identity.ts`, `plugins/vite/require-source-url.ts` | The build identity; a production build without `VITE_SOURCE_URL` fails | D1, D25 |

## Where to start

### Adding a new decision kind

1. **`protocol.ts`**: add the kind to `DECISION_KINDS`. If a message shape changes incompatibly, bump
   `COOP_PROTOCOL_VERSION`.
2. **The key**: add a builder next to its kind (`decision-keys.ts`, or the area's module). `turn` is `battle.turn` only
   for decisions made inside a battle turn, else `0`. The `ref` must be unique within the wave and derived from the
   simulation (a `pokemon.id`, a step counter both clients count the same way), never a slot or a local counter (D2).
3. **The payload**: a type and an `is…Payload` guard (`prompt-payloads.ts` or the area's module).
4. **`control.ts`**: add the decision to `CoopDecision` and to `deciderOf`, so the phase can ask who decides.
5. **`takeover.ts`**: `takeoverPlan` switches over every kind and does not compile until the new one has a plan (a fixed
   payload, `ask`, or `custom`). Update `canTakeOver` if nobody may take it over.
6. **`validate.ts`**: what the host checks before it sequences a proposal of this kind.
7. **`legal.ts`**: what both clients check before applying it. If the check needs more of the state, extend
   `LegalityView` and fill it in `legal-view.ts`.
8. **The phase**: call `coopDecide` (or open a window with the sequencer) behind `isLinked()`, and apply the returned
   payload the same way on both clients.
9. **Tests**: Node tests (`test/coop/legal.test.ts`, `takeover.test.ts` and `protocol.test.ts` iterate over
   `DECISION_KINDS`; add the kind's legal and illegal cases), a game test with the scripted partner
   (`test/tests/coop/linked-*.test.ts`), and, if a full run can reach it, the STE scenarios.
10. **Docs**: add the kind to the table in D2 of [DECISIONS.md](DECISIONS.md), and to the take over table of D17.

### Adding a UI string

Use `coopText(key, defaultValue, vars)` from `text.ts`. Keys live in the `coop` i18n namespace; the English default is
in the call, because the locale files are upstream's and have no co-op entries yet. Variables use i18next syntax:

```ts
coopText("tookOver", "{{partner}} took over for you.", { partner: session.partnerName });
```

Words that appear inside upstream screens (the stats, the run history) are in `labels.ts`.

### Other common changes

| Change | Start at |
|---|---|
| A new random draw on a simulation path | Use the seeded battle RNG; if it must stay unseeded in solo, add a site to `COOP_RNG_SITES` in `sim-rng.ts`. The call-site tests will flag it either way. |
| Reading account data in the simulation | Read `simAccount()`, never `gameData` (D4); the account call-site test lists every direct read. |
| Writing account data | Gate it with `writesForPokemon` or `writesForSeat` (D4a). |
| New simulation state | Make sure `state-hash.ts` covers it, so a divergence shows up at the next checkpoint. |
| A new cosmetic message | `cosmetic.ts`: the type, its validation in `isCosmeticMessage`, a limit in `COSMETIC_LIMITS`; draw it in `cosmetic-view.ts`. |
| A new relay limit or option | `coop-server/src/limits.ts` and `main.ts`, then `coop-server/README.md`. |

Before sending a change, run `pnpm test:coop` and the full `pnpm test`: solo play must stay as upstream has it. Code
adapted from SunghoLee98/pokerogue (AGPL-3.0-only) keeps a header comment that credits it (D15).

## See also

- [DECISIONS.md](DECISIONS.md): the rules this code implements.
- [HOW-TO-PLAY.md](HOW-TO-PLAY.md): co-op for players.
- [HOSTING.md](HOSTING.md): running your own server.
- [The project README](../../README.md).
