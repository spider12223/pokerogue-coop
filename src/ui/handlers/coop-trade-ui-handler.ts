/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { getPokemonNameWithAffix } from "#app/messages";
import { drawPixels, MARK_COLORS, MARK_ICONS } from "#coop/cosmetic-tag";
import { coopText } from "#coop/text";
import { Button } from "#enums/buttons";
import { TextStyle } from "#enums/text-style";
import type { PlayerPokemon } from "#field/pokemon";
import { addTextObject } from "#ui/text";
import { UiHandler } from "#ui/ui-handler";
import { addWindow } from "#ui/ui-theme";

/**
 * The trade screen (DECISIONS D11): the player's Pokémon on the left and the partner's on the right,
 * each with its level and HP, the deal underneath (what the player gives, what they get), and the actions beside it. It
 * only shows what {@linkcode CoopTradePhase} gives it and reports what the player did; nothing here changes the simulation.
 *
 * | Phase state | The actions |
 * |---|---|
 * | nothing proposed | Propose (Give, when nothing of the partner's is picked: a gift), Done |
 * | the partner proposed | Accept, Decline |
 * | this player proposed | Withdraw |
 *
 * The cursor moves over the lists with the arrows; down from the last row (or right from the partner's list) it goes to
 * the actions, where up and down (or left and right) move between them, and up or left from the first one goes back to
 * the lists.
 *
 * @module
 */

export interface TradeScreenModel {
  mine: PlayerPokemon[];
  theirs: PlayerPokemon[];
  partnerName: string;
  /** A proposal waiting for an answer: `give` is what the proposer gives, `want` what they ask for */
  pending: { byMe: boolean; give: PlayerPokemon; want: PlayerPokemon | null } | null;
  iAmDone: boolean;
  partnerDone: boolean;
  /** A line for the player: why something was refused, what the partner answered */
  notice: string | null;
}

export interface TradeScreenActions {
  propose(give: number, want: number | null): boolean;
  answer(accept: boolean): void;
  cancel(): void;
  done(done: boolean): void;
}

export type TradeScreenMode = "compose" | "answer" | "wait";

const TEXT_COLOR = "#f8f8f8";
const DIM_COLOR = "#9aa0a8";
/** What this player gives: picked, or in the deal */
const GIVE_COLOR = 0xffdd55;
const GIVE_TEXT = "#ffdd55";
/** What this player gets: the partner's colour */
const GET_COLOR = MARK_COLORS.partner;
const GET_TEXT = MARK_COLORS.partnerText;
/** A row of the lists, and the bar of a fainted Pokémon */
const ROW_FILL = 0x4a4458;
const BAR_BACK = 0x2a2830;

/** The arrows of the deal, as rows of pixels (seven wide, five high) */
const ARROW_RIGHT = ["....#..", "....##.", "#######", "....##.", "....#.."];
const ARROW_LEFT = ["..#....", ".##....", "#######", ".##....", "..#...."];

/** The font size of the small labels ("You give", "Give", "Get") */
const SMALL_FONT = "64px";
/** How many characters of a name fit on a side of the deal, and in a row before the level (about 5.5 pixels each) */
const DEAL_NAME_CHARS = 11;
const ROW_NAME_CHARS = 12;

/** A name of at most `max` characters: a longer one is cut, with "…" */
function shortName(name: string, max: number): string {
  return name.length > max ? `${name.slice(0, max - 1).trimEnd()}…` : name;
}

// The layout, in scaled pixels from the top of the 320x180 canvas
const PANEL_X = [4, 164] as const;
const PANEL_WIDTH = 152;
const PANEL_TOP = 4;
const PANEL_HEIGHT = 100;
const HEADER_Y = PANEL_TOP + 4;
const ROWS_TOP = PANEL_TOP + 20;
/** A row with the HP bar under the name; with more Pokémon than {@linkcode FULL_ROWS}, a compact row of one line */
const FULL_ROWS = 3;
const ROW_HEIGHT = 25;
const COMPACT_ROW_HEIGHT = 13;
const MAX_ROWS = 6;
const DEAL_TOP = 108;
const DEAL_HEIGHT = 32;
const DEAL_WIDTH = 212;
const ACTIONS_X = 220;
const ACTIONS_WIDTH = 96;
const ACTION_LINE = 13;
const STATUS_TOP = 144;
const STATUS_HEIGHT = 34;
const STATUS_TEXT_Y = STATUS_TOP + 3;
/**
 * The status window holds two lines (about 55 characters each); a third would run off the canvas. The texts are written to
 * fit, this only keeps an unexpected one (a long partner name in a hint) from overflowing.
 */
const STATUS_MAX_CHARS = 100;

export class CoopTradeUiHandler extends UiHandler {
  private container: Phaser.GameObjects.Container;
  /** What is drawn from the model, made again by every {@linkcode render} */
  private drawn: Phaser.GameObjects.GameObject[] = [];
  private headers: Phaser.GameObjects.Text[] = [];
  private statusText: Phaser.GameObjects.Text;
  private arrow: Phaser.GameObjects.Text;

  private actions: TradeScreenActions | null = null;
  private model: TradeScreenModel | null = null;
  /** 0: the player's Pokémon, 1: the partner's, 2: the actions */
  private side = 0;
  private row = 0;
  private actionIndex = 0;
  /** The list the cursor came from to the actions, to go back to */
  private lastList = 0;
  private give: number | null = null;
  private want: number | null = null;

  setup(): void {
    const ui = this.getUi();
    const { width, height } = globalScene.scaledCanvas;
    this.container = globalScene.add.container(0, 0);
    this.container.setName("coop-trade");
    this.container.setVisible(false);
    ui.add(this.container);

    // Opaque: with a translucent shade the reward screen shows through between the windows
    const shade = globalScene.add.rectangle(0, -height, width, height, 0x0c0c14, 1);
    shade.setOrigin(0, 0);
    this.container.add(shade);

    for (const [index, x] of PANEL_X.entries()) {
      this.container.add(addWindow(x, -height + PANEL_TOP, PANEL_WIDTH, PANEL_HEIGHT));
      const header = addTextObject(x + 8, -height + HEADER_Y, "", TextStyle.WINDOW);
      this.headers[index] = header;
      this.container.add(header);
    }
    this.container.add(addWindow(4, -height + DEAL_TOP, DEAL_WIDTH, DEAL_HEIGHT));
    this.container.add(addWindow(ACTIONS_X, -height + DEAL_TOP, ACTIONS_WIDTH, DEAL_HEIGHT));

    this.container.add(addWindow(4, -height + STATUS_TOP, width - 8, STATUS_HEIGHT));
    // The text starts at x = 10 and the window ends at x = width - 4, so this wrap width leaves a margin on the right
    this.statusText = addTextObject(10, -height + STATUS_TEXT_Y, "", TextStyle.WINDOW, {
      wordWrap: { width: (width - 24) * 6 },
    });
    this.container.add(this.statusText);

    this.arrow = addTextObject(0, 0, "▶", TextStyle.WINDOW);
    this.container.add(this.arrow);
  }

  /** @param args - `[actions, model]` */
  override show(args: any[]): boolean {
    super.show(args);
    this.actions = args[0] as TradeScreenActions;
    this.model = args[1] as TradeScreenModel;
    this.row = 0;
    this.give = null;
    this.want = null;
    // Opening on a proposal of the partner (a reload, a rejoin) the cursor is on its answers
    this.focusFor(this.mode());
    this.container.setVisible(true);
    this.render();
    return true;
  }

  /** How many rows each list shows */
  private sizes(): [number, number] {
    const model = this.model;
    return [Math.min(model?.mine.length ?? 0, MAX_ROWS), Math.min(model?.theirs.length ?? 0, MAX_ROWS)];
  }

  /**
   * Put the cursor where the player acts in this mode: on the answers or on Withdraw while a proposal is open (the lists
   * are not selectable then), on the lists to compose one.
   */
  private focusFor(mode: TradeScreenMode): void {
    this.actionIndex = 0;
    if (mode !== "compose") {
      this.side = 2;
      return;
    }
    const sizes = this.sizes();
    this.side = sizes[0] > 0 ? 0 : sizes[1] > 0 ? 1 : 2;
    if (this.side !== 2) {
      this.row = Math.min(this.row, sizes[this.side] - 1);
      this.lastList = this.side;
    }
  }

  /** The phase has a new state to show */
  public update(model: TradeScreenModel): void {
    const before = this.mode();
    this.model = model;
    if (this.mode() !== before) {
      this.focusFor(this.mode());
    }
    // What was picked may be gone (a trade went through): keep only what is still there
    if (this.give !== null && !model.mine.some(pokemon => pokemon.id === this.give)) {
      this.give = null;
    }
    if (this.want !== null && !model.theirs.some(pokemon => pokemon.id === this.want)) {
      this.want = null;
    }
    if (this.side !== 2) {
      // a list can be shorter now: keep the cursor on it
      this.row = Math.max(0, Math.min(this.row, this.sizes()[this.side] - 1));
    }
    this.actionIndex = Math.max(0, Math.min(this.actionIndex, this.currentActions().length - 1));
    this.render();
  }

  /** @returns What the screen shows, for the debug API and the tests */
  public describe(): {
    mode: TradeScreenMode;
    give: number | null;
    want: number | null;
    cursor: { side: number; row: number; action: number };
    actions: string[];
    mine: number[];
    theirs: number[];
    notice: string | null;
    /** The text of the status window at the bottom */
    status: string;
    /** What the deal shows: what this player gives and gets (ids), and whether it is a gift */
    deal: { gives: number | null; gets: number | null };
  } {
    const deal = this.deal();
    return {
      mode: this.mode(),
      give: this.give,
      want: this.want,
      cursor: { side: this.side, row: this.row, action: this.actionIndex },
      actions: this.currentActions().map(action => action.label),
      mine: this.model?.mine.map(pokemon => pokemon.id) ?? [],
      theirs: this.model?.theirs.map(pokemon => pokemon.id) ?? [],
      notice: this.model?.notice ?? null,
      status: this.statusText.text,
      deal: { gives: deal.gives?.id ?? null, gets: deal.gets?.id ?? null },
    };
  }

  private mode(): TradeScreenMode {
    const pending = this.model?.pending ?? null;
    if (pending === null) {
      return "compose";
    }
    return pending.byMe ? "wait" : "answer";
  }

  private currentActions(): { label: string; run: () => void; dim?: boolean }[] {
    const model = this.model;
    const actions = this.actions;
    if (model === null || actions === null) {
      return [];
    }
    switch (this.mode()) {
      case "answer":
        return [
          { label: coopText("tradeAccept", "Accept"), run: () => actions.answer(true) },
          { label: coopText("tradeDecline", "Decline"), run: () => actions.answer(false) },
        ];
      case "wait":
        return [{ label: coopText("tradeWithdraw", "Withdraw"), run: () => actions.cancel() }];
      default:
        return [
          {
            // with nothing of the partner's picked, the offer is a gift
            label:
              this.give !== null && this.want === null
                ? coopText("tradeGive", "Give")
                : coopText("tradePropose", "Propose"),
            run: () => {
              if (this.give === null || !actions.propose(this.give, this.want)) {
                this.getUi().playError();
              }
            },
            dim: this.give === null,
          },
          {
            label: model.iAmDone ? coopText("tradeNotDone", "Not done") : coopText("tradeDone", "Done"),
            run: () => actions.done(!model.iAmDone),
          },
        ];
    }
  }

  /**
   * The deal, as this player sees it: the Pokémon of theirs that would go, and the partner's that would come. While a
   * proposal is open it is that proposal; otherwise what the player has picked.
   */
  private deal(): { gives: PlayerPokemon | null; gets: PlayerPokemon | null } {
    const model = this.model;
    if (model === null) {
      return { gives: null, gets: null };
    }
    const pending = model.pending;
    if (pending !== null) {
      return pending.byMe ? { gives: pending.give, gets: pending.want } : { gives: pending.want, gets: pending.give };
    }
    return {
      gives: model.mine.find(pokemon => pokemon.id === this.give) ?? null,
      gets: model.theirs.find(pokemon => pokemon.id === this.want) ?? null,
    };
  }

  /** Draw the whole screen from the model and the cursor */
  private render(): void {
    const model = this.model;
    if (model === null) {
      return;
    }
    const { height } = globalScene.scaledCanvas;
    for (const object of this.drawn.splice(0)) {
      object.destroy();
    }
    const graphics = globalScene.add.graphics();
    this.keep(graphics);
    const deal = this.deal();

    // The two lists, with a "Done" mark on the header of whoever is done
    this.headers[0].setText(coopText("tradeYours", "Your Pokémon"));
    this.headers[1].setText(coopText("tradeTheirs", "{{partner}}'s Pokémon", { partner: model.partnerName }));
    this.headers[1].setColor(GET_TEXT);
    for (const [side, done] of [model.iAmDone, model.partnerDone].entries()) {
      if (done) {
        this.drawDone(graphics, PANEL_X[side] + PANEL_WIDTH - 8, -height + HEADER_Y);
      }
    }
    for (const [side, list] of [model.mine, model.theirs].entries()) {
      const shown = list.slice(0, MAX_ROWS);
      const compact = shown.length > FULL_ROWS;
      for (const [index, pokemon] of shown.entries()) {
        const inDeal = side === 0 ? deal.gives?.id === pokemon.id : deal.gets?.id === pokemon.id;
        this.drawRow(graphics, pokemon, side, index, compact, inDeal);
      }
    }

    this.drawDeal(graphics, deal);

    // The actions, one under the other, beside the deal
    const actions = this.currentActions();
    for (const [index, action] of actions.entries()) {
      const selected = this.side === 2 && this.actionIndex === index;
      this.keep(
        addTextObject(ACTIONS_X + 16, -height + DEAL_TOP + 3 + index * ACTION_LINE, action.label, TextStyle.WINDOW, {
          color: selected ? GIVE_TEXT : action.dim ? DIM_COLOR : TEXT_COLOR,
        }),
      );
    }

    const status = this.statusMessage(model);
    this.statusText.setText(
      status.length > STATUS_MAX_CHARS ? `${status.slice(0, STATUS_MAX_CHARS - 1).trimEnd()}…` : status,
    );
    this.placeArrow();
    // the cursor stays on top of what was drawn again
    this.container.bringToTop(this.arrow);
  }

  private keep<T extends Phaser.GameObjects.GameObject>(object: T): T {
    this.container.add(object);
    this.drawn.push(object);
    return object;
  }

  /** The top of row `index` of a list, in the container's units */
  private rowTop(index: number, compact: boolean): number {
    const { height } = globalScene.scaledCanvas;
    return -height + ROWS_TOP + index * (compact ? COMPACT_ROW_HEIGHT : ROW_HEIGHT);
  }

  /**
   * One Pokémon of a list: a box with its icon, name and level, and its HP under the name (a compact row has the level after
   * the name and no bar). A Pokémon in the deal has a frame in the colour of its side, and a tag: "Give" or "Get".
   */
  private drawRow(
    graphics: Phaser.GameObjects.Graphics,
    pokemon: PlayerPokemon,
    side: number,
    index: number,
    compact: boolean,
    inDeal: boolean,
  ): void {
    // (the cursor sits left of the box)
    const left = PANEL_X[side] + 15;
    const right = PANEL_X[side] + PANEL_WIDTH - 6;
    const top = this.rowTop(index, compact);
    const boxHeight = (compact ? COMPACT_ROW_HEIGHT : ROW_HEIGHT) - 2;
    const accent = side === 0 ? GIVE_COLOR : GET_COLOR;
    graphics.fillStyle(ROW_FILL, inDeal ? 0.9 : 0.45);
    graphics.fillRect(left, top, right - left, boxHeight);
    if (inDeal) {
      this.frame(graphics, left, top, right - left, boxHeight, accent);
    }

    const fainted = pokemon.isFainted();
    const icon = globalScene.addPokemonIcon(pokemon, left + 2, top + (compact ? -4 : -3), 0, 0);
    icon.setScale(compact ? 0.4 : 0.6);
    if (fainted) {
      icon.setAlpha(0.5);
    }
    this.keep(icon);

    const name = shortName(getPokemonNameWithAffix(pokemon), compact ? ROW_NAME_CHARS - 2 : ROW_NAME_CHARS);
    const level = coopText("tradeLevel", "Lv{{level}}", { level: pokemon.level });
    const textX = left + (compact ? 18 : 28);
    this.keep(
      addTextObject(textX, top + 1, compact ? `${name} ${level}` : name, TextStyle.WINDOW, {
        color: fainted ? DIM_COLOR : TEXT_COLOR,
      }),
    );
    if (!compact) {
      this.keep(addTextObject(right - 2, top + 1, level, TextStyle.WINDOW, { color: DIM_COLOR }).setOrigin(1, 0));
      this.drawHp(graphics, pokemon, textX, top + 15, 64);
    }
    if (inDeal) {
      this.keep(
        addTextObject(
          right - 2,
          top + (compact ? 2 : 12),
          side === 0 ? coopText("tradeTagGive", "Give") : coopText("tradeTagGet", "Get"),
          TextStyle.WINDOW,
          { color: side === 0 ? GIVE_TEXT : GET_TEXT, fontSize: SMALL_FONT },
        ).setOrigin(1, 0),
      );
    }
  }

  /** A Pokémon's HP as a bar: green, yellow below a half, red below a fifth; a fainted one has an empty bar */
  private drawHp(
    graphics: Phaser.GameObjects.Graphics,
    pokemon: PlayerPokemon,
    x: number,
    y: number,
    width: number,
  ): void {
    graphics.fillStyle(BAR_BACK, 1);
    graphics.fillRect(x, y, width, 3);
    const ratio = pokemon.isFainted() ? 0 : Math.max(0, Math.min(1, pokemon.getHpRatio()));
    if (ratio > 0) {
      graphics.fillStyle(ratio > 0.5 ? 0x58d858 : ratio > 0.2 ? 0xf0c838 : 0xe84848, 1);
      graphics.fillRect(x, y, Math.max(1, Math.round(width * ratio)), 3);
    }
  }

  /** A frame of one pixel around a box */
  private frame(
    graphics: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    width: number,
    height: number,
    color: number,
  ): void {
    graphics.fillStyle(color, 1);
    graphics.fillRect(x, y, width, 1);
    graphics.fillRect(x, y + height - 1, width, 1);
    graphics.fillRect(x, y, 1, height);
    graphics.fillRect(x + width - 1, y, 1, height);
  }

  /** "✓ Done", its right end at `right`, on a header */
  private drawDone(graphics: Phaser.GameObjects.Graphics, right: number, y: number): void {
    const text = this.keep(
      addTextObject(right, y, coopText("tradeDoneMark", "Done"), TextStyle.WINDOW, {
        color: MARK_COLORS.readyText,
      }).setOrigin(1, 0),
    );
    const width = Number.isFinite(text.displayWidth) && text.displayWidth > 0 ? text.displayWidth : 24;
    drawPixels(graphics, MARK_ICONS.check, Math.round(right - width - 9), y + 3, MARK_COLORS.ready);
  }

  /**
   * The deal: what this player gives on the left, what they get on the right, and arrows between them: both ways for a
   * trade, one way for a gift. An empty side says so.
   */
  private drawDeal(
    graphics: Phaser.GameObjects.Graphics,
    deal: { gives: PlayerPokemon | null; gets: PlayerPokemon | null },
  ): void {
    const { height } = globalScene.scaledCanvas;
    const top = -height + DEAL_TOP;
    const compose = this.mode() === "compose";
    const sides: [PlayerPokemon | null, number, string, string, string][] = [
      [
        deal.gives,
        10,
        coopText("tradeYouGive", "You give"),
        GIVE_TEXT,
        compose ? coopText("tradePickYours", "Pick one of yours") : coopText("tradeNothing", "Nothing"),
      ],
      [
        deal.gets,
        118,
        coopText("tradeYouGet", "You get"),
        GET_TEXT,
        deal.gives === null ? "" : coopText("tradeNothingGift", "Nothing: a gift"),
      ],
    ];
    for (const [pokemon, x, label, color, empty] of sides) {
      this.keep(addTextObject(x + 2, top + 2, label, TextStyle.WINDOW, { color, fontSize: SMALL_FONT }));
      if (pokemon === null) {
        this.keep(addTextObject(x + 2, top + 14, empty, TextStyle.WINDOW, { color: DIM_COLOR }));
        continue;
      }
      const icon = globalScene.addPokemonIcon(pokemon, x, top + 9, 0, 0);
      icon.setScale(0.6);
      this.keep(icon);
      this.keep(
        // the name only (the level is in the lists), cut where it would reach the arrows or the window's edge
        addTextObject(x + 26, top + 14, shortName(getPokemonNameWithAffix(pokemon), DEAL_NAME_CHARS), TextStyle.WINDOW),
      );
    }
    // The arrows, in the gap between the two sides
    const arrowX = 103;
    if (deal.gives !== null && deal.gets !== null) {
      drawPixels(graphics, ARROW_RIGHT, arrowX, top + 13, GIVE_COLOR);
      drawPixels(graphics, ARROW_LEFT, arrowX, top + 20, GET_COLOR);
    } else if (deal.gives !== null) {
      drawPixels(graphics, ARROW_RIGHT, arrowX, top + 16, GIVE_COLOR);
    } else if (deal.gets !== null) {
      drawPixels(graphics, ARROW_LEFT, arrowX, top + 16, GET_COLOR);
    }
  }

  /** What the status window says: a notice first, then where the screen is waiting, then the help or the open proposal */
  private statusMessage(model: TradeScreenModel): string {
    if (model.notice !== null) {
      return model.notice;
    }
    if (model.pending === null) {
      const partner = model.partnerName;
      if (model.iAmDone && !model.partnerDone) {
        return coopText("tradeWaitingDone", "Waiting for {{partner}} to finish…", { partner });
      }
      if (model.partnerDone) {
        return coopText("tradePartnerDone", "{{partner}} is done.", { partner });
      }
    }
    return this.statusLine(model);
  }

  private statusLine(model: TradeScreenModel): string {
    const pending = model.pending;
    if (pending === null) {
      return coopText(
        "tradeHelp",
        "Pick yours to give, and one of {{partner}}'s to trade for it, or none to give it for free.",
        { partner: model.partnerName },
      );
    }
    const give = getPokemonNameWithAffix(pending.give);
    const want = pending.want === null ? "" : getPokemonNameWithAffix(pending.want);
    if (pending.byMe) {
      return want === ""
        ? coopText("tradeWaitingGift", "Waiting for {{partner}}: you give {{give}}.", {
            partner: model.partnerName,
            give,
          })
        : coopText("tradeWaiting", "Waiting for {{partner}}: your {{give}} for their {{want}}.", {
            partner: model.partnerName,
            give,
            want,
          });
    }
    return want === ""
      ? coopText("tradeOfferedGift", "{{partner}} gives you {{give}}.", { partner: model.partnerName, give })
      : coopText("tradeOffered", "{{partner}} offers {{give}} for your {{want}}.", {
          partner: model.partnerName,
          give,
          want,
        });
  }

  private placeArrow(): void {
    const { height } = globalScene.scaledCanvas;
    if (this.side === 2) {
      this.arrow.setPosition(ACTIONS_X + 3, -height + DEAL_TOP + 3 + this.actionIndex * ACTION_LINE);
      return;
    }
    const compact = this.sizes()[this.side] > FULL_ROWS;
    this.arrow.setPosition(PANEL_X[this.side] + 3, this.rowTop(this.row, compact) + 1);
  }

  /** The cursor goes to the actions, from list `from` */
  private toActions(from: number): void {
    this.lastList = from;
    this.side = 2;
    this.actionIndex = Math.max(0, Math.min(this.actionIndex, this.currentActions().length - 1));
  }

  /** The cursor goes back from the actions to the list it came from (the other one if that one is empty) */
  private toLists(): boolean {
    const sizes = this.sizes();
    const list = sizes[this.lastList] > 0 ? this.lastList : sizes[1 - this.lastList] > 0 ? 1 - this.lastList : -1;
    if (list === -1) {
      return false;
    }
    this.side = list;
    this.row = sizes[list] - 1;
    return true;
  }

  processInput(button: Button): boolean {
    const model = this.model;
    if (model === null) {
      return false;
    }
    const sizes = this.sizes();
    const actions = this.currentActions();
    let changed = false;
    if (this.side === 2) {
      switch (button) {
        case Button.UP:
        case Button.LEFT:
          if (this.actionIndex > 0) {
            this.actionIndex--;
            changed = true;
          } else {
            changed = this.toLists();
          }
          break;
        case Button.DOWN:
        case Button.RIGHT:
          changed = this.actionIndex < actions.length - 1;
          this.actionIndex = Math.min(actions.length - 1, this.actionIndex + 1);
          break;
        case Button.ACTION:
          changed = this.act(actions);
          break;
        case Button.CANCEL:
          changed = this.clearPicks();
          break;
        default:
          break;
      }
    } else {
      switch (button) {
        case Button.UP:
          if (this.row > 0) {
            this.row--;
            changed = true;
          }
          break;
        case Button.DOWN:
          if (this.row >= sizes[this.side] - 1) {
            this.toActions(this.side);
          } else {
            this.row++;
          }
          changed = true;
          break;
        case Button.LEFT:
          if (this.side === 1 && sizes[0] > 0) {
            this.side = 0;
            this.row = Math.min(this.row, sizes[0] - 1);
            changed = true;
          }
          break;
        case Button.RIGHT:
          if (this.side === 0 && sizes[1] > 0) {
            this.side = 1;
            this.row = Math.min(this.row, sizes[1] - 1);
          } else {
            this.toActions(this.side);
          }
          changed = true;
          break;
        case Button.ACTION:
          changed = this.act(actions);
          break;
        case Button.CANCEL:
          changed = this.clearPicks();
          break;
        default:
          break;
      }
    }
    if (changed) {
      this.getUi().playSelect();
      this.render();
    }
    return changed;
  }

  private clearPicks(): boolean {
    if (this.mode() === "compose" && (this.give !== null || this.want !== null)) {
      this.give = null;
      this.want = null;
      return true;
    }
    return false;
  }

  private act(actions: { run: () => void }[]): boolean {
    if (this.side === 2) {
      actions[this.actionIndex]?.run();
      return true;
    }
    if (this.mode() !== "compose" || this.model === null) {
      return false;
    }
    if (this.side === 0) {
      const pokemon = this.model.mine[this.row];
      this.give = pokemon === undefined || this.give === pokemon.id ? null : pokemon.id;
    } else {
      const pokemon = this.model.theirs[this.row];
      this.want = pokemon === undefined || this.want === pokemon.id ? null : pokemon.id;
    }
    return true;
  }

  override clear(): void {
    super.clear();
    for (const object of this.drawn.splice(0)) {
      object.destroy();
    }
    this.container.setVisible(false);
    this.actions = null;
    this.model = null;
  }
}
