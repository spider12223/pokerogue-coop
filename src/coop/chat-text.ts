/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * The text of the chat box (D38): what a line may hold, and the filter every line goes through before it is shown, on both
 * screens (a partner found by matchmaking is a stranger, maybe a child): swear words and slurs become stars, and links
 * become "[link]". No game imports: it runs in plain Node.
 * @module
 */

/** The longest line, in characters */
export const CHAT_MAX = 120;

/**
 * A line as it may be sent and shown: no control or invisible characters (bidi overrides, zero-width joiners), white space
 * collapsed, at most {@linkcode CHAT_MAX} characters
 * @returns `null` if nothing is left
 */
export function cleanChat(raw: string): string | null {
  const text = raw
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const characters = [...text];
  const line = (characters.length > CHAT_MAX ? characters.slice(0, CHAT_MAX).join("") : text).trim();
  return line === "" ? null : line;
}

/** Endings a filtered word may have and still be caught ("fucking", "shits") */
const SUFFIXES = "(?:s|es|ed|er|ers|ing|in|y|ies)?";

/**
 * The words the filter hides, as their letters (a word is caught with letters doubled and the usual look-alikes: 4 for a,
 * 3 for e, 1 or ! for i, 0 for o, 5 or $ for s). Kept short and common: a filter is a seat belt, not a moderator.
 */
const BLOCKED = [
  "fuck",
  "motherfuck",
  "fck",
  "fuk",
  "shit",
  "bullshit",
  "bitch",
  "bastard",
  "asshole",
  "arsehole",
  "ass",
  "dick",
  "cock",
  "pussy",
  "cunt",
  "twat",
  "whore",
  "slut",
  "wank",
  "wanker",
  "prick",
  "piss",
  "porn",
  "rape",
  "rapist",
  "nigger",
  "nigga",
  "faggot",
  "fag",
  "retard",
  "tranny",
  "chink",
  "spic",
  "kike",
  "gook",
  "wetback",
  "nazi",
  "kys",
];

const LOOK_ALIKES: Record<string, string> = {
  a: "a4@",
  e: "e3",
  i: "i1!|",
  o: "o0",
  s: "s5$",
  t: "t7",
  g: "g9",
  l: "l1|",
};

/** One letter of a blocked word: itself or a look-alike, once or more */
function letter(c: string): string {
  const set = LOOK_ALIKES[c] ?? c;
  return `[${set.replace(/[\\\]^-]/g, "\\$&")}]+`;
}

/** Not a letter or a digit: where a word starts and ends (so "class" and "Cofagrigus" are left alone) */
const EDGE = "[^\\p{L}\\p{N}]";

const WORDS = new RegExp(
  `(^|${EDGE})((?:${BLOCKED.map(word => [...word].map(letter).join("")).join("|")})${SUFFIXES})(?=$|${EDGE})`,
  "giu",
);

/** "kill yourself", however it is spaced */
const PHRASES = /\bkill\s*(?:your\s*self|urself|yourselves)\b/giu;

const TLDS =
  "com|net|org|gg|io|co|me|xyz|tv|ly|app|dev|ru|uk|de|info|biz|link|site|online|top|club|shop|live|fun|games?|to|cc|be|us|ca|fr|jp|nl";

/** A web address, with or without its scheme ("discord.gg/abc", "www.x.y", "https://...") */
const LINKS = new RegExp(
  `(?:\\b(?:https?|ftp)://\\S+|\\bwww\\.\\S+|\\b[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)*\\.(?:${TLDS})\\b(?:/\\S*)?)`,
  "giu",
);

const stars = (text: string): string => "*".repeat([...text].length);

/** What a line shows: links become "[link]", blocked words become stars of their length */
export function filterChat(text: string): string {
  return text
    .replace(LINKS, "[link]")
    .replace(PHRASES, match => stars(match))
    .replace(WORDS, (_match, edge: string, word: string) => `${edge}${stars(word)}`);
}
