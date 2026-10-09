// SPDX-License-Identifier: GPL-3.0-only
/**
 * Running tallies (PRD FR-22).
 *
 * Every count shown to a person is maintained here, as observations arrive, and is never
 * subject to eviction. The retained `network` array is a sample bounded by the storage
 * quota; these numbers are not.
 *
 * Counts computed by scanning the retained array at read time measure what survived
 * rather than what happened: on one page the advertising-request count read 87, then 25,
 * then 0, purely as the retention rule changed underneath it. Three answers to the same
 * question about the same page.
 *
 * Mutable by design. This is the one place where accumulating in place is correct: the
 * alternative is rebuilding a record per request on a page that makes hundreds, and the
 * whole structure is written to storage on every flush regardless.
 */

import {
  ACTIVE_RESOURCE_TYPES,
  CONTAINER_COOKIE_CAP,
  CONTAINER_FRAME_URL_CAP,
  COOKIE_DETAIL_CAP,
  FIRST_PARTY_COOKIE_CAP,
  REQUEST_LOST_COOKIE_CAP,
  UNLISTED_COOKIE_CAP,
  UNLISTED_DOMAIN_CAP,
  UNLISTED_HOST_CAP,
  containerKey,
  entityCategoryKey,
  hostOf,
} from "@gpc-inspector/schema";
import { COUNTING_CATEGORIES, isCounted, type Category, type CookieCharge } from "@gpc-inspector/engine";
import type {
  Tallies,
  EntityTally,
  EntityCategoryTally,
  NetworkObservation,
  CookieRecord,
  CookieDetail,
  ContainerTally,
  ContainerIdentity,
  UnlistedDomainTally,
  FirstPartyTally,
  TagManagerKind,
} from "@gpc-inspector/schema";

/** What the tally needs to know about a URL, supplied by the caller. */
export interface TallyClassification {
  readonly party: "first" | "third";
  readonly category: string;
  readonly entityName: string | null;
  /** The URL's registrable domain (1.26.0). Absent, the hostname stands in for it. */
  readonly domain?: string;
}

/**
 * Whom each cookie is charged to (1.25.0): the engine's `cookieCharge`, which the worker
 * calls once per cookie and hands in. See the engine's cookie-charge.ts.
 */
export type ChargeOf = (cookie: CookieRecord) => CookieCharge;

/** The charge of a response's cookies, and of any cookie when no rule is supplied: its request's host. */
export function hostCharge(cls: TallyClassification): CookieCharge {
  return {
    kind: "host",
    party: cls.party,
    category: cls.category as Category,
    entity: cls.entityName === null ? null : { name: cls.entityName, id: cls.entityName },
    ...(cls.domain === undefined ? {} : { domain: cls.domain }),
  };
}

/** A charge as the tally's own classification; null for a container's, which names no one. */
function chargedTo(charge: CookieCharge): TallyClassification | null {
  if (charge.kind === "container") return null;
  return { party: charge.party, category: charge.category, entityName: charge.entity?.name ?? null };
}

/** Mutable form. Converted to the readonly schema shape on read. */
export interface MutableTallies {
  totalRequests: number;
  signedRequests: number;
  adVendorRequests: number;
  adCookieEvents: number;
  adCookieKeys: Set<string>;
  adCookieEventsUnsigned: number;
  adCookieKeysUnsigned: Set<string>;
  firstPartyVendorCookieKeys: Set<string>;
  /** Category of the request that first set each counted key (1.17.0). */
  adCookieCategories: Map<string, "advertising" | "analytics">;
  /** Vendor whose request first set each counted key (1.19.0). */
  adCookieEntities: Map<string, string>;
  /**
   * Every vendor each counted key was charged to, signed and unsigned, so a probe takes a
   * name off exactly the vendors that no longer hold a key of it. Stored since 1.37.0; a
   * tally stored before that is thawed from adCookieEntities, the first vendor of each key.
   */
  adCookieCharges: { readonly signed: Map<string, Set<string>>; readonly unsigned: Map<string, Set<string>> };
  /** Per vendor: probe cookie names, and refused writes as "name (domain)" (1.18.0). */
  probeCookies: Map<string, Set<string>>;
  refusedCookieWrites: Map<string, Set<string>>;
  byEntity: Map<string, MutableEntityTally>;
  /** One summary per company and category, every category (1.20.0). Counts nothing. */
  byEntityCategory: Map<string, MutablePairTally>;
  /** Per recorded cookie key: attributes, and what the per-cookie findings need (1.22.0). */
  cookieDetails: Map<string, MutableCookieDetail>;
  /** What was written inside each container, by containerKey (1.25.0). Counts nothing. */
  byContainer: Map<string, MutableContainerTally>;
  /** Third-party domains the list names no company for, by registrable domain (1.26.0). Counts nothing. */
  byUnlistedDomain: Map<string, MutableUnlistedTally>;
  unlistedDomainsCapped: boolean;
  /** The first-party cookies (1.26.0). Counts nothing. */
  firstParty: MutableFirstPartyTally;
}

/** One unlisted domain's summary. See the schema's UnlistedDomainTally. */
interface MutableUnlistedTally {
  domain: string;
  requests: number;
  signedRequests: number;
  hosts: Set<string>;
  resourceTypes: Set<string>;
  cookieKeys: Set<string>;
  cookieKeysUnsigned: Set<string>;
  cookiesReturned: Set<string>;
  probeCookies: Set<string>;
  refusedWrites: Set<string>;
  scriptRan: boolean;
  scriptRanOutsideXhr: boolean;
  firstObservationId: string | null;
  executionObservationId: string | null;
  cookieKeysRequestLost: Set<string>;
  requestLostCapped: boolean;
  capped: boolean;
  requestsCapped: boolean;
}

/** See the schema's FirstPartyTally. */
interface MutableFirstPartyTally {
  cookieKeys: Set<string>;
  cookieKeysUnsigned: Set<string>;
  vendorCookieKeysUnsigned: Set<string>;
  probeCookies: Set<string>;
  cookieKeysRequestLost: Set<string>;
  requestLostCapped: boolean;
  capped: boolean;
  cappedUnsigned: boolean;
}

type MutableCookieDetail = { -readonly [K in keyof CookieDetail]: CookieDetail[K] };

/** One container's summary. See the schema's ContainerTally. */
interface MutableContainerTally {
  manager: TagManagerKind;
  id: string | null;
  frameUrls: string[];
  cookieKeys: Set<string>;
  cookieKeysUnsigned: Set<string>;
  probeCookies: Set<string>;
  refusedWrites: Set<string>;
  capped: boolean;
}

/** A company in one category. See the schema's EntityCategoryTally. */
interface MutablePairTally {
  entity: string;
  category: string;
  requests: number;
  signedRequests: number;
  hosts: Set<string>;
  resourceTypes: Set<string>;
  scriptRan: boolean;
  /** Written for the categories that do not count; the counted keys are the record of the rest. */
  cookieKeys: Set<string>;
  cookieKeysUnsigned: Set<string>;
  cookiesReturned: Set<string>;
  probeCookies: Set<string>;
  refusedWrites: Set<string>;
  firstObservationId: string | null;
  executionObservationId: string | null;
  scriptRanOutsideXhr: boolean;
  /** Keys set on a response whose request was lost (1.26.0). Every category; counted nowhere. */
  cookieKeysRequestLost: Set<string>;
  requestLostCapped: boolean;
}

interface MutableEntityTally {
  requests: number;
  signedRequests: number;
  cookieNames: Set<string>;
  cookieNamesUnsigned: Set<string>;
  cookiesReturned: Set<string>;
  hosts: Set<string>;
  /**
   * The per-vendor summary (1.13.0): what the engine needs to judge a vendor once its
   * requests are gone. `scriptRan` stays undefined for a tally stored before the field
   * existed, so an old tab is not read as "counted requests, no script".
   */
  resourceTypes: Set<string>;
  scriptRan: boolean | undefined;
}

function emptyEntity(): MutableEntityTally {
  return {
    requests: 0,
    signedRequests: 0,
    cookieNames: new Set<string>(),
    cookieNamesUnsigned: new Set<string>(),
    cookiesReturned: new Set<string>(),
    hosts: new Set<string>(),
    resourceTypes: new Set<string>(),
    scriptRan: false,
  };
}

export function emptyTallies(): MutableTallies {
  return {
    totalRequests: 0,
    signedRequests: 0,
    adVendorRequests: 0,
    adCookieEvents: 0,
    adCookieKeys: new Set(),
    adCookieEventsUnsigned: 0,
    adCookieKeysUnsigned: new Set(),
    firstPartyVendorCookieKeys: new Set(),
    adCookieCategories: new Map(),
    adCookieEntities: new Map(),
    adCookieCharges: { signed: new Map(), unsigned: new Map() },
    probeCookies: new Map(),
    refusedCookieWrites: new Map(),
    byEntity: new Map(),
    byEntityCategory: new Map(),
    cookieDetails: new Map(),
    byContainer: new Map(),
    byUnlistedDomain: new Map(),
    unlistedDomainsCapped: false,
    firstParty: emptyFirstParty(),
  };
}

function emptyFirstParty(): MutableFirstPartyTally {
  return {
    cookieKeys: new Set(),
    cookieKeysUnsigned: new Set(),
    vendorCookieKeysUnsigned: new Set(),
    probeCookies: new Set(),
    cookieKeysRequestLost: new Set(),
    requestLostCapped: false,
    capped: false,
    cappedUnsigned: false,
  };
}

// COUNTING_CATEGORIES, the engine's: the categories whose cookies and requests are counted.
// The summaries per company and category cover every category and never consult it to
// decide what to record, only where a cookie's key is kept: nothing they hold reaches a
// count.

/** A cookie's identity for distinct-counting: name and the domain it was set for. */
export function cookieKey(cookie: CookieRecord): string {
  return `${cookie.name}\u0000${cookie.domain}`;
}

/**
 * Count a request. Called once per observation, when the request is first seen.
 *
 * Split from cookie counting because the two facts arrive at different times: a request is
 * observed at onSendHeaders, its cookies on the response. Counting both in one function and
 * then SUBTRACTING the request half when called for cookies is the shape that produces
 * off-by-one bugs, and this is the code whose entire purpose is for the numbers to be
 * right.
 */
export function tallyRequest(
  t: MutableTallies,
  obs: NetworkObservation,
  classify: (url: string) => TallyClassification,
): void {
  t.totalRequests += 1;
  if (obs.secGpcPresent) t.signedRequests += 1;

  const cls = classify(obs.url);
  tallyPairRequest(t, obs, cls);
  tallyUnlistedRequest(t, obs, cls);
  if (!(cls.party === "third" && COUNTING_CATEGORIES.has(cls.category))) return;

  t.adVendorRequests += 1;
  if (cls.entityName === null) return;

  const entry = t.byEntity.get(cls.entityName) ?? emptyEntity();
  entry.requests += 1;

  // Which of this entity's cookies came back on this request. Only names we saw it SET
  // count: a request to doubleclick.net also carries unrelated cookies on that domain, and
  // claiming those as identifiers this vendor placed would overstate.
  for (const name of obs.cookiesSent) {
    if (entry.cookieNames.has(name) || entry.cookieNamesUnsigned.has(name)) {
      entry.cookiesReturned.add(name);
    }
  }
  if (obs.secGpcPresent) entry.signedRequests += 1;
  entry.resourceTypes.add(obs.resourceType);
  if (ACTIVE_RESOURCE_TYPES.has(obs.resourceType)) entry.scriptRan = true;
  else if (entry.scriptRan === undefined) entry.scriptRan = false;
  const host = hostOf(obs.url);
  if (host !== "") entry.hosts.add(host); // an unparseable url contributes no hostname
  t.byEntity.set(cls.entityName, entry);
}

/**
 * Count a response's cookies. Called once per response that set any.
 *
 * Cookies on a SIGNED request and cookies on an unsigned one are counted apart. The signed
 * count is the claim the product makes about what happened while the signal was on; the
 * unsigned count is the baseline a reader gets by turning the signal off and reloading,
 * which is how a change in site behavior is seen at all. They never merge: a headline that
 * added them would describe neither visit.
 *
 * First-party vendor-written cookies are counted only on signed requests. They are
 * supporting detail under the headline, not part of the comparison.
 */
export function tallyCookies(
  t: MutableTallies,
  obs: NetworkObservation,
  classify: (url: string) => TallyClassification,
  classifyScript: (url: string) => TallyClassification = classify,
  // A charge per cookie in place of one classification per request (1.25.0): a script's
  // observation can carry a name its container's owner wrote beside one it did not.
  chargeOf?: ChargeOf,
): void {
  if (obs.setCookies.length === 0) return;

  const requestCharge = chargeOf === undefined ? hostCharge(classify(obs.url)) : null;
  const signed = obs.secGpcPresent;

  for (const cookie of obs.setCookies) {
    const charge = requestCharge ?? (chargeOf as ChargeOf)(cookie);
    // A response whose request was lost (1.26.0): whether the request carried the signal was
    // not observed, so the cookie is kept by name and counted nowhere.
    if (obs.requestLost === true) {
      tallyLostCookie(t, obs, cookie, charge);
      continue;
    }
    const isCountingVendor = isCounted(charge);
    // Every key written inside a container is kept by the container's summary, counted or
    // not, and has a detail whatever the cap, as a counted key does.
    const inContainer = charge.kind === "host" ? false : noteContainerCookie(t, charge.container, cookie, signed);
    const cls = chargedTo(charge);
    if (cls === null) {
      noteCookieDetail(t, obs, cookie, signed, false, charge, inContainer);
      continue;
    }
    tallyPairCookie(t, cookie, cls, signed, isCountingVendor, classifyScript, obs.id, charge);
    // A domain the list names no company for keeps its own keys (1.26.0), as a container does.
    const unlisted = unlistedDomainOf(charge, obs.url);
    const held = (unlisted !== null && noteUnlistedCookie(t, unlisted, cookie, signed, obs.id)) || inContainer;
    if (isCountingVendor || isPair(cls) || held) noteCookieDetail(t, obs, cookie, signed, isCountingVendor, charge, held);
    if (isCountingVendor) {
      const key = cookieKey(cookie);
      if (!t.adCookieCategories.has(key)) {
        t.adCookieCategories.set(key, cls.category === "analytics" ? "analytics" : "advertising");
      }
      if (signed) {
        t.adCookieEvents += 1;
        t.adCookieKeys.add(cookieKey(cookie));
      } else {
        t.adCookieEventsUnsigned += 1;
        t.adCookieKeysUnsigned.add(cookieKey(cookie));
      }
      if (cls.entityName !== null) {
        if (!t.adCookieEntities.has(key)) t.adCookieEntities.set(key, cls.entityName);
        const charges = signed ? t.adCookieCharges.signed : t.adCookieCharges.unsigned;
        charges.set(key, (charges.get(key) ?? new Set()).add(cls.entityName));
        // Create the entry if the response somehow arrives before the request was counted.
        // In practice onSendHeaders always precedes onHeadersReceived, but a rollup that
        // silently drops a cookie when the order surprises it is the kind of dependency
        // that breaks quietly.
        const entry = t.byEntity.get(cls.entityName) ?? emptyEntity();
        (signed ? entry.cookieNames : entry.cookieNamesUnsigned).add(cookie.name);
        // A cookie written by this entity's own script is execution evidence whatever the
        // resourceType of the request that carries the observation; the engine's rule says
        // the same, and this is the summary it reads when that request is gone. The owner's
        // name written inside its own container is the owner's too (1.25.0).
        const writer = cookie.writerScriptUrl;
        if (charge.kind === "owner") entry.scriptRan = true;
        else if ((cookie.via === "documentCookie" || cookie.via === "cookieStore") && writer) {
          if (classifyScript(writer).entityName === cls.entityName) entry.scriptRan = true;
        }
        t.byEntity.set(cls.entityName, entry);
      }
      continue;
    }
    // A first-party container's names are nobody's (1.25.0), the owner's included.
    if (charge.kind !== "host" || cls.party !== "first") continue;

    // A first-party cookie written by an attributable ad/analytics script is a real fact
    // and a DIFFERENT one: the vendor's code ran, but nothing crossed a site boundary in
    // that act. Counted separately so it never inflates the headline, and on signed
    // requests only. Every other first-party key, and that one while the signal
    // was off, is kept by the first-party summary (1.26.0), which counts nothing. It takes
    // no detail: the cap on details stays the vendor panels'.
    const writer = cookie.writerScriptUrl;
    const byVendor = writer !== null && writer !== undefined && COUNTING_CATEGORIES.has(classifyScript(writer).category);
    if (byVendor && signed) {
      t.firstPartyVendorCookieKeys.add(cookieKey(cookie));
      noteCookieDetail(t, obs, cookie, signed, false, charge, false);
      continue;
    }
    const keys = byVendor ? t.firstParty.vendorCookieKeysUnsigned : signed ? t.firstParty.cookieKeys : t.firstParty.cookieKeysUnsigned;
    noteFirstPartyCookie(t, keys, cookieKey(cookie), signed);
  }
}

/**
 * Record what the panel and the findings need about a cookie key, as it is set (1.22.0).
 *
 * A `counted` key, one the headline counts signed or unsigned, always gets an entry: the
 * per-cookie findings are built from the signed ones, and with sending off the headline is
 * the unsigned ones, so neither may depend on a cap. Any other key gets one while the map
 * is under COOKIE_DETAIL_CAP. The attributes are the latest set's; the host and observation
 * are the first signed set's.
 */
function noteCookieDetail(
  t: MutableTallies,
  obs: NetworkObservation,
  cookie: CookieRecord,
  signed: boolean,
  counted: boolean,
  charge: CookieCharge,
  /** Held by a container's or an unlisted domain's summary: kept past the cap, as a counted key is. */
  inContainer: boolean,
): void {
  const key = cookieKey(cookie);
  const signedCounted = signed && counted;
  // The writer's container goes with the host, from the same set (1.25.0).
  const writtenIn = charge.kind === "host" ? undefined : containerKey(charge.container);
  let entry = t.cookieDetails.get(key);
  if (entry === undefined) {
    if (!counted && !inContainer && t.cookieDetails.size >= COOKIE_DETAIL_CAP) return;
    entry = newCookieDetail(obs, cookie, writtenIn);
    t.cookieDetails.set(key, entry);
  }
  entry.expiresMs = cookie.expiresMs;
  entry.sameSite = cookie.sameSite;
  entry.secure = cookie.secure;
  entry.partitioned = cookie.partitioned;
  entry.via = cookie.via;
  // A set on a request that was observed: the key is no longer known only from a lost one.
  delete entry.requestLost;
  if (obs.isRedirectHop) entry.onRedirect = true;
  if (signedCounted) {
    if (entry.firstSignedObservationId === null) {
      entry.firstSignedObservationId = obs.id;
      entry.host = hostOf(obs.url);
      if (writtenIn === undefined) delete entry.container;
      else entry.container = writtenIn;
    }
    if (obs.isRedirectHop) entry.onRedirectSigned = true;
  }
}

// ---------------------------------------------------------------------------
// One summary per company and category (1.20.0)
// ---------------------------------------------------------------------------

/** Whether a classification is a company in a category: third party, and named. */
/** A key's first detail, from the set that made it; `writtenIn` is the writer's container. */
function newCookieDetail(obs: NetworkObservation, cookie: CookieRecord, writtenIn: string | undefined): MutableCookieDetail {
  return {
    expiresMs: cookie.expiresMs,
    sameSite: cookie.sameSite,
    secure: cookie.secure,
    partitioned: cookie.partitioned,
    via: cookie.via,
    host: hostOf(obs.url),
    onRedirect: false,
    onRedirectSigned: false,
    firstSignedObservationId: null,
    ...(writtenIn === undefined ? {} : { container: writtenIn }),
  };
}

/** Add a key to a capped list: true when the list holds it, false when it was full. */
function keepKey(keys: Set<string>, key: string, cap: number): boolean {
  if (keys.has(key)) return true;
  if (keys.size >= cap) return false;
  keys.add(key);
  return true;
}

function isPair(cls: TallyClassification): cls is TallyClassification & { entityName: string } {
  return cls.party === "third" && cls.entityName !== null;
}

function pairOf(t: MutableTallies, entity: string, category: string): MutablePairTally {
  const key = entityCategoryKey(entity, category);
  const existing = t.byEntityCategory.get(key);
  if (existing) return existing;
  const fresh: MutablePairTally = {
    entity,
    category,
    requests: 0,
    signedRequests: 0,
    hosts: new Set(),
    resourceTypes: new Set(),
    scriptRan: false,
    cookieKeys: new Set(),
    cookieKeysUnsigned: new Set(),
    cookiesReturned: new Set(),
    probeCookies: new Set(),
    refusedWrites: new Set(),
    firstObservationId: null,
    executionObservationId: null,
    scriptRanOutsideXhr: false,
    cookieKeysRequestLost: new Set(),
    requestLostCapped: false,
  };
  t.byEntityCategory.set(key, fresh);
  return fresh;
}

/**
 * The names of the cookies a company set from one category's domains. For a counting
 * category they are read from the counted keys, each under the company and category that
 * first set it, so a summary never holds a second record of what the headline counts.
 */
function namesSetBy(t: MutableTallies, pair: MutablePairTally): Set<string> {
  const names = new Set<string>();
  const add = (key: string): void => {
    names.add(key.slice(0, key.indexOf("\u0000")));
  };
  if (COUNTING_CATEGORIES.has(pair.category)) {
    for (const key of [...t.adCookieKeys, ...t.adCookieKeysUnsigned]) {
      if (t.adCookieEntities.get(key) === pair.entity && t.adCookieCategories.get(key) === pair.category) add(key);
    }
  } else {
    for (const key of pair.cookieKeys) add(key);
    for (const key of pair.cookieKeysUnsigned) add(key);
  }
  // And a key known only from a lost request (1.26.0): it was set, and can be sent back.
  for (const key of pair.cookieKeysRequestLost) add(key);
  return names;
}

/** The request half of a summary. Every category; never touches a count. */
function tallyPairRequest(t: MutableTallies, obs: NetworkObservation, cls: TallyClassification): void {
  if (!isPair(cls)) return;
  const pair = pairOf(t, cls.entityName, cls.category);
  pair.requests += 1;
  if (obs.secGpcPresent) pair.signedRequests += 1;
  pair.firstObservationId ??= obs.id;
  if (obs.cookiesSent.length > 0) {
    // Only names seen SET from these domains, for the reason the per-entity rollup gives.
    const set = namesSetBy(t, pair);
    for (const name of obs.cookiesSent) if (set.has(name)) pair.cookiesReturned.add(name);
  }
  pair.resourceTypes.add(obs.resourceType);
  if (ACTIVE_RESOURCE_TYPES.has(obs.resourceType)) {
    pair.scriptRan = true;
    pair.executionObservationId ??= obs.id;
    if (obs.resourceType !== "xmlhttprequest") pair.scriptRanOutsideXhr = true;
  }
  const host = hostOf(obs.url);
  if (host !== "") pair.hosts.add(host); // an unparseable url contributes no hostname
}

/**
 * The cookie half. A key is kept here only for a category that does not count. A cookie a
 * script wrote is execution evidence for the company and category the SCRIPT came from,
 * where that is the same company.
 */
function tallyPairCookie(
  t: MutableTallies,
  cookie: CookieRecord,
  cls: TallyClassification,
  signed: boolean,
  counted: boolean,
  classifyScript: (url: string) => TallyClassification,
  obsId: string,
  charge: CookieCharge,
): void {
  if (!isPair(cls)) return;
  // Created here too, for the reason tallyCookies gives: a response that arrives before its
  // request was counted must not drop a cookie.
  const pair = pairOf(t, cls.entityName, cls.category);
  if (!counted) (signed ? pair.cookieKeys : pair.cookieKeysUnsigned).add(cookieKey(cookie));
  const writer = cookie.writerScriptUrl;
  if (charge.kind === "owner") {
    // The owner's name written inside its own container (1.25.0): its code ran, in the
    // category the list gives the name. The container's host is not the owner's, and is
    // not added to its hosts.
    pair.scriptRan = true;
    pair.scriptRanOutsideXhr = true;
    pair.firstObservationId ??= obsId;
    pair.executionObservationId ??= obsId;
    return;
  }
  if ((cookie.via === "documentCookie" || cookie.via === "cookieStore") && writer) {
    const w = classifyScript(writer);
    if (isPair(w) && w.entityName === cls.entityName) {
      // The script that ran is evidence, and where it came from is one of this company's
      // hosts in this category, as a request to it would be (1.22.0).
      const ran = pairOf(t, w.entityName, w.category);
      ran.scriptRan = true;
      ran.scriptRanOutsideXhr = true;
      ran.firstObservationId ??= obsId;
      ran.executionObservationId ??= obsId;
      const host = hostOf(writer);
      if (host !== "") ran.hosts.add(host);
    }
  }
}

/**
 * A cookie set on a response whose request was lost (1.26.0): the request went out before
 * a worker reclaim or restart, and only the response reached this worker. Kept by name, in
 * the summary of whoever set it, the counting categories' included, and never counted: not
 * in the headline, not in a company's cookies, not as signed or unsigned. A response sets a
 * cookie for its own host, so the charge is the host's; a counted domain with no company has
 * no summary to keep it in. Its detail says the request was lost, unless a set on an
 * observed request already made one; the first party's keys take no detail. Past
 * REQUEST_LOST_COOKIE_CAP the summary says its list is incomplete (`requestLostCapped`).
 */
function tallyLostCookie(t: MutableTallies, obs: NetworkObservation, cookie: CookieRecord, charge: CookieCharge): void {
  const cls = chargedTo(charge);
  if (cls === null) return;
  let summary: { cookieKeysRequestLost: Set<string>; requestLostCapped: boolean } | null = null;
  if (isPair(cls)) summary = pairOf(t, cls.entityName, cls.category);
  else {
    const unlisted = unlistedDomainOf(charge, obs.url);
    if (unlisted !== null) summary = unlistedOf(t, unlisted, true) as MutableUnlistedTally;
    else if (charge.kind === "host" && cls.party === "first") summary = t.firstParty;
  }
  if (summary === null) return;
  const key = cookieKey(cookie);
  // A full list says so, as every capped list of keys does.
  if (!keepKey(summary.cookieKeysRequestLost, key, REQUEST_LOST_COOKIE_CAP)) {
    summary.requestLostCapped = true;
    return;
  }
  if (summary === t.firstParty || t.cookieDetails.has(key)) return;
  t.cookieDetails.set(key, { ...newCookieDetail(obs, cookie, undefined), onRedirect: obs.isRedirectHop, requestLost: true });
}

/**
 * Whether a key is held by a summary: a cookie recorded in a category that does not count,
 * written inside a container (1.25.0), set from a domain with no company, or first party
 * (1.26.0).
 */
export function isRecordedKey(t: MutableTallies, key: string): boolean {
  for (const pair of t.byEntityCategory.values()) {
    if (pair.cookieKeys.has(key) || pair.cookieKeysUnsigned.has(key) || pair.cookieKeysRequestLost.has(key)) return true;
  }
  for (const c of t.byContainer.values()) {
    if (c.cookieKeys.has(key) || c.cookieKeysUnsigned.has(key)) return true;
  }
  for (const u of t.byUnlistedDomain.values()) {
    if (u.cookieKeys.has(key) || u.cookieKeysUnsigned.has(key) || u.cookieKeysRequestLost.has(key)) return true;
  }
  return isFirstPartyKey(t, key);
}

// ---------------------------------------------------------------------------
// Third-party domains the list names no company for, and the first party (1.26.0)
// ---------------------------------------------------------------------------

/**
 * The domain a charge is kept under when the list names no company for it: third party,
 * charged to a host, no company, and not counted. null for every other charge. `url` is
 * the observation's, for a charge that carries no domain of its own.
 */
function unlistedDomainOf(charge: CookieCharge, url: string): string | null {
  if (charge.kind !== "host" || charge.party !== "third" || charge.entity !== null || isCounted(charge)) return null;
  const domain = charge.domain ?? hostOf(url);
  return domain === "" ? null : domain;
}

/**
 * The domain's summary. One that only made requests is admitted while there are fewer than
 * UNLISTED_DOMAIN_CAP; one with a cookie, a probe or a refused write always is, and past the
 * cap says its earlier requests were not kept.
 */
function unlistedOf(t: MutableTallies, domain: string, always: boolean): MutableUnlistedTally | null {
  const existing = t.byUnlistedDomain.get(domain);
  if (existing) return existing;
  if (!always && t.byUnlistedDomain.size >= UNLISTED_DOMAIN_CAP) {
    t.unlistedDomainsCapped = true;
    return null;
  }
  const fresh: MutableUnlistedTally = {
    domain,
    requests: 0,
    signedRequests: 0,
    hosts: new Set(),
    resourceTypes: new Set(),
    cookieKeys: new Set(),
    cookieKeysUnsigned: new Set(),
    cookiesReturned: new Set(),
    probeCookies: new Set(),
    refusedWrites: new Set(),
    scriptRan: false,
    scriptRanOutsideXhr: false,
    firstObservationId: null,
    executionObservationId: null,
    cookieKeysRequestLost: new Set(),
    requestLostCapped: false,
    capped: false,
    requestsCapped: t.byUnlistedDomain.size >= UNLISTED_DOMAIN_CAP,
  };
  t.byUnlistedDomain.set(domain, fresh);
  return fresh;
}

/** The request half. Never touches a count. */
function tallyUnlistedRequest(t: MutableTallies, obs: NetworkObservation, cls: TallyClassification): void {
  const domain = unlistedDomainOf(hostCharge(cls), obs.url);
  if (domain === null) return;
  const u = unlistedOf(t, domain, false);
  if (u === null) return;
  u.requests += 1;
  if (obs.secGpcPresent) u.signedRequests += 1;
  u.firstObservationId ??= obs.id;
  // What vendor-signal-check judges the domain on, as a company's summary records it.
  if (ACTIVE_RESOURCE_TYPES.has(obs.resourceType)) {
    u.scriptRan = true;
    u.executionObservationId ??= obs.id;
    if (obs.resourceType !== "xmlhttprequest") u.scriptRanOutsideXhr = true;
  }
  if (obs.cookiesSent.length > 0) {
    // Only names seen SET from this domain, for the reason the per-entity rollup gives.
    const set = new Set<string>();
    for (const key of [...u.cookieKeys, ...u.cookieKeysUnsigned, ...u.cookieKeysRequestLost]) set.add(key.slice(0, key.indexOf("\u0000")));
    for (const name of obs.cookiesSent) if (set.has(name)) u.cookiesReturned.add(name);
  }
  u.resourceTypes.add(obs.resourceType);
  const host = hostOf(obs.url);
  if (host !== "" && u.hosts.size < UNLISTED_HOST_CAP) u.hosts.add(host);
}

/**
 * Keep a key set from an unlisted domain, up to UNLISTED_COOKIE_CAP each way. Returns
 * whether the summary holds it.
 */
function noteUnlistedCookie(t: MutableTallies, domain: string, cookie: CookieRecord, signed: boolean, obsId: string): boolean {
  const u = unlistedOf(t, domain, true) as MutableUnlistedTally;
  // A script that wrote a cookie made no request of its own: its host is one of the domain's,
  // and its code ran, as a company's does when its script writes one. The charge is the
  // writer's, so the writer is from this domain.
  const writer = cookie.writerScriptUrl;
  const host = typeof writer === "string" ? hostOf(writer) : "";
  if (host !== "" && u.hosts.size < UNLISTED_HOST_CAP) u.hosts.add(host);
  if ((cookie.via === "documentCookie" || cookie.via === "cookieStore") && host !== "") {
    u.scriptRan = true;
    u.scriptRanOutsideXhr = true;
    u.firstObservationId ??= obsId;
    u.executionObservationId ??= obsId;
  }
  const key = cookieKey(cookie);
  if (keepKey(signed ? u.cookieKeys : u.cookieKeysUnsigned, key, UNLISTED_COOKIE_CAP)) return true;
  u.capped = true;
  return false;
}

/**
 * Record a probe or a refused write against the unlisted domain a charge names, up to the
 * cap each vendor has. Any other charge has no such summary to go on. A refused write is a
 * script the charge names writing, so the domain's code ran, as a cookie it wrote says.
 */
export function noteForUnlisted(
  t: MutableTallies,
  charge: CookieCharge,
  kind: "probeCookies" | "refusedWrites",
  entry: string,
): void {
  const domain = unlistedDomainOf(charge, "");
  if (domain === null) return;
  const u = unlistedOf(t, domain, true) as MutableUnlistedTally;
  if (u[kind].size < PER_VENDOR_NAMES) u[kind].add(entry);
  if (kind === "refusedWrites") {
    u.scriptRan = true;
    u.scriptRanOutsideXhr = true;
  }
}

/** Keep a first-party key in one of the summary's lists, up to FIRST_PARTY_COOKIE_CAP. */
function noteFirstPartyCookie(t: MutableTallies, keys: Set<string>, key: string, signed: boolean): void {
  if (keepKey(keys, key, FIRST_PARTY_COOKIE_CAP)) return;
  if (signed) t.firstParty.capped = true;
  else t.firstParty.cappedUnsigned = true;
}

/** Whether the first-party summary holds a key (1.26.0), one known only from a lost request included. */
export function isFirstPartyKey(t: MutableTallies, key: string): boolean {
  const f = t.firstParty;
  return f.cookieKeys.has(key) || f.cookieKeysUnsigned.has(key) || f.vendorCookieKeysUnsigned.has(key) || f.cookieKeysRequestLost.has(key);
}

/** Record a first-party probe by name, up to the cap each vendor has (1.26.0). */
export function noteFirstPartyProbe(t: MutableTallies, name: string): void {
  if (t.firstParty.probeCookies.size < PER_VENDOR_NAMES) t.firstParty.probeCookies.add(name);
}

function freezeUnlisted(t: MutableTallies): Record<string, UnlistedDomainTally> {
  const out: Record<string, UnlistedDomainTally> = {};
  for (const [key, u] of [...t.byUnlistedDomain].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out[key] = {
      domain: u.domain,
      requests: u.requests,
      signedRequests: u.signedRequests,
      hosts: [...u.hosts].sort(),
      resourceTypes: [...u.resourceTypes].sort(),
      cookieKeys: [...u.cookieKeys].sort(),
      cookieKeysUnsigned: [...u.cookieKeysUnsigned].sort(),
      cookiesReturned: [...u.cookiesReturned].sort(),
      probeCookies: [...u.probeCookies].sort(),
      refusedWrites: [...u.refusedWrites].sort(),
      scriptRan: u.scriptRan,
      scriptRanOutsideXhr: u.scriptRanOutsideXhr,
      firstObservationId: u.firstObservationId,
      executionObservationId: u.executionObservationId,
      ...(u.cookieKeysRequestLost.size > 0 ? { cookieKeysRequestLost: [...u.cookieKeysRequestLost].sort() } : {}),
      ...(u.requestLostCapped ? { requestLostCapped: true as const } : {}),
      ...(u.capped ? { capped: true as const } : {}),
      ...(u.requestsCapped ? { requestsCapped: true as const } : {}),
    };
  }
  return out;
}

/** A tally stored before 1.26.0 has no such summaries, and thaws with none. */
function thawUnlisted(rec: Tallies["byUnlistedDomain"]): Map<string, MutableUnlistedTally> {
  const out = new Map<string, MutableUnlistedTally>();
  for (const [key, u] of Object.entries(rec ?? {})) {
    out.set(key, {
      domain: u.domain,
      requests: u.requests,
      signedRequests: u.signedRequests,
      hosts: new Set(u.hosts),
      resourceTypes: new Set(u.resourceTypes),
      cookieKeys: new Set(u.cookieKeys),
      cookieKeysUnsigned: new Set(u.cookieKeysUnsigned),
      cookiesReturned: new Set(u.cookiesReturned),
      probeCookies: new Set(u.probeCookies),
      refusedWrites: new Set(u.refusedWrites),
      // Stored by a build of 1.26.0 from before these were kept: judged from what comes next.
      scriptRan: u.scriptRan === true,
      scriptRanOutsideXhr: u.scriptRanOutsideXhr === true,
      firstObservationId: u.firstObservationId ?? null,
      executionObservationId: u.executionObservationId ?? null,
      cookieKeysRequestLost: new Set(u.cookieKeysRequestLost ?? []),
      requestLostCapped: u.requestLostCapped === true,
      capped: u.capped === true,
      requestsCapped: u.requestsCapped === true,
    });
  }
  return out;
}

function freezeFirstParty(f: MutableFirstPartyTally): FirstPartyTally {
  return {
    cookieKeys: [...f.cookieKeys].sort(),
    cookieKeysUnsigned: [...f.cookieKeysUnsigned].sort(),
    vendorCookieKeysUnsigned: [...f.vendorCookieKeysUnsigned].sort(),
    ...(f.probeCookies.size > 0 ? { probeCookies: [...f.probeCookies].sort() } : {}),
    ...(f.cookieKeysRequestLost.size > 0 ? { cookieKeysRequestLost: [...f.cookieKeysRequestLost].sort() } : {}),
    ...(f.requestLostCapped ? { requestLostCapped: true as const } : {}),
    ...(f.capped ? { capped: true as const } : {}),
    ...(f.cappedUnsigned ? { cappedUnsigned: true as const } : {}),
  };
}

/** A tally stored before 1.26.0 has no first-party summary, and thaws with an empty one. */
function thawFirstParty(f: Tallies["firstParty"]): MutableFirstPartyTally {
  if (f === undefined) return emptyFirstParty();
  return {
    cookieKeys: new Set(f.cookieKeys),
    cookieKeysUnsigned: new Set(f.cookieKeysUnsigned),
    vendorCookieKeysUnsigned: new Set(f.vendorCookieKeysUnsigned),
    probeCookies: new Set(f.probeCookies ?? []),
    cookieKeysRequestLost: new Set(f.cookieKeysRequestLost ?? []),
    requestLostCapped: f.requestLostCapped === true,
    capped: f.capped === true,
    cappedUnsigned: f.cappedUnsigned === true,
  };
}

// ---------------------------------------------------------------------------
// What was written inside each container (1.25.0)
// ---------------------------------------------------------------------------

function containerOf(t: MutableTallies, identity: ContainerIdentity): MutableContainerTally {
  const key = containerKey(identity);
  const existing = t.byContainer.get(key);
  if (existing) return existing;
  const fresh: MutableContainerTally = {
    manager: identity.manager,
    id: identity.id,
    frameUrls: [],
    cookieKeys: new Set(),
    cookieKeysUnsigned: new Set(),
    probeCookies: new Set(),
    refusedWrites: new Set(),
    capped: false,
  };
  t.byContainer.set(key, fresh);
  return fresh;
}

/**
 * Keep a key written inside a container, counted or not, up to CONTAINER_COOKIE_CAP each
 * way. Returns whether the summary holds it.
 */
function noteContainerCookie(t: MutableTallies, identity: ContainerIdentity, cookie: CookieRecord, signed: boolean): boolean {
  const c = containerOf(t, identity);
  const url = cookie.writerScriptUrl;
  if (typeof url === "string" && !c.frameUrls.includes(url) && c.frameUrls.length < CONTAINER_FRAME_URL_CAP) c.frameUrls.push(url);
  const key = cookieKey(cookie);
  const keys = signed ? c.cookieKeys : c.cookieKeysUnsigned;
  if (keys.has(key)) return true;
  if (keys.size >= CONTAINER_COOKIE_CAP) {
    c.capped = true;
    return false;
  }
  keys.add(key);
  return true;
}

/**
 * Record a probe or a refused write against a container, up to the cap each vendor has.
 * A write inside a container is noted there whoever it is charged to.
 */
export function noteForContainer(
  t: MutableTallies,
  identity: ContainerIdentity,
  kind: "probeCookies" | "refusedWrites",
  entry: string,
): void {
  const set = containerOf(t, identity)[kind];
  if (set.size < PER_VENDOR_NAMES) set.add(entry);
}

function freezeContainers(t: MutableTallies): Record<string, ContainerTally> {
  const out: Record<string, ContainerTally> = {};
  for (const [key, c] of [...t.byContainer].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out[key] = {
      manager: c.manager,
      id: c.id,
      frameUrls: [...c.frameUrls],
      cookieKeys: [...c.cookieKeys].sort(),
      cookieKeysUnsigned: [...c.cookieKeysUnsigned].sort(),
      probeCookies: [...c.probeCookies].sort(),
      refusedWrites: [...c.refusedWrites].sort(),
      ...(c.capped ? { capped: true as const } : {}),
    };
  }
  return out;
}

/** A tally stored before 1.25.0 has no container summaries, and thaws with none. */
function thawContainers(rec: Tallies["byContainer"]): Map<string, MutableContainerTally> {
  const out = new Map<string, MutableContainerTally>();
  for (const [key, c] of Object.entries(rec ?? {})) {
    out.set(key, {
      manager: c.manager,
      id: c.id,
      frameUrls: [...c.frameUrls],
      cookieKeys: new Set(c.cookieKeys),
      cookieKeysUnsigned: new Set(c.cookieKeysUnsigned),
      probeCookies: new Set(c.probeCookies),
      refusedWrites: new Set(c.refusedWrites),
      capped: c.capped === true,
    });
  }
  return out;
}

/**
 * Record a probe or a refused write against a company and category, up to the cap each
 * vendor has. Third party and named only; anything else has no summary to go on.
 */
export function noteForPair(
  t: MutableTallies,
  cls: TallyClassification,
  kind: "probeCookies" | "refusedWrites",
  entry: string,
): void {
  if (!isPair(cls)) return;
  const set = pairOf(t, cls.entityName, cls.category)[kind];
  if (set.size < PER_VENDOR_NAMES) set.add(entry);
}

function freezePairs(t: MutableTallies): Record<string, EntityCategoryTally> {
  const out: Record<string, EntityCategoryTally> = {};
  for (const [key, p] of [...t.byEntityCategory].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out[key] = {
      entity: p.entity,
      category: p.category,
      requests: p.requests,
      signedRequests: p.signedRequests,
      hosts: [...p.hosts].sort(),
      resourceTypes: [...p.resourceTypes].sort(),
      scriptRan: p.scriptRan,
      cookieKeys: [...p.cookieKeys].sort(),
      cookieKeysUnsigned: [...p.cookieKeysUnsigned].sort(),
      cookiesReturned: [...p.cookiesReturned].sort(),
      probeCookies: [...p.probeCookies].sort(),
      refusedWrites: [...p.refusedWrites].sort(),
      firstObservationId: p.firstObservationId,
      executionObservationId: p.executionObservationId,
      scriptRanOutsideXhr: p.scriptRanOutsideXhr,
      ...(p.cookieKeysRequestLost.size > 0 ? { cookieKeysRequestLost: [...p.cookieKeysRequestLost].sort() } : {}),
      ...(p.requestLostCapped ? { requestLostCapped: true as const } : {}),
    };
  }
  return out;
}

/** A tally stored before 1.20.0 has no summaries, and thaws with none. */
function thawPairs(rec: Tallies["byEntityCategory"]): Map<string, MutablePairTally> {
  const out = new Map<string, MutablePairTally>();
  for (const [key, p] of Object.entries(rec ?? {})) {
    out.set(key, {
      entity: p.entity,
      category: p.category,
      requests: p.requests,
      signedRequests: p.signedRequests,
      hosts: new Set(p.hosts),
      resourceTypes: new Set(p.resourceTypes),
      scriptRan: p.scriptRan,
      cookieKeys: new Set(p.cookieKeys),
      cookieKeysUnsigned: new Set(p.cookieKeysUnsigned),
      cookiesReturned: new Set(p.cookiesReturned),
      probeCookies: new Set(p.probeCookies),
      refusedWrites: new Set(p.refusedWrites),
      firstObservationId: p.firstObservationId ?? null,
      executionObservationId: p.executionObservationId ?? null,
      scriptRanOutsideXhr: p.scriptRanOutsideXhr ?? false,
      cookieKeysRequestLost: new Set(p.cookieKeysRequestLost ?? []),
      requestLostCapped: p.requestLostCapped === true,
    });
  }
  return out;
}

/** Convert to the schema's readonly shape, with stable ordering for determinism. */
export function freezeTallies(t: MutableTallies): Tallies {
  const byEntity: Record<string, EntityTally> = {};
  for (const [name, e] of [...t.byEntity].sort(([a], [b]) => (a < b ? -1 : 1))) {
    byEntity[name] = {
      requests: e.requests,
      signedRequests: e.signedRequests,
      cookieNames: [...e.cookieNames].sort(),
      cookieNamesUnsigned: [...e.cookieNamesUnsigned].sort(),
      cookiesReturned: [...e.cookiesReturned].sort(),
      hosts: [...e.hosts].sort(),
      resourceTypes: [...e.resourceTypes].sort(),
      ...(e.scriptRan === undefined ? {} : { scriptRan: e.scriptRan }),
    };
  }
  return {
    totalRequests: t.totalRequests,
    signedRequests: t.signedRequests,
    adVendorRequests: t.adVendorRequests,
    adCookieEvents: t.adCookieEvents,
    adCookieKeys: [...t.adCookieKeys].sort(),
    adCookieEventsUnsigned: t.adCookieEventsUnsigned,
    adCookieKeysUnsigned: [...t.adCookieKeysUnsigned].sort(),
    firstPartyVendorCookieKeys: [...t.firstPartyVendorCookieKeys].sort(),
    adCookieCategories: Object.fromEntries([...t.adCookieCategories].sort(([a], [b]) => (a < b ? -1 : 1))),
    adCookieEntities: Object.fromEntries([...t.adCookieEntities].sort(([a], [b]) => (a < b ? -1 : 1))),
    adCookieCharges: { signed: listsByKey(t.adCookieCharges.signed), unsigned: listsByKey(t.adCookieCharges.unsigned) },
    probeCookies: listsByEntity(t.probeCookies),
    refusedCookieWrites: listsByEntity(t.refusedCookieWrites),
    byEntity,
    byEntityCategory: freezePairs(t),
    cookieDetails: Object.fromEntries([...t.cookieDetails].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, d]) => [k, { ...d }])),
    byContainer: freezeContainers(t),
    byUnlistedDomain: freezeUnlisted(t),
    ...(t.unlistedDomainsCapped ? { unlistedDomainsCapped: true as const } : {}),
    firstParty: freezeFirstParty(t.firstParty),
  };
}

/**
 * Rehydrate from stored form, since storage round-trips through JSON.
 *
 * Fields added after a tally was stored are read as empty: a tab left open across an
 * upgrade keeps its counts rather than crashing the worker on the first request.
 */
export function thawTallies(t: Tallies): MutableTallies {
  const byEntity = new Map<string, MutableEntityTally>();
  for (const [name, e] of Object.entries(t.byEntity)) {
    byEntity.set(name, {
      requests: e.requests,
      signedRequests: e.signedRequests,
      cookieNames: new Set(e.cookieNames),
      cookieNamesUnsigned: new Set(e.cookieNamesUnsigned ?? []),
      cookiesReturned: new Set(e.cookiesReturned ?? []),
      hosts: new Set(e.hosts),
      resourceTypes: new Set(e.resourceTypes ?? []),
      scriptRan: e.scriptRan,
    });
  }
  return {
    totalRequests: t.totalRequests,
    signedRequests: t.signedRequests,
    adVendorRequests: t.adVendorRequests,
    adCookieEvents: t.adCookieEvents,
    adCookieKeys: new Set(t.adCookieKeys),
    adCookieEventsUnsigned: t.adCookieEventsUnsigned ?? 0,
    adCookieKeysUnsigned: new Set(t.adCookieKeysUnsigned ?? []),
    firstPartyVendorCookieKeys: new Set(t.firstPartyVendorCookieKeys),
    adCookieCategories: new Map(Object.entries(t.adCookieCategories ?? {})),
    adCookieEntities: new Map(Object.entries(t.adCookieEntities ?? {})),
    adCookieCharges: thawCharges(t),
    probeCookies: setsByEntity(t.probeCookies),
    refusedCookieWrites: setsByEntity(t.refusedCookieWrites),
    byEntity,
    byEntityCategory: thawPairs(t.byEntityCategory),
    // A tally stored before 1.22.0 has none; entries start with the next set of each key.
    cookieDetails: new Map(Object.entries(t.cookieDetails ?? {}).map(([k, d]) => [k, { ...d }])),
    byContainer: thawContainers(t.byContainer),
    byUnlistedDomain: thawUnlisted(t.byUnlistedDomain),
    unlistedDomainsCapped: t.unlistedDomainsCapped === true,
    firstParty: thawFirstParty(t.firstParty),
  };
}

/**
 * The stored charges (1.37.0). A tally stored before that can only say each counted key's
 * first vendor, in the set the key is in.
 */
function thawCharges(t: Tallies): MutableTallies["adCookieCharges"] {
  const stored = t.adCookieCharges;
  if (stored !== undefined) return { signed: setsByKey(stored.signed), unsigned: setsByKey(stored.unsigned) };
  const of = (keys: readonly string[]): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>();
    for (const key of keys) {
      const entity = t.adCookieEntities?.[key];
      if (entity !== undefined) out.set(key, new Set([entity]));
    }
    return out;
  };
  return { signed: of(t.adCookieKeys), unsigned: of(t.adCookieKeysUnsigned ?? []) };
}

/** An empty tally in schema shape, for states with nothing observed. */
export function emptyTalliesFrozen(): Tallies {
  return freezeTallies(emptyTallies());
}

/**
 * Take a cookie back out of the counts: it was a probe, set and removed within moments
 * (see cookie-events.ts). The key leaves every set it could be in. Its name leaves a
 * vendor's name list only when no other counted key charged to that vendor still carries
 * that name, since two domains can hold a cookie of the same name and only one of them was
 * the probe.
 * Event counters are left alone: they count writes, and the write happened. The key also
 * leaves any summary that recorded it (per company and category, per container, per
 * unlisted domain, the first party's) and its detail.
 */
export function untallyCookie(t: MutableTallies, key: string, name: string): void {
  t.adCookieKeys.delete(key);
  t.adCookieKeysUnsigned.delete(key);
  t.firstPartyVendorCookieKeys.delete(key);
  t.adCookieCategories.delete(key);
  t.adCookieEntities.delete(key);
  t.adCookieCharges.signed.delete(key);
  t.adCookieCharges.unsigned.delete(key);
  // Per vendor: a counted key of the same name still holds the name for each vendor it was
  // charged to, and for no other. Checked across every vendor, a probe of `uid` by one would
  // keep `uid` on its list whenever another vendor had a `uid` of its own.
  const entitiesHolding = (charges: ReadonlyMap<string, ReadonlySet<string>>): Set<string> => {
    const out = new Set<string>();
    for (const [k, entities] of charges) {
      if (k.startsWith(`${name}\u0000`)) for (const e of entities) out.add(e);
    }
    return out;
  };
  const signed = entitiesHolding(t.adCookieCharges.signed);
  const unsigned = entitiesHolding(t.adCookieCharges.unsigned);
  for (const [entity, entry] of t.byEntity) {
    if (!signed.has(entity)) entry.cookieNames.delete(name);
    if (!unsigned.has(entity)) entry.cookieNamesUnsigned.delete(name);
  }
  for (const pair of t.byEntityCategory.values()) {
    pair.cookieKeys.delete(key);
    pair.cookieKeysUnsigned.delete(key);
    pair.cookieKeysRequestLost.delete(key);
  }
  for (const c of t.byContainer.values()) {
    c.cookieKeys.delete(key);
    c.cookieKeysUnsigned.delete(key);
  }
  for (const u of t.byUnlistedDomain.values()) {
    u.cookieKeys.delete(key);
    u.cookieKeysUnsigned.delete(key);
    u.cookieKeysRequestLost.delete(key);
  }
  t.firstParty.cookieKeys.delete(key);
  t.firstParty.cookieKeysUnsigned.delete(key);
  t.firstParty.vendorCookieKeysUnsigned.delete(key);
  t.firstParty.cookieKeysRequestLost.delete(key);
  t.cookieDetails.delete(key);
}

/** Names kept per vendor for probeCookies and refusedCookieWrites. */
const PER_VENDOR_NAMES = 20;

/** Record a probe or a refused write against a vendor, up to the per-vendor cap. */
export function noteForVendor(map: Map<string, Set<string>>, entity: string, entry: string): void {
  const set = map.get(entity) ?? new Set<string>();
  if (set.size < PER_VENDOR_NAMES) set.add(entry);
  map.set(entity, set);
}

function listsByEntity(map: Map<string, Set<string>>): Record<string, string[]> {
  return Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : 1)).map(([e, s]) => [e, [...s].sort()]));
}

function setsByEntity(rec: Readonly<Record<string, readonly string[]>> | undefined): Map<string, Set<string>> {
  return new Map(Object.entries(rec ?? {}).map(([e, names]) => [e, new Set(names)]));
}

/** A key's vendors, sorted, by key in order, so a stored tally reads the same whatever the order of charges. */
function listsByKey(charges: ReadonlyMap<string, ReadonlySet<string>>): Record<string, string[]> {
  return Object.fromEntries([...charges].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, entities]) => [k, [...entities].sort()]));
}

function setsByKey(rec: Readonly<Record<string, readonly string[]>>): Map<string, Set<string>> {
  return new Map(Object.entries(rec).map(([k, entities]) => [k, new Set(entities)]));
}
