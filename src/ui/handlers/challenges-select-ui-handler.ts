import { globalScene } from "#app/global-scene";
import { takeCoopChallengePick } from "#coop/link/challenge-pick";
import type { Challenge } from "#data/challenge";
import { Button } from "#enums/buttons";
import { ChallengeCategory } from "#enums/challenge-category";
import { Challenges } from "#enums/challenges";
import { Color, ShadowColor } from "#enums/color";
import { TextStyle } from "#enums/text-style";
import {
  getDisplayBounds,
  type KeyedPointerRow,
  type PointerBounds,
  SyncedPointerHitAreas,
  unionBounds,
} from "#ui/pointer-hit-area-sync";
import { ensureCanvasContextMenuDisabled } from "#ui/pointer-hit-areas";
import { TabMenu } from "#ui/tab-menu";
import { addTextObject } from "#ui/text";
import { UiHandler } from "#ui/ui-handler";
import { addWindow } from "#ui/ui-theme";
import { getRibbonsToAward } from "#utils/challenge-utils";
import { getLocalizedSpriteKey } from "#utils/common";
import { addMask } from "#utils/mask-utils";
import { getRibbonKey, orderedRibbons } from "#utils/ribbon-utils";
import i18next from "i18next";
import Phaser from "phaser";
import type BBCodeText from "phaser4-rex-plugins/plugins/bbcodetext";

type ChallengeLabel = {
  label: Phaser.GameObjects.Text;
  value: Phaser.GameObjects.Text;
  leftArrow: Phaser.GameObjects.Image;
  rightArrow: Phaser.GameObjects.Image;
};

const MAX_ROWS_TO_DISPLAY = 6;

/** Handles all the UI for choosing optional challenges. */
export class GameChallengesUiHandler extends UiHandler {
  private challengesContainer: Phaser.GameObjects.Container;
  private valuesContainer: Phaser.GameObjects.Container;

  private scrollCursor: number;

  private optionsBg: Phaser.GameObjects.NineSlice;

  // private difficultyText: Phaser.GameObjects.Text;

  private descriptionText: BBCodeText;
  private descriptionScrollTween: Phaser.Tweens.Tween | null;
  private descriptionTextBaseY: number;
  private descriptionTextMaxHeight: number;
  private descriptionTextMaskRect: Phaser.GameObjects.Graphics | null;
  private homeKey: Phaser.Input.Keyboard.Key | undefined;

  private readonly challengeLabels: ChallengeLabel[] = [];
  private monoTypeValue: Phaser.GameObjects.Sprite;

  private cursorObj: Phaser.GameObjects.NineSlice | null;

  private startBg: Phaser.GameObjects.NineSlice;
  private startCursor: Phaser.GameObjects.NineSlice;
  private startText: Phaser.GameObjects.Text;
  private hasSelectedChallenge: boolean;

  private optionsWidth: number;

  private tabMenu: TabMenu;
  private resetIcon: Phaser.GameObjects.Sprite;
  private resetLabel: Phaser.GameObjects.Text;

  /** Pointer hit areas: tabs, reset, challenge rows and their values, start */
  private pointerHits: SyncedPointerHitAreas | null = null;
  /** Greater than 0 while a pointer callback runs; hit areas are then rebuilt after it, not under its feet */
  private pointerDispatchDepth = 0;
  private pointerRebuildQueued = false;

  private readonly challengeCategories: ChallengeCategory[] = Object.values(ChallengeCategory).filter(
    cat => cat !== ChallengeCategory.UNUSED,
  );

  public override setup(): void {
    const ui = this.getUi();
    const { width: canvasWidth, height: canvasHeight } = globalScene.scaledCanvas;

    this.homeKey = globalScene.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.HOME);
    this.homeKey?.on("up", this.onHomeDown, this);

    this.challengesContainer = globalScene.add //
      .container(0, -canvasHeight)
      .setName("challenges");

    this.challengesContainer.setInteractive(
      new Phaser.Geom.Rectangle(0, 0, canvasWidth, canvasHeight),
      Phaser.Geom.Rectangle.Contains,
    );

    const bgOverlay = globalScene.add
      .rectangle(0, 0, canvasWidth, canvasHeight, 0x424242, 0.8)
      .setName("rect-challenge-overlay")
      .setOrigin(0);
    this.challengesContainer.add(bgOverlay);

    // TODO: Change this back to /9 when adding in difficulty
    const headerBg = addWindow(0, 0, canvasWidth, 24) //
      .setName("window-header-bg")
      .setOrigin(0);

    const headerText = addTextObject(0, 0, i18next.t("challenges:title"), TextStyle.HEADER_LABEL)
      .setName("text-header")
      .setOrigin(0)
      .setPositionRelative(headerBg, 8, 4);

    const categoryNames = this.challengeCategories.map(cat => this.getCategoryName(cat));

    this.tabMenu = new TabMenu(0, headerBg.height, canvasWidth, categoryNames, _newIndex => {
      this.setCursor(0);
      this.setScrollCursor(0);
      this.initLabels();
      this.updateText();
    });

    const startBgHeight = 24;
    const contentY = headerBg.height + this.tabMenu.height;

    this.optionsWidth = canvasWidth * 0.6;
    this.optionsBg = addWindow(0, contentY, this.optionsWidth, canvasHeight - contentY - startBgHeight)
      .setName("window-options-bg")
      .setOrigin(0);

    const descriptionBg = addWindow(0, contentY, canvasWidth - this.optionsWidth, canvasHeight - contentY)
      .setName("window-desc-bg")
      .setOrigin(0)
      .setPositionRelative(this.optionsBg, this.optionsBg.width, 0);

    this.descriptionText = globalScene.add
      .rexBBCodeText(descriptionBg.x + 6, descriptionBg.y + 4, "", {
        fontFamily: "emerald",
        fontSize: 84,
        color: Color.ORANGE,
        padding: { bottom: 6 },
        wrap: { mode: "word", width: (descriptionBg.width - 12) * 6 },
      })
      .setName("text-desc")
      .setScale(1 / 6)
      .setShadow(4, 5, ShadowColor.ORANGE)
      .setOrigin(0);
    globalScene.add.existing(this.descriptionText);
    this.descriptionTextBaseY = this.descriptionText.y;
    this.descriptionTextMaxHeight = descriptionBg.height - 8;

    this.descriptionTextMaskRect = globalScene.make
      .graphics({})
      .setScale(6)
      .fillStyle(0xffffff)
      .beginPath()
      .fillRect(descriptionBg.x + 6, descriptionBg.y + 4, descriptionBg.width - 12, this.descriptionTextMaxHeight);
    addMask(this.descriptionText, this.descriptionTextMaskRect);
    this.descriptionText.once(Phaser.GameObjects.Events.DESTROY, () => this.descriptionTextMaskRect?.destroy());

    this.startBg = addWindow(0, 0, this.optionsWidth, startBgHeight)
      .setName("window-start-bg")
      .setOrigin(0)
      .setPositionRelative(this.optionsBg, 0, this.optionsBg.height);

    this.startText = addTextObject(0, 0, i18next.t("challenges:noneSelected"), TextStyle.SETTINGS_LABEL)
      .setName("text-start")
      .setOrigin(0);
    this.startText.setPositionRelative(this.startBg, (this.startBg.width - this.startText.displayWidth) / 2, 4);

    this.startCursor = globalScene.add
      .nineslice(0, 0, "summary_moves_cursor", undefined, this.optionsWidth - 8, 16, 1, 1, 1, 1)
      .setName("9s-start-cursor")
      .setOrigin(0)
      .setPositionRelative(this.startBg, 4, 4)
      .setVisible(false);

    const resetText = addTextObject(0, 0, i18next.t("settings:reset"), TextStyle.SETTINGS_LABEL);
    resetText.setOrigin(0, 0.15);

    const iconReset = globalScene.add.sprite(0, 0, "keyboard").setFrame("HOME.png");
    iconReset.setOrigin(0, -0.1);

    const resetGroupWidth = 26 + resetText.displayWidth;

    iconReset.setPositionRelative(headerBg, headerBg.width - resetGroupWidth - 8, 5);
    resetText.setPositionRelative(iconReset, 26, 0);
    this.resetIcon = iconReset;
    this.resetLabel = resetText;

    this.valuesContainer = globalScene.add //
      .container(0, 0)
      .setName("values");

    for (let i = 0; i < MAX_ROWS_TO_DISPLAY; i++) {
      const label = addTextObject(8, contentY + 4 + i * 16, "", TextStyle.SETTINGS_LABEL)
        .setName(`text-challenge-label-${i}`)
        .setOrigin(0);

      const leftArrow = globalScene.add
        .image(0, 0, "cursor_reverse")
        .setName(`challenge-left-arrow-${i}`)
        .setOrigin(0)
        .setVisible(false)
        .setScale(0.75);

      const rightArrow = globalScene.add
        .image(0, 0, "cursor")
        .setName(`challenge-right-arrow-${i}`)
        .setOrigin(0)
        .setScale(0.75)
        .setVisible(false);

      const value = addTextObject(0, contentY + 4 + i * 16, "", TextStyle.SETTINGS_LABEL)
        .setName(`challenge-value-text-${i}`)
        .setPositionRelative(label, 100, 0);

      this.valuesContainer.add([label, leftArrow, rightArrow, value]);

      this.challengeLabels[i] = { label, value, leftArrow, rightArrow };
    }

    this.monoTypeValue = globalScene.add
      .sprite(8, contentY + 74, getLocalizedSpriteKey("types"))
      .setName("challenge-value-monotype-sprite")
      .setScale(0.86)
      .setVisible(false);
    this.valuesContainer.add(this.monoTypeValue);

    this.challengesContainer.add([
      headerBg,
      headerText,
      this.tabMenu,
      // difficultyBg,
      // this.difficultyText,
      // difficultyName,
      this.optionsBg,
      descriptionBg,
      this.descriptionText,
      this.startBg,
      this.startText,
      this.startCursor,
      iconReset,
      resetText,
      this.valuesContainer,
    ]);

    ui.add(this.challengesContainer);

    this.setCursor(0);
    this.setScrollCursor(0);

    this.challengesContainer.setVisible(false);

    this.pointerHits = new SyncedPointerHitAreas(this.createPointerHitAreas(this.challengesContainer));
  }

  /**
   * Sets the description text, using orange for the text & shadow colors.
   * @param text - The text to set
   */
  private setDescription(text: string): void {
    this.descriptionText.setText(`[color=${Color.ORANGE}][shadow=${ShadowColor.ORANGE}]${text}`);
    this.updateDescriptionScroll();
  }

  private updateDescriptionScroll(): void {
    if (this.descriptionScrollTween) {
      this.descriptionScrollTween.remove();
      this.descriptionScrollTween = null;
    }

    this.descriptionText.setY(this.descriptionTextBaseY);
    const overflow = this.descriptionText.displayHeight - this.descriptionTextMaxHeight;
    if (overflow <= 0) {
      return;
    }

    this.descriptionScrollTween = globalScene.tweens.add({
      targets: this.descriptionText,
      delay: 3200,
      hold: 5000,
      repeatDelay: 3200,
      repeat: -1,
      yoyo: true,
      duration: Math.max(3200, overflow * 44),
      y: `-=${overflow}`,
    });
  }

  private getCategoryName(category: ChallengeCategory): string {
    const entry = Object.entries(ChallengeCategory).find(([, value]) => value === category);
    const key = entry ? entry[0].toLowerCase() : "misc";

    return i18next.t(`challenges:category.${key}`);
  }

  private getFilteredChallenges(): Challenge[] {
    const activeCategory = this.tabMenu
      ? this.challengeCategories[this.tabMenu.selectedIndex]
      : ChallengeCategory.DIFFICULTY;

    return globalScene.gameMode.challenges.filter(c => c.category === activeCategory);
  }

  private initLabels(): void {
    const challenges = this.getFilteredChallenges();

    if (challenges.length > 0) {
      this.setDescription(challenges[0].getDescription());
    } else {
      this.setDescription("");
    }

    for (let i = 0; i < MAX_ROWS_TO_DISPLAY; i++) {
      this.challengeLabels[i].label.setVisible(false);
      this.challengeLabels[i].value.setVisible(false);
      this.challengeLabels[i].leftArrow.setVisible(false);
      this.challengeLabels[i].rightArrow.setVisible(false);
    }

    for (let i = 0; i < Math.min(MAX_ROWS_TO_DISPLAY, challenges.length); i++) {
      this.challengeLabels[i].label.setVisible(true);
      this.challengeLabels[i].value.setVisible(true);
      this.challengeLabels[i].leftArrow.setVisible(true);
      this.challengeLabels[i].rightArrow.setVisible(true);
    }

    const tempText = addTextObject(0, 0, "", TextStyle.SETTINGS_LABEL);

    for (const challenge of challenges) {
      if (challenge.id === Challenges.SINGLE_TYPE) {
        continue;
      }
      const challengeName = challenge.name;
      tempText.setText(challengeName);
      let longestOptionNameWidth = 0;
      let longestOptionName = "";
      const challengeNameLength = Math.round(tempText.displayWidth);
      for (let cValue = 0; cValue <= challenge.maxValue; cValue++) {
        const cValueText = challenge.getValue(cValue);
        tempText.setText(cValueText);
        if (tempText.displayWidth > longestOptionNameWidth) {
          longestOptionNameWidth = Math.round(tempText.displayWidth);
          longestOptionName = cValueText;
        }
      }
      if (challengeNameLength + longestOptionNameWidth > 159) {
        console.warn(
          `Potential overlap between challenge "${challengeName}"'s name and its longest option "${longestOptionName}" detected!\n`
            + `Max combined width of 159 exceeded (total: ${challengeNameLength + longestOptionNameWidth})!\n`
            + `Challenge name display width: ${challengeNameLength} | Longest option name display width: ${longestOptionNameWidth}`,
        );
      }
    }
    tempText.destroy();
  }

  private updateText(): void {
    const challenges = this.getFilteredChallenges();

    /** Used to get the display width of the current option */
    const tempText = addTextObject(0, 0, "", TextStyle.SETTINGS_LABEL);

    if (challenges.length > 0) {
      this.setDescription(this.getActiveChallenge().getDescription());
    } else {
      this.setDescription("");
    }

    let monoTypeVisible = false;
    for (let i = 0; i < MAX_ROWS_TO_DISPLAY; i++) {
      const challenge = challenges[this.scrollCursor + i];
      const challengeLabel = this.challengeLabels[i];

      if (!challenge) {
        challengeLabel.label.setVisible(false);
        challengeLabel.value.setVisible(false);
        challengeLabel.leftArrow.setVisible(false);
        challengeLabel.rightArrow.setVisible(false);
        continue;
      }

      challengeLabel.label.setVisible(true);
      challengeLabel.rightArrow.setVisible(true);
      challengeLabel.leftArrow.setVisible(true);

      challengeLabel.label.setText(challenge.name);

      challengeLabel.rightArrow
        .setPositionRelative(challengeLabel.label, this.optionsBg.width - 20, 4)
        .setVisible(challenge.value !== challenge.maxValue);

      tempText.setText(challenge.getValue());
      // monotype challenge has a unique display and needs to be accounted for manually
      const leftArrowX = (challenge.id === Challenges.SINGLE_TYPE ? -30 : -Math.round(tempText.displayWidth)) - 10;
      challengeLabel.leftArrow
        .setPositionRelative(challengeLabel.rightArrow, leftArrowX, 0)
        .setVisible(challenge.value !== 0);

      // this line of code gets the center point between the left and right arrows from their left side
      // (`Arrow.x` gives middle point), taking into account the width of the arrows
      const optionX = Math.round(
        (challengeLabel.leftArrow.x + challengeLabel.rightArrow.x + challengeLabel.leftArrow.displayWidth) / 2,
      );
      if (challenge.id === Challenges.SINGLE_TYPE) {
        this.monoTypeValue
          .setX(optionX)
          .setY(challengeLabel.label.y + 8)
          .setFrame(challenge.getValue())
          .setVisible(true);
        challengeLabel.value.setVisible(false);
        monoTypeVisible = true;
      } else {
        challengeLabel.value //
          .setText(challenge.getValue())
          .setX(optionX)
          .setOrigin(0.5, 0)
          .setVisible(true);
      }
    }
    tempText.destroy();

    if (!monoTypeVisible) {
      this.monoTypeValue.setVisible(false);
    }

    this.hasSelectedChallenge = globalScene.gameMode.challenges.some(c => c.value !== 0);

    let i18nKey = "common:start";
    let alphaValue = 1;
    if (!this.hasSelectedChallenge) {
      i18nKey = "challenges:noneSelected";
      alphaValue = 0.5;
    }
    this.startText
      .setText(i18next.t(i18nKey))
      .setAlpha(alphaValue)
      .setPositionRelative(this.startBg, (this.startBg.width - this.startText.displayWidth) / 2, 4);

    this.updatePointerHitAreas();

    this.challengesContainer.update();
  }

  public override show(args: any[]): boolean {
    super.show(args);

    if (this.tabMenu) {
      this.tabMenu.setIndex(0);
      this.tabMenu.updateIcons();
    }

    this.startCursor.setVisible(false);
    this.updateChallengeArrowsTint(false);
    this.challengesContainer.setVisible(true);

    this.hasSelectedChallenge = globalScene.gameMode.challenges.some(c => c.value !== 0);

    this.setCursor(0);
    this.setScrollCursor(0);

    this.initLabels();
    this.updateText();

    this.getUi().moveTo(this.challengesContainer, this.getUi().length - 1);

    this.getUi().hideTooltip();

    ensureCanvasContextMenuDisabled();
    this.pointerHits?.manager.setWheelHandler(direction => this.runPointerAction(() => this.handleWheel(direction)));
    this.updatePointerHitAreas();

    return true;
  }

  private updateChallengeArrowsTint(tinted: boolean): void {
    const challenges = this.getFilteredChallenges();

    for (let i = 0; i < Math.min(MAX_ROWS_TO_DISPLAY, challenges.length); i++) {
      const challengeLabel = this.challengeLabels[i];
      if (tinted) {
        challengeLabel.leftArrow.setTint(0x808080);
        challengeLabel.rightArrow.setTint(0x808080);
      } else {
        challengeLabel.leftArrow.clearTint();
        challengeLabel.rightArrow.clearTint();
      }
    }
  }

  private setAwardedRibbons(): void {
    const awardedRibbonFlags = getRibbonsToAward();

    const text = i18next.t("ribbons:runAward").concat("\n");
    const labels: string[] = [];

    if (awardedRibbonFlags === 0n) {
      const label = i18next.t("ribbons:noRibbons");
      this.descriptionText.setText(`[color=${Color.ORANGE}][shadow=${ShadowColor.ORANGE}]${label}`);
      return;
    }

    for (const ribbon of orderedRibbons) {
      if (!(ribbon & awardedRibbonFlags)) {
        continue;
      }
      const label = i18next.t(`ribbons:name.${getRibbonKey(ribbon)}`);
      if (labels.length > 0) {
        labels.push(`${i18next.t("ribbons:connector")} `);
      }
      labels.push(label);
    }

    this.descriptionText.setText(`[color=${Color.ORANGE}][shadow=${ShadowColor.ORANGE}]${text.concat(...labels)}`);
  }

  private activateStartCursor(): void {
    this.startCursor.setVisible(true);
    this.cursorObj?.setVisible(false);
    this.updateChallengeArrowsTint(this.startCursor.visible);

    this.setAwardedRibbons();
  }

  private deactivateStartCursor(): void {
    this.startCursor.setVisible(false);
    this.cursorObj?.setVisible(true);
    this.updateChallengeArrowsTint(this.startCursor.visible);

    this.updateText();
  }

  private goToBottomOfChallengeList(): boolean {
    let success = false;
    const challenges = this.getFilteredChallenges();

    // When at the top of the menu and pressing UP, move to the bottommost item.
    if (challenges.length > MAX_ROWS_TO_DISPLAY) {
      // If there are more than `MAX_ROWS_TO_DISPLAY` challenges, scroll to the bottom
      // First, set the cursor to the last visible element, preparing for the scroll to the end.
      const successA = this.setCursor(MAX_ROWS_TO_DISPLAY - 1);
      // Then, adjust the scroll to display the bottommost elements of the menu.
      const successB = this.setScrollCursor(challenges.length - MAX_ROWS_TO_DISPLAY);
      success = successA && successB; // success is just there to play the little validation sound effect
    } else if (challenges.length > 0) {
      // If there are `MAX_ROWS_TO_DISPLAY` or less challenges, just move to the bottom one
      success = this.setCursor(challenges.length - 1);
    }

    return success;
  }

  /**
   * Processes input from a specified button.
   *
   * This method handles navigation through a UI menu,
   * including movement through menu item and handling special actions like cancellation. \
   * Each button press may adjust the cursor position or the menu scroll,
   * and plays a sound effect if the action was successful.
   *
   * @param button - The button pressed by the user.
   * @returns Whether the action associated with the button was successfully processed
   */
  public override processInput(button: Button): boolean {
    const ui = this.getUi();
    const { phaseManager } = globalScene;
    let success = false;

    if (button === Button.CANCEL) {
      if (this.startCursor.visible) {
        // If the user presses cancel when the start cursor has been activated,
        // the game deactivates the start cursor and allows typical challenge selection behavior
        this.deactivateStartCursor();
      } else {
        const coop = takeCoopChallengePick();
        if (coop === null) {
          phaseManager.toTitleScreen();
          phaseManager.getCurrentPhase().end();
        } else {
          // Co-op (D41): back to the mode question of Host a game
          coop.cancel();
        }
      }
      success = true;
    } else if (button === Button.CYCLE_FORM || button === Button.CYCLE_SHINY) {
      success = this.tabMenu.navigate(button);
    } else if (button === Button.SUBMIT || button === Button.ACTION) {
      if (this.hasSelectedChallenge) {
        if (this.startCursor.visible) {
          const coop = takeCoopChallengePick();
          if (coop === null) {
            phaseManager.unshiftNew("SelectStarterPhase");
            phaseManager.getCurrentPhase().end();
          } else {
            // Co-op (D41): the host hosts the game with these challenges; the starter select comes once linked
            coop.start();
          }
        } else {
          this.activateStartCursor();
        }
        success = true;
      } else {
        success = false;
      }
    } else if (this.cursorObj?.visible && !this.startCursor.visible) {
      const challenges = this.getFilteredChallenges();

      switch (button) {
        case Button.UP:
          if (this.cursor === 0) {
            if (this.scrollCursor === 0) {
              if (this.hasSelectedChallenge) {
                this.activateStartCursor();
                ui.playSelect();
                return true;
              }
              success = this.goToBottomOfChallengeList();
            } else {
              success = this.setScrollCursor(this.scrollCursor - 1);
            }
          } else {
            success = this.setCursor(this.cursor - 1);
          }
          if (success) {
            this.updateText();
          }
          break;
        case Button.DOWN:
          if (this.cursor === MAX_ROWS_TO_DISPLAY - 1) {
            if (this.scrollCursor < challenges.length - MAX_ROWS_TO_DISPLAY) {
              // When at the bottom and pressing DOWN, scroll if possible.
              success = this.setScrollCursor(this.scrollCursor + 1);
            } else if (this.hasSelectedChallenge) {
              this.activateStartCursor();
              ui.playSelect();
              return true;
            } else {
              // When at the bottom of a scrolling menu and pressing DOWN, move to the topmost item.
              // First, set the cursor to the first visible element, preparing for the scroll to the top.
              const successA = this.setCursor(0);
              // Then, adjust the scroll to display the topmost elements of the menu.
              const successB = this.setScrollCursor(0);
              success = successA && successB; // success is just there to play the little validation sound effect
            }
          } else if (challenges.length < MAX_ROWS_TO_DISPLAY && this.cursor >= challenges.length - 1) {
            // When at the bottom of a non-scrolling menu and pressing DOWN, move to the topmost item.
            if (this.hasSelectedChallenge) {
              this.activateStartCursor();
              ui.playSelect();
              return true;
            }
            success = this.setCursor(0);
          } else {
            success = this.setCursor(this.cursor + 1);
          }
          if (success) {
            this.updateText();
          }
          break;
        case Button.LEFT:
          if (challenges.length > 0) {
            success = this.getActiveChallenge().decreaseValue();
            if (success) {
              this.updateText();
            }
          }
          break;
        case Button.RIGHT:
          if (challenges.length > 0) {
            success = this.getActiveChallenge().increaseValue();
            if (success) {
              this.updateText();
            }
          }
          break;
      }
    } else if (button === Button.UP && this.startCursor.visible) {
      this.deactivateStartCursor();
      this.goToBottomOfChallengeList();
      success = true;
    } else if (button === Button.DOWN && this.startCursor.visible) {
      this.setScrollCursor(0);
      this.setCursor(0);
      this.deactivateStartCursor();
      success = true;
    }

    if (success) {
      ui.playSelect();
    }
    return success;
  }

  private onHomeDown(): void {
    if (!this.challengesContainer.visible) {
      return;
    }

    this.resetChallengesToDefault();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Pointer (mouse / touch) support
  // -------------------------------------------------------------------------------------------------------------------

  private canHandlePointer(): boolean {
    return this.isPointerInputEnabled() && this.challengesContainer.visible;
  }

  /**
   * Run a pointer callback. Hit areas that it asks to rebuild are rebuilt right after it, so the rectangle that is
   * dispatching the event is not destroyed from inside its own handler.
   */
  private runPointerAction(action: () => void): void {
    this.pointerDispatchDepth++;
    try {
      action();
    } finally {
      this.pointerDispatchDepth--;
    }
    if (this.pointerDispatchDepth === 0 && this.pointerRebuildQueued) {
      this.updatePointerHitAreas();
    }
  }

  /** The tab titles of the tab menu, in the coordinates of the challenges container. */
  private getTabBounds(): PointerBounds[] {
    // The tab menu holds its background first, then one text per tab, then the previous / next tab icons
    const count = this.challengeCategories.length;
    const titles = this.tabMenu.list.slice(1, 1 + count) as Phaser.GameObjects.Text[];
    if (titles.length !== count) {
      return [];
    }

    // Each tab reaches halfway to its neighbours, so that there are no gaps between tabs
    const gap = 4;
    return titles.map((title, i) => {
      const previous = titles[i - 1];
      const next = titles[i + 1];
      const left = previous ? (previous.x + previous.displayWidth + title.x) / 2 : title.x - gap;
      const right = next ? (title.x + title.displayWidth + next.x) / 2 : title.x + title.displayWidth + gap;
      return { x: this.tabMenu.x + left, y: this.tabMenu.y, width: right - left, height: this.tabMenu.height };
    });
  }

  /** The icons that cycle to the previous / next tab, in the coordinates of the challenges container. */
  private getTabArrowBounds(): { button: Button; bounds: PointerBounds }[] {
    const count = this.challengeCategories.length;
    const [previous, next] = this.tabMenu.list.slice(1 + count, 3 + count) as Phaser.GameObjects.Sprite[];
    const arrows: { button: Button; bounds: PointerBounds }[] = [];
    for (const [button, icon] of [
      [Button.CYCLE_FORM, previous],
      [Button.CYCLE_SHINY, next],
    ] as const) {
      // The icon is invisible (alpha 0) while no key icon is known for it
      if (icon && icon.alpha > 0) {
        const box = getDisplayBounds(icon);
        arrows.push({ button, bounds: { ...box, x: this.tabMenu.x + box.x, y: this.tabMenu.y + box.y } });
      }
    }
    return arrows;
  }

  /**
   * Bring all hit areas in line with the screen: tabs, reset, the challenge rows (hover selects, the left / right half of
   * the value decreases / increases it), the start button. Cheap to call often: unchanged areas are kept.
   */
  private updatePointerHitAreas(): void {
    if (!this.pointerHits) {
      return;
    }
    if (this.pointerDispatchDepth > 0) {
      this.pointerRebuildQueued = true;
      return;
    }
    this.pointerRebuildQueued = false;

    if (!this.active || !this.challengesContainer.visible) {
      this.pointerHits.clearRows();
      return;
    }

    const { width, height } = globalScene.scaledCanvas;
    const goBack = (): void => this.runPointerAction(() => this.handleCancelPointer());
    const rows: KeyedPointerRow[] = [];

    // The whole screen: a right click anywhere goes back (this screen's container is interactive over the whole screen,
    // so the global right click would never reach empty space).
    rows.push({ id: "bg", x: 0, y: 0, width, height, onRightClick: goBack });

    // Tabs: click selects the tab
    this.getTabBounds().forEach((bounds, index) => {
      rows.push({
        id: `tab:${index}`,
        ...bounds,
        onActivate: () => this.runPointerAction(() => this.handleTabPointerActivate(index)),
        onRightClick: goBack,
      });
    });
    for (const { button, bounds } of this.getTabArrowBounds()) {
      rows.push({
        id: `tabArrow:${button}`,
        ...bounds,
        onActivate: () => this.runPointerAction(() => this.handleTabArrowPointerActivate(button)),
        onRightClick: goBack,
      });
    }

    // Reset (the HOME key)
    rows.push({
      id: "reset",
      ...unionBounds(getDisplayBounds(this.resetIcon), getDisplayBounds(this.resetLabel)),
      onActivate: () => this.runPointerAction(() => this.handleResetPointerActivate()),
      onRightClick: goBack,
    });

    // Challenge rows
    const challenges = this.getFilteredChallenges();
    const rowX = this.optionsBg.x + 4;
    const rowWidth = this.optionsWidth - 8;
    for (let i = 0; i < Math.min(MAX_ROWS_TO_DISPLAY, challenges.length - this.scrollCursor); i++) {
      const row = i;
      const rowY = this.optionsBg.y + 4 + row * 16;
      const { leftArrow, rightArrow } = this.challengeLabels[row];
      const valueCenterX = Math.round((leftArrow.x + rightArrow.x + leftArrow.displayWidth) / 2);
      const leftEdge = leftArrow.x - 6;
      const rightEdge = rightArrow.x + rightArrow.displayWidth + 6;

      rows.push({
        id: `row:${row}`,
        x: rowX,
        y: rowY,
        width: rowWidth,
        height: 16,
        onHover: () => this.runPointerAction(() => this.handleRowPointerHover(row)),
        onActivate: () => this.runPointerAction(() => this.handleRowPointerActivate(row, null)),
        onRightClick: goBack,
      });
      // The value: its left half (and the left arrow) decreases it, its right half (and the right arrow) increases it
      rows.push({
        id: `row:${row}:decrease`,
        x: leftEdge,
        y: rowY,
        width: valueCenterX - leftEdge,
        height: 16,
        onActivate: () => this.runPointerAction(() => this.handleRowPointerActivate(row, Button.LEFT)),
        onRightClick: goBack,
      });
      rows.push({
        id: `row:${row}:increase`,
        x: valueCenterX,
        y: rowY,
        width: rightEdge - valueCenterX,
        height: 16,
        onActivate: () => this.runPointerAction(() => this.handleRowPointerActivate(row, Button.RIGHT)),
        onRightClick: goBack,
      });
    }

    // Start (the first click focuses it, the second one starts, as with the keyboard)
    rows.push({
      id: "start",
      x: this.startBg.x,
      y: this.startBg.y,
      width: this.startBg.displayWidth,
      height: this.startBg.displayHeight,
      onActivate: () => this.runPointerAction(() => this.handleStartPointerActivate()),
      onRightClick: goBack,
    });

    this.pointerHits.set(rows);
  }

  /** Click on a tab: cycle to it with the same previous / next tab keys. */
  private handleTabPointerActivate(index: number): void {
    if (!this.canHandlePointer()) {
      return;
    }
    const count = this.challengeCategories.length;
    const forward = (index - this.tabMenu.selectedIndex + count) % count;
    const backward = count - forward;
    const steps = Math.min(forward, backward);
    const button = forward <= backward ? Button.CYCLE_SHINY : Button.CYCLE_FORM;
    for (let step = 0; step < steps; step++) {
      this.processInput(button);
    }
  }

  /** Click on the previous / next tab icon: the previous / next tab key. */
  private handleTabArrowPointerActivate(button: Button): void {
    if (this.canHandlePointer()) {
      this.processInput(button);
    }
  }

  /** Click on reset: the HOME key. */
  private handleResetPointerActivate(): void {
    if (this.canHandlePointer()) {
      this.resetChallengesToDefault();
    }
  }

  /** Make a challenge row the selected one, as moving the cursor onto it with UP / DOWN would. */
  private selectRow(row: number): boolean {
    let changed = false;
    if (this.startCursor.visible) {
      this.deactivateStartCursor();
      changed = true;
    }
    if (this.cursor !== row || !this.cursorObj?.visible) {
      this.setCursor(row);
      changed = true;
    }
    if (changed) {
      this.updateText();
    }
    return changed;
  }

  private handleRowPointerHover(row: number): void {
    if (!this.canHandlePointer()) {
      return;
    }
    if (this.selectRow(row)) {
      this.getUi().playSelect();
    }
  }

  /**
   * Click on a challenge row: select it, and when the click was on the left / right half of the value, press LEFT / RIGHT
   * to change the value.
   */
  private handleRowPointerActivate(row: number, button: Button.LEFT | Button.RIGHT | null): void {
    if (!this.canHandlePointer()) {
      return;
    }
    const changed = this.selectRow(row);
    if (button !== null) {
      this.processInput(button);
    } else if (changed) {
      this.getUi().playSelect();
    }
  }

  /** Click on the start button: ACTION (focuses it; once focused, starts the run). */
  private handleStartPointerActivate(): void {
    if (this.canHandlePointer()) {
      this.processInput(Button.ACTION);
    }
  }

  /** Right click goes back: the keyboard CANCEL (leaves the start button, or returns to the title screen). */
  private handleCancelPointer(): void {
    if (this.canHandlePointer()) {
      this.processInput(Button.CANCEL);
    }
  }

  /** The mouse wheel moves through the challenges, like UP / DOWN. */
  private handleWheel(direction: -1 | 1): void {
    if (this.canHandlePointer()) {
      this.processInput(direction < 0 ? Button.UP : Button.DOWN);
    }
  }

  private resetChallengesToDefault(): void {
    for (const challenge of globalScene.gameMode.challenges) {
      challenge.reset();
    }

    this.startCursor.setVisible(false);
    this.cursorObj?.setVisible(true);
    this.updateChallengeArrowsTint(false);
    this.updateText();
  }

  public override setCursor(cursor: number): boolean {
    let ret = super.setCursor(cursor);

    if (!this.cursorObj) {
      this.cursorObj = globalScene.add
        .nineslice(0, 0, "summary_moves_cursor", undefined, this.optionsWidth - 8, 16, 1, 1, 1, 1)
        .setOrigin(0);
      this.valuesContainer.add(this.cursorObj);
    }

    ret ||= !this.cursorObj.visible;
    this.cursorObj //
      .setVisible(true)
      .setPositionRelative(this.optionsBg, 4, 4 + this.cursor * 16);

    return ret;
  }

  private setScrollCursor(scrollCursor: number): boolean {
    if (scrollCursor === this.scrollCursor) {
      return false;
    }

    this.scrollCursor = scrollCursor;

    this.setCursor(this.cursor);

    return true;
  }

  private getActiveChallenge(): Challenge {
    return this.getFilteredChallenges()[this.cursor + this.scrollCursor];
  }

  public override clear(): void {
    super.clear();
    this.pointerHits?.clear();
    this.challengesContainer.setVisible(false);
    if (this.descriptionScrollTween) {
      this.descriptionScrollTween.remove();
      this.descriptionScrollTween = null;
    }
    this.eraseCursor();
  }

  public override destroy(): void {
    super.destroy();

    this.homeKey?.off("up", this.onHomeDown, this);
    this.homeKey = undefined;

    if (this.descriptionScrollTween) {
      this.descriptionScrollTween.remove();
      this.descriptionScrollTween = null;
    }

    this.descriptionText.clearMask(true);
    this.descriptionTextMaskRect = null;

    this.challengesContainer?.destroy();
  }

  private eraseCursor(): void {
    if (this.cursorObj) {
      this.cursorObj.destroy();
    }
    this.cursorObj = null;
  }
}
