// SPDX-License-Identifier: GPL-3.0-only
/**
 * The Requests tab's view model (PRD 5.2).
 *
 * Pure, like the Overview's: filtering and row derivation are testable in Node, and the
 * renderer only decides where to put the result.
 *
 * This tab exists for PARITY: it keeps the table of domains and their headers that v0.1.4
 * had, so a reader who used it still has it. It is also the surface a practitioner needs:
 * the Overview answers "what happened", this answers "show me".
 */

import { isCookieSet, lostKeptRecords } from "@gpc-inspector/schema";
import type { ObservationSet, NetworkObservation, KeptCookieResponse } from "@gpc-inspector/schema";
import { categoryRank, cookieCharge, isCounted, NO_OWNERS, recordKeyOf, type OwnerNames, type ProvenanceResolution } from "@gpc-inspector/engine";
import { loadedViaRowLine, type LoadedViaLine } from "./view-model.js";
// Defined beside the vendor rows, which label a category too; exported from here as well.
export { categoryLabelKey } from "./view-model.js";
import type { Classifier } from "@gpc-inspector/engine";

/**
 * Which subset of requests is shown. The id is printed in the first line of the copied
 * text, so it is the word the chip shows.
 */
export type RequestFilter =
  | "all"
  | "advertising"
  | "analytics"
  | "third-party"
  | "set-cookie"
  | "uncategorized";

export interface RequestRow {
  readonly id: string;
  /** Full URL, kept for the detail view and for copying. */
  readonly url: string;
  /** Host plus a truncated path — what the row displays. */
  readonly label: string;
  readonly method: string;
  readonly resourceType: string;
  readonly statusCode: number | null;
  /** Did this request carry Sec-GPC: 1? False, and meaningless, where `requestLost`. */
  readonly secGpcPresent: boolean;
  /**
   * Only the response was seen (1.26.0): the request went out before a worker reclaim or
   * restart, so whether it carried the signal was not observed, and nothing it set counts.
   */
  readonly requestLost?: true;
  /**
   * Listed from its kept record after a worker reclaim (1.27.0). `url` is what was kept: no
   * query, and at most 256 characters. The headers were not kept.
   */
  readonly kept?: true;
  /** Names of cookies this response set, deduped by the capture layer. */
  readonly cookieNames: readonly string[];
  /**
   * Of those, the names that set a cookie (isCookieSet): not a deletion, and not one the
   * browser's cookie jar did not hold. What the collapsed row's "set N cookies" counts and
   * what makes a redirect one that "set cookies"; the detail still names every record.
   */
  readonly setCookieNames: readonly string[];
  /**
   * A cookie a page script wrote, not a request (sw.ts records one as method SCRIPT, with
   * no status and the GPC property's value in `secGpcPresent`). Listed with the requests,
   * since the Overview's counts rest on it, and counted by none of the tab's numbers. Its
   * row names the script that wrote it and the property, since no header was sent.
   */
  readonly scriptWrite?: true;
  /**
   * Of those, the ones the Overview's count includes: set, not deleted, on a third-party
   * advertising or analytics request that carried the signal, or that did not when
   * sending is off, which is the count the Overview shows then. Drawn in the attention
   * color, as on the Overview, so a name there can be found here.
   */
  readonly countedCookieNames: readonly string[];
  /**
   * Of the counted names, the ones counted under a company other than this request's own
   * (1.25.0): an owner's name written inside its container, `_ga` on a
   * googletagmanager.com script, which the row labels as no one's. The detail names the
   * company and category each is counted under, so an amber name never sits under a label
   * that names nobody.
   */
  readonly countedUnder: readonly { readonly name: string; readonly entity: string; readonly category: string }[];
  /**
   * Of the counted names, the ones on the list of functional cookie names. Counted only:
   * the site's own `__cf_bm` behind Cloudflare is on the list too, and the label's "still
   * included in the count" would be false of it.
   */
  readonly functionalCookieNames: readonly string[];
  /**
   * Names this response set that the browser's cookie jar did not hold when checked
   * (1.30.0): never counted, whatever set them. The detail lists them on their own line.
   */
  readonly notStoredCookieNames: readonly string[];
  readonly isRedirectHop: boolean;
  /** Entity name when the domain is classified, else null. */
  readonly entity: string | null;
  readonly party: "first" | "third";
  readonly category: string;
  /**
   * Who inserted this script or iframe, from the insertion records (provenance). null when
   * the request is not a script or iframe, or the records could not tell. The same line
   * the vendor row shows, so the two tabs phrase one fact one way.
   */
  readonly loadedBy: LoadedViaLine | null;
  /**
   * The registrable domain the row is grouped under: the list's own answer, from the Public
   * Suffix List, the one the Overview's rows and the first- or third-party label use. Not a
   * host's last two labels, which would group every site under co.uk as "co.uk" and
   * 127.0.0.1 as "0.1". A URL with no host is its own group, under the URL.
   */
  readonly domain: string;
}

/**
 * Requests grouped by registrable domain.
 *
 * Grouped by DOMAIN rather than by entity, deliberately. The Overview's vendor list already
 * answers "who is on this page and what did they set"; if this tab answered the same
 * question it would be a longer version of a screen the reader just left. This one answers
 * "which hosts did my browser actually talk to", which is why someone opens it.
 *
 * Two further reasons:
 *
 *   - A domain makes no ownership claim, so it cannot be wrong about one. Entity grouping
 *     depends entirely on the classification list, which has already produced "G." as a
 *     company name, and a bad rollup would mis-group silently.
 *   - It shows what entity grouping hides: that Google's cookies arrive from three separate
 *     hostnames, and that gstatic.com set nothing at all.
 *
 * The cost is that a reader must know doubleclick and gstatic are the same company. Each
 * row's meta line carries the entity name, so that mapping stays visible per-request
 * without the tab being organized around it.
 */
export interface RequestGroup {
  /** Registrable domain, e.g. "doubleclick.net". */
  readonly domain: string;
  /** Entity that owns it, when the list knows. null for uncategorized. */
  readonly entity: string | null;
  readonly party: "first" | "third";
  /**
   * The category the row names after the vendor: the first, in the list's order, among
   * the categories of the domain's requests shown. bing.com, with bat.bing.com
   * (Advertising) and www.bing.com (Content), is Advertising; each request still names its
   * own. "unknown" where the list gives the domain none.
   */
  readonly topCategory: string;
  readonly rows: readonly RequestRow[];
  /** Of the rows, the HTTP requests: the number the group's heading shows. */
  readonly requestCount: number;
  /** Distinct cookie names set across the group, for the collapsed summary. */
  readonly cookieNames: readonly string[];
  /** Of those, the ones the Overview's count includes. See RequestRow. */
  readonly countedCookieNames: readonly string[];
  /** Of the counted names, the ones listed as functional. See RequestRow. */
  readonly functionalCookieNames: readonly string[];
}

export interface RequestsView {
  readonly rows: readonly RequestRow[];
  readonly groups: readonly RequestGroup[];
  /**
   * HTTP requests under every filter, so the chips can show totals without re-filtering.
   * A script's cookie write is no request and is in none of them; a request listed from
   * its kept record is.
   */
  readonly counts: Readonly<Record<RequestFilter, number>>;
  /**
   * Rows every filter lists, script writes included: whether a chip selects anything, and
   * whether the tab has anything to list at all.
   */
  readonly listed: Readonly<Record<RequestFilter, number>>;
  /** Script cookie writes among `rows`, which the note above the list counts. */
  readonly scriptWriteCount: number;
  readonly activeFilter: RequestFilter;
  /** True when the capture was truncated or interrupted. */
  readonly incomplete: boolean;
  /**
   * True when the worker was reclaimed and the requests before it with it (1.22.0). The
   * counts and findings survive that; this list does not, so this tab is where it is said.
   */
  readonly requestsDropped: boolean;
  /**
   * Rows restored from the kept cookie records (1.27.0): observations that set a cookie,
   * which the request list lost with a reclaim. How many, and whether some were not kept
   * (past the cap, or dropped to make room), so the note says what the list still holds.
   */
  readonly keptShown: number;
  readonly keptIncomplete: boolean;
}

/**
 * A compact label for a row.
 *
 * Host first because that is what a reader scans for; the path is truncated because a
 * full ad-tech URL is hundreds of characters of query string and would push everything
 * else off the row.
 */
export function labelFor(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    const label = `${u.hostname}${path}`;
    return label.length > 64 ? `${label.slice(0, 63)}…` : label;
  } catch {
    return url.length > 64 ? `${url.slice(0, 63)}…` : url;
  }
}

/**
 * A kept cookie record as the observation it stood for, with what was not kept left empty:
 * the query, the headers, what the request sent and every cookie's value.
 */
function fromKept(k: KeptCookieResponse): NetworkObservation {
  return {
    ...k,
    initiator: null,
    cookiesSent: [],
    requestHeaders: [],
    responseHeaders: null,
    setCookies: k.setCookies.map((c) => ({ ...c, value: "" })),
  };
}

function toRow(
  net: NetworkObservation,
  classifier: Classifier,
  topSite: string,
  resolution: ProvenanceResolution | undefined,
  signalOn: boolean,
  isListedFunctional: ((cookieName: string) => boolean) | undefined,
  owners: OwnerNames,
): RequestRow {
  const cls = classifier.classify(net.url, topSite);
  const loaders = resolution?.byKey.get(recordKeyOf(net.url)) ?? [];
  const loadedBy = loaders.length > 0 ? (loadedViaRowLine(loaders, []) ?? null) : null;
  // The count's own rule, per cookie (1.25.0): the one charge the tally took. With the
  // signal on it counts cookies set on requests that carried it; with sending off, the ones
  // set on requests that did not.
  const countedNames: string[] = [];
  const countedUnder: { name: string; entity: string; category: string }[] = [];
  // A lost request's cookies count nowhere: what the request carried was not seen (1.26.0).
  if (net.secGpcPresent === signalOn && net.requestLost !== true) {
    for (const c of net.setCookies) {
      // Nor does a deletion, or one the cookie jar did not hold (1.30.0).
      if (!isCookieSet(c, net.timeMs)) continue;
      const charge = cookieCharge(c, net.url, topSite, classifier, owners);
      if (!isCounted(charge)) continue;
      countedNames.push(c.name);
      if (charge.kind === "owner") countedUnder.push({ name: c.name, entity: charge.entity.name, category: charge.category });
    }
  }
  return {
    id: net.id,
    url: net.url,
    label: labelFor(net.url),
    method: net.method,
    resourceType: net.resourceType,
    statusCode: net.statusCode,
    secGpcPresent: net.secGpcPresent,
    ...(net.requestLost === true ? { requestLost: true as const } : {}),
    cookieNames: net.setCookies.map((c) => c.name),
    setCookieNames: [...new Set(net.setCookies.filter((c) => isCookieSet(c, net.timeMs)).map((c) => c.name))],
    ...(isScriptWrite(net) ? { scriptWrite: true as const } : {}),
    countedCookieNames: countedNames,
    countedUnder,
    functionalCookieNames: isListedFunctional === undefined ? [] : countedNames.filter((n) => isListedFunctional(n)),
    notStoredCookieNames: [...new Set(net.setCookies.filter((c) => c.jar === "not-stored").map((c) => c.name))],
    isRedirectHop: net.isRedirectHop,
    entity: cls.entity?.name ?? null,
    party: cls.party,
    category: cls.category,
    loadedBy,
    domain: cls.registrableDomain === "" ? net.url : cls.registrableDomain,
  };
}

/**
 * The words for a row's signal where it was not seen carrying it, as the collapsed row's
 * mark (`mark`) or the detail's Sec-GPC value (`detail`); null where it carried it. A lost
 * request's signal was not observed, which is not its absence (1.26.0). A script write has
 * no request, so its mark says the property was not set rather than that a header was not
 * sent, and its detail has no Sec-GPC line (detailHead).
 */
export function gpcAbsentKey(row: RequestRow, where: "mark" | "detail"): string | null {
  if (row.requestLost) return "requestLost";
  if (row.secGpcPresent) return null;
  if (row.scriptWrite) return "reqNoGpcProperty";
  return where === "mark" ? "reqNoGpc" : "detailSignalAbsent";
}

/** The detail's Response value: a message key, or null to show the status code. */
export function responseKey(row: RequestRow): string | null {
  return row.statusCode === null ? "detailNoResponse" : null;
}

/** A line of a row's detail: a label, and a value given verbatim or as a message key. */
export type DetailLine = { readonly labelKey: string } & ({ readonly value: string } | { readonly valueKey: string });

/**
 * The lines that open a row's detail. A request's say what was sent and what came back:
 * method and type, Sec-GPC on every row and not only where it was absent, and the response.
 * A script's cookie write sent nothing and got nothing back, so its lines name the script
 * and say whether the GPC property was set, the one signal that script could have read.
 */
export function detailHead(row: RequestRow): DetailLine[] {
  if (row.scriptWrite) {
    return [
      { labelKey: "detailWrittenBy", value: row.url },
      { labelKey: "detailGpcProperty", valueKey: row.secGpcPresent ? "detailGpcPropertySet" : "detailGpcPropertyNotSet" },
    ];
  }
  const absent = gpcAbsentKey(row, "detail");
  const response = responseKey(row);
  return [
    { labelKey: "detailRequest", value: `${row.method} ${row.resourceType}` },
    absent === null ? { labelKey: "detailSecGpc", value: "1" } : { labelKey: "detailSecGpc", valueKey: absent },
    response === null ? { labelKey: "detailResponse", value: String(row.statusCode) } : { labelKey: "detailResponse", valueKey: response },
  ];
}

/** The note above the list, for the script writes it lists; null when it lists none. */
export function scriptWriteNote(view: RequestsView): { key: string; substitution?: string } | null {
  const n = view.scriptWriteCount;
  if (n === 0) return null;
  return n === 1 ? { key: "reqScriptWritesNoteOne" } : { key: "reqScriptWritesNote", substitution: String(n) };
}

/** The detail's Redirect value, or null for a row that is not a redirect. */
export function redirectKey(row: RequestRow): string | null {
  if (!row.isRedirectHop) return null;
  return row.setCookieNames.length > 0 ? "detailRedirectValue" : "detailRedirectNoCookies";
}

/**
 * The collapsed row's cookie mark, counting the cookies set: a deletion or a write the
 * cookie jar did not hold is no cookie set, so a row of only those has no mark.
 */
export function setCookieMark(row: RequestRow): { key: string; substitution?: string } | null {
  const n = row.setCookieNames.length;
  if (n === 0) return null;
  return n === 1 ? { key: "markSetOneCookie" } : { key: "markSetCookies", substitution: String(n) };
}

function matches(row: RequestRow, filter: RequestFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "advertising":
    case "analytics":
      // Each half of the predicate the cookie count uses, so the tab and the Overview
      // cannot disagree about who is counted. Per request: a domain whose requests are in
      // two categories is under each filter with the requests of that category.
      return row.party === "third" && row.category === filter;
    case "third-party":
      return row.party === "third";
    case "set-cookie":
      return row.cookieNames.length > 0;
    case "uncategorized":
      // Third-party domains Disconnect gives no category: not listed at all, or listed with
      // an owner and nothing else. Shown so a reader can see every request the counts set
      // aside: an uncategorized domain is never counted (FR-18). One with no company has a
      // row of its own on the Overview and a Read GPC state (1.26.0).
      return row.party === "third" && row.category === "unknown";
    default:
      return true;
  }
}

/** Whether an observation is a page script's cookie write, which is no HTTP request. */
function isScriptWrite(net: { readonly method: string }): boolean {
  return net.method === "SCRIPT";
}

/**
 * The number on the Requests tab: the HTTP requests the list would show under "All", kept
 * records included and script cookie writes not, without building the list. The tab's
 * label carries it whichever tab is open, so a reader sees it before opening the tab, and
 * in a panel that stays open it keeps up with the page.
 */
export function requestCount(obs: ObservationSet | null): number {
  if (obs === null) return 0;
  let n = 0;
  for (const k of lostKeptRecords(obs)) if (!isScriptWrite(k)) n += 1;
  for (const net of obs.network) if (!isScriptWrite(net)) n += 1;
  return n;
}

/** Each filter's number over `rows`. */
function countBy(rows: readonly RequestRow[]): Record<RequestFilter, number> {
  return {
    all: rows.length,
    advertising: rows.filter((r) => matches(r, "advertising")).length,
    analytics: rows.filter((r) => matches(r, "analytics")).length,
    "third-party": rows.filter((r) => matches(r, "third-party")).length,
    "set-cookie": rows.filter((r) => matches(r, "set-cookie")).length,
    uncategorized: rows.filter((r) => matches(r, "uncategorized")).length,
  };
}

const NO_COUNTS: Readonly<Record<RequestFilter, number>> = {
  all: 0,
  advertising: 0,
  analytics: 0,
  "third-party": 0,
  "set-cookie": 0,
  uncategorized: 0,
};

export function buildRequestsView(
  obs: ObservationSet | null,
  classifier: Classifier,
  activeFilter: RequestFilter = "all",
  resolution?: ProvenanceResolution,
  /** Whether a cookie name is on the list of functional cookie names. */
  isListedFunctional?: (cookieName: string) => boolean,
  /** The container owners' cookie names, for the count's own rule (1.25.0). */
  owners: OwnerNames = NO_OWNERS,
): RequestsView {
  if (obs === null) {
    return {
      rows: [],
      groups: [],
      counts: NO_COUNTS,
      listed: NO_COUNTS,
      scriptWriteCount: 0,
      activeFilter,
      incomplete: false,
      requestsDropped: false,
      keptShown: 0,
      keptIncomplete: false,
    };
  }

  const signalOn = obs.signal.source !== "none";
  // The kept records a reclaim took came before the requests the next worker saw, so they
  // are listed first.
  const restored = lostKeptRecords(obs).map(fromKept);
  const row = (n: NetworkObservation) => toRow(n, classifier, obs.context.topSite, resolution, signalOn, isListedFunctional, owners);
  const all = [...restored.map((n) => ({ ...row(n), kept: true as const })), ...obs.network.map(row)];

  // Every number the tab shows counts HTTP requests. "set-cookie" is then the responses
  // that set one.
  const counts = countBy(all.filter((r) => !r.scriptWrite));

  // Order: cookie-setting requests first, then the rest in capture order. The rows that
  // produced findings are the ones a reader came here to check, and capture order is
  // preserved within each group so a redirect chain still reads in sequence.
  // Capture order within a group: a redirect chain reads in sequence, and the order does
  // not shift as more requests arrive.
  const ordered = all.filter((r) => matches(r, activeFilter));

  return {
    rows: ordered,
    groups: groupByDomain(ordered),
    counts,
    listed: countBy(all),
    scriptWriteCount: ordered.filter((r) => r.scriptWrite).length,
    activeFilter,
    incomplete: obs.context.incomplete,
    keptShown: restored.length,
    keptIncomplete: obs.keptCookieResponsesIncomplete === true,
    requestsDropped: obs.context.incompleteReasons?.includes("worker-restarted") === true,
  };
}

/**
 * Group rows by registrable domain.
 *
 * Groups that set cookies sort first, then by request count, then alphabetically — the same
 * rule the flat list uses, so a reader who switches filters sees a consistent ordering. The
 * site's own domain sorts last regardless: it is the one group whose presence is expected
 * and whose contents are least likely to be why anyone opened this tab.
 */
export function groupByDomain(rows: readonly RequestRow[]): RequestGroup[] {
  const byDomain = new Map<string, RequestRow[]>();
  for (const row of rows) {
    const key = row.domain;
    const existing = byDomain.get(key);
    if (existing) existing.push(row);
    else byDomain.set(key, [row]);
  }

  const groups: RequestGroup[] = [];
  for (const [domain, groupRows] of byDomain) {
    const names = new Set<string>();
    const counted = new Set<string>();
    const functional = new Set<string>();
    for (const r of groupRows) {
      for (const n of r.cookieNames) names.add(n);
      for (const n of r.countedCookieNames) counted.add(n);
      for (const n of r.functionalCookieNames) functional.add(n);
    }
    const top = [...groupRows].sort((a, b) => categoryRank(a.category) - categoryRank(b.category))[0];
    groups.push({
      domain,
      // The vendor of the request that gives the row its category, so the two agree.
      entity: top?.entity ?? groupRows[0]?.entity ?? null,
      party: groupRows[0]?.party ?? "third",
      topCategory: top?.category ?? "unknown",
      rows: groupRows,
      requestCount: groupRows.filter((r) => !r.scriptWrite).length,
      cookieNames: [...names].sort(),
      countedCookieNames: [...counted].sort(),
      functionalCookieNames: [...functional].sort(),
    });
  }

  // First-party first, then alphabetical.
  //
  // Not sorted by cookie count or request volume: a list whose order encodes importance
  // makes the reader infer a ranking, and this tab reports what happened rather than what
  // matters most. Alphabetical is also the only order that stays stable while a page is
  // still loading — a volume-sorted list reshuffles under the reader as requests arrive.
  return groups.sort((a, b) => {
    if (a.party !== b.party) return a.party === "first" ? -1 : 1;
    return a.domain < b.domain ? -1 : 1;
  });
}

/** At most this many of a domain's cookie names on its row; the opened domain lists them all. */
export const ROW_COOKIE_NAMES = 3;

/**
 * The names a domain's row shows whole, and how many it leaves to "+N". The row never cuts
 * the count: a name is either shown or counted in N, and the opened domain lists every one
 * (popup.ts). Only when even the first name does not fit is that one name cut, with an
 * ellipsis, so N still counts every name the row does not show.
 *
 * `fits(k)` says whether the first k names, with "+N" for the rest, fit the row's box. It
 * is the popup's measure of the drawn row; a test passes its own.
 */
export function rowCookieNames(
  names: readonly string[],
  fits: (shown: number) => boolean,
): { readonly shown: readonly string[]; readonly more: number } {
  let k = Math.min(ROW_COOKIE_NAMES, names.length);
  while (k > 1 && !fits(k)) k--;
  return { shown: names.slice(0, k), more: names.length - k };
}

/**
 * Plain-text export of the visible rows.
 *
 * Respects the active filter: filtering to set-cookie and copying gives exactly the rows
 * worth pasting into an email, which is the actual use. Cookie VALUES are never included —
 * only names — so a copied list cannot carry a session identifier out of the browser.
 */
export function rowsToText(view: RequestsView): string {
  // The requests in the rows, as the chip counts them, and the script writes apart.
  const requests = view.rows.length - view.scriptWriteCount;
  const writes = view.scriptWriteCount === 0 ? "" : `, ${view.scriptWriteCount} cookie ${view.scriptWriteCount === 1 ? "write" : "writes"} by page scripts`;
  const header = `# ${requests} requests${writes} (${view.activeFilter})`;
  const lines = view.rows.map((r) => {
    const marks: string[] = [];
    // A script write sent no header: what it could have read is the property.
    if (r.scriptWrite) marks.push(r.secGpcPresent ? "gpc-property:set" : "gpc-property:not-set");
    else if (r.requestLost) marks.push("request-lost");
    else if (r.secGpcPresent) marks.push("sec-gpc:1");
    if (r.isRedirectHop) marks.push("redirect");
    // The URL is what was kept past a reclaim, not the whole of it (1.27.0).
    if (r.kept) marks.push("query-not-kept");
    // The label travels with the name, in words: the copied text has no icon and no hover.
    const named = r.cookieNames.map((n) =>
      r.notStoredCookieNames.includes(n) ? `${n} (not stored by the browser)` : r.functionalCookieNames.includes(n) ? `${n} (listed as functional)` : n,
    );
    if (r.cookieNames.length > 0) marks.push(`set-cookie: ${named.join(", ")}`);
    if (r.loadedBy) marks.push(`loaded-by: ${r.loadedBy.parts.map((p) => (p.substitution ?? [p.key]).join(" ")).join(", ")}`);
    const status = r.statusCode === null ? "-" : String(r.statusCode);
    // A script write has no response and no resource type; its URL is the script's.
    const type = r.scriptWrite ? "cookie-written-by-script" : r.resourceType;
    const who = r.entity ?? (r.party === "first" ? "first-party" : r.category === "unknown" ? "uncategorized" : r.category);
    return `${status}\t${type}\t${who}\t${r.url}${marks.length ? `\t[${marks.join(" · ")}]` : ""}`;
  });
  return [header, ...lines].join("\n");
}
