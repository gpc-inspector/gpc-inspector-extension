// SPDX-License-Identifier: GPL-3.0-only
/**
 * Export redaction (PRD FR-24).
 *
 * The in-memory ObservationSet keeps what the wire carried, cookie values included, because
 * the engine and the popup are the reader's own tools looking at the reader's own session.
 * A bundle leaves the machine: pasted into an issue, attached to a report, handed to a
 * third party to replay. `redact` is the one pass between the two, applied to a COPY, and
 * `EvidenceBundle.redacted` records whether it ran.
 *
 * What it masks, and why each item is in the list:
 *
 *   - Cookie values, wherever a value sits: `setCookies[].value`, the raw `Set-Cookie`
 *     response header, and the `Cookie` request header. A session cookie's value IS the
 *     session; nothing the engine concludes depends on it (LIMITATIONS: values are never
 *     the basis of a finding).
 *   - `Authorization` and `Proxy-Authorization` request headers, for the same reason.
 *   - The query and fragment of a header that holds a URL: `Referer` on a request,
 *     `Location` on a redirect.
 *   - Query strings and fragments on every request, frame and script URL, the kept
 *     cookie-setting records (1.27.0) included. Identifiers and tokens travel there, and
 *     the engine classifies a URL by its host. The one exception
 *     is a tag-manager loader's `id=`, kept because the container id is the point of the
 *     URL and the provenance rules resolve by it. The exception is checked, not assumed:
 *     `containerIdentity` gives the same answer before and after. Container frame URLs
 *     count as frame URLs wherever they sit, including the keys of the per-container read
 *     split and the frames that set Consent Mode: a GTM loader's query can carry
 *     `gtm_auth` and `gtm_preview`, which open the site's unpublished workspace. The frame
 *     URLs a container's summary keeps (`tallies.byContainer`, 1.25.0) are among them.
 *
 * What it leaves: cookie names, domains, paths and attributes; hostnames and paths; the
 * GPP, US Privacy and TCF strings (consent state the site broadcast about the reader,
 * which is the subject of the record rather than a credential); every count.
 *
 * Replayability (FR-23) holds because nothing the engine reads is changed by the pass.
 * The engine test suite asserts it: `evaluate` returns the same findings for a set and its
 * redaction. A caller seals the redacted set with findings computed from that set, so a
 * third party re-running the engine on the bundle gets the bundle's findings back.
 *
 * Pure: the input is not touched, and the pass is idempotent.
 */

import type { ObservationSet } from "./observation-set.js";
import type {
  CookieRecord,
  Header,
  KeptCookieResponse,
  NetworkObservation,
  ScriptInsertion,
  ScriptInsertionLoader,
} from "./observation.js";
import type {
  ConsentApiCall,
  ContainerTally,
  GtmObservation,
  InvalidWireValue,
  ReadAttribution,
  SignalObservation,
  Tallies,
} from "./signal.js";
import { containerIdentity } from "./tag-managers.js";

/** The marker a masked value is replaced with. Distinct from any value a site could set. */
export const REDACTED = "[redacted]";

/** Request headers whose value is a credential. Matched on `nameLower`. */
const CREDENTIAL_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "cookie",
  "authorization",
  "proxy-authorization",
]);

/**
 * A URL with its query and fragment removed. A tag-manager loader keeps its `id=` when the
 * original query carried one, so `containerIdentity` still names the container.
 *
 * String operations rather than `new URL`, because a frame URL distilled from a stack can
 * be truncated past what the parser accepts and still name a host worth keeping.
 */
export function redactUrl(url: string): string {
  let end = url.length;
  const q = url.indexOf("?");
  if (q >= 0) end = q;
  const h = url.indexOf("#");
  if (h >= 0 && h < end) end = h;
  const base = url.slice(0, end);
  if (q < 0 || q > end) return base;

  const identity = containerIdentity(url);
  if (identity === null || identity.id === null) return base;
  const id = queryParam(url.slice(q + 1, h > q ? h : url.length), "id");
  return id === null ? base : `${base}?id=${id}`;
}

/** The raw (still encoded) value of one query parameter, or null when absent. */
function queryParam(query: string, name: string): string | null {
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    const key = eq < 0 ? pair : pair.slice(0, eq);
    if (key === name) {
      const value = eq < 0 ? "" : pair.slice(eq + 1);
      return value === "" ? null : value;
    }
  }
  return null;
}

function redactUrls(urls: readonly string[]): string[] {
  return urls.map(redactUrl);
}

/**
 * A `Set-Cookie` header with its value masked and its attributes kept: the name and the
 * attributes are what the record is about, the value is what must not leave.
 */
function redactSetCookieValue(header: string): string {
  const semi = header.indexOf(";");
  const pair = semi < 0 ? header : header.slice(0, semi);
  const attrs = semi < 0 ? "" : header.slice(semi);
  const eq = pair.indexOf("=");
  if (eq < 0) return `${REDACTED}${attrs}`;
  return `${pair.slice(0, eq)}=${REDACTED}${attrs}`;
}

/**
 * Headers whose value is a URL: the page a request came from, and where a redirect sent
 * it. Their queries are stripped like any other URL's. A same-origin Referer carries the
 * page's full address, and a Location can carry an OAuth `code=` or a session token.
 */
const URL_REQUEST_HEADERS: ReadonlySet<string> = new Set(["referer"]);
const URL_RESPONSE_HEADERS: ReadonlySet<string> = new Set(["location", "content-location", "refresh"]);

function redactRequestHeader(h: Header): Header {
  if (CREDENTIAL_REQUEST_HEADERS.has(h.nameLower)) return { ...h, value: REDACTED };
  return URL_REQUEST_HEADERS.has(h.nameLower) ? { ...h, value: redactUrl(h.value) } : h;
}

function redactResponseHeader(h: Header): Header {
  if (h.nameLower === "set-cookie") return { ...h, value: redactSetCookieValue(h.value) };
  return URL_RESPONSE_HEADERS.has(h.nameLower) ? { ...h, value: redactUrl(h.value) } : h;
}

/** A cookie's writer URLs with their queries stripped, for every form a cookie is kept in. */
function redactWriters<C extends Omit<CookieRecord, "value">>(c: C): C {
  let out = c;
  if (typeof c.writerScriptUrl === "string") out = { ...out, writerScriptUrl: redactUrl(c.writerScriptUrl) };
  if (typeof c.writerWrapperUrl === "string") out = { ...out, writerWrapperUrl: redactUrl(c.writerWrapperUrl) };
  return out;
}

function redactCookie(c: CookieRecord): CookieRecord {
  return redactWriters({ ...c, value: REDACTED });
}

/**
 * A kept record (1.27.0) already carries its URLs without a query and its cookies without
 * a value. The pass runs over it anyway, so the rule holds by this file and not by how the
 * worker happened to write the record: a value on one of its cookies, which its type has no
 * room for, is dropped here too.
 */
function redactKept(k: KeptCookieResponse): KeptCookieResponse {
  return {
    ...k,
    url: redactUrl(k.url),
    setCookies: k.setCookies.map((c) => {
      const { value: _never, ...cookie } = c as typeof c & { value?: unknown };
      return redactWriters(cookie);
    }),
  };
}

function redactNetwork(n: NetworkObservation): NetworkObservation {
  return {
    ...n,
    url: redactUrl(n.url),
    initiator: n.initiator === null ? null : redactUrl(n.initiator),
    requestHeaders: n.requestHeaders.map(redactRequestHeader),
    responseHeaders:
      n.responseHeaders === null ? null : n.responseHeaders.map(redactResponseHeader),
    setCookies: n.setCookies.map(redactCookie),
  };
}

function redactLoader(l: ScriptInsertionLoader): ScriptInsertionLoader {
  const out: ScriptInsertionLoader = {
    ...l,
    insertedBy: redactUrls(l.insertedBy),
    containerUrls: redactUrls(l.containerUrls),
  };
  if (l.wrapperFrames !== undefined) {
    return { ...out, wrapperFrames: redactUrls(l.wrapperFrames) };
  }
  return out;
}

function redactInsertion(s: ScriptInsertion): ScriptInsertion {
  return { ...s, url: redactUrl(s.url), loaders: s.loaders.map(redactLoader) };
}

function redactConsentCall(c: ConsentApiCall): ConsentApiCall {
  const out: ConsentApiCall = {
    ...c,
    callerScriptUrl: c.callerScriptUrl === null ? null : redactUrl(c.callerScriptUrl),
  };
  if (c.containerUrls !== undefined) {
    return { ...out, containerUrls: redactUrls(c.containerUrls) };
  }
  return out;
}

/**
 * Counts keyed by URL (reads by script, container reads by frame). Two URLs that differ
 * only in their query become one key, so their counts add; the total is unchanged.
 */
function redactCountsByUrl(
  counts: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [url, n] of Object.entries(counts)) {
    const key = redactUrl(url);
    out[key] = (out[key] ?? 0) + n;
  }
  return out;
}

function redactReadAttribution(a: ReadAttribution): ReadAttribution {
  if (a.viaTagManagerByContainer === undefined) return a;
  return { ...a, viaTagManagerByContainer: redactCountsByUrl(a.viaTagManagerByContainer) };
}

function redactSignal(s: SignalObservation): SignalObservation {
  return {
    ...s,
    readsByScript: redactCountsByUrl(s.readsByScript),
    readAttribution: s.readAttribution === null ? null : redactReadAttribution(s.readAttribution),
  };
}

/**
 * The frames that set Consent Mode. null (site code, or unattributed) and absent (a set
 * recorded before 1.12.0) both stay as they are.
 */
function redactGtm(g: GtmObservation): GtmObservation {
  let out = g;
  if (typeof g.consentModeDefaultSetBy === "string") {
    out = { ...out, consentModeDefaultSetBy: redactUrl(g.consentModeDefaultSetBy) };
  }
  if (typeof g.consentModeUpdateSetBy === "string") {
    out = { ...out, consentModeUpdateSetBy: redactUrl(g.consentModeUpdateSetBy) };
  }
  return out;
}

/** The frame URLs each container's summary keeps. Absent stays absent. */
function redactTallies(t: Tallies): Tallies {
  if (t.byContainer === undefined) return t;
  const byContainer: Record<string, ContainerTally> = {};
  for (const [key, c] of Object.entries(t.byContainer)) byContainer[key] = { ...c, frameUrls: redactUrls(c.frameUrls) };
  return { ...t, byContainer };
}

/**
 * An invalid wire value can hold anything a vendor put in the parameter, not only a
 * consent string, so it is masked like a cookie value. The hosts and the placeholder flag
 * stay: they are what the finding is about.
 */
function redactInvalidWire<T extends { readonly invalidWire?: readonly InvalidWireValue[] }>(o: T): T {
  if (o.invalidWire === undefined) return o;
  return { ...o, invalidWire: o.invalidWire.map((w) => ({ ...w, value: REDACTED })) };
}

/**
 * A copy of the set with every value listed in the header comment masked. The input is
 * not modified. Optional fields stay absent when absent, so the canonical form of a set
 * recorded before a field existed does not gain the field.
 */
export function redact(obs: ObservationSet): ObservationSet {
  const out: ObservationSet = {
    ...obs,
    gpp: obs.gpp === null ? null : redactInvalidWire(obs.gpp),
    usPrivacy: obs.usPrivacy === null ? null : redactInvalidWire(obs.usPrivacy),
    context: { ...obs.context, finalUrl: redactUrl(obs.context.finalUrl) },
    signal: redactSignal(obs.signal),
    gtm: redactGtm(obs.gtm),
    network: obs.network.map(redactNetwork),
    consentApiCalls: obs.consentApiCalls.map(redactConsentCall),
    tallies: redactTallies(obs.tallies),
  };
  const withKept =
    obs.keptCookieResponses === undefined
      ? out
      : { ...out, keptCookieResponses: obs.keptCookieResponses.map(redactKept) };
  const withInsertions =
    obs.scriptInsertions === undefined
      ? withKept
      : { ...withKept, scriptInsertions: obs.scriptInsertions.map(redactInsertion) };
  return obs.requestInitiators === undefined
    ? withInsertions
    : { ...withInsertions, requestInitiators: obs.requestInitiators.map(redactInsertion) };
}
