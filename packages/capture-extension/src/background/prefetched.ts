// SPDX-License-Identifier: GPL-3.0-only
/**
 * The cookies a page's prefetches set, kept until the reader opens what was prefetched.
 *
 * A prefetch is listed on the page that asked for it and counts nowhere there (1.46.0). When
 * the reader follows the link, Chrome serves the response it already has: nothing reaches the
 * server, and the navigation's response is reported with no `Set-Cookie`. The cookies the
 * prefetch set arrived with the page the reader opened, so they are handed to the first
 * request in the tab for the same address, and count there like any of its own.
 *
 * Kept by tab and address, once: the first request for the address takes them. Chrome keeps
 * a prefetch for five minutes, and one older than that is dropped unused.
 *
 * In memory. A worker that stops before the page is opened takes them with it, and the
 * opened page lists none of them.
 */
import type { CookieRecord } from "@gpc-inspector/schema";

/** How long Chrome keeps a prefetch for a navigation to use. */
export const PREFETCH_LIFETIME_MS = 5 * 60 * 1000;

/** At most this many addresses per tab: a page can prefetch every link it shows. */
const MAX_PER_TAB = 100;

interface Kept {
  readonly cookies: readonly CookieRecord[];
  readonly atMs: number;
}

export class PrefetchedCookies {
  private readonly byTab = new Map<number, Map<string, Kept>>();

  /** Keep the cookies a prefetch of `url` set. A later prefetch of the address replaces them. */
  keep(tabId: number, url: string, cookies: readonly CookieRecord[], atMs: number): void {
    if (cookies.length === 0) return;
    let tab = this.byTab.get(tabId);
    if (tab === undefined) {
      tab = new Map();
      this.byTab.set(tabId, tab);
    }
    tab.delete(url);
    tab.set(url, { cookies, atMs });
    // The oldest goes first: a Map keeps its keys in the order they were set.
    while (tab.size > MAX_PER_TAB) {
      const oldest = tab.keys().next().value;
      if (oldest === undefined) break;
      tab.delete(oldest);
    }
  }

  /** The cookies a prefetch of `url` set in this tab, if Chrome would still serve it, and then forgotten. */
  take(tabId: number, url: string, atMs: number): readonly CookieRecord[] {
    const tab = this.byTab.get(tabId);
    const kept = tab?.get(url);
    if (tab === undefined || kept === undefined) return [];
    tab.delete(url);
    if (tab.size === 0) this.byTab.delete(tabId);
    return atMs - kept.atMs <= PREFETCH_LIFETIME_MS ? kept.cookies : [];
  }

  forgetTab(tabId: number): void {
    this.byTab.delete(tabId);
  }
}
