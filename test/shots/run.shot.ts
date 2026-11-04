/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, test } from "@playwright/test";
import { type RelayServer, startRelayServer } from "../../coop-server/src/relay-server.ts";
import { defaultsOf, findScenarios, listing, variablesOf } from "./catalog.ts";
import { ShotRun } from "./engine.ts";
import { ShotOutput } from "./output.ts";
import { NoSuchValue, type Scenario } from "./scenario.ts";
import { resolveVars, VARIABLES, type VariableName, varsLabel } from "./variables.ts";

/**
 * The one "test" of `pnpm shot` (`test/shots/shot.ts` starts it): the job is in `SHOT_JOB`. Each scenario the job names
 * runs in fresh pages, one after another; with `--all`, once for each value of its sweep variable.
 */

interface Job {
  scenario: string;
  headed: boolean;
  vars: Record<string, string>;
  list: boolean;
  all: boolean;
  out: string;
  /** Seconds one scenario may take */
  timeout: number;
}

/**
 * How the browser draws the game: the GPU first (several times the frames of a software renderer, and three pages run at
 * once), else SwiftShader, the software renderer the browser tests use
 */
const RENDERERS = [
  {
    name: "GPU",
    channel: "chromium",
    args: {
      win32: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
      darwin: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
      linux: ["--use-angle=vulkan", "--enable-gpu", "--ignore-gpu-blocklist"],
    } as Partial<Record<NodeJS.Platform, string[]>>,
  },
  {
    name: "software (no GPU found: slower)",
    channel: undefined,
    args: {
      default: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    },
  },
] as const;

/** A browser that draws WebGL on the GPU if this computer lets it, else in software */
async function launchBrowser(headed: boolean): Promise<Browser> {
  for (const renderer of RENDERERS) {
    const args =
      (renderer.args as Record<string, string[] | undefined>)[process.platform]
      ?? (renderer.args as Record<string, string[] | undefined>)["default"];
    if (args === undefined) {
      continue;
    }
    const browser = await chromium
      .launch({ headless: !headed, args, ...(renderer.channel === undefined ? {} : { channel: renderer.channel }) })
      .catch(() => null);
    if (browser === null) {
      continue;
    }
    const page = await browser.newPage();
    const name = await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl");
      if (gl == null) {
        return null;
      }
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      return info == null ? "WebGL" : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
    });
    await page.close();
    if (name !== null && (renderer.channel === undefined || !/SwiftShader|llvmpipe|software/i.test(name))) {
      console.log(`drawing with: ${renderer.name}, ${name}`);
      return browser;
    }
    await browser.close();
  }
  throw new Error("no browser here can draw WebGL, which the game needs");
}

/** The port of the relay the dev build connects to (`VITE_COOP_RELAY_URL` of `.env.development`) */
const RELAY_PORT = 8787;

/**
 * One shot at a time: the game's dev build has one relay address, so two shots at once would share a relay that the
 * first closes when it ends. A second one waits for its turn.
 */
const LOCK = join("test-results", "shots.lock");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Wait until no other shot runs; @returns How to give the turn back */
async function takeTurn(): Promise<() => void> {
  mkdirSync("test-results", { recursive: true });
  let told = false;
  for (;;) {
    try {
      writeFileSync(LOCK, String(process.pid), { flag: "wx" });
      return () => rmSync(LOCK, { force: true });
    } catch {
      const holder = Number(readFileSync(LOCK, "utf8"));
      if (!Number.isInteger(holder) || !alive(holder)) {
        // a shot that was stopped left it
        rmSync(LOCK, { force: true });
        continue;
      }
      if (!told) {
        console.log("another pnpm shot is running: this one starts when it ends");
        told = true;
      }
      await new Promise(done => setTimeout(done, 2000));
    }
  }
}

const job: Job | null = JSON.parse(process.env["SHOT_JOB"] ?? "null");

/** The values `--all` runs a scenario with */
function sweepValues(name: VariableName): string[] {
  const variable = VARIABLES[name];
  switch (variable.kind) {
    case "choice":
      return [...variable.values];
    case "number":
      return Array.from({ length: variable.max - variable.min + 1 }, (_, i) => String(variable.min + i));
    case "text":
      throw new Error(`--all cannot go through --${name}: it is text`);
  }
}

function withTimeout<T>(work: Promise<T>, seconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`it took more than ${seconds} s (--timeout)`)), seconds * 1000);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

interface Outcome {
  name: string;
  index: string | null;
  failure: string | null;
}

test("pnpm shot", async () => {
  if (job === null) {
    throw new Error("run it with pnpm shot (test/shots/shot.ts)");
  }
  if (job.list) {
    console.log(listing());
    return;
  }
  const scenarios = findScenarios(job.scenario);
  const many = scenarios.length > 1;
  const giveBack = await takeTurn();
  const browser = await launchBrowser(job.headed).catch(error => {
    giveBack();
    throw error;
  });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  let relay: RelayServer | null = null;
  try {
    relay = await startRelayServer({ port: RELAY_PORT, host: "127.0.0.1", allowedOrigins: ["*"] });
  } catch {
    // one is listening already (another shot, or started by hand): it is used
  }
  const outcomes: Outcome[] = [];
  try {
    for (const scenario of scenarios) {
      const sweep = job.all ? scenario.sweep : undefined;
      if (job.all && sweep === undefined && !many) {
        throw new Error(`${scenario.id} has nothing for --all to go through`);
      }
      for (const value of sweep === undefined ? [null] : sweepValues(sweep)) {
        const typed = value === null || sweep === undefined ? job.vars : { ...job.vars, [sweep]: value };
        const outcome = await runOne(scenario, typed, stamp, many);
        if (outcome === "no more") {
          break;
        }
        outcomes.push(outcome);
      }
    }
  } finally {
    await relay?.close();
    await browser.close();
    giveBack();
  }
  console.log("");
  for (const outcome of outcomes) {
    console.log(`${outcome.failure === null ? "ok    " : "FAILED"} ${outcome.name}  ${outcome.index ?? ""}`);
    if (outcome.failure !== null) {
      console.log(`       ${outcome.failure}`);
    }
  }
  const failed = outcomes.filter(outcome => outcome.failure !== null).length;
  if (failed > 0) {
    throw new Error(`${failed} of ${outcomes.length} failed`);
  }

  /** One scenario with one set of variables, in its own folder; `"no more"` past the last value of a sweep */
  async function runOne(
    scenario: Scenario,
    typed: Record<string, string>,
    folderStamp: string,
    keepGoing: boolean,
  ): Promise<Outcome | "no more"> {
    const allowed = variablesOf(scenario);
    const defaults = defaultsOf(scenario);
    let vars: ReturnType<typeof resolveVars>;
    try {
      vars = resolveVars(allowed, defaults, typed);
    } catch (error) {
      if (!keepGoing) {
        throw error;
      }
      return { name: scenario.id, index: null, failure: `skipped: ${(error as Error).message}` };
    }
    const label = varsLabel(vars, allowed, defaults);
    const name = `${scenario.id}${label === "" ? "" : ` ${label}`}`;
    const title = `${scenario.id} ${allowed.map(v => `--${v} ${vars[v] === "" ? '""' : vars[v]}`).join(" ")}`;
    const folder = [folderStamp, scenario.id.replace(/:/g, "-"), label].filter(part => part !== "").join("_");
    const out = new ShotOutput(title, folder, job!.out);
    const run = new ShotRun(browser, vars, out);
    console.log(`\n${title}\n  -> ${out.dir}`);
    const started = Date.now();
    try {
      await withTimeout(scenario.play(run, vars), job!.timeout);
      const index = await out.finish(null);
      console.log(`  ${out.count} steps in ${Math.round((Date.now() - started) / 1000)} s`);
      return { name, index, failure: null };
    } catch (error) {
      if (error instanceof NoSuchValue) {
        console.log(`  ${error.message}: the sweep ends here`);
        rmSync(out.dir, { recursive: true, force: true });
        return "no more";
      }
      const failure = (error as Error).message.split("\n")[0];
      console.log(`  failed after ${Math.round((Date.now() - started) / 1000)} s: ${failure}`);
      await run.failureShot();
      return { name, index: await out.finish(failure), failure };
    } finally {
      await run.close();
    }
  }
});
