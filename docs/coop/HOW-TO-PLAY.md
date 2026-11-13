<!--
SPDX-FileCopyrightText: 2026 pokerogue-coop contributors

SPDX-License-Identifier: AGPL-3.0-only
-->

# How to play co-op

Two players, each on their own computer, play one Classic or Endless run together. Every battle is a double battle: each of you brings
three Pokémon and controls one side of the field. Both of you need the same game address (a website, or a link from a friend
who hosts it, see [HOSTING.md](HOSTING.md)) and a recent Chrome, Edge or Firefox. Keep the game in its own window: a tab in
the background runs slowly. Trying it alone in two tabs or windows of one browser? Both share one save, so each one's
progress (candies, catches) overwrites the other's, and the game says so in the chat: open the second player in a
private window or another browser instead.

## Starting a game

1. **Both:** on the title screen choose **Co-op**, then **Your name** and type the name your friend will see.
2. **One of you hosts:** **Host a game**, then **Classic**, **Endless** or **Challenge** (pick the challenges, then
   Start). A six-character code appears; **Copy code** puts it in the clipboard. Send it to your friend. (With
   **3-Player Co-op (Beta)** on in the settings, Host a game first asks **2 players** or **3 players (Beta)**: see
   [Three players](#three-players-beta).)
3. **The other joins:** **Join a game** and paste the code. You play the kind of run your friend chose; the starter select
   says "Endless" when it is one.

   **No friend to play with?** Choose **Find a partner** instead (on the website), then Classic or Endless: the game pairs
   you with the next player who is looking for the same kind of run, and you land on the starter select together. It may
   take a moment when few people are looking. To play with a friend, use a code: Find a partner gives you whoever comes
   first.
4. The starter select opens for both, with **the Pokémon of both of you**: you can pick anything your friend has caught,
   with their shinies, forms, IVs and unlocks. Pick up to three starters each; you share **15 points**, and you see your
   friend's picks as they make them. When both press ready, the run starts. Leaving the starter select (Cancel with no
   starter picked) asks first, with the cursor on **No**: leaving ends the game for both of you.

The host's Pokémon fight on the left, the guest's on the right.

**Endless** is free in co-op: you do not have to beat Classic first. It plays as solo Endless (shorter biomes, a boss every
50 waves, no trainers) and only ends when both of you are out of Pokémon and the host does not retry.

## Battles

- **You both choose at the same time.** Your friend sees which move you are looking at and a check mark once you have chosen.
- **Fainted Pokémon:** the owner picks the replacement from their own Pokémon. If they have none left, the partner sends in
  one of theirs, and the partner then commands both sides.
- **Balls and running away** use the whole side's turn, so the partner is asked first ("let them throw?"). If you both choose
  a Ball (or a Ball and Run) in the same turn, the host picks which one happens.
- **Catching:** the catch goes to whoever threw the Ball. Each player holds up to three Pokémon: with three already, you
  release one of yours, or one of your friend's that is not in the battle (then the catch is theirs, Pokédex and candy
  too, and they are told), or let the catch go.
- **Aiming at your friend's Pokémon:** if you point an attack at your friend's Pokémon, the game asks first, so a stray
  button press doesn't hit them.
- **A wipe:** when both sides are out of Pokémon, the host chooses **Retry the wave** (both of you start that wave again from
  its beginning) or **End the run**.

## Between battles

- **Rewards:** you take turns picking the free reward, the host first. Either of you can buy from the shop at any time, and
  move held items between your own Pokémon.
- **Your party:** on the reward screen you can reorder or rename your own Pokémon, and release yours or your friend's
  (everyone keeps at least one; your friend is told).
- **Trading:** press **Trade** on the reward screen; the trade screen opens after it and says each step at the bottom.
  Pick one of yours and one of your friend's, then **Propose**; your friend accepts or declines. Pick only one of yours to **Give** it away for free (you always
  keep at least one). Both press **Done** to go on.
- **DNA Splicers** fuse two of your own Pokémon only: your friend's are dimmed on that screen.

## Three players (Beta)

Three friends can play one run together. It is a Beta: turn it on with **Settings → Co-op → 3-Player Co-op (Beta)**
(only the host needs it; joining a game of three works with the setting off).

- **Starting:** **Host a game → 3 players (Beta)**, then the kind of run. Send the code to both friends; each joins with
  **Join a game**. The starter select opens when all three are in: you share **20 points** and pick up to **two** starters
  each. Each friend's picks show in a window of their own, with their name in their colour (P1 yellow, P2 blue, P3 green).
- **Battles:** three of yours against two. Left to right: the host's Pokémon, the first guest's, the second guest's. Your
  own Pokémon has the full HP box; each friend's has a small bar over it with their name. Enemies are tougher (more HP and
  attack) to make up for the third Pokémon. Every Pokémon can target any enemy or either ally.
- **Balls and running away** are the host's call: a guest's Ball or Run waits for the host to accept; the host's needs
  nobody's.
- **Fainted Pokémon:** the owner sends in their other one. With none left, the next player in order (host, guest, second
  guest, then the host again) sends one of theirs and commands it.
- **Catching:** each player holds up to two Pokémon; with two already, you release one or let the catch go.
- **Rewards** go round: the host picks first, then the first guest, then the second. **Trading:** pick one of yours and
  one of either friend's (their names are in their colour); for a gift, choose **Give to …**. The third player watches
  while two trade; the screen ends when all three press Done.
- **Someone leaves:** the other two play on; the host is asked to take over the missing player's choices. A friend who
  comes back (or reloads the page) joins again at the start of the next wave. If the host leaves, the run waits for them.
- **Saving:** **Continue (3 players, wave N)** asks 2 or 3 players. With 2, it plays as a normal game of two and the
  missing friend's Pokémon are commanded by the two of you, one each, until they are back.
- **Chat** is one box for all three, each name in its colour. **Play again** starts a new game with whoever wants it.

## Debug menu (for messing around)

The host can cheat: **Settings → Co-op → Co-op Debug Menu (Host)**, then **F8** opens the **debug window**: a window
of its own, connected to your game (the key can be changed in **Menu > Settings > Keyboard**). Put it beside the game or
on a second screen; the game keeps running. Only the host has it; friends only see what happens.

- **Left:** both teams and the field, live: HP, status, boss bars, who owns which Pokémon, the weather. Click a Pokémon to
  edit it.
- **Top:** quick buttons (win the wave, heal the team, everyone to level 100, +10k money, 99 Master Balls, enemies to
  1 HP, free shop, no damage) and a search box that finds any option.
- **Pokémon:** level, IVs, nature, any ability or passive, friendship, species, fusion, shiny, gender, Tera type, moves,
  held items (give any, take one away), heal, give a Pokémon to another player, remove one, or add any Pokémon to anyone.
- **Enemies & Field:** knock out, 1 HP, full HP or the level of an enemy (or all of them), stat stages, status, weather,
  terrain.
- **Waves:** the **Next battle** card plans the next wave (or a later one): pick its kind, or just pick a Pokémon and
  it is a wild battle. Each enemy gets its species, a fusion (with a Pokémon you pick, or a random one), its level and
  shiny rarity (★, ★★, ★★★); **More** holds its boss bars, ability, nature, Terastallize, gender, moves and held items.
  A trainer battle can have up to 6 team members planned; the rival, evil team, Elite Four and champion battles always
  happen, with your Pokémon on their team. One line says what the wave will be. Below: the other planned waves, a jump
  ahead to a later wave, and the next biome.
- **Rewards & Shop:** the **whole item catalog**, every exact item: each Mega Stone, evolution item, TM, berry, mint,
  Tera Shard and so on, and in **Game picks** a random item of a tier (Master, Rogue, Ultra, Great, Common). Click up
  to 8 for the next reward screen (on a reward screen, it changes at once). The items that
  fit your team come first. Mega Stones work when held even without a Mega Bracelet; the bracelet only lets the game roll
  them by itself, and the window offers it. Also free shop and rerolls, money, Poké Balls, team items.
- **Modes:** no damage for your team, one-hit knockouts, shiny enemies, every enemy's level, EXP and money multipliers,
  everyone shiny, random species.

**One click is one change**: picking from a list applies, a number applies on Enter. Changes happen with the next turn
(or at once on a reward screen). The **change log** on the right shows what is pending (× takes it back) and what was
applied, and on which turn; changing the same thing twice keeps only the newest. If the game reloads, the window says so:
press F8 in the game to connect it again. If your browser blocks pop-ups, the same opens over the game instead (Esc
closes it). A cheated run counts for your accounts like any other.

## Mystery Encounters

They appear as in single player. The host makes every choice of an encounter; the guest's cursor follows the host's (and the
guest can still move it to read another option). A Pokémon the encounter asks for (training, a trade, a part-time job…)
can be any Pokémon of the party, yours or your friend's. Encounters that only one Pokémon can enter first ask the host who
goes: the host, the guest, or nobody; the one who goes picks one of their own Pokémon. Encounter battles are two against
two; a lone wild Pokémon is made stronger and gives double experience and money.

## Trainers

A run remembers the trainers it has fought. A biome's next trainer is one you have not fought yet, as long as the biome has
one left (a gym leader for a gym leader); only then does one come back.

## Eggs, vouchers and your account

- An egg or a voucher won in the run goes to **both** of you. Eggs hatch between waves, each in its own player's game.
- **Menu > Egg Gacha** works in the middle of a run; your friend waits while you are in the machine.
- What you catch is added to **your own** account (your starter select), and your account is saved at the start of every
  wave.
- Your friend's Pokémon are only borrowed on the co-op starter select: they are never added to your account, and candies
  you spend there are your own.

## Events

Events like **Halloween** are on in co-op too: more shinies, event Pokémon in the wild, extra rewards and candy, as on
pokerogue.net. A run has the events that were on for both of you when it started, and keeps them until it ends, even if
the event ends first. If one of your computers has the wrong date, the run starts without the event.

## Bringing your own Pokémon from pokerogue.net

On pokerogue.net: **Menu > Manage Data > Export Data**. That downloads a `.prsv` file. Here, on the title screen: **Co-op >
Import PokéRogue data**, choose that file and confirm. The game reloads with your own Pokémon, candies, eggs and vouchers. If
pokerogue.net is on a newer version than this game, whatever this version does not have is left out (the game tells you how
much). Importing is not possible during a co-op run.

## Keeping your save safe

Your save lives only in your browser: clearing cookies or site data deletes it, and no server has a copy. Back it up with
**Menu > Manage Data > Export Data** now and then; **Manage Data > Import Data** brings it back. After two hours of play
since your last backup (and at most once a week), the title screen offers to make one; **No** puts it off for a week.

## Taking a break

- **Menu > Save and Quit** (or just close the game). The host's browser keeps the run, saved at the start of the wave.
- Next time the **host** chooses **Co-op > Continue (wave N)** (**Continue (Endless, wave N)** for an Endless run), which
  gives a new code, and the **guest** joins it. It must be the same two accounts as before. Progress inside a wave is not
  kept: you start that wave again.

## When something happens

| What you see | What it means |
|---|---|
| "Waiting for … to reconnect" | Your friend's connection dropped. They come back by themselves after a reload; both of you continue from the start of that wave. After a minute you can **End session**. |
| "… is still choosing", then **Take over** | Your friend has not answered for a while. Taking over makes that one choice for them. |
| "You and your partner run different versions" | One of you has an older page: reload with **Ctrl+F5**. |
| "Your games keep getting different results" | The two games disagreed three times in one wave and the run stopped. Press **Save report** (both of you), send the two files to whoever runs the game, then **Back to the title screen**: **Continue** brings you back to the start of that wave. |

The **Report a problem** button (top left of the page) saves a log of your co-op session, and sends it to the server if the
server collects logs. It contains your display names and what you chose in the run, no account data or passwords.

## Controls

| Action | Keyboard | Gamepad | Touch |
|---|---|---|---|
| Ping what your cursor is on (your friend sees it) | **P** | the button of "Cycle Gender" (left trigger) | **!** button |
| Emote wheel | **Q** | the button of "Cycle Ability" (right trigger) | emote button |
| Chat with your partner | **H** (Enter sends, Esc closes) | | **Chat** button, top right |
| Debug window (host, when on) | **F8** | | |
| Zoom the battlefield out / in (your screen only) | mouse wheel, or **numpad −** / **numpad +** | | |
| Hide or show an HP box (your screen only) | click its small eye (an enemy's by its level, yours by its name) | | tap the eye |

The keys can be changed in **Menu > Settings > Keyboard**.

**Menu > Settings > Co-op** chooses what you see of co-op: your partner's move tags and target pointers, ping and
emote bubbles, their cursor on the reward screen, the hide buttons on the HP boxes, the chat pop-ups and button, the
report button, the mouse wheel zoom and more. It only changes your screen, never your partner's.

**Your own view:** zooming out (down to 60%) and hiding HP boxes change only your screen; your partner's stays as it
is. A hidden box leaves its type and a closed eye at the screen's edge: click the eye to bring the box back. Your
browser remembers both.

**The chat** is there in every co-op game. Swear words and links are hidden, for both of you, and **Mute** in the chat
hides your partner's messages. Drag the chat by its title bar or its button to put it anywhere on the screen (your browser
remembers the spot); double-click the title bar to put it back. A message that arrives while the chat is closed shows under the Chat button for a few
seconds.

## Limits

- Two players per game; nobody can watch.
- No daily runs in co-op. A challenge run's win gives vouchers, as in solo; a plain co-op win gives ribbons and counts as
  a co-op clear.
- The co-op texts are in English; the rest of the game keeps its languages.
- A room closes after 30 minutes without any play.
- The host's run lives in the host's browser: clearing the site's data loses it.
