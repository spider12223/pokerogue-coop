import { CFG_KEYBOARD_QWERTY } from "#inputs/cfg-keyboard-qwerty";
import { SettingKeyboard } from "#system/settings-keyboard";
import type { KeyboardConfig } from "#types/configs/inputs";

const blank: KeyboardConfig["default"] = Object.fromEntries(
  Object.keys(CFG_KEYBOARD_QWERTY.default).map(k => [k, -1 as const]),
) as KeyboardConfig["default"];

export const CFG_KEYBOARD_HOTSEAT_P2: KeyboardConfig = {
  ...CFG_KEYBOARD_QWERTY,
  padID: "hotseat-p2",
  default: {
    ...blank,
    KEY_W: SettingKeyboard.BUTTON_UP,
    KEY_S: SettingKeyboard.BUTTON_DOWN,
    KEY_A: SettingKeyboard.BUTTON_LEFT,
    KEY_D: SettingKeyboard.BUTTON_RIGHT,
    KEY_Q: SettingKeyboard.BUTTON_ACTION,
    KEY_SHIFT: SettingKeyboard.BUTTON_CANCEL,
    KEY_TAB: SettingKeyboard.BUTTON_SUBMIT,
    KEY_1: SettingKeyboard.BUTTON_MENU,
    KEY_2: SettingKeyboard.BUTTON_STATS,
    KEY_3: SettingKeyboard.BUTTON_CYCLE_SHINY,
    KEY_4: SettingKeyboard.BUTTON_CYCLE_FORM,
    KEY_5: SettingKeyboard.BUTTON_CYCLE_GENDER,
    KEY_E: SettingKeyboard.BUTTON_CYCLE_ABILITY,
    KEY_6: SettingKeyboard.BUTTON_CYCLE_NATURE,
    KEY_7: SettingKeyboard.BUTTON_CYCLE_TERA,
    KEY_8: SettingKeyboard.BUTTON_SPEED_UP,
    KEY_9: SettingKeyboard.BUTTON_SLOW_DOWN,
  },
};
