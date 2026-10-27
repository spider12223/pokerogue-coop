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

/**
 * Co-op on the starter select screen (DECISIONS D3, D4, D7, D32). The screen is the solo one with these changes:
 * - it shows the Pokémon of both players (`shared-collection.ts`)
 * - a player picks at most {@linkcode STARTERS_PER_SEAT_MAX} starters, and the 15-point budget is shared: a player's limit
 *   is what the partner's party left
 * - the partner's picks show in the team slots after the player's own, on a band in the partner's color, faded until they
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
  /** Right edge and top of the status text, in a free part of the screen */
  statusPosition: [x: number, y: number];
  /** How wide the status text may be before it wraps (it has room for two lines) */
  statusWidth: number;
  /** The co-op objects are drawn just below this child of the container, so the screen's later layers cover them */
  drawBelow: Phaser.GameObjects.GameObject;
}

/** The color of the partner on the co-op screens: their team slots here, their cursor on the reward screen (D16) */
export const PARTNER_COLOR = 0x8fd3ff;

/** The partner's name, for the lines of this screen */
function partnerName(): string {
  return getCoopSession()?.partnerName || coopText("yourPartner", "your partner");
}

/**
 * Draws the partner's picks as icons in the team slots after the player's own, on a band in the partner's color that marks
 * those slots as theirs, and the status as text.
 */
class PartnerView {
  private readonly icons: Phaser.GameObjects.Sprite[] = [];
  /** The placeholders under {@linkcode icons}, hidden while a partner pick covers them */
  private readonly placeholders: Phaser.GameObjects.Sprite[];
  private readonly band: Phaser.GameObjects.Rectangle;
  private readonly status: Phaser.GameObjects.Text;

  constructor(container: Phaser.GameObjects.Container, layout: CoopStarterSelectLayout, firstSlot: number) {
    this.placeholders = layout.slotIcons.slice(firstSlot, firstSlot + STARTERS_PER_SEAT_MAX);
    for (let i = 0; i < STARTERS_PER_SEAT_MAX; i++) {
      const [x, y] = layout.iconPosition(firstSlot + i);
      this.icons.push(globalScene.add.sprite(x, y, "pokemon_icons_0").setScale(0.5).setOrigin(0).setVisible(false));
    }
    const [bandX, bandTop] = layout.iconPosition(firstSlot);
    const [, bandLast] = layout.iconPosition(firstSlot + STARTERS_PER_SEAT_MAX - 1);
    this.band = globalScene.add
      .rectangle(bandX - 4, bandTop - 1, 28, bandLast - bandTop + 17, PARTNER_COLOR, 0.18)
      .setOrigin(0)
      .setStrokeStyle(1, PARTNER_COLOR, 0.45);
    const [x, y] = layout.statusPosition;
    this.status = addTextObject(x, y, "", TextStyle.TOOLTIP_CONTENT, {
      fontSize: "42px",
      align: "right",
      wordWrap: { width: layout.statusWidth * 6 },
    }).setOrigin(1, 0);
    container.addAt([this.band, ...this.icons, this.status], container.getIndex(layout.drawBelow));
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

  setStatus(text: string): void {
    this.status.setText(text);
  }

  destroy(): void {
    for (const icon of this.icons) {
      icon.destroy();
    }
    for (const placeholder of this.placeholders) {
      placeholder.setVisible(true);
    }
    this.band.destroy();
    this.status.destroy();
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
      // The partner left: there is no run to start any more
      if (button === Button.CANCEL) {
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
    if (this.lobby.closed) {
      this.view.setStatus(coopText("partnerLeftLobby", "{{partner}} left. Cancel: back to the title", vars));
    } else if (this.lobby.localReady) {
      this.view.setStatus(
        coopText("waitingForPartnerReady", "Ready! Waiting for {{partner}} (Cancel to change)", vars),
      );
    } else if (this.overLimit) {
      this.view.setStatus(coopText("notEnoughPoints", "Not enough points"));
    } else if (this.lobby.wasReset) {
      this.view.setStatus(coopText("pointsReset", "Too many points together: pick again"));
    } else {
      this.view.setStatus(
        partner.ready
          ? coopText("partnerIsReady", "{{partner}} is ready", vars)
          : coopText("partnerIsPicking", "{{partner}} is picking", vars),
      );
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
