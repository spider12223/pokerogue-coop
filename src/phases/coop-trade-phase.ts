/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { Phase } from "#app/phase";
import { AfkWatcher } from "#coop/afk";
import { dropLeftoverFaintReplacements, INDEX_BAKED_PHASES } from "#coop/arrange";
import { coopGate, coopText, isLinked, mySeat, reportBridgeError } from "#coop/bridge";
import { type DecisionKey, otherSeat, type Seat } from "#coop/protocol";
import { type Decision, ProposalRejectedError } from "#coop/sequencer";
import { requireCoopSession } from "#coop/session";
import {
  applyTrade,
  checkTradeProposal,
  type PendingTrade,
  type TradeEffect,
  type TradeProposePayload,
  type TradeRefusal,
  TradeState,
  tradeDoneKey,
  tradeKey,
} from "#coop/trade";
import { UiMode } from "#enums/ui-mode";
import type { PlayerPokemon } from "#field/pokemon";
import type { CoopTradeUiHandler, TradeScreenActions, TradeScreenModel } from "#ui/coop-trade-ui-handler";

/**
 * The trade screen between two reward screens (DECISIONS D11). It runs right after the reward screen if either player
 * asked for it there (`TRADE_REQUEST`), after whatever the pick queued (a learn-move, an evolution), and before the biome
 * is chosen and the next battle is set up.
 *
 * Everything the players do on it is a sequenced decision in one window ({@linkcode TradeState}); both clients feed the
 * same decisions to the same state in the same order, so they end with the same owners. An accepted trade changes the owner
 * map and nothing else: the party array stays as it is (so no phase that holds a party index is affected), the held items
 * stay on their Pokémon, and the arrange step of the next wave puts each player's first legal Pokémon in their slot.
 *
 * Without a network (the rules harness) there is nothing to ask: the phase ends at once.
 */
export class CoopTradePhase extends Phase {
  public readonly phaseName = "CoopTradePhase";

  private readonly state = new TradeState();
  /** This player's action was proposed and has not come back yet */
  private awaiting = false;
  private notice: string | null = null;
  private watcher: AfkWatcher | null = null;
  private stopWatchingRejections: (() => void) | null = null;

  public override start(): void {
    super.start();
    this.run().catch(error => {
      reportBridgeError(error);
    });
  }

  private async run(): Promise<void> {
    const session = requireCoopSession();
    const link = session.link;
    if (!isLinked() || link === null) {
      this.finish();
      return;
    }
    // The decisions below change who owns which Pokémon: nothing that acts on a party index may still be waiting (D11). A
    // replacement left over from a faint after the last enemy has nothing to do any more: the arrange step of the next wave
    // fills that slot, so it goes first
    dropLeftoverFaintReplacements("trade");
    for (const name of INDEX_BAKED_PHASES) {
      if (globalScene.phaseManager.hasPhaseOfType(name)) {
        throw new Error(`co-op: the trade screen cannot open with a ${name} queued`);
      }
    }

    const { sequencer } = link;
    this.stopWatchingRejections = sequencer.onProposalRejected(({ key, reason }) => this.onRejected(key, reason));
    await globalScene.ui.setMode(UiMode.COOP_TRADE, this.actions(), this.model());

    while (!this.state.finished) {
      // While the partner is away, or a reload is due, the screen does not go on (D20, D13)
      await coopGate();
      const { waveIndex: wave } = globalScene.currentBattle;
      const entries = this.state.window(wave);
      session.openWindow = [...session.openWindow, ...entries.map(entry => entry.key)];
      this.watchPartner();
      let decision: Decision;
      try {
        decision = await sequencer.awaitOneOf(entries);
      } finally {
        this.watcher?.stop();
        this.watcher = null;
        session.openWindow = session.openWindow.filter(open => !entries.some(entry => entry.key === open));
      }
      this.awaiting = false;
      this.notice = null;
      this.afterEffect(this.state.apply(decision), decision);
      this.refresh();
    }
    this.finish();
  }

  /** Leave the screen: the next phases of the wave go on */
  private finish(): void {
    this.stopWatchingRejections?.();
    this.stopWatchingRejections = null;
    this.watcher?.stop();
    const session = requireCoopSession();
    session.tradeRequested = false;
    session.tradeQueued = false;
    globalScene.ui.clearText();
    void globalScene.ui.setMode(UiMode.MESSAGE).then(() => this.end());
  }

  // #region What the players do

  private actions(): TradeScreenActions {
    const me = mySeat();
    return {
      propose: (give, want) => {
        if (this.awaiting || this.state.pending !== null) {
          return false;
        }
        const refusal = checkTradeProposal(me, { give, want }, requireCoopSession().ownership);
        if (refusal !== null) {
          this.notice = this.describeRefusal(refusal);
          this.refresh();
          return false;
        }
        const payload: TradeProposePayload = { give, want };
        this.send(tradeKey(this.wave(), "TRADE_PROPOSE", this.state.step), payload);
        return true;
      },
      answer: accept => {
        if (this.state.pending !== null && !this.awaiting) {
          this.send(tradeKey(this.wave(), accept ? "TRADE_ACCEPT" : "TRADE_DECLINE", this.state.step), null);
        }
      },
      cancel: () => {
        if (this.state.pending !== null && !this.awaiting) {
          this.send(tradeKey(this.wave(), "TRADE_CANCEL", this.state.step), null);
        }
      },
      done: done => {
        if (!this.awaiting && this.state.pending === null) {
          this.send(tradeDoneKey(this.wave(), this.state.step, me), { done });
        }
      },
    };
  }

  private wave(): number {
    return globalScene.currentBattle.waveIndex;
  }

  /** Propose a decision of this player in the open step; a refusal comes back through {@linkcode onRejected} */
  private send(key: DecisionKey, payload: unknown, takeover = false): void {
    const link = requireCoopSession().link;
    if (link === null) {
      return;
    }
    this.awaiting = true;
    try {
      link.sequencer.propose(key, payload, takeover ? { takeover: true } : {});
    } catch (error) {
      if (error instanceof ProposalRejectedError) {
        this.onRejected(error.key, error.reason);
      } else {
        throw error;
      }
    }
  }

  private onRejected(key: DecisionKey, reason: string): void {
    if (!key.kind.startsWith("TRADE_") || key.kind === "TRADE_REQUEST") {
      return;
    }
    this.awaiting = false;
    globalScene.ui.playError();
    this.notice =
      reason === "invalid"
        ? coopText("tradeInvalid", "That trade is not allowed.")
        : coopText("tradeTooLate", "Too late: the screen has changed.");
    this.refresh();
  }

  private describeRefusal(refusal: TradeRefusal): string {
    switch (refusal) {
      case "notYours":
        return coopText("tradeNotYours", "Pick one of your own Pokémon to give.");
      case "notTheirs":
        return coopText("tradeNotTheirs", "Pick one of your partner's Pokémon to ask for.");
      case "lastOne":
        return coopText("tradeLastOne", "Keep at least one Pokémon of your own: that one cannot be a gift.");
    }
  }

  // #endregion

  // #region What the decisions do

  private afterEffect(effect: TradeEffect, decision: Decision): void {
    const session = requireCoopSession();
    const name = (trade: PendingTrade): string => this.pokemonName(trade.give);
    switch (effect.t) {
      case "accepted": {
        applyTrade(session.ownership, effect.trade.proposer, effect.trade);
        session.trades++;
        this.notice =
          effect.trade.want === null
            ? coopText("tradeDoneGift", "{{give}} has a new trainer.", { give: name(effect.trade) })
            : coopText("tradeDoneSwap", "{{give}} and {{want}} traded places.", {
                give: name(effect.trade),
                want: this.pokemonName(effect.trade.want),
              });
        globalScene.ui.playSelect();
        break;
      }
      case "declined":
        this.notice = coopText("tradeDeclined", "The trade was declined.");
        break;
      case "cancelled":
        this.notice = coopText("tradeCancelled", "The proposal was withdrawn.");
        break;
      default:
        break;
    }
    if (decision.takeover === true && decision.author !== mySeat()) {
      this.notice = coopText("tradeTookOver", "{{partner}} took over for you.", { partner: session.partnerName });
    }
  }

  private pokemonName(id: number): string {
    return globalScene.getPlayerParty().find(pokemon => pokemon.id === id)?.name ?? "?";
  }

  // #endregion

  // #region The screen

  private model(): TradeScreenModel {
    const session = requireCoopSession();
    const me = mySeat();
    const party = globalScene.getPlayerParty();
    const byId = (id: number): PlayerPokemon | undefined => party.find(pokemon => pokemon.id === id);
    const pending = this.state.pending;
    const give = pending === null ? undefined : byId(pending.give);
    return {
      mine: party.filter(pokemon => session.ownership.get(pokemon.id) === me),
      theirs: party.filter(pokemon => session.ownership.get(pokemon.id) === otherSeat(me)),
      partnerName: session.partnerName,
      pending:
        pending === null || give === undefined
          ? null
          : { byMe: pending.proposer === me, give, want: pending.want === null ? null : (byId(pending.want) ?? null) },
      iAmDone: this.state.done[me],
      partnerDone: this.state.done[otherSeat(me)],
      notice: this.notice,
    };
  }

  private refresh(): void {
    const handler = globalScene.ui.handlers[UiMode.COOP_TRADE] as CoopTradeUiHandler | undefined;
    if (handler?.active) {
      handler.update(this.model());
    }
  }

  // #endregion

  // #region A partner who does not answer (D17)

  /** Watch the partner while this player waits for them: for an answer to a proposal, or for them to be done */
  private watchPartner(): void {
    const me = mySeat();
    const partner: Seat = otherSeat(me);
    const pending = this.state.pending;
    const waitingForAnswer = pending !== null && pending.proposer === me;
    const waitingForDone = pending === null && this.state.done[me] && !this.state.done[partner];
    if (!waitingForAnswer && !waitingForDone) {
      return;
    }
    const wave = this.wave();
    const step = this.state.step;
    this.watcher = new AfkWatcher({
      offerOver: [UiMode.COOP_TRADE],
      // The ping and emote keys do nothing on this screen: the hint names none
      noPingHint: true,
      showText: text => {
        this.notice = text;
        this.refresh();
      },
      onTakeOver: () => {
        // The default of an answer is to decline; of a done, to be done (D17)
        if (waitingForAnswer) {
          this.send(tradeKey(wave, "TRADE_DECLINE", step), null, true);
        } else {
          this.send(tradeDoneKey(wave, step, partner), { done: true }, true);
        }
      },
    });
    this.watcher.start();
  }

  // #endregion
}
