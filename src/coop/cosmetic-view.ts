/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { getPokemonNameWithAffix } from "#app/messages";
import { coopText, getLink, isLinked } from "#coop/bridge";
import { controllerOf } from "#coop/control";
import { type CosmeticMessage, type CosmeticTarget, EMOTE_COUNT } from "#coop/cosmetic";
import { addTag, addTargetPointer, battlerBox, MARK_COLORS, type TagPiece } from "#coop/cosmetic-tag";
import type { CoopLink } from "#coop/link";
import type { Seat } from "#coop/protocol";
import { getCoopSession } from "#coop/session";
import { allMoves } from "#data/data-lists";
import { getTypeRgb } from "#data/type";
import type { PokemonType } from "#enums/pokemon-type";
import { UiMode } from "#enums/ui-mode";
import type { Pokemon } from "#field/pokemon";
import type { ModifierSelectUiHandler } from "#ui/modifier-select-ui-handler";
import type { MysteryEncounterUiHandler } from "#ui/mystery-encounter-ui-handler";

/**
 * What the cosmetic channel shows (DECISIONS D16): the partner's intents as ghost markers, their cursor on the reward
 * screen, their pings and emotes as bubbles. Everything here only draws: it reads the simulation and never changes it, and
 * a message that does not fit what is on screen is dropped.
 *
 * The state is kept apart from the drawing (`intents`, `cursor`, `pings`, `emotes`) so tests and the debug API can read what
 * was received even where nothing can be drawn.
 *
 * @module
 */

/** How long a ping or an emote bubble stays, in ms */
const BUBBLE_MS = 2500;
/** How many pings and emotes the debug view keeps */
const KEPT = 12;

export interface IntentState {
  pokemonId: number;
  move: number | null;
  target: number | null;
  ready: boolean;
}

export interface PingState {
  seat: Seat;
  name: string;
  at: CosmeticTarget;
  shownAt: number;
}

export interface EmoteState {
  seat: Seat;
  name: string;
  id: number;
  label: string;
  shownAt: number;
}

/** The six emotes of the wheel (D16), by `id` */
export function emoteLabel(id: number): string {
  const labels = [
    coopText("emote0", "Go!"),
    coopText("emote1", "Nice!"),
    coopText("emote2", "Oops"),
    coopText("emote3", "Wait!"),
    coopText("emote4", "Thanks"),
    coopText("emote5", "?"),
  ];
  return labels[id] ?? "";
}

export class CosmeticView {
  /** The partner's tentative commands by `pokemon.id`, as last announced */
  public readonly intents = new Map<number, IntentState>();
  /** The partner's cursor on the reward screen that is open (`null`: none, or another screen's) */
  public cursor: { screen: number; row: number; col: number } | null = null;
  /** The chooser's cursor on the options of a Mystery Encounter (D29), while the partner chooses */
  public meCursor: { step: number; index: number } | null = null;
  public readonly pings: PingState[] = [];
  public readonly emotes: EmoteState[] = [];

  private readonly unsubscribe: () => void;
  /** What is drawn for each intent, to be replaced when it changes */
  private readonly intentObjects = new Map<number, Phaser.GameObjects.GameObject[]>();
  /** The bubble of each seat: a new one replaces the old */
  private readonly bubbles = new Map<Seat, Phaser.GameObjects.GameObject>();

  constructor(
    public readonly link: CoopLink,
    /** The partner's seat */
    private readonly partner: Seat,
  ) {
    this.unsubscribe = link.onCosmetic(message => this.handle(message));
  }

  /** The partner's name, for the bubbles */
  private get partnerName(): string {
    return this.link.partnerName;
  }

  /** @returns What is on screen, for the debug API */
  public describe(): {
    intents: IntentState[];
    cursor: { screen: number; row: number; col: number } | null;
    pings: PingState[];
    emotes: EmoteState[];
    drawn: number;
  } {
    let drawn = this.bubbles.size;
    for (const objects of this.intentObjects.values()) {
      drawn += objects.length;
    }
    return {
      intents: [...this.intents.values()],
      cursor: this.cursor,
      pings: [...this.pings],
      emotes: [...this.emotes],
      drawn,
    };
  }

  public dispose(): void {
    this.unsubscribe();
    this.clearIntents();
    for (const bubble of this.bubbles.values()) {
      bubble.destroy();
    }
    this.bubbles.clear();
    this.cursor = null;
    this.meCursor = null;
  }

  /** What arrived on the cosmetic channel; it was validated and limited already ({@linkcode CoopLink.onCosmetic}) */
  public handle(message: CosmeticMessage): void {
    try {
      switch (message.t) {
        case "intent":
          this.onIntent(message);
          break;
        case "cursor":
          this.onCursor(message);
          break;
        case "meCursor":
          this.onMeCursor(message);
          break;
        case "ping":
          this.onPing(message.at);
          break;
        case "emote":
          this.onEmote(message.id);
          break;
      }
    } catch (error) {
      // Drawing must never take the game down
      console.error("co-op: could not show a cosmetic message:", error);
    }
  }

  // #region Intents

  private onIntent(message: Extract<CosmeticMessage, { t: "intent" }>): void {
    const session = getCoopSession();
    // The partner can only announce what its own Pokémon do
    if (session === null || session.ownership.get(message.pokemonId) !== this.partner) {
      return;
    }
    // ... and only while the commands of a turn are being chosen: a message that is late for a turn that started is stale
    if (!commandsAreOpen()) {
      return;
    }
    if (message.move === null && message.target === null && !message.ready) {
      this.intents.delete(message.pokemonId);
    } else {
      this.intents.set(message.pokemonId, {
        pokemonId: message.pokemonId,
        move: message.move,
        target: message.target,
        ready: message.ready,
      });
    }
    this.drawIntent(message.pokemonId);
  }

  /** The partner's command for this Pokémon was sequenced: it is ready, whatever the cosmetic channel got of it */
  public markReady(pokemonId: number): void {
    const session = getCoopSession();
    if (session === null || session.ownership.get(pokemonId) !== this.partner) {
      return;
    }
    const known = this.intents.get(pokemonId);
    this.intents.set(pokemonId, { pokemonId, move: known?.move ?? null, target: known?.target ?? null, ready: true });
    try {
      this.drawIntent(pokemonId);
    } catch (error) {
      console.error("co-op: could not show a ready mark:", error);
    }
  }

  /** The turn starts, or the partner went back: the markers go (D8) */
  public clearIntents(): void {
    this.intents.clear();
    for (const id of [...this.intentObjects.keys()]) {
      this.eraseIntent(id);
    }
  }

  private eraseIntent(pokemonId: number): void {
    for (const object of this.intentObjects.get(pokemonId) ?? []) {
      // (a pointer that bobs has a tween that never ends by itself)
      globalScene.tweens.killTweensOf(object);
      object.destroy();
    }
    this.intentObjects.delete(pokemonId);
  }

  /**
   * One tag above the partner's Pokémon says what it is about to do, and corner marks show its target:
   * - looking at a move: the move's type, its name and "...", lighter;
   * - aiming it: the arrow and the target's name, and the marks on the target;
   * - locked in: a check mark, in green.
   */
  private drawIntent(pokemonId: number): void {
    this.eraseIntent(pokemonId);
    const intent = this.intents.get(pokemonId);
    if (intent === undefined || !canDraw()) {
      return;
    }
    const actor = globalScene.getPlayerField().find(pokemon => pokemon?.id === pokemonId && pokemon.isActive());
    if (actor === undefined) {
      return;
    }
    const move = intent.move === null ? undefined : allMoves[intent.move];
    // a move that hits several has no one target (the command names the first)
    const spread = move?.isMultiTarget() ?? false;
    const target = intent.target === null || spread ? undefined : globalScene.getField()[intent.target];
    const aimed = target !== undefined && target !== actor && target.isActive();
    const accent = intent.ready ? MARK_COLORS.ready : MARK_COLORS.partner;
    const accentText = intent.ready ? MARK_COLORS.readyText : MARK_COLORS.partnerText;

    const pieces: TagPiece[] = [];
    if (intent.ready) {
      pieces.push({ icon: "check", color: MARK_COLORS.ready });
    }
    if (move !== undefined) {
      pieces.push({ chip: typeColor(move.type) }, { text: move.name, color: MARK_COLORS.text });
      if (aimed) {
        pieces.push({ icon: "arrow", color: accent }, { text: shortName(target), color: accentText });
      } else if (spread && intent.ready) {
        pieces.push({ icon: "arrow", color: accent }, { text: coopText("targetAll", "all"), color: accentText });
      } else if (!intent.ready) {
        pieces.push({ icon: "dots", color: MARK_COLORS.partner });
      }
    } else if (intent.ready) {
      // a switch, a Ball or Run, or a command the cosmetic channel did not carry
      pieces.push({ text: coopText("intentReady", "Ready"), color: MARK_COLORS.readyText });
    } else {
      return;
    }

    const objects: Phaser.GameObjects.GameObject[] = [
      addTag(actor.x, battlerBox(actor).top - 1, pieces, { accent, dim: !intent.ready, tail: true }),
    ];
    if (aimed) {
      // a pointer over the target: moving while the partner is still aiming, still once locked in
      objects.push(addTargetPointer(target, accent, !intent.ready));
    }
    this.intentObjects.set(pokemonId, objects);
  }

  // #endregion

  // #region Reward screen cursor

  private onCursor(message: Extract<CosmeticMessage, { t: "cursor" }>): void {
    const session = getCoopSession();
    // Only the screen that is open, or the next one: a client that is a moment behind keeps the cursor of the screen it is
    // about to open (`drawCursor` shows it once that screen is up); any other screen's cursor is stale
    const open = session === null ? -1 : session.rewardPickCount - 1;
    if (session === null || (message.screen !== open && message.screen !== open + 1)) {
      return;
    }
    this.cursor = { screen: message.screen, row: message.row, col: message.col };
    this.drawCursor();
  }

  /** Show the partner's cursor on the reward screen, if it is open */
  public drawCursor(): void {
    const handler = rewardHandler();
    if (handler === null) {
      return;
    }
    const session = getCoopSession();
    if (this.cursor === null || session === null || this.cursor.screen !== session.rewardPickCount - 1) {
      handler.setPartnerCursor(null);
    } else {
      handler.setPartnerCursor(this.cursor.row, this.cursor.col);
    }
  }

  /** The reward screen is over: the partner's cursor is not on it any more */
  public clearCursor(): void {
    this.cursor = null;
    rewardHandler()?.setPartnerCursor(null);
  }

  // #endregion

  // #region Encounter screen cursor (D29)

  private onMeCursor(message: Extract<CosmeticMessage, { t: "meCursor" }>): void {
    const session = getCoopSession();
    // Only the chooser's, on the question that is open or the next one (a client a moment behind asks it next)
    if (
      session === null
      || session.meChooser !== this.partner
      || message.step < session.meStep - 1
      || message.step > session.meStep
    ) {
      return;
    }
    this.meCursor = { step: message.step, index: message.index };
    this.drawMeCursor();
  }

  /** While the partner chooses an encounter's option, this screen's cursor follows theirs */
  public drawMeCursor(): void {
    const session = getCoopSession();
    if (
      this.meCursor === null
      || session === null
      || session.meQuestion?.k !== "option"
      || this.meCursor.step !== session.meStep - 1
      || globalScene?.ui == null
      || globalScene.ui.mode !== UiMode.MYSTERY_ENCOUNTER
    ) {
      return;
    }
    (globalScene.ui.handlers[UiMode.MYSTERY_ENCOUNTER] as MysteryEncounterUiHandler).followPartnerCursor(
      this.meCursor.index,
    );
  }

  // #endregion

  // #region Pings and emotes

  private onPing(at: CosmeticTarget): void {
    const session = getCoopSession();
    if (session === null) {
      return;
    }
    this.pings.push({ seat: this.partner, name: this.partnerName, at, shownAt: Date.now() });
    this.pings.splice(0, Math.max(0, this.pings.length - KEPT));
    if (!canDraw()) {
      return;
    }
    // What is pinged: a battler, a party Pokémon, or an option of the reward screen
    if (at.k !== "reward" && at.k !== "shop") {
      this.showBubble(this.partner, this.partnerName, this.describeTarget(at), true);
    }
    switch (at.k) {
      case "enemy":
        this.flashBattler(globalScene.getEnemyField()[at.index]);
        break;
      case "ally":
        this.flashBattler(globalScene.getPlayerField()[at.index]);
        break;
      case "reward":
      case "shop":
        rewardHandler()?.pingOption(at.k === "shop", at.index, `${this.partnerName}: !`);
        break;
      default:
        break;
    }
  }

  /** What a ping is about, after its "!" (nothing in particular: nothing) */
  private describeTarget(at: CosmeticTarget): string {
    switch (at.k) {
      case "enemy": {
        const enemy = globalScene.getEnemyField()[at.index];
        return enemy === undefined ? "" : getPokemonNameWithAffix(enemy);
      }
      case "ally": {
        const ally = globalScene.getPlayerField()[at.index];
        return ally === undefined ? "" : getPokemonNameWithAffix(ally);
      }
      case "party": {
        const member = globalScene.getPlayerParty().find(pokemon => pokemon.id === at.pokemonId);
        return member === undefined ? "" : getPokemonNameWithAffix(member);
      }
      default:
        return "";
    }
  }

  /** A pointer blinks over a pinged battler, then goes */
  private flashBattler(pokemon: Pokemon | undefined): void {
    if (pokemon === undefined || !pokemon.isActive()) {
      return;
    }
    const pointer = addTargetPointer(pokemon, MARK_COLORS.partner);
    globalScene.tweens.add({ targets: pointer, alpha: 0.25, duration: 180, yoyo: true, repeat: 2 });
    this.fadeOut(pointer);
  }

  private onEmote(id: number): void {
    if (id < 0 || id >= EMOTE_COUNT) {
      return;
    }
    const label = emoteLabel(id);
    this.emotes.push({ seat: this.partner, name: this.partnerName, id, label, shownAt: Date.now() });
    this.emotes.splice(0, Math.max(0, this.emotes.length - KEPT));
    if (canDraw()) {
      this.showBubble(this.partner, this.partnerName, label);
    }
  }

  /**
   * A bubble over the Pokémon of the field slot `seat` controls (above where its command tag goes), or on its side of the
   * screen: the name in the seat's colour, then what it says. A new one replaces the one before.
   * @param ping - A ping: a "!" before what it is about
   */
  public showBubble(seat: Seat, name: string, message: string, ping = false): void {
    this.bubbles.get(seat)?.destroy();
    const [x, y] = bubbleSpot(seat);
    const partner = seat === this.partner;
    const pieces: TagPiece[] = [{ text: `${name}:`, color: partner ? MARK_COLORS.partnerText : MARK_COLORS.text }];
    if (ping) {
      pieces.push({ icon: "bang", color: partner ? MARK_COLORS.partner : MARK_COLORS.own });
    }
    if (message !== "") {
      pieces.push({ text: message, color: MARK_COLORS.text });
    }
    const bubble = addTag(x, y, pieces, { accent: partner ? MARK_COLORS.partner : MARK_COLORS.own, tail: true });
    this.bubbles.set(seat, bubble);
    this.fadeOut(bubble, () => {
      if (this.bubbles.get(seat) === bubble) {
        this.bubbles.delete(seat);
      }
    });
  }

  private fadeOut(object: Phaser.GameObjects.Container, done?: () => void): void {
    globalScene.tweens.add({
      targets: object,
      alpha: 0,
      delay: BUBBLE_MS,
      duration: 400,
      onComplete: () => {
        object.destroy();
        done?.();
      },
    });
  }

  // #endregion
}

// #region The view of this client

let view: CosmeticView | null = null;

/** @returns The cosmetic view of the running link, or `null` without one (solo play, or a session without a network) */
export function getCosmeticView(): CosmeticView | null {
  if (view !== null && view.link !== getLink()) {
    view.dispose();
    view = null;
  }
  return view;
}

/** Start showing what the partner's cosmetic messages say; called when the link exists */
export function startCosmeticView(link: CoopLink, partner: Seat): CosmeticView {
  view?.dispose();
  view = new CosmeticView(link, partner);
  return view;
}

/** Stop: the run is over or the players left */
export function stopCosmeticView(): void {
  view?.dispose();
  view = null;
}

// #endregion

// #region What this client sends

/** Tell the partner what this player is about to command (D16); a no-op without a network */
export function sendIntent(pokemonId: number, move: number | null, target: number | null, ready = false): void {
  if (isLinked()) {
    getLink()?.sendCosmetic({ t: "intent", pokemonId, move, target, ready });
  }
}

/** The turn starts: the partner's markers go, and what was held back to send is dropped (D8, D16) */
export function endTurnCosmetics(): void {
  getCosmeticView()?.clearIntents();
  getLink()?.clearHeldCosmetics();
}

/** Tell the partner where this player's cursor is on reward screen `screen` */
export function sendCursor(screen: number, row: number, col: number): void {
  if (isLinked()) {
    getLink()?.sendCosmetic({ t: "cursor", screen, row, col });
  }
}

/** Tell the partner which option of the encounter's question `step` this player's cursor is on (D29) */
export function sendMeCursor(step: number, index: number): void {
  if (isLinked()) {
    getLink()?.sendCosmetic({ t: "meCursor", step, index });
  }
}

/**
 * Ping something: the partner sees a bubble with this player's name, and the target flashes.
 * @returns Whether it was sent (a ping over the limit is refused)
 */
export function sendPing(at: CosmeticTarget): boolean {
  const link = getLink();
  if (link === null) {
    return false;
  }
  const sent = link.sendCosmetic({ t: "ping", at });
  if (sent) {
    // This player sees their own ping, too
    getOwnBubbles()?.showBubble(getCoopSession()?.seat ?? "host", link.name, "", true);
  }
  return sent;
}

/** Say one of the six emotes; the partner sees a bubble on this player's side of the field */
export function sendEmote(id: number): boolean {
  const link = getLink();
  if (link === null) {
    return false;
  }
  const sent = link.sendCosmetic({ t: "emote", id });
  if (sent) {
    getOwnBubbles()?.showBubble(getCoopSession()?.seat ?? "host", link.name, emoteLabel(id));
  }
  return sent;
}

function getOwnBubbles(): CosmeticView | null {
  return canDraw() ? getCosmeticView() : null;
}

// #endregion

// #region Where things are

/** The phases in which the commands of a turn are chosen and exchanged */
const COMMAND_PHASES: readonly string[] = ["TurnInitPhase", "CommandPhase", "SelectTargetPhase", "CoopTurnSyncPhase"];

/** Whether the commands of a turn are being chosen (and a partner's intent means something) */
function commandsAreOpen(): boolean {
  const phase = globalScene?.phaseManager?.getCurrentPhase();
  return phase != null && COMMAND_PHASES.includes(phase.phaseName);
}

/** Whether there is a battle on screen to draw into */
function canDraw(): boolean {
  return isLinked() && globalScene?.currentBattle != null && globalScene.fieldUI != null;
}

function rewardHandler(): ModifierSelectUiHandler | null {
  if (globalScene?.ui == null || globalScene.ui.mode !== UiMode.MODIFIER_SELECT) {
    return null;
  }
  return (globalScene.ui.handlers[UiMode.MODIFIER_SELECT] as ModifierSelectUiHandler | undefined) ?? null;
}

/**
 * Where a seat's bubble goes (the tip of its notch): above the Pokémon of the field slot it controls, over the place of that
 * Pokémon's command tag, or, with none, on its side (the host's left, the guest's right).
 */
function bubbleSpot(seat: Seat): [number, number] {
  const width = globalScene.scaledCanvas.width;
  if (globalScene.ui?.mode === UiMode.MODIFIER_SELECT) {
    // Above the rewards, not on them: the seat's side, under the top line of the screen
    return [seat === "host" ? width * 0.25 : width * 0.75, 30];
  }
  for (const [slot, pokemon] of globalScene.getPlayerField().entries()) {
    if (pokemon?.isActive() && controllerOf(slot) === seat) {
      return [pokemon.x, battlerBox(pokemon).top - 1 - BUBBLE_ABOVE_TAG];
    }
  }
  return [seat === "host" ? width * 0.25 : width * 0.75, 110];
}

/** How far a bubble sits above the place of a command tag: one tag and a little room */
const BUBBLE_ABOVE_TAG = 16;

/** A move type's colour, as a number for the tag's chip */
function typeColor(type: PokemonType): number {
  const [red, green, blue] = getTypeRgb(type);
  return (red << 16) | (green << 8) | blue;
}

/** A battler's name, short enough for a tag */
function shortName(pokemon: Pokemon): string {
  const name = pokemon.getNameToRender({ prependFormName: false });
  return name.length > 12 ? name.slice(0, 11) : name;
}

// #endregion
