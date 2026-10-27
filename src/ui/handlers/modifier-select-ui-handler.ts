import { audioManager } from "#app/global-audio-manager";
import { globalScene } from "#app/global-scene";
import { settings } from "#app/global-settings-manager";
import { activeOverrides } from "#app/overrides";
import { handleTutorial, Tutorial } from "#app/tutorial";
import { coopText } from "#coop/bridge";
import type { CosmeticTarget } from "#coop/cosmetic";
import { getCosmeticView, sendCursor } from "#coop/cosmetic-view";
import { getCoopSession } from "#coop/session";
import { allMoves } from "#data/data-lists";
import { getPokeballAtlasKey } from "#data/pokeball";
import { Button } from "#enums/buttons";
import type { PokeballType } from "#enums/pokeball";
import { ShopCursorTarget } from "#enums/shop-cursor-target";
import { TextStyle } from "#enums/text-style";
import { HealShopCostModifier, LockModifierTiersModifier, PokemonHeldItemModifier } from "#modifiers/modifier";
import type { ModifierTypeOption } from "#modifiers/modifier-type";
import { getPlayerShopModifierTypeOptionsForWave, TmModifierType } from "#modifiers/modifier-type";
import type { ModifierSelectCallback } from "#phases/select-modifier-phase";
import { AwaitableUiHandler } from "#ui/awaitable-ui-handler";
import { MoveInfoOverlay } from "#ui/move-info-overlay";
import { addTextObject, getModifierTierTextTint, getTextColor, getTextStyleOptions, getTextWithColors } from "#ui/text";
import { fixedInt, formatMoney, NumberHolder } from "#utils/common";
import i18next from "i18next";
import Phaser from "phaser";

export const SHOP_OPTIONS_ROW_LIMIT = 7;
const SINGLE_SHOP_ROW_YOFFSET = 12;
const DOUBLE_SHOP_ROW_YOFFSET = 24;
const OPTION_BUTTON_YPOSITION = -62;
/** The partner's color on this screen (D16): their cursor, and what they ping */
const PARTNER_TINT = 0x8fd3ff;
/** The cursor of the Trade button, which only exists in a linked co-op run (D11) */
const TRADE_CURSOR = 4;

/** What the co-op run needs the reward screen to show besides the solo screen (the sixth argument of `show`) */
export interface RewardScreenCoop {
  /** Show the Trade button (D11) */
  trade: boolean;
  /** A trade was already requested on this screen */
  requested: boolean;
  /** The player who is not picking: the reroll and lock buttons are drawn as unavailable (D9) */
  readOnly?: boolean;
}

export class ModifierSelectUiHandler extends AwaitableUiHandler {
  private modifierContainer: Phaser.GameObjects.Container;
  private rerollButtonContainer: Phaser.GameObjects.Container;
  private lockRarityButtonContainer: Phaser.GameObjects.Container;
  private transferButtonContainer: Phaser.GameObjects.Container;
  /** Co-op (D11): ask for a trade after this screen */
  private tradeButtonContainer: Phaser.GameObjects.Container;
  private tradeButtonText: Phaser.GameObjects.Text;
  private tradeButtonWidth: number;
  private showTradeButton = false;
  /** Co-op (D9): this player is not the picker of this screen */
  private coopReadOnly = false;
  /** Co-op (D16): the partner's cursor, and the option it is on */
  private partnerCursorObj: Phaser.GameObjects.Image | null = null;
  private partnerTarget: ModifierOption | null = null;
  private checkButtonContainer: Phaser.GameObjects.Container;
  private continueButtonContainer: Phaser.GameObjects.Container;
  private rerollCostText: Phaser.GameObjects.Text;
  /** Co-op: who is choosing, on the screen of the player who is not (D9) */
  private coopLabel: Phaser.GameObjects.Text;
  private lockRarityButtonText: Phaser.GameObjects.Text;
  private moveInfoOverlay: MoveInfoOverlay;
  private moveInfoOverlayActive = false;
  declare protected onActionInput: ModifierSelectCallback | null;

  private rowCursor = 0;
  private player: boolean;
  /**
   * If reroll cost is negative, it is assumed there are 0 items in the shop.
   * It will cause reroll button to be disabled, and a "Continue" button to show in the place of shop items
   */
  private rerollCost: number;
  private transferButtonWidth: number;
  private checkButtonWidth: number;

  public options: ModifierOption[] = [];
  public shopOptionsRows: ModifierOption[][] = [];

  private cursorObj: Phaser.GameObjects.Image | null;

  setup() {
    const ui = this.getUi();

    this.modifierContainer = globalScene.add.container(0, 0);
    ui.add(this.modifierContainer);

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    const styleOptions = getTextStyleOptions(TextStyle.PARTY).styleOptions;

    if (context) {
      context.font = styleOptions.fontSize + "px " + styleOptions.fontFamily;
      this.transferButtonWidth = context.measureText(i18next.t("modifierSelectUiHandler:manageItems")).width;
      this.checkButtonWidth = context.measureText(i18next.t("modifierSelectUiHandler:checkTeam")).width;
      this.tradeButtonWidth = context.measureText(coopText("tradeAsked", "Trade ✓")).width;
    }

    this.transferButtonContainer = globalScene.add.container(
      (globalScene.game.canvas.width - this.checkButtonWidth) / 6 - 21,
      OPTION_BUTTON_YPOSITION,
    );
    this.transferButtonContainer.setName("transfer-btn");
    this.transferButtonContainer.setVisible(false);
    ui.add(this.transferButtonContainer);

    const transferButtonText = addTextObject(-4, -6, i18next.t("modifierSelectUiHandler:manageItems"), TextStyle.PARTY);
    transferButtonText.setName("text-transfer-btn");
    transferButtonText.setOrigin(1, 0);
    this.transferButtonContainer.add(transferButtonText);

    // Co-op (D11): left of "manage items", whether that one is shown or not
    this.tradeButtonContainer = globalScene.add.container(
      (globalScene.game.canvas.width - this.checkButtonWidth - this.transferButtonWidth) / 6 - 33,
      OPTION_BUTTON_YPOSITION,
    );
    this.tradeButtonContainer.setName("trade-btn");
    this.tradeButtonContainer.setVisible(false);
    ui.add(this.tradeButtonContainer);

    this.tradeButtonText = addTextObject(-4, -6, coopText("trade", "Trade"), TextStyle.PARTY);
    this.tradeButtonText.setName("text-trade-btn");
    this.tradeButtonText.setOrigin(1, 0);
    this.tradeButtonContainer.add(this.tradeButtonText);

    this.checkButtonContainer = globalScene.add.container(globalScene.scaledCanvas.width - 1, OPTION_BUTTON_YPOSITION);
    this.checkButtonContainer.setName("use-btn");
    this.checkButtonContainer.setVisible(false);
    ui.add(this.checkButtonContainer);

    const checkButtonText = addTextObject(-4, -6, i18next.t("modifierSelectUiHandler:checkTeam"), TextStyle.PARTY);
    checkButtonText.setName("text-use-btn");
    checkButtonText.setOrigin(1, 0);
    this.checkButtonContainer.add(checkButtonText);

    this.rerollButtonContainer = globalScene.add.container(16, OPTION_BUTTON_YPOSITION);
    this.rerollButtonContainer.setName("reroll-brn");
    this.rerollButtonContainer.setVisible(false);
    ui.add(this.rerollButtonContainer);

    const rerollButtonText = addTextObject(-4, -6, i18next.t("modifierSelectUiHandler:reroll"), TextStyle.PARTY);
    rerollButtonText.setName("text-reroll-btn");
    rerollButtonText.setOrigin(0, 0);
    this.rerollButtonContainer.add(rerollButtonText);

    this.rerollCostText = addTextObject(0, 0, "", TextStyle.MONEY);
    this.rerollCostText.setName("text-reroll-cost");
    this.rerollCostText.setOrigin(0, 0);
    this.rerollCostText.setPositionRelative(rerollButtonText, rerollButtonText.displayWidth + 5, 1);
    this.rerollButtonContainer.add(this.rerollCostText);

    this.lockRarityButtonContainer = globalScene.add.container(16, OPTION_BUTTON_YPOSITION);
    this.lockRarityButtonContainer.setVisible(false);
    ui.add(this.lockRarityButtonContainer);

    this.lockRarityButtonText = addTextObject(
      -4,
      -6,
      i18next.t("modifierSelectUiHandler:lockRarities"),
      TextStyle.PARTY,
    );
    this.lockRarityButtonText.setOrigin(0, 0);
    this.lockRarityButtonContainer.add(this.lockRarityButtonText);

    this.continueButtonContainer = globalScene.add.container(
      globalScene.scaledCanvas.width / 2,
      -(globalScene.scaledCanvas.height / 2),
    );
    this.continueButtonContainer.setVisible(false);
    ui.add(this.continueButtonContainer);

    this.coopLabel = addTextObject(
      globalScene.scaledCanvas.width / 2,
      -globalScene.scaledCanvas.height + 1,
      "",
      TextStyle.BATTLE_INFO,
      {
        backgroundColor: "#000000c8",
        padding: { x: 3, y: 1 },
        align: "center",
        // Between the wave and money text on the right and the left edge; a long hint takes two lines
        wordWrap: { width: (globalScene.scaledCanvas.width - 120) * 6 },
      },
    );
    this.coopLabel.setOrigin(0.5, 0);
    this.coopLabel.setVisible(false);
    // In this screen's container, under the screens opened from it (the party screen of Check Team), not above them
    this.modifierContainer.add(this.coopLabel);

    // Create continue button
    const continueButtonText = addTextObject(
      -24,
      5,
      i18next.t("modifierSelectUiHandler:continueNextWaveButton"),
      TextStyle.MESSAGE,
    );
    continueButtonText.setName("text-continue-btn");
    this.continueButtonContainer.add(continueButtonText);

    // prepare move overlay
    this.moveInfoOverlay = new MoveInfoOverlay({
      delayVisibility: true,
      onSide: true,
      right: true,
      x: 1,
      y: -MoveInfoOverlay.getHeight(true) - 1,
      width: globalScene.scaledCanvas.width - 2,
    });
    ui.add(this.moveInfoOverlay);
    // register the overlay to receive toggle events
    globalScene.addInfoToggle(this.moveInfoOverlay);
  }

  show(args: any[]): boolean {
    globalScene.disableMenu = false;

    if (this.active) {
      if (args.length >= 3) {
        this.awaitingActionInput = true;
        this.onActionInput = args[2];
      }
      this.moveInfoOverlay.active = this.moveInfoOverlayActive;
      return false;
    }

    // The fifth and sixth arguments are only given in co-op: a text for the player who watches the other one choose, and
    // the Trade button (D11)
    if (args.length < 4 || args.length > 6 || !Array.isArray(args[1]) || !(args[2] instanceof Function)) {
      return false;
    }

    super.show(args);

    this.coopLabel.setText(typeof args[4] === "string" ? args[4] : "").setVisible(typeof args[4] === "string");
    this.modifierContainer.bringToTop(this.coopLabel);
    const coop = args[5] as RewardScreenCoop | undefined;
    this.showTradeButton = coop?.trade === true;
    this.coopReadOnly = coop?.readOnly === true;
    this.setTradeRequested(coop?.requested === true);
    this.tradeButtonContainer.setVisible(false);
    this.tradeButtonContainer.setAlpha(0);

    this.getUi().clearText();

    this.player = args[0];

    const partyHasHeldItem =
      this.player
      && globalScene.findModifiers(m => m instanceof PokemonHeldItemModifier && m.isTransferable).length > 0;
    const canLockRarities = !!globalScene.findModifier(m => m instanceof LockModifierTiersModifier);

    this.transferButtonContainer.setVisible(false);
    this.transferButtonContainer.setAlpha(0);

    this.checkButtonContainer.setVisible(false);
    this.checkButtonContainer.setAlpha(0);

    this.rerollButtonContainer.setVisible(false);
    this.rerollButtonContainer.setAlpha(0);

    this.lockRarityButtonContainer.setVisible(false);
    this.lockRarityButtonContainer.setAlpha(0);

    this.continueButtonContainer.setVisible(false);
    this.continueButtonContainer.setAlpha(0);

    this.rerollButtonContainer.setPositionRelative(this.lockRarityButtonContainer, 0, canLockRarities ? -12 : 0);

    this.rerollCost = args[3] as number;

    this.updateRerollCostText();

    const typeOptions = args[1] as ModifierTypeOption[];
    const hasShop = globalScene.gameMode.getShopStatus();
    const baseShopCost = new NumberHolder(globalScene.getWaveMoneyAmount(1));
    globalScene.applyModifier(HealShopCostModifier, true, baseShopCost);
    const shopTypeOptions = hasShop
      ? getPlayerShopModifierTypeOptionsForWave(globalScene.currentBattle.waveIndex, baseShopCost.value)
      : [];
    const optionsYOffset =
      shopTypeOptions.length > SHOP_OPTIONS_ROW_LIMIT ? -SINGLE_SHOP_ROW_YOFFSET : -DOUBLE_SHOP_ROW_YOFFSET;

    for (let m = 0; m < typeOptions.length; m++) {
      const sliceWidth = globalScene.scaledCanvas.width / (typeOptions.length + 2);
      const option = new ModifierOption(
        sliceWidth * (m + 1) + sliceWidth * 0.5,
        -globalScene.scaledCanvas.height / 2 + optionsYOffset,
        typeOptions[m],
      );
      option.setScale(0.5);
      globalScene.add.existing(option);
      this.modifierContainer.add(option);
      this.options.push(option);
    }

    // Set "Continue" button height based on number of rows in healing items shop
    const continueButton = this.continueButtonContainer.getAt<Phaser.GameObjects.Text>(0);
    continueButton.y = optionsYOffset - 5;
    continueButton.setVisible(this.options.length === 0);

    for (let m = 0; m < shopTypeOptions.length; m++) {
      const row = m < SHOP_OPTIONS_ROW_LIMIT ? 0 : 1;
      const col = m < SHOP_OPTIONS_ROW_LIMIT ? m : m - SHOP_OPTIONS_ROW_LIMIT;
      const rowOptions = shopTypeOptions.slice(
        row ? SHOP_OPTIONS_ROW_LIMIT : 0,
        row ? undefined : SHOP_OPTIONS_ROW_LIMIT,
      );
      const sliceWidth = globalScene.scaledCanvas.width / (rowOptions.length + 2);
      const option = new ModifierOption(
        sliceWidth * (col + 1) + sliceWidth * 0.5,
        -globalScene.scaledCanvas.height / 2 - globalScene.game.canvas.height / 32 - (42 - (28 * row - 1)),
        shopTypeOptions[m],
      );
      option.setScale(0.375);
      globalScene.add.existing(option);
      this.modifierContainer.add(option);

      if (row >= this.shopOptionsRows.length) {
        this.shopOptionsRows.push([]);
      }
      this.shopOptionsRows[row].push(option);
    }

    const maxUpgradeCount = typeOptions.map(to => to.upgradeCount).reduce((max, current) => Math.max(current, max), 0);

    /* Force updateModifiers without pokemonSpecificModifiers */
    globalScene.getModifierBar().updateModifiers(globalScene.modifiers, true);

    globalScene.showShopOverlay(fixedInt(750));
    globalScene.updateAndShowText(750);
    globalScene.updateBiomeWaveText();
    globalScene.updateMoneyText();

    // DO NOT REMOVE: Fixes bug which allows action input to be processed before the UI is shown,
    // causing errors if reroll is selected
    this.awaitingActionInput = false;

    const { promise: tweenPromise, resolve: tweenResolve } = Promise.withResolvers<void>();
    let i = 0;

    // #region animation

    /** Holds promises that resolve once each reward's *upgrade animation* has finished playing */
    const rewardAnimPromises: Promise<void>[] = [];
    /** Holds promises that resolves once *all* animations for a reward have finished playing */
    const rewardAnimAllSettledPromises: Promise<void>[] = [];

    /*
     * A counter here is used instead of a loop to "stagger" the apperance of each reward,
     * using `sine.easeIn` to speed up the appearance of the rewards as each animation progresses.
     *
     * The `onComplete` callback for this tween is set to resolve once the upgrade animations
     * for each reward has finished playing, allowing for the next set of animations to
     * start to appear.
     */
    globalScene.tweens.addCounter({
      ease: "Sine.easeIn",
      duration: 1250,
      onUpdate: t => {
        // The bang here is safe, as `getValue()` only returns null if the tween has been destroyed (which obviously isn't the case inside onUpdate)
        const value = t.getValue()!;
        const index = Math.floor(value * typeOptions.length);
        while (index > i && index <= typeOptions.length) {
          const option = this.options[i];
          if (option) {
            rewardAnimPromises.push(
              option.show(
                Math.floor((1 - value) * 1250) * 0.325 + 2000 * maxUpgradeCount,
                -(maxUpgradeCount - typeOptions[i].upgradeCount),
                rewardAnimAllSettledPromises,
              ),
            );
          }
          i++;
        }
      },
      onComplete: () => {
        Promise.allSettled(rewardAnimPromises).then(() => tweenResolve());
      },
    });

    /** Holds promises that resolve once each shop item has finished animating */
    const shopAnimPromises: Promise<void>[] = [];
    globalScene.time.delayedCall(1000 + maxUpgradeCount * 2000, () => {
      for (const shopOption of this.shopOptionsRows.flat()) {
        // It is safe to skip awaiting the `show` method here,
        // as the promise it returns is also part of the promise appended to `shopAnimPromises`,
        // which is awaited later on.
        shopOption.show(0, 0, shopAnimPromises, false);
      }
    });

    tweenPromise.then(() => {
      globalScene.time.delayedCall(500, () => {
        if (getCoopSession() !== null && !this.active) {
          // Co-op (D20): the screen was left while it was opening (the partner went away, a reload): it does not draw itself again
          // over the waiting screen
          return;
        }
        if (partyHasHeldItem) {
          this.transferButtonContainer.setAlpha(0);
          this.transferButtonContainer.setVisible(true);
          globalScene.tweens.add({
            targets: this.transferButtonContainer,
            alpha: 1,
            duration: 250,
          });
        }

        if (this.showTradeButton) {
          this.tradeButtonContainer.setAlpha(0);
          this.tradeButtonContainer.setVisible(true);
          globalScene.tweens.add({ targets: this.tradeButtonContainer, alpha: 1, duration: 250 });
        }

        this.rerollButtonContainer.setAlpha(0);
        this.checkButtonContainer.setAlpha(0);
        this.lockRarityButtonContainer.setAlpha(0);
        this.continueButtonContainer.setAlpha(0);
        this.rerollButtonContainer.setVisible(true);
        this.checkButtonContainer.setVisible(true);
        this.continueButtonContainer.setVisible(this.rerollCost < 0);
        this.lockRarityButtonContainer.setVisible(canLockRarities);

        globalScene.tweens.add({
          targets: [this.checkButtonContainer, this.continueButtonContainer],
          alpha: 1,
          duration: 250,
        });

        globalScene.tweens.add({
          targets: [this.rerollButtonContainer, this.lockRarityButtonContainer],
          alpha: this.rerollCost < 0 || this.coopReadOnly ? 0.5 : 1,
          duration: 250,
        });

        // Ensure that the reward animations have completed before allowing input to proceed.
        // Required to ensure that the user cannot interact with the UI before the animations
        // have completed, (which, among other things, would allow the GameObjects to be destroyed
        // before the animations have completed, causing errors).
        Promise.allSettled([...shopAnimPromises, ...rewardAnimAllSettledPromises]).then(() => {
          if (getCoopSession() !== null && !this.active) {
            return;
          }
          const updateCursorTarget = () => {
            if (settings.display.shopCursorTarget === ShopCursorTarget.CHECK_TEAM) {
              this.setRowCursor(0);
              this.setCursor(2);
            } else if (
              settings.display.shopCursorTarget === ShopCursorTarget.SHOP
              && (!hasShop || this.shopOptionsRows.length === 0)
            ) {
              // No shop row exists to point at (e.g. the mode has no shop, or this is a
              // boss/Gym wave where no shop items are offered). Fall back to the rewards row
              // instead of leaving the cursor on a nonexistent shop row, which would crash.
              this.setRowCursor(ShopCursorTarget.REWARDS);
              this.setCursor(0);
            } else {
              this.setRowCursor(settings.display.shopCursorTarget);
              this.setCursor(0);
            }
          };

          updateCursorTarget();

          handleTutorial(Tutorial.SELECT_ITEM).then(res => {
            if (res) {
              updateCursorTarget();
            }
            this.awaitingActionInput = true;
            this.onActionInput = args[2];
            // Co-op (D16): where the partner's cursor is
            getCosmeticView()?.drawCursor();
          });
        });
      });
    });

    // #endregion animation

    return true;
  }

  processInput(button: Button): boolean {
    const ui = this.getUi();

    if (!this.awaitingActionInput) {
      return false;
    }

    let success = false;

    if (button === Button.ACTION) {
      success = true;
      if (this.onActionInput) {
        const originalOnActionInput = this.onActionInput;
        this.awaitingActionInput = false;
        this.onActionInput = null;
        if (originalOnActionInput(this.rowCursor, this.cursor)) {
          this.moveInfoOverlayActive = this.moveInfoOverlay.active;
          this.moveInfoOverlay.setVisible(false);
          this.moveInfoOverlay.active = false; // this is likely unnecessary, but it should help future prove the UI
        } else {
          this.awaitingActionInput = true;
          this.onActionInput = originalOnActionInput;
        }
      }
    } else if (button === Button.CANCEL) {
      if (this.player) {
        success = true;
        if (this.onActionInput) {
          const originalOnActionInput = this.onActionInput;
          this.awaitingActionInput = false;
          this.onActionInput = null;
          // TODO: What is a good fallback to pass to this?
          originalOnActionInput(-1, -1);
          this.moveInfoOverlayActive = this.moveInfoOverlay.active;
          this.moveInfoOverlay.setVisible(false);
          this.moveInfoOverlay.active = false; // don't clear here as we might need to restore the UI in case the user cancels the action
        }
      }
    } else {
      switch (button) {
        case Button.UP:
          if (this.rowCursor === 0 && this.cursor === 3) {
            success = this.setCursor(0);
          } else if (this.rowCursor < this.shopOptionsRows.length + 1) {
            success = this.setRowCursor(this.rowCursor + 1);
          } else {
            success = this.setRowCursor(0);
          }
          break;
        case Button.DOWN:
          if (this.rowCursor) {
            success = this.setRowCursor(this.rowCursor - 1);
          } else if (this.lockRarityButtonContainer.visible && this.cursor === 0) {
            success = this.setCursor(3);
          } else {
            success = this.setRowCursor(this.shopOptionsRows.length + 1);
          }
          break;
        case Button.LEFT:
          if (!this.rowCursor) {
            switch (this.cursor) {
              case 0:
                success = this.setCursor(2);
                break;
              case 1:
                if (this.tradeButtonContainer.visible) {
                  success = this.setCursor(TRADE_CURSOR);
                } else if (this.lockRarityButtonContainer.visible) {
                  success = this.setCursor(3);
                } else {
                  success = this.rerollButtonContainer.visible && this.setCursor(0);
                }
                break;
              case 2:
                if (this.transferButtonContainer.visible) {
                  success = this.setCursor(1);
                } else if (this.tradeButtonContainer.visible) {
                  success = this.setCursor(TRADE_CURSOR);
                } else if (this.rerollButtonContainer.visible) {
                  success = this.setCursor(0);
                } else {
                  success = false;
                }
                break;
              case 3:
                if (this.lockRarityButtonContainer.visible) {
                  success = this.setCursor(2);
                } else {
                  success = false;
                }
                break;
              case TRADE_CURSOR:
                if (this.lockRarityButtonContainer.visible) {
                  success = this.setCursor(3);
                } else {
                  success = this.rerollButtonContainer.visible && this.setCursor(0);
                }
                break;
            }
          } else if (this.cursor) {
            success = this.setCursor(this.cursor - 1);
          } else if (this.rowCursor === 1 && this.options.length === 0) {
            success = false;
          } else {
            success = this.setCursor(this.getRowItems(this.rowCursor) - 1);
          }
          break;
        case Button.RIGHT:
          if (!this.rowCursor) {
            switch (this.cursor) {
              case 0:
              case 3:
                if (this.tradeButtonContainer.visible) {
                  success = this.setCursor(TRADE_CURSOR);
                } else if (this.transferButtonContainer.visible) {
                  success = this.setCursor(1);
                } else {
                  success = this.setCursor(2);
                }
                break;
              case 1:
                success = this.setCursor(2);
                break;
              case 2:
                success = this.setCursor(0);
                break;
              case TRADE_CURSOR:
                success = this.setCursor(this.transferButtonContainer.visible ? 1 : 2);
                break;
            }
          } else if (this.cursor < this.getRowItems(this.rowCursor) - 1) {
            success = this.setCursor(this.cursor + 1);
          } else if (this.rowCursor === 1 && this.options.length === 0) {
            success = this.setRowCursor(0);
          } else {
            success = this.setCursor(0);
          }
          break;
      }
    }

    if (success) {
      ui.playSelect();
    }

    return success;
  }

  setCursor(cursor: number): boolean {
    const ui = this.getUi();
    const ret = super.setCursor(cursor);

    if (!this.cursorObj) {
      this.cursorObj = globalScene.add.image(0, 0, "cursor");
      this.modifierContainer.add(this.cursorObj);
    }

    const options = this.rowCursor === 1 ? this.options : this.shopOptionsRows.at(-(this.rowCursor - 1))!;

    this.cursorObj.setScale(this.rowCursor === 1 ? 2 : this.rowCursor >= 2 ? 1.5 : 1);

    // the modifier selection has been updated, always hide the overlay
    this.moveInfoOverlay.clear();
    if (this.rowCursor) {
      if (this.rowCursor === 1 && options.length === 0) {
        // Continue button when no shop items
        this.cursorObj.setScale(1.25);
        this.cursorObj.setPosition(
          globalScene.scaledCanvas.width / 3 + 23,
          -globalScene.scaledCanvas.height / 2
            - (this.shopOptionsRows.length > 1 ? SINGLE_SHOP_ROW_YOFFSET - 2 : DOUBLE_SHOP_ROW_YOFFSET - 2),
        );
        ui.showText(i18next.t("modifierSelectUiHandler:continueNextWaveDescription"));
        return ret;
      }

      const sliceWidth = globalScene.scaledCanvas.width / (options.length + 2);
      if (this.rowCursor < 2) {
        // Cursor on free items
        this.cursorObj.setPosition(
          sliceWidth * (cursor + 1) + sliceWidth * 0.5 - 20,
          -globalScene.scaledCanvas.height / 2
            - (this.shopOptionsRows.length > 1 ? SINGLE_SHOP_ROW_YOFFSET - 2 : DOUBLE_SHOP_ROW_YOFFSET - 2),
        );
      } else {
        // Cursor on paying items
        this.cursorObj.setPosition(
          sliceWidth * (cursor + 1) + sliceWidth * 0.5 - 16,
          -globalScene.scaledCanvas.height / 2
            - globalScene.game.canvas.height / 32
            - (-14 + 28 * (this.rowCursor - (this.shopOptionsRows.length - 1))),
        );
      }

      const type = options[this.cursor].modifierTypeOption.type;
      if (type) {
        const messageHandler = ui.getMessageHandler();
        ui.showText(type.getDescription());

        const cost = options[this.cursor].modifierTypeOption.cost;
        if (cost > 0) {
          const formattedMoney = formatMoney(settings.display.moneyFormat, cost);
          const costStyleName = cost <= globalScene.money ? "MONEY" : "PARTY_RED";
          const costText = i18next.t("modifierSelectUiHandler:itemCost", { formattedMoney });
          const nameWithCost = `${type.name}\u00A0\u00A0\u00A0@[${costStyleName}]{${costText}}`;
          messageHandler.showNameText(getTextWithColors(nameWithCost, TextStyle.MESSAGE, true), type.iconImage);
        } else {
          messageHandler.showNameText(type.name, type.iconImage);
        }

        if (type instanceof TmModifierType) {
          // prepare the move overlay to be shown with the toggle
          this.moveInfoOverlay.show(allMoves[type.moveId]);
        }
      }
    } else if (cursor === 0) {
      this.cursorObj.setPosition(
        6,
        this.lockRarityButtonContainer.visible ? OPTION_BUTTON_YPOSITION - 11 : OPTION_BUTTON_YPOSITION + 1,
      );
      ui.showText(i18next.t("modifierSelectUiHandler:rerollDesc"));
    } else if (cursor === 1) {
      this.cursorObj.setPosition(
        (globalScene.game.canvas.width - this.transferButtonWidth - this.checkButtonWidth) / 6 - 30,
        OPTION_BUTTON_YPOSITION + 1,
      );
      ui.showText(i18next.t("modifierSelectUiHandler:manageItemsDesc"));
    } else if (cursor === 2) {
      this.cursorObj.setPosition(
        (globalScene.game.canvas.width - this.checkButtonWidth) / 6 - 10,
        OPTION_BUTTON_YPOSITION + 1,
      );
      ui.showText(i18next.t("modifierSelectUiHandler:checkTeamDesc"));
    } else if (cursor === TRADE_CURSOR) {
      this.cursorObj.setPosition(this.getCursorSpot(0, TRADE_CURSOR)!.x, OPTION_BUTTON_YPOSITION + 1);
      ui.showText(
        coopText("tradeDesc", "Ask {{partner}} for a trade after this screen.", {
          partner: getCoopSession()?.partnerName ?? "",
        }),
      );
    } else {
      this.cursorObj.setPosition(6, OPTION_BUTTON_YPOSITION + 1);
      ui.showText(i18next.t("modifierSelectUiHandler:lockRaritiesDesc"));
    }

    // Co-op (D16): the partner sees where the cursor is
    const session = getCoopSession();
    if (session?.link != null && cursor >= 0) {
      sendCursor(session.rewardPickCount - 1, this.rowCursor, cursor);
    }

    return ret;
  }

  setRowCursor(rowCursor: number): boolean {
    const lastRowCursor = this.rowCursor;

    if (rowCursor !== lastRowCursor) {
      this.rowCursor = rowCursor;
      let newCursor = Math.round(
        (this.cursor / Math.max(this.getRowItems(lastRowCursor) - 1, 1)) * (this.getRowItems(rowCursor) - 1),
      );
      if (rowCursor === 1 && this.options.length === 0) {
        // Handle empty shop
        newCursor = 0;
      }
      if (rowCursor === 0) {
        if (this.options.length === 0) {
          newCursor = 1;
        }
        if (newCursor === 0 && !this.rerollButtonContainer.visible) {
          newCursor = 1;
        }
        if (newCursor === 1 && !this.transferButtonContainer.visible) {
          newCursor = 2;
        }
      }
      // Allows to find lock rarity button when looping from the top
      if (rowCursor === 0 && lastRowCursor > 1 && newCursor === 0 && this.lockRarityButtonContainer.visible) {
        newCursor = 3;
      }
      // Allows to loop to top when lock rarity button is shown
      if (rowCursor === this.shopOptionsRows.length + 1 && lastRowCursor === 0 && this.cursor === 3) {
        newCursor = 0;
      }
      this.cursor = -1;
      this.setCursor(newCursor);
      return true;
    }

    return false;
  }

  private getRowItems(rowCursor: number): number {
    switch (rowCursor) {
      case 0:
        return 3;
      case 1:
        return this.options.length;
      default:
        return this.shopOptionsRows.at(-(rowCursor - 1))!.length;
    }
  }

  setRerollCost(rerollCost: number): void {
    this.rerollCost = rerollCost;
  }

  updateCostText(): void {
    const shopOptions = this.shopOptionsRows.flat();
    for (const shopOption of shopOptions) {
      shopOption.updateCostText();
    }

    this.updateRerollCostText();
  }

  updateRerollCostText(): void {
    const rerollDisabled = this.rerollCost < 0;
    if (rerollDisabled) {
      this.rerollCostText.setVisible(false);
      return;
    }
    this.rerollCostText.setVisible(true);
    const canReroll = globalScene.money >= this.rerollCost;

    const formattedMoney = formatMoney(settings.display.moneyFormat, this.rerollCost);

    this.rerollCostText.setText(i18next.t("modifierSelectUiHandler:rerollCost", { formattedMoney }));
    this.rerollCostText.setColor(getTextColor(canReroll ? TextStyle.MONEY : TextStyle.PARTY_RED));
    this.rerollCostText.setShadowColor(getTextColor(canReroll ? TextStyle.MONEY : TextStyle.PARTY_RED, true));
  }

  updateLockRaritiesText(): void {
    const textStyle = globalScene.lockModifierTiers ? TextStyle.SUMMARY_BLUE : TextStyle.PARTY;
    this.lockRarityButtonText.setColor(getTextColor(textStyle));
    this.lockRarityButtonText.setShadowColor(getTextColor(textStyle, true));
  }

  clear() {
    super.clear();

    this.coopLabel.setVisible(false);
    this.moveInfoOverlay.clear();
    this.moveInfoOverlayActive = false;
    this.awaitingActionInput = false;
    this.onActionInput = null;
    this.getUi().clearText();
    this.getUi().getMessageHandler().hideNameText();
    this.eraseCursor();
    this.erasePartnerCursor();

    // Reset cursor positions
    this.cursor = 0;
    this.rowCursor = 0;

    globalScene.hideShopOverlay(fixedInt(750));
    globalScene.hideLuckText(250);

    /* Normally already called just after the shop, but not sure if it happens in 100% of cases */
    globalScene.getModifierBar().updateModifiers(globalScene.modifiers);

    const options = this.options.concat(this.shopOptionsRows.flat());
    this.options.splice(0, this.options.length);
    this.shopOptionsRows.splice(0, this.shopOptionsRows.length);

    globalScene.tweens.add({
      targets: options,
      scale: 0.01,
      duration: 250,
      ease: "Cubic.easeIn",
      onComplete: () => {
        options.forEach(o => {
          o.destroy();
        });
      },
    });

    [
      this.rerollButtonContainer,
      this.checkButtonContainer,
      this.transferButtonContainer,
      this.tradeButtonContainer,
      this.lockRarityButtonContainer,
      this.continueButtonContainer,
    ].forEach(container => {
      if (container.visible) {
        globalScene.tweens.add({
          targets: container,
          alpha: 0,
          duration: 250,
          ease: "Cubic.easeIn",
          onComplete: () => {
            if (this.options.length === 0) {
              container.setVisible(false);
            } else {
              container.setAlpha(1);
            }
          },
        });
      }
    });
  }

  eraseCursor() {
    if (this.cursorObj) {
      this.cursorObj.destroy();
    }
    this.cursorObj = null;
  }

  // #region Co-op (D11, D16)

  /** The line that says who is choosing, on the screen of the player who is not (D9, D17); `null` takes it away */
  public setCoopLabel(text: string | null): void {
    this.coopLabel.setText(text ?? "").setVisible(text !== null);
    this.modifierContainer.bringToTop(this.coopLabel);
  }

  /** Co-op (D17): the player took over the screen, so the picker's buttons are theirs now */
  public setCoopReadOnly(readOnly: boolean): void {
    this.coopReadOnly = readOnly;
    for (const button of [this.rerollButtonContainer, this.lockRarityButtonContainer]) {
      if (button.visible) {
        button.setAlpha(this.rerollCost < 0 || readOnly ? 0.5 : 1);
      }
    }
  }

  /** @returns The line that is shown now (empty if none) */
  public getCoopLabel(): string {
    return this.coopLabel.visible ? this.coopLabel.text : "";
  }

  /** The Trade button says whether a trade was asked for already */
  public setTradeRequested(requested: boolean): void {
    this.tradeButtonText.setText(requested ? coopText("tradeAsked", "Trade ✓") : coopText("trade", "Trade"));
    const style = requested ? TextStyle.SUMMARY_BLUE : TextStyle.PARTY;
    this.tradeButtonText.setColor(getTextColor(style));
    this.tradeButtonText.setShadowColor(getTextColor(style, true));
  }

  /** @returns Whether the cursor is on the Trade button */
  public isOnTradeButton(): boolean {
    return this.rowCursor === 0 && this.cursor === TRADE_CURSOR && this.tradeButtonContainer.visible;
  }

  /** @returns What the cursor points at, for a ping (D16); `null` if it is on a button */
  public getPingTarget(): CosmeticTarget | null {
    if (this.rowCursor === 1) {
      return this.options.length > 0 ? { k: "reward", index: this.cursor } : null;
    }
    if (this.rowCursor >= 2) {
      const rowIndex = this.shopOptionsRows.length - (this.rowCursor - 1);
      return rowIndex >= 0 ? { k: "shop", index: rowIndex * SHOP_OPTIONS_ROW_LIMIT + this.cursor } : null;
    }
    return null;
  }

  /** Where a cursor on `row` and `cursor` is drawn; the same places as {@linkcode setCursor} puts it */
  private getCursorSpot(row: number, cursor: number): { x: number; y: number; scale: number } | null {
    const { scaledCanvas, game } = globalScene;
    if (row === 0) {
      switch (cursor) {
        case 0:
          return {
            x: 6,
            y: this.lockRarityButtonContainer.visible ? OPTION_BUTTON_YPOSITION - 11 : OPTION_BUTTON_YPOSITION + 1,
            scale: 1,
          };
        case 1:
          return {
            x: (game.canvas.width - this.transferButtonWidth - this.checkButtonWidth) / 6 - 30,
            y: OPTION_BUTTON_YPOSITION + 1,
            scale: 1,
          };
        case 2:
          return { x: (game.canvas.width - this.checkButtonWidth) / 6 - 10, y: OPTION_BUTTON_YPOSITION + 1, scale: 1 };
        case 3:
          return { x: 6, y: OPTION_BUTTON_YPOSITION + 1, scale: 1 };
        case TRADE_CURSOR:
          return {
            x: (game.canvas.width - this.checkButtonWidth - this.transferButtonWidth - this.tradeButtonWidth) / 6 - 42,
            y: OPTION_BUTTON_YPOSITION + 1,
            scale: 1,
          };
        default:
          return null;
      }
    }
    const options = row === 1 ? this.options : this.shopOptionsRows.at(-(row - 1));
    if (options === undefined || cursor >= options.length) {
      return null;
    }
    const sliceWidth = scaledCanvas.width / (options.length + 2);
    if (row < 2) {
      return {
        x: sliceWidth * (cursor + 1) + sliceWidth * 0.5 - 20,
        y:
          -scaledCanvas.height / 2
          - (this.shopOptionsRows.length > 1 ? SINGLE_SHOP_ROW_YOFFSET - 2 : DOUBLE_SHOP_ROW_YOFFSET - 2),
        scale: 2,
      };
    }
    return {
      x: sliceWidth * (cursor + 1) + sliceWidth * 0.5 - 16,
      y: -scaledCanvas.height / 2 - game.canvas.height / 32 - (-14 + 28 * (row - (this.shopOptionsRows.length - 1))),
      scale: 1.5,
    };
  }

  /**
   * Show where the partner's cursor is (D16): a cursor in the partner's color. On an item it points from the other side, so
   * that it does not hide this player's own cursor when both are on the same item.
   * @param row - `null` to take it away
   */
  public setPartnerCursor(row: number | null, cursor = 0): void {
    this.partnerTarget?.setPartnerTint(null);
    this.partnerTarget = null;
    const spot = row === null ? null : this.getCursorSpot(row, cursor);
    if (row === null || spot === null) {
      this.partnerCursorObj?.setVisible(false);
      return;
    }
    if (this.partnerCursorObj === null) {
      this.partnerCursorObj = globalScene.add.image(0, 0, "cursor");
      this.partnerCursorObj.setTint(PARTNER_TINT);
      this.modifierContainer.add(this.partnerCursorObj);
    }
    // The own cursor is left of an item, 20 (rewards) or 16 (shop) units from its middle: the partner's mirrors it
    const mirror = row === 1 ? 40 : row > 1 ? 32 : 0;
    this.partnerCursorObj
      .setVisible(true)
      // a negative width mirrors the cursor around its middle
      .setScale(mirror > 0 ? -spot.scale : spot.scale, spot.scale)
      .setPosition(spot.x + mirror, spot.y);
  }

  /**
   * The partner pinged an option (D16): it lights up for a moment, with a short text above it
   * @param text - What the bubble says, with the partner's name
   */
  public pingOption(shop: boolean, index: number, text: string): void {
    const option = shop ? this.shopOptionsRows.flat()[index] : this.options[index];
    if (option === undefined) {
      return;
    }
    option.setPartnerTint(PARTNER_TINT);
    // Right above a reward's icon; a shop item has its name and price under the icon, so the bubble goes under them
    const bubble = addTextObject(option.x, option.y + (shop ? 18 : -11), text, TextStyle.BATTLE_INFO, {
      color: "#8fd3ff",
      backgroundColor: "#000000b0",
      padding: { x: 2, y: 1 },
    });
    bubble.setOrigin(0.5, shop ? 0 : 1);
    this.modifierContainer.add(bubble);
    globalScene.time.delayedCall(2500, () => {
      bubble.destroy();
      if (this.partnerTarget !== option) {
        option.setPartnerTint(null);
      }
    });
  }

  private erasePartnerCursor(): void {
    this.partnerTarget = null;
    this.partnerCursorObj?.destroy();
    this.partnerCursorObj = null;
  }

  // #endregion
}

class ModifierOption extends Phaser.GameObjects.Container {
  public modifierTypeOption: ModifierTypeOption;
  private pb: Phaser.GameObjects.Sprite;
  private pbTint: Phaser.GameObjects.Sprite;
  private itemContainer: Phaser.GameObjects.Container;
  private item: Phaser.GameObjects.Sprite;
  private itemTint: Phaser.GameObjects.Sprite;
  private itemText: Phaser.GameObjects.Text;
  private itemCostText: Phaser.GameObjects.Text;

  constructor(x: number, y: number, modifierTypeOption: ModifierTypeOption) {
    super(globalScene, x, y);

    this.modifierTypeOption = modifierTypeOption;

    this.setup();
  }

  /** Co-op (D16): a tint on the item, for what the partner's cursor or ping is on; `null` takes it off */
  public setPartnerTint(tint: number | null): void {
    if (tint === null) {
      this.item?.clearTint();
    } else {
      this.item?.setTint(tint);
    }
  }

  setup() {
    if (!this.modifierTypeOption.cost) {
      const getPb = (): Phaser.GameObjects.Sprite => {
        const pb = globalScene.add.sprite(0, -182, "pb", this.getPbAtlasKey(-this.modifierTypeOption.upgradeCount));
        pb.setScale(2);
        return pb;
      };

      this.pb = getPb();
      this.add(this.pb);

      this.pbTint = getPb();
      this.pbTint.setVisible(false);
      this.add(this.pbTint);
    }

    this.itemContainer = globalScene.add.container(0, 0);
    this.itemContainer.setScale(0.5);
    this.itemContainer.setAlpha(0);
    this.add(this.itemContainer);

    const getItem = () => {
      const item = globalScene.add.sprite(0, 0, "items", this.modifierTypeOption.type?.iconImage);
      return item;
    };

    this.item = getItem();
    this.itemContainer.add(this.item);

    if (!this.modifierTypeOption.cost) {
      this.itemTint = getItem();
      this.itemTint.setTintFill(Phaser.Display.Color.GetColor(255, 192, 255));
      this.itemContainer.add(this.itemTint);
    }

    this.itemText = addTextObject(0, 35, this.modifierTypeOption.type?.name!, TextStyle.PARTY, { align: "center" }); // TODO: is this bang correct?
    this.itemText.setOrigin(0.5, 0);
    this.itemText.setAlpha(0);
    this.itemText.setTint(
      this.modifierTypeOption.type?.tier ? getModifierTierTextTint(this.modifierTypeOption.type?.tier) : undefined,
    );
    this.add(this.itemText);

    if (this.modifierTypeOption.cost) {
      this.itemCostText = addTextObject(0, 45, "", TextStyle.MONEY, {
        align: "center",
      });

      this.itemCostText.setOrigin(0.5, 0);
      this.itemCostText.setAlpha(0);
      this.add(this.itemCostText);

      this.updateCostText();
    }
  }

  /**
   * Start the tweens responsible for animating the option's appearance
   *
   * @privateRemarks
   * This method is unusual. It "returns" (one via the actual return, one by via appending to the `promiseHolder`
   * parameter) two promises. The promise returned by the method resolves once the option's appearance animations have
   * completed, and is meant to allow callers to synchronize with the completion of the option's appearance animations.
   * The promise appended to `promiseHolder` resolves once *all* animations started by this method have completed,
   * and should be used by callers to ensure that all animations have completed before proceeding.
   *
   * @param remainingDuration - The duration in milliseconds that the animation can play for
   * @param upgradeCountOffset - The offset to apply to the upgrade count for options whose rarity is being upgraded
   * @param promiseHolder - A promise that resolves once all tweens started by this method have completed will be pushed to this array.
   * @param isReward - Whether the option being shown is a reward, meaning it should show pokeball and upgrade animations.
   * @returns A promise that resolves once the *option's apperance animations* have completed. This promise will resolve _before_ all
   *   promises that are initiated in this method complete. Instead, the `promiseHolder` array will contain a new promise
   *   that will resolve once all animations have completed.
   *
   */
  async show(
    remainingDuration: number,
    upgradeCountOffset: number,
    promiseHolder: Promise<void>[],
    isReward = true,
  ): Promise<void> {
    /** Promises for the pokeball and upgrade animations */
    const animPromises: Promise<void>[] = [];
    if (isReward) {
      const { promise: bouncePromise, resolve: resolveBounce } = Promise.withResolvers<void>();
      globalScene.tweens.add({
        targets: this.pb,
        y: 0,
        duration: 1250,
        ease: "Bounce.Out",
        onComplete: () => {
          resolveBounce();
        },
      });
      animPromises.push(bouncePromise);

      let lastValue = 1;
      let bounceCount = 0;
      let bounce = false;

      globalScene.tweens.addCounter({
        from: 1,
        to: 0,
        duration: 1250,
        ease: "Bounce.Out",
        onUpdate: t => {
          if (!globalScene) {
            return;
          }
          const value = t.getValue()!;
          if (!bounce && value > lastValue) {
            audioManager.playSound("se/pb_bounce_1", {
              volume: 1 / ++bounceCount,
            });
            bounce = true;
          } else if (bounce && value < lastValue) {
            bounce = false;
          }
          lastValue = value;
        },
      });

      // TODO: Figure out proper delay between chains and then convert this into a single tween chain
      // rather than starting multiple tween chains.

      for (let u = 0; u < this.modifierTypeOption.upgradeCount; u++) {
        const { resolve, promise } = Promise.withResolvers<void>();
        globalScene.tweens.chain({
          tweens: [
            {
              delay: remainingDuration - 2000 * (this.modifierTypeOption.upgradeCount - (u + 1 + upgradeCountOffset)),
              onStart: () => {
                audioManager.playSound("se/upgrade", {
                  rate: 1 + 0.25 * u,
                });
                this.pbTint.setPosition(this.pb.x, this.pb.y).setTintFill(0xffffff).setVisible(true).setAlpha(0);
              },
              targets: this.pbTint,
              alpha: 1,
              duration: 1000,
              ease: "Sine.easeIn",
              onComplete: () => {
                if (this.pb?.scene) {
                  this.pb.setTexture("pb", this.getPbAtlasKey(-this.modifierTypeOption.upgradeCount + (u + 1)));
                }
              },
            },
            {
              targets: this.pbTint,
              alpha: 0,
              duration: 750,
              ease: "Sine.easeOut",
              onComplete: () => {
                this.pbTint.setVisible(false);
                resolve();
              },
            },
          ],
        });
        animPromises.push(promise);
      }
    }

    const finalPromises: Promise<void>[] = [];
    globalScene.time.delayedCall(remainingDuration + 2000, () => {
      // The screen may have been left before the animation was done: the option is gone with it (a shop item has no Poké
      // Ball: only a reward's is checked)
      if (!this.scene || (isReward && !this.pb?.scene)) {
        return;
      }
      if (isReward) {
        this.pb.setTexture("pb", `${this.getPbAtlasKey(0)}_open`);
        audioManager.playSound("se/pb_rel");

        const { resolve: pbResolve, promise: pbPromise } = Promise.withResolvers<void>();

        globalScene.tweens.add({
          targets: this.pb,
          duration: 500,
          ease: "Sine.easeIn",
          alpha: 0,
          onComplete: () => {
            Promise.allSettled(animPromises).then(() => this.pb.destroy());
            pbResolve();
          },
        });
        finalPromises.push(pbPromise);
      }

      /** Delay for the rest of the tweens to ensure they show after the pokeball animation begins to appear */
      const delay = isReward ? 250 : 0;

      const { resolve: itemResolve, promise: itemPromise } = Promise.withResolvers<void>();
      globalScene.tweens.add({
        targets: this.itemContainer,
        delay,
        duration: 500,
        ease: "Elastic.Out",
        scale: 2,
        alpha: 1,
        onComplete: () => {
          itemResolve();
        },
      });
      finalPromises.push(itemPromise);

      if (isReward) {
        const { resolve: itemTintResolve, promise: itemTintPromise } = Promise.withResolvers<void>();
        globalScene.tweens.add({
          targets: this.itemTint,
          alpha: 0,
          delay,
          duration: 500,
          ease: "Sine.easeIn",
          onComplete: () => {
            this.itemTint.destroy();
            itemTintResolve();
          },
        });
        finalPromises.push(itemTintPromise);
      }

      const { resolve: itemTextResolve, promise: itemTextPromise } = Promise.withResolvers<void>();
      globalScene.tweens.add({
        targets: this.itemText,
        delay,
        duration: 500,
        alpha: 1,
        y: 25,
        ease: "Cubic.easeInOut",
        onComplete: () => itemTextResolve(),
      });
      finalPromises.push(itemTextPromise);

      if (this.itemCostText) {
        const { resolve: itemCostResolve, promise: itemCostPromise } = Promise.withResolvers<void>();
        globalScene.tweens.add({
          targets: this.itemCostText,
          delay,
          duration: 500,
          alpha: 1,
          y: 35,
          ease: "Cubic.easeInOut",
          onComplete: () => itemCostResolve(),
        });
        finalPromises.push(itemCostPromise);
      }
    });
    // The `.then` suppresses the return type for the Promise.allSettled so that it returns void.
    // TODO `finalPromises` is empty when it's spread here, so it isn't respected
    promiseHolder.push(Promise.allSettled([...animPromises, ...finalPromises]).then());

    await Promise.allSettled(animPromises);
  }

  getPbAtlasKey(tierOffset = 0) {
    return getPokeballAtlasKey((this.modifierTypeOption.type?.tier! + tierOffset) as number as PokeballType); // TODO: is this bang correct?
  }

  updateCostText(): void {
    const cost = activeOverrides.WAIVE_ROLL_FEE_OVERRIDE ? 0 : this.modifierTypeOption.cost;
    const textStyle = cost <= globalScene.money ? TextStyle.MONEY : TextStyle.PARTY_RED;

    const formattedMoney = formatMoney(settings.display.moneyFormat, cost);

    this.itemCostText.setText(i18next.t("modifierSelectUiHandler:itemCost", { formattedMoney }));
    this.itemCostText.setColor(getTextColor(textStyle, false));
    this.itemCostText.setShadowColor(getTextColor(textStyle, true));
  }
}
