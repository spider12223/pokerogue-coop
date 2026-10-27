/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createReadStream } from "node:fs";
import { printable } from "../src/untrusted.ts";

/**
 * Reads the client log lines the server wrote (DECISIONS D26) and prints them as one readable timeline: both players of a
 * room together, in the order their browsers wrote them. It reads files (`LOG_DIR/client-*.jsonl`) or standard input (the output
 * of `docker logs`, where the relay's own lines are mixed in and skipped).
 *
 *     docker logs pokerogue 2>&1 | node coop-server/scripts/log-view.ts --room ABCD12
 *     node coop-server/scripts/log-view.ts ~/coop-logs/client-2026-10-26.jsonl --level warn
 *
 * Filters: `--room <code>`, `--seat host|guest`, `--session <id>`, `--kind <kind>`, `--level warn` (that level and worse),
 * `--rooms` (only list the rooms, their players and how many lines each has), `--data` (print each line's data in full).
 *
 * Everything in a client line was written by a browser: each field is printed through `printable` (a line break, an escape
 * sequence or a control character is written out, never sent to the terminal).
 */

/** The most of one field that is printed */
const FIELD_MAX = 2000;

/** A field of a client line, as it may be printed */
const show = (value: unknown, max = FIELD_MAX): string =>
  value === undefined || value === null ? "" : printable(String(value), max);

/** The relay's own lines: they carry what a client sent only escaped, and never hold a client line */
const RELAY_LINE = /\bcoop (relay|server):/;

interface Line {
  t?: string;
  src?: string;
  session?: string;
  room?: string | null;
  seat?: string | null;
  name?: string | null;
  build?: string;
  ua?: string;
  at?: string;
  n?: number;
  level?: string;
  kind?: string;
  msg?: string;
  data?: unknown;
}

const LEVELS = ["debug", "info", "warn", "error"];

function parseArgs(argv: string[]): { files: string[]; options: Map<string, string | true> } {
  const files: string[] = [];
  const options = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--") && !["rooms", "data"].includes(name)) {
        options.set(name, value);
        i++;
      } else {
        options.set(name, true);
      }
    } else {
      files.push(arg);
    }
  }
  return { files, options };
}

/**
 * The lines of the files or of standard input, split at `\n` only: `readline` also splits at U+2028 and U+2029, which
 * `JSON.stringify` leaves as they are in a string, so a client's text could cut its own line in two
 */
async function* readLines(files: string[]): AsyncGenerator<string> {
  const sources =
    files.length > 0 ? files.map(file => createReadStream(file, "utf8")) : [process.stdin.setEncoding("utf8")];
  for (const source of sources) {
    let rest = "";
    for await (const chunk of source) {
      const parts = `${rest}${String(chunk)}`.split("\n");
      rest = parts.pop() ?? "";
      for (const part of parts) {
        yield part.endsWith("\r") ? part.slice(0, -1) : part;
      }
    }
    if (rest !== "") {
      yield rest;
    }
  }
}

/**
 * A client line: a JSON object that is the whole rest of the line, after at most a prefix of the platform (a timestamp of
 * `docker logs -t`, a tag); `null` for anything else, such as a line of the relay itself
 */
function parse(raw: string): Line | null {
  const start = raw.indexOf("{");
  if (start < 0 || RELAY_LINE.test(raw.slice(0, start))) {
    return null;
  }
  try {
    const line: unknown = JSON.parse(raw.slice(start));
    return typeof line === "object" && line !== null && (line as Line).src === "client" ? (line as Line) : null;
  } catch {
    return null;
  }
}

function shortData(data: unknown, full: boolean): string {
  if (data === undefined) {
    return "";
  }
  const json = JSON.stringify(data) ?? "";
  // JSON escapes C0 controls but not C1 controls or the characters that turn text around
  return printable(json, full ? Number.POSITIVE_INFINITY : 157, true);
}

async function main(): Promise<void> {
  const { files, options } = parseArgs(process.argv.slice(2));
  const minLevel = typeof options.get("level") === "string" ? LEVELS.indexOf(options.get("level") as string) : 0;
  const matches = (line: Line): boolean =>
    (!options.has("room") || line.room === options.get("room"))
    && (!options.has("seat") || line.seat === options.get("seat"))
    && (!options.has("session") || line.session === options.get("session"))
    && (!options.has("kind") || line.kind === options.get("kind"))
    && LEVELS.indexOf(line.level ?? "info") >= minLevel;

  const rooms = new Map<string, { players: Set<string>; lines: number; first: string; last: string }>();
  const timeline: Line[] = [];
  for await (const raw of readLines(files)) {
    const line = parse(raw);
    if (line === null || !matches(line)) {
      continue;
    }
    const who = `${show(line.seat, 16) || "?"}(${show(line.name, 64) || "?"})`;
    if (options.has("rooms")) {
      const key = show(line.room, 64) || "(no room)";
      const t = show(line.t, 64);
      const room = rooms.get(key) ?? { players: new Set(), lines: 0, first: t, last: t };
      room.players.add(`${who} tab ${show(line.session, 64)}`);
      room.lines++;
      room.last = t || room.last;
      rooms.set(key, room);
      continue;
    }
    timeline.push(line);
  }
  // A batch reaches the server up to 10 s after its entries were written: the browsers' own times interleave the two players
  const when = (line: Line): string => String(line.at ?? line.t ?? "");
  timeline.sort((a, b) => when(a).localeCompare(when(b)));
  for (const line of timeline) {
    const who = `${show(line.seat, 16) || "?"}(${show(line.name, 64) || "?"})`;
    const time = show(when(line).slice(11, 23));
    const level = show(line.level, 16).toUpperCase().padEnd(5);
    const data = shortData(line.data, options.has("data"));
    console.log(
      `${time} ${show(line.room, 64) || "-"} ${who.padEnd(16)} ${level} ${show(line.kind, 64).padEnd(9)} ${show(line.msg)} ${data}`,
    );
  }
  for (const [code, room] of rooms) {
    console.log(`${code}: ${room.lines} lines, ${room.first} .. ${room.last}`);
    for (const player of room.players) {
      console.log(`  ${player}`);
    }
  }
}

void main();
