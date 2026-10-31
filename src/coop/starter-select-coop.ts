/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Adapted from SunghoLee98/pokerogue `src/coop/coop-starter-select-ui.ts` (AGPL-3.0-only): the partner's party is drawn
 * beside the player's own, faded until they are ready; the player's point limit is what the partner's party left.
 */

import { PLAYER_PARTY_MAX_SIZE } from "#app/constants";
import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { coopText } from "#coop/bridge";
import { coopLog } from "#coop/coop-log";
import { drawPixels, MARK_COLORS, MARK_ICONS, type MarkIcon } from "#coop/cosmetic-tag";
import { returnToTitle } from "#coop/lobby";
import { type CoopStarter, STARTERS_PER_SEAT_MAX } from "#coop/protocol";
import { getCoopSession } from "#coop/session";
import { captureAccountSnapshot } from "#coop/sim-account";
import type { StarterLobby } from "#coop/starter-lobby";
import { Button } from "#enums/buttons";
import { TextStyle } from "#enums/text-style";
import type { Starter } from "#types/save-data";
import type { StarterSpeciesId } from "#types/starter-species-id";
import { getPartyValue } from "#ui/starter-select-ui-utils";
import { addTextObject } from "#ui/text";
import { addWindow } from "#ui/ui-theme";
import i18next from "i18next";

/**
 * Co-op on the starter select screen (DECISIONS D3, D4, D7, D32). The screen is the solo one with these changes:
 * - it shows the Pokémon of both players (`shared-collection.ts`)
 * - a player picks at most {@linkcode STARTERS_PER_SEAT_MAX} starters, and the 15-point budget is shared: a player's limit
 *   is what the partner's party left
 * - the partner's picks show in the team slots after the player's own, in a window of their own, faded until they
 *   are ready; the status line names the partner
 * - confirming makes the player ready instead of starting the run, and cancel takes the ready back; the run starts
 *   when both are ready. If the partner leaves, cancel goes back to the title
 *
 * @module
 */

/** @returns The starter as it goes over the wire */
export function toCoopStarter(starter: Starter): CoopStarter {
  const wire: CoopStarter = {
    speciesId: starter.speciesId,
    shiny: starter.shiny,
    variant: starter.variant,
    formIndex: starter.formIndex,
    abilityIndex: starter.abilityIndex,
    passive: starter.passive,
    nature: starter.nature,
    pokerus: starter.pokerus,
    ivs: [...starter.ivs],
  };
  if (starter.female !== undefined) {
    wire.female = starter.female;
  }
  if (starter.moveset !== undefined) {
    wire.moveset = [...starter.moveset];
  }
  if (starter.nickname !== undefined) {
    wire.nickname = starter.nickname;
  }
  if (starter.teraType !== undefined) {
    wire.teraType = starter.teraType;
  }
  return wire;
}

/** @returns The starter a wire starter describes */
export function fromCoopStarter(wire: CoopStarter): Starter {
  return { ...wire } as Starter;
}

/** What a party of starters costs of the budget, on the local account. */
export function starterCost(starters: readonly Starter[]): number {
  return getPartyValue(starters.map(starter => starter.speciesId as StarterSpeciesId));
}

/** Positions on the starter select screen, supplied by its handler. */
export interface CoopStarterSelectLayout {
  /** Position of team slot `index` (0-5); the partner's picks use the slots after the player's own */
  iconPosition(index: number): [x: number, y: number];
  /** The screen's own team slot icons (0-5); the free ones show the empty-slot placeholder */
  slotIcons: readonly Phaser.GameObjects.Sprite[];
  /** Right edge and top of the status plate, in a free part of the screen */
  statusPosition: [x: number, y: number];
  /** How wide the status plate may be before its text wraps (it has room for two lines) */
  statusWidth: number;
  /** The co-op objects are drawn just below this child of the container, so the screen's later layers cover them */
  drawBelow: Phaser.GameObjects.GameObject;
  /** The team column's window */
  teamWindow: { x: number; y: number; width: number; height: number };
  /** The container of the team column (its windows, cursors and icons) */
  teamColumn: Phaser.GameObjects.Container;
}

/** The color of the partner on the co-op screens: their team slots here, their cursor on the reward screen (D16) */
export const PARTNER_COLOR = 0x8fd3ff;

/** The partner's name, for the lines of this screen */
function partnerName(): string {
  return getCoopSession()?.partnerName || coopText("yourPartner", "your partner");
}

/** What the status says: the partner picks or is ready, this player is ready, or something went wrong */
export type StatusTone = "picking" | "ready" | "self" | "warn";

/** How far the partner's team slots sit below their place in solo play, for the edge of their window */
const PARTNER_SLOT_SHIFT = 3;

/** The accent of a warning on the status plate */
const WARN_COLOR = 0xf0a048;

/**
 * The status, on a plate in the colours of the battle's co-op tags (D16): the window's body and edge, a bar on the left in
 * the colour of what it says, and a pixel icon (dots while the partner picks, a check once ready)
 */
class StatusPlate {
  readonly object: Phaser.GameObjects.Container;
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly text: Phaser.GameObjects.Text;

  /**
   * @param right - Where its right edge goes
   * @param top - Where its top goes
   * @param maxWidth - How wide it may grow before the text wraps
   */
  constructor(
    private readonly right: number,
    private readonly top: number,
    maxWidth: number,
  ) {
    this.graphics = globalScene.add.graphics();
    this.text = addTextObject(0, 0, "", TextStyle.TOOLTIP_CONTENT, {
      fontSize: "42px",
      wordWrap: { width: (maxWidth - 14) * 6 },
      // Two lines fit above the summary's move list
      lineSpacing: -12,
    }).setOrigin(0, 0);
    this.object = globalScene.add.container(0, 0, [this.graphics, this.text]);
  }

  set(text: string, tone: StatusTone): void {
    this.text.setText(text);
    let icon: MarkIcon = "bang";
    if (tone === "ready" || tone === "self") {
      icon = "check";
    } else if (tone === "picking") {
      icon = "dots";
    }
    let accent: number = MARK_COLORS.ready;
    if (tone === "warn") {
      accent = WARN_COLOR;
    } else if (tone === "picking") {
      accent = PARTNER_COLOR;
    }
    const iconWidth = MARK_ICONS[icon][0].length + 2;
    const width = Math.ceil(2 + 3 + iconWidth + this.text.displayWidth + 3);
    const height = Math.max(11, Math.ceil(this.text.displayHeight) + 2);
    const left = this.right - width;
    const g = this.graphics.clear();
    g.fillStyle(MARK_COLORS.shadow, 0.5).fillRect(left, this.top + 1, width + 1, height + 1);
    g.fillStyle(MARK_COLORS.edge, 1).fillRect(left - 1, this.top - 1, width + 2, height + 2);
    g.fillStyle(MARK_COLORS.body, 0.94).fillRect(left, this.top, width, height);
    g.fillStyle(accent, 1).fillRect(left, this.top, 2, height);
    drawPixels(g, MARK_ICONS[icon], left + 5, Math.round(this.top + height / 2 - 2.5), accent);
    this.text.setPosition(left + 5 + iconWidth, this.top + 1);
  }
}

/**
 * Draws the partner's picks as icons in the team slots after the player's own, in a window of their own (the team column is
 * split in two, in the player's window style), and the status on a plate.
 */
class PartnerView {
  private readonly icons: Phaser.GameObjects.Sprite[] = [];
  /** The placeholders under {@linkcode icons}, hidden while a partner pick covers them */
  private readonly placeholders: Phaser.GameObjects.Sprite[];
  /** The window of the partner's half of the team column */
  private readonly window: Phaser.GameObjects.NineSlice;
  private readonly plate: StatusPlate;

  constructor(container: Phaser.GameObjects.Container, layout: CoopStarterSelectLayout, firstSlot: number) {
    this.placeholders = layout.slotIcons.slice(firstSlot, firstSlot + STARTERS_PER_SEAT_MAX);
    // The partner's slots move down a little, to make room for their window's top edge under the player's last slot
    for (const placeholder of this.placeholders) {
      placeholder.y += PARTNER_SLOT_SHIFT;
    }
    for (let i = 0; i < STARTERS_PER_SEAT_MAX; i++) {
      const [x, y] = layout.iconPosition(firstSlot + i);
      this.icons.push(
        globalScene.add
          .sprite(x, y + PARTNER_SLOT_SHIFT, "pokemon_icons_0")
          .setScale(0.5)
          .setOrigin(0)
          .setVisible(false),
      );
    }
    const [, firstPartner] = layout.iconPosition(firstSlot);
    const team = layout.teamWindow;
    // The edge sits in the empty top of the partner's first icon
    const top = firstPartner + PARTNER_SLOT_SHIFT - 2;
    this.window = addWindow(team.x, top, team.width, team.y + team.height - top);
    // Under the icons of the column, so the placeholders of the partner's free slots show on it
    layout.teamColumn.addAt(this.window, layout.teamColumn.getIndex(layout.slotIcons[0]));
    const [x, y] = layout.statusPosition;
    this.plate = new StatusPlate(x, y, layout.statusWidth);
    container.addAt([...this.icons, this.plate.object], container.getIndex(layout.drawBelow));
  }

  /** The partner's party is drawn faded until they are ready. */
  setPartner(picks: readonly CoopStarter[], ready: boolean): void {
    for (const [i, icon] of this.icons.entries()) {
      const pick = picks.at(i);
      this.placeholders.at(i)?.setVisible(!pick);
      if (!pick) {
        icon.setVisible(false);
        continue;
      }
      const species = speciesDataRegistry.getSpecies(pick.speciesId);
      const female = pick.female === true && species.malePercent !== null;
      const frame = species.getIconId(female, pick.formIndex, pick.shiny, pick.variant);
      icon.setTexture(species.getIconAtlasKey(pick.formIndex, pick.shiny, pick.variant)).setFrame(frame);
      if (icon.frame.name !== frame) {
        // The atlas has no icon for this variant: the plain one, as the screen does for the player's own picks
        icon
          .setTexture(species.getIconAtlasKey(pick.formIndex, false, pick.variant))
          .setFrame(species.getIconId(female, pick.formIndex, false, pick.variant));
      }
      icon.setAlpha(ready ? 1 : 0.5).setVisible(true);
    }
  }

  setStatus(text: string, tone: StatusTone): void {
    this.plate.set(text, tone);
  }

  destroy(): void {
    for (const icon of this.icons) {
      icon.destroy();
    }
    for (const placeholder of this.placeholders) {
      placeholder.setVisible(true);
      placeholder.y -= PARTNER_SLOT_SHIFT;
    }
    this.window.destroy();
    this.plate.object.destroy();
  }
}

export class CoopStarterSelectController {
  private readonly view: PartnerView;
  private readonly unsubscribe: () => void;
  /** The last party shared with the partner (and its cost), to send only changes */
  private sharedPicks = "[[],0]";
  /** Whether the last confirm was refused because the party costs more than the points left */
  private overLimit = false;
  /** The partner's cost when the limit was last refreshed */
  private lastPartnerCost = 0;

  /**
   * @param onLimitChange - Called when the partner's party changed the points this player has left
   */
  constructor(
    private readonly lobby: StarterLobby,
    container: Phaser.GameObjects.Container,
    layout: CoopStarterSelectLayout,
    private readonly onLimitChange: () => void,
  ) {
    this.view = new PartnerView(container, layout, STARTERS_PER_SEAT_MAX);
    this.unsubscribe = lobby.onChange(() => this.render());
    this.render();
  }

  /** The player's point limit: what the partner's party left of the shared budget. */
  get valueLimit(): number {
    return this.lobby.valueLimit;
  }

  /** What the partner's party takes of the shared budget */
  get partnerCost(): number {
    return this.lobby.partner.cost;
  }

  /** The budget both players share */
  get sharedLimit(): number {
    return this.lobby.sharedLimit;
  }

  /**
   * The player's party changed, or one of its starters did (a shiny, a form, a cheaper cost): share it with the partner, who
   * sees it (faded) and has the points taken.
   */
  updatePicks(starters: readonly Starter[]): void {
    if (this.lobby.localReady || this.lobby.startInfo !== null || this.lobby.closed) {
      return;
    }
    const picks = starters.map(toCoopStarter);
    const cost = starterCost(starters);
    const shared = JSON.stringify([picks, cost]);
    if (shared === this.sharedPicks) {
      return;
    }
    this.sharedPicks = shared;
    this.lobby.setPicks(picks, cost);
    coopLog().info("lobby", "picks", { species: picks.map(pick => pick.speciesId), cost });
  }

  /**
   * The player confirmed their team: become ready and wait for the partner.
   * @returns `true`: in co-op confirming never starts the run by itself
   */
  confirm(starters: readonly Starter[]): boolean {
    if (!this.lobby.closed) {
      const ok = this.lobby.setReady(starters.map(toCoopStarter), starterCost(starters), captureAccountSnapshot());
      this.overLimit = !ok;
      coopLog().info("lobby", ok ? "ready" : "ready refused: not enough points", {
        species: starters.map(starter => starter.speciesId),
        cost: starterCost(starters),
        partnerCost: this.lobby.partner.cost,
      });
    }
    this.render();
    return true;
  }

  /**
   * Handle input before the starter select screen does.
   * @returns Whether the input was consumed: while ready (cancel takes the ready back), once the run started, or once the
   * partner is gone (cancel goes back to the title)
   */
  processInput(button: Button): boolean {
    if (this.lobby.startInfo !== null) {
      return true;
    }
    if (this.lobby.closed) {
      // The partner left: there is no run to start any more. Leaving tells the relay, so the room closes for a partner who
      // would come back to it
      if (button === Button.CANCEL) {
        getCoopSession()?.link?.leave();
        returnToTitle(null);
      } else {
        globalScene.ui.playError();
      }
      return true;
    }
    if (!this.lobby.localReady) {
      return false;
    }
    if (button === Button.CANCEL) {
      this.lobby.cancelReady();
      coopLog().info("lobby", "not ready any more");
      this.render();
    } else {
      globalScene.ui.playError();
    }
    return true;
  }

  /** The question before the player leaves the starter select, which leaves the room */
  leaveQuestion(): string {
    return coopText("confirmLeaveLobby", "Leave the co-op game? It ends for {{partner}} too.", {
      partner: partnerName(),
    });
  }

  destroy(): void {
    this.unsubscribe();
    this.view.destroy();
  }

  private render(): void {
    const { partner } = this.lobby;
    const limitChanged = partner.cost !== this.lastPartnerCost;
    if (limitChanged) {
      this.lastPartnerCost = partner.cost;
      this.overLimit = false;
    }
    this.view.setPartner(partner.picks, partner.ready);
    const vars = { partner: partnerName() };
    // An endless run says so on every line (D39): the guest learns the host's choice here
    const mode = getCoopSession()?.runMode === "endless" ? `${i18next.t("gameMode:endless")}: ` : "";
    const status = (text: string, tone: StatusTone): void => this.view.setStatus(mode + text, tone);
    if (this.lobby.closed) {
      status(coopText("partnerLeftLobby", "{{partner}} left. Cancel: back to the title", vars), "warn");
    } else if (this.lobby.away) {
      status(coopText("partnerAwayLobby", "{{partner}} lost the connection. Waiting…", vars), "warn");
    } else if (this.lobby.localReady) {
      status(coopText("waitingForPartnerReady", "Ready! Waiting for {{partner}}", vars), "self");
    } else if (this.overLimit) {
      status(coopText("notEnoughPoints", "Not enough points"), "warn");
    } else if (this.lobby.wasReset) {
      status(coopText("pointsReset", "Too many points together: pick again"), "warn");
    } else if (partner.ready) {
      status(coopText("partnerIsReady", "{{partner}} is ready", vars), "ready");
    } else {
      status(coopText("partnerIsPicking", "{{partner}} is picking", vars), "picking");
    }
    if (limitChanged) {
      this.onLimitChange();
    }
  }
}

/** @returns How many starters the local player may pick: their share of the party in co-op, a full party otherwise */
export function getStarterPickLimit(): number {
  return globalScene.gameMode.isCoop ? STARTERS_PER_SEAT_MAX : PLAYER_PARTY_MAX_SIZE;
}
