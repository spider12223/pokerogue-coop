/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { CHAT_MAX, cleanChat, filterChat } from "#coop/chat-text";
import { chatKeyName } from "#coop/hotkey-names";
import type { CoopLink } from "#coop/link";
import { coopText } from "#coop/text";
import { Button } from "#enums/buttons";
import { Device } from "#enums/devices";
import { UiMode } from "#enums/ui-mode";
import { getButtonWithKeycode } from "#inputs/config-handler";

/**
 * The chat box (D38): a small panel over the game, in every linked session (the lobby, the starter select, the run, the end
 * screen). Lines go to the partner on the link (`CHAT`), outside the simulation. Every line, the partner's and this player's
 * own, is shown through the filter of `chat-text.ts`, and the partner can be muted. While the box has the keyboard, the
 * game gets no key: the box stops each key event before the game's listener on the window hears it. The chat key itself is
 * caught on the page, before the game, too: the game never holds it down (a key whose release went to the box would stay
 * held, and the game repeats a held key).
 *
 * It is the page's (HTML, not the game's canvas): the text is the player's own, written with `textContent` only.
 * @module
 */

const ROOT_ID = "coopChat";
/** Lines kept in the box */
const HISTORY = 50;
/** How long a line stays in the corner while the box is closed */
const TOAST_MS = 6000;
const TOASTS_MAX = 3;
/** Sending: three at once, then one every 1.5 s */
const SEND_BURST = 3;
const SEND_EVERY_MS = 1500;
/** Receiving: what a partner who floods gets through (an honest one keeps to the sending limit) */
const RECEIVE_BURST = 5;
const RECEIVE_EVERY_MS = 1000;

/** A token bucket on the clock of the page: the chat is not part of the run */
class Bucket {
  private tokens: number;
  private last = clock();
  constructor(
    private readonly burst: number,
    private readonly everyMs: number,
  ) {
    this.tokens = burst;
  }
  take(): boolean {
    const now = clock();
    this.tokens = Math.min(this.burst, this.tokens + (now - this.last) / this.everyMs);
    this.last = now;
    if (this.tokens < 1) {
      return false;
    }
    this.tokens--;
    return true;
  }
}

/** The page's clock, for the chat's limits only (never read by a run; it does not jump with the computer's clock) */
function clock(): number {
  return performance.now();
}

/** Who this tab muted (D38): a muted partner stays muted in a new game with them, and after a reload */
const MUTED_KEY = "coopChatMuted";

function mutedNames(): string[] {
  try {
    const names: unknown = JSON.parse(sessionStorage.getItem(MUTED_KEY) ?? "[]");
    return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

function rememberMuted(name: string, muted: boolean): void {
  try {
    const names = mutedNames().filter(other => other !== name);
    sessionStorage.setItem(MUTED_KEY, JSON.stringify(muted ? [...names, name].slice(-20) : names));
  } catch {
    // Storage off: the mute lasts as long as the session
  }
}

interface Parts {
  root: HTMLElement;
  toggle: HTMLButtonElement;
  toasts: HTMLElement;
  panel: HTMLElement;
  title: HTMLElement;
  mute: HTMLButtonElement;
  log: HTMLElement;
  input: HTMLInputElement;
}

interface Chat {
  link: CoopLink;
  /** This player's name and the partner's (D1) */
  mine: string;
  partner: string;
  muted: boolean;
  unread: number;
  open: boolean;
  sending: Bucket;
  receiving: Bucket;
  stop: () => void;
}

let parts: Parts | null = null;
let chat: Chat | null = null;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** Keys pressed in the box: their release goes nowhere else either, even when the box has closed meanwhile (Esc, Enter) */
const pressedInBox = new Set<string>();
/** The chat key while it is held: its repeats and its release go nowhere (they would type into the line it opened) */
let heldChatKey: string | null = null;

/**
 * The game must not hear a key that goes into the box (its listener is on the window, after the box), nor the release of
 * one: the game takes a release it never saw pressed for another held key's
 */
function keepKeysFromGame(panel: HTMLElement): void {
  for (const type of ["keydown", "keyup", "keypress"] as const) {
    panel.addEventListener(type, event => {
      event.stopPropagation();
      if (event.type === "keydown") {
        pressedInBox.add((event as KeyboardEvent).code);
      }
    });
  }
  window.addEventListener(
    "keydown",
    event => {
      // Pressed outside the box, the key is the game's again, its release too
      if (!(event.target instanceof Node && panel.contains(event.target))) {
        pressedInBox.delete(event.code);
      }
    },
    true,
  );
  window.addEventListener(
    "keyup",
    event => {
      if (pressedInBox.delete(event.code)) {
        event.stopPropagation();
      }
    },
    true,
  );
  window.addEventListener("blur", () => {
    pressedInBox.clear();
    heldChatKey = null;
  });
}

/** The toggle must not keep the focus: the next Enter or Space is the game's */
function onClick(button: HTMLButtonElement, action: () => void): void {
  button.addEventListener("click", () => {
    button.blur();
    action();
  });
}

/** A field the player types in (the chat's line, the game's own forms): its keys are letters, not the chat key */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement
    && (target.isContentEditable
      || target.tagName === "INPUT"
      || target.tagName === "TEXTAREA"
      || target.tagName === "SELECT")
  );
}

/** Whether the key is the one the player bound to the chat ("Co-op: chat", H at first) */
function isChatKey(event: KeyboardEvent): boolean {
  try {
    const controller = globalScene.inputController;
    // The game reads its keyboard mapping at its first key: this may come first
    controller?.ensureKeyboardIsInit();
    const config = controller?.getActiveConfig(Device.KEYBOARD);
    return config != null && getButtonWithKeycode(config, event.keyCode) === Button.COOP_CHAT;
  } catch {
    return false;
  }
}

/** The keyboard settings are waiting for a key to bind: the chat key is only a key there */
function isBindingKeys(): boolean {
  try {
    return globalScene.ui?.mode === UiMode.KEYBOARD_BINDING;
  } catch {
    return false;
  }
}

/** The chat key, on the page before the game: it opens or closes the box, and the game never sees it */
function onChatKey(event: KeyboardEvent): void {
  if (heldChatKey !== null && event.code === heldChatKey && (event.type === "keyup" || event.repeat)) {
    if (event.type === "keyup") {
      heldChatKey = null;
    }
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (
    chat === null
    || event.type !== "keydown"
    || event.repeat
    || event.ctrlKey
    || event.metaKey
    || event.altKey
    || isTyping(event.target)
    || isBindingKeys()
    || !isChatKey(event)
  ) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  heldChatKey = event.code;
  setOpen(!chat.open);
}

function build(): Parts {
  const root = element("div", "coop-chat");
  root.id = ROOT_ID;
  root.hidden = true;
  const toggle = element("button", "coop-chat-toggle");
  toggle.type = "button";
  const toasts = element("div", "coop-chat-toasts");
  toasts.setAttribute("aria-live", "polite");
  const panel = element("div", "coop-chat-panel");
  panel.hidden = true;
  const head = element("div", "coop-chat-head");
  const title = element("span", "coop-chat-title");
  const mute = element("button", "coop-chat-mute");
  mute.type = "button";
  const close = element("button", "coop-chat-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", coopText("chatClose", "Close the chat"));
  head.append(title, mute, close);
  const log = element("ol", "coop-chat-log");
  log.setAttribute("role", "log");
  // A click in it (to select a line) keeps the focus in the box
  log.tabIndex = -1;
  const form = element("form", "coop-chat-form");
  const input = element("input", "coop-chat-input");
  input.type = "text";
  input.maxLength = CHAT_MAX;
  input.autocomplete = "off";
  input.spellcheck = true;
  input.placeholder = coopText("chatPlaceholder", "Say something… (Enter sends, Esc closes)");
  const send = element("button", "coop-chat-send", coopText("chatSend", "Send"));
  send.type = "submit";
  form.append(input, send);
  panel.append(head, log, form);
  root.append(toggle, toasts, panel);
  document.body.append(root);

  keepKeysFromGame(panel);
  panel.addEventListener("keydown", event => {
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      setOpen(false);
    }
  });
  // A button or the panel itself does not take the focus from the line (the line keeps the keyboard)
  panel.addEventListener("mousedown", event => {
    if (event.target !== input && !(event.target instanceof Node && log.contains(event.target))) {
      event.preventDefault();
    }
  });
  // The keyboard left the box (a click on the game, a tab): the box closes, so it never shows "Enter sends" to keys that are
  // the game's. A page that lost the focus altogether (another window) keeps it open.
  panel.addEventListener("focusout", () => {
    setTimeout(() => {
      if (chat?.open && document.hasFocus() && !panel.contains(document.activeElement)) {
        setOpen(false);
      }
    }, 0);
  });
  // A game key held when the line takes the keyboard would be held for good: its release goes into the box
  input.addEventListener("focus", () => releaseGameKeys());
  form.addEventListener("submit", event => {
    event.preventDefault();
    const text = input.value;
    if (text.trim() === "") {
      // An empty Enter closes the box, as in most games
      setOpen(false);
      return;
    }
    if (sendLine(text)) {
      input.value = "";
    }
  });
  window.addEventListener("keydown", onChatKey, true);
  window.addEventListener("keyup", onChatKey, true);
  onClick(toggle, () => setOpen(!(chat?.open ?? false)));
  close.addEventListener("click", () => setOpen(false));
  mute.addEventListener("click", () => {
    setMuted(!(chat?.muted ?? false));
    input.focus();
  });
  return { root, toggle, toasts, panel, title, mute, log, input };
}

/** The toggle's label: the key that opens the box, and the lines that came while it was closed */
function drawToggle(): void {
  if (parts === null || chat === null) {
    return;
  }
  const key = chatKeyName();
  const label = coopText("chatButton", "Chat");
  parts.toggle.textContent = chat.unread > 0 ? `${label} (${chat.unread})` : label;
  parts.toggle.title = key === null ? label : `${label} (${key})`;
  parts.toggle.classList.toggle("coop-chat-unread", chat.unread > 0);
}

function drawHead(): void {
  if (parts === null || chat === null) {
    return;
  }
  parts.title.textContent = coopText("chatTitle", "Chat with {{partner}}", { partner: chat.partner });
  parts.mute.textContent = chat.muted ? coopText("chatUnmute", "Unmute") : coopText("chatMute", "Mute");
}

type Who = "me" | "partner" | "note";

function addLine(who: Who, text: string): void {
  if (parts === null || chat === null) {
    return;
  }
  const item = element("li", `coop-chat-line coop-chat-${who}`);
  if (who !== "note") {
    item.append(element("span", "coop-chat-name", `${who === "me" ? chat.mine : chat.partner}: `));
  }
  item.append(document.createTextNode(text));
  parts.log.append(item);
  while (parts.log.childElementCount > HISTORY) {
    parts.log.firstElementChild?.remove();
  }
  parts.log.scrollTop = parts.log.scrollHeight;
}

/** While the box is closed, a line of the partner shows in the corner for a few seconds */
function toast(text: string): void {
  if (parts === null || chat === null) {
    return;
  }
  const item = element("div", "coop-chat-toast");
  item.append(element("span", "coop-chat-name", `${chat.partner}: `), document.createTextNode(text));
  parts.toasts.append(item);
  while (parts.toasts.childElementCount > TOASTS_MAX) {
    parts.toasts.firstElementChild?.remove();
  }
  setTimeout(() => item.classList.add("coop-chat-gone"), TOAST_MS - 500);
  setTimeout(() => item.remove(), TOAST_MS);
}

/** Whatever the game thinks is held stays held otherwise: its release may go into the box, and the game repeats a held key */
function releaseGameKeys(): void {
  try {
    globalScene.inputController?.loseFocus();
  } catch {
    // no game (a test page)
  }
}

function setOpen(open: boolean): void {
  if (parts === null || chat === null) {
    return;
  }
  chat.open = open;
  parts.panel.hidden = !open;
  parts.toasts.hidden = open;
  releaseGameKeys();
  if (open) {
    chat.unread = 0;
    parts.toasts.replaceChildren();
    parts.log.scrollTop = parts.log.scrollHeight;
    // At once, inside the tap or the key that opened it (a phone shows its keyboard only then); that key's press was
    // cancelled, so it types nothing
    parts.input.focus();
  } else if (parts.panel.contains(document.activeElement)) {
    (document.activeElement as HTMLElement).blur();
  }
  drawToggle();
}

function setMuted(muted: boolean): void {
  if (chat === null) {
    return;
  }
  chat.muted = muted;
  rememberMuted(chat.partner, muted);
  addLine(
    "note",
    muted
      ? coopText("chatMuted", "You muted {{partner}}: their lines are not shown.", { partner: chat.partner })
      : coopText("chatUnmuted", "{{partner}} is not muted any more.", { partner: chat.partner }),
  );
  drawHead();
}

/** @returns Whether the line went (it was not empty, and not over the limit) */
function sendLine(raw: string): boolean {
  if (chat === null || parts === null) {
    return false;
  }
  const line = cleanChat(raw);
  if (line === null) {
    return true;
  }
  if (chat.link.isClosed || !chat.link.partnerPresent) {
    // A line sent now would be lost (the partner's next connection starts afresh, D20): it stays in the box
    addLine(
      "note",
      coopText("chatAway", "{{partner}} is not connected right now: they would not see it.", { partner: chat.partner }),
    );
    return false;
  }
  if (!chat.sending.take()) {
    addLine("note", coopText("chatSlowDown", "Slow down a little."));
    return false;
  }
  chat.link.sendChat(line);
  addLine("me", filterChat(line));
  return true;
}

function received(text: string): void {
  if (chat === null || chat.muted || !chat.receiving.take()) {
    return;
  }
  const line = cleanChat(text);
  if (line === null) {
    return;
  }
  const shown = filterChat(line);
  addLine("partner", shown);
  if (!chat.open) {
    chat.unread++;
    toast(shown);
    drawToggle();
  }
}

/**
 * Show the chat box for a linked session; a session that starts again (a new game) starts with an empty box
 * @param mine - This player's display name (D1)
 */
export function startChat(link: CoopLink, mine: string): void {
  if (typeof document === "undefined") {
    return;
  }
  stopChat();
  parts ??= build();
  parts.log.replaceChildren();
  parts.toasts.replaceChildren();
  parts.input.value = "";
  chat = {
    link,
    mine,
    partner: link.partnerName,
    muted: mutedNames().includes(link.partnerName),
    unread: 0,
    open: false,
    sending: new Bucket(SEND_BURST, SEND_EVERY_MS),
    receiving: new Bucket(RECEIVE_BURST, RECEIVE_EVERY_MS),
    stop: link.onChat(payload => received(payload.text)),
  };
  addLine(
    "note",
    coopText("chatRules", "Be kind: swear words and links are hidden. Mute stops {{partner}}'s lines.", {
      partner: chat.partner,
    }),
  );
  if (chat.muted) {
    addLine(
      "note",
      coopText("chatMuted", "You muted {{partner}}: their lines are not shown.", { partner: chat.partner }),
    );
  }
  drawHead();
  setOpen(false);
  parts.root.hidden = false;
}

/** The session is over: the box goes, with what was said */
export function stopChat(): void {
  chat?.stop();
  chat = null;
  pressedInBox.clear();
  heldChatKey = null;
  if (parts !== null) {
    parts.input.blur();
    parts.root.hidden = true;
    parts.panel.hidden = true;
    parts.log.replaceChildren();
    parts.toasts.replaceChildren();
  }
}

/** The chat key (D38): open the box, or close it */
export function toggleChat(): void {
  if (chat !== null) {
    setOpen(!chat.open);
  }
}

/** What the debug API and the tests read */
export function chatInfo(): { open: boolean; muted: boolean; unread: number; lines: string[] } | null {
  if (chat === null || parts === null) {
    return null;
  }
  return {
    open: chat.open,
    muted: chat.muted,
    unread: chat.unread,
    lines: [...parts.log.children].map(item => item.textContent ?? ""),
  };
}
