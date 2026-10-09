// SPDX-License-Identifier: GPL-3.0-only
/**
 * One shape for everything the engine and the popup read (1.22.0).
 *
 * Since 1.22.0 the worker records, as they arrive, every fact the Overview and the findings
 * are built from: the cookie details, each vendor summary's first request and first proof
 * its code ran, whether a Google tag script was fetched. The request list is then only the
 * Requests tab's, and losing it to a worker reclaim changes nothing else.
 *
 * A bundle recorded before 1.22.0 has those facts only in its request list. This derives
 * them from it, once, so a reader never has to choose between the persisted field and a
 * scan of `network`: the choice is made here and nowhere else. A current capture has every
 * field already and comes back unchanged.
 *
 * It also reads a GPP section's MspaCoveredTransactions key, the misspelling recorded before
 * 1.32.0, as MspaCoveredTransaction, so an older bundle's value still decodes.
 *
 * Pure and deterministic, like the rest of the engine: the same set always derives the same
 * fields, in request order.
 */

import type {
  GppObservation,
  GppSectionFields,
  ObservationSet,
  Tallies,
  CookieDetail,
  ContainerTally,
  EntityCategoryTally,
  EntityTally,
} from "@gpc-inspector/schema";
import {
  ACTIVE_RESOURCE_TYPES,
  CONTAINER_COOKIE_CAP,
  CONTAINER_FRAME_URL_CAP,
  containerIdentity,
  containerKey,
  hostOf,
  isCookieSet,
  isGoogleTagScript,
} from "@gpc-inspector/schema";

type MutableDetail = { -readonly [K in keyof CookieDetail]: CookieDetail[K] };

const shaped = new WeakMap<ObservationSet, ObservationSet>();

/** The set with every persisted field present, derived from its requests where missing. */
export function withPersistedShape(obs: ObservationSet): ObservationSet {
  const known = shaped.get(obs);
  if (known !== undefined) return known;

  const t = obs.tallies;
  const needsGtm = obs.gtm.scriptFetched === undefined;
  const needsDetails = t.cookieDetails === undefined;
  const needsIds = Object.values(t.byEntityCategory ?? {}).some((p) => p.firstObservationId === undefined);
  const needsTypes = Object.values(t.byEntity).some((e) => e.resourceTypes === undefined);
  const needsContainers = t.byContainer === undefined;
  const needsGpp = obs.gpp !== null && Object.values(obs.gpp.sections).some((f) => PLURAL_MSPA_KEY in f);
  if (!needsGtm && !needsDetails && !needsIds && !needsTypes && !needsContainers && !needsGpp) {
    shaped.set(obs, obs);
    return obs;
  }

  const details = needsDetails ? detailsFrom(obs) : t.cookieDetails;
  const containers = needsContainers ? containersFrom(obs, details ?? {}) : null;
  const tallies: Tallies = {
    ...t,
    ...(needsDetails || containers !== null ? { cookieDetails: containers?.details ?? details } : {}),
    ...(needsIds && t.byEntityCategory ? { byEntityCategory: summariesWithIds(obs, t.byEntityCategory) } : {}),
    ...(needsTypes ? { byEntity: entitiesWithTypes(obs, t.byEntity) } : {}),
    ...(containers !== null ? { byContainer: containers.byContainer } : {}),
  };
  const out: ObservationSet = {
    ...obs,
    ...(needsGpp && obs.gpp !== null ? { gpp: gppWithSingularKey(obs.gpp) } : {}),
    gtm: needsGtm ? { ...obs.gtm, scriptFetched: obs.network.some((n) => isGoogleTagScript(n.url)) } : obs.gtm,
    tallies,
  };
  shaped.set(obs, out);
  shaped.set(out, out);
  return out;
}

/** The key GppSectionFields used for MspaCoveredTransaction before 1.32.0, misspelled. */
const PLURAL_MSPA_KEY = "MspaCoveredTransactions";

/** Each section with the pre-1.32.0 plural key read as the IAB field name, value kept. */
function gppWithSingularKey(gpp: GppObservation): GppObservation {
  const sections: Record<string, GppSectionFields> = {};
  for (const [name, fields] of Object.entries(gpp.sections)) {
    if (!(PLURAL_MSPA_KEY in fields)) {
      sections[name] = fields;
      continue;
    }
    const { [PLURAL_MSPA_KEY]: plural, ...rest } = fields;
    const value = rest.MspaCoveredTransaction ?? plural;
    sections[name] = value === undefined ? rest : { ...rest, MspaCoveredTransaction: value };
  }
  return { ...gpp, sections };
}

/** The worker's noteCookieDetail, over a recorded request list, with no cap. */
function detailsFrom(obs: ObservationSet): Record<string, CookieDetail> {
  const signedCounted = new Set(obs.tallies.adCookieKeys);
  const out = new Map<string, MutableDetail>();
  for (const net of obs.network) {
    for (const c of net.setCookies) {
      if (!isCookieSet(c, net.timeMs)) continue;
      const key = `${c.name}\u0000${c.domain}`;
      const host = hostOf(net.url);
      let d = out.get(key);
      if (d === undefined) {
        d = {
          expiresMs: c.expiresMs, sameSite: c.sameSite, secure: c.secure, partitioned: c.partitioned, via: c.via,
          host, onRedirect: false, onRedirectSigned: false, firstSignedObservationId: null,
        };
        out.set(key, d);
      }
      d.expiresMs = c.expiresMs;
      d.sameSite = c.sameSite;
      d.secure = c.secure;
      d.partitioned = c.partitioned;
      d.via = c.via;
      if (net.isRedirectHop) d.onRedirect = true;
      if (net.secGpcPresent && signedCounted.has(key)) {
        if (d.firstSignedObservationId === null) {
          d.firstSignedObservationId = net.id;
          d.host = host;
        }
        if (net.isRedirectHop) d.onRedirectSigned = true;
      }
    }
  }
  return Object.fromEntries([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Each summary's first request and first proof its code ran, found by its hosts. */
function summariesWithIds(
  obs: ObservationSet,
  summaries: Readonly<Record<string, EntityCategoryTally>>,
): Record<string, EntityCategoryTally> {
  const out: Record<string, EntityCategoryTally> = {};
  for (const [key, p] of Object.entries(summaries)) {
    if (p.firstObservationId !== undefined) {
      out[key] = p;
      continue;
    }
    const hosts = new Set(p.hosts);
    let first: string | null = null;
    let ran: string | null = null;
    let outsideXhr = false;
    for (const net of obs.network) {
      const mine = hosts.has(hostOf(net.url));
      if (mine) first ??= net.id;
      if (mine && ACTIVE_RESOURCE_TYPES.has(net.resourceType)) {
        ran ??= net.id;
        if (net.resourceType !== "xmlhttprequest") outsideXhr = true;
      }
      // A cookie its own script wrote: the observation's URL is the writer's.
      if (mine && net.setCookies.some((c) => (c.via === "documentCookie" || c.via === "cookieStore") && c.writerScriptUrl)) {
        ran ??= net.id;
        outsideXhr = true;
      }
    }
    out[key] = { ...p, firstObservationId: first, executionObservationId: ran, scriptRanOutsideXhr: outsideXhr };
  }
  return out;
}

/** Resource types per vendor, for a tally from before they were recorded (1.13.0). */
function entitiesWithTypes(
  obs: ObservationSet,
  byEntity: Readonly<Record<string, EntityTally>>,
): Record<string, EntityTally> {
  const out: Record<string, EntityTally> = {};
  for (const [name, e] of Object.entries(byEntity)) {
    if (e.resourceTypes !== undefined) {
      out[name] = e;
      continue;
    }
    const hosts = new Set(e.hosts);
    const types = new Set<string>();
    // Requests only: a script-written cookie's observation is not a request.
    for (const net of obs.network) if (net.method !== "SCRIPT" && hosts.has(hostOf(net.url))) types.add(net.resourceType);
    out[name] = { ...e, resourceTypes: [...types].sort() };
  }
  return out;
}

/**
 * What was written inside each container, and each key's writer, for a capture from before
 * 1.25.0: the worker's container summary over the recorded request list. Probes and refused
 * writes were never kept by container, and a key past the cap is left out as the worker
 * leaves it. A detail whose host is a container's gains the container, so the findings
 * charge it by the owner's list, as they would a current capture's.
 */
function containersFrom(
  obs: ObservationSet,
  details: Readonly<Record<string, CookieDetail>>,
): { byContainer: Record<string, ContainerTally>; details: Record<string, CookieDetail> } {
  type Mutable = { -readonly [K in keyof ContainerTally]: ContainerTally[K] } & {
    frameUrls: string[];
    cookieKeys: string[];
    cookieKeysUnsigned: string[];
  };
  const out = new Map<string, Mutable>();
  const writerOf = new Map<string, string>();
  for (const net of obs.network) {
    for (const c of net.setCookies) {
      if (c.via !== "documentCookie" && c.via !== "cookieStore") continue;
      if (typeof c.writerScriptUrl !== "string" || !isCookieSet(c, net.timeMs)) continue;
      const identity = containerIdentity(c.writerScriptUrl);
      if (identity === null) continue;
      const ck = containerKey(identity);
      const key = `${c.name}\u0000${c.domain}`;
      let summary = out.get(ck);
      if (summary === undefined) {
        summary = { manager: identity.manager, id: identity.id, frameUrls: [], cookieKeys: [], cookieKeysUnsigned: [], probeCookies: [], refusedWrites: [] };
        out.set(ck, summary);
      }
      if (!summary.frameUrls.includes(c.writerScriptUrl) && summary.frameUrls.length < CONTAINER_FRAME_URL_CAP) summary.frameUrls.push(c.writerScriptUrl);
      const keys = net.secGpcPresent ? summary.cookieKeys : summary.cookieKeysUnsigned;
      if (!keys.includes(key)) {
        if (keys.length < CONTAINER_COOKIE_CAP) keys.push(key);
        else summary.capped = true;
      }
      // The detail's writer is the set its host was taken from, as in the worker.
      if (!writerOf.has(key) && details[key]?.host === hostOf(net.url)) writerOf.set(key, ck);
    }
  }
  const byContainer: Record<string, ContainerTally> = {};
  for (const [ck, summary] of [...out].sort(([a], [b]) => (a < b ? -1 : 1))) {
    byContainer[ck] = { ...summary, cookieKeys: [...summary.cookieKeys].sort(), cookieKeysUnsigned: [...summary.cookieKeysUnsigned].sort() };
  }
  const withWriters: Record<string, CookieDetail> = {};
  for (const [key, d] of Object.entries(details)) {
    const ck = writerOf.get(key);
    withWriters[key] = ck === undefined || d.container !== undefined ? d : { ...d, container: ck };
  }
  return { byContainer, details: withWriters };
}
