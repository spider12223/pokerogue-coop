/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  type Client,
  chooseRunMode,
  describeClients,
  EXTERNAL_BASE_URL,
  newClientContext,
  openClient,
  openCoopMenu,
  playUntil,
  press,
  shotsDir,
  startLinkedRun,
  useRelay,
  waitForTitle,
} from "./coop-client.ts";

/**
 * End-to-end tests (DECISIONS D16, D25): the room code, the Source link, the hotkeys and the problem report. Run
 * against a deployed build (the container of `docs/coop/HOSTING.md`, `E2E_BASE_URL`), the title screen must have its
 * Source link; against the dev server it has none, because the dev build is not given an address.
 *
 * | test | what happens | what is checked |
 * | --- | --- | --- |
 * | 1 | the host opens a room and presses "Copy code" | the menu has "Copy code" and "Cancel"; the code is in the clipboard; the message says so and keeps the code on screen |
 * | 2 | two clients in a battle: the host presses the keys | the key P of the keyboard pings, and the partner sees the ping with the host's name; Q opens the emote wheel (in a deployed build) |
 * | 3 | two clients play to the first command menu; the host reports a problem | both co-op logs reach the server (the session, the lobby, the decisions) with their seat and name; the report has the note and a snapshot; no line has a token (D26) |
 */

const SHOTS = shotsDir("polish");
const sleep = (client: Client, ms: number): Promise<void> => client.page.waitForTimeout(ms);
const coop = <T>(client: Client, path: string): Promise<T> =>
  client.page.evaluate(
    keys => keys.split(".").reduce((value: any, key) => value?.[key], (window as any).__coop) as T,
    path,
  );

test.describe("co-op: the lobby, the hotkeys and problem reports", () => {
  const relay = useRelay({ clientLogs: true });

  test("the lobby copies the room code, and the title screen links to the source", async ({ browser }, testInfo) => {
    test.setTimeout(600_000);
    mkdirSync(SHOTS, { recursive: true });
    const context = await newClientContext(browser, true);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const host = await openClient(context, "host");
    try {
      await waitForTitle(host);
      // the Source link of the title screen (D25): a deployed build has one, the dev server does not
      const source = await coop<string | null>(host, "sourceLink");
      if (EXTERNAL_BASE_URL === undefined) {
        expect(source).toBeNull();
      } else {
        expect(source).toMatch(/^https?:\/\/\S+$/);
      }

      await openCoopMenu(host);
      await press(host, "ACTION"); // "Host a game": the first entry while there is no co-op slot
      await chooseRunMode(host);
      await expect
        .poll(() => coop<string | null>(host, "joinCode"), { message: "no join code", timeout: 30_000 })
        .not.toBeNull();
      const code = (await coop<string>(host, "joinCode"))!;
      await expect
        .poll(() => coop<string[]>(host, "menuOptions"), { message: "the menu of the lobby", timeout: 30_000 })
        .toEqual(["Copy code", "Cancel"]);

      // "Copy code" is the first entry
      await press(host, "ACTION");
      // (the text is typed out letter by letter: wait for the whole of it, the code at its end)
      await expect
        .poll(() => coop<string>(host, "messageText"), { message: "no word about the copy", timeout: 30_000 })
        .toMatch(new RegExp(`(Copied ${code}|Could not copy. Your join code is ${code})`));
      expect(await coop<string[]>(host, "menuOptions")).toEqual(["Copy code", "Cancel"]);
      expect(await host.page.evaluate(() => navigator.clipboard.readText())).toBe(code);
      await sleep(host, 1500);
      await host.page.screenshot({ path: join(SHOTS, "copy-code.png") });
    } catch (error) {
      await testInfo.attach("clients.json", {
        body: JSON.stringify(await describeClients(host), null, 2),
        contentType: "application/json",
      });
      throw error;
    } finally {
      await context.close();
    }
  });

  test("the keys of the keyboard ping and open the emote wheel", async ({ browser }, testInfo) => {
    test.setTimeout(900_000);
    const hostContext = await newClientContext(browser, true);
    const guestContext = await newClientContext(browser, true);
    const [host, guest] = await Promise.all([openClient(hostContext, "host"), openClient(guestContext, "guest")]);
    try {
      await Promise.all([waitForTitle(host), waitForTitle(guest)]);
      await host.page.evaluate(() => (window as any).__coop.setName("Sam"));
      await guest.page.evaluate(() => (window as any).__coop.setName("Alex"));
      await startLinkedRun(host, guest);
      await Promise.all([
        playUntil(host, "the command menu", state => state.ui === "COMMAND"),
        playUntil(guest, "the command menu", state => state.ui === "COMMAND"),
      ]);

      // P is the ping key until the player moves it
      expect(await coop<string | null>(host, "pingKey")).toBe("P");
      await host.page.keyboard.press("KeyP");
      await expect
        .poll(async () => (await coop<{ pings: { name: string }[] } | null>(guest, "cosmetics"))?.pings ?? [], {
          message: "the ping never arrived",
          timeout: 20_000,
        })
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: "Sam" })]));

      // Q opens the emote wheel (a development build keeps Q for its own button)
      if (EXTERNAL_BASE_URL !== undefined) {
        await host.page.keyboard.press("KeyQ");
        await expect
          .poll(() => coop<string>(host, "ui"), { message: "no emote wheel", timeout: 20_000 })
          .toBe("OPTION_SELECT");
        expect((await coop<string[]>(host, "menuOptions")).length).toBeGreaterThan(2);
        await press(host, "CANCEL");
      }
    } catch (error) {
      await testInfo.attach("clients.json", {
        body: JSON.stringify(await describeClients(host, guest), null, 2),
        contentType: "application/json",
      });
      throw error;
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
  test("the co-op logs of both players reach the server, and a report adds the note and a snapshot", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(900_000);
    const hostContext = await newClientContext(browser, true);
    const guestContext = await newClientContext(browser, true);
    const [host, guest] = await Promise.all([openClient(hostContext, "host"), openClient(guestContext, "guest")]);
    try {
      await Promise.all([waitForTitle(host), waitForTitle(guest)]);
      await host.page.evaluate(() => (window as any).__coop.setName("Sam"));
      await guest.page.evaluate(() => (window as any).__coop.setName("Alex"));
      await startLinkedRun(host, guest);
      // play until the first commands are in: they are the run's first sequenced decisions
      const decided = async (client: Client): Promise<boolean> =>
        (await coop<{ kind: string }[]>(client, "coopLog")).some(entry => entry.kind === "decision");
      await Promise.all([
        playUntil(host, "a logged decision", () => decided(host)),
        playUntil(guest, "a logged decision", () => decided(guest)),
      ]);

      // each game logged its session, its lobby and the run's first decisions
      for (const client of [host, guest]) {
        const kinds = (await coop<{ kind: string }[]>(client, "coopLog")).map(entry => entry.kind);
        expect(kinds).toEqual(expect.arrayContaining(["lobby", "session", "decision"]));
      }

      const result = await host.page.evaluate(() => (window as any).__coop.report("the menu froze for a moment"));
      if (EXTERNAL_BASE_URL !== undefined) {
        // a deployed server collects the logs only with CLIENT_LOGS=1: either way the report is made
        expect(["sent", "saved"]).toContain(result);
        return;
      }
      expect(result).toBe("sent");
      // the lines of this test's room: the server of this file also collected the lobby of the first test
      const room = await coop<string>(host, "roomCode");
      expect(room).toMatch(/^[A-Z0-9]{4,8}$/);
      const lines = () =>
        relay.clientLines.map(line => JSON.parse(line) as Record<string, any>).filter(line => line["room"] === room);
      await expect
        .poll(() => lines().some(line => line["seat"] === "guest" && line["kind"] === "decision"), {
          message: "the guest's log never reached the server",
          timeout: 30_000,
        })
        .toBe(true);
      const report = lines().find(line => line["kind"] === "report");
      expect(report).toMatchObject({ seat: "host", name: "Sam", level: "warn", msg: "the menu froze for a moment" });
      expect(report?.["data"]).toMatchObject({
        phase: expect.any(String),
        party: expect.any(Array),
        trace: expect.any(Array),
      });
      expect(
        lines()
          .filter(line => line["seat"] === "host")
          .every(line => line["name"] === "Sam"),
      ).toBe(true);
      expect(
        lines()
          .filter(line => line["seat"] === "guest")
          .every(line => line["name"] === "Alex"),
      ).toBe(true);
      // every line names the room, from the lobby on, and it is the same one for both players
      for (const seat of ["host", "guest"]) {
        expect(
          lines().some(line => line["seat"] === seat && line["kind"] === "lobby"),
          `the ${seat}'s lobby lines name the room`,
        ).toBe(true);
      }
      // never a seat token, never an address
      expect(relay.clientLines.some(line => /token|127\.0\.0\.1/i.test(line))).toBe(false);
    } catch (error) {
      await testInfo.attach("clients.json", {
        body: JSON.stringify(await describeClients(host, guest), null, 2),
        contentType: "application/json",
      });
      throw error;
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});
