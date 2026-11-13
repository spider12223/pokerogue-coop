/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { BaseSettingsUiHandler } from "#ui/base-settings-ui-handler";
import { coopSettingsUiItems } from "#ui/settings-ui-items";

/** Co-op (D47): the Co-op tab of the settings */
export class SettingsCoopUiHandler extends BaseSettingsUiHandler {
  constructor() {
    super("coop", coopSettingsUiItems);
  }
}
