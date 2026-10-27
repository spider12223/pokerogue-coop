<!--
SPDX-FileCopyrightText: 2026 pokerogue-coop contributors

SPDX-License-Identifier: AGPL-3.0-only
-->

# src/coop

The co-op layer of the game: session, transport, sequencer, ownership, rewards, trade, resync and lobby.

- How it fits together, a map of every module, and where to start a change: [docs/coop/ARCHITECTURE.md](../../docs/coop/ARCHITECTURE.md).
- The rules and why (cited in the code as `D1`…`D31`): [docs/coop/DECISIONS.md](../../docs/coop/DECISIONS.md).

Two rules for code here: every co-op branch in the game is gated by `isCoop()`, so a single-player game runs upstream's
code; and nothing synchronised is keyed by a slot index, `battle.turn` or a local counter (D2).
