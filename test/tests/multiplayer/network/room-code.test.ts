import {
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from "#app/multiplayer/network/room-code";
import { describe, expect, it } from "vitest";

describe("room-code", () => {
  describe("generateRoomCode", () => {
    it("returns a string of the configured length", () => {
      const code = generateRoomCode();
      expect(code.length).toBe(ROOM_CODE_LENGTH);
    });

    it("only uses characters from the alphabet", () => {
      for (let i = 0; i < 256; i++) {
        const code = generateRoomCode();
        for (const ch of code) {
          expect(ROOM_CODE_ALPHABET).toContain(ch);
        }
      }
    });

    it("does not contain confusable characters (0/O/1/I)", () => {
      for (let i = 0; i < 256; i++) {
        const code = generateRoomCode();
        expect(code).not.toMatch(/[01IO]/);
      }
    });

    it("returns different codes across calls", () => {
      const seen = new Set<string>();
      for (let i = 0; i < 64; i++) {
        seen.add(generateRoomCode());
      }
      expect(seen.size).toBeGreaterThan(60);
    });
  });

  describe("isValidRoomCode", () => {
    it("accepts a freshly generated code", () => {
      for (let i = 0; i < 16; i++) {
        expect(isValidRoomCode(generateRoomCode())).toBe(true);
      }
    });

    it("rejects empty string", () => {
      expect(isValidRoomCode("")).toBe(false);
    });

    it("rejects wrong length", () => {
      expect(isValidRoomCode("ABC")).toBe(false);
      expect(isValidRoomCode("ABCDEFG")).toBe(false);
    });

    it("rejects lowercase characters", () => {
      expect(isValidRoomCode("abcdef")).toBe(false);
    });

    it("rejects confusable characters", () => {
      expect(isValidRoomCode("ABCDE0")).toBe(false);
      expect(isValidRoomCode("ABCDEO")).toBe(false);
      expect(isValidRoomCode("ABCDE1")).toBe(false);
      expect(isValidRoomCode("ABCDEI")).toBe(false);
    });

    it("rejects whitespace", () => {
      expect(isValidRoomCode("ABCDE ")).toBe(false);
      expect(isValidRoomCode(" BCDEF")).toBe(false);
    });
  });

  describe("normalizeRoomCode", () => {
    it("uppercases input", () => {
      expect(normalizeRoomCode("abcdef")).toBe("ABCDEF");
    });

    it("trims whitespace", () => {
      expect(normalizeRoomCode("  ABCDEF  ")).toBe("ABCDEF");
    });

    it("combines uppercase + trim", () => {
      expect(normalizeRoomCode("\tabcdef\n")).toBe("ABCDEF");
    });

    it("normalized output passes isValidRoomCode if input was a valid code", () => {
      const original = generateRoomCode();
      const munged = `  ${original.toLowerCase()}  `;
      expect(isValidRoomCode(normalizeRoomCode(munged))).toBe(true);
    });
  });
});
