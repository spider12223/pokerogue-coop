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
      // a right-to-left override and a zero-width space
      expect(cleanChat("ab‮cd​ef")).toBe("ab cd ef");
      expect(cleanChat("bell\u0007")).toBe("bell");
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

    it("hides links, with or without their scheme", () => {
      expect(filterChat("join discord.gg/abc123 now")).toBe("join [link] now");
      expect(filterChat("see https://example.org/x?y=1")).toBe("see [link]");
      expect(filterChat("www.something.net")).toBe("[link]");
      expect(filterChat("my site is cool.xyz")).toBe("my site is [link]");
    });

    it("leaves numbers and ordinary dots alone", () => {
      expect(filterChat("it did 3.5x damage, e.g. a lot.")).toBe("it did 3.5x damage, e.g. a lot.");
      expect(filterChat("gg wp")).toBe("gg wp");
    });
  });
});
