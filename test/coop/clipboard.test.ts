/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { type ClipboardEnv, copyText } from "#coop/clipboard";
import { describe, expect, it } from "vitest";

/** The copy button of the lobby: the clipboard of the browser, and the older way where it is not allowed */

function pageWithOldCopy(result: boolean | Error) {
  const calls: string[] = [];
  const env: ClipboardEnv = {
    document: {
      createElement: () => {
        const field = {
          value: "",
          style: {} as Record<string, string>,
          setAttribute: () => undefined,
          select: () => calls.push(`select ${field.value}`),
          remove: () => calls.push("remove"),
        };
        return field;
      },
      body: { appendChild: () => calls.push("append") },
      execCommand: () => {
        if (result instanceof Error) {
          throw result;
        }
        calls.push("copy");
        return result;
      },
    },
  };
  return { env, calls };
}

describe("copyText", () => {
  it("uses the clipboard of the browser when there is one", async () => {
    const written: string[] = [];
    const env: ClipboardEnv = {
      navigator: { clipboard: { writeText: async text => void written.push(text) } },
    };
    await expect(copyText("ABC234", env)).resolves.toBe(true);
    expect(written).toEqual(["ABC234"]);
  });

  it("copies the older way when the clipboard refuses (a plain http page, no permission)", async () => {
    const { env, calls } = pageWithOldCopy(true);
    env.navigator = {
      clipboard: {
        writeText: async () => {
          throw new Error("NotAllowedError");
        },
      },
    };
    await expect(copyText("ABC234", env)).resolves.toBe(true);
    expect(calls).toEqual(["append", "select ABC234", "copy", "remove"]);
  });

  it("copies the older way where there is no clipboard at all", async () => {
    const { env } = pageWithOldCopy(true);
    await expect(copyText("XYZ789", env)).resolves.toBe(true);
  });

  it("says no, and cleans up, when the page does not copy; and when nothing is there to try", async () => {
    const refused = pageWithOldCopy(false);
    await expect(copyText("ABC234", refused.env)).resolves.toBe(false);
    expect(refused.calls.at(-1)).toBe("remove");
    await expect(copyText("ABC234", pageWithOldCopy(new Error("no")).env)).resolves.toBe(false);
    await expect(copyText("ABC234", {})).resolves.toBe(false);
  });
});
