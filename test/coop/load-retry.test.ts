/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  type DownloadFile,
  type DownloadLoader,
  MAX_DOWNLOAD_TRIES,
  retryFailedDownloads,
} from "#coop/diagnostics/load-retry";
import { describe, expect, it } from "vitest";

/**
 * A download that fails is asked for again at the end of the queue, twice at most (DECISIONS D45). A player once had every
 * Pokémon icon of the starter select missing: the icon atlases had not come, and nothing asked again.
 */

/** A loader that records what is asked of it; `emit` plays a failure as Phaser's loader reports it */
function fakeLoader(loading = true) {
  const calls: unknown[][] = [];
  let onError: ((file: DownloadFile) => void) | null = null;
  const done = new Map<string, () => void>();
  const renamed: [string, string][] = [];
  const loader: DownloadLoader & {
    emit(file: DownloadFile): void;
    finish(event: string): void;
    starts: number;
  } = {
    starts: 0,
    on: (event, listener) => {
      expect(event).toBe("loaderror");
      onError = listener;
    },
    image: (key, url) => void calls.push(["image", key, url]),
    atlas: (key, textureUrl, atlasUrl) => void calls.push(["atlas", key, textureUrl, atlasUrl]),
    spritesheet: (key, url, config) => void calls.push(["spritesheet", key, url, config]),
    json: (key, url) => void calls.push(["json", key, url]),
    isLoading: () => loading,
    start: () => {
      loader.starts++;
    },
    once: (event, listener) => void done.set(event, listener),
    textureManager: {
      renameTexture: (from, to) => {
        renamed.push([from, to]);
        return true;
      },
    },
    emit: file => onError?.(file),
    finish: event => done.get(event)?.(),
  };
  return { loader, calls, renamed };
}

describe("a download that fails (D45)", () => {
  it("is asked for again, twice at most, and each try and the giving up are logged", () => {
    const { loader, calls } = fakeLoader();
    const notes: string[] = [];
    retryFailedDownloads(loader, (message, file) => notes.push(`${message} ${file}`));
    const failed: DownloadFile = { key: "logo", type: "image", url: "images/logo.png" };

    for (let i = 0; i < MAX_DOWNLOAD_TRIES; i++) {
      loader.emit(failed);
    }
    expect(calls).toEqual([
      ["image", "logo", "images/logo.png"],
      ["image", "logo", "images/logo.png"],
    ]);
    expect(notes).toEqual([
      "trying again (2 of 3) image logo images/logo.png",
      "trying again (3 of 3) image logo images/logo.png",
      "gave up after 3 tries image logo images/logo.png",
    ]);
  });

  it("asks for a whole atlas again when its picture or its frame list fails, once for both", () => {
    // (under a name of its own: Phaser skips a file whose name is still in flight, and the other part of the failed atlas
    // may still be; the texture takes the atlas's name once it has come)
    const { loader, calls, renamed } = fakeLoader();
    retryFailedDownloads(loader, () => {});
    const atlas = {
      key: "pokemon_icons_1",
      type: "atlasjson",
      files: [] as DownloadFile[],
    };
    const picture: DownloadFile = {
      key: "pokemon_icons_1",
      type: "image",
      url: "images/pokemon_icons_1.png",
      multiFile: atlas,
    };
    const frames: DownloadFile = {
      key: "pokemon_icons_1",
      type: "json",
      url: "images/pokemon_icons_1.json",
      multiFile: atlas,
    };
    atlas.files.push(picture, frames);

    loader.emit(picture);
    loader.emit(frames);
    expect(calls).toEqual([
      ["atlas", "pokemon_icons_1__retry2", "images/pokemon_icons_1.png", "images/pokemon_icons_1.json"],
    ]);
    expect(renamed).toEqual([]);
    loader.finish("filecomplete-atlasjson-pokemon_icons_1__retry2");
    expect(renamed).toEqual([["pokemon_icons_1__retry2", "pokemon_icons_1"]]);

    // the retry fails as well: the third try is the last, still counted against the atlas's own name
    const retry = { key: "pokemon_icons_1__retry2", type: "atlasjson", files: [] as DownloadFile[] };
    retry.files.push({ ...picture, key: retry.key, multiFile: retry }, { ...frames, key: retry.key, multiFile: retry });
    loader.emit(retry.files[0]);
    expect(calls.at(-1)?.[1]).toBe("pokemon_icons_1__retry3");
    const last = { key: "pokemon_icons_1__retry3", type: "atlasjson", files: [] as DownloadFile[] };
    last.files.push({ ...picture, key: last.key, multiFile: last }, { ...frames, key: last.key, multiFile: last });
    loader.emit(last.files[0]);
    expect(calls).toHaveLength(2);
  });

  it("keeps a spritesheet's frame size, and leaves sounds and other kinds alone", () => {
    const { loader, calls } = fakeLoader();
    retryFailedDownloads(loader, () => {});
    loader.emit({ key: "statuses", type: "spritesheet", url: "images/statuses.png", config: { frameWidth: 22 } });
    loader.emit({ key: "battle_wild", type: "audio", url: "audio/bgm/battle_wild.mp3" });
    expect(calls).toEqual([["spritesheet", "statuses", "images/statuses.png", { frameWidth: 22 }]]);
  });

  it("starts the loader again when it had finished (a file the battle asked for on its own)", () => {
    const { loader } = fakeLoader(false);
    retryFailedDownloads(loader, () => {});
    loader.emit({ key: "pkmn__1", type: "image", url: "images/pokemon/1.png" });
    expect(loader.starts).toBe(1);
  });
});
