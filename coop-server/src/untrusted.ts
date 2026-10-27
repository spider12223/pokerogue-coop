/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * What a client controls and the relay must not take as it is (DECISIONS D23): the request line, its address, and any text
 * of it that may reach a log. Plain functions without Node imports, so the Worker (`coop-worker/`) uses them too.
 *
 * @module
 */

/**
 * The URL of a request, or `null` when it cannot be read (the caller answers `400`).
 * `request.url` is the target as the client wrote it in the request line. Resolved against a base, `//` and `//:` read as a
 * URL with an empty host and throw, so a target that starts with `/` is put behind a fixed host and stays a path.
 */
export function requestUrl(target: string | undefined): URL | null {
  const text = target ?? "/";
  try {
    return new URL(text.startsWith("/") ? `http://relay${text}` : text);
  } catch {
    return null;
  }
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HEXTET = /^[0-9a-f]{1,4}$/;
/** What a key of a limiter that is not an address may keep of the text */
const OTHER_MAX = 64;

/** The 8 groups of an IPv6 address (lower case, no zone), or `null` when it is not one */
function ipv6Groups(address: string): number[] | null {
  let text = address;
  const tail: number[] = [];
  // the last 32 bits may be written as IPv4 (`::ffff:1.2.3.4`)
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted !== null) {
    const octets = dotted[2]!.split(".").map(Number);
    if (octets.some(octet => octet > 255)) {
      return null;
    }
    tail.push(octets[0]! * 256 + octets[1]!, octets[2]! * 256 + octets[3]!);
    text = dotted[1]!.endsWith("::") ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  const groups = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const head = groups(halves[0]!);
  const after = halves.length === 2 ? groups(halves[1]!) : [];
  if (![...head, ...after].every(group => HEXTET.test(group))) {
    return null;
  }
  const known = head.length + after.length + tail.length;
  if (halves.length === 1 ? known !== 8 : known > 7) {
    return null;
  }
  const parse = (group: string): number => Number.parseInt(group, 16);
  return [...head.map(parse), ...new Array<number>(8 - known).fill(0), ...after.map(parse), ...tail];
}

/**
 * The key the limits and the log tags use for an address (DECISIONS D23).
 * - IPv4 as it is; an IPv4-mapped IPv6 address (`::ffff:1.2.3.4`, how a dual-stack socket shows IPv4) is that IPv4 address;
 * - IPv6 is its /64 (`2001:db8:0:1::/64`): a home or a phone gets a whole /64, so a new address in it costs nothing and
 *   would otherwise be a new player for every limit;
 * - anything else (`unknown`) as it is, clipped.
 */
export function normalizeIp(address: string): string {
  let text = address.trim().toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) {
    text = text.slice(1, -1);
  }
  const zone = text.indexOf("%");
  if (zone >= 0) {
    text = text.slice(0, zone);
  }
  if (IPV4.test(text)) {
    return text;
  }
  const groups = text.includes(":") ? ipv6Groups(text) : null;
  if (groups === null) {
    return address.slice(0, OTHER_MAX);
  }
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    const [high, low] = [groups[6]!, groups[7]!];
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map(group => group.toString(16))
    .join(":")}::/64`;
}

/** Control and format characters (a line break, an escape sequence, a character that turns the text around), and `\` */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\\]/gu;
/** The same without `\` */
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

function escapeChar(char: string): string {
  if (char === "\\") {
    return "\\\\";
  }
  const code = char.codePointAt(0) ?? 0;
  return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16)}}`;
}

/**
 * Text a client sent, made safe to print on one line of a terminal or a log: control and format characters (a line break,
 * an escape sequence, a C1 control, a bidirectional override) and `\` are written as `\xNN` or `\u{N}`, and the text is
 * clipped to `max` characters. Letters of any script stay.
 * @param keepBackslash - Leave `\` as it is, for text that is JSON already (its escapes stay readable)
 */
export function printable(text: string, max: number, keepBackslash = false): string {
  const clipped = text.length > max ? `${text.slice(0, max)}...` : text;
  return clipped.replace(keepBackslash ? CONTROL : UNSAFE, escapeChar);
}

/**
 * {@linkcode printable}, and without `{` or `}`: a line of the relay never holds a JSON object that a log reader could take
 * for a line of a client (`scripts/log-view.ts`).
 */
export function logField(text: string, max = 80): string {
  return printable(text, max).replace(/[{}]/g, escapeChar);
}
