// SPDX-License-Identifier: GPL-3.0-only
/**
 * Script-insertion records in the worker: merging what the bridge relays, and the
 * interned form they are persisted in (provenance).
 *
 * The ObservationSet keeps plain URLs, because it is the contract a skeptic reads by hand.
 * chrome.storage.session does not need to: a few hundred records each repeating the same
 * eight loader URLs is the shape that exhausts the quota, so the persisted form stores
 * every URL once in a table and the records refer to it by index. Expanded again on read;
 * nothing outside this file sees the interned form.
 */

import type { ScriptInsertion, ScriptInsertionLoader } from "@gpc-inspector/schema";

/** Loaders per key, as the schema documents. */
export const LOADERS_PER_KEY = 3;
/** Records per tab, all frames together. Above the capture's per-frame cap on purpose. */
export const RECORDS_PER_TAB = 600;

export interface ReportedInsertion {
  readonly key: string;
  readonly url: string;
  readonly element: ScriptInsertion["element"];
  readonly loader: ScriptInsertionLoader;
}

function signature(l: ScriptInsertionLoader): string {
  return `${l.via}|${l.frameOrigin}|${l.topFrame ? 1 : 0}|${l.insertedBy.join(" ")}|${l.currentScriptKey ?? ""}`;
}

/**
 * Merge one reported insertion into the tab's records, in place.
 *
 * A known key with a known loader takes the larger count (the capture re-reports an entry
 * when its count grows). A known key with a new loader adds it, up to the cap, keeping the
 * entries sorted by first insertion so canonicalisation is stable. A new key is appended
 * until the per-tab cap.
 */
export function mergeInsertion(records: ScriptInsertion[], reported: ReportedInsertion): void {
  const idx = records.findIndex((r) => r.key === reported.key);
  if (idx < 0) {
    if (records.length >= RECORDS_PER_TAB) return;
    records.push({ key: reported.key, url: reported.url, element: reported.element, loaders: [reported.loader] });
    return;
  }
  const existing = records[idx]!;
  const sig = signature(reported.loader);
  const loaders = existing.loaders.map((l) =>
    signature(l) === sig && reported.loader.count > l.count ? { ...l, count: reported.loader.count } : l,
  );
  if (!existing.loaders.some((l) => signature(l) === sig)) {
    if (loaders.length >= LOADERS_PER_KEY) return;
    loaders.push(reported.loader);
    loaders.sort((a, b) => a.timeMs - b.timeMs);
  }
  records[idx] = { ...existing, loaders };
}

/** The persisted shape: a URL table and records whose URL fields are indices into it. */
export interface InternedInsertions {
  readonly urls: readonly string[];
  readonly records: readonly {
    readonly k: number;
    readonly u: number;
    readonly e: ScriptInsertion["element"];
    readonly l: readonly {
      readonly b: readonly number[];
      readonly w?: readonly number[];
      readonly i: boolean;
      readonly c: number | null;
      readonly t: readonly number[];
      readonly v: ScriptInsertionLoader["via"];
      readonly o: number;
      readonly f: boolean;
      readonly n: number;
      readonly m: number;
    }[];
  }[];
}

export function internInsertions(records: readonly ScriptInsertion[]): InternedInsertions {
  const urls: string[] = [];
  const index = new Map<string, number>();
  const id = (s: string): number => {
    const known = index.get(s);
    if (known !== undefined) return known;
    const n = urls.push(s) - 1;
    index.set(s, n);
    return n;
  };
  return {
    urls,
    records: records.map((r) => ({
      k: id(r.key),
      u: id(r.url),
      e: r.element,
      l: r.loaders.map((l) => ({
        b: l.insertedBy.map(id),
        ...(l.wrapperFrames ? { w: l.wrapperFrames.map(id) } : {}),
        i: l.inlineFrames,
        c: l.currentScriptKey === null ? null : id(l.currentScriptKey),
        t: l.containerUrls.map(id),
        v: l.via,
        o: id(l.frameOrigin),
        f: l.topFrame,
        n: l.count,
        m: l.timeMs,
      })),
    })),
  };
}

export function expandInsertions(interned: InternedInsertions | undefined): ScriptInsertion[] {
  if (!interned) return [];
  const u = (i: number): string => interned.urls[i] ?? "";
  return interned.records.map((r) => ({
    key: u(r.k),
    url: u(r.u),
    element: r.e,
    loaders: r.l.map((l) => ({
      insertedBy: l.b.map(u),
      ...(l.w ? { wrapperFrames: l.w.map(u) } : {}),
      inlineFrames: l.i,
      currentScriptKey: l.c === null ? null : u(l.c),
      containerUrls: l.t.map(u),
      via: l.v,
      frameOrigin: u(l.o),
      topFrame: l.f,
      count: l.n,
      timeMs: l.m,
    })),
  }));
}
