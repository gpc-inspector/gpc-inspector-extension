// SPDX-License-Identifier: GPL-3.0-only
/**
 * The Overview's Tag containers rows (1.25.0): one row per tag container on the page, every
 * Google tag id sharing one row, each saying whether a tag inside it read GPC, what was
 * written inside it, who loaded it, and in its panel what it loaded and where its tags sent
 * requests.
 *
 * A container is the site's tool, not a vendor and not an endpoint, so it is a section of
 * its own under Vendors rather than a group of that list. What a tag inside it did resolves
 * to the container and to no tag: the rows never name a tag, and a read is "a tag read
 * GPC", never which one.
 *
 * Built from the engine's containerSummaries, which reads only what survives a worker
 * reclaim, so the rows, their states and their cookies are the same after one. Plain data
 * throughout: the side panel compares two views as JSON.
 */

import type { Finding, LoaderIdentity, ObservationSet, CookieDetail, ContainerIdentity } from "@gpc-inspector/schema";
import { containerKey, redactUrl } from "@gpc-inspector/schema";
import { containerSummaries, type Classifier, type Classification, type ContainerSummary } from "@gpc-inspector/engine";
import type { BuildInput, LoadedViaLine, UrlClass } from "./view-model.js";
import { formatExpiry, gppCallReads, gppGpcRecord, loaderLines, loadedViaRowLine } from "./view-model.js";

/** Brand names, never translated. The Google tag's name is a message (containerNameGoogleTag). */
export const MANAGER_NAMES: Readonly<Record<string, string>> = {
  gtm: "Google Tag Manager",
  tealium: "Tealium",
  "adobe-launch": "Adobe Launch",
  segment: "Segment",
  matomo: "Matomo Tag Manager",
  "piwik-pro": "Piwik PRO",
  ensighten: "Ensighten",
  "commanders-act": "Commanders Act",
};

/** One cookie written inside a container, on its row. */
export interface ContainerCookie {
  /** The name, or "name (domain)" where one name was written on two domains. */
  readonly name: string;
  /** Whether the headline counts it: the owner's own name. Drawn in the attention color. */
  readonly counted: boolean;
}

/** One cookie in a container's panel. */
export interface ContainerCookieDetail {
  readonly name: string;
  readonly domain: string;
  /** The company and category the count includes it under; absent when it is not counted. */
  readonly countedUnder?: { readonly entity: string; readonly category: string };
  readonly expiry?: string;
  readonly sameSite?: string;
  readonly partitioned: boolean;
  readonly via?: string;
  readonly onRedirect: boolean;
  /** Counted, and on the list of functional cookie names. See VendorRow.functionalCookies. */
  readonly functional: boolean;
}

export interface ContainerDetail {
  /** Every cookie written inside it, signed (or unsigned with sending off). */
  readonly cookies: readonly ContainerCookieDetail[];
  readonly probeCookies: readonly string[];
  readonly refusedWrites: readonly string[];
  /** Consent API calls from its frames, by API. */
  readonly consentCalls: readonly { readonly api: string; readonly count: number }[];
  /** Who inserted its script, one line each. */
  readonly loadedBy: readonly LoadedViaLine[];
  /** Companies whose scripts it inserted, each in its category. */
  readonly vendorsLoaded: readonly { readonly entity: string; readonly category: string }[];
  /** Domains of scripts it inserted that no company is named for. */
  readonly domainsLoaded: readonly string[];
  /** Containers it loaded, by product name and ids. Absent on the Google tag's panel. */
  readonly containersLoaded?: readonly { readonly name: string; readonly nameKey?: string; readonly ids: readonly string[] }[];
  /** Where its tags sent requests: a company and category, or a domain no company is named for. */
  readonly requestsTo: readonly { readonly entity: string | null; readonly category: string; readonly domain: string; readonly hosts: readonly string[] }[];
  /** Its own address, query masked but for the id, without the scheme. */
  readonly scripts: readonly string[];
  /** Whether the insertion and request records were kept at all: an empty section then says "not observable". */
  readonly insertionsObserved: boolean;
  readonly requestsObserved: boolean;
  /** A key was left out of its record past the cap. */
  readonly capped?: true;
}

export interface ContainerRow {
  /** Identifies the row, and keeps its panel open across a redraw: `container:<key>`. */
  readonly key: string;
  /** The product, a brand name never translated; or a message key, for the Google tag. */
  readonly manager: string;
  readonly managerKey?: string;
  /** Its ids. One, beside the name; the Google tag's, on a line of their own. */
  readonly ids: readonly string[];
  readonly checkKey: "containerTagRead" | "containerNoRead" | "containerCannotDetermine";
  readonly checkHelp: { readonly key: string };
  readonly cookies: readonly ContainerCookie[];
  /** The capture predates the record of what was written inside a container (1.25.0). */
  readonly cookiesPredate?: true;
  readonly loadedVia?: LoadedViaLine;
  readonly detail: ContainerDetail;
}

/** The view model's own classification, as the engine's classifier: one answer for both. */
function classifierOf(input: BuildInput, classOf: (url: string) => UrlClass): Classifier {
  return {
    classify(url: string): Classification {
      const c = input.classify?.(url) ?? classOf(url);
      return {
        party: c.party,
        category: c.category as Classification["category"],
        entity: c.entity === null ? null : { name: c.entity, id: c.entity.toLowerCase() },
        registrableDomain: c.domain,
      };
    },
  };
}

/** A script's address as a reader recognizes it: no scheme, the query masked but for the id. */
function address(url: string): string {
  return redactUrl(url).replace(/^[a-z]+:\/\//i, "");
}

const GOOGLE_TAG_KEY = "gtag:*";

/** The rows and the ids found with nothing recorded, in the order the section draws them. */
export function containerRows(
  obs: ObservationSet,
  input: BuildInput,
  findings: readonly Finding[],
  classOf: (url: string) => UrlClass,
  /** Whether the capture predates `tallies.byContainer`, as it was given (before any derivation). */
  predates: boolean,
): { rows: ContainerRow[]; quiet: string[] } {
  const summaries = containerSummaries(obs, classifierOf(input, classOf));
  const signalOn = obs.signal.source !== "none";
  const t = obs.tallies;
  const counted = new Set(signalOn ? t.adCookieKeys : (t.adCookieKeysUnsigned ?? []));
  // A tag's GPP call is a read only when the page's string records a GPC value, the rule
  // every vendor row and the Read GPC lines use (gppCallReads). With no decodable string,
  // what it was told is unknown.
  const record = gppGpcRecord(obs.gpp);
  const gppReads = gppCallReads(record, signalOn);

  const quiet = summaries.filter((s) => s.quiet && s.identity.id !== null).map((s) => s.identity.id as string);
  const live = summaries.filter((s) => !s.quiet);

  // Every Google tag id shares one row, and a helper frame of Google's that joined no
  // container goes with them: both are Google's tags running outside a container.
  const google = live.filter((s) => s.identity.manager === "gtag" || (s.identity.manager === "google" && hasContent(s)));
  const own = live.filter((s) => s.identity.manager !== "gtag" && s.identity.manager !== "google");
  const groups: { key: string; summaries: ContainerSummary[] }[] = own.map((s) => ({ key: containerKey(s.identity), summaries: [s] }));
  if (google.length > 0) groups.push({ key: GOOGLE_TAG_KEY, summaries: google });

  // A container's parent, for the order: the container that inserted it.
  const groupOf = new Map<string, string>();
  for (const g of groups) for (const s of g.summaries) groupOf.set(containerKey(s.identity), g.key);
  const parentOf = new Map<string, string>();
  for (const g of groups) {
    for (const s of g.summaries) {
      const p = s.parent === null ? undefined : groupOf.get(containerKey(s.parent));
      if (p !== undefined && p !== g.key) {
        parentOf.set(g.key, p);
        break;
      }
    }
  }

  const insertionsObserved = obs.capabilities.scriptInsertion === true;
  const requestsObserved = obs.capabilities.requestInitiation === true;
  const details = t.cookieDetails ?? {};

  const rows = new Map<string, ContainerRow & { sortName: string; hasCookies: boolean }>();
  for (const g of groups) {
    const isGoogleTag = g.key === GOOGLE_TAG_KEY;
    const first = g.summaries[0]!;
    const ids = g.summaries.map((s) => s.identity.id).filter((id): id is string => id !== null).sort();
    const read = g.summaries.some((s) => s.reads > 0 || (s.gppRead && gppReads));
    const gppUnknown = record === "no-string" && g.summaries.some((s) => s.gppRead);
    const attribution = obs.signal.readAttribution;
    const tracingOff = obs.signal.readTracking !== "active" || attribution === null;
    const capped = attribution?.traceCapReached === true;
    const checkKey: ContainerRow["checkKey"] = read ? "containerTagRead" : tracingOff || gppUnknown || capped ? "containerCannotDetermine" : "containerNoRead";
    const checkHelp = {
      key: read
        ? "containerTagReadHelp"
        : tracingOff
          ? "containerCannotDetermineHelpOff"
          : gppUnknown
            ? "containerCannotDetermineHelpGpp"
            : capped
              ? "containerCannotDetermineHelp"
              : "containerNoReadHelp",
    };

    // What was written inside it, as the headline's own visit: signed, or unsigned with sending off.
    const keys = [...new Set(g.summaries.flatMap((s) => (signalOn ? s.cookies?.cookieKeys : s.cookies?.cookieKeysUnsigned) ?? []))].sort();
    const split = keys.map((k) => ({ key: k, name: k.slice(0, k.indexOf("\u0000")), domain: k.slice(k.indexOf("\u0000") + 1) }));
    const cookies: ContainerCookie[] = split.map((c) => ({
      name: split.filter((o) => o.name === c.name).length > 1 ? `${c.name} (${c.domain})` : c.name,
      counted: counted.has(c.key),
    }));
    const cookieDetails: ContainerCookieDetail[] = split.map((c) => cookieDetail(c.key, c.name, c.domain, counted.has(c.key), details[c.key], t, input));

    const loaders = dedupe(g.summaries.flatMap((s) => [...s.loadedBy])).filter(
      // The Google tag's ids loading one another are one row loading itself.
      (l) => !(isGoogleTag && l.kind === "container" && groupOf.get(containerKey(l.identity)) === GOOGLE_TAG_KEY),
    );
    const rowLine = loaders.length > 0 ? loadedViaRowLine(loaders, findings) : undefined;

    const vendorsLoaded = uniqueBy(g.summaries.flatMap((s) => s.loaded), (v) => `${v.entity}\u0000${v.category}`);
    const containersLoaded = isGoogleTag
      ? undefined
      : loadedContainerNames(g.summaries.flatMap((s) => s.loadedContainers), groupOf);
    const requestsTo = mergeRequests(g.summaries.flatMap((s) => s.requestsTo));
    const scripts = [...new Set(g.summaries.flatMap((s) => s.scripts).map(address))].sort();

    const row: ContainerRow & { sortName: string; hasCookies: boolean } = {
      key: `container:${g.key}`,
      manager: isGoogleTag ? "Google tag" : (MANAGER_NAMES[first.identity.manager] ?? first.identity.manager),
      ...(isGoogleTag ? { managerKey: "containerNameGoogleTag" } : {}),
      ids,
      checkKey,
      checkHelp,
      cookies,
      ...(predates ? { cookiesPredate: true as const } : {}),
      ...(rowLine ? { loadedVia: rowLine } : {}),
      detail: {
        cookies: cookieDetails,
        probeCookies: [...new Set(g.summaries.flatMap((s) => s.cookies?.probeCookies ?? []))].sort(),
        refusedWrites: [...new Set(g.summaries.flatMap((s) => s.cookies?.refusedWrites ?? []))].sort(),
        consentCalls: sumCalls(g.summaries),
        loadedBy: loaderLines(loaders, findings),
        vendorsLoaded,
        domainsLoaded: [...new Set(g.summaries.flatMap((s) => s.loadedDomains))].sort(),
        ...(containersLoaded !== undefined ? { containersLoaded } : {}),
        requestsTo,
        scripts,
        insertionsObserved,
        requestsObserved,
        ...(g.summaries.some((s) => s.cookies?.capped === true) ? { capped: true as const } : {}),
      },
      sortName: isGoogleTag ? "Google tag" : `${MANAGER_NAMES[first.identity.manager] ?? first.identity.manager} ${ids[0] ?? ""}`,
      hasCookies: cookies.length > 0,
    };
    rows.set(g.key, row);
  }

  // A container, then what it loaded; among the rest, rows that set a cookie first, then by
  // manager and id.
  const order = (a: { sortName: string; hasCookies: boolean }, b: { sortName: string; hasCookies: boolean }) =>
    Number(b.hasCookies) - Number(a.hasCookies) || a.sortName.localeCompare(b.sortName, undefined, { sensitivity: "base" });
  const children = (parent: string) => [...rows.entries()].filter(([k]) => parentOf.get(k) === parent).sort(([, a], [, b]) => order(a, b));
  const out: ContainerRow[] = [];
  const emitted = new Set<string>();
  const emit = (key: string): void => {
    if (emitted.has(key)) return;
    emitted.add(key);
    const { sortName: _s, hasCookies: _h, ...row } = rows.get(key)!;
    out.push(row);
    for (const [child] of children(key)) emit(child);
  };
  const roots = [...rows.entries()].filter(([k]) => !rows.has(parentOf.get(k) ?? "")).sort(([, a], [, b]) => order(a, b));
  for (const [k] of roots) emit(k);
  // A cycle in the graph leaves rows no root reaches; they come last, never dropped.
  for (const [k] of [...rows.entries()].sort(([, a], [, b]) => order(a, b))) emit(k);

  return { rows: out, quiet: [...new Set(quiet)].sort() };
}

/** Anything recorded for a summary beyond its own address. */
function hasContent(s: ContainerSummary): boolean {
  return (
    s.reads > 0 ||
    s.consentCalls.length > 0 ||
    s.loaded.length > 0 ||
    s.loadedDomains.length > 0 ||
    s.loadedContainers.length > 0 ||
    s.requestsTo.length > 0 ||
    s.cookies !== null
  );
}

function cookieDetail(
  key: string,
  name: string,
  domain: string,
  isCounted: boolean,
  d: CookieDetail | undefined,
  t: ObservationSet["tallies"],
  input: BuildInput,
): ContainerCookieDetail {
  const entity = t.adCookieEntities?.[key];
  const category = t.adCookieCategories?.[key];
  const base = {
    name,
    domain,
    ...(isCounted && entity !== undefined && category !== undefined ? { countedUnder: { entity, category } } : {}),
    functional: isCounted && input.isListedFunctional?.(name) === true,
  };
  if (d === undefined) return { ...base, partitioned: false, onRedirect: false };
  return {
    ...base,
    expiry: formatExpiry(d.expiresMs),
    sameSite: d.sameSite,
    partitioned: d.partitioned,
    via: d.via === "onHeadersReceived" ? "Set-Cookie" : "page script",
    onRedirect: d.onRedirect,
  };
}

function dedupe(loaders: readonly LoaderIdentity[]): LoaderIdentity[] {
  return uniqueBy(loaders, (l) => JSON.stringify(l));
}

function uniqueBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) if (!seen.has(keyOf(item))) seen.set(keyOf(item), item);
  return [...seen.values()];
}

function sumCalls(summaries: readonly ContainerSummary[]): { api: string; count: number }[] {
  const by = new Map<string, number>();
  for (const s of summaries) for (const c of s.consentCalls) by.set(c.api, (by.get(c.api) ?? 0) + c.count);
  return [...by].sort(([a], [b]) => (a < b ? -1 : 1)).map(([api, count]) => ({ api, count }));
}

function mergeRequests(entries: ContainerSummary["requestsTo"]): ContainerDetail["requestsTo"] {
  const by = new Map<string, { entity: string | null; category: string; domain: string; hosts: Set<string> }>();
  for (const e of entries) {
    const k = e.entity !== null ? `e\u0000${e.entity}\u0000${e.category}` : `d\u0000${e.domain}`;
    const entry = by.get(k) ?? { entity: e.entity, category: e.category, domain: e.domain, hosts: new Set<string>() };
    for (const h of e.hosts) entry.hosts.add(h);
    by.set(k, entry);
  }
  return [...by.values()].map((e) => ({ ...e, hosts: [...e.hosts].sort() }));
}

/** The containers a container loaded, by product and ids; the Google tag's ids as one entry. */
function loadedContainerNames(
  loaded: readonly ContainerIdentity[],
  groupOf: ReadonlyMap<string, string>,
): { name: string; nameKey?: string; ids: string[] }[] {
  const out = new Map<string, { name: string; nameKey?: string; ids: Set<string> }>();
  for (const c of loaded) {
    if (c.id === null) continue;
    const isGoogleTag = c.manager === "gtag" || groupOf.get(containerKey(c)) === GOOGLE_TAG_KEY;
    const k = isGoogleTag ? GOOGLE_TAG_KEY : containerKey(c);
    const entry = out.get(k) ?? { name: isGoogleTag ? "Google tag" : (MANAGER_NAMES[c.manager] ?? c.manager), ...(isGoogleTag ? { nameKey: "containerNameGoogleTag" } : {}), ids: new Set<string>() };
    entry.ids.add(c.id);
    out.set(k, entry);
  }
  return [...out.values()].map((e) => ({ ...e, ids: [...e.ids].sort() })).sort((a, b) => a.name.localeCompare(b.name));
}
