/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { coopText } from "#coop/ui/text";

/**
 * The controls of the host's debug window (DECISIONS D42): each makes its change in one step. A number applies on Enter or
 * when the box is left (or with its − and + buttons), a list applies when an entry is picked, a row of buttons when one is
 * pressed. They are made in the window's own document (`useDocument`): its own browser window, or the game's page.
 * @module
 */

/** One entry of a list to pick from */
export interface Choice {
  label: string;
  value: number | string;
  /** Said after it, smaller (what an item is, who it is for) */
  note?: string;
  /** It is for one of our Pokémon: shown first, marked */
  fits?: boolean;
}

type Child = Node | string | null | undefined | false;

let doc: Document | null = typeof document === "undefined" ? null : document;

/** The document the controls are made in from now on */
export function useDocument(next: Document): void {
  doc = next;
}

export function currentDocument(): Document {
  return doc ?? document;
}

export const t = (key: string, text: string, vars: Record<string, string | number> = {}): string =>
  coopText(`debug${key}`, text, vars);

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = currentDocument().createElement(tag);
  if (className !== "") {
    node.className = className;
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) {
      node.append(child);
    }
  }
  return node;
}

export function button(text: string, action: () => void, className = "cdw-btn"): HTMLButtonElement {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", () => action());
  return node;
}

/** A button that asks once more before it acts: the first press arms it for a few seconds */
export function dangerButton(text: string, armedText: string, action: () => void): HTMLButtonElement {
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const node = button(
    text,
    () => {
      if (armed) {
        if (timer !== null) {
          clearTimeout(timer);
        }
        action();
        return;
      }
      armed = true;
      node.textContent = armedText;
      node.classList.add("cdw-armed");
      timer = setTimeout(() => {
        armed = false;
        node.textContent = text;
        node.classList.remove("cdw-armed");
      }, 3000);
    },
    "cdw-btn cdw-small cdw-danger",
  );
  return node;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * A number with − and + buttons. It applies on Enter, when the box is left, and on each press of − or +.
 * @param onCommit - Called with a new value in range
 */
export function numberBox(
  value: number,
  min: number,
  max: number,
  onCommit: (value: number) => void,
  step = 1,
  width = 72,
): HTMLElement {
  let last = value;
  const input = el("input", "");
  input.type = "text";
  input.inputMode = "numeric";
  input.value = String(value);
  input.style.width = `${width}px`;
  const commit = (next: number): void => {
    const v = clamp(Math.trunc(next), min, max);
    input.value = String(v);
    if (v !== last) {
      last = v;
      onCommit(v);
    }
  };
  const fromText = (): void => {
    const typed = Number(input.value.trim().replace(/[,\s]/g, ""));
    if (input.value.trim() === "" || !Number.isFinite(typed)) {
      input.value = String(last);
      return;
    }
    commit(typed);
  };
  input.addEventListener("change", fromText);
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      fromText();
    }
  });
  const minus = button("−", () => commit(last - step), "");
  const plus = button("+", () => commit(last + step), "");
  minus.title = `−${step}`;
  plus.title = `+${step}`;
  return el("span", "cdw-num", minus, input, plus);
}

/** A row of buttons, one of which is on; pressing another applies it */
export function segmented<T extends number | string | boolean | null>(
  choices: readonly { label: string; value: T }[],
  current: T | undefined,
  onPick: (value: T) => void,
): HTMLElement {
  const box = el("span", "cdw-seg");
  for (const choice of choices) {
    const node = button(
      choice.label,
      () => {
        for (const other of Array.from(box.children)) {
          other.classList.toggle("cdw-on", other === node);
        }
        onPick(choice.value);
      },
      choice.value === current ? "cdw-on" : "",
    );
    box.append(node);
  }
  return box;
}

/** An on/off switch; a press applies the other state */
export function switchButton(label: string, on: boolean, onToggle: (next: boolean) => void): HTMLElement {
  const node = button("", () => onToggle(!on), `cdw-sw${on ? " cdw-on" : ""}`);
  node.append(el("i"), label);
  node.setAttribute("aria-pressed", String(on));
  return node;
}

/** A list in a drop-down; picking an entry applies it */
export function selectBox(
  choices: readonly Choice[],
  current: number | string | undefined,
  onPick: (value: string) => void,
) {
  const node = el("select", "cdw-in");
  for (const choice of choices) {
    const option = el("option", "", choice.label);
    option.value = String(choice.value);
    option.selected = choice.value === current;
    node.append(option);
  }
  node.addEventListener("change", () => onPick(node.value));
  return node;
}

/** How many entries a search list shows at once */
const MENU_SIZE = 60;

/**
 * A search box over a list: typing narrows it, ↑ ↓ choose, Enter or a click picks. Picking applies at once.
 * @param choices - The list, read each time it opens (the entries that fit our team first)
 */
export function picker(
  choices: () => readonly Choice[],
  placeholder: string,
  onPick: (choice: Choice) => void,
  width = 220,
): HTMLElement {
  const box = el("span", "cdw-pick");
  const input = el("input", "cdw-in");
  input.type = "text";
  input.placeholder = placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.style.width = `${width}px`;
  box.append(input);
  let menu: HTMLElement | null = null;
  let shown: Choice[] = [];
  let high = 0;

  const close = (): void => {
    menu?.remove();
    menu = null;
  };
  const pick = (choice: Choice | undefined): void => {
    if (choice === undefined) {
      return;
    }
    input.value = "";
    close();
    // (the box is left: the window drawn again after the pick does not open its list again over what is below)
    input.blur();
    onPick(choice);
  };
  const draw = (): void => {
    const query = input.value.trim().toLowerCase();
    const all = choices();
    const found =
      query === ""
        ? all
        : all.filter(
            choice => choice.label.toLowerCase().includes(query) || (choice.note ?? "").toLowerCase().includes(query),
          );
    // (a name that starts with what was typed comes before one that only has it inside)
    shown = (query === "" ? found : [...found].sort((a, b) => rank(a, query) - rank(b, query))).slice(0, MENU_SIZE);
    high = Math.min(high, Math.max(0, shown.length - 1));
    menu ??= el("div", "cdw-menu");
    menu.replaceChildren(
      ...shown.map((choice, index) => {
        const node = el(
          "button",
          `${index === high ? "cdw-hi" : ""}${choice.fits ? " cdw-fits" : ""}`.trim(),
          el("span", "", choice.label),
          choice.note === undefined ? null : el("small", "", choice.note),
        );
        node.type = "button";
        // (before the box loses the focus)
        node.addEventListener("mousedown", event => {
          event.preventDefault();
          pick(choice);
        });
        return node;
      }),
    );
    if (shown.length === 0) {
      menu.append(el("div", "cdw-more", t("NoMatch", "Nothing matches.")));
    } else if (found.length > shown.length) {
      menu.append(el("div", "cdw-more", t("More", "{{n}} more: keep typing", { n: found.length - shown.length })));
    }
    if (menu.parentNode !== box) {
      box.append(menu);
    }
  };
  input.addEventListener("focus", () => {
    high = 0;
    draw();
  });
  input.addEventListener("input", () => {
    high = 0;
    draw();
  });
  input.addEventListener("blur", () => close());
  input.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      high = clamp(high + (event.key === "ArrowDown" ? 1 : -1), 0, Math.max(0, shown.length - 1));
      draw();
      menu?.children[high]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(shown[high]);
    } else if (event.key === "Escape") {
      close();
      input.blur();
    }
  });
  return box;
}

function rank(choice: Choice, query: string): number {
  return (choice.label.toLowerCase().startsWith(query) ? 0 : 1) + (choice.fits ? 0 : 0.5);
}

export function chip(text: string, onRemove?: () => void, removeTitle = ""): HTMLElement {
  const node = el("span", "cdw-chip", text);
  if (onRemove !== undefined) {
    const x = button("×", onRemove, "cdw-x");
    x.title = removeTitle;
    node.append(x);
  }
  return node;
}

export interface FieldOptions {
  hint?: string;
  wide?: boolean;
  /** A change to it waits for the next turn: the label says so */
  pending?: boolean;
  /** More words the search finds it by */
  words?: string;
}

/** A card of the window: its label, its controls, a line on what it does. The search finds it by its words. */
export function field(label: string, options: FieldOptions, ...controls: Child[]): HTMLElement {
  const title = el("label", "", label);
  if (options.pending) {
    title.append(el("span", "cdw-wait", t("Pending", "⧗ next turn")));
  }
  const node = el(
    "div",
    `cdw-f${options.wide ? " cdw-wide" : ""}`,
    title,
    el("div", "cdw-row", ...controls),
    options.hint === undefined ? null : el("div", "cdw-hint", options.hint),
  );
  node.dataset["search"] = [label, options.hint ?? "", options.words ?? ""].join(" ").toLowerCase();
  return node;
}
