/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Concept (the turn's commands of both players are collected before the turn starts) from SunghoLee98/pokerogue
 * `src/coop/coop-turn-commands.ts` (AGPL-3.0-only); the keys, the window and the side actions are new.
 */

import { globalScene } from "#app/global-scene";
import { getPokemonNameWithAffix } from "#app/messages";
import { Phase } from "#app/phase";
import { AfkWatcher } from "#coop/afk";
import {
  coopDecide,
  coopGate,
  coopText,
  mySeat,
  proposeUnlessLate,
  reportBridgeError,
  showWaitingForPartner,
} from "#coop/bridge";
import { deciderOf, requireOwnerOf } from "#coop/control";
import { getCosmeticView, sendIntent } from "#coop/cosmetic-view";
import { sideActionKey, sidePickKey, turnCommandsKey } from "#coop/decision-keys";
import { type DecisionKey, keyId, type Seat } from "#coop/protocol";
import type { Decision } from "#coop/sequencer";
import { requireCoopSession } from "#coop/session";
import { askCommandFor } from "#coop/takeover-command";
import {
  commandFromWire,
  commandToWire,
  isSideAction,
  isSideActionPayload,
  isSidePickPayload,
  isTurnCommandsPayload,
  type SideActionPayload,
  type SidePickPayload,
  type TurnCommandsPayload,
} from "#coop/turn-commands";
import { clearWaitingLine } from "#coop/waiting-line";
import { getPokeballName } from "#data/pokeball";
import { Command } from "#enums/command";
import type { PokeballType } from "#enums/pokeball";
import { UiMode } from "#enums/ui-mode";
import type { PlayerPokemon } from "#field/pokemon";
import type { OptionSelectItem } from "#types/ui-types";

/** A Pokémon of the player's side whose commands this phase decides */
type Participant = { pokemon: PlayerPokemon; slot: number; controller: Seat; key: DecisionKey };

/**
 * The turn's commands, as sequenced decisions (DECISIONS D2, D8). It runs after the `CommandPhase`s and before the enemies
 * choose and the turn starts.
 *
 * Both players choose at the same time: each client ran the `CommandPhase`s of the slots it controls, and skipped the
 * others. Here each client proposes the commands its player made, one decision per Pokémon, and waits for the partner's.
 * The decisions may come in any order (the window holds every key at once). Each client then writes the partner's
 * commands into `turnCommands`, so `TurnStartPhase` plays the same turn on both.
 *
 * A Ball or a Run takes the whole side's turn, so the partner has to accept it. On accept the other slot is skipped, as
 * upstream does; on decline the proposer chooses again (D8).
 */
export class CoopTurnSyncPhase extends Phase {
  public readonly phaseName = "CoopTurnSyncPhase";

  /**
   * @param onlyPokemonId - A decline sends the proposer back to choose again: only this Pokémon's command is decided
   * @param attempt - How many times that Pokémon's command was declined before, for the key
   */
  constructor(
    private readonly onlyPokemonId: number | null = null,
    private readonly attempt = 0,
  ) {
    super();
  }

  /** A short notice for this player, shown as the turn starts */
  private notice: string | null = null;

  public override start(): void {
    super.start();
    this.sync()
      .then(() => {
        globalScene.ui.setMode(UiMode.MESSAGE);
        globalScene.ui.clearText();
        if (this.notice !== null) {
          // The next phase may open a menu at once: the notice is read first
          globalScene.ui.showText(this.notice, null, () => this.end(), 1500);
          return;
        }
        this.end();
      })
      .catch(reportBridgeError);
  }

  private async sync(): Promise<void> {
    const session = requireCoopSession();
    const link = session.link;
    if (link === null) {
      return;
    }
    // While the partner is away, or a reload is due, the turn does not go on (D20, D13)
    await coopGate();
    const sequencer = link.sequencer;
    const battle = globalScene.currentBattle;
    const { waveIndex: wave, turn } = battle;
    const me = mySeat();

    const participants = globalScene
      .getPlayerField()
      .map((pokemon, slot) => ({ pokemon, slot }))
      .filter(({ pokemon }) => pokemon.isActive() && (this.onlyPokemonId === null || pokemon.id === this.onlyPokemonId))
      .map(entry => {
        const controller = requireOwnerOf(entry.pokemon);
        const attempt = entry.pokemon.id === this.onlyPokemonId ? this.attempt : 0;
        return { ...entry, controller, key: turnCommandsKey(wave, turn, entry.pokemon.id, attempt) };
      });

    // The window: every Pokémon's commands, in whatever order they are sequenced
    session.openWindow = [...session.openWindow, ...participants.map(part => part.key)];
    let arrived = 0;
    const arrivedKeys = new Set<string>();
    const waits = participants.map(part =>
      sequencer.awaitDecision<TurnCommandsPayload>(part.key, { authors: [part.controller] }).then(decision => {
        arrived++;
        arrivedKeys.add(keyId(part.key));
        // Co-op (D16): the cosmetic "ready" may have been lost; the sequenced command is the proof
        getCosmeticView()?.markReady(part.pokemon.id);
        return decision;
      }),
    );

    // This client's player has chosen for their Pokémon: propose it
    for (const part of participants) {
      if (part.controller === me) {
        const payload: TurnCommandsPayload = {
          command: commandToWire(battle.turnCommands[part.slot]),
          pre: commandToWire(battle.preTurnCommands[part.slot]),
        };
        // (unless the partner took over for this Pokémon while its player was away, D17)
        const late = sequencer.hasDecision(part.key);
        proposeUnlessLate(link, part.key, payload);
        if (late) {
          // The partner chose for it and has its check mark already: this player's late choice is not what runs
          continue;
        }
        // The partner sees a check mark on this Pokémon, with what it was told to do (D8, D16)
        const chosen = battle.turnCommands[part.slot];
        sendIntent(
          part.pokemon.id,
          chosen?.move?.move ?? null,
          // the target that was picked is in `targets`; a move that hits several has them in `move.targets`
          chosen?.targets?.[0] ?? chosen?.move?.targets?.[0] ?? null,
          true,
        );
      }
    }

    const decisions = await this.collect(
      waits,
      () => arrived === participants.length,
      () => participants.some(part => part.controller !== me && !arrivedKeys.has(keyId(part.key))),
      watcher => void this.takeOverCommands(participants, arrivedKeys, watcher).catch(reportBridgeError),
    );
    session.openWindow = session.openWindow.filter(open => !participants.some(part => part.key === open));

    for (const [index, part] of participants.entries()) {
      const payload = decisions[index].payload;
      if (!isTurnCommandsPayload(payload)) {
        throw new Error(`co-op: unreadable commands for Pokémon ${part.pokemon.id}`);
      }
      // Not the commands this client's player chose: the partner's, or the ones the partner chose in this player's place (D17)
      if (part.controller !== me || decisions[index].author !== me) {
        battle.turnCommands[part.slot] = payload.command === null ? null : commandFromWire(payload.command);
        battle.preTurnCommands[part.slot] = payload.pre === null ? null : commandFromWire(payload.pre);
      }
      if (part.controller === me && decisions[index].author !== me) {
        // The command this player may have picked meanwhile is not the one that runs: say whose it is
        this.notice = coopText("tookOverTurn", "{{partner}} chose for {{pokemonName}} while you were away.", {
          partner: session.partnerName,
          pokemonName: getPokemonNameWithAffix(part.pokemon),
        });
      }
    }

    this.enforceTeraRule(
      participants,
      decisions.map(decision => decision.seq),
    );
    await this.settleSideAction(participants);
  }

  /**
   * Tera is a side resource (D8, amended): if both players chose it in the same turn, the first by `seq` keeps it.
   * The other's Tera flag is cleared, and that player sees a short notice. Both clients do the same, as the sequence is
   * the same on both.
   * @param seqs - The `seq` of each participant's decision, in the order of the participants
   */
  private enforceTeraRule(participants: { slot: number; controller: Seat }[], seqs: number[]): void {
    const battle = globalScene.currentBattle;
    const isTera = (slot: number): boolean => {
      const pre = battle.preTurnCommands[slot];
      return pre?.command === Command.TERA && !pre.skip;
    };
    // A Tera kept from an earlier round of this turn (the partner chose again after a declined Ball or Run) came first
    const keptBefore = globalScene
      .getPlayerField()
      .some((pokemon, slot) => pokemon.isActive() && !participants.some(part => part.slot === slot) && isTera(slot));
    const users = participants
      .map((part, index) => ({ part, seq: seqs[index] }))
      .filter(({ part }) => {
        const pre = battle.preTurnCommands[part.slot];
        return pre?.command === Command.TERA && !pre.skip;
      })
      .sort((a, b) => a.seq - b.seq);
    for (const { part } of users.slice(keptBefore ? 0 : 1)) {
      battle.preTurnCommands[part.slot] = { command: Command.FIGHT, targets: [part.slot], skip: true };
      if (part.controller === mySeat()) {
        this.notice = coopText("partnerTeraFirst", "{{partner}} Terastallized first: no Tera for you this turn.", {
          partner: requireCoopSession().partnerName,
        });
      }
    }
  }

  /**
   * The waiting player chose to take over (D17): choose the commands of the partner's Pokémon that have not come, one
   * after the other. If the partner's own arrive in the meantime, the menu closes (the watcher stops) and theirs count.
   */
  private async takeOverCommands(
    participants: { pokemon: PlayerPokemon; slot: number; controller: Seat; key: DecisionKey }[],
    arrivedKeys: ReadonlySet<string>,
    watcher: AfkWatcher,
  ): Promise<void> {
    const link = requireCoopSession().link;
    if (link === null) {
      return;
    }
    for (const part of participants) {
      if (part.controller === mySeat() || arrivedKeys.has(keyId(part.key))) {
        continue;
      }
      // The menus close if the partner's own commands arrive meanwhile (the watcher stops)
      const arrivedNow = (): boolean => arrivedKeys.has(keyId(part.key));
      const payload = await askCommandFor(part.pokemon, part.slot, close => watcher.markOverlay(close), arrivedNow);
      watcher.markOverlay(null);
      if (payload === null) {
        if (!arrivedNow()) {
          // Back from the take-over menus: the line says again what this player waits for
          showWaitingForPartner();
          watcher.keepWaiting();
        }
        return;
      }
      proposeUnlessLate(link, part.key, payload, { takeover: true });
    }
  }

  /**
   * Wait for the partner's commands; say so if they are not there yet, and note how long it took. A long wait is
   * watched (D17): a hint, then the offer to take over.
   * @param partnerMissing - Whether a command of the partner's is not there yet. The guest's own commands come back from
   * the host a round trip later: waiting only for those is no wait for the partner, and says nothing
   */
  private async collect<T>(
    waits: Promise<T>[],
    allArrived: () => boolean,
    partnerMissing: () => boolean,
    onTakeOver: (watcher: AfkWatcher) => void,
  ): Promise<T[]> {
    const session = requireCoopSession();
    // The local proposals were sequenced at once if this client is the host: give those a moment to resolve first
    await Promise.resolve();
    const started = performance.now();
    const instant = allArrived();
    let watcher: AfkWatcher | null = null;
    if (!instant && partnerMissing()) {
      showWaitingForPartner();
      const afk: AfkWatcher = new AfkWatcher({ onTakeOver: () => onTakeOver(afk) });
      afk.start();
      watcher = afk;
    }
    let results: T[];
    try {
      results = await Promise.all(waits);
    } finally {
      watcher?.stop();
      clearWaitingLine();
    }
    const waited = instant ? 0 : performance.now() - started;
    session.waits.turns++;
    session.waits.waitedMs += waited;
    session.waits.maxWaitedMs = Math.max(session.waits.maxWaitedMs, waited);
    session.waits.samples.push(Math.round(waited * 10) / 10);
    if (instant) {
      session.waits.instant++;
    }
    return results;
  }

  /**
   * A Ball or a Run needs the partner's accept (D8). Only the first one (lowest slot) is asked about: it ends the turn
   * of the whole side. When both players chose one, nobody has to accept the other's: the host picks the one that
   * happens, and both run the same turn.
   */
  private async settleSideAction(participants: Participant[]): Promise<void> {
    const battle = globalScene.currentBattle;
    const actors = participants.filter(part => isSideAction(battle.turnCommands[part.slot]));
    if (actors.length === 0) {
      return;
    }
    const both = actors.some(part => part.controller !== actors[0].controller);
    // Two Runs are the same Run: only a Ball makes the two differ
    const differ = both && actors.some(part => battle.turnCommands[part.slot]!.command === Command.BALL);
    const proposer = differ ? await this.pickSideAction(actors) : actors[0];
    const command = battle.turnCommands[proposer.slot]!;
    const allies = globalScene
      .getPlayerField()
      .map((pokemon, slot) => ({ pokemon, slot }))
      .filter(({ pokemon, slot }) => slot !== proposer.slot && pokemon.isActive());

    // The partner has a Pokémon in the other slot: it has to accept, unless it chose a Ball or a Run too. Otherwise
    // nobody else is affected.
    const partnerInvolved = !both && allies.some(({ pokemon }) => requireOwnerOf(pokemon) !== proposer.controller);
    let accepted = true;
    if (partnerInvolved) {
      const { waveIndex: wave, turn } = battle;
      const attempt = proposer.pokemon.id === this.onlyPokemonId ? this.attempt : 0;
      const decider = deciderOf({ kind: "SIDE_ACTION", proposer: proposer.controller });
      if (decider === null || decider === "either") {
        throw new Error("co-op: a side action without a partner to accept it");
      }
      const decision: Decision<SideActionPayload> = await coopDecide<SideActionPayload>({
        key: sideActionKey(wave, turn, proposer.pokemon.id, attempt),
        decider,
        ask: () => this.askAccept(command.command === Command.BALL),
        isPayload: isSideActionPayload,
      });
      accepted = decision.payload.accept;
    }

    if (accepted) {
      // Upstream: the ally's command is skipped. Slot 1 throwing the ball skips slot 0's; slot 0's skips slot 1's.
      for (const { slot } of allies) {
        const existing = battle.turnCommands[slot];
        battle.turnCommands[slot] =
          slot > proposer.slot || existing == null
            ? { command: command.command, skip: true }
            : { ...existing, skip: true };
      }
      return;
    }

    // Declined: the proposer chooses again, nobody else is asked
    if (proposer.controller === mySeat()) {
      this.notice = coopText("sideActionDeclined", "{{partner}} said no. Choose again.", {
        partner: requireCoopSession().partnerName,
      });
    }
    battle.turnCommands[proposer.slot] = null;
    battle.preTurnCommands[proposer.slot] = null;
    const attempt = (proposer.pokemon.id === this.onlyPokemonId ? this.attempt : 0) + 1;
    globalScene.phaseManager.unshiftNew("CommandPhase", proposer.slot);
    globalScene.phaseManager.unshiftNew("CoopTurnSyncPhase", proposer.pokemon.id, attempt);
  }

  /**
   * Both players chose a Ball or a Run (D8): the host picks the one that happens, as a sequenced decision that both
   * clients check (D24). The player whose choice does not happen, and who did not pick, is told.
   */
  private async pickSideAction(actors: Participant[]): Promise<Participant> {
    const battle = globalScene.currentBattle;
    const session = requireCoopSession();
    const partner = session.partnerName;
    const balls = actors.every(part => battle.turnCommands[part.slot]!.command === Command.BALL);
    session.sidePick = actors.map(part => part.pokemon.id);
    try {
      const decision = await coopDecide<SidePickPayload>({
        key: sidePickKey(battle.waveIndex, battle.turn),
        decider: deciderOf({ kind: "SIDE_PICK" }) as Seat,
        ask: () => this.askSidePick(actors, balls),
        wait: () => {
          const { ui } = globalScene;
          ui.setMode(UiMode.MESSAGE);
          ui.showText(
            balls
              ? coopText("sidePickBallWait", "You both chose to throw a ball: {{partner}} picks who throws…", {
                  partner,
                })
              : coopText("sidePickWait", "You both chose to end the turn: {{partner}} picks which…", { partner }),
            null,
            undefined,
            null,
            false,
          );
        },
        isPayload: isSidePickPayload,
      });
      // (the legality check of D24 refused any other Pokémon before it came here)
      const picked = actors.find(part => part.pokemon.id === decision.payload.pokemonId) ?? actors[0];
      if (picked.controller !== mySeat() && decision.author !== mySeat()) {
        this.notice = balls
          ? coopText("sidePickBallTheirs", "{{partner}} throws the ball this turn.", { partner })
          : coopText("sidePickTheirs", "{{partner}} picked theirs this turn.", { partner });
      }
      return picked;
    } finally {
      session.sidePick = null;
    }
  }

  /** The host's menu: whose Ball or Run happens */
  private askSidePick(actors: Participant[], balls: boolean): Promise<SidePickPayload> {
    const { ui } = globalScene;
    const battle = globalScene.currentBattle;
    const partner = requireCoopSession().partnerName;
    return new Promise(resolve => {
      const options: OptionSelectItem[] = actors.map(part => {
        const command = battle.turnCommands[part.slot]!;
        const who = part.controller === mySeat() ? coopText("sidePickMe", "Me") : partner;
        const what =
          command.command === Command.BALL
            ? getPokeballName(command.cursor as PokeballType)
            : coopText("sidePickRun", "Run away");
        return {
          label: `${who}: ${what}`,
          handler: () => {
            ui.setMode(UiMode.MESSAGE);
            resolve({ pokemonId: part.pokemon.id });
            return true;
          },
        };
      });
      ui.setMode(UiMode.MESSAGE);
      ui.showText(
        balls
          ? coopText("sidePickBall", "You and {{partner}} both chose to throw a ball. Who throws?", { partner })
          : coopText("sidePickAction", "You and {{partner}} chose different ways to end the turn. Which one?", {
              partner,
            }),
        null,
        () => ui.setModeWithoutClear(UiMode.OPTION_SELECT, { options, yOffset: 48 }),
        null,
        false,
      );
    });
  }

  /** The partner's Ball or Run: ask whether to accept it. */
  private askAccept(ball: boolean): Promise<SideActionPayload> {
    const { ui } = globalScene;
    const partner = requireCoopSession().partnerName;
    const text = ball
      ? coopText("acceptBallFrom", "{{partner}} wants to throw a Poké Ball. Let them?", { partner })
      : coopText("acceptRunFrom", "{{partner}} wants to run away. Let them?", { partner });
    return new Promise(resolve => {
      ui.setMode(UiMode.MESSAGE);
      ui.showText(
        text,
        null,
        () => {
          ui.setModeWithoutClear(UiMode.CONFIRM, {
            yesHandler: () => {
              ui.setMode(UiMode.MESSAGE);
              resolve({ accept: true });
            },
            noHandler: () => {
              ui.setMode(UiMode.MESSAGE);
              resolve({ accept: false });
            },
          });
        },
        null,
        true,
      );
    });
  }
}
