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
| **M2a** | Co-op lobby pipe: title menu entry, room codes, Trystero handshake, "Connected" state. NO battle integration. | ✅ FUNCTIONALLY WORKING — pending diagnostic log cleanup + final commit |
| **M2b** | Cloudflare Pages deploy of the fork so cross-machine smoke testing becomes possible | NOT STARTED. Cloudflare account ready. GitHub fork at `github.com/spider12223/pokerogue-coop`. |
| **M2c** | Networked play: NetworkCommandSource for joiner's slot, host pushes state snapshots, joiner renders from snapshots | NOT STARTED |
| **M2d** | Full battle render parity on joiner side, animation sync, edge-case polish | NOT STARTED |

---

## SECTION 2 — STATE OF MILESTONES

### M1 — Hot-seat (SHIPPED)

Committed at **`ef4041da`**. Two keyboards, two players, dual battles. Input gating fully tested (5 test files, ~15 tests). All 442 / 442 test files passed at commit time.

Toggled via `Overrides.LOCAL_HOTSEAT_OVERRIDE: true` in `src/overrides.ts`. When on, hot-seat uses keymaps from `cfg-keyboard-hotseat-p1.ts` (P1 = arrows + Z/X) and `cfg-keyboard-hotseat-p2.ts` (P2 = WASD + Q/Shift + numbers).

### M2a — Lobby pipe (FUNCTIONALLY WORKING, NEEDS CLEANUP)

Two-tab smoke test (same machine, both Chromium tabs to `localhost:8000`) just passed:
- Tab 1: Title → Co-op → Host Co-op → lobby renders with code (e.g. `XTP7JV`).
- Tab 2: Title → Co-op → Join Co-op → form → enter code → lobby renders.
- Trystero/Nostr handshake completes within ~5 seconds.
- Both tabs reach `CoopState.kind = "CONNECTED"` and display "Connected (host)" / "Connected (joiner)".

**Remaining work for M2a:**
1. Strip all `[coop]` / `[coop-ui]` diagnostic logs (added during the rendering / cancel / handshake debugging session).
2. Run full test suite — should be 446+ files green.
3. Commit as M2a final.

### M2b — Cloudflare deploy (NOT STARTED)

Cloudflare Pages target ready. Repo fork is `github.com/spider12223/pokerogue-coop`. The deploy will let two machines / two networks test peer connection across the public internet (the smoke test so far has only been same-machine). M2b is a deploy + smoke-test exercise; no significant code changes expected.

### M2c — Networked play (NOT STARTED)

The big one. Architecture is already designed in M1 — `CommandSource` is the abstraction. M2a's `CoopSession` provides the transport. M2c's job is to:
- Plug a `NetworkCommandSource` into the joiner's slot on the host side.
- Have the joiner's browser open a UI for slot 1's CommandPhase when the host sends a "request command" message.
- Have the joiner send the chosen command back across the wire.
- Host's `phase.handleCommand(...)` is invoked with the network-delivered command.
- Joiner renders the battle by listening for state-snapshot messages.

### M2d — Polish (NOT STARTED)

Animation sync, edge cases (faints, switches, evolution prompts on joiner side), error recovery (peer drops mid-battle), full battle render parity. No design done yet.

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

---

## SECTION 5 — IMMEDIATE NEXT STEPS FOR NEW CHAT

Do these in order. Stop after step 3 — M2b is the new chat's call.

1. **Strip all `[coop]` and `[coop-ui]` diagnostic logs** from these files (single cleanup commit, no other changes):
   - `src/phases/title-phase.ts`
   - `src/multiplayer/network/coop-session.ts`
   - `src/multiplayer/network/transport.ts`
   - `src/ui/handlers/coop-lobby-ui-handler.ts`
   - `src/ui/ui.ts` (the `setModeInternal` log block — gated on `isCoopRelated`)
   - Also remove the `// Trace ...` debug comments next to each log line. The codebase rule is no comments in production code — debug comments were allowed only during the diagnostic session.
   - **Don't strip** the `console.trace` inside `CoopSession.setState`'s HOSTING → IDLE branch on a hunch — actually do strip it. All `console.trace` calls go too. Check every file with `grep -n "\[coop\]\|\[coop-ui\]\|console\.trace" src/`.
2. **Run the full test suite**: `pnpm test:silent`. Should be 446+ test files green, 4333+ tests, 0 errors. If anything regresses, the cleanup pass over-deleted something.
3. **Commit M2a final** with message describing scope (lobby pipe, no battle integration). User does final manual two-tab smoke test, confirms green, then merges.
4. **M2b**: Cloudflare Pages deploy. Fork is `github.com/spider12223/pokerogue-coop`. Cloudflare account ready. The deploy is straightforward (PokéRogue is a Vite static site); the only co-op-specific concern is that production may apply CSP headers at the CDN layer that block `wss://` to Nostr relays — verify and configure CSP to allow `wss://*` if needed. Smoke test: open the deployed site in two tabs / two machines / two networks, verify host+join still connects.

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

## SECTION 9 — OPEN QUESTIONS FOR M2C ONWARDS

These are real unknowns. The new chat should think carefully and propose options before committing:

- **Joiner-side rendering strategy.** Three viable approaches:
  - (a) **Full mirror**: joiner runs the whole BattleScene render pipeline against host-pushed state snapshots. Hardest to implement (need to serialize a lot of state), best UX (everything looks identical).
  - (b) **Simplified UI**: joiner renders just a moveset selector + opponent HP + minimal field state. Easier to implement, weirder UX (asymmetric experience between players).
  - (c) **Decision deferred**: ship M2c with whatever the minimum is for "joiner can pick a move", iterate.
  - Recommendation: design discussion with user before code. Probably (a) ultimately, but maybe staged via (c).
- **Explicit `relayUrls` fallback.** Trystero's default Nostr relay list may have outages. Should we pin a specific subset for reliability? Or detect failure and rotate? Decision can wait until M2b production smoke surfaces real reliability data.
- **Backdrop full-canvas coverage edge case.** The visual seam on the right edge (Section 6) — is it an alpha-blend artifact, a coordinate rounding issue, or actually a different handler peeking through? Worth ~30 min of investigation in a quiet moment.
- **Reconnect after peer drop mid-battle.** Trystero supports manual relay reconnection. Should we attempt to reconnect for a grace period (e.g. 30s) before terminating the run? UX question for M2c.
- **Battle scene state size for snapshot sync.** A full PokéRogue battle has hundreds of fields (Pokémon HP/status/stat-stages, arena tags, weather, modifiers, etc.). Naive JSON serialization may push the WebRTC data-channel limits or be slow. Consider: differential snapshots, structured event log instead of full state, or a hybrid. Open architecture question for M2c.

---

*Document last updated immediately after the M2a two-tab smoke test passed. M2a code is in working order pending the [coop] log cleanup pass.*
