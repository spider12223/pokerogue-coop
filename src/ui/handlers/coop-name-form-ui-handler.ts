/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { coopText } from "#coop/bridge";
import type { ModalConfig } from "#types/ui-types";
import { FormModalUiHandler, type InputFieldConfig } from "#ui/form-modal-ui-handler";
import i18next from "i18next";

/** The form where a player types the name the partner sees (DECISIONS D1). */
export class CoopNameFormUiHandler extends FormModalUiHandler {
  getModalTitle(_config?: ModalConfig): string {
    return coopText("nameTitle", "Your name");
  }

  getWidth(_config?: ModalConfig): number {
    return 160;
  }

  getMargin(_config?: ModalConfig): [number, number, number, number] {
    return [0, 0, 48, 0];
  }

  getButtonLabels(_config?: ModalConfig): string[] {
    return [coopText("nameSave", "Save"), i18next.t("menu:cancel")];
  }

  override getInputFieldConfigs(): InputFieldConfig[] {
    return [{ label: coopText("nameLabel", "Name") }];
  }

  /** Type a name into the form and submit it, as the player would (the debug API and the end-to-end test use it) */
  public submitName(name: string): void {
    this.inputs[0].text = name;
    this.submitAction?.();
  }

  /** @param args - `[config, current]`: `config.buttonActions` is `[save(name: string), cancel()]`, `current` the name now */
  override show(args: any[]): boolean {
    if (!super.show(args)) {
      return false;
    }
    const config = args[0] as ModalConfig;
    this.inputs[0].text = typeof args[1] === "string" ? args[1] : "";
    this.submitAction = () => {
      this.sanitizeInputs();
      config.buttonActions[0](this.inputs[0].text);
    };
    return true;
  }
}
