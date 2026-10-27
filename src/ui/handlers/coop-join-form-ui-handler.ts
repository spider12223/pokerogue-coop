/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Adapted from SunghoLee98/pokerogue `src/coop/coop-join-form-ui-handler.ts` (AGPL-3.0-only).
 */

import { coopText } from "#coop/bridge";
import type { ModalConfig } from "#types/ui-types";
import { FormModalUiHandler, type InputFieldConfig } from "#ui/form-modal-ui-handler";
import i18next from "i18next";

/** The form where the guest types the host's join code. */
export class CoopJoinFormUiHandler extends FormModalUiHandler {
  getModalTitle(_config?: ModalConfig): string {
    return coopText("joinTitle", "Join a co-op game");
  }

  getWidth(_config?: ModalConfig): number {
    return 160;
  }

  getMargin(_config?: ModalConfig): [number, number, number, number] {
    return [0, 0, 48, 0];
  }

  getButtonLabels(_config?: ModalConfig): string[] {
    return [coopText("join", "Join"), i18next.t("menu:cancel")];
  }

  override getInputFieldConfigs(): InputFieldConfig[] {
    return [{ label: coopText("joinCodeLabel", "Join code") }];
  }

  /** Type a code into the form and submit it, as the player would (the debug API and the end-to-end test use it) */
  public submitCode(code: string): void {
    this.inputs[0].text = code;
    this.submitAction?.();
  }

  /**
   * @param args - `[config, code?]`, where `config.buttonActions` is `[join(code: string), cancel()]` and `code` is what the
   * field starts with (the code that was mistyped last time, to correct)
   */
  override show(args: any[]): boolean {
    if (!super.show(args)) {
      return false;
    }
    for (const input of this.inputs) {
      input.text = "";
    }
    this.inputs[0].text = typeof args[1] === "string" ? args[1] : "";
    const config = args[0] as ModalConfig;
    this.submitAction = () => {
      this.sanitizeInputs();
      config.buttonActions[0](this.inputs[0].text);
    };
    return true;
  }
}
