import { Button } from "#enums/buttons";
import { UiMode } from "#enums/ui-mode";
import type { OptionSelectModeConfig, UIOptionSelectItem } from "#types/ui-types";
import { OptionSelectUiHandler } from "#ui/option-select-ui-handler";
import type { PointerHitAreaManager, PointerRowHitAreaConfig } from "#ui/pointer-hit-areas";
import type Phaser from "phaser";

const DEFAULT_MAX_OPTIONS = 10;

export class AutoCompleteUiHandler extends OptionSelectUiHandler {
  private modalContainer?: Phaser.GameObjects.Container;

  /** Row hit areas that pick a suggestion with SUBMIT, on top of the inherited ones (ACTION does nothing here) */
  private submitHitAreas: PointerHitAreaManager | null = null;
  private totalOptions = 0;
  private visibleOptions = 0;

  constructor() {
    super(UiMode.AUTO_COMPLETE);
  }

  public override setup(): void {
    super.setup();

    this.submitHitAreas = this.createPointerHitAreas(this.optionSelectContainer);
  }

  public override show(args: any[]): boolean {
    if (args[0]?.modalContainer) {
      const config: OptionSelectModeConfig & { modalContainer: Phaser.GameObjects.Container } = args[0];
      this.modalContainer = config.modalContainer;
      this.totalOptions = config.options?.length ?? 0;
      this.visibleOptions = Math.min(this.totalOptions, config.maxOptions ?? DEFAULT_MAX_OPTIONS);

      // CANCEL does nothing here (the text field's Escape closes the list), so there is no click-outside-to-cancel zone:
      // it would only stop clicks from reaching the form's own buttons
      if (!super.show([{ ...config, blockCancelButton: true }, ...args.slice(1)])) {
        return false;
      }
      this.updateSubmitHitAreas();
      this.submitHitAreas?.setWheelHandler(direction => this.onPointerWheel(direction));
      return true;
    }

    return false;
  }

  protected override updateSizeForOptions(options: UIOptionSelectItem[]): void {
    super.updateSizeForOptions(options);

    if (this.modalContainer) {
      this.optionSelectContainer.setPositionRelative(
        this.modalContainer,
        this.optionSelectBg.width,
        this.optionSelectBg.height + 50,
      );
    }
  }

  protected override displayCurrentOptions(skipResizing = false): void {
    super.displayCurrentOptions(skipResizing);
    this.updateSubmitHitAreas();
  }

  /** Same rows as the inherited hit areas: hover selects a suggestion, a click selects it and presses SUBMIT */
  private updateSubmitHitAreas(): void {
    if (!this.submitHitAreas || !this.optionSelectContainer.visible) {
      return;
    }

    const rowPitch = 114 * this.scale - 3;
    const rowWidth = this.optionSelectBg.displayWidth;
    const baseX = this.optionSelectBg.x - rowWidth;
    const baseY = this.optionSelectBg.y - this.optionSelectBg.displayHeight + 102 * this.scale - 2 - rowPitch / 2;

    const configs: PointerRowHitAreaConfig[] = [];
    for (let row = 0; row < this.visibleOptions; row++) {
      configs.push({
        x: baseX,
        y: baseY + row * rowPitch,
        width: rowWidth,
        height: Math.max(rowPitch, 1),
        onHover: () => {
          if (this.isPointerInputEnabled() && !this.blockInput) {
            this.setCursor(row);
          }
        },
        onActivate: () => {
          if (this.isPointerInputEnabled()) {
            this.setCursor(row);
            this.processInput(Button.SUBMIT);
          }
        },
      });
    }

    this.submitHitAreas.setRows(configs);
  }

  /** Scroll the suggestions by one (mouse wheel), without wrapping around */
  private onPointerWheel(direction: -1 | 1): void {
    if (!this.isPointerInputEnabled()) {
      return;
    }
    const maxScrollCursor = Math.max(this.totalOptions - this.visibleOptions, 0);
    this.setScrollCursor(Math.min(Math.max(this.scrollCursor + direction, 0), maxScrollCursor));
  }

  public override processInput(button: Button): boolean {
    const ui = this.getUi();

    if (button === Button.SUBMIT) {
      const option = this.currentOption;

      if (option?.handler()) {
        if (!option.keepOpen) {
          this.clear();
        }
        if (!option.noSoundEffects) {
          ui.playSelect();
        }
      } else {
        ui.playError();
      }

      return true;
    }

    if (button !== Button.CANCEL && button !== Button.ACTION) {
      return super.processInput(button);
    }

    return false;
  }

  public override clear(): void {
    super.clear();

    this.submitHitAreas?.clear();
  }
}
