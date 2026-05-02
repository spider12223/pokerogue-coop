# PokéRogue Co-op Multiplayer — Progress Handoff

This document is the single source of truth for the co-op multiplayer effort. It captures every architectural decision, file location, milestone state, and gotcha across M1 and M2a so a new chat can pick up cleanly.

---

## SECTION 1 — PROJECT OVERVIEW

**Goal.** Add 2-player co-op campaign multiplayer to PokéRogue. Both players run through the same roguelike run together. Battles are forced to dual battles. Player 1 (host) controls the LEFT pokémon (slot 0). Player 2 (joiner) controls the RIGHT pokémon (slot 1).

**Architecture: host-authoritative P2P over WebRTC via Trystero/Nostr.**
- Host's browser is the only authoritative simulator. The host runs the full PokéRogue phase queue: encounters, battles, biome progression, save sync.
- Joiner's browser is a **remote control + UI mirror**. The joiner sends only inputs across the wire (e.g. "I picked move 2, target 3" for slot 1). The joiner's screen renders state pushed from the host (M2c+ scope).
- Networking dep: **Trystero v0.24 with the Nostr strategy** (default; serverless; uses public Nostr relays for WebRTC signaling).
- Validation dep: **zod v4** for message schema validation. Discriminated union envelope.

**Milestone phasing.**
| Milestone | Scope | Status |
|---|---|---|
| **M1** | Hot-seat 2-player local: input gating in dual battles via two keyboard schemes, no networking | ✅ SHIPPED at commit `ef4041da` |
| **M2a** | Co-op lobby pipe: title menu entry, room codes, Trystero handshake, "Connected" state. NO battle integration. | ✅ SHIPPED at commit `c49a105f` |
| **M2b** | Public deploy of the fork so cross-machine smoke testing becomes possible | ✅ SHIPPED 2026-05-02 to `https://pokerogue-coop.netlify.app` (commit `714182bd86f` enabled guest mode; pivoted to Netlify after hitting Cloudflare Pages' 20,000-file deploy cap) |
| **M2c** | Networked play: NetworkCommandSource for joiner's slot, host pushes state snapshots, joiner renders via minimum-viable command panel | 🟡 IN PROGRESS — M2c.1 Foundation phase |
| **M2d** | Full battle render parity on joiner side, animation sync, switch/baton support, snapshot diffing, edge-case polish | NOT STARTED |

---

## SECTION 2 — STATE OF MILESTONES

### M1 — Hot-seat (SHIPPED)

Committed at **`ef4041da`**. Two keyboards, two players, dual battles. Input gating fully tested (5 test files, ~15 tests). All 442 / 442 test files passed at commit time.

Toggled via `Overrides.LOCAL_HOTSEAT_OVERRIDE: true` in `src/overrides.ts`. When on, hot-seat uses keymaps from `cfg-keyboard-hotseat-p1.ts` (P1 = arrows + Z/X) and `cfg-keyboard-hotseat-p2.ts` (P2 = WASD + Q/Shift + numbers).

### M2a — Lobby pipe (SHIPPED)

Committed at **`c49a105f`** on branch `multiplayer-coop`. 446/446 test files green, 4333/4333 tests. Two-tab smoke test passed locally before deploy.

Behavior:
- Tab 1: Title → Co-op → Host Co-op → lobby renders with code (e.g. `XTP7JV`).
- Tab 2: Title → Co-op → Join Co-op → form → enter code → lobby renders.
- Trystero/Nostr handshake completes within ~5 seconds.
- Both tabs reach `CoopState.kind = "CONNECTED"` and display "Connected (host)" / "Connected (joiner)".

### M2b — Public deploy (SHIPPED)

Live at **`https://pokerogue-coop.netlify.app`** as of 2026-05-02. Two-tab cross-origin co-op handshake works. Cross-internet tested between regular Chrome and Chrome incognito (separate Trystero peer IDs).

**Pivot story:** Started on Cloudflare Pages → build succeeded but deploy validation failed at the **20,000-file deploy limit** (full pokerogue dist has 34,086 files). Cloudflare Workers Static Assets free tier has the same 20k cap (the 100k limit is paid-tier only, requires Wrangler 4.34.0+). Pivoted to **Netlify free tier** which has no overall file count cap (only a 54,000-files-per-single-directory cap that we don't hit — largest dir is `images/pokemon/back` at 2,811 files). Total deploy: 700 MB, well under Netlify's 10 GB storage.

**Guest mode:** commit `714182bd86f` flipped `VITE_BYPASS_LOGIN=0 → 1` in `.env.production`. The deployed fork bypasses the login wall. All players play as `Guest`. Saves go to per-origin browser localStorage (isolated from `pokerogue.net`).

**Build settings on Netlify:**
- Build command: `pnpm build`
- Publish directory: `dist`
- Production branch: `multiplayer-coop`
- Env vars: `NODE_VERSION=24.9.0`, `PNPM_VERSION=10.33.2`
- Submodules (`assets/`, `locales/`) auto-clone via Netlify's default git-recurse-submodules behavior.

**Side note:** the asset pipeline trick is in [src/plugins/vite/vite-minify-json-plugin.ts:93-100](../src/plugins/vite/vite-minify-json-plugin.ts#L93). Despite its name, the plugin recursively copies `./assets/` and `./locales/` into `dist/` during build. Vite's `publicDir` is set to `false` for the build command, so Vite's normal public copy doesn't fire.

### M2c — Networked play (IN PROGRESS, M2c.1 phase)

Architecture is designed in M1 — `CommandSource` is the abstraction. M2a's `CoopSession` provides the transport. M2c's job:
- Plug a `NetworkCommandSource` into the joiner's slot on the host side.
- Host pushes state snapshots to joiner over Trystero.
- When host's `CommandPhase` fires for slot 1, host sends a `request-command` envelope; joiner UI opens; joiner sends `choose-command` back; host calls `phase.handleCommand(...)` with the network-delivered command.
- Joiner renders a **minimum-viable command panel** (text + HP bars + move buttons), NOT a full battle mirror. Full mirror is M2d.

**Phasing (each phase = one commit, tests green before next phase):**

| Phase | Scope |
|---|---|
| **M2c.1 Foundation** | New envelope types + zod schemas; `NetworkCommandSource` skeleton class; `coopMode` field on BattleScene; `Overrides.COOP_NETWORKED_OVERRIDE` + `Overrides.COOP_BOT_FILL_JOINER`; `TurnCommandManager.initCoopHost` / `initCoopJoiner` + `refreshFromOverrides` extension; tests |
| **M2c.2 State Snapshot** | `projectSnapshot()` pure function in `snapshot.ts`; `state-snapshot` envelope wiring host-side (send) + joiner-side (receive, store); tests |
| **M2c.3 Command Request Roundtrip** | Full `NetworkCommandSource.requestCommand` send-and-await; timeout machinery; CANCEL re-issue; bot-fill-joiner short-circuit; full integration test |
| **M2c.4 Joiner UI** | New `CoopCommandPanelUiHandler` (new UiMode); subscribes to coopSession events; move/switch/run buttons; target select overlay; idle state |
| **M2c.5 Run Start/End Integration** | "Start Co-op Run" button on lobby (host-only); `start-run` envelope; lobby ↔ run transitions on both peers; GameOverPhase → COOP_LOBBY routing |
| **M2c.6 Smoke + Polish** | Full test suite green; two-tab browser smoke; deploy to Netlify; cross-internet smoke; bug fixes that surface |

**M2c scope: FIGHT and RUN only for joiner.** Switch/Pokémon command, Pokeball, Tera, Mega all deferred to M2d. (See Section 4 sub-decision M2c.S5 below.)

### M2d — Polish (NOT STARTED)

Switch/Pokémon command for joiner; Pokeball/Tera/Mega; full battle render parity (sprites, animations, weather visuals, type-effectiveness hints); snapshot diffing protocol; reconnect-after-drop with grace period; mystery encounter joiner participation (currently host-only). No detailed design yet.

---

## SECTION 3 — ARCHITECTURE & FILE INDEX

### M1 files (all in repo at `ef4041da`)

**Core abstractions:**
- `src/multiplayer/input-role.ts` — `PlayerSlot`, `InputOwner`, `InputRole` discriminated union (`field-slot` | `party-slot` | `shared`).
- `src/multiplayer/input-source.ts` — `InputSource` interface, `InputEvent` shape, `SourceKind` / `SourceId` types.
- `src/multiplayer/keyboard-input-source.ts` — `KeyboardInputSource` impl with **per-source** `Set<Button> buttonLock` and `Map<Button, interval> repeatTimers`. NEVER share state across sources.
- `src/multiplayer/command-source.ts` — `CommandSource` interface + `LocalUiCommandSource` (just opens UI today; `NetworkCommandSource` is M2c).

**Broker:**
- `src/turn-command-manager.ts` — Grew from a stub into the full input-ownership broker. Owns `fieldSlotOwners`, `partySlotOwners`, `commandSources`. Implements `getCurrentInputRole()` (introspects `globalScene.phaseManager.getCurrentPhase()` and narrows on `phase.is("CommandPhase")` / `SelectTargetPhase` / `CheckSwitchPhase` / `SwitchPhase`), `shouldAcceptInput(event)`, `getCommandSource(role)`, `initSinglePlayer()` / `initHotseat()` / `refreshFromOverrides()`.

**Refactored existing:**
- `src/inputs-controller.ts` — coordinator pattern. Owns `Map<SourceId, InputSource>` registry. Replaces old `keyboardKeyDown`/`keyboardKeyUp` methods with per-source listeners. Keeps gamepad path inline (not refactored to GamepadInputSource). Calls `refreshFromOverrides()` from `BattleScene.newBattle` so test-time spies on `LOCAL_HOTSEAT_OVERRIDE` are picked up.
- `src/ui-inputs.ts` — `listenInputs` calls `turnCommandManager.shouldAcceptInput(event)` at the top of both `input_down` and `input_up` listeners; drops on mismatch.
- `src/phases/command-phase.ts` — `start()` runs invariants (resetCursorIfNeeded, handleFieldIndexLogic, checkCommander, skip checks, queued-move shortcut), then delegates UI-open via `source.requestCommand(this)`. Phase-level invariants stay on the phase per design adjustment.
- `src/phases/check-switch-phase.ts`, `src/phases/switch-phase.ts` — added public `getFieldIndex()` for broker narrowing.
- `src/touch-controls.ts` — `simulateKeyboardEvent` updated to emit new event shape with `sourceKind: "touch"`.
- `src/battle-scene.ts` — added `coopSession: CoopSession` field; `create()` calls `turnCommandManager.initSinglePlayer()`; `newBattle()` calls `inputController.refreshFromOverrides()` and `turnCommandManager.refreshFromOverrides()` at the top.

**Hot-seat keymaps:**
- `src/configs/inputs/cfg-keyboard-hotseat-p1.ts` — P1 keymap: arrows + Z/X/Enter/Backspace/Esc/etc. WASD/Q/E/Shift/Tab/numbers stripped (set to `-1`) so P2 can claim them.
- `src/configs/inputs/cfg-keyboard-hotseat-p2.ts` — P2 keymap: WASD = directions, Q = ACTION, Shift = CANCEL, Tab = SUBMIT, 1-9 = MENU/STATS/cycles, E = CYCLE_ABILITY.

**Override:**
- `src/overrides.ts` — `LOCAL_HOTSEAT_OVERRIDE: boolean` field; export changed from `satisfies` → `as InstanceType<typeof DefaultOverrides>` so dev-set literal types don't narrow downstream consumers.

**M1 tests** (in `test/tests/multiplayer/`):
- `command-phase-gating.test.ts` — 3 tests: P2 input dropped during P1 CommandPhase, P1 input accepted during P1 CommandPhase, P1 input dropped during P2 CommandPhase.
- `target-select-gating.test.ts` — 4 tests: same pattern for SelectTargetPhase. Required adding `"SelectTargetPhase"` to `endBySetMode` in `test/helpers/prompt-handler.ts`.
- `turn-resolution.test.ts` — 3 tests: queue holds at CommandPhase(1) until both slots commit; turn advances past command phases when both commit.
- `cancel-rollback.test.ts` — 3 tests: slot 0 cancel = no-op; slot 1 cancel re-pushes both CommandPhases; post-cancel ownership preserved.
- `key-repeat-isolation.test.ts` — 2 tests: P1 holding key during slot transition does not affect slot 1 cursor; repeat timer cleared after slot transition.

**M1 test-infra changes** (in `test/framework/`):
- `inputs-handler.ts` — added `pressKeyboardKeyForSlot(slot, key, durationMs)`. `FakeMobile` is now lazy-instantiated only when `pressTouch` is called (fixes the `window.document` global mutation that broke other tests). `destroy()` method added for clean teardown. Old `pressKeyboardKey` removed (clean break per design).

### M2a files

**Network layer (`src/multiplayer/network/`):**
- `room-code.ts` — `generateRoomCode()`, `isValidRoomCode()`, `normalizeRoomCode()`. 32-char alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no I/O/0/1). 6-character codes.
- `messages.ts` — zod discriminated union envelope: `hello` (with `version` + `role`), `ping`, `pong`, `disconnect` (with nullable `reason`). `parseEnvelope(raw)` returns `Envelope | null`. `COOP_PROTOCOL_VERSION = "m2a-1"`.
- `transport.ts` — `TrysteroTransport` class wrapping Trystero's `joinRoom` from `trystero/nostr`. Single `"msg"` action namespace. Lazy `open()`, idempotent `close()`. Handler arrays for peer-join / peer-leave / envelope. `sendEnvelope(envelope, targetPeer?)`. Constructor accepts optional `roomFactory` for test injection.
- `coop-session.ts` — `CoopSession extends Phaser.Events.EventEmitter`. State machine: `IDLE` / `HOSTING` / `JOINING` / `CONNECTED` / `ERROR`. Methods: `host()` / `join(code)` / `cancel()` / `disconnect()` / `retry()` / `dismiss()` / `destroy()`. 30s join timeout via injectable `joinTimeoutMs`. Emits `state-change`. Constructor accepts `transportFactory` for test injection. Constants: `COOP_APP_ID = "pokerogue-coop-v1"`, `COOP_JOIN_TIMEOUT_MS = 30_000`.
- `index.ts` — barrel re-exports.

**UI handlers:**
- `src/ui/handlers/coop-lobby-ui-handler.ts` — Custom `UiHandler` for `UiMode.COOP_LOBBY`. Full-canvas dim backdrop + centered 240×96 panel. Subscribes to `coopSession.state-change` events on `show()`. Renders state-driven status / code / hint text. Uses **negative-Y coordinates** (matches `run-history-ui-handler` pattern) since UI's anchor is at canvas-bottom. `show()` calls `getUi().bringToTop(this.container)` before `setVisible(true)` — critical, otherwise other handlers (like Title's `optionSelectContainer` brought to top during initial title show) render above the lobby. `processInput` only treats CANCEL as the exit key (ACTION is no-op for HOSTING/JOINING/CONNECTED) — this prevents key-repeat from spuriously cancelling the lobby.
- `src/ui/handlers/coop-join-form-ui-handler.ts` — Cloned the `RenameRunFormUiHandler` pattern (extends `FormModalUiHandler`). Single 6-char input field. On submit: `normalizeRoomCode` → `isValidRoomCode` → callback with normalized code on success, or in-modal error message documenting the alphabet on failure.

**Enum + UI registration:**
- `src/enums/ui-mode.ts` — appended `COOP_LOBBY` and `COOP_JOIN_FORM` to the end of the enum (preserves all existing enum values; can't shift them without breaking serialized save state and existing tests).
- `src/ui/ui.ts` — registered both new handlers at the end of the `handlers[]` array (matches enum order so `handlers[mode]` lookup works).

**Title menu integration:**
- `src/phases/title-phase.ts` — Added top-level **"Co-op"** option between "New Game" and "Load Game" with `keepOpen: true`. New `openCoopSubmenu()` private method opens an `OPTION_SELECT` overlay with **Host / Join / Cancel** sub-options. Host calls `coopSession.host()` then sets `(handlers[UiMode.TITLE] as TitleUiHandler).suspended = true` + `resetModeChain()` + `setMode(COOP_LOBBY)`. Join opens the form; on submit does the same setup and joins.
- `src/ui/handlers/title-ui-handler.ts` — Added `public suspended = false` field. `updateTitleStats()` early-returns when `suspended` is true (prevents the 60s `setInterval` poll from doing anything while in lobby). `show()` resets `suspended = false` so a fresh TitlePhase reactivates polling automatically.

**Battle scene wiring:**
- `src/battle-scene.ts` — `coopSession: CoopSession = new CoopSession()` field added beside `turnCommandManager`. Single instance per scene.

**M2a tests** (`test/tests/multiplayer/network/`):
- `room-code.test.ts` — 14 tests: alphabet correctness, length, no-confusables, validation, normalization round-trip.
- `messages.test.ts` — 15 tests: every variant round-trips through `envelopeSchema.safeParse`; malformed payloads rejected; `parseEnvelope` discriminator narrowing.
- `transport.test.ts` — 13 tests: room factory called with right config, action wired correctly, peer/envelope forwarding, malformed envelope drop, send routing, idempotent close, reopen after close. Uses an in-file `MockRoom` test fixture.
- `coop-session.test.ts` — 21 tests: every state transition + edge cases (timeout clears on connect, version mismatch, code normalization, retry preserving last code, peer-leave clean exit). Uses `vi.useFakeTimers()` for the 30s timeout test. Fake transport injected via `transportFactory`.

**Test infra additions:**
- `test/helpers/prompt-handler.ts` — added `"SelectTargetPhase"` to `endBySetMode` array so the phase interceptor pauses at TARGET_SELECT during gating tests.

**Dependencies:**
- `package.json`: `trystero@^0.24.0`, `zod@^4.4.1`.

---

## SECTION 4 — KEY DESIGN DECISIONS

These are the load-bearing choices. Pulled forward from earlier planning docs.

### Per-source state, never shared

`KeyboardInputSource` owns its own `Set<Button> buttonLock` and `Map<Button, interval> repeatTimers`. These were originally shared at the `InputsController` level (flat array `Button[]`), which broke when two sources pressed the same Button — the array dedup'd them. Per-source state is the foundation of M1 multi-keyboard correctness. **Do not unify these across sources.**

### CommandSource is role-based, not slot-based

`InputRole` discriminated union: `{ kind: "field-slot", fieldIndex: 0 | 1 }` | `{ kind: "party-slot", partyMemberIndex: number }` | `{ kind: "shared" }`. M1 only uses `field-slot`. `party-slot` is reserved for M2c/M2d (LearnMovePhase, EvolutionPhase — those use `partyMemberIndex`, not `fieldIndex`). `shared` is the default for any phase the broker doesn't recognize — all current non-co-op gameplay falls here, so the broker is invisible to existing tests.

### Host is authoritative; joiner is remote control + UI mirror

Joiner's tab does NOT run phases. M2c will introduce a separate render mode where the joiner subscribes to host-pushed state snapshots and renders them. The joiner runs UI handlers (CommandUiHandler etc.) only when the host's `NetworkCommandSource` requests an input from slot 1. **Do not propose "phantom phases" on the joiner.**

### TurnCommandManager broker lives on BattleScene

Single instance per scene. Reset via `BattleScene.reset()`. Test infra already has scene-level mocking patterns. **Do not move it to a module singleton or a different owner.**

### LOCAL_HOTSEAT_OVERRIDE flag

`Overrides.LOCAL_HOTSEAT_OVERRIDE: boolean = false`. When true:
- `InputsController.refreshFromOverrides` registers two keyboard sources (HOTSEAT_P1 + HOTSEAT_P2) instead of one.
- `TurnCommandManager.initHotseat()` registers two `LocalUiCommandSource`s, one per slot.
- Read at battle-start time (not scene-create) via `BattleScene.newBattle()` so test-time `vi.spyOn` works.

### Trystero / Nostr / single "msg" action / zod envelopes

- `import { joinRoom } from "trystero/nostr"`. Default Nostr strategy works without API keys, decentralized relays.
- ONE Trystero action named `"msg"`. All envelopes go through it. Per-message-type fan-out happens client-side (`switch (envelope.type)`).
- Every received message → `envelopeSchema.safeParse` → drop on failure. Network attack-surface defense.
- `appId = "pokerogue-coop-v1"`. Bumping the suffix invalidates incompatible client versions.
- Room code derives session encryption (no separate password param).

### Hello handshake on peer-join

- Both peers call `room.onPeerJoin` and immediately send `{ type: "hello", version, role }` to the new peer.
- Both peers receive the other's hello via `onEnvelope`. Validate version match. If matched, transition `HOSTING/JOINING → CONNECTED`. If not, transition to `ERROR` (recoverable=false).
- This is the M2a connection threshold. M2c will add subsequent message types (state-snapshot, request-command, choose-command, etc.) to the same envelope discriminated union.

### setMode vs setOverlayMode + modeChain

Hard-learned rule: `setOverlayMode` pushes to `modeChain` but doesn't clear the previous handler. The previous handler stays in the modeChain with its containers visible and timers running. To leave a "top-level destination" (like the lobby), you must EITHER `resetModeChain()` + suspend the underlying handler's side effects (e.g. `TitleUiHandler.suspended = true` to stop the stats poll), OR end the underlying phase via `this.end()`. M2a uses the suspend approach since the lobby is UI-only inside the still-running TitlePhase.

### bringToTop + negative-Y coords for full-canvas UI handlers

UI is at `(0, scaledCanvas.height)` inside `uiContainer`. `uiContainer` has `setScale(6)`. Children render with NEGATIVE Y to be on the visible canvas. Full-canvas backdrop = `rectangle(0, 0, scaledWidth, -scaledHeight)` with origin `(0, 0)`. Match `run-history-ui-handler.ts` exactly. Also call `getUi().bringToTop(container)` in `show()` — otherwise other handlers' previously-bringToTop'd containers (like Title's `optionSelectContainer`) render on top.

### CANCEL-only exit in lobby

`CoopLobbyUiHandler.processInput` treats only `Button.CANCEL` as the exit. ACTION is a no-op for HOSTING/JOINING/CONNECTED states. Originally both ACTION and CANCEL exited, which caused intermittent cancellation when key-repeat from the original "Host Co-op" Z-press fired ACTION on the new lobby mode within 250ms. Single-button discipline = no race.

### M2c-specific decisions (resolved 2026-05-02)

**M2c.S1 — Joiner rendering = minimum viable, not full mirror.** Joiner gets a command-picker panel (HP bars + move buttons + recent log lines) instead of a full Phaser BattleScene render. Full mirror is M2d. *Why:* risk surface, faster iteration, decoupled from network protocol so M2d swap is non-breaking.

**M2c.S2 — State sync = full snapshots, not diffs.** Host re-sends a complete `BattleSnapshot` on each meaningful event. Diff protocol is M2d if performance dictates. *Why:* correctness and debuggability over efficiency for an MVP. Snapshots are 5-15 KB; WebRTC handles them comfortably.

**M2c.S3 — Snapshot projection is a pure function.** `projectSnapshot(scene): BattleSnapshot` lives in its own file (`src/multiplayer/network/snapshot.ts`). No Phaser dependencies leak into the message layer. *Why:* unit testable without booting a full BattleScene; keeps network layer clean.

**M2c.S4 — Command request roundtrip uses `requestId` (uuid) for correlation.** Host generates a uuid per request, joiner echoes it in the response. Timeout default 60s (configurable via `Overrides.COOP_COMMAND_TIMEOUT_MS`). On timeout, host falls back to `Command.FIGHT` with first usable move + default targets, logs to host's battle log. *Why:* uuids defend against accidental session-reset collisions; 60s is generous for a casual co-op game; default-fight fallback is recoverable.

**M2c.S5 — M2c scope = FIGHT and RUN for joiner only.** Switch/Pokémon command, Pokeball, Tera, Mega all deferred to M2d. CheckSwitchPhase/SwitchPhase network surface is non-trivial. *Why:* scope discipline; ship a playable minimum.

**M2c.S6 — Joiner pokémon ownership = shared party.** Same model as M1 hot-seat: host owns the run; joiner sees host's party; joiner controls slot 1's pokémon and (in M2d) can switch in any party member not on the field. *Why:* matches the project goal ("Both players run through the same roguelike run together"); simpler than tag-team-format alternatives.

**M2c.S7 — Joiner save data = none for M2c.** Host owns the run state. If host disconnects, joiner has no run to continue. Real save sync is a future-milestone concern. *Why:* localStorage-per-origin is unidirectional from host; full save sync would be an architectural pivot.

**M2c.S8 — Mystery encounters = host runs entire ME, joiner observes via snapshot.** Joiner doesn't participate in ME UIs. *Why:* MEs have non-battle UIs (item rewards, NPC dialogues, encounter choices); designing joiner-side ME participation explodes M2c scope.

**M2c.S9 — Pokémon names in snapshots = pre-localized strings.** Snapshot includes `name: string` (already localized on host). `nameKey` for joiner-side localization is correct long-term but defers to M2d. *Why:* simpler MVP wire format; localization parity not critical when both peers run the same i18next setup.

**M2c.S10 — Run-end on disconnect = continue solo.** When joiner disconnects mid-run, host continues solo: NetworkCommandSource auto-falls back to default-move on every slot 1 request. Host battle log shows "Joiner disconnected" banner. *Why:* pokerogue runs are long; aborting destroys progress unnecessarily. Joiner-on-host-disconnect goes to title (joiner has no authoritative state).

**M2c.S11 — `coopMode` runtime field, `COOP_NETWORKED_OVERRIDE` dev-only.** Two distinct knobs: `globalScene.coopMode: "single" | "host" | "joiner"` (set programmatically by the lobby Start button); `Overrides.COOP_NETWORKED_OVERRIDE: false | "host" | "joiner"` (committed to overrides.ts only for dev testing). Plus `Overrides.COOP_BOT_FILL_JOINER: boolean` — when true on a host, NetworkCommandSource auto-responds to its own `request-command` with a default move (no envelope sent). *Why:* runtime field for production; override for solo dev iteration without two browsers; bot-fill for fast inner-loop testing.

---

## SECTION 5 — IMMEDIATE NEXT STEPS FOR NEW CHAT

**Current phase: M2c.1 Foundation.** Tests can be written test-first; production code requires user spec-approval before being written.

### M2c.1 — Foundation (CURRENT)

Wire-format and skeleton work. After this phase: all the new types compile, but no production behavior changes (the `coopMode` field defaults to `"single"`, the override defaults to `false`, so nothing actually triggers the new code paths until M2c.5 lights them up).

**Production code planned in M2c.1:**
- `src/multiplayer/network/messages.ts` — add new envelope schemas: `state-snapshot` (placeholder payload, refined in M2c.2), `request-command`, `choose-command`, `cancel-command-request`, `start-run`. Extend `envelopeSchema` discriminated union. **Do NOT bump `COOP_PROTOCOL_VERSION` in this phase** — wait until M2c.5 when the integration code lights up the new types in real connections (see Section 4 sub-decision: bump on integration, not on plumbing).
- `src/multiplayer/network/network-command-source.ts` — NEW. Skeleton class implementing `CommandSource`. `requestCommand()` is a no-op stub in this phase; real send/await machinery comes in M2c.3. Constructor takes `(playerSlot, session, opts)`. Has `cancelPending()` that clears any timer and zeroes pending state.
- `src/turn-command-manager.ts` — add `initCoopHost()` and `initCoopJoiner()` methods. Extend `refreshFromOverrides()` to route through a `resolveCoopMode()` helper that prefers `globalScene.coopMode` runtime field, then `Overrides.COOP_NETWORKED_OVERRIDE`, then `Overrides.LOCAL_HOTSEAT_OVERRIDE`, then default single-player.
- `src/battle-scene.ts` — add `coopMode: "single" | "host" | "joiner"` field, default `"single"`. Reset to `"single"` in `BattleScene.reset()` (parallel to existing reset behavior).
- `src/overrides.ts` — add `COOP_NETWORKED_OVERRIDE: false | "host" | "joiner"` (default `false`) and `COOP_BOT_FILL_JOINER: boolean` (default `false`).

**Test-first files for M2c.1:**
- `test/tests/multiplayer/network/messages.test.ts` — extend with round-trip + reject-malformed tests for the 5 new envelope types.
- `test/tests/multiplayer/network/network-command-source.test.ts` — NEW. Skeleton tests: constructor accepts the right args; `kind === "network"`; `playerSlot` exposed; `cancelPending()` clears state. Behavioral tests come in M2c.3 (don't try to write request/response tests here — the methods are no-op stubs).
- `test/tests/multiplayer/turn-command-manager.test.ts` — NEW. `initCoopHost` registers `LocalUiCommandSource` for slot 0 and `NetworkCommandSource` for slot 1. `initCoopJoiner` registers `LocalUiCommandSource` for slot 1 only. `refreshFromOverrides` routing: coopMode runtime → init methods; override second; hotseat third; single-player default.

**M2c.1 done criteria:**
- Full suite green (target: 449+ test files, 4350+ tests).
- Spec-approved before any production file is touched (test-first allowed without preview).
- One commit, message format `M2c.1: foundation — envelope types, NetworkCommandSource skeleton, TurnCommandManager coop init`.

### After M2c.1

Phases M2c.2 → M2c.6 follow per the table in Section 2. Each its own commit, tests green before next phase. Don't skip.

---

## SECTION 6 — KNOWN POLISH ISSUES (NOT BLOCKERS)

- **Lobby backdrop bleed-through on right edge.** The 0.85-alpha black backdrop covers the canvas, but the title menu's `optionSelectContainer` (which was `bringToTop`'d during initial Title.show) sometimes peeks through on the right edge of the screen at certain canvas resize ratios. Functional, just a visual seam. Fix would be ~5 lines.
- **Cancel-via-key-repeat was theoretically possible during the diagnostic session.** Last test pass didn't reproduce it after the CANCEL-only fix landed. If it shows up again in M2c (when more buttons get meaningful actions in the lobby UI), revisit.
- **`updateTitleStats` console errors fire constantly during local dev** because `rogueserver` (the title-stats backend) isn't running. Harmless — `getGameTitleStats` catches and returns null. Will go silent in production where the server is reachable.
- **The 30s join timeout is pessimistic for local same-machine.** Two Chromium tabs on `localhost` typically connect within 1-3 seconds. Cross-internet may be slower. Tune later if user reports timeout-fires-on-real-connections in M2b smoke.

---

## SECTION 7 — USER PREFERENCES

- **User:** Zayed, 18, Ras Al Khaimah UAE. Windows 10 with `cmd.exe`. Treat `cmd.exe`-style command quoting where it matters.
- **No code comments in production.** Debug comments allowed during active diagnostic sessions but stripped in the cleanup commit before merge.
- **Test-first development.** Failing test → red bar → implementation → green bar. Every M1 and M2a test was written before (or alongside) the corresponding production code.
- **Phased milestones with commit after each.** Don't merge halfway through a milestone. Don't roll multiple milestones into one commit.
- **Don't pivot architecture without explicit user approval.** When in doubt, propose, stop, await approval. The user has corrected my course several times — they want oversight on direction changes.
- **Stop and ask if anything diverges from the plan.** Don't silently improvise.

---

## SECTION 8 — WHAT NOT TO DO

- **Do NOT pivot to a separate desktop app (Electron / Tauri / standalone Node).** The user evaluated this option and ruled it out. Web-first.
- **Do NOT remove or rewrite the InputSource / CommandSource architecture.** It survived M1 testing and is the explicit foundation for M2c.
- **Do NOT extract the joiner into a separate CLI / standalone client.** Joiner is the same web app, in a different mode.
- **Do NOT skip the [coop] log cleanup commit.** It must be a clean separate commit before M2a merges.
- **Do NOT rename `LOCAL_HOTSEAT_OVERRIDE`** or move it out of `Overrides`. Existing tests and dev workflows reference it.
- **Do NOT change `appId = "pokerogue-coop-v1"`** without a coordinated release. Bumping the suffix breaks all existing host/joiner pairs across versions.
- **Do NOT migrate to a different Trystero strategy** (BitTorrent / MQTT / Firebase / IPFS) without exhausting Nostr first. Nostr works locally and is decentralized; alternatives have known drawbacks (Firebase needs an API key, BitTorrent has flaky relays in some regions, etc.).

---

## SECTION 9 — OPEN QUESTIONS

Items resolved during M2c planning (2026-05-02) are now in Section 4 sub-decisions M2c.S1–M2c.S11. Remaining open questions:

- **Explicit `relayUrls` fallback.** Trystero's default Nostr relay list may have outages. Should we pin a specific subset for reliability? Or detect failure and rotate? Decision can wait until cross-internet smoke testing during M2c.6 surfaces real reliability data on the deployed site.
- **Backdrop full-canvas coverage edge case** (handoff Section 6 visual seam on the lobby's right edge). Is it an alpha-blend artifact, a coordinate rounding issue, or actually a different handler peeking through? Worth ~30 min of investigation in a quiet moment. Not blocking M2c.
- **Reconnect after peer drop mid-battle.** Per M2c.S10, M2c continues solo on disconnect. M2d should reconsider: trystero supports manual relay reconnection — should we attempt to reconnect for a grace period (e.g. 30s) before falling back to solo? UX question for M2d, not M2c.
- **Snapshot diffing** (M2d). Current decision (M2c.S2) is full snapshots every event. If M2c.6 cross-internet smoke shows latency or bandwidth pain, M2d should add diff-based updates. Open architecture work.
- **Animation event channel** (M2d). For full-mirror joiner rendering, host needs to push more than state — needs to push events ("Foe Pidgey used Tackle on slot 1"). Either a separate `battle-event` envelope type, or embed events in snapshots. Defer until M2d's full-mirror design phase.
- **Joiner save data** (post-M2d). M2c.S7 says no save sync; if the project later wants a co-op-aware save format (each player has their own progress on a shared run), this is a major architectural item.

---

*Document last updated 2026-05-02, after M2b shipped to https://pokerogue-coop.netlify.app and the M2c plan was finalized with Q1-Q8 resolved as sub-decisions M2c.S1-M2c.S11 in Section 4. Current phase: M2c.1 Foundation, awaiting spec approval before production code.*
