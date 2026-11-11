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
import { getCosmeticView, sendIntent } from "#coop/cosmetic/cosmetic-view";
import { isDebugBatch } from "#coop/debug/actions";
import { applyDebugBatch } from "#coop/debug/apply";
import { takeDebugBatch } from "#coop/debug/queue";
import {
  coopDecide,
  coopGate,
  coopText,
  mySeat,
  proposeUnlessLate,
  reportBridgeError,
  showWaitingForPartner,
} from "#coop/decisions/bridge";
import { deciderOf, requireOwnerOf } from "#coop/decisions/control";
import { debugTurnKey, sideActionKey, sidePickKey, turnCommandsKey } from "#coop/decisions/decision-keys";
import type { Decision } from "#coop/decisions/sequencer";
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
} from "#coop/decisions/turn-commands";
import { type DecisionKey, keyId, type Seat } from "#coop/protocol";
import { requireCoopSession } from "#coop/session";
import { AfkWatcher } from "#coop/ui/afk";
import { askCommandFor } from "#coop/ui/takeover-command";
import { clearWaitingLine } from "#coop/ui/waiting-line";
import { getPokeballName } from "#data/pokeball";
import { type BattlerIndex, playerBattlerOf } from "#enums/battler-index";
import { Command } from "#enums/command";
import type { PokeballType } from "#enums/pokeball";
import { UiMode } from "#enums/ui-mode";
import type { PlayerPokemon } from "#field/pokemon";
import type { OptionSelectItem } from "#types/ui-types";

/** A Pokémon of the player's side whose commands this phase decides */
/** A Pokémon of ours that chooses this turn: its field slot, and its battler (its key in the turn's commands; D40) */
type Participant = { pokemon: PlayerPokemon; slot: number; battler: BattlerIndex; controller: Seat; key: DecisionKey };

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
      .map((pokemon, slot) => ({ pokemon, slot, battler: playerBattlerOf(slot) }))
      .filter(({ pokemon }) => pokemon.isActive() && (this.onlyPokemonId === null || pokemon.id === this.onlyPokemonId))
      .map(entry => {
        const controller = requireOwnerOf(entry.pokemon);
        const attempt = entry.pokemon.id === this.onlyPokemonId ? this.attempt : 0;
        return { ...entry, controller, key: turnCommandsKey(wave, turn, entry.pokemon.id, attempt) };
      });

    // The host's debug batch of the turn (D42): sequenced with the commands, carried out after them. Not on a second round
    // of the turn (a declined Ball or Run): the first had it
    const debugKey = session.debug && this.onlyPokemonId === null ? debugTurnKey(wave, turn) : null;

    // The window: every Pokémon's commands and the debug batch, in whatever order they are sequenced
    session.openWindow = [
      ...session.openWindow,
      ...participants.map(part => part.key),
      ...(debugKey === null ? [] : [debugKey]),
    ];
    let arrived = 0;
    const arrivedKeys = new Set<string>();
    // (all at once: in a game of three the others' commands may already be here, in the order the host sequenced them,
    // D40; and a guest's take over of the host's command, sequenced while the host's menu was up, may come before the
    // debug batch, D17)
    const awaited = sequencer.awaitEach<TurnCommandsPayload>([
      ...participants.map(part => ({ key: part.key, authors: [part.controller] })),
      ...(debugKey === null ? [] : [{ key: debugKey, authors: ["host"] as const }]),
    ]);
    const debugWait = debugKey === null ? null : awaited[participants.length];
    // (a reload rejects it before it is awaited: that is not an unhandled rejection)
    debugWait?.catch(() => undefined);
    if (debugKey !== null && session.isHost) {
      proposeUnlessLate(link, debugKey, takeDebugBatch());
    }
    const waits = participants.map((part, index) =>
      awaited[index].then(decision => {
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
          command: commandToWire(battle.turnCommands[part.battler]),
          pre: commandToWire(battle.preTurnCommands[part.battler]),
        };
        // (unless the partner took over for this Pokémon while its player was away, D17)
        const late = sequencer.hasDecision(part.key);
        proposeUnlessLate(link, part.key, payload);
        if (late) {
          // The partner chose for it and has its check mark already: this player's late choice is not what runs
          continue;
        }
        // The partner sees a check mark on this Pokémon, with what it was told to do (D8, D16)
        const chosen = battle.turnCommands[part.battler];
        sendIntent(
          part.pokemon.id,
          chosen?.move?.move ?? null,
          // the target that was picked is in `targets`; a move that hits several has them in `move.targets`
          chosen?.targets?.[0] ?? chosen?.move?.targets?.[0] ?? null,
          true,
        );
      }
    }

    // Whose commands are not there yet (named in a game of three, D40)
    const missing = (): Seat[] => [
      ...new Set(
        participants
          .filter(part => part.controller !== me && !arrivedKeys.has(keyId(part.key)))
          .map(part => part.controller),
      ),
    ];
    const decisions = await this.collect(
      waits,
      () => arrived === participants.length,
      () => missing().length > 0,
      watcher => void this.takeOverCommands(participants, arrivedKeys, watcher).catch(reportBridgeError),
      {
        waitingFor: missing,
        // The host of three takes over at once for a guest who left (D40)
        absent: () =>
          session.players === 3 && session.isHost && missing().every(seat => session.link?.present(seat) === false),
      },
    );
    session.openWindow = session.openWindow.filter(open => !participants.some(part => part.key === open));

    for (const [index, part] of participants.entries()) {
      const payload = decisions[index].payload;
      if (!isTurnCommandsPayload(payload)) {
        throw new Error(`co-op: unreadable commands for Pokémon ${part.pokemon.id}`);
      }
      // Not the commands this client's player chose: the partner's, or the ones the partner chose in this player's place (D17)
      if (part.controller !== me || decisions[index].author !== me) {
        battle.turnCommands[part.battler] = payload.command === null ? null : commandFromWire(payload.command);
        battle.preTurnCommands[part.battler] = payload.pre === null ? null : commandFromWire(payload.pre);
      }
      if (part.controller === me && decisions[index].author !== me) {
        // The command this player may have picked meanwhile is not the one that runs: say whose it is
        this.notice = coopText("tookOverTurn", "{{partner}} chose for {{pokemonName}} while you were away.", {
          // (whoever took over, in a game of three: D40)
          partner: session.nameOf(decisions[index].author),
          pokemonName: getPokemonNameWithAffix(part.pokemon),
        });
      }
    }

    this.enforceTeraRule(
      participants,
      decisions.map(decision => decision.seq),
    );
    if (debugWait !== null) {
      const batch = (await debugWait).payload;
      session.openWindow = session.openWindow.filter(open => open !== debugKey);
      if (isDebugBatch(batch) && batch.actions.length > 0) {
        await applyDebugBatch(batch, { wave, turn });
      }
    }
    await this.settleSideAction(participants);
  }

  /**
   * Tera is a side resource (D8, amended): if both players chose it in the same turn, the first by `seq` keeps it.
   * The other's Tera flag is cleared, and that player sees a short notice. Both clients do the same, as the sequence is
   * the same on both.
   * @param seqs - The `seq` of each participant's decision, in the order of the participants
   */
  private enforceTeraRule(
    participants: { slot: number; battler: BattlerIndex; controller: Seat }[],
    seqs: number[],
  ): void {
    const battle = globalScene.currentBattle;
    const isTera = (slot: number): boolean => {
      const pre = battle.preTurnCommands[playerBattlerOf(slot)];
      return pre?.command === Command.TERA && !pre.skip;
    };
    // A Tera kept from an earlier round of this turn (the partner chose again after a declined Ball or Run) came first
    const keptBefore = globalScene
      .getPlayerField()
      .some((pokemon, slot) => pokemon.isActive() && !participants.some(part => part.slot === slot) && isTera(slot));
    const users = participants
      .map((part, index) => ({ part, seq: seqs[index] }))
      .filter(({ part }) => {
        const pre = battle.preTurnCommands[part.battler];
        return pre?.command === Command.TERA && !pre.skip;
      })
      .sort((a, b) => a.seq - b.seq);
    for (const { part } of users.slice(keptBefore ? 0 : 1)) {
      battle.preTurnCommands[part.battler] = { command: Command.FIGHT, targets: [part.battler], skip: true };
      if (part.controller === mySeat()) {
        const session = requireCoopSession();
        // (the one who did, in a game of three: D40)
        const first = keptBefore || users.length === 0 ? null : users[0].part.controller;
        this.notice = coopText("partnerTeraFirst", "{{partner}} Terastallized first: no Tera for you this turn.", {
          partner: first === null || first === mySeat() ? session.partnerName : session.nameOf(first),
        });
      }
    }
  }

  /**
   * The waiting player chose to take over (D17): choose the commands of the partner's Pokémon that have not come, one
   * after the other. If the partner's own arrive in the meantime, the menu closes (the watcher stops) and theirs count.
   */
  private async takeOverCommands(
    participants: Participant[],
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
          showWaitingForPartner([part.controller]);
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
    who: { waitingFor: () => readonly Seat[]; absent: () => boolean },
  ): Promise<T[]> {
    const session = requireCoopSession();
    // The local proposals were sequenced at once if this client is the host: give those a moment to resolve first
    await Promise.resolve();
    const started = performance.now();
    const instant = allArrived();
    let watcher: AfkWatcher | null = null;
    if (!instant && partnerMissing()) {
      showWaitingForPartner(who.waitingFor());
      const afk: AfkWatcher = new AfkWatcher({ ...who, onTakeOver: () => onTakeOver(afk) });
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
    const actors = participants.filter(part => isSideAction(battle.turnCommands[part.battler]));
    if (actors.length === 0) {
      return;
    }
    const both = actors.some(part => part.controller !== actors[0].controller);
    // Two Runs are the same Run: only a Ball makes the two differ
    const differ = both && actors.some(part => battle.turnCommands[part.battler]!.command === Command.BALL);
    const proposer = differ ? await this.pickSideAction(actors) : actors[0];
    const command = battle.turnCommands[proposer.battler]!;
    const allies = globalScene
      .getPlayerField()
      .map((pokemon, slot) => ({ pokemon, slot }))
      .filter(({ pokemon, slot }) => slot !== proposer.slot && pokemon.isActive());

    // The partner has a Pokémon in the other slot: it has to accept, unless it chose a Ball or a Run too. Otherwise
    // nobody else is affected. In a game of three the host decides: a guest's Ball or Run is the host's to accept, the
    // host's own needs nobody's (D40)
    const partnerInvolved =
      requireCoopSession().players === 3
        ? !both && proposer.controller !== "host"
        : !both && allies.some(({ pokemon }) => requireOwnerOf(pokemon) !== proposer.controller);
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
        const existing = battle.turnCommands[playerBattlerOf(slot)];
        battle.turnCommands[playerBattlerOf(slot)] =
          slot > proposer.slot || existing == null
            ? { command: command.command, skip: true }
            : { ...existing, skip: true };
      }
      return;
    }

    // Declined: the proposer chooses again, nobody else is asked
    if (proposer.controller === mySeat()) {
      const session = requireCoopSession();
      this.notice = coopText("sideActionDeclined", "{{partner}} said no. Choose again.", {
        // (the host, who decides in a game of three: D40)
        partner: session.players === 3 ? session.nameOf("host") : session.partnerName,
      });
    }
    battle.turnCommands[proposer.battler] = null;
    battle.preTurnCommands[proposer.battler] = null;
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
    const balls = actors.every(part => battle.turnCommands[part.battler]!.command === Command.BALL);
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
        const command = battle.turnCommands[part.battler]!;
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
