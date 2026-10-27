/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { activeOverrides } from "#app/overrides";
import { retimeAfkWatchers } from "#coop/afk";
import type { Checkpoint } from "#coop/checkpoint-log";
import { coopLog } from "#coop/coop-log";
import type { CosmeticStats } from "#coop/cosmetic";
import { getCosmeticView, sendEmote, sendPing } from "#coop/cosmetic-view";
import { getCoopName, setCoopName } from "#coop/display-name";
import { pingKeyName } from "#coop/hotkey-names";
import { openEmoteWheel, pingNow } from "#coop/hotkeys";
import { getJoinCode } from "#coop/lobby";
import { type PaceInfo, paceInfo } from "#coop/pace-run";
import type { PhaseTraceEntry } from "#coop/phase-trace";
import { keyId, type Seat } from "#coop/protocol";
import { reconnectScreenText } from "#coop/reconnect-ui";
import { reportProblem } from "#coop/report-button";
import { endSession } from "#coop/resync-run";
import { getCoopSession, type WaitStats } from "#coop/session";
import { sourceUrlOf } from "#coop/source-link";
import { type StallDump, stalls, startStallDetector } from "#coop/stall-detector";
import { currentCoopSlot } from "#coop/wave-save";
import { Button } from "#enums/buttons";
import { UiMode } from "#enums/ui-mode";
import {
  getPlayerShopModifierTypeOptionsForWave,
  type ModifierTypeOption,
  PokemonModifierType,
  TmModifierType,
} from "#modifiers/modifier-type";
import type { CoopJoinFormUiHandler } from "#ui/coop-join-form-ui-handler";
import type { CoopTradeUiHandler } from "#ui/coop-trade-ui-handler";
import type { ModifierSelectUiHandler } from "#ui/modifier-select-ui-handler";
import type { PartyUiHandler } from "#ui/party-ui-handler";

/**
 * `window.__coop`, in dev and test builds only: what the co-op layer of this client is doing, for
 * the end-to-end test and for whoever debugs a desync.
 *
 * @module
 */

/** The reward screen that is open */
export interface CoopDebugReward {
  /** Which screen of the run this is, counted from 0 */
  screen: number;
  /** The open step of the screen: how many actions came before it */
  step: number;
  picker: Seat;
  money: number;
  /** The screen has finished showing and takes input */
  ready: boolean;
  /** A trade was asked for on this screen (D11) */
  tradeRequested: boolean;
  /** The line that says who is choosing, if one is shown (D9, D17) */
  label: string;
  options: { name: string; tmMove: number | null }[];
  shop: { name: string; cost: number; needsTarget: boolean }[];
}

/** A Pokémon of the party, in party order */
export interface CoopDebugPartyMember {
  owner: Seat | null;
  name: string;
  hp: number;
  maxHp: number;
  moves: number[];
  ppUsed: number[];
  /** The moves this Pokémon learned from a TM (what a `MOVESET_OVERRIDE` cannot hide) */
  usedTms: number[];
}

export interface CoopDebugApi {
  /** This client's seat, or `null` outside a co-op run */
  readonly seat: Seat | null;
  /** Whether the run has a network */
  readonly linked: boolean;
  /** The join code of the room this client hosts, once it exists */
  readonly joinCode: string | null;
  /** The decision keys the simulation is waiting for right now (the decision window), as `wave:turn:KIND:ref` */
  readonly window: string[];
  /** The state-hash checkpoints this client passed, in order (D13) */
  readonly checkpoints: Checkpoint[];
  /** Where the two clients first differed, or the reason a decision failed; `null` while all is well */
  readonly desync: string | null;
  /** How long this client waited for its partner's commands */
  readonly waits: WaitStats | null;
  /** The current phase, wave and turn */
  readonly phase: { name: string; wave: number; turn: number } | null;
  /** The current UI mode (`COMMAND`, `FIGHT`, `PARTY`, ...) */
  readonly ui: string;
  /** This player's display name, and what the partner is called (D1) */
  readonly name: string;
  readonly partnerName: string | null;
  /** What the cosmetic channel received and shows (D16), with what it dropped */
  readonly cosmetics: {
    intents: { pokemonId: number; move: number | null; target: number | null; ready: boolean }[];
    cursor: { screen: number; row: number; col: number } | null;
    pings: { name: string; at: unknown }[];
    emotes: { name: string; id: number; label: string }[];
    drawn: number;
    stats: CosmeticStats;
  } | null;
  /** Where this client is in the text of the run, where the host is, and the lines it showed (D27) */
  readonly pace: PaceInfo | null;
  /** The decisions made for a partner who did not answer, as this client saw them (D17) */
  readonly takeovers: { key: string; author: Seat }[];
  /** The player Pokémon on the field, by slot, with their owners */
  readonly field: { slot: number; pokemonId: number; owner: Seat | null }[];
  /** The trade screen, while it is open (D11) */
  readonly trade: ReturnType<CoopTradeUiHandler["describe"]> | null;
  /** The reward screen that is open, or `null` */
  readonly reward: CoopDebugReward | null;
  /** The party, in party order */
  readonly party: CoopDebugPartyMember[];
  /** What the stall detector wrote down: this client did not move for a while (see `stall-detector.ts`) */
  readonly stalls: StallDump[];
  /** The code of the room this client is in, while it is in one (the join code goes away when the run starts) */
  readonly roomCode: string | null;
  /** The epoch of the run: 0 until the first reload (D18) */
  readonly epoch: number;
  /** Whether the partner is connected right now (D20) */
  readonly partnerPresent: boolean;
  /** The partner came back and this client still has to reload (D20) */
  readonly needsResync: boolean;
  /** What the waiting screen says while the partner is away, or `null` (D20) */
  readonly reconnectScreen: string | null;
  /** The text the message window shows right now, as far as it has been typed out */
  readonly messageText: string;
  /** Where the Source link of the title screen goes, or `null` where the build has none (D25) */
  readonly sourceLink: string | null;
  /** The co-op log of this page, newest last (D26): number, level, kind and text of the last 200 entries */
  readonly coopLog: { n: number; level: string; kind: string; msg: string }[];
  /** Whether the server took the log (`null`: not asked yet) */
  readonly coopLogSent: boolean | null;
  /** "Report a problem" with this note, without the file: `sent` when the server has it */
  report(note: string): Promise<string>;
  /** The labels of the option menu that is open (the lobby's "Copy code" is one), or `[]` */
  readonly menuOptions: string[];
  /** The name of the key that pings now ("P" until the player moves it), or `null` if none */
  readonly pingKey: string | null;
  /** The reloads of this run (D13): why, in which epoch, of which wave */
  readonly resyncs: { epoch: number; reason: string; wave: number }[];
  /** The run was stopped by the third desync of a wave (D13) */
  readonly stopped: { wave: number } | null;
  /** When the pieces of a rejoin and a reload happened, in ms since the epoch */
  readonly timing: Record<string, number>;
  /** The co-op slot of this browser (D19), without the save */
  readonly slot: { wave: number; epoch: number; seq: number; names: Record<Seat, string> } | null;
  /** The phase trace: one entry per phase start with a hash of the RNG state (D13) */
  trace(): PhaseTraceEntry[];
  /**
   * Set overrides of `src/overrides.ts` (item rewards, starting level, ...). Both clients of a run must be given the same
   * ones before the run starts, as with any other change to the simulation.
   */
  setOverrides(values: Record<string, unknown>): void;
  /** Change when a waiting player is told the partner is slow (hint) and may take over (D17); it reaches the waits that are open */
  setAfkTimers(hintMs: number, takeoverMs: number, keepWaitingMs?: number): void;
  /** Save a display name, as the name form does */
  setName(name: string): string;
  /** The hotkeys of the cosmetic channel (D16): ping what the cursor is on, or open the emote wheel */
  hotkey(which: "ping" | "emote"): boolean;
  /**
   * Flip one HP value of the first Pokémon of the party, as a bug would: this client no longer agrees with its partner, and the
   * next checkpoint says so (D13). Dev and test builds only.
   */
  corrupt(): boolean;
  /** "End session" (D20): leave the room for good and go back to the title screen. @returns Whether there was a session */
  leave(): boolean;
  /** Change how long a player waits for a partner before they are offered to end the session (D20) */
  setReconnectEndMs(ms: number): void;
  /** Send a ping at nothing in particular, or an emote, without a hotkey. @returns Whether it was sent */
  nudge(): boolean;
  emote(id: number): boolean;
  /** Whether the party member can learn the TM of this move */
  canLearnTm(partyIndex: number, moveId: number): boolean;
  /** Put the cursor of the open reward screen on a row (0 buttons, 1 rewards, 2 shop) and a column, as the arrows would */
  moveRewardCursor(row: number, cursor: number): boolean;
  /** Put the cursor of the open party menu on a party member, as the arrows would */
  movePartyCursor(partyIndex: number): boolean;
  /** Press a button as the player would: `UP`, `DOWN`, `LEFT`, `RIGHT`, `ACTION`, `CANCEL`, `SUBMIT`, ... */
  press(button: keyof typeof Button): boolean;
  /** Type a join code into the open join form and submit it */
  submitJoinCode(code: string): boolean;
}

function api(): CoopDebugApi {
  return {
    get seat() {
      return getCoopSession()?.seat ?? null;
    },
    get linked() {
      return getCoopSession()?.link != null;
    },
    get joinCode() {
      return getJoinCode();
    },
    get window() {
      return (getCoopSession()?.openWindow ?? []).map(keyId);
    },
    get checkpoints() {
      return [...(getCoopSession()?.checkpoints.entries ?? [])];
    },
    get desync() {
      return getCoopSession()?.desyncMessage ?? null;
    },
    get waits() {
      return getCoopSession()?.waits ?? null;
    },
    get phase() {
      const battle = globalScene?.currentBattle as typeof globalScene.currentBattle | undefined;
      const phase = globalScene?.phaseManager?.getCurrentPhase();
      return phase == null ? null : { name: phase.phaseName, wave: battle?.waveIndex ?? 0, turn: battle?.turn ?? 0 };
    },
    get ui() {
      return globalScene?.ui == null ? "NONE" : (UiMode[globalScene.ui.mode] ?? String(globalScene.ui.mode));
    },
    get reward() {
      const session = getCoopSession();
      const phase = globalScene?.phaseManager?.getCurrentPhase();
      if (session == null || phase?.phaseName !== "SelectModifierPhase") {
        return null;
      }
      // The screen's own state is private: this is the one place outside it that reads it
      const open = phase as unknown as { screen: number; picker: Seat; typeOptions: ModifierTypeOption[] };
      const { screen, picker } = open;
      const options = open.typeOptions.map(option => ({
        name: option.type.name,
        tmMove: option.type instanceof TmModifierType ? option.type.moveId : null,
      }));
      const shop = getPlayerShopModifierTypeOptionsForWave(
        globalScene.currentBattle.waveIndex,
        globalScene.getWaveMoneyAmount(1),
      ).map(option => ({
        name: option.type.name,
        cost: option.cost,
        needsTarget: option.type instanceof PokemonModifierType,
      }));
      const handler = globalScene.ui.handlers[UiMode.MODIFIER_SELECT] as unknown as { awaitingActionInput: boolean };
      const ready = globalScene.ui.mode === UiMode.MODIFIER_SELECT && handler.awaitingActionInput;
      return {
        screen,
        step: session.rewardStep,
        picker,
        money: globalScene.money,
        ready,
        tradeRequested: session.tradeRequested,
        label: (globalScene.ui.handlers[UiMode.MODIFIER_SELECT] as ModifierSelectUiHandler).getCoopLabel(),
        options,
        shop,
      };
    },
    get name() {
      return getCoopSession()?.link?.name ?? getCoopName();
    },
    get partnerName() {
      return getCoopSession()?.link?.partnerName ?? null;
    },
    get cosmetics() {
      const view = getCosmeticView();
      const session = getCoopSession();
      if (view === null || session?.link == null) {
        return null;
      }
      const state = view.describe();
      return {
        intents: state.intents,
        cursor: state.cursor,
        pings: state.pings.map(ping => ({ name: ping.name, at: ping.at })),
        emotes: state.emotes.map(emote => ({ name: emote.name, id: emote.id, label: emote.label })),
        drawn: state.drawn,
        stats: session.link.cosmeticReceiver.stats,
      };
    },
    /** Where this client is in the text of the run, where the host is, and the lines it showed (D27) */
    get pace() {
      return paceInfo();
    },
    get takeovers() {
      return [...(getCoopSession()?.takeovers ?? [])];
    },
    get field() {
      const session = getCoopSession();
      return (globalScene?.getPlayerField?.() ?? []).map((pokemon, slot) => ({
        slot,
        pokemonId: pokemon.id,
        owner: session?.ownership.get(pokemon.id) ?? null,
      }));
    },
    get trade() {
      const handler = globalScene?.ui?.handlers?.[UiMode.COOP_TRADE] as CoopTradeUiHandler | undefined;
      return handler?.active ? handler.describe() : null;
    },
    get party() {
      const session = getCoopSession();
      return (globalScene?.getPlayerParty?.() ?? []).map(pokemon => ({
        owner: session?.ownership.get(pokemon.id) ?? null,
        name: pokemon.name,
        hp: pokemon.hp,
        maxHp: pokemon.getMaxHp(),
        moves: pokemon.getMoveset().map(move => move.moveId),
        ppUsed: pokemon.getMoveset().map(move => move.ppUsed),
        usedTms: [...pokemon.usedTMs],
      }));
    },
    get stalls() {
      return [...stalls];
    },
    get roomCode() {
      return getCoopSession()?.link?.code ?? null;
    },
    get epoch() {
      return getCoopSession()?.link?.epoch ?? 0;
    },
    get partnerPresent() {
      return getCoopSession()?.link?.partnerPresent ?? false;
    },
    get needsResync() {
      return getCoopSession()?.link?.needsResync ?? false;
    },
    get reconnectScreen() {
      return reconnectScreenText();
    },
    get sourceLink() {
      return sourceUrlOf(import.meta.env.VITE_SOURCE_URL);
    },
    get coopLog() {
      return coopLog()
        .all.slice(-200)
        .map(({ n, level, kind, msg }) => ({ n, level, kind, msg }));
    },
    get coopLogSent() {
      return coopLog().serverCollects;
    },
    report: note => reportProblem(note, false),
    get menuOptions() {
      const handler = globalScene?.ui?.getHandler?.() as unknown as
        | { config?: { options?: { label: string }[] } }
        | undefined;
      return (handler?.config?.options ?? []).map(option => option.label);
    },
    get pingKey() {
      return pingKeyName();
    },
    get messageText() {
      const handler = globalScene?.ui?.getMessageHandler?.() as unknown as { message?: { text?: string } } | undefined;
      return String(handler?.message?.text ?? "");
    },
    get resyncs() {
      return [...(getCoopSession()?.resyncs ?? [])];
    },
    get stopped() {
      const stopped = getCoopSession()?.stopped;
      return stopped == null ? null : { wave: stopped.wave };
    },
    get timing() {
      return { ...(getCoopSession()?.timing ?? {}) };
    },
    get slot() {
      const slot = currentCoopSlot();
      return slot === null ? null : { wave: slot.wave, epoch: slot.epoch, seq: slot.seq, names: slot.names };
    },
    trace: () => getCoopSession()?.trace.dump() ?? [],
    setOverrides: values => {
      Object.assign(activeOverrides, values);
    },
    setAfkTimers: (hintMs, takeoverMs, keepWaitingMs) => {
      const session = getCoopSession();
      if (session !== null) {
        session.afkTimers = { hintMs, takeoverMs, ...(keepWaitingMs === undefined ? {} : { keepWaitingMs }) };
        retimeAfkWatchers();
      }
    },
    corrupt: () => {
      const pokemon = globalScene.getPlayerParty()[0];
      if (getCoopSession() === null || pokemon === undefined) {
        return false;
      }
      pokemon.hp = pokemon.hp > 1 ? pokemon.hp - 1 : pokemon.hp + 1;
      return true;
    },
    leave: () => {
      const session = getCoopSession();
      if (session === null) {
        return false;
      }
      endSession(session);
      return true;
    },
    setReconnectEndMs: ms => {
      const session = getCoopSession();
      if (session !== null) {
        session.reconnectEndMs = ms;
      }
    },
    setName: name => setCoopName(name),
    hotkey: which => (which === "ping" ? pingNow() : openEmoteWheel()),
    nudge: () => sendPing({ k: "none" }),
    emote: id => sendEmote(id),
    canLearnTm: (partyIndex, moveId) => globalScene.getPlayerParty()[partyIndex]?.isTmCompatible(moveId, true) ?? false,
    moveRewardCursor: (row, cursor) => {
      const handler = globalScene.ui.handlers[UiMode.MODIFIER_SELECT] as ModifierSelectUiHandler | undefined;
      if (globalScene.ui.mode !== UiMode.MODIFIER_SELECT || handler === undefined) {
        return false;
      }
      handler.setRowCursor(row);
      handler.setCursor(cursor);
      return true;
    },
    movePartyCursor: partyIndex => {
      const handler = globalScene.ui.handlers[UiMode.PARTY] as PartyUiHandler | undefined;
      if (globalScene.ui.mode !== UiMode.PARTY || handler === undefined) {
        return false;
      }
      handler.setCursor(partyIndex);
      return true;
    },
    press: button => globalScene.ui.processInput(Button[button]),
    submitJoinCode: code => {
      const handler = globalScene.ui.handlers[UiMode.COOP_JOIN_FORM] as CoopJoinFormUiHandler | undefined;
      if (globalScene.ui.mode !== UiMode.COOP_JOIN_FORM || handler === undefined) {
        return false;
      }
      handler.submitCode(code);
      return true;
    },
  };
}

/**
 * Expose `window.__coop`. Only dev and test builds do, and the image of the browser tests (`VITE_COOP_E2E`): a beta or
 * production build exposes nothing.
 */
export function installCoopDebugApi(): void {
  if (
    import.meta.env.MODE !== "development"
    && import.meta.env.MODE !== "test"
    && import.meta.env.VITE_COOP_E2E !== "1"
  ) {
    return;
  }
  (window as unknown as { __coop?: CoopDebugApi }).__coop = api();
  startStallDetector();
}
