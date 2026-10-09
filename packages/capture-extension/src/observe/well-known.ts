// SPDX-License-Identifier: GPL-3.0-only
/**
 * The published GPC resource (PRD FR-20).
 *
 * `/.well-known/gpc.json` is a voluntary declaration a site makes about itself. Reading it
 * is the only place this extension makes a network request of its own, so the shape of
 * that request matters as much as what it returns:
 *
 *   - Once per ORIGIN, cached. A fetch on every page load would let any site detect the
 *     extension by watching for the request, a fingerprinting surface a privacy tool
 *     should not add.
 *   - Cached in session storage, not local. A durable cache keyed by origin is a browsing
 *     history on disk, created by a privacy tool. Session storage clears when the browser
 *     closes, so its lifetime IS most of the cache policy.
 *   - `credentials: "omit"`. The user's session has no business being sent here.
 *   - Only to the site being visited. A redirect is followed only within the same
 *     registrable domain (www to apex, http to https); one to any other site is not
 *     followed and reads as not found. The settings and the first-run screen both say the
 *     request "goes to the site you are already visiting", and a followed redirect would
 *     have sent it somewhere else.
 *
 * The interpretation is separated from the fetch so the awkward cases — a soft 404 served
 * as HTML with status 200, a 403, a body that is not JSON — are testable without a network.
 */

import type { WellKnownGpc } from "@gpc-inspector/schema";
import { registrableDomain } from "@gpc-inspector/lists";

/** Max age of a cached observation. Beyond this we re-read. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Max age of a cached reading that says nothing about the file (see isCacheable): a request
 * that failed, a server error, a rate limit. Left uncached, a failing site's file would be
 * fetched on every navigation, the request pattern the cache exists to prevent. Short, so
 * one blip on a first visit does not hide a published file for a day.
 */
export const FAILED_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * How old a reading may be and still count as current, for the one finding that rests on
 * it (`declared-honor-cookie-set`).
 *
 * Not "fetched during this very navigation": with the cache, that is nearly unreachable. On
 * the 2026-09-25 corpus run retailer-a.example, health-a.example and health-d.example each
 * navigated twice while loading; the second commit found the entry the first had cached
 * seconds earlier, which that test marks stale, on a first visit, in a fresh profile. Every
 * later page of a site would hit the same wall for a day.
 *
 * Not a re-fetch either: it would break the promise in the settings (the file is requested
 * periodically, "rather than on every page") and reopen the fingerprinting surface the
 * cache exists to close. A window keeps the request pattern the cache sets. Ten minutes is a
 * judgment: long enough to cover a visit's page views, short enough that a site retracting
 * its file in between is not a realistic risk. Past it, the reading is still reported, and
 * still not accused on. The value lives here only; user-facing text says "periodically" and
 * "recent" and names no range.
 */
export const CURRENT_READ_MS = 10 * 60 * 1000;

/**
 * Cap on cached origins.
 *
 * Session storage has a quota, and exhausting it silently fails every write and makes the
 * popup confidently wrong. Entries are ~150 bytes, so this cap is generous; it exists so
 * the failure mode is eviction rather than a silent write failure somewhere else in the
 * extension.
 */
export const MAX_CACHED_ORIGINS = 500;

const KEY_PREFIX = "wk:";

export function cacheKey(origin: string): string {
  return `${KEY_PREFIX}${origin}`;
}

/** The URL to request for an origin. */
export function wellKnownUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}/.well-known/gpc.json`;
}

/**
 * Interpret a response.
 *
 * Deliberately strict about what counts as present. The failure that matters is a server
 * returning a generic HTML error page with status 200 — treating that as "unparseable"
 * would manufacture a diagnostic out of a misconfiguration, when the honest reading is
 * simply that no resource is published there.
 */
export function interpretResponse(
  url: string,
  status: number,
  contentType: string | null,
  body: string,
  now: number = Date.now(),
): WellKnownGpc {
  const base = { url, observedAtMs: now, fresh: true } as const;

  if (status !== 200) {
    return { ...base, present: false, gpc: null, lastUpdate: null, reason: `status ${status}` };
  }

  // A soft 404: HTML served with a 200. Common enough to be the default failure, not an
  // edge case.
  if (contentType !== null && /html/i.test(contentType)) {
    return { ...base, present: false, gpc: null, lastUpdate: null, reason: "html response" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ...base, present: false, gpc: null, lastUpdate: null, reason: "not json" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...base, present: false, gpc: null, lastUpdate: null, reason: "not an object" };
  }

  const obj = parsed as Record<string, unknown>;
  const gpc = obj["gpc"];

  // The spec defines `gpc` as a boolean. A file without it is not a GPC resource, whatever
  // else it contains.
  if (typeof gpc !== "boolean") {
    return { ...base, present: false, gpc: null, lastUpdate: null, reason: "no gpc field" };
  }

  return {
    ...base,
    present: true,
    gpc,
    lastUpdate: typeof obj["lastUpdate"] === "string" ? obj["lastUpdate"] : null,
    reason: null,
  };
}

/** Is a cached observation still usable? A failed read is kept for FAILED_MAX_AGE_MS. */
export function isFresh(entry: WellKnownGpc, now: number = Date.now()): boolean {
  return now - entry.observedAtMs < (isCacheable(entry) ? MAX_AGE_MS : FAILED_MAX_AGE_MS);
}

/**
 * A cached entry, with `fresh` saying whether it is recent enough to rest a finding on.
 *
 * `fresh` gates the `declared-honor-cookie-set` finding: a site can retract its file at any
 * time, and resting an accusation on a declaration that may have been withdrawn is the kind
 * of claim this product must not make. Stale is fine for reporting and not for accusing. A
 * reading from the last CURRENT_READ_MS is current; an older one is reported and not
 * accused on.
 */
export function asCached(entry: WellKnownGpc, now: number = Date.now()): WellKnownGpc {
  return { ...entry, fresh: now - entry.observedAtMs < CURRENT_READ_MS };
}

/**
 * Hosts Chrome keeps every extension out of, whatever host_permissions say. The Web Store
 * is the one a user actually lands on: a probe there fails with a CORS error that Chrome
 * logs against the extension, and there is nothing to learn from it.
 */
const RESTRICTED_HOSTS: ReadonlySet<string> = new Set(["chromewebstore.google.com", "chrome.google.com"]);

/** Origin of a URL, or null when it will not parse or Chrome would refuse the request. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (RESTRICTED_HOSTS.has(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** How much of a response body is read. A GPC resource is a few dozen bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * How long the request may take, body included. A server that holds the connection open
 * otherwise keeps the check, and the popup's "checking" row, waiting indefinitely.
 */
export const FETCH_TIMEOUT_MS = 10_000;

const REQUEST_FAILED = "request failed";

/** Reasons a redirect was not followed. Both read as not found. */
export const REDIRECT_OFF_SITE = "redirect to another site";
/** The redirect's target was never reported, so there was nowhere known to go. */
export const REDIRECT_UNSEEN = "redirect target not seen";

/** Redirects followed, all within the site, before giving up. */
export const MAX_REDIRECTS = 5;

/**
 * Whether a reading says something about the file that is worth caching for a day. A
 * request that failed (offline, timed out, refused), a server error or rate limit, and a
 * redirect whose target we never learned are about that moment, not about the file: cached
 * for a day, one blip on a first visit would hide a published declaration for a day. They are
 * cached for FAILED_MAX_AGE_MS instead (isFresh).
 */
export function isCacheable(entry: WellKnownGpc): boolean {
  return !gotNoAnswer(entry) && !/^status (5\d\d|408|429)$/.test(entry.reason ?? "");
}

/**
 * Whether a reading got no answer from the server at all: the request failed (timed out,
 * refused, offline) or a redirect's target was never reported. Unlike a status, however
 * unwelcome, this says nothing about whether the file exists, so it is reported as "could not
 * be checked" rather than "not found", and it is the one kind of reading retried once after
 * the page loads (RetryAfterLoad).
 */
export function gotNoAnswer(entry: WellKnownGpc): boolean {
  const reason = entry.reason ?? "";
  return !entry.present && (reason.startsWith(REQUEST_FAILED) || reason === REDIRECT_UNSEEN);
}

/**
 * Which tabs are owed one more read of the file, after their page has finished loading.
 *
 * The read starts at commit, while the page is loading, and a read that gets no answer then
 * (a timeout, a dropped connection) is cached for FAILED_MAX_AGE_MS, hiding a published file
 * from every page of the site in that window. One retry once the load completes replaces it
 * when the server answers.
 *
 * Bounded so the request pattern stays what the cache promises: at most one retry, and only
 * for a reading this navigation fetched itself. A reading served from the cache never earns
 * one, so a site that does not answer is not asked again on every page, and the retry's own
 * failure earns nothing further. The ledger lives in memory: a worker restart drops what it
 * owed, which costs a retry and never adds a request.
 */
export class RetryAfterLoad {
  private readonly tabs = new Map<number, { origin: string; phase: "owed" | "loaded" | "spent" }>();

  /** A top-level navigation started, or the tab closed: whatever the last page was owed is gone. */
  navigated(tabId: number): void {
    this.tabs.delete(tabId);
  }

  /** The tab's top document finished loading. True when a retry is owed: run it now. */
  loaded(tabId: number, origin: string): boolean {
    const t = this.tabs.get(tabId);
    if (t !== undefined && t.origin === origin) {
      if (t.phase !== "owed") return false;
      this.tabs.set(tabId, { origin, phase: "spent" });
      return true;
    }
    this.tabs.set(tabId, { origin, phase: "loaded" });
    return false;
  }

  /**
   * This navigation's own read got no answer. True when the page has already finished
   * loading: run the retry now. Otherwise it waits for `loaded`.
   */
  noAnswer(tabId: number, origin: string): boolean {
    const t = this.tabs.get(tabId);
    if (t !== undefined && t.origin === origin) {
      if (t.phase !== "loaded") return false;
      this.tabs.set(tabId, { origin, phase: "spent" });
      return true;
    }
    this.tabs.set(tabId, { origin, phase: "owed" });
    return false;
  }
}

/** What a retry needs from the worker: the read itself and the per-origin cache. */
export interface RetryDeps {
  read: () => Promise<WellKnownGpc>;
  getCached: (origin: string) => Promise<WellKnownGpc | null>;
  putCached: (origin: string, entry: WellKnownGpc) => Promise<void>;
}

/**
 * Retry a reading that got no answer. Returns the reading to show, or null to leave the row
 * as it is.
 *
 * When the cache already holds an answer (another tab's read of the same site succeeded in
 * the meantime), that answer is used and nothing is requested. An answer replaces the cached
 * failure, so the next page of the site gets the file rather than the failure. A retry that
 * also gets no answer changes nothing: the first failure keeps its time, and with it the
 * moment the site is next read.
 */
export async function retryReading(
  origin: string,
  deps: RetryDeps,
  now: () => number = Date.now,
): Promise<WellKnownGpc | null> {
  const cached = await deps.getCached(origin);
  if (cached !== null && !gotNoAnswer(cached) && isFresh(cached, now())) return asCached(cached, now());
  const observed = await deps.read();
  if (gotNoAnswer(observed)) return null;
  await deps.putCached(origin, observed);
  return observed;
}

/**
 * Whether a redirect from `from` to `to` stays on the same site: http or https, and the same
 * registrable domain. www.example.com to example.com and http to https are; a CDN's host,
 * a parked-domain page or a sign-in host is not.
 */
export function sameSiteRedirect(from: string, to: string): boolean {
  try {
    const a = new URL(from);
    const b = new URL(to);
    if (b.protocol !== "http:" && b.protocol !== "https:") return false;
    if (RESTRICTED_HOSTS.has(b.hostname)) return false;
    return registrableDomain(a.hostname) === registrableDomain(b.hostname);
  } catch {
    return false;
  }
}

/** Where a request was redirected to, once the browser reports it. */
export interface RedirectWatch {
  /** The target, or null when none was reported within `waitMs`. */
  target(waitMs: number): Promise<string | null>;
  stop(): void;
}

/**
 * Starts watching one URL, before it is requested. A fetch with `redirect: "manual"` gets an
 * opaque response with no Location, so the target comes from the browser's own report.
 */
export type WatchRedirect = (url: string) => RedirectWatch;

/** How long to wait for the redirect report once the fetch has answered. */
export const REDIRECT_REPORT_WAIT_MS = 1000;

/**
 * The worker's watcher: webRequest reports the extension's own requests to itself, with tab
 * -1 and a redirect target even when the fetch does not follow it. Verified live 2026-10-01:
 * on github.com (http to https), news-g.example (apex to www) and example.com the report arrived
 * before the fetch answered.
 */
export const watchRedirectWithWebRequest: WatchRedirect = (url) => {
  const want = new URL(url).href;
  let seen: string | null = null;
  let wake: (() => void) | null = null;
  const listener = (d: { url: string; tabId: number; redirectUrl: string }): void => {
    if (seen !== null || d.tabId !== -1 || d.url !== want) return;
    seen = d.redirectUrl;
    wake?.();
  };
  chrome.webRequest.onBeforeRedirect.addListener(listener, { urls: ["<all_urls>"], tabId: -1 });
  return {
    target: (waitMs) =>
      seen !== null
        ? Promise.resolve(seen)
        : new Promise((resolve) => {
            const timer = setTimeout(() => resolve(seen), waitMs);
            wake = () => {
              clearTimeout(timer);
              resolve(seen);
            };
          }),
    stop: () => chrome.webRequest.onBeforeRedirect.removeListener(listener),
  };
};

/**
 * Read at most `cap` bytes of a body as text, then stop the download. `text()` buffers the
 * whole body first, however large.
 */
async function readCapped(response: Response, cap: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return (await response.text()).slice(0, cap);
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return text.slice(0, cap);
}

/**
 * Fetch and interpret, with no caching. The caller owns the cache so this stays testable.
 *
 * A network failure is reported as "not present" with a reason rather than thrown: a site
 * that is unreachable has published nothing observable, and the caller has no better answer
 * to give than that. isCacheable tells the caller to keep it only briefly.
 *
 * Redirects are taken one hop at a time (`redirect: "manual"`), and each target is checked
 * before it is requested: one that leaves the site is never requested, and the reading is
 * not found. `watchRedirect` reports each hop's target; without one, no redirect is followed.
 */
export async function fetchWellKnown(
  origin: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
  watchRedirect: WatchRedirect | null = null,
): Promise<WellKnownGpc> {
  let url = wellKnownUrl(origin);
  const notFound = (reason: string): WellKnownGpc => ({
    url,
    present: false,
    gpc: null,
    lastUpdate: null,
    observedAtMs: Date.now(),
    fresh: true,
    reason,
  });
  // One timeout for the whole read, every hop included.
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    for (let hop = 0; ; hop++) {
      const watch = watchRedirect?.(url) ?? null;
      let next: string | null = null;
      try {
        const response = await fetch(url, {
          credentials: "omit",
          redirect: "manual",
          cache: "no-cache",
          signal,
        });
        if (response.type !== "opaqueredirect") {
          const contentType = response.headers.get("content-type");
          // Capped: a misconfigured server can return a large HTML page, and we need only
          // enough to determine there is no JSON object here.
          const body = await readCapped(response, MAX_BODY_BYTES);
          return interpretResponse(url, response.status, contentType, body);
        }
        next = watch === null ? null : await watch.target(REDIRECT_REPORT_WAIT_MS);
      } finally {
        watch?.stop();
      }
      if (next === null) return notFound(REDIRECT_UNSEEN);
      if (!sameSiteRedirect(url, next)) return notFound(REDIRECT_OFF_SITE);
      if (hop >= MAX_REDIRECTS) return notFound("too many redirects");
      url = next;
    }
  } catch (e) {
    return notFound(`${REQUEST_FAILED}: ${String(e).slice(0, 80)}`);
  }
}
