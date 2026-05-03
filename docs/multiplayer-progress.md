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
| **M2c** | Networked play: NetworkCommandSource for joiner's slot, host pushes state snapshots, joiner renders via minimum-viable command panel | ✅ SHIPPED 2026-05-03. M2c.1–M2c.5 + M2c.6 phases A/B/C/D all passed. Cross-internet WebRTC verified across separate ISPs. Production HEAD: `57ee83e0fc7` |
| **M2d** | Full visual mirror on joiner side (real Phaser BattleScene render, sprites, animations, HP bars, weather, modifiers) — see Section 10 planning notes | NOT STARTED |

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

### M2c — Networked play (SHIPPED)

**Phase commits:**
| Phase | Commit | Scope |
|---|---|---|
| M2c.1 Foundation | `b95cfcaccc1` | Envelope types, NetworkCommandSource skeleton, TurnCommandManager coop init |
| M2c.2 State Snapshot | `d8a620532d1` | `projectSnapshot()` pure function, SnapshotStore, snapshot-update event, schema narrowing |
| M2c.3 Command Roundtrip | `127415cce90` | NetworkCommandSource state machine, timeout, bot-fill, cancel-rollback |
| M2c.4 Joiner UI | `8eabae027c3` | CoopCommandPanelLogic, CoopCommandPanelUiHandler, target picker, MessageLog capture, multi-target default fix |
| M2c.5 Run Integration | `cbfe823aaab` | Start Co-op Run button, joiner panel entry via TitlePhase ui mode juggling, run-end protocol, disconnect handling, FakeCoopSession integration tests |
| M2c.6 Phase A fix | `57ee83e0fc7` | Title UI bleed-through fix: `TitleUiHandler.clear()` called when entering co-op run |

**M2c.6 Phase A — Local dev two-tab smoke (PASSED 2026-05-02):**
- `pnpm start:dev`, two browser tabs (regular + incognito) at `localhost:8000`
- Co-op → Host on A, Co-op → Join with code on B → both reach Connected
- A clicks ACTION on lobby → Start Co-op Run flow:
  - A enters new game (starter select, etc.)
  - B's UI flips to COOP_COMMAND_PANEL automatically
- First battle: A picks for slot 0 via local UI; B's panel shows foes / ally / self / moves with PP / RUN button / log lines
- B picks a move → host's slot 1 CommandPhase resolves → turn advances on both sides
- **Initial bug found and fixed:** title menu options (Continue/New Game/Co-op/etc.) bled through onto the battle UI on host side because `TitleUiHandler.clear()` was never called when transitioning to a co-op run. Fixed by replacing the wrong `suspended = false` line in `startCoopRun` with a direct `clear()` call. Plus defensive `clear()` in `TitlePhase.start()` CONNECTED branch for post-run safety.

**Test count progression** (production tests across the project):
| Milestone | Tests | Files |
|---|---|---|
| M1 final | 4255 | 442 |
| M2a final | 4333 | 446 |
| M2c.1 | 4366 | 448 |
| M2c.2 | 4389 | 450 |
| M2c.3 | 4415 | 450 |
| M2c.4 | 4443 | 452 |
| M2c.5 | 4463 | 453 |
| **Current** | **4463** | **453** |

**M2c.6 phases B/C/D — All passed 2026-05-03:**
- **Phase B** — `pnpm build` + `pnpm preview` at `localhost:4173`: full co-op flow ran on the production bundle. No build-mode-only regressions surfaced.
- **Phase C** — Netlify auto-deploy from `git push`: deployed build at `https://pokerogue-coop.netlify.app` ran the co-op flow end-to-end.
- **Phase D** — Cross-internet smoke: tested with a peer on a different ISP. Trystero/Nostr WebRTC handshake completed; full battle round-trip worked.

**Cross-internet validation:** the default Nostr relay set in Trystero v0.24 carried signaling correctly across real-world networks without any custom `relayUrls` configuration. Open question on `relayUrls` fallback (Section 9) can stay open as a hardening item but is no longer pressing — no reliability pain in the smoke window.

**Wins for M2c:**
- Networked co-op battles work end-to-end: joiner picks → host resolves → both tabs advance turn.
- Single discriminated-union envelope architecture grew from 4 message types (M2a) to 9 (M2c) with zero schema-side regressions. Every received message still funnels through `envelopeSchema.safeParse`.
- Pure-function `projectSnapshot()` keeps Phaser dependencies out of the wire layer — unit-testable and future-proof for the M2d swap to a richer mirror payload.
- 60s command timeout + bot-fill fallback means a stuck or disconnected joiner never blocks the host's turn.
- Run-end + disconnect protocols handle "joiner left mid-run" cleanly: host continues solo with a banner; joiner returns to title (per M2c.S10).
- Title UI bleed-through bug caught and fixed in phase A before any deploy. Defensive `clear()` in `TitlePhase.start()` CONNECTED branch covers post-run safety.
- Cross-internet WebRTC validated end-to-end with no relay tuning needed.
- Test count: 4333 (M2a) → 4463 (M2c.5) across 446 → 453 files. No regressions through any phase.

**M2c scope: FIGHT and RUN only for joiner.** Switch/Pokémon command, Pokeball, Tera, Mega all deferred to M2d (see Section 4 sub-decision M2c.S5 and Section 10 planning notes).

### M2d — Full Visual Mirror (NOT STARTED — see Section 10)

Switch/Pokémon command for joiner; Pokeball/Tera/Mega; full battle render parity (real Phaser BattleScene with sprites, animations, weather visuals, modifier UI, type-effectiveness hints); snapshot diffing protocol; reconnect-after-drop with grace period; mystery encounter joiner participation (currently host-only). Detailed planning notes in Section 10 below; no code yet.

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

**M2c is shipped (2026-05-03).** The next milestone is **M2d — full visual mirror.** Detailed planning notes in Section 10.

**Before any M2d code:**
1. Read Section 10 in full, especially the two open scope decisions captured 2026-05-03 — joiner role in `ModifierSelectPhase` (lean: Option A for M2d.1) and trainer-battle compatibility risk (verify early in M2d.1's first dev cycle).
2. Spec the M2d.1 phase in detail — `MirrorBattleScene` vs branched `BattleScene`, snapshot extension fields, asset-loading flow on joiner.
3. Get explicit user approval on the spec before writing production code.
4. Tests-first; one phase per commit; no jumping ahead.

The detailed M2c.1–M2c.6 phase plans previously in this section are preserved in the commit history (see commits `b95cfcaccc1` through `57ee83e0fc7`) and in Section 2's phase table. They no longer apply to active work.

### Pre-M2d empirical testing (in flight)

Zayed is running cross-machine sessions with a friend before M2d planning begins, to surface any edge cases the smoke phases didn't catch (long sessions, weird wild encounters, modifier interactions, etc.). Capture findings here before kicking off M2d.1.

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

- **Explicit `relayUrls` fallback.** Trystero's default Nostr relay list may have outages. M2c.6 cross-internet smoke (2026-05-03) showed no reliability pain — default relays carried signaling fine across separate ISPs. Question stays open as a long-term hardening item but is no longer pressing; revisit only if M2d / M2e cross-internet sessions surface real outages.
- **Backdrop full-canvas coverage edge case** (handoff Section 6 visual seam on the lobby's right edge). Is it an alpha-blend artifact, a coordinate rounding issue, or actually a different handler peeking through? Worth ~30 min of investigation in a quiet moment. Not blocking M2c.
- **Reconnect after peer drop mid-battle.** Per M2c.S10, M2c continues solo on disconnect. M2d should reconsider: trystero supports manual relay reconnection — should we attempt to reconnect for a grace period (e.g. 30s) before falling back to solo? UX question for M2d, not M2c.
- **Snapshot diffing** (M2d). Current decision (M2c.S2) is full snapshots every event. If M2c.6 cross-internet smoke shows latency or bandwidth pain, M2d should add diff-based updates. Open architecture work.
- **Animation event channel** (M2d). For full-mirror joiner rendering, host needs to push more than state — needs to push events ("Foe Pidgey used Tackle on slot 1"). Either a separate `battle-event` envelope type, or embed events in snapshots. Defer until M2d's full-mirror design phase.
- **Joiner save data** (post-M2d). M2c.S7 says no save sync; if the project later wants a co-op-aware save format (each player has their own progress on a shared run), this is a major architectural item.

---

## SECTION 10 — M2D FULL VISUAL MIRROR — STRATEGY (PLANNING NOTES)

This section is forward-looking. No code yet. Read before designing M2d implementation.

### Why M2c uses text-only joiner UI

Per **decision M2c.S1** (the (c) variant — "decision deferred"), M2c shipped a minimum-viable command panel: text-based rendering with HP bars, move buttons, opponent labels, and recent log lines. **No sprites, no animations, no weather visuals, no modifier UI.** The asymmetric UX is real but acceptable for an MVP — joiner can make every move-decision needed without seeing the visual battle.

The data needed for full visual rendering is mostly in `BattleSnapshot` already (`field` slots with species, HP, status, moves; weather; recentLog). What's missing is the *rendering pipeline on joiner* and the *event-stream protocol* for animations/transitions.

### What M2d adds

The joiner should see the host's actual Phaser `BattleScene` rendered against the snapshot data — not a recreated mini-game, but a faithful visual mirror:
- **Pokémon sprites** on field: slot 0, slot 1, foe 0, foe 1. Active poses, fainted states, status overlays (sleep, poison particles, etc.)
- **HP bar widgets** that animate when HP changes (smooth tween from old HP to new)
- **Battle log scrolling** that mirrors host's message flow at the same pace
- **Move animations** when a pokémon attacks — the actual Phaser animations the host plays
- **Weather effects** (rain particles, sun glare, sandstorm overlay)
- **Modifier UI** — held items, multi-hit counters, charge states (Solar Beam, Bide, etc.)
- **Switch/baton animations** when pokémon swap in/out
- **Faint animations** + return-to-pokeball
- **Mystery encounter scenes** (NPC dialogues, item rewards) — currently host-only; joiner observes via M2d
- **Pokeball / Tera / Mega button** support on joiner panel (currently deferred per M2c.S5)
- **Switch (Pokémon) command** support on joiner panel — joiner can pick a switch from party (M2c.S5 deferred)

### The data is mostly there; the rendering is the work

`BattleSnapshot` (M2c.2) carries:
- field positions with PokemonView (id, species, name, level, hp, maxHp, status, isShiny, moves with PP)
- weather (type, turnsRemaining)
- recentLog (last 5 messages)

For full mirror, snapshots get extended with:
- Active modifiers per pokémon (held items, multi-hit counters, charge, etc.)
- Stat stages (atk +1, spe -2, etc.)
- Battler tags (substitute, reflect, light screen, etc.)
- Field effects (entry hazards, terrain, screens, traps)
- Animation/event hints for the rendering pipeline

The renderer is the harder part: **joiner needs to drive its own `BattleScene` against the host's state**, but joiner's BattleScene isn't running phases. We'd need a `MirrorBattleScene` (or equivalent) that renders state without simulating turns. Big architectural piece.

### Risk areas

The hardest problems in M2d, in roughly likely-to-bite order:

1. **Animation timing drift between host and joiner.** Host plays a Tackle animation over 800ms; joiner plays one too — but starts on a slight delay (due to network latency) and may finish at a different time. If the *next* turn's request-command arrives on joiner before the previous animation completes, the panel state is stale. **Need:** event-stream protocol that joiner can buffer and play in order, with host waiting for joiner's "ready for next event" ack OR joiner skipping to current state if it falls behind.

2. **Partial mid-animation states.** Host sends a snapshot at "after Tackle, before HP tick"; joiner renders that state but the sprite is still mid-Tackle locally. Needs the joiner's BattleScene to know "I'm rendering the FROM state" vs "I'm rendering the TO state".

3. **Coarse snapshots are insufficient for animations.** A snapshot says "foe Pidgey HP went from 100 to 65" — but the visual needs "Pikachu lunges → Pidgey takes hit → HP bar animates from 100 to 65 → particle effect → message text scrolls". Host's BattleScene generates these events naturally; joiner needs them serialized. **Needs an event-stream envelope type:** `battle-event` with discriminated kinds (`move-used`, `damage-dealt`, `status-applied`, `pokemon-fainted`, `weather-changed`, `modifier-added`, `message-shown`, etc.). Likely the biggest design item in M2d.

4. **Sprite asset loading on joiner.** When a battle starts on host, host loads the Pokemon sprites for the encounter. On joiner, those sprites need to be loaded too. The joiner's BattleScene asset loading must fire on `state-snapshot` arrival (or `start-run`), not on a phase that joiner isn't running. **Needs:** rework of LoadingScene for joiner mode to load assets on-demand from snapshot data.

5. **Out-of-order Trystero delivery.** Trystero/WebRTC data channels are ordered per-channel, but if we use multiple channels (e.g. envelopes + animation events), ordering between channels isn't guaranteed. M2c uses a single `"msg"` action so ordering is fine — but M2d may need to keep that constraint or build a sequence-number system.

6. **Modifier UI rendering.** Host's modifier UI (held items, X tokens, etc.) is computed from BattleScene state. Joiner needs the modifier list in the snapshot AND the UI handler to render it. Modifier sprites get loaded on demand — same asset-loading concern as sprites.

7. **Edge cases that bite specifically on joiner side:**
   - **Evolutions:** trigger an evolution scene on host. Joiner needs the same scene played out. New envelope type or embed in event stream.
   - **Faints:** the visual sequence is multiple animations chained. Faint → return → switch in.
   - **Switches:** baton vs normal. Animation differs.
   - **Mystery Encounters:** non-battle UI flows. Joiner currently skips entirely (M2c.S8). M2d would need joiner to render the ME UI in observer mode.
   - **Dialogue boxes:** host-driven message flow. Joiner currently sees only the last 5 messages in `recentLog`; M2d needs full message playback.

### Joiner role in item rewards (ModifierSelectPhase) — open scope decision (captured 2026-05-03)

After M2c ships, `ModifierSelectPhase` still has no joiner-side UI. Three options on the table for M2d:

- **Option A — host picks alone, joiner watches via snapshot.** Simplest, ~1 day of work. Joiner sees the picked items reflected in the next state-snapshot but has no input on the choice. Default for M2d.1.
- **Option B — joiner suggests, host picks.** Collaborative, ~3 days. Joiner gets a non-binding pick UI; their suggestion appears on the host's modifier-select screen as a hint; host has the final click. Polish goal for after M2d.1 ships.
- **Option C — joiner gets own pick (parallel selection from a separate pool).** Changes game balance — runs effectively get double the modifier velocity. Not recommended; flagged here only so it's not re-litigated. Skip unless an explicit design pivot says otherwise.

**Decision (lean):** M2d.1 ships with Option A. Option B added later as a polish item once core rendering is stable. Option C off the table.

### Trainer battle compatibility — risk to verify early in M2d.1 (captured 2026-05-03)

PokéRogue has two battle kinds:
- **Wild encounters** — validated in the M2c.6 smoke phases. Co-op dual mode works.
- **Trainer battles** — UNVERIFIED for co-op dual mode.

**Risk:** trainer battles may auto-summon two of the host's pokémon (slots 0 and 1 both belong to host), leaving the joiner's intended slot 1 pokémon stuck on the bench. The joiner's `NetworkCommandSource` would then fire `requestCommand` for a pokémon that isn't on the field, or never fire at all because slot 1 is host-owned.

**Verify early in M2d.1's first dev cycle:**
1. Build, run a co-op session.
2. Force-progress to a trainer battle (existing dev override or in-game progression).
3. Confirm slot 1 on the field is the joiner's pokémon, not host's pokémon #2.
4. Confirm `NetworkCommandSource.requestCommand` fires for the joiner's pokémon and the round-trip works identically to wild battles.

If broken, fix before any other M2d.1 work — this is foundational and will block all trainer-battle play. Likely culprits: dual-battle slot-assignment logic in `EncounterPhase` or `SummonPhase`, or trainer-party generation paths that pre-date `coopMode` and don't respect it.

### Likely M2d phases

Detailed design discussion needed before code. Tentative phasing (subject to revision):

- **M2d.1 — Joiner BattleScene scaffolding.** New `MirrorBattleScene` or extend existing scene with `coopMode === "joiner"` branches. Sprite render against snapshot data. No animations yet — just static field state.
- **M2d.2 — Battle event envelope.** New `battle-event` envelope type with discriminated kinds (move-used, damage-dealt, faint, status, weather, etc.). Host pushes events as they happen. Joiner buffers and plays.
- **M2d.3 — Animation playback on joiner.** Joiner's MirrorBattleScene consumes battle-events and triggers Phaser animations. Includes HP bar tween, status overlays, basic move animations.
- **M2d.4 — Modifier UI + edge cases.** Joiner renders modifiers, handles faint sequences, baton switches, evolutions. The "everything else" phase.
- **M2d.5 — Mystery encounters.** Joiner observes ME UIs in passive mode. Probably 1-2 weeks alone.
- **M2d.6 — Snapshot diffing.** Optimization. Replace full-snapshot-every-event with diff-based updates. Reduces bandwidth. Only do if M2c.6 cross-internet smoke shows pain.
- **M2d.7 — Switch/Pokeball/Tera/Mega on joiner panel.** Adds the deferred command kinds from M2c.S5.
- **M2d.8 — Reconnect grace period.** Trystero auto-reconnect on peer drop, 30s grace. Per M2c.S10 deferral.

### Estimate

**2-3 weeks of evening builds.** Bigger than M2c (which was ~5 days of solid work). The complexity is real:
- M2d.1-M2d.3 are the meat and probably 60% of the time.
- M2d.4 is a long tail of edge cases.
- M2d.5 (mystery encounters) is its own beast.
- M2d.6-M2d.8 are smaller and could be skipped if not needed.

### Recommendation for the next chat

**Design discussion FIRST, then code.** Don't dive into M2d.1 implementation until the event envelope and animation strategy are spec'd:

1. Read the M2c.1-M2c.5 commits to understand what's already wired (NetworkCommandSource, BattleSnapshot, CoopSession event-routing).
2. Confirm the joiner's `BattleScene` approach vs a new `MirrorBattleScene`. Big architectural decision.
3. Spec the `battle-event` envelope type — discriminated kinds, ordering guarantees, ack protocol.
4. Decide on snapshot vs event-stream tradeoffs for each kind of state change. Some changes are best as snapshots (current HP, current weather), others as events (move played, status applied).
5. Decide on the asset-loading flow for joiner — does it preload on `start-run`, or lazy-load per-snapshot?
6. Then phase M2d.1 spec, get approval, write code.

Same workflow as M2c: spec → approval → tests-first → impl → run suite → commit per phase.

---

*Document last updated 2026-05-03, after M2c.6 phases B/C/D all passed and M2c shipped. Production HEAD `57ee83e0fc7`. Next chat: M2d planning per Section 10 above — start with the two open scope items (joiner role in ModifierSelectPhase, trainer-battle compatibility risk) before phasing M2d.1.*
