/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { sourceUrlOf } from "#coop/source-link";
import { describe, expect, it } from "vitest";
import { checkSourceUrl, isSourceUrl, requireSourceUrl } from "../../plugins/vite/require-source-url.ts";

/** The source link of the title screen and the build that insists on it (DECISIONS D25) */
describe("the source link", () => {
  it("is the address the build was given, and nothing where there is none", () => {
    expect(sourceUrlOf("https://github.com/you/pokerogue-coop")).toBe("https://github.com/you/pokerogue-coop");
    expect(sourceUrlOf("  https://git.example.org/coop/  ")).toBe("https://git.example.org/coop/");
    expect(sourceUrlOf(undefined)).toBeNull();
    expect(sourceUrlOf("")).toBeNull();
    expect(sourceUrlOf("   ")).toBeNull();
  });

  it("is only ever a web address", () => {
    expect(sourceUrlOf("javascript:alert(1)")).toBeNull();
    expect(sourceUrlOf("data:text/html,<script>1</script>")).toBeNull();
    expect(sourceUrlOf("github.com/you/repo")).toBeNull();
    expect(sourceUrlOf("file:///etc/passwd")).toBeNull();
  });
});

describe("the build that needs it", () => {
  it("accepts an http(s) address", () => {
    expect(isSourceUrl("https://github.com/you/pokerogue-coop")).toBe(true);
    expect(isSourceUrl("http://localhost:3000/repo")).toBe(true);
    expect(isSourceUrl("ftp://example.org")).toBe(false);
    expect(isSourceUrl("not a url")).toBe(false);
    expect(isSourceUrl(undefined)).toBe(false);
  });

  it("stops a production build that has none, and says what to do", () => {
    expect(() => checkSourceUrl("production", undefined)).toThrow(/VITE_SOURCE_URL is not set/);
    expect(() => checkSourceUrl("production", "")).toThrow(/VITE_SOURCE_URL/);
    expect(() => checkSourceUrl("production", "javascript:alert(1)")).toThrow(/VITE_SOURCE_URL/);
  });

  it("lets a production build with one go, and development, test and beta builds without", () => {
    expect(() => checkSourceUrl("production", "https://github.com/you/pokerogue-coop")).not.toThrow();
    for (const mode of ["development", "test", "beta", "app"]) {
      expect(() => checkSourceUrl(mode, undefined)).not.toThrow();
    }
  });

  it("is a plugin of the build, and not of the dev server", () => {
    const plugin = requireSourceUrl();
    expect(plugin.name).toBe("coop-require-source-url");
    expect(plugin.apply).toBe("build");
  });
});
