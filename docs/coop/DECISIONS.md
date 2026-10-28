<!--
SPDX-FileCopyrightText: 2026 pokerogue-coop contributors

SPDX-License-Identifier: AGPL-3.0-only
-->

# Design decisions

PokeRogue Co-op adds a two-player online mode to PokeRogue. Two players, each in their own browser, play one classic run
together:

- Every battle is a double battle.
- The party of six is shared, but each player owns three of the Pokémon and controls one field slot: the host fights in
  slot 0, the guest in slot 1. Control follows the owner of the Pokémon on the field.
- Both players choose their commands at the same time, and they can give or trade Pokémon to each other between waves.

The run is played in **lockstep**. Both browsers run the whole simulation from the same seed and never send each other
game state. They only exchange *decisions*: a move, a reward pick, a switch, the answer to a prompt. The host numbers
every decision (`seq`), and both clients apply them strictly in that order, so both simulations take the same path. A
relay server forwards the messages between the two browsers without reading them.

At fixed points both clients hash the state they must agree on and compare the hashes. A mismatch is a *desync*: both
clients reload the start of the wave from the host's save and play on. Every decision is also checked for legality on
both sides before it is applied, so a corrupted or forged one ends up on the same path.

This document is the rulebook of that design: who decides what, how each decision is keyed and checked, what is saved
and when. [ARCHITECTURE.md](ARCHITECTURE.md) explains how the code implements it.

## How to read this document

- Every section has a fixed number, D1 to D31, plus D4a. The source code cites them (`DECISIONS D9`, `(D13)`) in
  hundreds of comments, so the numbers never change: a new rule gets a new number, and a changed rule is edited in place.
- The sections are in number order (D4a follows D4). The table below groups them by topic.
- "Host" and "guest" are the two seats; "the partner" is the other player. Text in braces, such as `{partner}`, is
  replaced by a display name on screen.
- Decision kinds in capitals (`REWARD_PICK`, `TRADE_DONE`, …) are the entries of `DECISION_KINDS` in
  `src/coop/protocol.ts`. D2 lists them all with their keys and deciders.
- Code paths are relative to the repository root.

| Topic | Sections |
|---|---|
| Connection and sync | D1 handshake, D2 sequencing, D3 determinism, D13 desyncs, D18 epochs, D24 payload validation |
| Accounts and settings | D4 account data, D4a account writes and run end, D5 settings, D31 account import, D32 the starter select of both, D35 play again, D36 rules kept as they are |
| Events | D33 timed events (Halloween and the others) |
| Battles | D6 battle shape, D7 party and control, D8 commands, D34 trainers the run has met |
| Between waves | D9 rewards, D10 prompts, D11 trade, D28 party edits, D29 Mystery Encounters, D30 eggs and vouchers |
| Feel | D16 cosmetic channel, D17 AFK and take over, D27 pacing |
| Saving and reconnecting | D19 saving, D20 disconnect and rejoin, D21 resume later |
| Deploy and operations | D22 deploy shape, D23 relay hardening, D25 source link, D26 diagnostics log |
| Scope and process | D12 what is off, D14 tests, D15 reference fork (prior art) |

## Glossary

| Term | Meaning |
|---|---|
| Host, guest | The two players. The host created the room and is the sequencer; the guest joined with the room code. |
| Seat | `host` or `guest`: a player's place in a room. The relay gives each seat a token to take it back after a drop. |
| Owner, controller | The owner of a Pokémon is the seat it belongs to (the owner map, D7). The controller of a field slot is the owner of the Pokémon in it. |
| Linked run | A co-op run with a network connection: its decisions are sequenced. A co-op session without one exists only in rule tests. |
| Sequencer | The part of each client that orders decisions (D2). The host's assigns `seq`; both clients apply decisions strictly by `seq`. |
| Decision | A state-changing choice, proposed by its author and broadcast by the host as `SEQUENCED` with its `seq`. Only sequenced decisions change the simulation. |
| Decision key | `{wave, turn, kind, ref}`, the asserted identity of a decision. Each client derives the key it expects from its own simulation; a sequenced decision with a key it does not expect is a desync. |
| Window | The set of decision keys the game is waiting for at the moment (D2). |
| Decider | The seat that makes a decision: an owner, the reward picker, the host, or either player (`deciderOf`). |
| Picker | The player who makes the free pick of a reward screen. It alternates screen by screen (D9). |
| Epoch | A counter of reloads (D18). Every message carries it; messages of an older epoch are dropped. |
| Checkpoint | A hash of the simulation state, taken at fixed points (turn start, wave start, reward options, wave end) and compared with the partner's (D13). |
| Desync | The two clients disagree: a checkpoint mismatch, a key nobody expected, or an illegal decision. |
| Resync | The recovery from a desync: both clients reload the host's wave-start save under a new epoch (D13). Rejoin, resume and retry use the same mechanism. |
| Wave-start save | The session save of a linked run, taken at the start of every wave (D19). The host keeps it in its co-op slot, the guest in memory. |
| Co-op slot | The host's `localStorage` entry `coopSlot`: the wave-start save, both names and accounts, the last epoch and `seq` (D19). |
| Decision gate | The point where a phase waits for a decision (`coopGate`, `coopDecide`, the reward, turn-commands and trade windows). A reload waits for one, because that is where a phase can be abandoned safely. |
| Relay | The server in `coop-server/` that pairs two browsers by room code and forwards their messages without reading them (D22, D23). |
| Cosmetic channel | Unsequenced messages that may be lost and only change what the partner sees: intents, cursors, pings, emotes, pacing (D16, D27). |
| Take over | Making one decision for a partner who has not answered for 90 seconds (D17). |
| Validation | The host's check of a proposal before it sequences it (D2). |
| Legality check | The check both clients run on every sequenced decision before they apply it (D24). |
| Overlay | Settings applied in memory for the co-op session and never saved: the host's pinned settings on the guest (D1, D5), and the host's speed settings on the guest (D27). |

## D1. Pin and handshake

- **Base.** The fork was built on upstream PokeRogue `main` at `a6995c571a092e762ea036589bb6f3a8fa4f5dbd` (version
  1.12.1.3) and has since merged upstream `main` at `7fd2ba7058e5f6a62eca96987f16072cece383da` (version 1.12.2.2), with
  the `assets` and `locales` submodules of that commit.
- **What must match.** In the `HELLO` handshake both clients must match on:
  - the protocol version (`COOP_PROTOCOL_VERSION`);
  - the build identity (below);
  - the build mode, including `VITE_BYPASS_LOGIN`;
  - `hash(activeOverrides)`, which must equal the hash of the defaults;
  - the pinned settings (D5).

  On any mismatch the connection is refused.
- **The handshake is asymmetric**, so the guest can take on the host's settings before they are compared:
  1. The host sends `HELLO {build, pinnedSettings, name, mode}`.
  2. The guest verifies the build. It then applies the host's pinned settings as an in-memory co-op overlay, never
     written to its saved settings.
  3. The guest replies `HELLO_ACK {build, effectiveSettingsHash, name, accountId}`. The host verifies it and answers
     `HELLO_OK`, or `REFUSE` with the fields that differ.
  4. When the co-op session ends, the overlay is removed.
- **Display names.** Each client has a name, set in the co-op lobby and stored locally. `HELLO` and `HELLO_ACK` carry it
  (1 to 16 printable characters, trimmed; default "Player"). It is cosmetic: not part of the build identity, of any hash
  or of any decision. Every "{partner}" text uses it; if both names are equal, the partner's is shown with " (2)".
- **Resume and rejoin (D20, D21).** `HELLO` carries `mode: "new" | "resume"`. `HELLO_ACK` carries the guest's
  `accountId` (`"trainerId:secretId"`). In a `resume` room the host refuses a guest whose `accountId` is not the one in
  the saved co-op block (`REFUSE`, with `accountId` as the field that differs). A rejoin repeats the whole handshake.
- **Build identity.** The build is `gitSha` plus `dirtyHash`. `dirtyHash` is `clean`, or a hash of `git diff HEAD` plus
  the path and content of every untracked, non-ignored file under `src/`, hashed with `\n` line endings at build time
  (`plugins/vite/coop-build-identity.ts`). Both parts must be equal. A build without `.git` (a container image) takes
  them from build arguments (D22).

## D2. Sequencing

- **The host is the sequencer.** Every state-changing decision gets a host-assigned, strictly increasing `seq`. The
  table below lists every kind.
- The guest sends `PROPOSE`. The host validates it and broadcasts `SEQUENCED`; its own decisions take the same path.
  Both clients, the host included, apply only sequenced decisions, strictly in `seq` order. Early arrivals are buffered.
- **Validation.** The host refuses (`REJECT`) a proposal whose key is malformed, whose author may not make it, whose key
  was already decided (`duplicate`), whose window another decision closed (`closed`), or whose payload fails the
  host's check (`invalid`, `validateProposal` in `src/coop/validate.ts`). The proposer is told. Both clients also check
  every sequenced decision before applying it (D24).
- **Decision keys.** Each decision carries an asserted `DecisionKey {wave, turn, kind, ref}`. A key mismatch counts as a
  desync (`DesyncError`).
  - `wave` is `currentBattle.waveIndex`.
  - `ref` is a number (a `pokemon.id`, or `NO_REF` = -1) or a string (a composite, below). It must be unique within the
    wave for its kind.
- **Decision windows.** The game opens a window: the set of keys it currently expects. Sequenced decisions may resolve
  open keys in any order (`awaitAll`, and `awaitOneOf` for a window where the first decision closes the others). A key
  outside the window throws `DesyncError`.
- **`turn` in keys.** Only decisions made inside a battle turn carry `battle.turn`: `TURN_COMMANDS`, `SIDE_ACTION`,
  `SIDE_PICK`, `FAINT_SWITCH` and `PIVOT_SWITCH`. Every prompt and between-wave decision uses `turn = 0` and a `ref`
  that is unique within the wave.
- `FAINT_SWITCH` uses `battle.turn` as it stands when the faint `SwitchPhase` runs, which is the faint turn + 1
  (`TurnEndPhase` has advanced it). This is intended: both clients read the same value at the same point.
- **The reward screen.** Every action has `ref = "${screen}:${step}"`, with `screen = rewardPickCount - 1` and `step` the
  number of decisions that already took a step on that screen (a buy, a transfer, a reroll, a lock, a trade request, a
  party edit). All keys of the step are open at once: `REWARD_PICK`, `REROLL`, `REWARD_LOCK`, `SHOP_BUY`,
  `REWARD_TRANSFER`, `TRADE_REQUEST` (D11) and `PARTY_EDIT` (D28). The first one sequenced closes the step, and a later
  proposal for it is rejected as `closed` (D9). Variable-count actions are validated by window membership and `kind`.
- **The trade phase.** In `CoopTradePhase` every key has `ref = "${step}"`, where `step` counts the trade decisions of
  the phase from 0. `TRADE_DONE` has `"${step}:${seat}"`.
- **Take over (D17).** A `PROPOSE` may carry `takeover: true`. The host then skips the check of who may author the key
  (the waiting player decides for the partner), but still checks the payload. The first proposal sequenced for a key
  wins; a later one for the same key is rejected as `duplicate`. `SEQUENCED` repeats `takeover`, so both clients know.
- **Epoch (D18).** Every envelope carries `epoch`. The sequencer and the checkpoint exchange drop what is older than the
  local epoch.
- **`COSMETIC` is not a decision (D16).** It has no key and no `seq`, and the sequencer never sees it.
- **Never** key anything by `battle.turn` alone, by `fieldIndex` (a slot), or by counting `CommandPhase`s, and never
  order anything by arrival time or by a local counter: the order is `seq`.

| Kind | Who decides | `turn` | `ref` | Rules |
|---|---|---|---|---|
| `TURN_COMMANDS` | the controller of the slot | `battle.turn` | the Pokémon's id; `"${id}:${attempt}"` when a declined Ball or Run is chosen again | D8 |
| `SIDE_ACTION` | the partner of the player who chose a Ball or Run (accept or decline) | `battle.turn` | `"${id}:${attempt}"` | D8 |
| `SIDE_PICK` | the host | `battle.turn` | `NO_REF` (one per turn) | D8 |
| `FAINT_SWITCH` | the fainted Pokémon's owner, or the partner if the owner has no bench | `battle.turn` (above) | the fainted Pokémon's id | D7 |
| `PIVOT_SWITCH` | the controller of the slot | `battle.turn` | the leaving Pokémon's id | D7 |
| `REWARD_PICK`, `REROLL`, `REWARD_LOCK` | the picker | 0 | `"${screen}:${step}"` | D9 |
| `SHOP_BUY`, `REWARD_TRANSFER` | either player | 0 | `"${screen}:${step}"` | D9 |
| `REWARD_TARGET` | not used: the target travels in the payload of the pick or the buy | | | D9 |
| `LEARN_MOVE` | the Pokémon's owner | 0 | `"${pokemonId}:${moveId}"` | D10 |
| `EVOLUTION_CANCEL` | the Pokémon's owner | 0 | `"${pokemonId}:${targetSpeciesId}"`; the pause question after a cancel adds `":pause"` | D10 |
| `BIOME` | the picker of the most recent reward screen | 0 | `NO_REF` (one per wave) | D10 |
| `CATCH_RELEASE` | the thrower | 0 | the caught Pokémon's id | D10 |
| `TRADE_REQUEST` | either player | 0 | `"${screen}:${step}"` | D11 |
| `TRADE_PROPOSE` | either player | 0 | `"${step}"` | D11 |
| `TRADE_ACCEPT`, `TRADE_DECLINE` | the other seat than the proposer | 0 | `"${step}"` | D11 |
| `TRADE_CANCEL` | the proposer | 0 | `"${step}"` | D11 |
| `TRADE_DONE` | each seat for itself | 0 | `"${step}:${seat}"` | D11 |
| `PARTY_EDIT` | either player, for their own Pokémon | 0 | `"${screen}:${step}"` | D28 |
| `ME_CHOICE` | the host, or the player who goes in a one-Pokémon encounter | 0 | `"${n}"`, counting the encounter decisions of the wave | D29 |
| `RETRY` | the host | 0 | `NO_REF` | D4a |

- **A prompt asked again in a wave** (an evolution cancelled and offered again at the next level, a declined TM picked
  again) gets a key of its own: the `LEARN_MOVE` and `EVOLUTION_CANCEL` refs carry `:n` from the second time
  (`CoopSession.nextOccurrence`, counted alike on both clients, from the first again in a new wave or epoch). A key the
  simulation already took is never awaited again: that is a `DesyncError`, not a wait that never ends.

## D3. Determinism

- **Run seed.** The host generates it and sends it in `START`.
- **Sites that upstream draws unseeded.** In co-op, each simulation site that upstream draws from `Math.random` gets its
  own seeded stream: a dedicated `executeWithSeedOffset` offset (`simRandInt` in `src/coop/sim-rng.ts`). These draws do
  not go through the shared stream, so nothing after them shifts. Solo play keeps the unseeded draw. The sites:
  - the gender of an evil-team grunt (`src/battle.ts`);
  - whether a grunt battle is a double (`src/battle.ts`; in co-op every battle is a double anyway, D6);
  - which status a fusion keeps (`src/data/status-effect.ts`);
  - the random target of a move like Outrage, drawn when the move is chosen (`commandTargetPick`). Only the chooser's
    client runs that command phase, so in co-op the target comes from its own stream instead of the battle's.
- Mystery Encounters seed what upstream leaves unseeded on their paths, such as the GTS ball roll (D29). Eggs are drawn
  outside the simulation on purpose (D30).
- **Timed events** read the wall clock, which two clients do not share: a co-op run has the events the host chose when
  it started (D33), not the clock's.
- **`pokemon.id`.** In co-op, uniqueness is asserted when a Pokémon is created. On a collision the id is redrawn
  deterministically, identically on both clients (`src/coop/pokemon-id.ts`).
- **Call-site tests** (`test/coop/rng-call-sites.test.ts`, `test/coop/account-call-sites.test.ts`) list every remaining
  unseeded or wall-clock call and every direct `gameData` read in `src/`, each with its reason. A new unseeded call on a
  simulation path fails them.

## D4. Account data

- Both accounts are snapshotted at run start into the `coop` block of the session save. During co-op, the simulation
  never reads live `gameData`: it reads the snapshots (`simAccount()` in `src/coop/sim-account.ts`).
- **Host snapshot** (world-level values):
  - TID/SID (shininess);
  - Eviolite and Mini Black Hole unlocks;
  - `checkCanUseBall` legality;
  - the dex count for critical captures.
- **Owner snapshot** (Pokémon-level values, from the account of the Pokémon's owner):
  - egg moves;
  - dex conditions for evolutions and forms;
  - starter luck, carried per starter.
- **Writes** (dex, candy, catches) are credited to the current owner's account. The partner only marks "seen" (D4a).
- A saved run can be continued only with the same two accounts (D21).
- The snapshot of `ready` is taken while the starter select shows both players' Pokémon (D32), so it holds what the
  player picked from: the egg moves, forms and shinies of both accounts.

## D4a. Account writes and run end

- Each client writes to its own account only for Pokémon it owns. A partner-owned Pokémon is only marked "seen". Account
  writes never feed the simulation, which reads the snapshots (D4).
- Victory and game over are shared. Both clients return to the title screen with a "Co-op run ended" message.
- **Retry after a wipe.** A co-op game over (not a victory) first asks the host "Retry the wave" or "End the run". This
  is the sequenced decision `RETRY` (`retryKey(wave)`, `ref` `NO_REF`, payload `{retry}`, decided by the host, taken
  over with the same menu, D17). The guest sees "{host} is deciding whether to retry the wave…".
  - A retry is a `RESYNC` with the reason `retry` (D13): both clients reload the host's wave-start save under a new
    epoch and play the wave again. It is not a desync strike, and nothing is written (no run history, no clear counter).
  - "End the run" ends it as a game over.
  - The host's `enableRetries` setting is not read; it stays pinned (D5).
  - Without a network or a wave-start save there is nothing to go back to, and the run ends.
  - A partner who drops and comes back while the question is open: the rejoin reloads the wave start (D20), which is a
    retry nobody chose. "End the run" is offered again at the next wipe.
  - A partner who is away at the wipe and does not come back: the host's "End session" (D20) leaves without ending the
    run, so the co-op slot keeps the wave start and the run can be continued, and retried, later.
- **Victory.** Ribbons go to each Pokémon's owner. The victory counts as a co-op clear on each player's own account
  ("Co-op Clears" in the stats) and goes into each player's run history with both display names. It does not trigger
  the classic-win unlocks or their vouchers.

## D5. Settings

Pinned in co-op to the host's values and enforced on both clients (the guest receives them as an overlay, D1):

| Setting | Value |
|---|---|
| `battleStyle` | SET |
| `enableTutorials` | false |
| `skipSeenDialogues` | false |
| `levelMoveConfirmation` | true |
| `enableRetries` | false |
| `playerGender` | the host's |
| `manualMessageClear` | false |
| `partyExpNotificationMode` | SKIP |

- `eggSkipPreference` is not asked in co-op: eggs hatch without the animation (D30).
- Local only, not pinned and not compared, because they do not change the simulation: `gameSpeed`, move animations,
  `expGainsSpeed`, `hideIvScanner`, `battleCursorMemory`, `preferBatonPass`, and cosmetic settings. For pacing, the
  guest still follows the host's speed and display settings while the run lasts (D27).

## D6. Battle shape

- Every battle is a double. The co-op rule is in `BattleScene.checkIsDouble`, before the "never double" edge cases.
- The enemy count stays natural: a wild double means 2 enemies, so on a wave that ends in 0 a wild boss becomes two
  bosses. Accepted.
- **Trainers** use their `DOUBLE` variant where the config has a usable one (`src/coop/doubles.ts`). A trainer without
  one fights as it is, and the engine sends out its first two Pokémon; a trainer with a single Pokémon fights 2v1.
- **Final boss:** 2v1, through the existing path.
- **No enemy reserve:** a forced double whose trainer has no reserve left for a second replacement stays 2v1, through
  the guards in `Trainer.getNextSummonIndex` and `SwitchSummonPhase`. Accepted.
- Battles of Mystery Encounters: D29.

## D7. Party and control

- One shared party array (max 6), plus an owner map `pokemon.id → host | guest`. Each player starts with 3.
- **Control follows the owner of the Pokémon on the field, not the slot.**
- **Wave-start arrange step:** slot 0 = the host's first legal Pokémon, slot 1 = the guest's first legal Pokémon. If a
  player has no legal Pokémon, the partner's next legal one fills the slot ("partner covers").
- **Faint replacement** (`FAINT_SWITCH`):
  1. The fainted Pokémon's owner picks from their own bench.
  2. If they have none, the partner picks from theirs.
  3. If neither has a bench, upstream behaviour applies (re-centre or game over).
- **Switches on the players' side:**
  - Voluntary switches and pivots (U-turn, Eject Button, Baton Pass; `PIVOT_SWITCH`): from the bench of the user's
    controller only. With no bench, the Pokémon stays in.
  - Forced switches (Roar, Whirlwind, Dragon Tail, Red Card): a random pick from the bench of the dragged-out Pokémon's
    owner; if that bench is empty, from the partner's bench; if both are empty, the move fails as upstream. The pick
    uses the seeded battle RNG, so both clients get the same one.
- Ownership changes only through a trade (D11), a catch (D10) or a Mystery Encounter (D29). A Pokémon that leaves the
  party (a release, a fusion) loses its owner entry.
- Party edits on the reward screen (reorder, release, …) apply only to the player's own Pokémon (D28).
- No trading during a battle.

## D8. Commands

- **Simultaneous:** both players choose at once, and the turn commits when both are ready. The partner's tentative
  choice is visible through the cosmetic intent of D16: a ghost marker on the targeted battler with the move name, and a
  check mark once the command is proposed. The markers clear at `TurnStartPhase`.
- The gate is at `CommandPhase.start`. The `CommandPhase` class is kept, because the UI handlers cast to it. Each client
  runs the command phases of the slots it controls; `CoopTurnSyncPhase` then sequences one `TURN_COMMANDS` decision per
  Pokémon and writes the partner's commands in, so `TurnStartPhase` plays the same turn on both.
- `cancel()` reopens only the canceller's own slot(s).
- **Side actions:** Ball and Run affect the whole turn, so the partner must accept (`SIDE_ACTION`).
  - On accept, the partner's slot is skipped (upstream semantics: the command phase of the other slot is not run).
  - On decline, the proposer chooses again.
  - **Both chose one:** nobody accepts the other's. Two Runs are one Run. Otherwise (two Balls, or a Ball and a Run) the
    host picks which one happens, from a menu of both ("Me: Great Ball", "Alex: Poké Ball"). The pick is the sequenced
    decision `SIDE_PICK` (one per turn, `ref` `NO_REF`), checked on both clients against the two Pokémon that chose one
    (D24), and taken over with the same menu (D17). The other slot is skipped as on an accept. The player whose choice
    did not happen, and who did not pick, sees a short notice.
- **Tera is a side resource:** if both players choose Tera in the same turn, the first by `seq` keeps it. The other
  player's Tera flag is cleared and that player sees a short notice. `CoopTurnSyncPhase` enforces it.

## D9. Rewards

- **The picker alternates per reward screen, not per wave.** The host picks on the first reward screen of the run, the
  guest on the second, and so on (`rewardPickerOf(screen)`, `screen = rewardPickCount - 1`). The picker makes the free
  pick, chooses its target (any party Pokémon, sent as `pokemon.id`), and controls rerolls.
  - `rewardPickCount` lives in the co-op block of the save. It counts the reward screens started; a reroll is the same
    screen and does not advance it.
  - Every tenth wave has fixed rewards and no reward screen (`victory-phase.ts`), so it does not advance the count.
- **The reward screen:**
  - The picker makes the free pick or the skip, and controls reroll and Lock Capsule.
  - Either player can buy shop items while the screen is open; purchases are sequenced. The buyer chooses the target
    (any party Pokémon, by `pokemon.id`).
  - **A DNA Splicer** fuses two of the user's own Pokémon (the picker's or the buyer's): fusing takes the second one out
    of the party, and the partner's is not theirs to give up. The party screen refuses the partner's on both picks; the
    host's validation and the legality check (D24) refuse it too.
  - Item transfer is open to either player, but only from their own Pokémon.
  - The screen closes when the picker picks or skips. The host rejects proposals that arrive after it closes, and the
    proposer is told.
  - The non-picker sees the same options read-only, with "{picker} is choosing…". The picker's cursor is mirrored live
    as a tint on the option (D16), and either player can ping an option.
  - **Trade button:** both players get one. It proposes `TRADE_REQUEST` (D11), which is sequenced like a shop buy (it
    takes a step) but is not a reward action.
  - A TM, Rare Candy or evolution item used on a partner's Pokémon sends the resulting learn-move or evolution prompt
    to that Pokémon's owner.
- The option list is hashed (type plus generated arguments, not just `ModifierType.id`) before display (D13).
- Lures are removed from the co-op pools.
- Money is shared.

## D10. Prompts

- **Learn-move and evolution:** the owner answers; the partner sees a read-only view.
- **Biome** (Map item): the picker of the most recent reward screen decides.
- **Catch:** each seat has a cap of 3. A thrower with fewer than 3 adds the catch and owns it. A thrower with 3 releases
  one of their own, or declines the catch (`CATCH_RELEASE`).
- **Nincada's Shedinja** is the Nincada owner's, within the same cap: an owner who has three gets none.

## D11. Trade

- Trading is not a screen every wave. Both players get a **Trade** button on the reward screen. It sends
  `TRADE_REQUEST` as a sequenced decision of the reward window (either seat; it is not a reward action, and it does not
  close the screen).
- If a request is sequenced before the reward screen closes, `CoopTradePhase` runs right after the screen (and after
  what its pick queued: learn-move, evolution), before biome selection and `NewBattlePhase`. Otherwise there is no trade
  phase. A request for a screen that has closed is rejected (`closed`).
- Waves that end in 0 have no reward screen, so there is no trading on them.
- `UiMode.COOP_TRADE`: two panels, yours on the left and the partner's on the right.
- **Propose** (`TRADE_PROPOSE`, either seat): one of yours to give, and optionally one of theirs to want. **Answer**
  (the other seat only): `TRADE_ACCEPT` or `TRADE_DECLINE`. The proposer can withdraw with `TRADE_CANCEL`. **Done**
  (`TRADE_DONE {done}`, each seat, toggles): the phase ends when both are done; any new proposal clears both.
- **Accept:** the sequenced apply swaps the owners in the owner map (the party array does not change). Held items stay
  on their Pokémon, so they follow it.
- **Gift** (no "want"): free, whatever the counts, as long as the giver keeps one of their own (a player with none would
  have nothing to play). The receiver may go past 3: the cap of 3 (D10) is for catches. The receiver still accepts or
  declines. A 1-for-1 trade keeps the counts.
- **The screen:** each player's Pokémon with icon, level and HP; the deal under the lists ("You give" / "You get", arrows
  both ways for a trade, one way for a gift); the actions beside it ("Give" when nothing of the partner's is picked,
  else "Propose"; "Done"); a green "Done" on the header of whoever is done.
- The index-baked phases (`ExpPhase`, `LevelUpPhase`, `LearnMovePhase`, `EvolutionPhase`) are drained before a trade is
  applied: `CoopTradePhase` does not start while one is queued.
- The next wave's arrange step puts each seat's first legal Pokémon in its slot (D7), so a traded Pokémon fights for its
  new owner.
- The owner map is in the co-op block of the save, so a trade survives a save and load.

## D12. Off in co-op

- Upstream's retry setting: `enableRetries` stays pinned off (D5). A wipe has its own retry, decided by the host (D4a).
- Daily mode.

Mystery Encounters are on (D29), and `EggLapsePhase` runs (D30).

## D13. Desync handling

- **Hash points:**
  - `TurnInitPhase.start`;
  - wave start, after `resetSeed` in `EncounterPhase`;
  - rewards, once `SelectModifierPhase` has generated its options and before they are displayed (D9);
  - wave end, at the end of `BattleEndPhase.start`.
- **Hash contents** (`src/coop/state-hash.ts`): the RNG states, the parties (with exp, luck, nature, IVs, ability,
  gender and owner), the fields, the weather, the modifiers and the reward options (each with its generated
  arguments), the run and wave seeds, the pinned settings (D5) and the run's timed events (D33). Not hashed: `timestamp` and `playTime` (wall
  clock), animation and UI state, local-only settings, and the accounts (they reach the simulation only through the
  snapshots, D4).
- Each client sends the hash of every checkpoint it passes to the partner and compares the partner's with its own.
- **Resync:** a checkpoint mismatch seen by either client sends `RESYNC_REQUEST` (the host's own detection needs no
  message). Both clients carry on until their next decision gate (`coopDecide`, the reward, turn-commands and trade
  windows), because that is where a phase waits on a promise and can be abandoned safely. At the gate the host
  sequences a `RESYNC` (it takes the next `seq` but has no key), so both reload at the same point:
  1. The `RESYNC` carries the current wave's start save (D19), the new epoch (D18) and the wave.
  2. Both clients drop their open windows and phases and reload through the retry-path reset (`reset` →
     `clearPhaseQueue` → load the save → `EncounterPhase(loaded)` and the summon phases). Both must reload, because a
     reload is not identical to live play.
  3. The epoch goes up by 1 and play continues. Progress within the wave is lost (accepted).
- **Reasons** of a `RESYNC`: `mismatch`, `desync`, `rejoin` (D20), `resume` (D21), and `retry` (D4a: the host chose to
  play a wiped wave again). Only `mismatch` and `desync` count as strikes. Only the host sends `retry`; a guest's
  `RESYNC_REQUEST` cannot carry it.
- **Three strikes:** the host counts the desyncs of each wave. The third desync of the same wave is not resynced: the
  host sends `RESYNC` with `stop: true`. Both clients save (the co-op slot already has the wave start), show an error,
  and offer a downloadable report: both phase traces (each client sends its own with the stop) and the two mismatching
  checkpoints. The run can be continued later (D21).
- **A decision's code that fails** (an exception in the phase that waits for it) reloads the wave like a desync, instead
  of leaving the phase hung; that phase counts as a safe point. A wave start that does not load (a save this build
  refuses) tells the player why and offers only Back to the title screen.
- **The hash** also covers each Pokémon's friendship, Tera type and Pokérus, the owner as the owner map has it (a member
  without one shows), the ball counts, the Lock Capsule, the battles left of a timed boost, and the run's seed.
- Not implemented: catching up by replaying the decision log live. A resync always reloads the wave start.

## D14. Tests

- **Record/replay** (Vitest, `test/helpers/coop-harness.ts`): one client plays a scenario as the host and logs its
  decisions; a second client with another account and other local settings replays the log as the guest, and both must
  pass the same checkpoints. The test framework's max-roll stub of `randBattleSeedInt` is disabled for these tests,
  because it would hide every battle-RNG desync.
- **Call-site tests** (D3).
- **A scripted-partner loopback test** (`test/helpers/coop-linked.ts`): one real game client, and a scripted partner on
  the other end of an in-process link.
- **Long runs:** whole runs from the first wave to Eternatus, replayed, played against a scripted partner from either
  seat, and through every Mystery Encounter (`pnpm test:ste`).
- **A Playwright two-browser harness** (`test/e2e/`; Playwright is a dev dependency).

## D15. Reference fork

- Code may be adapted from SunghoLee98/pokerogue, a working lockstep co-op fork under the same licence (AGPL-3.0-only).
  An adapted file credits the source in a header comment.
- Its `(wave, turn)` keying and its locally counted `seq` are not copied: D2 forbids both.

## D16. Cosmetic channel

- Intents, cursors, pings, emotes, ready badges and pacing travel as unsequenced `COSMETIC` messages. They have no key
  and no `seq`, and they are not retransmitted: a lost one is just a missed frame.
- They never touch simulation state: no RNG, no hashed state, no phase queue. A test floods them and checks that every
  checkpoint hash is unchanged.
- Each kind is rate-limited by the sender and again by the receiver (a token bucket per kind; the receiver allows a
  little more). The receiver drops anything malformed, over its limit, or not valid in the current state (a cursor for
  another screen).

| Kind | Payload | Sender's limit |
|---|---|---|
| `intent` | the sender's Pokémon, its tentative move and target, ready flag | 10 per s, burst 5 |
| `cursor` | the reward screen's number, the row and the column | 10 per s, burst 5 |
| `meCursor` | the chooser's option on a Mystery Encounter's screen (D29) | 10 per s, burst 5 |
| `ping` | what is pinged: an enemy or ally battler, a party Pokémon, a reward or shop option, or nothing (a nudge) | 1 per s, burst 3 |
| `emote` | one of 6 | 1 per 1.5 s, burst 2 |
| `pace` | the host's position in the text and its speed settings (D27) | 8 per s, burst 4 |
| `press` | the guest pressed on a line (D27) | 5 per s, burst 3 |

- The ping and emote buttons (`Button.COOP_PING`, `Button.COOP_EMOTE`) are buttons of the game: P and Q at first,
  remappable in the keyboard settings. A touch screen has a ping and an emote button. Pad triggers: D27.

## D17. AFK and take over

- While a client waits for the partner's decision, a timer runs for that wait. At **30 s** it shows "{partner} is still
  choosing" and the player can ping. At **90 s** it offers **Take over**: the player makes that one decision for the
  partner, proposed with `takeover: true` (D2).
- The sequencer accepts whichever proposal arrives first. If the partner then answers, its proposal is rejected and its
  screen closes with "{partner} took over".
- The timers can be changed only in dev and test builds (`window.__coop.setAfkTimers`).
- Take over applies to every decision that goes through the bridge (`takeoverPlan` in `src/coop/takeover.ts`):

| Decision | What the taker does |
|---|---|
| Turn commands | chooses that Pokémon's command with the normal command screen |
| Reward pick, reroll, lock | takes the picker's place on the screen: picks or skips |
| Faint switch, pivot switch, biome | chooses with the same screen the partner would have had |
| Side action (Ball or Run) | accepts it (the taker is the proposer) |
| Side pick, retry after a wipe | chooses with the host's menu (D8, D4a) |
| Learn-move | keeps the old moves |
| Evolution | allows it (no cancel, and no pause after a cancel) |
| Catch release | declines the catch |
| Trade answer | declines |
| Trade done | done |
| Mystery Encounter choice | chooses with the chooser's screens (D29) |

- Nobody takes over a trade request, a trade proposal or its cancel, or a party edit: nobody waits for those.
- **The host enforces it:** a guest's `takeover` is refused for a kind that cannot be taken over (and for trade
  proposals and accepts), must carry the plan's default where the plan has one, and is held until the host's own player
  has had the question for the hint's time (30 s); the host's own answer, if it comes first, wins. Once one take-over of
  a screen went through, the next steps of that screen are not held again. A modified client can no longer answer the
  host's questions for it.
- On a Mystery Encounter's screen the hint goes under the options and the offer may come over them. The trade screen's
  hint names no key (the ping keys do nothing there).

## D18. Epochs

- Every envelope carries an `epoch`, an integer. A message without one is epoch 0: all the traffic before the run
  (handshake, lobby, `START`).
- The host increments it on each reload: a resync, a rejoin, a resume, a retry. The new value travels in the `RESYNC`
  that causes the reload. A host that was reloaded itself starts at the last epoch of its co-op slot + 1.
- `PROPOSE`, `SEQUENCED`, `REJECT`, `CHECKPOINT` and `COSMETIC` from an older epoch than the receiver's are dropped (and
  counted). A message from a newer epoch never reaches the simulation before that epoch does: a `RESYNC` always passes
  (it is how the new epoch arrives); other kinds wait until the client has applied it, and cosmetic ones are dropped.
- `seq` never resets on the host. The `RESYNC` takes the next `seq`, and both clients carry on from `seq + 1`.
- A host reloaded by a resume continues from the slot's last `seq`. The slot is written at the wave start, so that
  value is older than what a guest that stayed has seen. The guest therefore takes the `RESYNC`'s `seq + 1` as it is,
  even if it is lower than its own; otherwise it would drop every decision of the new epoch as a duplicate. This is safe
  because the epoch stamp already drops everything of the old world.
- At an epoch change both clients forget their windows, closed keys, parked proposals and early decisions. Whatever
  awaited a decision rejects with `EpochChangedError`, which the game ignores. The checkpoint index starts again from 0
  (the log keeps the old entries, tagged with their epoch).

## D19. Saving

- A linked run saves at the start of each wave, in `EncounterPhase` after the enemies exist and before `doEncounter`
  (where a solo run calls `saveAll`). A linked run never calls `saveAll` and never writes a solo slot.
- **Host:** the save goes to a dedicated co-op slot, the `localStorage` key `coopSlot` (not `sessionData*`). It holds
  the session save (with the `coop` block, D4, D7), both display names, the last epoch and the last `seq`. It is removed
  when the run ends (victory, game over) and kept when the players only leave.
- **Guest:** keeps the latest wave-start save in memory only. It has no slot: the host's save is what both reload (D13).
- Solo slots are never touched; a test compares them byte for byte.
- **Each player's account** is saved at every wave start too (`saveSystem`, as a solo run's `saveAll` saves it), so what
  the run gave it (caught Pokémon, which the starter select shows; candies, eggs, vouchers) survives a closed tab. The
  menu's **Save and Quit** in a co-op run saves the account and then ends the session as "End session" does (D20); the
  run itself is the wave-start save.
- **Host a game** over a saved run asks first: the new run's first wave replaces the slot. A wave-start save that does
  not fit in local storage removes the slot of the earlier wave (Continue would silently take the run back to it).

## D20. Disconnect and rejoin

- The relay keeps a room alive as long as one seat is connected. The 60 s hold only applies when both seats are gone. A
  seat whose partner is still connected stays reserved without a limit.
- When the partner leaves, the remaining client pauses at its next decision gate with "Waiting for {partner} to
  reconnect" and the room code. After 60 s it also shows **End session**: the client leaves the room (the relay closes
  it at once), forgets the seat token and goes back to the title screen. The host keeps its co-op slot.
- Seat tokens are stored in `localStorage` as `coopSeat:<code>`, with the relay's address. At boot, a client that has
  one rejoins by itself, so a reloaded or reopened tab is back in the room. A refused token (`notFound`, `badToken`) is
  forgotten.
- A rejoin is a new pairing: both clients start their reliable channel again (numbers from 1), repeat the handshake
  (D1), and the host sequences a `RESYNC` (D13): both reload the current wave start under a new epoch. A client whose
  own connection dropped does the same when it is back. Messages sent before the pairing never reach the new one: the
  remaining client stops sending when the partner leaves.
- A host that was reloaded reads its co-op slot (D19); a guest that was reloaded receives the save from the host.
- **Before the first wave** (the starter select) a drop is not the end: the partner shows as away, and when they are back
  both send their picks and ready again, and the host its `START` (a duplicate changes nothing). There is no world to
  reload yet, so the host waits for the first wave's save; the starter select is a safe point, so a guest whose `START`
  was lost is brought into the run by that reload. A partner who left for good, or a closed room, ends it; leaving tells
  the relay.
- A guest that rejoined, or joined a continued run, waits for the reload like one in a decision: the reconnect screen,
  and End session. A screen whose partner is back offers End session too, after three times the wait. A socket that
  drops while a rejoin waits for the partner keeps the seat (a reload tries again); only the relay closing the room ends
  it. A tab whose seat another tab took leaves that tab's seat in the store.

## D21. Resume later

- Title screen → Co-op → **Continue** (host only, and only when the co-op slot exists). It creates a room and shows the
  code; `HELLO` says `mode: "resume"`.
- The guest joins with the code through "Join a game". It must be the same guest account as in the save (the
  `accountId` of `HELLO_ACK`, D1); another account is refused. The host's own account is checked against the save when
  the slot is loaded.
- After the handshake the host sequences a `RESYNC` at once: both load the wave-start save and continue, with the epoch
  after the slot's.
- **Continue** first checks that this build can load the slot; if it cannot, the host is told why and may delete it.
- `COOP_PROTOCOL_VERSION` in `src/coop/protocol.ts` (8) is bumped by any incompatible change to a message shape. Two
  builds pair only when they are the same commit anyway (D1).

## D22. Deploy shape

- One container, one port. `coop-server` serves the production `dist/` (static files) **and** the WebSocket relay on
  the same HTTP server. The relay is at `/coop` of the same origin, so there is no CORS and no mixed content (an `https`
  page gets a `wss` relay).
- `GET /healthz` answers `200` with a small JSON (`ok`, rooms, sockets, uptime, memory). `PORT` comes from the
  environment (default 8787); `STATIC_DIR` says where `dist/` is (none: relay only, for development).
- The client's relay URL is `VITE_COOP_RELAY_URL` if one was built in, else **`wss://<the page's host>/coop`**
  (`ws://` on an `http` page). `.env.development` sets `ws://localhost:8787/coop` for the dev server.
- Hosting-agnostic: the image needs only the port. Railway, Fly, a VPS, or a container at home behind Cloudflare Tunnel
  or Tailscale all work unchanged. TLS is terminated in front (the platform, a tunnel); the server speaks plain HTTP.
- Caching: files under `assets/` whose name carries Vite's content hash are `immutable` for a year; `index.html` and
  every other file are `no-cache` with an `ETag`, so a new image is picked up at once.
- The image is built from the repository with its submodules checked out (`assets/`, `locales/`). The build identity
  (D1) comes from build arguments when there is no `.git`. `VITE_BYPASS_LOGIN=1` is set for the build: a co-op deploy
  has no account server (the saves stay in the browser).
- The client debug API (`window.__coop`) is never in the image. A separate image built with `COOP_E2E=1` has it, for the
  browser tests against a container only.
- **Two more shapes, the same protocol:**
  - **A free website:** the game as static files on GitHub Pages (`.github/workflows/coop-pages.yml`), built with
    `VITE_COOP_RELAY_URL` pointing at `coop-worker/`, the relay as a Cloudflare Worker with one Durable Object per room
    code. The room keeps the seats of `RoomRegistry` in its storage (written on a seat change only) and sleeps between
    frames (WebSocket hibernation), so a game costs almost nothing of the free plan. It cannot ping (a sleeping room
    does not run): a connection that dies without closing is noticed when the player takes the seat back. The limits
    of D23 are per room and per Worker instance, not per IP over the whole relay; `/coop/log` answers 404 (D26).
  - **A pack for Windows** (`pack/windows/`, `scripts/pack-windows.ps1`): Node, `coop-server`, the build and
    `cloudflared` in one folder; `Start.bat` serves the game on `127.0.0.1` and opens a Cloudflare quick tunnel for the
    partner. The host plays on `http://127.0.0.1:8080`, so their saves stay; the partner's link changes at every start.
  - `coop-worker/scripts/smoke.ts` walks through the protocol against either relay.

## D23. Relay hardening

The relay stays stateless (memory only) and never reads a game message. Every limit except the frame size has a default
and an environment variable.

| Limit | Default | Variable | What happens over it |
|---|---|---|---|
| Connections per IP | 16 | `MAX_CONNECTIONS_PER_IP` | the upgrade is answered `429` |
| Connection attempts per IP | 60 per minute | `CONNECTIONS_PER_MINUTE` | `429`; this is also what makes guessing room codes pointless |
| Room creations per IP | 10 per minute | `ROOMS_PER_MINUTE` | `relay:error rateLimited` |
| Messages per IP | 120 per second, burst 400, over all of its sockets | `MESSAGES_PER_SECOND`, `MESSAGE_BURST`, `MAX_DROPS_PER_SOCKET` | the frame is dropped (the reliable layer resends); a socket that keeps going is closed (1008) |
| Bytes per IP | 2 MiB per second, burst 16 MiB, over all of its sockets | `BYTES_PER_SECOND`, `BYTE_BURST` | as for messages (the same drop count); a frame larger than the burst costs the burst |
| Backlog of a socket | 4 MiB waiting to be sent to it | `MAX_BUFFERED_BYTES` | a frame for it is dropped (the sender's reliable layer resends); after `MAX_DROPS_PER_SOCKET` in a row it is cut, and its seat is kept (D20) |
| Rooms in all | 1000 | `MAX_ROOMS` | `relay:error busy` |
| Idle room | 30 minutes without a game frame | `IDLE_ROOM_MS` | the room is closed (`relay:closed idle`); this also ends a wait for a partner who never comes back (D20) |
| Frame | 1 MiB | | the connection is closed (1009) |

- **Origin:** a browser always sends one. By default only the host the page was loaded from is accepted (same origin,
  no configuration needed in a one-container deploy). `ALLOWED_ORIGINS` is a comma list (`*` allows all). A client
  without an `Origin` header (a script, a test) is allowed.
- **Behind a proxy:** a platform, a tunnel or nginx stands between the players and the server, so every socket would
  come from the proxy's address and the limits would count everyone as one player. By default (`TRUST_PROXY` unset or
  `private`) a connection that comes from the machine itself or a private network is a proxy of the deploy, and the
  client is the first address from the right of `X-Forwarded-For` that is not private; a client on the internet cannot
  pass itself off as another this way. `TRUST_PROXY=<n>` takes that many entries from the right instead, and
  `TRUST_PROXY=0` never reads the header.
- **One address, one key:** before any limit or log tag sees it, an IPv6 address becomes its /64 (a home or a phone
  gets a whole /64, so a new address in it costs nothing) and an IPv4-mapped one (`::ffff:a.b.c.d`) its IPv4
  (`normalizeIp`, `coop-server/src/untrusted.ts`; the Worker does the same). The Worker's limits stay per instance
  (D22): a limit over the whole relay there is the platform's (a WAF or Rate Limiting rule on `/coop`), not code.
- **Requests:** a request target that is no URL is answered `400`, and `//` is a path (`new URL("//", base)`
  throws); nothing a request carries may throw out of a listener. A request the HTTP parser refuses is dropped; the
  headers must come within 15 s and the request within 30 s. A download the browser gives up on closes its file. The
  socket count of an IP is given back when the connection closes, whether the handshake completed or not. A last
  resort in `main.ts` logs an uncaught error and keeps the server (and every room) up.
- **Logs:** room codes, seats, reasons and counts. Never a message, a token, or an IP address (a short salted hash
  stands in for it). The one exception is the client diagnostics log, when an operator turns it on (D26).
  A code from a client is logged only if it has the shape of one (else `(invalid)`); any other text of a client (the
  `Origin`) is clipped, and its control characters and braces are written out, so it cannot forge a line, reach the
  terminal, or pass for a client line in `scripts/log-view.ts` (which escapes what it prints too). Refusals (origin,
  `429`, `relay:error`) anyone can cause at will: the first 20 of a minute are logged one by one, the rest counted in
  one line.

## D24. Payload validation

- Before a sequenced decision is applied, **both** clients check that it is legal against the state they have: a move
  that is in the moveset and usable (PP, not disabled), a target that is valid for it, a party index that exists and can
  be sent out, an item that can be afforded or used, a reward index that is on the screen, a trade that the rules allow,
  a prompt answer of the right shape. The host already validates a guest's proposal before it sequences it (D2); the
  same rules run again on the receiving side of every `SEQUENCED` decision, so a corrupted or forged one is caught by
  the guest and by the host's own apply.
- An illegal decision is **rejected the same way on both sides**: nothing is applied, a `DesyncError` ("illegal
  decision") is raised and logged with the key and the reason, and the run goes through the normal resync path (D13:
  resync, three strikes). It must never throw out of the apply, crash the phase, or leave a window open.
- **The host checks a guest's proposal before sequencing it** (when its window is open): an illegal one is refused
  (`REJECT invalid`), nothing is sequenced and nobody desyncs. Decisions the host sequences are still checked on both
  sides. Legality covers the move's use mode, the targets of a spread move (all of them) and of a queued move, a Ball at
  one live foe with the command phase's own rules (boss shields, encounters that forbid it), Run (a trapped Pokémon
  cannot), and a Baton switch (only with a held Baton or a Baton Pass that worked).
- **Bounds:** decision keys (wave and turn in range, a short ref), payload sizes, the frames a client holds for later,
  the proposals the host parks (a full park refuses, it does not fail the run), a partner's checkpoints, display names
  (no text-markup codes), and every field of a partner's collection.
- The checks are pure functions of the decision and a small read-only view of the state (`checkDecisionLegal` in
  `src/coop/legal.ts`, the view in `src/coop/legal-view.ts`), so the same code runs in Node tests with illegal payloads
  of every kind. The host's validation is `validateProposal` in `src/coop/validate.ts`.

## D25. AGPL source link

- The title screen shows a **Source** link to `VITE_SOURCE_URL` (the repository of this fork), as the AGPL asks of a
  service that runs a modified version.
- A production build fails if `VITE_SOURCE_URL` is not set (a Vite plugin checks it at `buildStart`,
  `plugins/vite/require-source-url.ts`); development and test builds do not need it.

## D26. Client diagnostics log

A deployed game has to say what went wrong in a player's browser without the player opening developer tools. The desync
report (D13) only exists once a run is stopped; this log also covers hangs, errors and resyncs that recovered.

- **The co-op log** (`src/coop/coop-log.ts`) records, from the moment a player chooses Co-op:
  - the session and the lobby (room code, seat, display names, picks, ready, start);
  - every sequenced decision (key, `seq`, author, take over, a short payload) and refused proposals;
  - the link (partner away, back, ended, and why), resyncs and desyncs;
  - the co-op code's errors and warnings, and the page's uncaught errors;
  - a note when no phase has started for 60 s, with where the game is (phase, screen, message, open window).

  It never feeds the simulation.
- It is kept in memory (4000 entries) and in `localStorage` (the last 1500), so a reload or a crash keeps it.
- **Upload:** the log is sent in batches to the server the relay is on (`POST /coop/log`, text JSON, at most 64 KiB): an
  error within a second, the rest every 10 s, and a beacon when the page is left. The server collects it only when it
  is started with `CLIENT_LOGS=1`; otherwise it answers 404 and the client stops sending. **This is the one exception to
  D23's "never a message":** an operator who turns it on gets the decisions of the runs on their server. It is off by
  default and meant for a private playtest whose players know.
- **Server side** (`coop-server/src/client-logs.ts`): one JSON line per entry (server time, a salted tag instead of the
  IP, session, room, seat, name, build, the entry) on standard output, so `docker logs` has it beside the relay's own
  lines, and, with `LOG_DIR`, in daily files kept under a size cap. Per-IP rate limit, the same Origin rule as the
  relay, a body cap. Never a seat token or an address. `coop-server/scripts/log-view.ts` prints the lines of a room as
  one timeline.
- **"Report a problem":** a small page button outside the game's canvas (so it works when the game does not answer),
  shown during a co-op session, and an entry in the co-op menu of the title screen (for after a reload). It asks for an
  optional note, adds a snapshot of the game (party, enemies, the last 120 phases, the last checkpoints), sends the log
  at once, and saves it as a file as well.

## D27. Pacing: the host's screen is the clock of the text

Without pacing, each client would press through its own text (battle lines, a trainer's speech, level-ups), so a player
who looked away would still be reading while the other already waited at the next decision. The decisions would be in
step; the screens would not.

- **Position:** `[checkpoint, phase, prompt]`: the D13 checkpoints taken in this epoch, the phases started since the
  last one, the shared prompts closed in the current phase. Between two checkpoints both clients run the same phases,
  so a position names the same line on both (the STE-twin test checks it over a whole run). The command menus
  (`CommandPhase`, `SelectTargetPhase`) are not counted: how many of them a client runs is its player's doing (a move
  with a target, a cancel). Before the first checkpoint of an epoch (lobby, reload) nothing is shared. A position is
  never a key of the simulation (D2): a wrong one only changes when a line closes on the guest's screen.
- **Shared line:** a line that waits for a press in the message box of the battle or the evolution scene (`MESSAGE`,
  `EVOLUTION_SCENE`), except in the command menus and on the decider's side of a bridge decision (`coopDecide`'s `ask`,
  and a take over's: learn-move, biome, catch release, switch, side action), whose lines only that player sees. Lines
  on other screens (party, rewards, trade) are not counted.
- **Host:** sends `pace {at, game, exp, hp, iv, anim, stats}`, an unsequenced `COSMETIC` state (D16 channel: latest
  wins, at most 8 per s, burst 4). A change sends it at once, then at most once per 150 ms with the latest position (the
  phases of a move start in bursts, and the guest looks every 250 ms anyway). It is sent again when the partner is back,
  and after 10 s without a change, so one the relay dropped is repaired. (It was on every change and every 2 s: three
  in five relay messages of a battle were `pace`.)
- **The guest follows:** a shared line closes by itself once the host is past it, and while the guest is behind, its
  lines appear at once. A panel of its own (level-up stats, IVs) closes once the host is past it too, and the IV
  Scanner question (`ScanIvsPhase`) is answered no. Nothing follows on the host.
- **Either player presses:** the guest's press on a shared line closes its own and sends `press {at}` (an event, 5 per
  s, burst 3); the host closes its line if it waits on that same position. A press never closes a line the host has not
  reached, so the host never misses one; the guest can read ahead and then waits at the next decision as before.
- **Speed:** while the run lasts, the guest uses the host's game speed, EXP bar speed, HP bar speed, IV Scanner, move
  animation and level-up stats settings: an overlay like D1's (general and display settings; never saved, taken off at
  the end), updated live when the host changes them.
- **Epoch:** a new epoch starts the positions again and forgets the host's.
- **Not a decision:** pacing never sequences, hashes or changes the simulation; closing a line does what the player's
  press would. Both players should play in the same language: a line split into pages differently would count
  differently.
- **Pad and touch (D16):** outside the starter, dex and settings screens, the two buttons that cycle gender and ability
  there also ping and open the emote wheel: a pad's LT pings and its RT opens the wheel (G and E on a keyboard). A touch
  screen has a ping button beside the emote button.

## D28. Party edits on the reward screen

- From the party screen of the reward screen, each player can reorder, release, rename, pause or unpause the evolutions
  of, switch the form change items of, and unsplice **their own** Pokémon, as in solo play. The partner's Pokémon only
  show their summary and dex entry.
- An edit is a `PARTY_EDIT` decision of the reward window (either seat, `ref = "${screen}:${step}"`): like a shop buy it
  takes a step, and it does not close the screen. If another decision takes the step first, the client proposes the
  edit again in the next step (up to 5 times) instead of telling the player it was too late. Nobody takes it over.
- **Rules** (the host validates before it sequences, both clients check before they apply, D24):
  - every Pokémon the edit names is the author's;
  - a swap is between two of their own, so the partner's order (and who leads for the partner, D7) never changes;
  - a release keeps at least one of their own;
  - unsplicing needs a fusion, a form item must be held, a pause needs an evolution;
  - a nickname is the rename form's base64, at most 96 characters.
- **Apply** (both clients): a swap exchanges the two party positions; a release removes the Pokémon's items, the
  Pokémon and its owner entry; the others set the nickname, the pause flag or the form item's state (with its form
  change), or undo the fusion. A party screen that is open on either client is drawn again.
- Still off: discarding items (D9), and party edits during a battle or from the pause menu.

## D29. Mystery Encounters

- **On in co-op.** The co-op game mode has them. The spawn, the pick and the set-up are seeded as in solo, so both
  clients meet the same encounter.
- **Who decides: the host,** for every choice of an encounter:
  - the option, the Pokémon it asks for (any Pokémon of the party, the guest's too, as in solo play; the guest sees the
    pick), the menu after it (a move, an item, a nature…), the follow-up menus (Safari Zone), and its yes/no prompts.
  - Each is a sequenced decision `ME_CHOICE`, `ref = "${n}"`, where `n` counts the encounter decisions of the wave.
    Both clients run the same encounter, so they count the same `n`.
  - Both clients then run the encounter's own code with that choice, so whatever it draws, it draws on both.
  - The guest sees the same screens, read-only, with "{host} is choosing…" and the host's cursor, and can ping. After
    90 s it may take over (D17) and choose with the same screens.
  - The host's cursor on the options is the cosmetic `meCursor` (D16): the guest's cursor follows it, in the partner's
    colour. The guest can move it to read another option's tooltip; the host's next move takes it back.
  - "{host} is choosing…" replaces the encounter's question under the description: on this screen the message box is
    under the options.
- **Pokémon the encounter picks by itself** (Dark Deal's random one, An Offer's strongest, Mysterious Chest's highest
  level, the lead that receives an item): from the whole party, as in solo.
- **Whole-party effects** hit both players' Pokémon, as in solo. A Pokémon an encounter replaces (Weird Dream's
  transformations, a GTS trade) passes its owner to the one that takes its place.
- **New Pokémon** (Absolute Avarice, Dancing Lessons, Uncommon Breed, the Salesman, the Safari Zone's catches) go to the
  chooser, with the cap of 3 (D10). At the cap the chooser releases one of their own or declines, through the
  `CATCH_RELEASE` decision, which replaces the encounter's own party-full prompt.
- **One-Pokémon encounters** (The Expert Pokémon Breeder, Fun and Games): the host first decides who goes (itself, the
  guest, or nobody: the encounter is left the way its leave option leaves it). The player who goes picks among their
  own Pokémon and plays it, and the other watches. These two stay singles.
- **Battles are 2v2:**
  - Every other encounter battle is a double: `initBattleWithEnemyConfig` keeps co-op's double.
  - A trainer sends two Pokémon at a time. A trainer whose party has one Pokémon gets a second one (seeded) from its
    own party pool.
  - A lone wild Pokémon stays two against one, and is stronger: +1 Attack, Defense, Sp. Atk, Sp. Def and Speed once
    both sides are out, and one more boss shield (a Pokémon that is not a boss becomes a boss of two shields). Beating
    it gives double the EXP, plus the money of a trainer win of that wave.
  - Before the battle, the arrange step (D7) puts each player's lead in their slot.
- **The encounter's shops** are reward screens like any other: the picker alternates (D9), and a trade can be asked for
  (D11).
- **Account writes** of an encounter (dex, candy, egg moves, unlocks) go to the owner's account (D4a); "seen" goes to
  both. Eggs and vouchers: D30.
- **Determinism:**
  - The GTS ball roll is seeded, and enemies an encounter builds get a unique id like any co-op Pokémon (D3).
  - Weird Dream's species search starts from a copy of its BST range in co-op (upstream widens the module constant
    itself, so a client that played it before would draw other species).
  - The requirement check of an option may draw (it picks the encounter's primary Pokémon), and the option screen is
    drawn again on one client alone (back from "View Party"). In co-op the check draws from its own seeded stream, so it
    gives the same answer however often it is asked.
- **A decision of a reloaded world** that an encounter was waiting for rejects (D18) and is ignored, as everywhere else.

## D30. Eggs and vouchers

- **Hatching:** eggs belong to an account, so each client hatches its own.
  - `EggLapsePhase` runs on both clients (the same phases). It counts down this client's eggs and hatches the ones that
    are due without the animation (`eggSkipPreference` is not asked in co-op), then shows this client's hatches in the
    summary screen, inside the same phase.
  - The host's summary waits for the host's press (at least 1 s). The guest's closes on a press, or once the host is
    past it (D27), so the run never waits on it.
  - A client with nothing hatched shows nothing.
- **Eggs from an encounter** (A Trainer's Test, The Expert Pokémon Breeder) go to both accounts: each client adds one of
  the same tier to its own. An egg never touches the run: its draws are unseeded (`Math.random`), outside the
  simulation's stream. Egg creation is not guarded against co-op.
- **Vouchers:**
  - A voucher picked on a reward screen is applied by both clients, so both accounts get one.
  - A boss trainer's voucher (gym leaders, team bosses, Elite Four, Champion) runs the same phases on both clients,
    whatever each account has unlocked already: one reward phase, whose voucher is decided per client, as in solo. On
    this account's first win it is the boss's own (Voucher Plus for a gym leader, Premium for the Elite Four and the
    Champion) and the unlock is recorded; on a later win it is the lesser one.
  - The Winstrate Challenge's voucher goes to both accounts.
- **The egg gacha:** open during a co-op run too, from the menu, as on the title screen. A pull takes this player's
  vouchers and adds the eggs to this account only. The eggs and their order are drawn outside the run's stream (the
  egg's seed override; an unseeded shuffle in co-op), so the partner's client draws nothing. It saves only the account:
  the run is saved at the start of a wave, to the co-op slot (D19). A player in the machine is like a player away from
  the keys: a decision waits for them, and the partner may take over (D17).

## D31. Importing a pokerogue.net account

- **What:** a player brings their own account from the official site. There, Menu > Manage Data > Export Data gives
  `data_<user>.prsv` (the system data, AES with the public `saveKey`). Here, the co-op menu's "Import PokéRogue data"
  (it first says where the file comes from) or Manage Data > Import Data reads it, and after a confirm it replaces this
  browser's account and reloads the page. The starter select and the co-op lobby then have the player's own Pokémon,
  candies, eggs and vouchers, and the partner's co-op starter select has them too (D32).
- **Where it is offered:** Import Data is shown with local accounts (`bypassLogin`, as this fork's deploy builds), as in
  dev, beta and app builds; a build with a PokéRogue server account stays as upstream.
- **Not during a co-op run:** the import reloads the page, so it is refused while a co-op session is open (checked when
  it is asked, when the file is read, and at the confirm).
- **This browser's trainer and secret IDs stay** (as upstream's import already did): a host's saved co-op run is found
  again by them (D21), so it can still be continued. The player is told so.
- **A save from a newer version** (the site may be ahead of this fork): what this build does not have is left out, so
  the account loads and nothing crashes: species and eggs it does not know, forms it does not have (a species caught
  only in such a form keeps its first form), movesets with moves it does not have; a starter the save lacks gets an
  empty entry; the version is stamped with this build's. The player is told both versions and how many Pokémon (that
  they had something of) and eggs were left out. An older save is migrated on load like any other. A file that is not
  a system save, or that would fail the check every save makes, is refused, and the player is told which file it is: a
  saved run (Export Session) or the run history is the usual mistake, so those are named, with where the account's
  export is (Manage Data > Export Data). An account given to Import Session says to use Import Data.
- **The notes** before the confirm go on by themselves (no key prompt): the import is asked from a menu, whose handler
  would take the key.

## D32. The starter select of both players

- **Shared points:** the two parties share 15 starter points (`COOP_STARTER_POINTS` in `src/coop/protocol.ts`; a solo
  classic run has 10 for a party of six). A player may spend what the partner's party leaves (D7: up to three each).
- **Shared collection:** the co-op starter select shows the Pokémon of both players, so a player whose account is new can
  pick what the partner has caught.
  - On entering the lobby each player sends a `LOBBY` `collection`: the caught species of the dex (caught and seen forms,
    natures, IVs) and the starters with something unlocked (abilities, passive, cost reductions, egg moves, classic wins).
    Candies and counts are not sent. A collection with `ask` is answered with the receiver's own, so both arrive whoever
    enters first. The starter select opens once the partner's is there (or after 15 s without it, with the player's own
    Pokémon only).
  - While the lobby is open, `gameData.dexData` and `starterData` are a merge of both (`src/coop/shared-collection.ts`):
    the forms, shinies, genders, natures, abilities, egg moves and passives either player has, the better IV of each stat,
    the bigger cost reduction. Candies, friendship, the egg pity, counts, ribbons and the custom moveset are the player's own.
  - **Nothing of the partner's is saved to the player's account.** The system save writes the account's own data while
    the merge is in place. In a merged entry, what the screen changes is written to the player's own entry: candies spent,
    a passive or cost reduction bought (the next one after the bigger of the two), the custom moveset. A passive only the
    partner unlocked can be turned on and off there; that choice lasts until the lobby closes.
  - The merge comes off when the lobby closes (`closeStarterLobby`): the run starts, or the players leave.
- **In the run:** the account snapshot of `ready` comes from the merge (D4), so the simulation reads the egg moves and
  dex of what was picked; the host's dex count (critical captures) is the count of both. Account writes during the run
  are as D4a: a Pokémon picked from the partner's collection earns its candy and dex entries on its owner's account.
- `COOP_PROTOCOL_VERSION` is 5: a page of the earlier version refuses to pair with this one.

## D33. Timed events

Upstream's timed events (Halloween, the winter holidays and the others in `src/data/balance/timed-events.ts`) change the
simulation: shiny rates, the wild Pokémon, rewards at fixed waves, biome links, Mystery Encounter tiers, candy. Upstream
turns them on by the computer's clock, and two clocks can disagree (a few minutes around an event's start or end, or a
wrong date). So a co-op run does not read the clock:

- **Chosen at run start.** Each player's `ready` (`LOBBY`) carries the names of the events their clock has on
  (`TimedEventManager.eventsByClock`). The host's `START` has `timedEvents`: those its own clock has on now that the
  guest's has on too. A client whose clock has an event off did not load its pictures at boot (banner, logo, sprite
  replacements), so an event only one clock has on is left out.
- **Kept for the run.** The session keeps them, the `coop` block of the save has them (`events`), and a reload, a rejoin
  or a run continued later has them again (D13, D20, D21), even after the event has ended: the run goes on as it
  started. A save of an earlier version has no `events` and its run has no event.
- **Read through `isActive`.** In co-op `TimedEventManager.isActive(event)` is whether the run's list names the event;
  before `START` (the lobby) the list is empty. Everything else in the manager goes through it, so every reader of an
  event sees the same on both clients. In solo play the clock decides, as upstream.
- **Hashed.** The list is part of the state hash (D13): a client that lost it is a desync, not a quiet difference.
- `COOP_PROTOCOL_VERSION` became 6 here (`START` and `ready` changed); it is 7 since `ready` and `reset` carry a
  count (a reset answers one ready of the guest, and an older one is ignored).
- **Pictures and music** of an event (the title banner and logo, image replacements) are loaded at boot by the clock,
  as upstream: they are only what each player sees.

## D34. Trainers the run has met

A biome has few trainer types (a cave has two common ones and four uncommon ones, three gym leaders), so upstream meets
the same ones again and again. A co-op run prefers the ones it has not met:

- **Remembered:** the trainer type of every wave's trainer battle (`generateNewBattleTrainer`), once, in the session.
  The trainers an encounter offers (Mysterious Challengers) are not.
- **The pick** (`Arena.randomTrainerType`, `src/coop/trainer-variety.ts`): the tier is drawn as upstream. A trainer of
  that tier is drawn as upstream (`randSeedItem`'s one integer, or none for a single trainer); if the run has met it,
  it is swapped, without a draw, for an unmet one of that tier or of the closest lower tier of the same kind (a gym
  leader only for a gym leader). Only when the run has met all of them does the drawn one come back. The stream moves
  exactly as upstream's, whatever the run has met.
- **Kept:** the `coop` block of the save has them (`trainers`), so a reload, a rejoin and a continued run pick the same.
  A save of an earlier version has none. A new run starts with none.
- **Hashed** (D13), like the timed events.
- Solo play picks as upstream.

## D35. Play again

At the end of a run (a victory, or a wipe the host did not retry), each player chooses **Play again with {partner}** or
**Back to title** on the end screen (`src/coop/play-again.ts`). A pair that wants another run does not share a new code.

- **From the run's end on** (`GameOverPhase.handleCoopRunEnd`, on both clients at the same point): the session is
  `runOver`, so the partner leaving is the end screen's to say, not "ended the session". What only a run needs stops
  (pacing, the reconnect and resync screens, the take-over clocks, cursors and emotes); the link stays.
- **The answers** are `LOBBY` messages on the run's link: `again` (`want`), heard from the run's end on, so an answer that
  comes before this client's end screen asks is kept. Nothing is sequenced: the run is over.
- **Both want to:** the host creates a new room and sends its code (`againCode`). The guest leaves the old room as soon as it
  has the code; the host leaves it when the guest has (or after 10 s). At the title screen the host waits in the new room
  (its code is shown, should the guest have to type it) and the guest joins it by itself. From there it is a new game: a new
  handshake (D1), a new session, the starter select (D32).
- **Otherwise:** a player who goes back to the title tells the partner, who reads "{partner} went back to the title"; a
  partner who left the room reads "{partner} left the game". A room that cannot be created, or a code that does not come in
  20 s, reads "Could not start a new game with {partner}". Each then goes to the title screen.
- A session without a link (the rules harness) shows "Co-op run ended" for 2.5 s, as before.
- `COOP_PROTOCOL_VERSION` is 8 since `again` and `againCode`.

## D36. Rules kept as they are

Settled by the owner on 2026-10-28, so they are not proposed again:

- **Achievements** a run earns unlock on both accounts, whichever player's Pokémon earned them: the run is shared.
- **Gifts** stay free whatever the counts (D11): a 5-and-1 split is the players' choice.
- **Retries** after a wipe are not limited (D4a): the host chooses each time.

## See also

- [HOW-TO-PLAY.md](HOW-TO-PLAY.md): co-op for players.
- [HOSTING.md](HOSTING.md): running your own server.
- [ARCHITECTURE.md](ARCHITECTURE.md): how the code implements these rules.
- [The project README](../../README.md).
