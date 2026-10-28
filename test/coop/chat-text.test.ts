/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { CHAT_MAX, cleanChat, filterChat } from "#coop/chat-text";
import { describe, expect, it } from "vitest";

describe("Co-op: the chat box's text (D38)", () => {
  describe("a line", () => {
    it("loses control and invisible characters, and collapses white space", () => {
      expect(cleanChat("  hi\tthere \n friend  ")).toBe("hi there friend");
      // a right-to-left override and a zero-width space are deleted: they cannot split a word
      expect(cleanChat("ab‮cd​ef")).toBe("abcdef");
      expect(cleanChat("bell\u0007")).toBe("bell");
      // at most two marks on a letter (no text that draws over the lines around it)
      expect(cleanChat(`Za${"́".repeat(30)}lgo`)).toBe("Zá́́lgo");
    });

    it("is at most the limit, and nothing is no line", () => {
      expect([...cleanChat("x".repeat(500))!]).toHaveLength(CHAT_MAX);
      expect(cleanChat("   ")).toBeNull();
      expect(cleanChat("​​")).toBeNull();
    });

    it("keeps letters of every language", () => {
      expect(cleanChat("¡Hola! こんにちは Привет")).toBe("¡Hola! こんにちは Привет");
    });
  });

  describe("the filter", () => {
    it("stars swear words and slurs, with their endings and look-alikes", () => {
      expect(filterChat("what the fuck")).toBe("what the ****");
      expect(filterChat("SHIT happens")).toBe("**** happens");
      expect(filterChat("fucking hell")).toBe("******* hell");
      expect(filterChat("sh1t b!tch fuuuck")).toBe("**** ***** ******");
      expect(filterChat("you f@g")).toBe("you ***");
      expect(filterChat("kys")).toBe("***");
      expect(filterChat("just kill yourself")).toBe("just *************");
    });

    it("sees through the usual ways around it", () => {
      // inside other words
      expect(filterChat("dumbass")).toBe("*******");
      expect(filterChat("you shithead")).toBe("you ****head");
      expect(filterChat("clusterfuck")).toBe("cluster****");
      expect(filterChat("fuckface")).toBe("****face");
      // spaced or dotted apart
      expect(filterChat("f u c k off")).toBe("******* off");
      expect(filterChat("f.u.c.k")).toBe("*******");
      expect(filterChat("k y s")).toBe("*****");
      // accents, other alphabets' look-alikes, invisible characters
      expect(filterChat("fúck")).toBe("****");
      expect(filterChat("fuсk")).toBe("****");
      expect(filterChat(cleanChat("f​u​ck")!)).toBe("****");
      // misspellings
      expect(filterChat("fvck fuq")).toBe("**** ***");
      expect(filterChat("kill ur self")).toBe("************");
    });

    it("leaves words that only contain one alone", () => {
      for (const fine of [
        "class",
        "assassin",
        "Cofagrigus",
        "Scunthorpe",
        "cockatoo",
        "Dickens",
        "grass",
        "pass the ball",
      ]) {
        expect(filterChat(fine)).toBe(fine);
      }
    });

    it("leaves ordinary words and numbers alone", () => {
      for (const fine of ["spicy berries", "a cocky one", "it pricked", "push it", "finish it", "455 damage", "900k"]) {
        expect(filterChat(fine)).toBe(fine);
      }
    });

    it("hides links, addresses and phone numbers", () => {
      expect(filterChat("join discord.gg/abc123 now")).toBe("join [link] now");
      expect(filterChat("see https://example.org/x?y=1")).toBe("see [link]");
      expect(filterChat("www.something.net")).toBe("[link]");
      expect(filterChat("my site is cool.xyz")).toBe("my site is [link]");
      expect(filterChat("x.ai/abc")).toBe("[link]");
      expect(filterChat("join discord gg/abc")).toBe("join [link]");
      expect(filterChat("mail me at kid@example.com")).toBe("mail me at [link]");
      expect(filterChat("call 555 123 4567")).toBe("call [number]");
    });

    it("does not take a missing space for a link", () => {
      for (const fine of ["ok.me too", "fine.Be careful", "go.to the shop", "have.fun"]) {
        expect(filterChat(fine)).toBe(fine);
      }
    });

    it("leaves numbers and ordinary dots alone", () => {
      expect(filterChat("it did 3.5x damage, e.g. a lot.")).toBe("it did 3.5x damage, e.g. a lot.");
      expect(filterChat("gg wp")).toBe("gg wp");
    });
  });
});
