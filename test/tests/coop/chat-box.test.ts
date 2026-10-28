/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { chatInfo, startChat, stopChat, toggleChat } from "#coop/chat";
import { CoopLink } from "#coop/link";
import { createLoopbackPair } from "#coop/transport/loopback";
import { ReliableTransport } from "#coop/transport/reliable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The chat box (D38) over a link, as both players see it: what is sent is filtered on both screens, the game hears no key
 * typed in the box, and the partner can be muted.
 */
describe("Co-op: the chat box (D38)", () => {
  let mine: CoopLink;
  let theirs: CoopLink;
  let heard: string[];

  const root = (): HTMLElement => document.getElementById("coopChat")!;
  const input = (): HTMLInputElement => root().querySelector(".coop-chat-input")!;
  const say = (text: string): void => {
    input().value = text;
    root()
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
  };

  beforeEach(() => {
    const [near, far] = createLoopbackPair();
    mine = new CoopLink({
      seat: "host",
      reliable: new ReliableTransport(near),
      names: { mine: "Sam", theirs: "Alex" },
    });
    theirs = new CoopLink({
      seat: "guest",
      reliable: new ReliableTransport(far),
      names: { mine: "Alex", theirs: "Sam" },
    });
    heard = [];
    theirs.onChat(chat => heard.push(chat.text));
    startChat(mine, "Sam");
  });

  afterEach(() => {
    stopChat();
    mine.close();
    theirs.close();
  });

  it("is there for the session, closed, with the rules on top", () => {
    expect(root().hidden).toBe(false);
    expect(chatInfo()).toMatchObject({ open: false, muted: false, unread: 0 });
    expect(chatInfo()!.lines[0]).toContain("swear words and links are hidden");
    stopChat();
    expect(root().hidden).toBe(true);
    expect(chatInfo()).toBeNull();
  });

  it("sends a line, and both screens show it filtered", async () => {
    toggleChat();
    say("what the fuck");
    expect(chatInfo()!.lines.at(-1)).toBe("Sam: what the ****");
    await vi.waitUntil(() => heard.length === 1, { timeout: 2000, interval: 5 });
    // the partner's client gets the line as typed, and filters it when it shows it
    expect(heard).toEqual(["what the fuck"]);
    expect(input().value).toBe("");
  });

  it("shows the partner's line, and counts it while the box is closed", async () => {
    theirs.sendChat("hi sh1t, see discord.gg/abc");
    await vi.waitUntil(() => chatInfo()!.unread === 1, { timeout: 2000, interval: 5 });
    expect(chatInfo()!.lines.at(-1)).toBe("Alex: hi ****, see [link]");
    expect(root().querySelector(".coop-chat-toast")?.textContent).toBe("Alex: hi ****, see [link]");
    expect(root().querySelector(".coop-chat-toggle")?.textContent).toBe("Chat (1)");
    toggleChat();
    expect(chatInfo()!.unread).toBe(0);
    expect(root().querySelector(".coop-chat-toast")).toBeNull();
  });

  it("keeps every key typed in the box from the game, and Esc closes it", () => {
    const game = vi.fn();
    window.addEventListener("keydown", game);
    try {
      toggleChat();
      for (const key of ["z", "x", " ", "ArrowUp", "Enter", "b"]) {
        input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      }
      expect(game).not.toHaveBeenCalled();
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(game).not.toHaveBeenCalled();
      expect(chatInfo()!.open).toBe(false);
    } finally {
      window.removeEventListener("keydown", game);
    }
  });

  it("mutes the partner: their lines are not shown", async () => {
    toggleChat();
    (root().querySelector(".coop-chat-mute") as HTMLButtonElement).click();
    expect(chatInfo()!.muted).toBe(true);
    theirs.sendChat("can you see this?");
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(chatInfo()!.lines.some(line => line.includes("can you see this"))).toBe(false);
  });

  it("asks a player who sends too fast to slow down", () => {
    toggleChat();
    for (const text of ["one", "two", "three", "four"]) {
      say(text);
    }
    expect(chatInfo()!.lines.slice(-2)).toEqual(["Sam: three", "Slow down a little."]);
    // what did not go stays in the box
    expect(input().value).toBe("four");
  });
});
