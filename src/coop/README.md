<!--
SPDX-FileCopyrightText: 2026 pokerogue-coop contributors

SPDX-License-Identifier: AGPL-3.0-only
-->

# src/coop

The co-op layer of the game. `protocol.ts` (the wire protocol) and `session.ts` (the session, `isCoop()`) sit here;
everything else is in a folder per area:

| Folder | What is in it |
|---|---|
| `transport/` | The relay's WebSocket, numbering and resends, epochs, rooms of three, matchmaking |
| `link/` | The link to the partner, the handshake, the title screen's Co-op entry and players online, the starter select, Play again |
| `decisions/` | The sequencer, decision keys and payloads, the bridge the phases call, who decides, legality, take over |
| `rules/` | Ownership, the arrange step, rewards, trades, party edits, encounters, catches, games of three |
| `sync/` | Seeded draws, the account snapshot, state hashes, checkpoints, the phase trace |
| `save/` | The save block, the co-op save files, resync, seat tokens, account import and backup |
| `cosmetic/` | Intents, cursors, pings, emotes, their hotkeys and touch buttons |
| `ui/` | The UI strings, waiting lines, take over menus, pacing, the chat, the HP bars of a battle of three, each player's zoom and hidden HP boxes |
| `diagnostics/` | The co-op log, "Report a problem", `window.__coop`, the stall detector, retries of failed downloads |
| `debug/` | The host's debug menu (D42) |

- How it fits together, every module, and where to start a change: [docs/coop/ARCHITECTURE.md](../../docs/coop/ARCHITECTURE.md).
- The rules and why (cited in the code as `D1`…`D45`): [docs/coop/DECISIONS.md](../../docs/coop/DECISIONS.md).

Two rules for code here: every co-op branch in the game is gated by `isCoop()`, so a single-player game runs upstream's
code; and nothing synchronised is keyed by a slot index, `battle.turn` or a local counter (D2).
