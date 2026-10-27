/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

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
 */

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

async function* readLines(files: string[]): AsyncGenerator<string> {
  const sources = files.length > 0 ? files.map(file => createReadStream(file, "utf8")) : [process.stdin];
  for (const source of sources) {
    for await (const line of createInterface({ input: source, crlfDelay: Number.POSITIVE_INFINITY })) {
      yield line;
    }
  }
}

/** A client line (it may follow a timestamp of `docker logs -t`), or `null` for anything else */
function parse(raw: string): Line | null {
  const start = raw.indexOf("{");
  if (start < 0) {
    return null;
  }
  try {
    const line = JSON.parse(raw.slice(start)) as Line;
    return line.src === "client" ? line : null;
  } catch {
    return null;
  }
}

function shortData(data: unknown, full: boolean): string {
  if (data === undefined) {
    return "";
  }
  const json = JSON.stringify(data);
  return full || json.length <= 160 ? json : `${json.slice(0, 157)}...`;
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
    const who = `${line.seat ?? "?"}(${line.name ?? "?"})`;
    if (options.has("rooms")) {
      const key = line.room ?? "(no room)";
      const room = rooms.get(key) ?? { players: new Set(), lines: 0, first: line.t ?? "", last: line.t ?? "" };
      room.players.add(`${who} tab ${line.session}`);
      room.lines++;
      room.last = line.t ?? room.last;
      rooms.set(key, room);
      continue;
    }
    timeline.push(line);
  }
  // A batch reaches the server up to 10 s after its entries were written: the browsers' own times interleave the two players
  timeline.sort((a, b) => (a.at ?? a.t ?? "").localeCompare(b.at ?? b.t ?? ""));
  for (const line of timeline) {
    const who = `${line.seat ?? "?"}(${line.name ?? "?"})`;
    const time = (line.at ?? line.t ?? "").slice(11, 23);
    const level = (line.level ?? "").toUpperCase().padEnd(5);
    const data = shortData(line.data, options.has("data"));
    console.log(
      `${time} ${line.room ?? "-"} ${who.padEnd(16)} ${level} ${(line.kind ?? "").padEnd(9)} ${line.msg ?? ""} ${data}`,
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
