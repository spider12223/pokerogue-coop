/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Copy text to the clipboard (the room code of the lobby). The clipboard of the browser needs a secure page (`https`
 * or `localhost`) and the permission of the user; the older way, a text field that is selected and copied, works on a plain
 * `http` page (a game on a home network, say).
 *
 * @module
 */

/** What the copy needs of the page; the page itself by default, a stand-in in a test */
export interface ClipboardEnv {
  navigator?: { clipboard?: { writeText(text: string): Promise<void> } };
  document?: {
    createElement(tag: "textarea"): {
      value: string;
      style: Record<string, string>;
      setAttribute(name: string, value: string): void;
      select(): void;
      remove(): void;
    };
    body: { appendChild(node: unknown): unknown };
    execCommand(command: "copy"): boolean;
  };
}

/** @returns Whether the text was copied */
export async function copyText(
  text: string,
  env: ClipboardEnv = globalThis as unknown as ClipboardEnv,
): Promise<boolean> {
  try {
    if (env.navigator?.clipboard !== undefined) {
      await env.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // not allowed here: the older way may be
  }
  try {
    const doc = env.document;
    if (doc === undefined) {
      return false;
    }
    const field = doc.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style["position"] = "fixed";
    field.style["opacity"] = "0";
    doc.body.appendChild(field);
    field.select();
    const copied = doc.execCommand("copy");
    field.remove();
    return copied;
  } catch {
    return false;
  }
}
