/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { coopLog } from "#coop/diagnostics/coop-log";

/**
 * A download of the game that fails is asked for again (DECISIONS D45): an image, an atlas (its picture or its frame list),
 * a spritesheet or a data file, at the end of the loader's queue, twice at most. Phaser's loader gives up on a file at the
 * first failure, and the game then draws a missing texture where it goes for the rest of the session: a player once had every
 * Pokémon icon of the starter select missing. Each try, and a file given up, is written to the co-op log (D26).
 *
 * The loader is reached through the little it needs, so the tests run without Phaser.
 *
 * @module
 */

/** Tries of one file in all: the first and two more */
export const MAX_DOWNLOAD_TRIES = 3;

/** A file of Phaser's loader, as a failure reports it */
export interface DownloadFile {
  key: string;
  type: string;
  url?: unknown;
  /** A spritesheet's frame size */
  config?: unknown;
  /** The file it is a part of (an atlas is a picture and a frame list) */
  multiFile?: { key: string; type: string; files: DownloadFile[] } | undefined;
}

/** What of Phaser's loader a retry uses */
export interface DownloadLoader {
  on(event: "loaderror", listener: (file: DownloadFile) => void): unknown;
  image(key: string, url: string): unknown;
  atlas(key: string, textureUrl: string, atlasUrl: string): unknown;
  spritesheet(key: string, url: string, config: never): unknown;
  json(key: string, url: string): unknown;
  isLoading(): boolean;
  start(): void;
  once(event: string, listener: () => void): unknown;
  textureManager: { renameTexture(currentKey: string, newKey: string): boolean };
}

/** Phaser's event for a file that failed (`Phaser.Loader.Events.FILE_LOAD_ERROR`) */
const FILE_LOAD_ERROR = "loaderror";

function logRetry(message: string, file: string): void {
  console.warn(`download ${message}: ${file}`);
  coopLog().warn("load", `download ${message}`, { file });
}

/**
 * Ask again for what fails to download on this loader.
 * @param loader - A scene's loader (`scene.load`)
 * @param log - Where each try and each file given up is told
 */
export function retryFailedDownloads(
  loader: DownloadLoader,
  log: (message: string, file: string) => void = logRetry,
): void {
  const tries = new Map<string, number>();
  // the name each atlas retry was asked for under, back to the atlas's own
  const ownName = new Map<string, string>();
  // the two parts of an atlas fail one after the other: the atlas is asked for once
  const askedAgain = new WeakSet<object>();
  loader.on(FILE_LOAD_ERROR, file => {
    const whole = file.multiFile;
    if (whole !== undefined && askedAgain.has(whole)) {
      return;
    }
    const again = ask(loader, file, ownName);
    if (again === null) {
      return;
    }
    const id = `${again.type} ${again.key} ${again.urls.join(" ")}`;
    const tried = tries.get(id) ?? 1;
    if (tried >= MAX_DOWNLOAD_TRIES) {
      log(`gave up after ${MAX_DOWNLOAD_TRIES} tries`, id);
      return;
    }
    tries.set(id, tried + 1);
    if (whole !== undefined) {
      askedAgain.add(whole);
    }
    log(`trying again (${tried + 1} of ${MAX_DOWNLOAD_TRIES})`, id);
    again.request(tried + 1);
    // (a file the battle asks for on its own comes after the loader finished: it is started again)
    if (!loader.isLoading()) {
      loader.start();
    }
  });
}

/**
 * How to ask again for a failed file: `null` for a kind this does not retry (a sound: the game goes on without it).
 * An atlas is asked for under a name of its own (`<key>__retry<n>`): Phaser's loader skips a file whose name and kind
 * are still in flight, and the other part of the failed atlas may still be. Once it has come, its texture takes the
 * atlas's name.
 */
function ask(
  loader: DownloadLoader,
  file: DownloadFile,
  ownName: Map<string, string>,
): { type: string; key: string; urls: string[]; request: (attempt: number) => void } | null {
  const whole = file.multiFile;
  if (whole !== undefined) {
    const [picture, frames] = whole.files.map(part => part.url);
    if (whole.type !== "atlasjson" || typeof picture !== "string" || typeof frames !== "string") {
      return null;
    }
    const key = ownName.get(whole.key) ?? whole.key;
    return {
      type: "atlas",
      key,
      urls: [picture, frames],
      request: attempt => {
        const name = `${key}__retry${attempt}`;
        ownName.set(name, key);
        loader.once(`filecomplete-atlasjson-${name}`, () => loader.textureManager.renameTexture(name, key));
        loader.atlas(name, picture, frames);
      },
    };
  }
  const url = file.url;
  if (typeof url !== "string") {
    return null;
  }
  switch (file.type) {
    case "image":
      return { type: "image", key: file.key, urls: [url], request: () => loader.image(file.key, url) };
    case "spritesheet":
      return {
        type: "spritesheet",
        key: file.key,
        urls: [url],
        request: () => loader.spritesheet(file.key, url, file.config as never),
      };
    case "json":
      return { type: "json", key: file.key, urls: [url], request: () => loader.json(file.key, url) };
    default:
      return null;
  }
}
