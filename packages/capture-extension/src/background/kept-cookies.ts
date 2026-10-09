// SPDX-License-Identifier: GPL-3.0-only
/**
 * The observations that set a cookie, kept past a worker reclaim (1.27.0).
 *
 * The request list lives in the worker's memory: in storage it fills the session quota and
 * stops every write (see state.ts, the note above liveByTab). A reclaim, about 30 seconds
 * idle, empties it while every count survives, which would leave the Requests tab empty.
 * This keeps one part of it, every cookie the page set, in session storage.
 *
 * Measured 2026-09-30 over 93 corpus pages: a record like this is about 280 bytes, a page's
 * median 25 KB and the largest 392 KB, and a live retailer-k.example reached 2,130 cookie-setting
 * observations in a minute. Chrome counts a stored object at three to four times its JSON
 * length against the quota, and a string at its own length. So:
 *
 *   - each record keeps only what the Requests tab draws: the URL without its query (a
 *     container's `?id=` kept, as insertion records keep it), and each cookie without its
 *     value, which is never persisted;
 *   - records are written as JSON strings, KEPT_CHUNK to a key, so a flush on a busy page
 *     rewrites one small string and not the whole record;
 *   - at most KEPT_COOKIE_RESPONSE_CAP a tab;
 *   - they are the first thing of an open tab dropped when the store refuses a write (state.ts,
 *     reclaimSessionSpace), and the Requests tab says when some were not kept.
 */

import { recordKeyOf } from "@gpc-inspector/engine";
import { KEPT_COOKIE_RESPONSE_CAP } from "@gpc-inspector/schema";
import type { KeptCookieResponse, NetworkObservation } from "@gpc-inspector/schema";

/** Records per stored key. About 70 KB of JSON at the measured size. */
export const KEPT_CHUNK = 250;
export const KEPT_PREFIX = "cookies:";

/** Chunks a tab can have at the cap: 8. */
export const KEPT_MAX_CHUNKS = Math.ceil(KEPT_COOKIE_RESPONSE_CAP / KEPT_CHUNK);

export function keptKey(tabId: number, chunk: number): string {
  return `${KEPT_PREFIX}${tabId}:${chunk}`;
}

/**
 * Every key a tab's kept records can be under. Few enough to read or remove whole, so no
 * count has to be looked up first, and a chunk a failed removal left behind goes too.
 */
export function keptKeys(tabId: number): string[] {
  return Array.from({ length: KEPT_MAX_CHUNKS }, (_, n) => keptKey(tabId, n));
}

/** How many chunks `stored` holds for the tab: one past the last present, 0 for none. */
export function chunksPresent(stored: Record<string, unknown>, tabId: number): number {
  for (let n = KEPT_MAX_CHUNKS; n > 0; n--) if (keptKey(tabId, n - 1) in stored) return n;
  return 0;
}

/** The tab a kept-record key belongs to, or null for any other key. */
export function keptTabOf(key: string): number | null {
  if (!key.startsWith(KEPT_PREFIX)) return null;
  const id = Number(key.slice(KEPT_PREFIX.length).split(":")[0]);
  return Number.isInteger(id) ? id : null;
}

/** An observation that set a cookie, in the form kept. No cookie value leaves memory. */
export function toKept(obs: NetworkObservation): KeptCookieResponse {
  return {
    id: obs.id,
    url: recordKeyOf(obs.url),
    method: obs.method,
    resourceType: obs.resourceType,
    statusCode: obs.statusCode,
    secGpcPresent: obs.secGpcPresent,
    isRedirectHop: obs.isRedirectHop,
    captureMethod: obs.captureMethod,
    timeMs: obs.timeMs,
    ...(obs.requestLost === true ? { requestLost: true as const } : {}),
    setCookies: obs.setCookies.map(({ value: _never, ...cookie }) => ({
      ...cookie,
      ...(typeof cookie.writerScriptUrl === "string" ? { writerScriptUrl: recordKeyOf(cookie.writerScriptUrl) } : {}),
      ...(typeof cookie.writerWrapperUrl === "string" ? { writerWrapperUrl: recordKeyOf(cookie.writerWrapperUrl) } : {}),
    })),
  };
}

/** Per kept list, by id, where each record is. */
export type KeptSources = Map<string, number>;

/** Where each record of a list is, for a list this worker did not build. */
export function sourcesOf(kept: readonly KeptCookieResponse[]): KeptSources {
  return new Map(kept.map((k, at) => [k.id, at]));
}

/**
 * Keep each observation in `network` that set a cookie and is not yet kept. `kept` and
 * `sources` are the tab's own and are changed in place. Returns whether one was left out at
 * the cap.
 */
export function keepNew(network: readonly NetworkObservation[], kept: KeptCookieResponse[], sources: KeptSources): boolean {
  let capped = false;
  for (const obs of network) {
    if (obs.setCookies.length === 0 || sources.has(obs.id)) continue;
    if (kept.length >= KEPT_COOKIE_RESPONSE_CAP) {
      capped = true;
      continue;
    }
    sources.set(obs.id, kept.length);
    kept.push(toKept(obs));
  }
  return capped;
}

/**
 * Remake the record of `obs`, when one is kept, from the observation as it is now. A probe's
 * set taken back out (forgetProbeSet in sw.ts) replaces its observation, and the record drops
 * the set as the observation did, if need be down to no cookie at all: it stays in place, so
 * no record after it moves. Returns its position, or null when none is kept. The chunk
 * holding it has to be written again.
 */
export function remakeKept(obs: NetworkObservation, kept: KeptCookieResponse[], sources: KeptSources): number | null {
  const at = sources.get(obs.id);
  if (at === undefined) return null;
  kept[at] = toKept(obs);
  return at;
}

/**
 * What a write stores for the kept records: the chunks from the one after the first
 * `written` records, which the store already holds as they are, as strings, and the keys of
 * chunks past the end of the list. The caller passes 0 for a list other than the one it
 * last wrote: a new page, one read back, or one dropped to make room.
 */
export function chunkWrites(
  tabId: number,
  kept: readonly KeptCookieResponse[],
  written: number,
  storedChunks: number,
): { readonly set: Record<string, string>; readonly remove: string[]; readonly chunks: number } {
  const chunks = Math.ceil(kept.length / KEPT_CHUNK);
  const set: Record<string, string> = {};
  if (kept.length !== written) {
    const first = Math.floor(Math.min(written, kept.length) / KEPT_CHUNK);
    for (let n = first; n < chunks; n++) set[keptKey(tabId, n)] = JSON.stringify(kept.slice(n * KEPT_CHUNK, (n + 1) * KEPT_CHUNK));
  }
  const remove: string[] = [];
  for (let n = chunks; n < storedChunks; n++) remove.push(keptKey(tabId, n));
  return { set, remove, chunks };
}

/**
 * The records read back from `count` stored chunks, in order. `complete` is false when a
 * chunk is missing or unreadable: dropped to make room, or written by a worker that ended
 * before it landed.
 */
export function readChunks(stored: Record<string, unknown>, tabId: number, count: number): { readonly records: KeptCookieResponse[]; readonly complete: boolean } {
  const records: KeptCookieResponse[] = [];
  let complete = true;
  for (let n = 0; n < count; n++) {
    const raw = stored[keptKey(tabId, n)];
    if (typeof raw !== "string") {
      complete = false;
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) records.push(...(parsed as KeptCookieResponse[]));
      else complete = false;
    } catch {
      complete = false;
    }
  }
  return { records, complete };
}
