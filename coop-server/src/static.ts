/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { gzip } from "node:zlib";

/**
 * The static files of the production build (DECISIONS D22): `dist/` as it is, with the cache rules of the deploy.
 * - A file under `assets/` whose name carries Vite's content hash never changes: `immutable`, a year.
 * - Everything else (`index.html`, the game's data, images and sounds) is `no-cache` with an `ETag`: the browser asks every
 *   time and gets a `304` while the file is the same, so a new image is picked up at once.
 * Text files are sent gzipped when the browser accepts it (the gzipped copy is kept in memory).
 *
 * @module
 */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

/** What is worth gzipping */
const COMPRESSIBLE = /^(text\/|application\/(json|xml|manifest\+json|wasm)|image\/svg)/;
const COMPRESS_MIN_BYTES = 1024;
const COMPRESS_MAX_BYTES = 32 * 1024 * 1024;
const CACHE_MAX_BYTES = 128 * 1024 * 1024;

/** `assets/name-<hash>.ext`: a name Vite derived from the content */
const HASHED = /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

export const IMMUTABLE = "public, max-age=31536000, immutable";
export const REVALIDATE = "no-cache";

export interface StaticOptions {
  /** The directory to serve (`dist/`) */
  root: string;
}

export interface StaticHandler {
  /** Answer a request for a file. Always ends the response. */
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  /** Bytes of gzipped files kept in memory */
  readonly cachedBytes: number;
}

/** @returns The `Cache-Control` of a file, by its URL path */
export function cacheControlFor(urlPath: string): string {
  return HASHED.test(urlPath) ? IMMUTABLE : REVALIDATE;
}

/**
 * @returns The path of the file under `root` that a URL path names, or `null` if it names something outside it
 */
export function resolveUnder(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    return null;
  }
  const absolute = resolve(root, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  const base = resolve(root);
  return absolute === base || absolute.startsWith(base + sep) ? absolute : null;
}

function respond(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end(text);
}

export function createStaticHandler(options: StaticOptions): StaticHandler {
  const root = resolve(options.root);
  const gzipped = new Map<string, Buffer>();
  let cachedBytes = 0;

  const compressed = async (key: string, file: string): Promise<Buffer> => {
    const known = gzipped.get(key);
    if (known !== undefined) {
      return known;
    }
    const raw = await readFile(file);
    const packed = await new Promise<Buffer>((done, fail) =>
      gzip(raw, { level: 6 }, (error, result) => (error ? fail(error) : done(result))),
    );
    while (cachedBytes + packed.length > CACHE_MAX_BYTES && gzipped.size > 0) {
      const oldest = gzipped.keys().next().value as string;
      cachedBytes -= gzipped.get(oldest)?.length ?? 0;
      gzipped.delete(oldest);
    }
    gzipped.set(key, packed);
    cachedBytes += packed.length;
    return packed;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      respond(response, 405, "Method not allowed");
      return;
    }
    const url = new URL(request.url ?? "/", "http://placeholder");
    const urlPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = resolveUnder(root, urlPath);
    if (file === null) {
      respond(response, 400, "Bad request");
      return;
    }
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(file);
    } catch {
      respond(response, 404, "Not found");
      return;
    }
    if (!info.isFile()) {
      respond(response, 404, "Not found");
      return;
    }

    const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    const etag = `W/"${info.size.toString(16)}-${Math.floor(Number(info.mtimeMs)).toString(16)}"`;
    const headers: Record<string, string> = {
      "content-type": type,
      "cache-control": cacheControlFor(urlPath),
      etag,
      "last-modified": info.mtime.toUTCString(),
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    };
    const compress = COMPRESSIBLE.test(type) && info.size >= COMPRESS_MIN_BYTES && info.size <= COMPRESS_MAX_BYTES;
    if (compress) {
      headers["vary"] = "Accept-Encoding";
    }

    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, headers);
      response.end();
      return;
    }

    const acceptsGzip = compress && /\bgzip\b/.test(String(request.headers["accept-encoding"] ?? ""));
    try {
      if (acceptsGzip) {
        const body = await compressed(`${file}|${etag}`, file);
        headers["content-encoding"] = "gzip";
        headers["content-length"] = String(body.length);
        response.writeHead(200, headers);
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }
      headers["content-length"] = String(info.size);
      response.writeHead(200, headers);
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = createReadStream(file);
      stream.on("error", () => response.destroy());
      stream.pipe(response);
    } catch {
      if (response.headersSent) {
        response.destroy();
      } else {
        respond(response, 500, "Server error");
      }
    }
  };

  return {
    handle,
    get cachedBytes() {
      return cachedBytes;
    },
  };
}
