/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser, Page } from "@playwright/test";

/**
 * Where a shot goes: one folder per run (in the system's temp folder unless `--out` says another), with every player's
 * screenshot of each step, one image of the step with all players side by side, `index.html` to look at them in order and
 * `shots.json` that lists them.
 *
 * @module
 */

/** What one player's screen showed at a step, written under the screenshot */
export interface SeatCaption {
  seat: string;
  phase: string;
  ui: string;
  text: string;
  /** The entries of the option menu that is open */
  menu: string[];
}

interface Step {
  n: number;
  name: string;
  /** The step's image, all players side by side */
  file: string;
  /** Each player's own screenshot */
  seats: (SeatCaption & { file: string })[];
}

/** The width of one player's screen in the side-by-side image */
const PANE_WIDTH = 800;

export class ShotOutput {
  readonly dir: string;
  private readonly steps: Step[] = [];
  private composer: Page | null = null;

  /**
   * @param title - The scenario and its variables, at the top of `index.html`
   * @param folderName - The folder's name: the scenario, the variables that differ, the time
   * @param out - `--out`: the folder to put it in, instead of the system's temp folder
   */
  private readonly title: string;

  constructor(title: string, folderName: string, out: string) {
    this.title = title;
    this.dir = resolve(out === "" ? join(tmpdir(), "pokerogue-shots") : out, folderName);
    mkdirSync(this.dir, { recursive: true });
  }

  get count(): number {
    return this.steps.length;
  }

  /**
   * Save a step: each player's screenshot, and the image of all of them side by side
   * @param shots - Per player, its screenshot (PNG) and what its screen showed
   */
  async add(browser: Browser, name: string, shots: { png: Buffer; caption: SeatCaption }[]): Promise<string> {
    const n = this.steps.length + 1;
    const base = `${String(n).padStart(2, "0")}-${name}`;
    const seats = shots.map(({ png, caption }) => {
      const file = `${base}-${caption.seat}.png`;
      writeFileSync(join(this.dir, file), png);
      return { ...caption, file };
    });
    const file = `${base}.png`;
    await this.compose(browser, join(this.dir, file), shots);
    this.steps.push({ n, name, file, seats });
    return join(this.dir, file);
  }

  /** The players side by side, each with a label: who it is, the phase and the screen */
  private async compose(browser: Browser, path: string, shots: { png: Buffer; caption: SeatCaption }[]): Promise<void> {
    this.composer ??= await (await browser.newContext({ viewport: { width: 2400, height: 600 } })).newPage();
    const panes = shots
      .map(
        ({ png, caption }) => `<figure>
          <figcaption><b>${escapeHtml(caption.seat)}</b> ${escapeHtml(caption.phase)} / ${escapeHtml(caption.ui)}</figcaption>
          <img src="data:image/png;base64,${png.toString("base64")}">
        </figure>`,
      )
      .join("");
    await this.composer.setContent(`<!doctype html><html><head><style>
      body { margin: 0; background: #111; display: inline-flex; gap: 6px; padding: 6px; font: 15px/1.3 sans-serif; color: #eee; }
      figure { margin: 0; width: ${PANE_WIDTH}px; }
      figcaption { padding: 2px 4px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      img { display: block; width: ${PANE_WIDTH}px; }
    </style></head><body>${panes}</body></html>`);
    await this.composer.evaluate(() => Promise.all(Array.from(document.images, image => image.decode())));
    await this.composer.locator("body").screenshot({ path });
  }

  /** Write `index.html` and `shots.json`; also after a failure, with what was shot until then */
  async finish(failure: string | null): Promise<string> {
    await this.composer?.context().close();
    this.composer = null;
    writeFileSync(
      join(this.dir, "shots.json"),
      JSON.stringify({ title: this.title, failure, steps: this.steps }, null, 2),
    );
    const rows = this.steps
      .map(
        step => `<section><h2>${step.n}. ${escapeHtml(step.name)}</h2>
          <a href="${step.file}"><img src="${step.file}" loading="lazy"></a>
          <ul>${step.seats.map(seat => `<li><b>${escapeHtml(seat.seat)}</b> ${escapeHtml(seat.phase)} / ${escapeHtml(seat.ui)}${seat.text === "" ? "" : `: “${escapeHtml(seat.text)}”`}${seat.menu.length === 0 ? "" : ` [${escapeHtml(seat.menu.join(" | "))}]`} · <a href="${seat.file}">own</a></li>`).join("")}</ul>
        </section>`,
      )
      .join("");
    const failed = failure === null ? "" : `<p class="failed">Stopped: ${escapeHtml(failure)}</p>`;
    writeFileSync(
      join(this.dir, "index.html"),
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(this.title)}</title><style>
        body { margin: 16px; background: #181818; color: #ddd; font: 14px/1.4 system-ui, sans-serif; }
        h1 { font-size: 18px; } h2 { font-size: 15px; margin: 18px 0 6px; }
        img { max-width: 100%; border: 1px solid #333; } ul { margin: 4px 0; padding-left: 18px; }
        a { color: #8cf; } .failed { color: #f88; font-weight: bold; }
      </style></head><body><h1>${escapeHtml(this.title)}</h1>${failed}${rows}</body></html>`,
    );
    return join(this.dir, "index.html");
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
