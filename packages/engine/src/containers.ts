// SPDX-License-Identifier: GPL-3.0-only
/**
 * What each tag container on the page did (1.25.0): the summary the Overview's Tag
 * containers rows are drawn from.
 *
 * A container runs other companies' code inside itself, so what a tag in it did resolves to
 * the container and to no tag: which tag read GPC, wrote a cookie or sent a request is not
 * observable, so no tag is ever named. What is observable is kept per container here, from
 * the records that survive a worker reclaim: the insertion and request-initiator records,
 * the reads split by container, the consent calls, the loader scan in `gtm`, and the
 * cookies each container's summary kept (`tallies.byContainer`).
 * The request list is never read, so the rows are the same before and after a reclaim.
 *
 * WHICH CONTAINER A RECORD IS. The innermost frame on its stack that names an id, the rule
 * `resolveLoaders` uses for insertions and `checksByContainer` uses for checks. A
 * frame that names no id (a helper script from the manager's host) joins the named
 * container whose frames inserted it, when an insertion record says one did; otherwise it
 * is a summary of its own with `id: null`.
 *
 * Pure, like the rest of the engine.
 */

import type { ContainerTally, LoaderIdentity, ObservationSet, ScriptInsertion } from "@gpc-inspector/schema";
import { callCount, containerIdentity, containerKey, type ContainerIdentity } from "@gpc-inspector/schema";
import type { Category, Classifier } from "./classifier.js";
import { categoryRank } from "./classifier.js";
import { gppCheckTest } from "./gpp-check.js";
import { innermostNamed, recordKeyOf, resolveLoaders, type ProvenanceResolution } from "./provenance.js";
import { withPersistedShape } from "./normalize.js";

export interface ContainerSummary {
  readonly identity: ContainerIdentity;
  /** Every frame URL seen for it, query kept until redaction, sorted. */
  readonly frameUrls: readonly string[];
  /**
   * The container's own address: the URLs of its loader script as it was inserted, where a
   * record says so, else the frame URLs. A Tealium profile runs as utag.js and one file per
   * tag (utag.12.js), and its address is the first alone.
   */
  readonly scripts: readonly string[];
  /** The container that inserted its script, from the container graph. */
  readonly parent: ContainerIdentity | null;
  /** Who inserted the container's own script. Empty when the records cannot tell. */
  readonly loadedBy: readonly LoaderIdentity[];
  /** Traced reads of the GPC property that resolved into its frames. A sample: tested against zero. */
  readonly reads: number;
  /** Consent API calls that resolved into its frames, by API, `ping` included. */
  readonly consentCalls: readonly { api: string; count: number }[];
  /** A `__gpp` check of the choice (gppCheckTest) resolved into its frames. */
  readonly gppRead: boolean;
  /** The companies whose scripts it inserted, each in the category of the script's domain. */
  readonly loaded: readonly { entity: string; category: Category }[];
  /** Registrable domains of scripts it inserted that no company is named for. */
  readonly loadedDomains: readonly string[];
  /** Containers whose loader script it inserted. */
  readonly loadedContainers: readonly ContainerIdentity[];
  /** Where its tags sent requests, by company and category, or by domain where no company is named. */
  readonly requestsTo: readonly { entity: string | null; category: Category; domain: string; hosts: readonly string[] }[];
  /** What was written inside it, from the tallies. null when nothing was, or the capture predates the record. */
  readonly cookies: ContainerTally | null;
  /** Found on the page (the loader scan) with nothing recorded under it. */
  readonly quiet: boolean;
}

interface Draft {
  identity: ContainerIdentity;
  frameUrls: Set<string>;
  scripts: Set<string>;
  parent: ContainerIdentity | null;
  loadedBy: Map<string, LoaderIdentity>;
  reads: number;
  calls: Map<string, number>;
  gppRead: boolean;
  loaded: Map<string, { entity: string; category: Category }>;
  loadedDomains: Set<string>;
  loadedContainers: Map<string, ContainerIdentity>;
  requestsTo: Map<string, { entity: string | null; category: Category; domain: string; hosts: Set<string> }>;
  cookies: ContainerTally | null;
  /** Anything recorded beyond the loader scan. */
  seen: boolean;
}

export function containerSummaries(
  given: ObservationSet,
  classifier: Classifier,
  resolution?: ProvenanceResolution,
): ContainerSummary[] {
  const obs = withPersistedShape(given);
  const topSite = obs.context.topSite;
  const res = resolution ?? resolveLoaders(obs, classifier);
  const insertions = obs.scriptInsertions ?? [];
  const insertionKeys = new Set(insertions.map((r) => r.key));
  const initiators = (obs.requestInitiators ?? []).filter((r) => !insertionKeys.has(r.key));

  // A helper frame (a manager's script that names no id) belongs to the named container
  // whose frames inserted it, when a record says so.
  const helperOf = new Map<string, ContainerIdentity>();
  for (const r of insertions) {
    const self = containerIdentity(r.url);
    if (self === null || self.id !== null) continue;
    const by = (res.byKey.get(r.key) ?? []).find(
      (l): l is Extract<LoaderIdentity, { kind: "container" }> => l.kind === "container" && l.identity.id !== null,
    );
    if (by !== undefined) helperOf.set(r.key, by.identity);
  }

  /** The container a frame URL is, after a helper joins its loader. */
  const containerOfFrame = (url: string): ContainerIdentity | null => {
    const id = containerIdentity(url);
    if (id === null) return null;
    if (id.id !== null) return id;
    return helperOf.get(recordKeyOf(url)) ?? id;
  };

  const drafts = new Map<string, Draft>();
  const draftOf = (identity: ContainerIdentity): Draft => {
    const key = containerKey(identity);
    const known = drafts.get(key);
    if (known) return known;
    const fresh: Draft = {
      identity,
      frameUrls: new Set(),
      scripts: new Set(),
      parent: null,
      loadedBy: new Map(),
      reads: 0,
      calls: new Map(),
      gppRead: false,
      loaded: new Map(),
      loadedDomains: new Set(),
      loadedContainers: new Map(),
      requestsTo: new Map(),
      cookies: null,
      seen: false,
    };
    drafts.set(key, fresh);
    return fresh;
  };
  const noteFrame = (url: string): Draft | null => {
    const identity = containerOfFrame(url);
    if (identity === null) return null;
    const d = draftOf(identity);
    d.frameUrls.add(url);
    d.seen = true;
    return d;
  };

  // The loader scan: ids found on the page, recorded or not. Only Google's are scanned for.
  for (const id of obs.gtm.containerIds) draftOf({ manager: "gtm", id });
  for (const id of obs.gtm.gtagIds) draftOf(/^GTM-/i.test(id) ? { manager: "gtm", id } : { manager: "gtag", id });

  // Reads that resolved into a container, split by its frame.
  for (const [url, n] of Object.entries(obs.signal.readAttribution?.viaTagManagerByContainer ?? {})) {
    const d = noteFrame(url);
    if (d !== null) d.reads += n;
  }

  // Consent API calls made from a container's own frames. A vendor's call from inside a
  // container tag is the vendor's, as checksByContainer counts it.
  const isGppCheck = gppCheckTest(obs);
  for (const call of obs.consentApiCalls) {
    if (!call.viaTagManager) continue;
    const frame = innermostNamed(call.containerUrls ?? (call.callerScriptUrl === null ? [] : [call.callerScriptUrl]));
    if (frame === undefined) continue;
    const d = noteFrame(frame);
    if (d === null) continue;
    d.calls.set(call.api, (d.calls.get(call.api) ?? 0) + callCount(call));
    if (isGppCheck(call)) d.gppRead = true;
  }

  // What each container's frames inserted and fetched, by the resolution's own answer.
  const containersOf = (key: string): ContainerIdentity[] => {
    const out = new Map<string, ContainerIdentity>();
    for (const l of res.byKey.get(key) ?? []) {
      if (l.kind !== "container") continue;
      const identity = l.identity.id === null ? (helperOf.get(key) ?? l.identity) : l.identity;
      out.set(containerKey(identity), identity);
    }
    return [...out.values()];
  };
  const noteLoaderFrames = (r: ScriptInsertion): void => {
    for (const l of r.loaders) {
      const frame = innermostNamed(l.containerUrls);
      if (frame !== undefined) noteFrame(frame);
    }
  };

  for (const r of insertions) {
    noteLoaderFrames(r);
    const self = containerIdentity(r.url);
    const selfKey = self === null ? null : containerKey(self.id === null ? (helperOf.get(r.key) ?? self) : self);
    // The container's own script: who inserted it, and the frame it runs as.
    if (self !== null && selfKey !== null) {
      const d = draftOf(self.id === null ? (helperOf.get(r.key) ?? self) : self);
      d.frameUrls.add(r.url);
      d.seen = true;
      let fromOutside = false;
      for (const l of res.byKey.get(r.key) ?? []) {
        if (l.kind === "container" && containerKey(l.identity) === selfKey) continue;
        d.loadedBy.set(JSON.stringify(l), l);
        fromOutside = true;
      }
      // Its address is a script something else inserted: a tag file the container
      // inserts itself is part of it, not where it lives.
      if (self.id !== null && (fromOutside || r.loaders.some((l) => l.via === "parser"))) d.scripts.add(r.url);
    }
    for (const by of containersOf(r.key)) {
      if (selfKey !== null && containerKey(by) === selfKey) continue;
      const d = draftOf(by);
      d.seen = true;
      if (self !== null && self.id !== null) {
        d.loadedContainers.set(containerKey(self), self);
        continue;
      }
      if (self !== null) continue; // a helper of the container itself
      if (r.key.startsWith("inline:")) continue;
      const cls = classifier.classify(r.url, topSite);
      if (cls.entity !== null) d.loaded.set(`${cls.entity.name}\u0000${cls.category}`, { entity: cls.entity.name, category: cls.category });
      else if (cls.registrableDomain !== "") d.loadedDomains.add(cls.registrableDomain);
    }
  }

  for (const r of initiators) {
    noteLoaderFrames(r);
    let host = "";
    try {
      host = new URL(r.url).hostname;
    } catch {
      continue;
    }
    for (const by of containersOf(r.key)) {
      const d = draftOf(by);
      d.seen = true;
      const cls = classifier.classify(r.url, topSite);
      const k = cls.entity !== null ? `e\u0000${cls.entity.name}\u0000${cls.category}` : `d\u0000${cls.registrableDomain}`;
      const entry = d.requestsTo.get(k) ?? { entity: cls.entity?.name ?? null, category: cls.category, domain: cls.registrableDomain, hosts: new Set<string>() };
      entry.hosts.add(host);
      d.requestsTo.set(k, entry);
    }
  }

  // What was written inside each container, as the tallies kept it. A helper's summary
  // joins its container's, keys and all.
  for (const tally of Object.values(obs.tallies.byContainer ?? {})) {
    const frame = tally.frameUrls[0];
    const identity = tally.id !== null || frame === undefined ? { manager: tally.manager, id: tally.id } : (containerOfFrame(frame) ?? { manager: tally.manager, id: tally.id });
    const d = draftOf(identity);
    for (const u of tally.frameUrls) d.frameUrls.add(u);
    d.seen = true;
    d.cookies = d.cookies === null ? { ...tally, manager: identity.manager, id: identity.id } : mergeTallies(d.cookies, tally);
  }

  // Parents, from the container graph; a helper-joined id has none of its own.
  for (const d of drafts.values()) {
    d.parent = d.identity.id === null ? null : (res.parents.get(containerKey(d.identity)) ?? null);
  }

  const out: ContainerSummary[] = [];
  for (const d of drafts.values()) {
    const empty = d.cookies === null || (d.cookies.cookieKeys.length === 0 && d.cookies.cookieKeysUnsigned.length === 0 && d.cookies.probeCookies.length === 0 && d.cookies.refusedWrites.length === 0);
    out.push({
      identity: d.identity,
      frameUrls: [...d.frameUrls].sort(),
      scripts: (d.scripts.size > 0 ? [...d.scripts] : [...d.frameUrls]).sort(),
      parent: d.parent,
      loadedBy: [...d.loadedBy.values()],
      reads: d.reads,
      consentCalls: [...d.calls].sort(([a], [b]) => (a < b ? -1 : 1)).map(([api, count]) => ({ api, count })),
      gppRead: d.gppRead,
      loaded: [...d.loaded.values()].sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.entity.localeCompare(b.entity)),
      loadedDomains: [...d.loadedDomains].sort(),
      loadedContainers: [...d.loadedContainers.values()].sort((a, b) => (containerKey(a) < containerKey(b) ? -1 : 1)),
      requestsTo: [...d.requestsTo.values()]
        .map((e) => ({ ...e, hosts: [...e.hosts].sort() }))
        .sort((a, b) => Number(a.entity === null) - Number(b.entity === null) || categoryRank(a.category) - categoryRank(b.category) || (a.entity ?? a.domain).localeCompare(b.entity ?? b.domain)),
      cookies: empty ? null : d.cookies,
      quiet: !d.seen,
    });
  }
  return out.sort((a, b) => (containerKey(a.identity) < containerKey(b.identity) ? -1 : 1));
}

/** Two summaries of one container (a helper's joining its container's), as one. */
function mergeTallies(a: ContainerTally, b: ContainerTally): ContainerTally {
  const union = (x: readonly string[], y: readonly string[]) => [...new Set([...x, ...y])].sort();
  return {
    manager: a.manager,
    id: a.id,
    frameUrls: union(a.frameUrls, b.frameUrls),
    cookieKeys: union(a.cookieKeys, b.cookieKeys),
    cookieKeysUnsigned: union(a.cookieKeysUnsigned, b.cookieKeysUnsigned),
    probeCookies: union(a.probeCookies, b.probeCookies),
    refusedWrites: union(a.refusedWrites, b.refusedWrites),
    ...(a.capped || b.capped ? { capped: true as const } : {}),
  };
}
