/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from "node:fs";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";

/**
 * Smoke test for the two-client harness: two isolated browser contexts (separate localStorage, so two separate
 * offline "Guest" accounts) each load the game and reach the title screen without console errors.
 *
 * Each context starts with the settings D5 pins for co-op that matter here: tutorials off (a fresh profile otherwise
 * opens on the intro tutorial) and a player gender (a fresh profile otherwise opens the gender select).
 *
 * The game exposes no global to ask which screen it is on, so "title screen" is detected from the canvas: while the
 * loading scene runs the canvas holds a logo and a progress bar on a dark background, the title screen is a full
 * scene with many colors (see {@linkcode countCanvasColors}).
 */

/**
 * The pixel-art title screen measures 74-109 colors; the loading scene was seen up to 57. Because that gap is narrow, the
 * title screen must also hold {@linkcode TITLE_STABLE_SAMPLES} samples in a row, after the network went idle.
 */
const TITLE_MIN_COLORS = 60;
const TITLE_STABLE_SAMPLES = 3;

/**
 * Upstream dev-server baseline noise, not a co-op problem: `src/init/init-manifest.ts:4` fetches the Vite build manifest,
 * which only exists in production builds.
 */
const KNOWN_UPSTREAM_404 = ["/manifest.json"];

function isKnownUpstream404(url: string): boolean {
  return KNOWN_UPSTREAM_404.some(path => url.endsWith(path));
}

const GAME_VERSION: string = JSON.parse(readFileSync("package.json", "utf8")).version;
/** `PlayerGender.MALE` */
const PLAYER_GENDER_MALE = 1;

async function newClientContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addInitScript(
    ({ version, gender }) => {
      if (localStorage.getItem("settings") === null) {
        localStorage.setItem(
          "settings",
          JSON.stringify({
            meta: { gameVersion: version },
            general: { enableTutorials: false, playerGender: gender },
            audio: { enableAudio: false },
          }),
        );
      }
    },
    { version: GAME_VERSION, gender: PLAYER_GENDER_MALE },
  );
  return context;
}

interface Client {
  label: string;
  page: Page;
  errors: string[];
  /** Canvas color counts seen while waiting, for diagnosing a threshold problem */
  samples: number[];
}

async function openClient(context: BrowserContext, label: string): Promise<Client> {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", message => {
    if (message.type() === "error" && !isKnownUpstream404(message.location().url)) {
      errors.push(`[${label}] console.error: ${message.text()}`);
    }
  });
  page.on("pageerror", error => {
    errors.push(`[${label}] pageerror: ${error.message}`);
  });
  // A failed resource load only shows up in the console as "Failed to load resource" without the URL.
  page.on("response", response => {
    if (response.status() >= 400 && !isKnownUpstream404(response.url())) {
      errors.push(`[${label}] HTTP ${response.status()}: ${response.url()}`);
    }
  });
  await page.goto("/");
  return { label, page, errors, samples: [] };
}

/**
 * Count the distinct colors (quantized to 4 bits per channel) in the WebGL canvas.
 * The canvas is copied inside an animation frame, right after Phaser has drawn: outside of it the drawing buffer of a
 * WebGL canvas is already cleared.
 */
async function countCanvasColors(page: Page): Promise<number> {
  return await page.evaluate(
    () =>
      new Promise<number>(resolve => {
        requestAnimationFrame(() => {
          const canvas = document.querySelector<HTMLCanvasElement>("#app canvas");
          if (!canvas || canvas.width === 0 || canvas.height === 0) {
            resolve(0);
            return;
          }
          const probe = document.createElement("canvas");
          probe.width = 192;
          probe.height = 108;
          const context = probe.getContext("2d", { willReadFrequently: true });
          if (!context) {
            resolve(0);
            return;
          }
          context.drawImage(canvas, 0, 0, probe.width, probe.height);
          const { data } = context.getImageData(0, 0, probe.width, probe.height);
          const colors = new Set<number>();
          for (let i = 0; i < data.length; i += 4) {
            colors.add(((data[i]! >> 4) << 8) | ((data[i + 1]! >> 4) << 4) | (data[i + 2]! >> 4));
          }
          resolve(colors.size);
        });
      }),
  );
}

async function waitForTitleScreen(client: Client): Promise<void> {
  const { page } = client;
  await expect(page.locator("#app canvas")).toBeVisible();
  // The loading scene downloads assets until it is done.
  await page.waitForLoadState("networkidle", { timeout: 180_000 });
  let streak = 0;
  await expect
    .poll(
      async () => {
        const colors = await countCanvasColors(page);
        client.samples.push(colors);
        streak = colors >= TITLE_MIN_COLORS ? streak + 1 : 0;
        return streak;
      },
      {
        message: `${client.label}: canvas never showed a stable full scene (title screen)`,
        timeout: 180_000,
        intervals: [1000],
      },
    )
    .toBeGreaterThanOrEqual(TITLE_STABLE_SAMPLES);
}

test("two browser contexts each reach the title screen", async ({ browser }, testInfo) => {
  const contextA = await newClientContext(browser);
  const contextB = await newClientContext(browser);
  const [a, b] = await Promise.all([openClient(contextA, "client-A"), openClient(contextB, "client-B")]);

  try {
    await Promise.all([waitForTitleScreen(a), waitForTitleScreen(b)]);
  } finally {
    for (const client of [a, b]) {
      // Shows how far the loading scene stays below the threshold, to keep TITLE_MIN_COLORS honest.
      console.log(`${client.label}: canvas colors per second: ${client.samples.join(",")}`);
    }
  }

  for (const client of [a, b]) {
    await testInfo.attach(`${client.label}-title.png`, {
      body: await client.page.screenshot(),
      contentType: "image/png",
    });
    await expect(client.page.locator("#app canvas")).toHaveCount(1);
  }

  expect([...a.errors, ...b.errors], "console errors").toEqual([]);

  await contextA.close();
  await contextB.close();
});
