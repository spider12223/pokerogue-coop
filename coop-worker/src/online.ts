/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DurableObject } from "cloudflare:workers";
import { countOnline, noteOnline, type OnlineBook } from "./online-book.ts";
import type { Env } from "./shared.ts";

const BOOK_KEY = "book";

/**
 * The one object that keeps the players-online count (D46, `online-book.ts`): the rooms and the queue tell it how many of
 * their players are connected, and the Worker asks it for the total. Kept in storage, so a restart loses nothing.
 */
export class Online extends DurableObject<Env> {
  /** `undefined`: not read from storage yet */
  private book: OnlineBook | undefined;

  /** A room (its object's id) or the queue says how many of its players are connected now */
  async report(key: string, players: number): Promise<void> {
    const book = await this.load();
    noteOnline(book, key, players, Date.now());
    await this.ctx.storage.put(BOOK_KEY, book);
  }

  /** The players connected now */
  async count(): Promise<number> {
    const book = await this.load();
    const before = Object.keys(book).length;
    const players = countOnline(book, Date.now());
    if (Object.keys(book).length !== before) {
      await this.ctx.storage.put(BOOK_KEY, book);
    }
    return players;
  }

  private async load(): Promise<OnlineBook> {
    this.book ??= (await this.ctx.storage.get<OnlineBook>(BOOK_KEY)) ?? {};
    return this.book;
  }
}
