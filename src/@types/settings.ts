import type { BattleStyle } from "#enums/battle-style";
import type { CandyUpgradeDisplayMode } from "#enums/candy-upgrade-display-mode";
import type { CandyUpgradeNotificationMode } from "#enums/candy-upgrade-notification-mode";
import type { DamageNumbersMode } from "#enums/damage-numbers-mode";
import type { EaseType } from "#enums/ease-type";
import type { EggSkipPreference } from "#enums/egg-skip-preference";
import type { ExpGainsSpeed } from "#enums/exp-gains-speed";
import type { ExpNotification } from "#enums/exp-notification";
import type { GameSpeed } from "#enums/game-speed";
import type { HpBarSpeed } from "#enums/hp-bar-speed";
import type { MoneyFormat } from "#enums/money-format";
import type { MusicPreference } from "#enums/music-preference";
import type { PlayerGender } from "#enums/player-gender";
import type { ShopCursorTarget } from "#enums/shop-cursor-target";
import type { SpriteSet } from "#enums/sprite-set";
import type { TypeHints } from "#enums/type-hints";
import type { UiTheme } from "#enums/ui-theme";
import type { UiWindowStyle } from "#enums/ui-window-style";

interface MetaSettings {
  gameVersion: string;
}

export interface Settings extends UserFacingSettings {
  meta: MetaSettings;
}

export interface UserFacingSettings {
  audio: AudioSettings;
  coop: CoopSettings;
  display: DisplaySettings;
  gamepad: GamepadSettings;
  general: GeneralSettings;
}

export interface GeneralSettings {
  battleCursorMemory: boolean;
  battleStyle: BattleStyle;
  dexForDevs: boolean;
  eggSkipPreference: EggSkipPreference;
  enableRetries: boolean;
  enableTouchControls: boolean;
  enableTutorials: boolean;
  enableVibration: boolean;
  expGainsSpeed: ExpGainsSpeed;
  gameSpeed: GameSpeed;
  hideIvScanner: boolean;
  hpBarSpeed: HpBarSpeed;
  levelMoveConfirmation: boolean;
  manualMessageClear: boolean;
  partyExpNotificationMode: ExpNotification;
  playerGender: PlayerGender;
  preferBatonPass: boolean;
  skipSeenDialogues: boolean;
}

/**
 * Co-op: the Co-op tab (DECISIONS D47). The two switches decide what a game offers; every other entry only changes
 * what this player sees, never the run or the partner's screen.
 */
export interface CoopSettings {
  /** The buttons that hide an HP box (D44); off, every box is shown */
  boxHandles: boolean;
  /** Ping and emote bubbles (D16) */
  bubbles: boolean;
  /** The chat button (the chat key still opens the box, D38) */
  chatButton: boolean;
  /** Chat lines and notes in the corner while the box is closed (D38) */
  chatPopups: boolean;
  /** The host of a game may open the debug menu (D42) */
  debugMenu: boolean;
  /** This screen's cursor follows the chooser's in an encounter (D29) */
  encounterCursor: boolean;
  /** The tag over the partner's Pokémon: its move, its target, ready (D16) */
  moveTags: boolean;
  /** The line of who is in, under the waiting text of a game of three (D40) */
  playersLine: boolean;
  /** The title screen's count of players online (D46) */
  playersOnline: boolean;
  /** The "Report a problem" button (D26) */
  reportButton: boolean;
  /** The partner's cursor on the reward screen (D16) */
  rewardCursor: boolean;
  /** The pointer over the Pokémon the partner aims at (D16) */
  targetPointers: boolean;
  /** The bars over a teammate's Pokémon in a game of three (D40) */
  teammateBars: boolean;
  /** Host a game offers 3 players (Beta, D40) */
  threePlayers: boolean;
  /** The mouse wheel zooms the battlefield (D44) */
  wheelZoom: boolean;
}

export interface DisplaySettings {
  candyUpgradeDisplayMode: CandyUpgradeDisplayMode;
  candyUpgradeNotificationMode: CandyUpgradeNotificationMode;
  damageNumbersMode: DamageNumbersMode;
  enableFusionPaletteSwaps: boolean;
  enableMoveAnimations: boolean;
  enableMoveInfo: boolean;
  hideUsername: boolean;
  language?: string;
  moneyFormat: MoneyFormat;
  shopCursorTarget: ShopCursorTarget;
  shopOverlayOpacity: number;
  showArenaFlyout: boolean;
  showBgmBar: boolean;
  showMissingRibbons: boolean;
  showMovesetFlyout: boolean;
  showStatsOnLevelUp: boolean;
  showTimeOfDayWidget: boolean;
  spriteSet: SpriteSet;
  timeOfDayAnimation: EaseType;
  typeHintsMode: TypeHints;
  uiTheme: UiTheme;
  uiWindowStyle: UiWindowStyle;
}

export interface AudioSettings {
  enableAudio: boolean;
  bgmVolume: number;
  fieldVolume: number;
  masterVolume: number;
  musicPreference: MusicPreference;
  soundEffectsVolume: number;
  uiVolume: number;
}

export interface GamepadSettings {
  activeIndex: number;
  enabled: boolean;
}

export type SettingUiItemOption = {
  value: number | string | boolean;
  label: string;
  /** Indicates if a settings change requires a confirmation */
  requiresConfirmation?: boolean;
  /** Provide a custom confirmation message. */
  confirmationMessage?: string;
};

export interface SettingsUiItem<K = AnySettingKey> {
  key: K;
  label: string;
  options: SettingUiItemOption[];
  /** Indicates if a settings change requires a reload */
  requiresReload?: boolean;
  /** Whether the setting is only available on devices supporting touchscreen. */
  touchscreenOnly?: boolean;
  /**
   * Specifies the behavior when navigating left/right at the boundaries of the option:
   *
   * - `true`: the cursor will stay on the boundary instead of moving
   * - `false`: the cursor will wrap to the other end of the options list
   * @defaultValue `false`
   */
  clamp?: boolean;
}

export type SettingsCategory = keyof UserFacingSettings;

/** All keys for all settings categories */
export type AnySettingKey =
  | GeneralSettingsKey
  | DisplaySettingsKey
  | AudioSettingsKey
  | GamepadSettingsKey
  | CoopSettingsKey;

/** All keys for the general settings + `"moveTouchControls"` */
export type GeneralSettingsKey = keyof GeneralSettings | "moveTouchControls";

/** All keys for the display settings + `"language"` */
export type DisplaySettingsKey = keyof DisplaySettings | "language";

/** All keys for the audio settings */
export type AudioSettingsKey = keyof AudioSettings;

/** All keys for changing the volume settings */
export type VolumeSettingsKey = Exclude<AudioSettingsKey, "musicPreference" | "enableAudio">;

/** All keys for the gamepad settings */
export type GamepadSettingsKey = keyof GamepadSettings;

/** All keys for the co-op settings */
export type CoopSettingsKey = keyof CoopSettings;
