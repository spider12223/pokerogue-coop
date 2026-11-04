/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * `pnpm shot`: screenshots of one co-op interaction, from every player, without a game window (headless browsers through
 * the local relay). It starts Playwright with `playwright.shots.config.ts`; the run itself is `run.shot.ts`.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HELP = `pnpm shot <scenario> [--<variable> <value> ...]

  pnpm shot --list                       the scenarios and their variables
  pnpm shot me:the-expert-pokemon-breeder --players 3 --goer guest2
  pnpm shot breeder --all                every option of the encounter (a part of an id is enough)
  pnpm shot "me:*"                       every encounter, one after another

  --out <folder>      where the shots go (default: the system's temp folder, pokerogue-shots)
  --timeout <s>       the most one scenario may take (default 300)
  --headed            show the browsers
  --keep              leave the dev server it starts running, for the next shot
  --stop              stop that dev server`;

const DEV_URL = "http://localhost:8000/";
const PID_FILE = join("test-results", "shots-dev-server.pid");
const windows = process.platform === "win32";

interface Parsed {
  scenario: string;
  vars: Record<string, string>;
  list: boolean;
  all: boolean;
  out: string;
  timeout: number;
  headed: boolean;
  keep: boolean;
  stop: boolean;
}

/** The options that take no value */
const FLAGS = ["list", "all", "headed", "keep", "stop"] as const;
type Flag = (typeof FLAGS)[number];

const isFlag = (name: string): name is Flag => (FLAGS as readonly string[]).includes(name);

function parse(argv: readonly string[]): Parsed {
  const parsed: Parsed = {
    scenario: "",
    vars: {},
    list: false,
    all: false,
    out: "",
    timeout: 300,
    headed: false,
    keep: false,
    stop: false,
  };
  const rest = [...argv];
  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    if (!arg.startsWith("--")) {
      if (parsed.scenario !== "") {
        fail(`one scenario at a time (got "${parsed.scenario}" and "${arg}"); a pattern like "me:*" runs several`);
      }
      parsed.scenario = arg;
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2);
    if (name === "help") {
      console.log(HELP);
      process.exit(0);
    }
    if (isFlag(name)) {
      parsed[name] = true;
      continue;
    }
    const value = inline ?? rest.shift();
    if (value === undefined || value.startsWith("--")) {
      fail(`--${name} needs a value`);
    }
    setOption(parsed, name, value);
  }
  if (!parsed.list && !parsed.stop && parsed.scenario === "") {
    fail(`which scenario? pnpm shot --list shows them\n\n${HELP}`);
  }
  return parsed;
}

/** `--out`, `--timeout`, or one of the scenario's variables (the run checks those) */
function setOption(parsed: Parsed, name: string, value: string): void {
  if (name === "out") {
    parsed.out = value;
  } else if (name === "timeout") {
    parsed.timeout = Number(value);
    if (!Number.isFinite(parsed.timeout) || parsed.timeout <= 0) {
      fail(`--timeout is a number of seconds, not "${value}"`);
    }
  } else {
    parsed.vars[name] = value;
  }
}

function fail(message: string): never {
  console.error(`pnpm shot: ${message}`);
  process.exit(2);
}

async function serverUp(): Promise<boolean> {
  try {
    const response = await fetch(DEV_URL, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Start the dev server on its own, to outlive this shot (`--keep`) */
async function keepServer(): Promise<void> {
  if (await serverUp()) {
    return;
  }
  console.log("starting the dev server (it stays up for the next shots; pnpm shot --stop stops it)");
  // one command line: its words are fixed, nothing typed goes into it
  const child: ChildProcess = spawn("pnpm start:dev", { detached: true, stdio: "ignore", shell: true });
  child.unref();
  mkdirSync("test-results", { recursive: true });
  writeFileSync(PID_FILE, String(child.pid));
  const end = Date.now() + 240_000;
  while (!(await serverUp())) {
    if (Date.now() > end) {
      fail("the dev server did not start in 4 minutes");
    }
    await new Promise(done => setTimeout(done, 1000));
  }
}

function stopServer(): void {
  if (!existsSync(PID_FILE)) {
    console.log("no dev server started by pnpm shot --keep");
    return;
  }
  const pid = Number(readFileSync(PID_FILE, "utf8"));
  if (windows) {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid);
    } catch {
      // it had stopped already
    }
  }
  rmSync(PID_FILE, { force: true });
  console.log("dev server stopped");
}

const options = parse(process.argv.slice(2));
if (options.stop) {
  stopServer();
  process.exit(0);
}
if (options.keep) {
  await keepServer();
}
const job = {
  scenario: options.scenario,
  headed: options.headed,
  vars: options.vars,
  list: options.list,
  all: options.all,
  out: options.out,
  timeout: options.timeout,
};
// The job goes in the environment; the command line has only fixed words
const playwright = spawn("pnpm exec playwright test -c playwright.shots.config.ts", {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, SHOT_JOB: JSON.stringify(job), ...(options.list ? { SHOT_NO_SERVER: "1" } : {}) },
});
playwright.on("exit", code => process.exit(code ?? 1));
