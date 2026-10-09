// SPDX-License-Identifier: GPL-3.0-only
/**
 * Turning raw webRequest events into schema observations (PRD FR-7, FR-8).
 *
 * Split into pure functions here so the conversion logic is testable in Node; the
 * listener registration that calls them lives in sw.ts, which must stay thin.
 *
 * Chrome behavior encoded here:
 *   - `onHeadersReceived` is the primary capture and fires PER REDIRECT HOP. A 302 that
 *     carries Set-Cookie is visible here and invisible to onResponseStarted; on a real
 *     site ~40% of image-tracking cookies arrived this way. Redirect responses are
 *     therefore recorded as first-class observations, flagged `isRedirectHop`.
 *   - `extraHeaders` is required for Set-Cookie to appear at all. Without it the
 *     harness measured zero cookies across every resource type.
 */

import type { NetworkObservation, Header, CookieRecord } from "@gpc-inspector/schema";
import { hostOf } from "@gpc-inspector/schema";
import {
  parseSetCookieHeaders,
  isRedirectStatus,
  hasSecGpc,
  cookieNamesSent,
} from "../observe/cookies.js";

/** Chrome delivers headers as {name, value?} or {name, binaryValue?}. Normalize. */
export function normalizeHeaders(
  raw: readonly chrome.webRequest.HttpHeader[] | undefined,
): Header[] {
  if (!raw) return [];
  const out: Header[] = [];
  for (const h of raw) {
    const name = h.name;
    out.push({
      name,
      nameLower: name.toLowerCase(),
      value: h.value ?? "",
    });
  }
  return out;
}

// One definition, shared with the tallies and the engine.
export { hostOf };

/**
 * Build the request half of an observation, from onSendHeaders.
 * The response fields are filled in later by onHeadersReceived, keyed by requestId.
 */
/**
 * Header names worth retaining on a request.
 *
 * We keep the signal itself and the presence-relevant few. Everything else is bulk: an
 * ad-heavy page produces enough header data to exhaust the session-storage quota, at
 * which point every subsequent write fails and the extension reports stale state with
 * full confidence. The facts the engine needs are extracted at capture time, so the raw
 * arrays earn their storage only where they serve as a finding's artifact.
 */
const RETAINED_REQUEST_HEADERS = new Set(["sec-gpc", "referer", "origin"]);

export function observationFromRequest(details: {
  requestId: string;
  url: string;
  method: string;
  type: string;
  initiator?: string | undefined;
  timeStamp: number;
  requestHeaders?: chrome.webRequest.HttpHeader[] | undefined;
}): NetworkObservation {
  const all = normalizeHeaders(details.requestHeaders);
  // secGpcPresent is computed from the full set before trimming, so the fact survives
  // even though the header array does not.
  const secGpcPresent = hasSecGpc(all);
  // Extracted before trimming: the Cookie header is deliberately not retained, but which
  // names it carried is the observation that turns "a cookie was set" into "the identifier
  // went back".
  const cookiesSent = cookieNamesSent(all);
  const requestHeaders = all.filter((h) => RETAINED_REQUEST_HEADERS.has(h.nameLower));
  return {
    id: details.requestId,
    url: details.url,
    method: details.method,
    resourceType: details.type,
    initiator: details.initiator ?? null,
    secGpcPresent,
    cookiesSent,
    requestHeaders,
    statusCode: null,
    responseHeaders: null,
    isRedirectHop: false,
    setCookies: [],
    captureMethod: "onHeadersReceived",
    timeMs: details.timeStamp,
  };
}

/**
 * Merge the response half into an existing observation.
 *
 * Returns a NEW observation rather than mutating, so callers can decide whether this is
 * an update to an existing entry or (for a redirect chain) an additional hop.
 */
export function mergeResponse(
  base: NetworkObservation,
  details: {
    statusCode: number;
    responseHeaders?: chrome.webRequest.HttpHeader[] | undefined;
    url: string;
  },
): NetworkObservation {
  const allResponse = normalizeHeaders(details.responseHeaders);
  const fallbackDomain = `.${hostOf(details.url)}`;
  // Cookies are parsed from the full set, then the array is trimmed to the headers that
  // serve as evidence for a cookie finding.
  const responseHeaders = allResponse.filter(
    (h) =>
      h.nameLower === "set-cookie" ||
      h.nameLower === "location" ||
      h.nameLower === "content-type",
  );
  const setCookies: CookieRecord[] = dedupeCookies(
    parseSetCookieHeaders(allResponse, fallbackDomain, "onHeadersReceived"),
  );

  return {
    ...base,
    statusCode: details.statusCode,
    responseHeaders,
    isRedirectHop: isRedirectStatus(details.statusCode),
    setCookies,
  };
}

/**
 * An observation built from a response alone (1.26.0): its request went out before this
 * worker started, after a reclaim or a restart, so nothing the request carried was seen.
 * `secGpcPresent` is false and says nothing, which `requestLost` marks; the cookies are
 * parsed as any response's are.
 */
export function observationFromResponse(details: {
  requestId: string;
  url: string;
  method: string;
  type: string;
  initiator?: string | undefined;
  timeStamp: number;
  statusCode: number;
  responseHeaders?: chrome.webRequest.HttpHeader[] | undefined;
}): NetworkObservation {
  const base: NetworkObservation = {
    id: details.requestId,
    url: details.url,
    method: details.method,
    resourceType: details.type,
    initiator: details.initiator ?? null,
    secGpcPresent: false,
    cookiesSent: [],
    requestHeaders: [],
    statusCode: null,
    responseHeaders: null,
    isRedirectHop: false,
    setCookies: [],
    captureMethod: "onHeadersReceived",
    timeMs: details.timeStamp,
    requestLost: true,
  };
  return mergeResponse(base, details);
}

/**
 * Collapse duplicate cookies within a single response.
 *
 * Observed in the wild: a response carrying the same name+domain+path more than once
 * (Google's SIDCC family arrived twice on one calendar.google.com response). Whether the
 * origin sent it twice or Chrome surfaced it twice under `extraHeaders`, the browser's
 * own semantics are last-write-wins for an identical name+domain+path — so counting it
 * twice would overstate what the response did, and this product's whole claim is that it
 * does not overstate.
 *
 * Cookies differing in domain or path are NOT duplicates: setting the same name for
 * .google.com and for calendar.google.com is two distinct cookies.
 */
export function dedupeCookies(cookies: readonly CookieRecord[]): CookieRecord[] {
  const byIdentity = new Map<string, CookieRecord>();
  for (const c of cookies) {
    byIdentity.set(`${c.name}\u0000${c.domain}\u0000${c.path}`, c); // last wins
  }
  return [...byIdentity.values()];
}

/**
 * A redirect hop and its eventual final response share a requestId in Chrome. Because
 * each hop can set its own cookies, we keep them as separate observations with distinct
 * ids: the base requestId for the first, then `${requestId}#N` for subsequent hops.
 */
export function hopId(requestId: string, hopIndex: number): string {
  return hopIndex === 0 ? requestId : `${requestId}#${hopIndex}`;
}

/**
 * Does this observation id belong to the given Chrome requestId?
 *
 * Chrome requestIds are sequential numeric strings, so a naive prefix test
 * (`id.startsWith(requestId)`) matches "1470", "1471", "14712"... for requestId "147".
 * On a busy page those collisions are certain, and a collision misattributes a response
 * to an unrelated request. Hop ids are exactly `requestId` or `requestId#N`.
 */
export function belongsToRequest(observationId: string, requestId: string): boolean {
  return observationId === requestId || observationId.startsWith(`${requestId}#`);
}

/**
 * Is this a top-level page we should track as a site?
 *
 * chrome://, chrome-extension://, about: and file: pages are not sites: content scripts
 * cannot run on them, so the signal side is unobservable, and a "topSite" of
 * "new-tab-page" makes party classification meaningless. Requests fired from behind such
 * pages (Google's own NTP service-worker traffic, for instance) are not observations
 * about a website.
 */
export function isTrackableTopLevel(url: string): boolean {
  try {
    const scheme = new URL(url).protocol;
    return scheme === "http:" || scheme === "https:";
  } catch {
    return false;
  }
}

/** Should this observation be retained? Filters out noise we never reason about. */
export function isRetainable(obs: NetworkObservation): boolean {
  // Extension-internal and browser-internal schemes are not observations about a site.
  if (
    obs.url.startsWith("chrome://") ||
    obs.url.startsWith("chrome-extension://") ||
    obs.url.startsWith("about:") ||
    obs.url.startsWith("data:")
  ) {
    return false;
  }
  return true;
}
