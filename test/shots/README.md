<!--
SPDX-FileCopyrightText: 2026 pokerogue-coop contributors

SPDX-License-Identifier: AGPL-3.0-only
-->

# `pnpm shot`: screenshots of one co-op interaction

One command brings two or three players to a screen and shoots every step of it, from every player, without a game
window: headless browsers on the dev build, linked through the local relay. A shot takes about a minute with a GPU.

```bash
pnpm shot --list
pnpm shot me:the-expert-pokemon-breeder --players 3 --goer guest2
pnpm shot wave:trade --seat guest
pnpm shot breeder --all
```

A part of an id is enough when it is the only one that matches (`breeder`). `"me:*"` runs every scenario whose id starts
with `me:`, one after another; `--all` runs one scenario once for each value of its sweep variable (an encounter's
options).

## What you get

A folder per run, in the system's temp folder (`pokerogue-shots/`) unless `--out` names another:

| File | What |
|---|---|
| `NN-<step>.png` | the step, every player side by side, each labelled with its phase and screen |
| `NN-<step>-<seat>.png` | one player's own screenshot of the step |
| `index.html` | every step in order, with what each screen said |
| `shots.json` | the same as data; `failure` says why a run stopped |

A step is shot once every player's screen has settled (its mode, text, menu and the encounter's question have not
changed for a second, nothing on it slides or fades, a reward screen takes input) and only when it shows something no
step before it did. A run that fails still writes what it shot, plus a last step `failed-here`.

## Options

| Option | |
|---|---|
| `--out <folder>` | where the folders go |
| `--timeout <s>` | the most one scenario may take (default 300) |
| `--headed` | show the browsers |
| `--keep` | leave the dev server it starts running, so the next shot does not wait for it; `--stop` stops it |

Without `--keep`, a shot uses the dev server on port 8000 if one is running, else starts one and stops it after. One
shot runs at a time: the dev build has one relay address, so a second shot waits for the first.

The browsers draw on the GPU when the computer has one (Direct3D on Windows) and fall back to SwiftShader, the software
renderer the browser tests use (several times slower). The first line of a run says which.

## How it plays

`engine.ts` answers what the game asks like a player who takes the first entry of everything: "yes", the move and the
target under the cursor, the first Pokémon that can be sent out. The variables steer it: `--option` is the encounter
option, `--goer` who goes, `--pick` which Pokémon. A full party's "release one?" is answered no. A guest presses only on
lines of its own: the run's text follows the host's (D27). A run that goes round in circles stops with an error that
names the screens.

The players' accounts are new ones. Each gets the cheapest starters (Weedle, Rattata, Spearow, Seel) so that three each
fit the starter points; `--party` picks how many each starts with.

## Adding a scenario

A `Scenario` (`scenario.ts`) in a file of `scenarios/`, in that file's exported list:

```ts
const mine: Scenario = {
  id: "wave:something",
  area: "Between waves",
  summary: "one line for --list",
  // the variables it takes besides the common ones, with its own defaults (null: the variable's)
  vars: { seat: null, wave: 5 },
  async play(run, vars) {
    await run.toRun({ SOME_OVERRIDE: 1 }); // linked, overrides set, parties picked, the run started
    await run.drive({ until: states => states.some(state => state.ui === "MODIFIER_SELECT") });
  },
};
```

- `run.toRun(overrides)`: from nothing to the start of the run, with any of `src/overrides.ts`.
- `run.drive({ until, answer, shoot })`: play and shoot every new screen until `until`. `answer` gives the scenario's own
  action for a player before the bot's (`undefined`: the bot's, `null`: nothing); `shoot` can leave steps out.
- `run.shot(name)`, `run.press(seat, button)`, `run.state(seat)`, `run.waitFor(...)`: for steps by hand.

The mystery encounters need no edit: `scenarios/encounters.ts` makes one scenario for each `MysteryEncounterType`.

## Adding a variable

An entry in `VARIABLES` (`variables.ts`): a choice, a number or text, with its default and one line for `--list`. If it
depends on another variable, a check in `checkVars`. Add it to `COMMON` if every scenario takes it, or list it in the
`vars` of the scenarios that do, and use `vars.<name>` there.
