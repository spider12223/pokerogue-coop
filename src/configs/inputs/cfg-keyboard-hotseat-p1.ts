import { CFG_KEYBOARD_QWERTY } from "#inputs/cfg-keyboard-qwerty";
import type { KeyboardConfig } from "#types/configs/inputs";

export const CFG_KEYBOARD_HOTSEAT_P1: KeyboardConfig = {
  ...CFG_KEYBOARD_QWERTY,
  padID: "hotseat-p1",
  default: {
    ...CFG_KEYBOARD_QWERTY.default,
    KEY_W: -1,
    KEY_A: -1,
    KEY_S: -1,
    KEY_D: -1,
    KEY_Q: -1,
    KEY_E: -1,
    KEY_M: -1,
    KEY_T: -1,
    KEY_Y: -1,
    KEY_SHIFT: -1,
    KEY_TAB: -1,
    KEY_1: -1,
    KEY_2: -1,
    KEY_3: -1,
    KEY_4: -1,
    KEY_5: -1,
    KEY_6: -1,
    KEY_7: -1,
    KEY_8: -1,
    KEY_9: -1,
  },
};
