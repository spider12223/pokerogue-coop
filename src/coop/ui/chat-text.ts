/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * The text of the chat box (D38): what a line may hold, and the filter every line goes through before it is shown, on both
 * screens (a partner found by matchmaking is a stranger, maybe a child): swear words and slurs become stars, links and email
 * addresses become "[link]", phone numbers "[number]". The filter reads a plain copy of the line (accents off, look-alike
 * letters of other alphabets mapped, letters spaced or dotted apart still read as a word) and stars the letters of the line
 * itself. No game imports: it runs in plain Node.
 * @module
 */

/** The longest line, in characters */
export const CHAT_MAX = 120;

/**
 * A line as it may be sent and shown: no control characters, no invisible ones (deleted, so one cannot split a word), at most
 * two accent marks on a letter, white space collapsed, at most {@linkcode CHAT_MAX} characters
 * @returns `null` if nothing is left
 */
export function cleanChat(raw: string): string | null {
  const text = raw
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Cc}\p{Co}\p{Cn}]/gu, " ")
    .replace(/(\p{M}{2})\p{M}+/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
  const characters = [...text];
  const line = (characters.length > CHAT_MAX ? characters.slice(0, CHAT_MAX).join("") : text).trim();
  return line === "" ? null : line;
}

/** Endings a filtered word may have and still be caught ("fucking", "bastards") */
const SUFFIXES = "(?:s|es|ed|er|ers|ing|in|y|ies|z)?";

/** Hidden wherever they are, inside other words too ("clusterfuck", "shithead", "dumbass") */
const ANYWHERE = [
  "fuck",
  "fuk",
  "fck",
  "fvck",
  "phuck",
  "shit",
  "bitch",
  "nigger",
  "nigga",
  "faggot",
  "dumbass",
  "jackass",
  "smartass",
  "asshole",
  "arsehole",
  "dickhead",
];

/** Hidden as words, with their endings */
const WITH_ENDINGS = [
  "fuq",
  "bastard",
  "whore",
  "slut",
  "wank",
  "twat",
  "pussy",
  "piss",
  "porn",
  "rape",
  "rapist",
  "retard",
  "tranny",
  "trannie",
  "fag",
  "nazi",
];

/** Hidden as whole words only: with an ending they are other words ("spicy", "cocky", "pricked") */
const EXACT = [
  "ass",
  "asses",
  "dick",
  "cock",
  "prick",
  "cunt",
  "cunts",
  "spic",
  "chink",
  "kike",
  "gook",
  "wetback",
  "kys",
];

/** Look-alike digits and signs a word may be spelled with */
const LOOK_ALIKES: Record<string, string> = {
  a: "a4@",
  e: "e3",
  i: "i1!|l",
  o: "o0",
  s: "s5$z",
  t: "t7+",
  g: "g9",
  l: "l1|i",
  u: "uv",
  c: "ck",
  k: "kc",
};

/** Letters of other alphabets that look like latin ones (Cyrillic, Greek), written as escapes */
const CONFUSABLES = new Map<string, string>([
  ["\u0430", "a"],
  ["\u0435", "e"],
  ["\u043E", "o"],
  ["\u0440", "p"],
  ["\u0441", "c"],
  ["\u0443", "y"],
  ["\u0445", "x"],
  ["\u0455", "s"],
  ["\u0456", "i"],
  ["\u0458", "j"],
  ["\u043A", "k"],
  ["\u043C", "m"],
  ["\u0442", "t"],
  ["\u043D", "h"],
  ["\u03BF", "o"],
  ["\u03B1", "a"],
  ["\u03B5", "e"],
  ["\u03B9", "i"],
  ["\u03BA", "k"],
  ["\u03BD", "v"],
  ["\u03C4", "t"],
  ["\u03C5", "u"],
  ["\u03C1", "p"],
]);

/** One letter of a blocked word: itself or a look-alike, once or more */
function letter(c: string): string {
  return `[${(LOOK_ALIKES[c] ?? c).replace(/[\\\]^-]/g, "\\$&")}]+`;
}

const tight = (words: string[]): string => words.map(word => [...word].map(letter).join("")).join("|");
/**
 * Every letter spaced or dotted apart ("f u c k", "f.u.c.k"): only that, so two words that meet are not read as one ("push
 * it" is not "sh it")
 */
const spaced = (words: string[]): string =>
  words
    .filter(word => word.length >= 3)
    .map(word => [...word].map(letter).join("[\\s._*-]{1,2}"))
    .join("|");
/** Not inside another word */
const START = "(?<![\\p{L}\\p{N}])";
const END = "(?![\\p{L}\\p{N}])";

const BLOCKED = [
  new RegExp(`(?:${tight(ANYWHERE)})${SUFFIXES}`, "gu"),
  new RegExp(`${START}(?:${tight(WITH_ENDINGS)})${SUFFIXES}${END}`, "gu"),
  new RegExp(`${START}(?:${tight(EXACT)})${END}`, "gu"),
  new RegExp(`${START}(?:${spaced([...ANYWHERE, ...WITH_ENDINGS, ...EXACT])})${END}`, "gu"),
  // "kill yourself", however it is spelled and spaced
  /kill\s*(?:your|ur|u)\s*sel(?:f|ves)/gu,
];

/** Top-level domains a bare address is caught with, without a path ("cool.xyz"); any other needs one ("x.ai/y") */
const TLDS = "com|net|org|gg|io|xyz|info|biz|site|online|club|app|dev|tk|ml|cf|gq|ru|tv|ly|ai";

const CONTACTS: [RegExp, string][] = [
  // An email address (before the bare domains, which it contains)
  [/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, "[link]"],
  // A web address with its scheme, or "www."
  [/\b(?:https?|ftp):\/\/\S+|\bwww\.\S+/giu, "[link]"],
  // A domain with a path ("x.ai/abc", "discord.gg/abc")
  [/\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[a-z]{2,}\/\S*/giu, "[link]"],
  // A bare domain of a common top-level domain ("cool.xyz", "discord.gg")
  [new RegExp(`\\b[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)*\\.(?:${TLDS})\\b`, "giu"), "[link]"],
  // "discord gg/abc", "discord dot gg abc"
  [/\bdiscord\s*(?:\.|dot)?\s*gg\b(?:\s*\/?\s*[\p{L}\p{N}]+)?/giu, "[link]"],
  // A phone number: ten digits or more, spaced or not
  [/\+?\d(?:[\s.()-]{0,2}\d){9,}/gu, "[number]"],
];

/** The plain copy the words are read in, with where each of its letters came from in the line */
function plain(text: string): { text: string; from: number[]; to: number[] } {
  const out: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  let index = 0;
  for (const character of text) {
    const end = index + character.length;
    const base = character.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    for (const part of base) {
      out.push(CONFUSABLES.get(part) ?? part);
      from.push(index);
      to.push(end);
    }
    index = end;
  }
  return { text: out.join(""), from, to };
}

/** Stars over the letters of `text` whose plain copy is a blocked word */
function starWords(text: string): string {
  const view = plain(text);
  const spans: [number, number][] = [];
  for (const pattern of BLOCKED) {
    for (const match of view.text.matchAll(pattern)) {
      const start = match.index;
      const found = match[0];
      // Digits and signs alone are not a word ("455", "$$$")
      if (found === "" || (found.match(/[a-z]/g)?.length ?? 0) < 2) {
        continue;
      }
      spans.push([view.from[start], view.to[start + found.length - 1]]);
    }
  }
  if (spans.length === 0) {
    return text;
  }
  spans.sort((a, b) => a[0] - b[0]);
  let shown = "";
  let at = 0;
  for (const [start, end] of spans) {
    if (end <= at) {
      continue;
    }
    const from = Math.max(start, at);
    shown += text.slice(at, from) + "*".repeat([...text.slice(from, end)].length);
    at = end;
  }
  return shown + text.slice(at);
}

/** What a line shows: links and contacts replaced, blocked words starred */
export function filterChat(text: string): string {
  let shown = text;
  for (const [pattern, replacement] of CONTACTS) {
    shown = shown.replace(pattern, replacement);
  }
  return starWords(shown);
}
