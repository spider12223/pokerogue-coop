import { eventBus } from "#app/event-bus";
import { isDev } from "#constants/app-constants";
import { MusicPreference } from "#enums/music-preference";
import { PlayerGender } from "#enums/player-gender";
import { SpriteSet } from "#enums/sprite-set";
import { UiTheme } from "#enums/ui-theme";
import { version } from "#package.json";
import { applySettingsVersionMigration } from "#system/version-converter";
import type { DisplaySettings, GeneralSettings, Settings, SettingsCategory, UserFacingSettings } from "#types/settings";

/** Manages game settings */
export class SettingsManager {
  /** Local storage key for persisting settings. */
  public readonly lsKey: string;

  /** Internal buffer for current settings. */
  private readonly _settings: Settings;

  /**
   * Co-op: the values `general` had before {@linkcode applyOverlay} replaced them in memory.
   * Empty outside co-op. Whatever is here is what gets saved; the overlaid values are never persisted.
   */
  private readonly overlayBackup: Partial<GeneralSettings> = {};
  /** Co-op: the same for `display` ({@linkcode applyDisplayOverlay}) */
  private readonly displayOverlayBackup: Partial<DisplaySettings> = {};

  constructor(localStorageKey: string, initSettings: UserFacingSettings) {
    this.lsKey = localStorageKey;
    this._settings = {
      meta: {
        gameVersion: version,
      },
      ...initSettings,
    };

    this.loadFromLocalStorage();
  }

  /** Getter for meta settings */
  public get meta() {
    return this._settings.meta;
  }

  /** Getter for general settings (with the co-op overlay applied, if any) */
  public get general() {
    return this._settings.general;
  }

  /** The general settings as they are saved: the same as {@linkcode general} but without the co-op overlay. */
  public get persistedGeneral(): Readonly<GeneralSettings> {
    return { ...this._settings.general, ...this.overlayBackup };
  }

  /** Whether a co-op overlay is applied. */
  public get hasOverlay(): boolean {
    return Object.keys(this.overlayBackup).length > 0 || Object.keys(this.displayOverlayBackup).length > 0;
  }

  /**
   * Co-op: replace general settings in memory for the length of a co-op session (DECISIONS D1, D5).
   * The overlay is never written to local storage ({@linkcode saveToLocalStorage} saves the underlying values) and
   * is taken off again with {@linkcode removeOverlay}. Applying more values while an overlay is active keeps the
   * original underlying values.
   * @param overlay - The values to force
   */
  public applyOverlay(overlay: Partial<GeneralSettings>): void {
    overlayInto("general", this._settings.general, this.overlayBackup, overlay);
  }

  /** Co-op: {@linkcode applyOverlay} for display settings (the guest follows the host's move animations, D27) */
  public applyDisplayOverlay(overlay: Partial<DisplaySettings>): void {
    overlayInto("display", this._settings.display, this.displayOverlayBackup, overlay);
  }

  /**
   * Co-op: take the overlay off again. The settings are back to their underlying values.
   * @param keys - Only these general settings (the ones the guest follows the host in, D27); default: every general and
   * display setting of the overlay
   */
  public removeOverlay(keys?: readonly (keyof GeneralSettings)[]): void {
    restoreFrom(this._settings.general, this.overlayBackup, keys);
    if (keys === undefined) {
      restoreFrom(this._settings.display, this.displayOverlayBackup);
    }
  }

  /** Co-op: take display settings of the overlay off again (default: all of them) */
  public removeDisplayOverlay(keys?: readonly (keyof DisplaySettings)[]): void {
    restoreFrom(this._settings.display, this.displayOverlayBackup, keys);
  }

  /** Getter for display settings */
  public get display() {
    return this._settings.display;
  }

  /** Getter for audio settings */
  public get audio() {
    return this._settings.audio;
  }

  /** Getter for gamepad settings */
  public get gamepad() {
    return this._settings.gamepad;
  }

  /** Getter for checking if experimental sprites are enabled */
  public get expSpritesEnabled(): boolean {
    return this.display.spriteSet === SpriteSet.EXPERIMENTAL;
  }

  /** Getter for checking if the player's gender is female */
  public get isPlayerFemale(): boolean {
    return this.general.playerGender === PlayerGender.FEMALE;
  }

  /** Getter for checking if the current UI theme is the legacy theme */
  public get isLegacyTheme(): boolean {
    return this.display.uiTheme === UiTheme.LEGACY;
  }

  /** Getter for checking if the music from all gens should be used */
  public get musicPreferenceAllGens(): boolean {
    return this.audio.musicPreference === MusicPreference.ALL_GENS;
  }

  /**
   * Updates a setting. Takes care of dispatching events and saving to local storage.
   * @param category - The category of the setting
   * @param key - The key of the setting
   * @param value - The updated value
   * @throws An error if an invalid category or key is encountered
   */
  public update<C extends SettingsCategory>(category: C, key: keyof UserFacingSettings[C], value: any) {
    if (!this._settings[category]) {
      eventBus.emit("settings/update/failed", { category, key, value });
      throw new Error(`Unknown category: ${category}`);
    }

    if (this._settings[category][key] == null) {
      eventBus.emit("settings/update/failed", { category, key, value });
      throw new Error(`Unknown key: ${category}.${String(key)}`);
    }

    const backup =
      category === "general" ? this.overlayBackup : category === "display" ? this.displayOverlayBackup : null;
    if (backup !== null && String(key) in backup) {
      // The overlay stays in effect; the player's choice is kept underneath and saved.
      (backup as Record<string, unknown>)[String(key)] = value;
    } else {
      this._settings[category][key] = value;
    }
    eventBus.emit("settings/update/success", { category, key, value });

    this.saveToLocalStorage();
  }

  /**
   * Exectues a window reload after updating the setting.
   * @see {@linkcode update}
   * @param category - The category of the setting
   * @param key - The key of the setting
   * @param value - The updated value
   */
  public updateAndReload<C extends SettingsCategory>(category: C, key: keyof UserFacingSettings[C], value: any) {
    this.update(category, key, value);
    window.location.reload();
  }

  /** Saves settings to local storage at {@linkcode lsKey} */
  private saveToLocalStorage() {
    const persisted: Settings = {
      ...this._settings,
      general: { ...this._settings.general, ...this.overlayBackup },
      display: { ...this._settings.display, ...this.displayOverlayBackup },
    };
    localStorage.setItem(this.lsKey, JSON.stringify(persisted));
    eventBus.emit("settings/saved", this._settings, this.lsKey);
  }

  /** Loads and populates settings from local storage at {@linkcode lsKey} */
  private loadFromLocalStorage() {
    const lsItem = localStorage.getItem(this.lsKey);

    if (lsItem) {
      try {
        const lsSettings: Partial<Settings> = JSON.parse(lsItem);

        applySettingsVersionMigration(lsSettings);

        const { general, audio, display, gamepad } = lsSettings;

        if (general) {
          this._settings.general = { ...this._settings.general, ...general };
        }
        if (!isDev) {
          this._settings.general.dexForDevs = false;
        }

        if (audio) {
          this._settings.audio = { ...this._settings.audio, ...audio };
        }

        if (display) {
          this._settings.display = { ...this._settings.display, ...display };
        }

        if (gamepad) {
          this._settings.gamepad = { ...this._settings.gamepad, ...gamepad };
        }
      } catch (err) {
        console.error("Error loading settings from local storage:", err);
      }
    }
  }
}

/** Co-op: force `overlay` into `target`, keeping each first underlying value in `backup` */
function overlayInto(category: string, target: object, backup: object, overlay: object): void {
  const values = target as Record<string, unknown>;
  const kept = backup as Record<string, unknown>;
  for (const [key, value] of Object.entries(overlay)) {
    if (!(key in values)) {
      throw new Error(`Unknown ${category} setting: ${key}`);
    }
    if (!(key in kept)) {
      kept[key] = values[key];
    }
    values[key] = value;
  }
}

/** Co-op: put the underlying values of `keys` (default: all that are kept) back into `target` */
function restoreFrom(target: object, backup: object, keys?: readonly string[]): void {
  const values = target as Record<string, unknown>;
  const kept = backup as Record<string, unknown>;
  for (const key of keys ?? Object.keys(kept)) {
    if (key in kept) {
      values[key] = kept[key];
      delete kept[key];
    }
  }
}
