/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

/**
 * Load test of the relay (DECISIONS D23): many rooms at once on loopback, each with two players who send to each other, and
 * what the server costs while it carries them. The server runs as its own process (`src/main.ts`) with the per-IP limits
 * raised, because every client here is one IP; the limits have their own tests.
 *
 *     node coop-server/scripts/load-test.ts [rooms=200] [seconds=30] [framesPerSecondPerPlayer=10]
 *
 * It prints one JSON report: the rooms and sockets, what was sent and received, how long a frame took from one player to the
 * other, and the server's memory (resident set) and CPU (share of one core) from `/healthz`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOMS = Number(process.argv[2] ?? 200);
const SECONDS = Number(process.argv[3] ?? 30);
const RATE = Number(process.argv[4] ?? 10);
const PORT = Number(process.env["LOAD_PORT"] ?? 18787);
/** About what a game message weighs: an envelope with a decision or a checkpoint */
const PAYLOAD = "x".repeat(220);

interface Health {
  rooms: number;
  sockets: number;
  rssMb: number;
  cpuMs: number;
}

const health = async (): Promise<Health> => (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json() as Promise<Health>;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function startServer(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [join(here, "..", "src", "main.ts")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      MAX_CONNECTIONS_PER_IP: "1000000",
      CONNECTIONS_PER_MINUTE: "1000000",
      ROOMS_PER_MINUTE: "1000000",
      MESSAGES_PER_SECOND: "1000000",
      MESSAGE_BURST: "1000000",
      MAX_ROOMS: "1000000",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout?.on("data", chunk => {
      if (String(chunk).includes("listening")) {
        resolve(child);
      }
    });
  });
}

interface Player {
  socket: WebSocket;
  /** Frames this player received */
  received: number;
}

const latencies: number[] = [];
let sent = 0;

/** A room: the host creates it, the guest joins with its code; both are paired when this returns */
function room(): Promise<[Player, Player]> {
  return new Promise((resolve, reject) => {
    const host = new WebSocket(`ws://127.0.0.1:${PORT}/coop?role=host`);
    const hostPlayer: Player = { socket: host, received: 0 };
    host.on("error", reject);
    let paired = 0;
    const onFrame = (player: Player) => (data: WebSocket.RawData) => {
      const text = data.toString();
      if (text.startsWith('{"t":"relay:')) {
        if (text.startsWith('{"t":"relay:paired"')) {
          paired++;
          if (paired === 2) {
            resolve([hostPlayer, guestPlayer!]);
          }
        }
        return;
      }
      player.received++;
      latencies.push(performance.now() - Number(text.slice(0, text.indexOf("|"))));
    };
    let guestPlayer: Player | undefined;
    host.on("message", data => {
      const text = data.toString();
      if (text.startsWith('{"t":"relay:created"')) {
        const code = (JSON.parse(text) as { code: string }).code;
        const guest = new WebSocket(`ws://127.0.0.1:${PORT}/coop?code=${code}`);
        guestPlayer = { socket: guest, received: 0 };
        guest.on("error", reject);
        guest.on("message", onFrame(guestPlayer));
      }
    });
    host.on("message", onFrame(hostPlayer));
  });
}

async function main(): Promise<void> {
  const server = await startServer();
  const report: Record<string, unknown> = { rooms: ROOMS, seconds: SECONDS, framesPerSecondPerPlayer: RATE };
  try {
    await sleep(500);
    const idle = await health();

    // open the rooms, a few at a time
    const players: Player[] = [];
    for (let opened = 0; opened < ROOMS; opened += 20) {
      const batch = await Promise.all(Array.from({ length: Math.min(20, ROOMS - opened) }, () => room()));
      for (const [host, guest] of batch) {
        players.push(host, guest);
      }
    }
    await sleep(500);
    const open = await health();

    // every player sends RATE frames a second to the other one, for SECONDS
    const samples: { rssMb: number; cpuPercent: number }[] = [];
    let last = open;
    let lastAt = performance.now();
    const timers = players.map(player =>
      setInterval(() => {
        if (player.socket.readyState === WebSocket.OPEN) {
          player.socket.send(`${performance.now()}|${PAYLOAD}`);
          sent++;
        }
      }, 1000 / RATE),
    );
    const sampler = setInterval(() => {
      void health().then(now => {
        const at = performance.now();
        samples.push({ rssMb: now.rssMb, cpuPercent: ((now.cpuMs - last.cpuMs) / (at - lastAt)) * 100 });
        last = now;
        lastAt = at;
      });
    }, 1000);
    await sleep(SECONDS * 1000);
    for (const timer of timers) {
      clearInterval(timer);
    }
    clearInterval(sampler);
    await sleep(1000); // what is on the way arrives

    const received = players.reduce((total, player) => total + player.received, 0);
    latencies.sort((a, b) => a - b);
    const at = (fraction: number): number =>
      Math.round((latencies[Math.floor(latencies.length * fraction)] ?? 0) * 100) / 100;
    const cpu = samples.map(sample => sample.cpuPercent);
    const during = await health();

    // "End session" (close code 4003): the room goes at once. A plain close would keep the seats for the hold (D20).
    for (const player of players) {
      player.socket.close(4003, "leave");
    }
    await sleep(1500);
    const after = await health();

    report["idleServer"] = { rssMb: idle.rssMb };
    report["afterOpeningRooms"] = { rooms: open.rooms, sockets: open.sockets, rssMb: open.rssMb };
    report["traffic"] = {
      framesSent: sent,
      framesReceived: received,
      lost: sent - received,
      framesPerSecondThroughTheRelay: Math.round(received / SECONDS),
      latencyMs: { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(0.9999) },
    };
    report["serverUnderLoad"] = {
      rssMbMax: Math.max(...samples.map(sample => sample.rssMb), during.rssMb),
      cpuPercentOfOneCoreMean: Math.round((cpu.reduce((a, b) => a + b, 0) / Math.max(1, cpu.length)) * 10) / 10,
      cpuPercentOfOneCoreMax: Math.round(Math.max(...cpu, 0) * 10) / 10,
    };
    report["afterClosing"] = { rooms: after.rooms, sockets: after.sockets, rssMb: after.rssMb };
  } finally {
    server.kill();
  }
  console.log(JSON.stringify(report, null, 2));
}

await main();
