/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defaultStarterSpecies, saveKey } from "#app/constants";
import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { bypassLogin, isApp, isBeta, isDev } from "#constants/app-constants";
import { coopText } from "#coop/text";
import { currentCoopSlot } from "#coop/wave-save";
import { allMoves } from "#data/data-lists";
import { AbilityAttr } from "#enums/ability-attr";
import { DexAttr } from "#enums/dex-attr";
import { EggSourceType } from "#enums/egg-source-types";
import { EggTier } from "#enums/egg-type";
import { version } from "#package.json";
import type { SystemSaveData } from "#types/save-data";
import { fixedInt } from "#utils/common";
import { isValidJSON } from "#utils/data";
import { compareVersions } from "#utils/migrator-utils";
import { AES, enc } from "crypto-js";

/**
 * Bringing an account from pokerogue.net into this game, so the players bring their own Pokémon. There, Menu → Manage
 * Data → Export Data downloads `data_<username>.prsv`: the account's system data as JSON, AES-encrypted with `saveKey`.
 * `GameData.importData` reads it with `GameData.readSystemImport`, which is built from this module.
 *
 * The official site can run a newer version than this build. Such a save does not load here as it is: `initSystem` refuses an
 * account from a newer version ("game out of date") and keeps the default one, which the next save then writes over the
 * import; an egg of a species this build does not have throws while the account loads; a form or a move this build does not
 * have breaks the starter select. So a newer save is made into one of this version: what this build does not have is left out,
 * and it is marked as this version. An older save is left as it is: the migrations bring it up to date when it loads, as they
 * do for any old save.
 *
 * @module
 */

/** What this build knows: the game's own data ({@linkcode gameImportCatalog}), or a stand-in in a test */
export interface ImportCatalog {
  /** This build's version (`package.json`) */
  readonly version: string;
  /** Every starter species, as `speciesDataRegistry.getAllStarters()` */
  readonly starters: readonly number[];
  /** The starters every account has (`defaultStarterSpecies`) */
  readonly defaultStarters: readonly number[];
  knowsSpecies(speciesId: number): boolean;
  /** The number of forms of a species this build knows (0: it has none) */
  formCount(speciesId: number): number;
  knowsMove(moveId: number): boolean;
}

/** Why an exported account is refused */
export type SystemImportRefusal =
  /** Neither JSON nor a save encrypted with `saveKey` */
  | "unreadable"
  /** JSON, but not an account (no dex, no starters, no timestamp or no version) */
  | "notSystemData"
  /** A saved run (Manage Data → Export Session), not the account */
  | "sessionData"
  /** The run history (Manage Data → Export Run History), not the account */
  | "runHistory"
  /** An account the game would throw away at its next save (`GameData.validateSystemData`) */
  | "corrupt";

export interface SystemImportAccepted {
  ok: true;
  /** What `importData` stores: the account as JSON, with this browser's trainer and secret IDs */
  dataStr: string;
  /** The version the save was made with */
  fromVersion: string;
  /** It was made with a newer version than this build, and was made into one of this version */
  newer: boolean;
  /** Species this build does not have, left out of the dex and the starters */
  droppedSpecies: number;
  /** Eggs this build cannot hatch (a species or a kind of egg it does not have), left out */
  droppedEggs: number;
}

export type SystemImportResult = SystemImportAccepted | { ok: false; reason: SystemImportRefusal };

/** The largest dex attribute a save keeps as a number; a larger one is a decimal string (`GameData.saveSystem`) */
const MAX_NUMBER_ATTR = 0x80000000n;

/** A game version as `compareVersions` takes it (`migrator-utils.ts` `extractVersion`) */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:\.\d+)?$/;

/** @returns The catalog of this build's own data */
export function gameImportCatalog(): ImportCatalog {
  return {
    version,
    starters: speciesDataRegistry.getAllStarters(),
    defaultStarters: defaultStarterSpecies,
    knowsSpecies: speciesId => speciesDataRegistry.getSpeciesData(speciesId) !== undefined,
    formCount: speciesId => speciesDataRegistry.getSpecies(speciesId).forms.length,
    knowsMove: moveId => allMoves[moveId] !== undefined,
  };
}

/**
 * Where the account import is offered: as upstream (beta, dev and app builds), and with local accounts (`bypassLogin`), which
 * have no server account to protect. A co-op deploy has local accounts (D22).
 */
export function systemImportAvailable(): boolean {
  return isBeta || isDev || isApp || bypassLogin;
}

/**
 * @returns The JSON of an exported save: the file as it is when it is JSON, else the file decrypted with `saveKey`; `null` when
 * it is neither
 */
export function decodeSaveText(fileText: string): string | null {
  const text = fileText.trim();
  if (isValidJSON(text)) {
    return text;
  }
  try {
    const plain = AES.decrypt(text, saveKey).toString(enc.Utf8);
    return isValidJSON(plain) ? plain : null;
  } catch {
    // Not AES text, or not this key: crypto-js throws "Malformed UTF-8 data"
    return null;
  }
}

/**
 * The account in an exported save, made ready to be stored (`importData` stores `dataStr` and reloads the page).
 * @param dataStr - The save's JSON, with the long keys (`GameData.convertSystemDataStr`)
 * @param account - This browser's account: its trainer and secret IDs are kept, as the import always kept them, so a saved
 * co-op run still finds this player (D21)
 * @param parse - `GameData.parseSystemData` (passed in: this module does not import the game data)
 * @param catalog - What this build knows
 */
export function prepareSystemImport(
  dataStr: string,
  account: { readonly trainerId: number; readonly secretId: number },
  parse: (dataStr: string) => SystemSaveData,
  catalog: ImportCatalog,
): SystemImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(dataStr);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (
    !isRecord(raw)
    || !isRecord(raw["dexData"])
    || !isRecord(raw["starterData"])
    || !raw["timestamp"]
    || typeof raw["gameVersion"] !== "string"
    || !VERSION_PATTERN.test(raw["gameVersion"])
  ) {
    return { ok: false, reason: otherSaveKind(raw) ?? "notSystemData" };
  }
  const fromVersion = raw["gameVersion"];
  const order = compareVersions(fromVersion, catalog.version);
  let left = { species: 0, eggs: 0 };
  if (order === 1) {
    left = leaveOutWhatThisBuildLacks(raw, catalog);
    raw["gameVersion"] = catalog.version;
  }
  raw["trainerId"] = account.trainerId;
  raw["secretId"] = account.secretId;
  const prepared = JSON.stringify(raw);

  let data: SystemSaveData;
  try {
    data = parse(prepared);
  } catch {
    return { ok: false, reason: "corrupt" };
  }
  // An older save is checked when it has been migrated, at its first save; one of this version or made into one is checked here
  if (order !== -1 && !startersAreSound(data, catalog)) {
    return { ok: false, reason: "corrupt" };
  }
  return {
    ok: true,
    dataStr: prepared,
    fromVersion,
    newer: order === 1,
    droppedSpecies: left.species,
    droppedEggs: left.eggs,
  };
}

/**
 * What the player is told before an account replaces this browser's, one message each (`importData` shows them before its own
 * question): a save from a newer version and what was left out of it, and a saved co-op run, which stays (the account keeps
 * this browser's IDs, D21).
 */
export function systemImportNotes(result: SystemImportAccepted): string[] {
  const notes: string[] = [];
  if (result.newer) {
    notes.push(
      coopText("importNewerSave", "This save is from version {{from}}. This game is version {{to}}.", {
        from: result.fromVersion,
        to: version,
      }),
    );
    if (result.droppedSpecies > 0 || result.droppedEggs > 0) {
      notes.push(
        coopText(
          "importLeftOut",
          "This version does not have {{species}} of its Pokémon and {{eggs}} of its eggs: they are left out.",
          {
            species: result.droppedSpecies,
            eggs: result.droppedEggs,
          },
        ),
      );
    }
  }
  const slot = currentCoopSlot();
  if (slot !== null) {
    notes.push(
      coopText(
        "importKeepsCoopRun",
        "Your saved co-op run (wave {{wave}}) stays: this browser keeps its trainer ID, so it can still be continued.",
        { wave: slot.wave },
      ),
    );
  }
  return notes;
}

/**
 * What the player is told when the file is refused: which file it is, and which one to bring instead. Every refusal used to
 * read "may be corrupted", while the usual cause is the wrong file from pokerogue.net's Manage Data menu.
 */
export function systemImportRefusalText(reason: SystemImportRefusal): string {
  const exportData = coopText(
    "importUseExportData",
    "On pokerogue.net use Manage Data > Export Data (data_<name>.prsv).",
  );
  switch (reason) {
    case "sessionData":
      return `${coopText("importIsSession", "That file is a saved run, not your account.")} ${exportData}`;
    case "runHistory":
      return `${coopText("importIsRunHistory", "That file is your run history, not your account.")} ${exportData}`;
    case "notSystemData":
      return `${coopText("importNotAccount", "That file is not PokéRogue account data.")} ${exportData}`;
    case "unreadable":
      return `${coopText("importUnreadable", "That file can't be read as a PokéRogue save.")} ${exportData}`;
    case "corrupt":
      return coopText(
        "importCorruptAccount",
        "This account fails the game's own save check, so it can't be loaded. It may be corrupted.",
      );
  }
}

/**
 * The session import was given an account (Import Session instead of Import Data)
 * @param dataStr - The file as the session import decoded it
 * @returns What to tell the player, or `null` if the file is not an account
 */
export function sessionImportHint(dataStr: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(dataStr);
  } catch {
    return null;
  }
  if (!systemImportAvailable() || !isRecord(raw) || !("dexData" in raw)) {
    return null;
  }
  return coopText("importIsAccount", "That file is your account, not a saved run: use Import Data instead.");
}

/** @returns Which other save a refused file is, if it is one */
function otherSaveKind(raw: unknown): "sessionData" | "runHistory" | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (Array.isArray(raw["party"]) && (Array.isArray(raw["enemyParty"]) || typeof raw["waveIndex"] === "number")) {
    return "sessionData";
  }
  const entries = Object.values(raw);
  if (entries.length > 0 && entries.every(entry => isRecord(entry) && "entry" in entry && "isVictory" in entry)) {
    return "runHistory";
  }
  return null;
}

/** How long a note stays before the next one, in ms (it is read, not answered) */
const NOTE_MS = 3000;

/**
 * Show the notes one after the other, each for a moment, then go on. Not a key prompt: the import is asked from a menu (the
 * co-op title menu, Manage Data), whose handler would take the key instead of the message.
 */
export function showImportNotes(notes: readonly string[], then: () => void): void {
  const [note, ...rest] = notes;
  if (note === undefined) {
    then();
    return;
  }
  globalScene.ui.showText(note, null, () => showImportNotes(rest, then), fixedInt(NOTE_MS));
}

/** The import reloads the page: during a co-op session that would end it */
export function importInCoopText(): string {
  return coopText(
    "importInCoop",
    "Importing reloads the game, which would end this co-op session. Import from the title screen instead.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Make a newer save into one of this version (see the module comment).
 * @returns How many species and eggs were left out
 */
function leaveOutWhatThisBuildLacks(
  raw: Record<string, unknown>,
  catalog: ImportCatalog,
): { species: number; eggs: number } {
  const unknownSpecies = new Set<string>();
  leaveOutDexData(raw["dexData"] as Record<string, unknown>, catalog, unknownSpecies);
  leaveOutStarterData(raw["starterData"] as Record<string, unknown>, catalog, unknownSpecies);
  let eggs = 0;
  if (Array.isArray(raw["eggs"])) {
    const kept = raw["eggs"].filter(egg => eggIsKnown(egg, catalog));
    eggs = raw["eggs"].length - kept.length;
    raw["eggs"] = kept;
  }
  return { species: unknownSpecies.size, eggs };
}

function knowsSpeciesKey(key: string, catalog: ImportCatalog): boolean {
  return Number.isInteger(Number(key)) && catalog.knowsSpecies(Number(key));
}

/** A count or an attribute bitmask as a save writes it (a number, or a string for a big one) that is not zero */
function isNonZero(value: unknown): boolean {
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    try {
      return BigInt(value) !== 0n;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Whether an entry holds anything the player did (seen, caught, hatched; candy, passives...). A save has an entry for every
 * species of its version, so an empty one of a species this build lacks is no loss and is not counted as left out.
 */
function hasProgress(entry: unknown, keys: readonly string[]): boolean {
  return isRecord(entry) && keys.some(key => isNonZero(entry[key]));
}

const DEX_PROGRESS = ["seenAttr", "caughtAttr", "seenCount", "caughtCount", "hatchedCount"] as const;
const STARTER_PROGRESS = [
  "candyCount",
  "abilityAttr",
  "passiveAttr",
  "eggMoves",
  "friendship",
  "classicWinCount",
] as const;

/** The dex: species this build does not have go (into `unknownSpecies`), and so do forms it does not have */
function leaveOutDexData(dexData: Record<string, unknown>, catalog: ImportCatalog, unknownSpecies: Set<string>): void {
  for (const key of Object.keys(dexData)) {
    const entry = dexData[key];
    if (!knowsSpeciesKey(key, catalog)) {
      if (hasProgress(entry, DEX_PROGRESS)) {
        unknownSpecies.add(key);
      }
      delete dexData[key];
    } else if (isRecord(entry)) {
      const forms = Math.max(catalog.formCount(Number(key)), 1);
      entry["seenAttr"] = keepKnownForms(entry["seenAttr"], forms);
      entry["caughtAttr"] = keepKnownForms(entry["caughtAttr"], forms);
    } else {
      // The empty entry of a new account takes its place when the account loads
      delete dexData[key];
    }
  }
}

/**
 * The starters: species this build does not have go (into `unknownSpecies`), and so do species that are not starters here (the
 * rule of the 1.12.0.10 migrator); a moveset with a move this build does not have is cleared. Every starter of this build has
 * an entry (`validateSystemData`): one this save does not have starts empty.
 */
function leaveOutStarterData(
  starterData: Record<string, unknown>,
  catalog: ImportCatalog,
  unknownSpecies: Set<string>,
): void {
  const starters = new Set(catalog.starters);
  for (const key of Object.keys(starterData)) {
    const entry = starterData[key];
    if (!knowsSpeciesKey(key, catalog)) {
      if (hasProgress(entry, STARTER_PROGRESS)) {
        unknownSpecies.add(key);
      }
      delete starterData[key];
    } else if (!(starters.has(Number(key)) && isRecord(entry))) {
      delete starterData[key];
    } else if (hasUnknownMove(entry["moveset"], catalog)) {
      entry["moveset"] = null;
    }
  }
  for (const speciesId of catalog.starters) {
    if (!isRecord(starterData[speciesId])) {
      starterData[speciesId] = {
        moveset: null,
        eggMoves: 0,
        candyCount: 0,
        friendship: 0,
        abilityAttr: catalog.defaultStarters.includes(speciesId) ? AbilityAttr.ABILITY_1 : 0,
        passiveAttr: 0,
        valueReduction: 0,
        classicWinCount: 0,
      };
    }
  }
}

/**
 * Form `i` of a species is the dex bit `1 << (7 + i)` (`GameData.getFormAttr`); a newer version can have more forms. Those bits
 * are cleared. A species seen or caught only in such forms keeps its first form instead, so it stays caught.
 * @returns The attribute as a save writes it
 */
function keepKnownForms(value: unknown, forms: number): unknown {
  let attr: bigint;
  try {
    attr = BigInt((value as string | number | undefined) ?? 0);
  } catch {
    // Not a number: `parseSystemData` throws on it, and the save is refused as corrupt
    return value;
  }
  const known = (1n << BigInt(7 + forms)) - 1n;
  if ((attr & ~known) === 0n) {
    return value;
  }
  let kept = attr & known;
  if (kept >> 7n === 0n) {
    kept |= DexAttr.DEFAULT_FORM;
  }
  return kept <= MAX_NUMBER_ATTR ? Number(kept) : kept.toString();
}

/** @returns Whether a saved moveset (one list, or one per form) has a move this build does not have */
function hasUnknownMove(moveset: unknown, catalog: ImportCatalog): boolean {
  if (moveset == null) {
    return false;
  }
  const lists: unknown[] = isRecord(moveset) ? Object.values(moveset) : [moveset];
  return lists.some(
    list =>
      !Array.isArray(list)
      || list.some(move => typeof move !== "number" || !Number.isInteger(move) || !catalog.knowsMove(move)),
  );
}

/** @returns Whether this build can hatch the egg: its species (0 for a legacy egg), its tier and its source are all known */
function eggIsKnown(egg: unknown, catalog: ImportCatalog): boolean {
  if (!isRecord(egg)) {
    return false;
  }
  const { species, tier, sourceType } = egg;
  if (species != null && species !== 0 && !(typeof species === "number" && catalog.knowsSpecies(species))) {
    return false;
  }
  if (tier != null && (typeof tier !== "number" || EggTier[tier] === undefined)) {
    return false;
  }
  return sourceType == null || (typeof sourceType === "number" && EggSourceType[sourceType] !== undefined);
}

/**
 * The check `GameData.validateSystemData` makes at every save, where a failure throws the whole account away: made here, so
 * such a file is refused instead. A missing dex entry is an empty one, as at that save (the empty entries fill the dex when the
 * account loads).
 */
function startersAreSound(data: SystemSaveData, catalog: ImportCatalog): boolean {
  for (const speciesId of catalog.starters) {
    if (catalog.defaultStarters.includes(speciesId)) {
      continue;
    }
    const starter = data.starterData[speciesId];
    if (starter == null) {
      return false;
    }
    const dex = data.dexData[speciesId];
    const hasStarterData =
      starter.abilityAttr > 0
      || starter.eggMoves > 0
      || starter.moveset != null
      || starter.passiveAttr > 0
      || starter.valueReduction > 0;
    const noDexData =
      dex == null || ((dex.caughtCount ?? 0) === 0 && (dex.hatchedCount ?? 0) === 0 && (dex.caughtAttr ?? 0n) === 0n);
    if (hasStarterData && noDexData) {
      return false;
    }
  }
  return true;
}
