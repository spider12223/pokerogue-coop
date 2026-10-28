/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Walks through the relay protocol (`coop-server/README.md`) against a running relay: a room, a guest, frames both ways,
 * a forged control frame, a dropped guest who comes back, the wrong token, a full room, and "End session".
 * Works against `coop-server` and the Worker alike.
 *
 *   node scripts/smoke.ts ws://127.0.0.1:8787/coop
 *   node scripts/smoke.ts wss://pokerogue-coop-relay.<you>.workers.dev/coop
 *
 * A relay that only lets pages of some origins in needs `ORIGIN=<one of them>` (Node sends no `Origin` otherwise).
 */

const relay = process.argv[2];
if (relay === undefined) {
  console.error("usage: node scripts/smoke.ts <relay URL, e.g. ws://127.0.0.1:8787/coop>");
  process.exit(2);
}

interface Client {
  socket: WebSocket;
  frames: string[];
  closed: Promise<number>;
  next(predicate: (frame: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown>>;
}

const TIMEOUT_MS = 10_000;
const sockets: WebSocket[] = [];

function connect(query: string): Promise<Client> {
  const origin = process.env["ORIGIN"];
  const options = origin ? { headers: { origin } } : undefined;
  // Node's WebSocket takes headers as a second argument (undici)
  const socket = new (WebSocket as unknown as new (url: string, options?: unknown) => WebSocket)(
    `${relay}?${query}`,
    options,
  );
  sockets.push(socket);
  const frames: string[] = [];
  const waiters: Array<() => void> = [];
  socket.addEventListener("message", event => {
    frames.push(String(event.data));
    for (const wake of waiters.splice(0)) {
      wake();
    }
  });
  const closed = new Promise<number>(resolve => socket.addEventListener("close", event => resolve(event.code)));
  const client: Client = {
    socket,
    frames,
    closed,
    async next(predicate, what) {
      const deadline = Date.now() + TIMEOUT_MS;
      for (;;) {
        const index = frames.findIndex(frame => {
          try {
            return predicate(JSON.parse(frame));
          } catch {
            return false;
          }
        });
        if (index >= 0) {
          return JSON.parse(frames.splice(index, 1)[0] as string);
        }
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new Error(`no ${what} within ${TIMEOUT_MS} ms; frames: ${JSON.stringify(frames)}`);
        }
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, left);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(client));
    socket.addEventListener("error", () => reject(new Error(`could not connect to ${relay}?${query}`)));
  });
}

const is = (t: string) => (frame: Record<string, unknown>) => frame["t"] === t;
let step = 0;
function ok(what: string): void {
  step++;
  console.log(`ok ${step} - ${what}`);
}
function check(condition: boolean, what: string): void {
  if (!condition) {
    throw new Error(what);
  }
}

const host = await connect("role=host");
const created = await host.next(is("relay:created"), "relay:created");
const code = String(created["code"]);
const hostToken = String(created["token"]);
check(/^[A-Z2-9]{6}$/.test(code) && hostToken.length === 32, `created: ${JSON.stringify(created)}`);
ok(`room ${code} created`);

let guest = await connect(`code=${code}`);
const joined = await guest.next(is("relay:joined"), "relay:joined");
const guestToken = String(joined["token"]);
await host.next(is("relay:paired"), "relay:paired (host)");
await guest.next(is("relay:paired"), "relay:paired (guest)");
ok("guest joined, both paired");

host.socket.send(JSON.stringify({ t: "game", n: 1 }));
await guest.next(frame => frame["t"] === "game" && frame["n"] === 1, "host's frame at the guest");
guest.socket.send(JSON.stringify({ t: "game", n: 2 }));
await host.next(frame => frame["t"] === "game" && frame["n"] === 2, "guest's frame at the host");
ok("frames forwarded both ways");

guest.socket.send(JSON.stringify({ t: "relay:closed", reason: "idle" }));
host.socket.send(JSON.stringify({ t: "game", n: 3 }));
await guest.next(frame => frame["n"] === 3, "frame after the forged one");
check(!host.frames.some(frame => frame.includes("relay:closed")), "a forged control frame was forwarded");
ok("a forged control frame is not forwarded");

const third = await connect(`code=${code}`);
const full = await third.next(is("relay:error"), "relay:error full");
check(full["reason"] === "full" && (await third.closed) === 4002, `third player: ${JSON.stringify(full)}`);
ok("a third player is refused (full)");

const wrong = await connect(`code=${code}&seat=guest&token=${"0".repeat(32)}`);
const badToken = await wrong.next(is("relay:error"), "relay:error badToken");
check(badToken["reason"] === "badToken", `wrong token: ${JSON.stringify(badToken)}`);
ok("the wrong token is refused");

const nowhere = await connect("code=ZZZZZ2");
const notFound = await nowhere.next(is("relay:error"), "relay:error notFound");
check(notFound["reason"] === "notFound", `unknown code: ${JSON.stringify(notFound)}`);
ok("an unknown code is refused");

guest.socket.close(1000);
const left = await host.next(is("relay:peerLeft"), "relay:peerLeft");
check(left["holdMs"] === null, `peerLeft: ${JSON.stringify(left)}`);
ok("the host is told the guest left");

guest = await connect(`code=${code}&seat=guest&token=${guestToken}`);
const rejoined = await guest.next(is("relay:rejoined"), "relay:rejoined");
check(rejoined["peerPresent"] === true, `rejoined: ${JSON.stringify(rejoined)}`);
await host.next(is("relay:peerBack"), "relay:peerBack");
await host.next(is("relay:paired"), "relay:paired again");
ok("the guest took the seat back");

const replacing = await connect(`code=${code}&seat=guest&token=${guestToken}`);
await replacing.next(is("relay:rejoined"), "relay:rejoined (replacing)");
check((await guest.closed) === 4000, "the older guest connection was not replaced");
guest = replacing;
ok("a newer connection replaces the older one (4000)");

guest.socket.close(4003);
const closed = await host.next(is("relay:closed"), "relay:closed");
check(closed["reason"] === "partnerLeft" && (await host.closed) === 4001, `End session: ${JSON.stringify(closed)}`);
ok("End session closes the room for both");

const after = await connect(`code=${code}&seat=host&token=${hostToken}`);
const gone = await after.next(is("relay:error"), "relay:error after the room closed");
check(gone["reason"] === "notFound", `after End session: ${JSON.stringify(gone)}`);
ok("the room's tokens stop working");

// Matchmaking (D37): a build of its own, so a live queue's players are never matched with these
const build = `smoke-${Math.random().toString(36).slice(2, 10)}`;
const first = await connect(`match=${build}`);
await first.next(is("relay:queued"), "relay:queued (first)");
first.socket.send('{"t":"match:ping"}');
await first.next(is("relay:pong"), "relay:pong");
const second = await connect(`match=${build}`);
await first.next(is("relay:matchHost"), "relay:matchHost");
await second.next(is("relay:matched"), "relay:matched");
ok("two players of a build are matched; the first hosts");
first.socket.send(JSON.stringify({ t: "match:code", code: "ABC234" }));
const matchGuest = await second.next(is("relay:matchGuest"), "relay:matchGuest");
check(matchGuest["code"] === "ABC234", `matchGuest: ${JSON.stringify(matchGuest)}`);
check((await first.closed) === 1000 && (await second.closed) === 1000, "the queue did not close both after the code");
ok("the host's room code reaches the guest, then both leave the queue");

const lonely = await connect(`match=${build}`);
await lonely.next(is("relay:queued"), "relay:queued (lonely)");
const leaving = await connect(`match=${build}`);
await lonely.next(is("relay:matchHost"), "relay:matchHost (lonely)");
leaving.socket.close(1000);
await lonely.next(is("relay:matchLost"), "relay:matchLost");
ok("a partner who leaves before the room puts the other back in the queue");
const unreadable = await connect("match=not%20a%20build");
const bad = await unreadable.next(is("relay:error"), "relay:error badRequest");
check(bad["reason"] === "badRequest", `bad build: ${JSON.stringify(bad)}`);
ok("a build it cannot read is refused");

console.log(`all ${step} checks passed`);
for (const socket of sockets) {
  socket.close();
}
