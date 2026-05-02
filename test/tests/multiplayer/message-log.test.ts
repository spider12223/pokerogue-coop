import { MessageLog } from "#app/multiplayer/message-log";
import { describe, expect, it } from "vitest";

describe("MessageLog", () => {
  it("starts empty", () => {
    const log = new MessageLog();
    expect(log.getRecent(5)).toEqual([]);
  });

  it("append stores a message", () => {
    const log = new MessageLog();
    log.append("hello");
    expect(log.getRecent(5)).toEqual(["hello"]);
  });

  it("getRecent(n) returns the last n messages in chronological order", () => {
    const log = new MessageLog();
    log.append("first");
    log.append("second");
    log.append("third");
    expect(log.getRecent(2)).toEqual(["second", "third"]);
    expect(log.getRecent(10)).toEqual(["first", "second", "third"]);
  });

  it("respects the capacity (defaults to 10) and trims oldest", () => {
    const log = new MessageLog();
    for (let i = 0; i < 15; i++) {
      log.append(`msg-${i}`);
    }
    const recent = log.getRecent(20);
    expect(recent).toHaveLength(10);
    expect(recent[0]).toBe("msg-5");
    expect(recent[9]).toBe("msg-14");
  });

  it("respects a custom capacity", () => {
    const log = new MessageLog(3);
    log.append("a");
    log.append("b");
    log.append("c");
    log.append("d");
    expect(log.getRecent(10)).toEqual(["b", "c", "d"]);
  });

  it("ignores non-string and empty values", () => {
    const log = new MessageLog();
    log.append("");
    log.append(null as unknown as string);
    log.append(undefined as unknown as string);
    log.append(42 as unknown as string);
    log.append("real");
    expect(log.getRecent(10)).toEqual(["real"]);
  });

  it("clear() empties the buffer", () => {
    const log = new MessageLog();
    log.append("a");
    log.append("b");
    log.clear();
    expect(log.getRecent(10)).toEqual([]);
  });
});
