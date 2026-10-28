<!--
SPDX-FileCopyrightText: 2026 pokerogue-coop contributors

SPDX-License-Identifier: AGPL-3.0-only
-->

# How to play co-op

Two players, each on their own computer, play one classic run together. Every battle is a double battle: each of you brings
three Pokémon and controls one side of the field. Both of you need the same game address (a website, or a link from a friend
who hosts it, see [HOSTING.md](HOSTING.md)) and a recent Chrome, Edge or Firefox. Keep the game in its own window: a tab in
the background runs slowly.

## Starting a game

1. **Both:** on the title screen choose **Co-op**, then **Your name** and type the name your friend will see.
2. **One of you hosts:** **Host a game**. A six-character code appears; **Copy code** puts it in the clipboard. Send it to
   your friend.
3. **The other joins:** **Join a game** and paste the code.
4. The starter select opens for both, with **the Pokémon of both of you**: you can pick anything your friend has caught,
   with their shinies, forms, IVs and unlocks. Pick up to three starters each; you share **15 points**, and you see your
   friend's picks as they make them. When both press ready, the run starts. Leaving the starter select (Cancel with no
   starter picked) asks first, with the cursor on **No**: leaving ends the game for both of you.

The host's Pokémon fight on the left, the guest's on the right.

## Battles

- **You both choose at the same time.** Your friend sees which move you are looking at and a check mark once you have chosen.
- **Fainted Pokémon:** the owner picks the replacement from their own Pokémon. If they have none left, the partner sends in
  one of theirs, and the partner then commands both sides.
- **Balls and running away** use the whole side's turn, so the partner is asked first ("let them throw?"). If you both choose
  a Ball (or a Ball and Run) in the same turn, the host picks which one happens.
- **Catching:** the catch goes to whoever threw the Ball. Each player holds up to three Pokémon: with three already, you
  release one of yours or let the catch go.
- **A wipe:** when both sides are out of Pokémon, the host chooses **Retry the wave** (both of you start that wave again from
  its beginning) or **End the run**.

## Between battles

- **Rewards:** you take turns picking the free reward, the host first. Either of you can buy from the shop at any time, and
  move held items between your own Pokémon.
- **Your party:** on the reward screen you can reorder, rename or release your own Pokémon (keep at least one).
- **Trading:** press **Trade** on the reward screen; the trade screen opens after it. Pick one of yours and one of your
  friend's, then **Propose**; your friend accepts or declines. Pick only one of yours to **Give** it away for free (you always
  keep at least one). Both press **Done** to go on.
- **DNA Splicers** fuse two of your own Pokémon only.

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
**Menu > Manage Data > Export Data** now and then; **Manage Data > Import Data** brings it back. Once you have played a while
since your last backup, the title screen offers to make one.

## Taking a break

- **Menu > Save and Quit** (or just close the game). The host's browser keeps the run, saved at the start of the wave.
- Next time the **host** chooses **Co-op > Continue (wave N)**, which gives a new code, and the **guest** joins it. It must be
  the same two accounts as before. Progress inside a wave is not kept: you start that wave again.

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

Both keys can be changed in **Menu > Settings > Keyboard**.

## Limits

- Two players per game; nobody can watch.
- Classic mode only: no daily runs, endless mode or challenges in co-op.
- The co-op texts are in English; the rest of the game keeps its languages.
- A room closes after 30 minutes without any play.
- The host's run lives in the host's browser: clearing the site's data loses it.
