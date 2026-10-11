// SPDX-License-Identifier: GPL-3.0-only
/**
 * Signal-side observations: what the browser sent, who set it, who read it, and what
 * the site broadcast to its vendors. These are the DOM/JS-side facts, as opposed to
 * the network-side facts in observation.ts.
 */

import type { CaptureMethod, SameSite } from "./observation.js";
import type { TagManagerKind } from "./tag-managers.js";

/**
 * Who is asserting the GPC signal (PRD FR-3, D10). Determined by source detection
 * BEFORE this extension asserts anything: header-presence probe + property descriptor
 * getter.toString(). We assert only when the answer is "none".
 */
export type SignalSource =
  | "native" // browser's own getter — getter.toString() is [native code]
  | "this-extension" // we set it
  | "other-extension" // a getter exists, isn't native, isn't ours (can't always name which)
  | "none"; // nothing sets it

/**
 * The tri-state of navigator.globalPrivacyControl (PRD FR-4). `true` = asserting,
 * `false` = supported but not enabled, absent = unsupported. We never emit `undefined`
 * where the spec wants `false`.
 */
export type PropertyValue = true | false | "absent";

/** Whether we could attach a read counter to the property (PRD FR-5, FR-10). */
export type ReadTrackingState =
  | "active" // our accessor is counting reads
  | "unavailable"; // another extension owns a non-configurable descriptor, or native non-configurable

export interface SignalObservation {
  /** Was Sec-GPC present, and on how many of how many requests. */
  readonly secGpcRequestCount: number;
  readonly totalRequestCount: number;
  /** Who set the signal. */
  readonly source: SignalSource;
  /** The observed property value. */
  readonly propertyValue: PropertyValue;
  /** Whether read counting is working. */
  readonly readTracking: ReadTrackingState;
  /**
   * How many times page scripts read navigator.globalPrivacyControl, when readTracking
   * is "active". Complete and exact — every read is counted. null when readTracking is
   * "unavailable" (PRD FR-10).
   *
   * This does NOT say that a script which never read the property never checked: the
   * property is one of two mechanisms, and a script can equally ask a CMP for the GPP
   * string. `readsByScript` and `consentApiCalls` are the two halves, and the engine's
   * per-vendor check state needs both.
   */
  readonly readCount: number | null;
  /**
   * Per calling-script read attribution. Key is the script URL from the stack; value is
   * how many SAMPLED reads resolved to it.
   *
   * Not a share of `readCount`. Stacks are captured for a bounded sample of reads, because
   * the property is read thousands of times on a heavy page and capturing a stack on every
   * one is a real cost (see capture-extension observe/read-attribution.ts). These values
   * are therefore a lower bound on how often a given script read the property, and the two
   * numbers are carried separately rather than one being scaled from the other.
   *
   * Attribution is best-effort (PRD FR-11) and can be empty even when readCount is large:
   * bundled code, inline script, and vendor code executed inside a tag-manager container
   * all resolve to something other than the vendor. Those reads are counted in
   * `readAttribution` instead and never assigned to a vendor.
   */
  readonly readsByScript: Readonly<Record<string, number>>;
  /**
   * What the sampling actually covered, so a reader is never shown an attributed subset as
   * though it were the whole. null when readTracking is "unavailable".
   */
  readonly readAttribution: ReadAttribution | null;
}

/**
 * Coverage of the read-attribution sample (PRD FR-11).
 *
 * `sampled` is the denominator for everything in `readsByScript`: without it, an empty
 * `readsByScript` cannot be told apart from "we sampled and attributed nothing", and the
 * silence would be read as a fact about the page's scripts.
 */
export interface ReadAttribution {
  /** Reads a stack was captured for. Always <= readCount. */
  readonly sampled: number;
  /** Of those, reads whose stack named nothing we could attribute (bundled, inline, eval). */
  readonly unattributed: number;
  /**
   * Of those, reads whose stack resolved into a tag-manager container.
   *
   * A separate bucket from `unattributed` because it supports a different claim: a check
   * demonstrably happened on the page and the container ran it, which is exactly the
   * evidence the engine's container states rest on. Which tag it belonged to remains
   * unknowable, so it is never folded into `readsByScript`.
   */
  readonly viaTagManager: number;
  /**
   * The same container reads split by the container frame that resolved them, keyed by
   * that frame's URL with its query kept, because the query is where the container's id
   * lives (`gtm.js?id=GTM-ABC`). Sums to `viaTagManager`. A handful of keys per page.
   *
   * Optional (1.12.0): a bundle recorded earlier has the total and no split.
   */
  readonly viaTagManagerByContainer?: Readonly<Record<string, number>>;
  /**
   * Whether read tracing thinned out on this page (1.13.0): the capture traces every read
   * up to a cap that bounds the cost on a page that polls the property, then one in
   * sixteen, then none. When true, a vendor's "no read observed" may be a read that fell
   * past the cap, and the popup says so and points at the setting that lifts it. Absent or
   * false: every read on the page was traced, or the bundle predates the field.
   */
  readonly traceCapReached?: boolean;
}

/** A single consent-API call we observed by wrapping the global (PRD FR-11). */
export type ConsentApi = "__gpp" | "__uspapi" | "__tcfapi";

export interface ConsentApiCall {
  readonly api: ConsentApi;
  /** The command string passed, if any (e.g. "getGPPData"). */
  readonly command: string | null;
  /**
   * Best-effort attribution of the calling script URL from the captured stack.
   * null when the frame resolved to a tag manager, a bundle, inline/eval code, or
   * was otherwise unattributable. Never guessed (PRD FR-11, edge cases).
   */
  readonly callerScriptUrl: string | null;
  /** True if the caller frame resolved into a tag-manager container (e.g. gtm.js). */
  readonly viaTagManager: boolean;
  /**
   * Every tag-manager frame on the call's stack, innermost first, query kept (the id is
   * in it). Non-empty whenever `viaTagManager` is true, and can be non-empty when it is
   * false: a vendor's own script called from inside a container tag records both facts,
   * the vendor checked and the container's tag is what invoked it. The first entry is the
   * container the check is counted under.
   *
   * Optional (1.12.0): an older bundle has the container's URL only in `callerScriptUrl`,
   * for container calls.
   */
  readonly containerUrls?: readonly string[];
  /** When the call was made. For a merged record (1.15.0), the FIRST of its calls. */
  readonly timeMs: number;
  /**
   * How many identical calls this record stands for (1.15.0). Calls with the same api,
   * command, caller, tag-manager flag and containers are merged at capture time: one page
   * polled `__uspapi` 20,096 times in a few minutes, and storing each call filled the
   * extension's session storage for every tab. Absent means 1, so a bundle recorded before
   * 1.15.0 reads as one record per call. Read it through `callCount`.
   */
  readonly count?: number;
  /** When the last of the merged calls was made (1.15.0). Absent means `timeMs`. */
  readonly lastTimeMs?: number;
}

/** How many calls a record stands for: `count` when merged, else 1. */
export function callCount(call: Pick<ConsentApiCall, "count">): number {
  return call.count ?? 1;
}

/**
 * Decoded GPP fields relevant to opt-out (PRD FR-12). Raw string is preserved so the
 * engine can re-derive and a skeptic can re-decode. Field values follow IAB encoding
 * (0 = N/A, 1 = opted out, 2 = did not opt out).
 */
export interface GppObservation {
  /** __gpp('getGPPData') response. */
  readonly rawString: string;
  /** Sections the SITE determined apply to this visitor (e.g. [8] for usca). A FACT. */
  readonly applicableSections: readonly number[];
  readonly gppVersion: string | null;
  /** Per-section decoded fields, keyed by section name (e.g. "usnat", "usca"). */
  readonly sections: Readonly<Record<string, GppSectionFields>>;
  /** True if the raw string could not be decoded — record raw, flag, never guess. */
  readonly unparseable: boolean;
  /**
   * gpp= parameter seen on outbound requests (the wire surface, mirroring
   * UsPrivacyObservation.fromWire below). No cookie surface: unlike US Privacy's
   * IAB-standardized `usprivacy` cookie name, GPP persistence is CMP-specific
   * (vendor-keyed localStorage, not a portable cookie), so there is no comparable
   * second page-side surface to track.
   */
  readonly fromWire: string | null;
  /** The host of the request that carried `fromWire` (1.16.0). Absent in older bundles. */
  readonly fromWireHost?: string;
  /**
   * `gpp=` values on outbound requests that are not GPP strings (1.16.0): an unfilled
   * placeholder such as `[GPP]`, or anything else that does not parse. Kept apart from
   * `fromWire` so they never feed a disagreement, and kept at all so the popup can show
   * what was sent. Absent when none were seen.
   */
  readonly invalidWire?: readonly InvalidWireValue[];
  /** Every distinct GPP string outbound requests carried (1.29.0); see WireValue. */
  readonly wireValues?: readonly WireValue[];
}

/**
 * A valid privacy string outbound requests carried, with the hosts that carried it (1.29.0).
 *
 * `fromWire` is the value on the most recent request, and a disagreement judged from it came
 * and went as requests arrived: on news-h.example (2026-09-30) Google's ad requests carried the
 * page's `1YYN` while Rubicon, Criteo, OpenX and PubMatic carried `1---`, and the notice
 * showed whenever one of the latter had sent last. Every distinct value is kept instead, first
 * seen first, so a disagreement once seen stays seen.
 *
 * The list starts over when the page's own string changes (a visitor opting out mid-visit):
 * requests sent before the change carried what the page said then, and are no disagreement
 * with what it says now. An empty list after such a change is not an absent one: a reader
 * falls back to `fromWire` only when `wireValues` is absent (a bundle from before 1.29.0).
 */
export interface WireValue {
  readonly value: string;
  /** Hosts whose requests carried it, first seen first, at most five. */
  readonly hosts: readonly string[];
}

/**
 * What requests carried, as values with hosts: every distinct one where capture kept them
 * (1.29.0), else the single most recent value an older bundle recorded.
 */
export function wireValuesOf(o: {
  readonly fromWire: string | null;
  readonly fromWireHost?: string;
  readonly wireValues?: readonly WireValue[];
}): readonly WireValue[] {
  if (o.wireValues !== undefined) return o.wireValues;
  if (o.fromWire === null) return [];
  return [{ value: o.fromWire, hosts: o.fromWireHost !== undefined ? [o.fromWireHost] : [] }];
}

/**
 * A privacy-string parameter on an outbound request that is not a valid string (1.16.0).
 *
 * Seen 2026-09-22 on news-b.example: cookie-sync URLs carrying `gpp=[GPP]`, a macro the ad tag
 * never filled in. Recorded once per distinct value, with the hosts that carried it, so a
 * reader sees exactly what was sent without one broken tag flooding the record.
 */
export interface InvalidWireValue {
  /** The value as sent, cut to 1,024 characters. */
  readonly value: string;
  /** Hosts whose requests carried it, first seen first, at most five. */
  readonly hosts: readonly string[];
  /** True when it looks like an unfilled template placeholder rather than a broken string. */
  readonly placeholder: boolean;
}

export interface GppSectionFields {
  readonly Gpc?: number;
  readonly SaleOptOut?: number;
  readonly SharingOptOut?: number;
  readonly TargetedAdvertisingOptOut?: number;
  /** Named MspaCoveredTransactions (plural) before 1.32.0; read through withPersistedShape. */
  readonly MspaCoveredTransaction?: number;
  readonly MspaServiceProviderMode?: number;
  readonly MspaOptOutOptionMode?: number;
  /** Any additional decoded fields, preserved verbatim. */
  readonly [field: string]: number | undefined;
}

/** US Privacy string across its three observable surfaces (PRD FR-13). */
export interface UsPrivacyObservation {
  /** __uspapi getUSPData response. */
  readonly fromApi: string | null;
  /** usprivacy cookie value. */
  readonly fromCookie: string | null;
  /** us_privacy= parameter on the most recent outbound request that carried a valid one. */
  readonly fromWire: string | null;
  /** The host of the request that carried `fromWire` (1.16.0). Absent in older bundles. */
  readonly fromWireHost?: string;
  /** `us_privacy=` values that are not US Privacy strings (1.16.0); see InvalidWireValue. */
  readonly invalidWire?: readonly InvalidWireValue[];
  /** Every distinct US Privacy string outbound requests carried (1.29.0); see WireValue. */
  readonly wireValues?: readonly WireValue[];
}

/**
 * TCF (IAB Transparency & Consent Framework) state, as returned by __tcfapi('getTCData').
 *
 * TCF is a GDPR mechanism, not a GPC one — it has no obligation relationship to the
 * signal this product inspects. It is decoded and displayed as its own, separate fact
 * (page-level context plus a purposes line where a call is attributable to a vendor),
 * never folded into a GPC finding or used to infer GPC compliance. We do not parse the
 * base64 `tcString` bitfield ourselves: getTCData's `purpose.consents` is already
 * pre-parsed by the CMP, so asking it is both more reliable and more defensible — the
 * values reported are the values the CMP itself says it granted.
 */
export interface TcfObservation {
  /** The encoded consent string, verbatim, for the external IAB decoder link. */
  readonly tcString: string;
  /** Whether the CMP indicated GDPR applies to this visitor. null when not reported. */
  readonly gdprApplies: boolean | null;
  /** Purpose id -> whether consent was granted, exactly as the CMP's own API reported it. */
  readonly purposeConsents: Readonly<Record<string, boolean>>;
}

/**
 * Google Tag Manager state (PRD FR-15). The container's Consent Mode decision is a
 * SITE-LEVEL fact observed by wrapping dataLayer.push. It NEVER decomposes into
 * per-vendor claims.
 */
/**
 * Google tag platform state (PRD FR-15).
 *
 * Three separable facts, kept separate because conflating them mislabels real sites:
 *
 *   containerIds — Google Tag Manager containers (GTM-…). Tags load through a container.
 *   gtagIds      — Google tag / gtag.js measurement IDs (G-…, AW-…, DC-…, GT-…). Tags are
 *                  loaded directly, with no container involved.
 *   consentMode  — belongs to NEITHER exclusively. Consent Mode is a tag-platform feature
 *                  reached through the global gtag() function, which pushes to the
 *                  dataLayer. A site can deploy it with gtag.js and no container at all.
 *
 * Reporting all of this as "Google Tag Manager" would label gtag.js-only sites as running a
 * container, with an ID of "unknown".
 */
export interface GtmObservation {
  readonly present: boolean;
  /** Tag Manager container IDs (e.g. ["GTM-WKX4"]). Empty when no container loads. */
  readonly containerIds: readonly string[];
  /** gtag.js measurement IDs (e.g. ["G-ABC123", "AW-456"]). Empty when gtag.js is absent. */
  readonly gtagIds: readonly string[];
  /** Consent Mode state, from either loader. null when no consent command was observed. */
  readonly consentMode: GtmConsentState | null;
  /**
   * The container frame (URL, query kept) that pushed the most recent `consent default`
   * and `consent update` command respectively. null when the push came from site code
   * (the inline default snippet is the documented placement) or could not be attributed.
   * Kept apart because `update` overrides `default` whatever the order, so one "most
   * recent" field would lose which container governs.
   *
   * Consent Mode state is one page-wide store shared by every container (verified live
   * 2026-09-12), so knowing who SET it is the only per-container fact there is about it.
   * Optional (1.12.0).
   */
  readonly consentModeDefaultSetBy?: string | null;
  readonly consentModeUpdateSetBy?: string | null;
  /**
   * The shared consent store itself, read directly from the page rather than derived
   * from dataLayer pushes. Consent set from a sandboxed template never touches the
   * dataLayer, so this is the effective state by every route. Keyed by arbitrary string:
   * sites add their own consent types beside Google's. null when the store is absent or
   * not of the expected shape, which is never reported as "no consent mode"; {} when it was
   * read and held no usable entry (1.33.0; null before). Optional (1.12.0).
   */
  readonly effectiveConsent?: Readonly<Record<string, EffectiveConsentEntry>> | null;
  /**
   * Whether a Google tag script (googletagmanager.com/gtm or /gtag) was requested
   * (1.22.0). Recorded as the request is seen, so it survives the request list being lost
   * to a worker reclaim. Absent in older bundles, whose readers scan `network` instead.
   */
  readonly scriptFetched?: boolean;
}

/**
 * One entry of the page's shared consent store. Mirrors what the store records per type:
 * whether a default was declared and what it was, whether an update was applied and what
 * it was, and whether the type is running on its implicit value because nothing declared
 * it. Only the fields the store had are present.
 */
export interface EffectiveConsentEntry {
  readonly default?: boolean;
  readonly update?: boolean;
  readonly implicit?: boolean;
}

/** Google Consent Mode signal states (PRD FR-15). */
export type ConsentValue = "granted" | "denied" | "unspecified";

/**
 * Google Consent Mode state, as documented at
 * https://support.google.com/tagmanager/answer/10718549
 *
 * Two groups, kept distinct because Google defines them distinctly:
 *   CONSENT TYPES control whether Google's tags fire and what they send.
 *   STORAGE TYPES are additional privacy parameters covering non-advertising storage.
 *
 * "unspecified" means the container never declared that type, which is a different fact
 * from declaring it denied and is displayed as such.
 */
export interface GtmConsentState {
  // Consent types
  readonly ad_storage: ConsentValue;
  readonly ad_user_data: ConsentValue;
  readonly ad_personalization: ConsentValue;
  readonly analytics_storage: ConsentValue;
  // Storage types (privacy parameters)
  readonly functionality_storage: ConsentValue;
  readonly personalization_storage: ConsentValue;
  readonly security_storage: ConsentValue;
}

/** Confirmation-notice text scan result (PRD FR-14). Only ever "not detected" as a claim. */
export type ConfirmationNoticeState =
  | "detected"
  | "not-detected" // rendered as "not found on this page — may appear elsewhere"
  | "indeterminate";

/**
 * Which capture capabilities actually installed (PRD §8 governing principle).
 *
 * Every interceptor can fail: a page may have already made `document.cookie`
 * non-configurable, another extension may own `__gpp`, a dataLayer may be frozen. When one
 * fails we observe nothing through it — and without recording that, the UI reports the
 * resulting silence as a fact about the SITE. "GPP not present" and "we could not look at
 * GPP" are different claims, and only one of them is ours to make.
 *
 * A failed session-storage write has the same shape: if every write fails and nothing
 * records it, the popup reports "GPC signal is not set" on a page where the header is being
 * sent. Nothing crashes; the extension is simply confidently wrong.
 */
export interface CaptureCapabilities {
  /** document.cookie setter interception (FR-9). */
  readonly documentCookie: boolean;
  /**
   * cookieStore.set interception (FR-9). True when the API is absent (1.35.0): it exists only
   * in secure contexts, so an http:// page has nothing to observe there. False only when it
   * exists and could not be wrapped. Before 1.35.0 an absent API read false.
   */
  readonly cookieStore: boolean;
  /** __gpp wrapping (FR-12). */
  readonly gpp: boolean;
  /** __uspapi wrapping (FR-13). */
  readonly uspapi: boolean;
  /** __tcfapi wrapping. */
  readonly tcfapi: boolean;
  /**
   * dataLayer.push wrapping for Consent Mode (FR-15). Since 1.31.0, false only when a Google
   * tag loaded, its consent store was not read, and no dataLayer it used was watched (see
   * consentModeNeedsDataLayer). A page with no Google tag has no Consent Mode to observe, and
   * one whose store was read had it observed; both read true, and before 1.31.0 read false.
   */
  readonly dataLayer: boolean;
  /**
   * The script-insertion observer (provenance, 1.12.0). false when the setting is off or
   * the prototypes could not be wrapped; absent from a bundle recorded before it existed.
   * Either way `scriptInsertions` then says nothing about the page.
   */
  readonly scriptInsertion?: boolean;
  /** The request-initiator observer (provenance); same semantics as scriptInsertion. */
  readonly requestInitiation?: boolean;
}

/**
 * A site's published GPC support resource (PRD FR-20).
 *
 * `/.well-known/gpc.json` is a voluntary public declaration: no law requires it, and over
 * half of sites do not publish one. Its ABSENCE is therefore not a finding and is not
 * displayed at all — a blank row sitting among rows where blankness is meaningful would
 * read as an accusation.
 *
 * Its presence is the cleanest observation in the product: a file the site itself
 * published, with a boolean field. No classification list, no attribution, no inference.
 *
 * The distinction between a fresh read and a cached one is load-bearing. A site can retract
 * the file at any time, so a cached value is an observation with a date rather than a
 * current fact. Display carries the date; the `declared-honor-cookie-set` finding requires
 * `fresh` to be true, because resting an accusation on a declaration that may have been
 * withdrawn is exactly the claim this product must not make.
 */
export interface WellKnownGpc {
  /**
   * The origin's `/.well-known/gpc.json` address, or, when a redirect led to a file, the
   * address the file was served from.
   */
  readonly url: string;
  /** Whether a valid GPC resource was found. */
  readonly present: boolean;
  /**
   * The declared value. `true` is a claim of support; `false` is an explicit declaration of
   * NON-support, which is a real statement and more interesting than silence. null when no
   * file was found or the field was absent.
   */
  readonly gpc: boolean | null;
  /** The `lastUpdate` field, verbatim, when present. */
  readonly lastUpdate: string | null;
  /** When this observation was made, ms since epoch. */
  readonly observedAtMs: number;
  /**
   * True when the reading is recent enough for a finding to rest on: fetched during this
   * navigation, or served from a recent cache entry (1.31.0; the capture sets the window,
   * CURRENT_READ_MS in capture-extension's well-known.ts).
   * Before 1.31.0 only the first of those counted, so a page that navigated twice while
   * loading, or the second page of a site, could never carry the declared-honor finding.
   */
  readonly fresh: boolean;
  /** Why no resource was found, when present is false. Diagnostic, never a finding. */
  readonly reason: string | null;
}

/**
 * Running tallies, maintained at capture time and never evicted (PRD FR-22, 5.6).
 *
 * A count computed by scanning the retained observation array is a function of what
 * survived eviction rather than of what happened. On a page producing 800 requests against
 * a 600 cap, the advertising-request count moved from 87 to 25 to 0 depending on which
 * retention rule was in force: three different answers to the same question, none of them
 * wrong about the data they saw and all of them wrong about the page.
 *
 * These are aggregates, so they do not need the rows they came from. They are bounded by
 * reality rather than by traffic: a page with 800 requests still has perhaps 30 distinct
 * cookies and 20 entities. They grow with distinct cookies and vendors, never with request
 * count: a few kilobytes on most pages, and about 230 bytes more per distinct cookie since
 * `cookieDetails` (1.22.0), so a page with hundreds of cookies carries tens of kilobytes.
 *
 * The resulting split is the honest one: THE TALLIES ARE COMPLETE, the request list is a
 * retained sample. Anything counted here is exact; anything enumerated from `network` may
 * have been truncated, and the UI says so where that matters.
 */
export interface Tallies {
  /** Every request observed, before any retention decision. */
  readonly totalRequests: number;
  /** Requests that carried Sec-GPC: 1. */
  readonly signedRequests: number;
  /** Third-party advertising or analytics requests — the denominator behind the counts. */
  readonly adVendorRequests: number;
  /** Set-Cookie events on signed requests to advertising domains. Counts repeats. */
  readonly adCookieEvents: number;
  /**
   * Distinct advertising cookies, keyed name + domain. This is the badge and the headline:
   * an ad slot refreshing every 30s re-sets the same cookie, and counting events measures
   * dwell time as much as site behavior.
   */
  readonly adCookieKeys: readonly string[];
  /**
   * The same two counts for requests that did NOT carry Sec-GPC. Kept apart from the
   * signed counts rather than folded in, because the two support different claims: the
   * signed count is what happened while the signal was on, the unsigned count is the
   * baseline a reader compares it against by turning the signal off and reloading. Whether
   * a site's behavior changes with the signal is one of the ways a regulator judges
   * support, and that comparison needs both numbers from the same counter.
   *
   * Optional because additive (1.11.0): a bundle recorded earlier has no such field, and a
   * reader treats its absence as zero.
   */
  readonly adCookieEventsUnsigned?: number;
  readonly adCookieKeysUnsigned?: readonly string[];
  /** Distinct first-party cookies written by attributable ad/analytics scripts. */
  readonly firstPartyVendorCookieKeys: readonly string[];
  /**
   * The category of the request that set each counted cookie key, signed or unsigned
   * (1.17.0): "advertising" or "analytics". The headline counts both, and says so; this is
   * what lets the popup show the split under it. Absent in older bundles, which then show
   * no split.
   */
  readonly adCookieCategories?: Readonly<Record<string, "advertising" | "analytics">>;
  /**
   * The vendor whose request set each counted cookie key, signed or unsigned (1.19.0). The
   * names under the headline and the vendor rows are built from these keys, so they list
   * exactly what the number counts. Absent for a key whose request had no named vendor,
   * and in older bundles, which fall back to the per-vendor name lists.
   */
  readonly adCookieEntities?: Readonly<Record<string, string>>;
  /**
   * Every vendor each counted key was charged to (1.37.0), signed and unsigned apart, so a
   * key taken out of the count takes its name off exactly the vendors that no longer hold
   * a key of that name. adCookieEntities keeps only the first vendor of a key; a key set by
   * two vendors, or by one on a signed request and another on an unsigned one, is charged
   * to each here. Absent in older bundles, which charge each key to its first vendor.
   */
  readonly adCookieCharges?: {
    readonly signed: Readonly<Record<string, readonly string[]>>;
    readonly unsigned: Readonly<Record<string, readonly string[]>>;
  };
  /**
   * Cookies each vendor's script wrote and removed again in the same task (1.18.0), by
   * name: write tests, which check whether writing works and are never counted (see the
   * capture's cookie-events). Since 1.40.0 only a write removed in the task that made it;
   * a bundle from before lists every cookie removed within five seconds of its write.
   * Keyed by entity name; at most 20 names per vendor. Absent in older bundles.
   */
  readonly probeCookies?: Readonly<Record<string, readonly string[]>>;
  /**
   * Script cookie writes the browser refused (1.18.0), as "name (domain)", keyed by the
   * entity of the script that wrote them: a Domain the page is not under, or a public
   * suffix such as .com. Never counted. At most 20 per vendor. Absent in older bundles.
   */
  readonly refusedCookieWrites?: Readonly<Record<string, readonly string[]>>;
  /** Per-entity rollup, keyed by entity name. */
  readonly byEntity: Readonly<Record<string, EntityTally>>;
  /**
   * One summary per company and category (1.20.0), keyed by `entityCategoryKey`. Every
   * category, `unknown` included, for third-party requests to a domain the list names a
   * company for. The popup lists a company once under each category it has domains in, and
   * the engine judges each of those apart, so this is the unit both read.
   *
   * It counts nothing. `byEntity` and the counted keys above are written as they were
   * before it existed: widening what is recorded must never move the headline. Absent in
   * older bundles, which have `byEntity` and one state per company.
   */
  readonly byEntityCategory?: Readonly<Record<string, EntityCategoryTally>>;
  /**
   * What is known about each recorded cookie key beyond its name and domain (1.22.0),
   * keyed by the same name + domain key: its attributes for the vendor panel, and the
   * facts the per-cookie findings are built from. Kept here so both stay the same when the
   * request list is lost to a worker reclaim.
   *
   * Every counted key (`adCookieKeys` and `adCookieKeysUnsigned`) has an entry: the
   * findings are built from the signed ones, and the headline counts one or the other. The
   * other keys get one while there are fewer than COOKIE_DETAIL_CAP entries in all; past
   * that they keep their counts and the panel shows the name alone. Holds no cookie value.
   * Absent in older bundles; the engine's withPersistedShape derives it from `network`.
   */
  readonly cookieDetails?: Readonly<Record<string, CookieDetail>>;
  /**
   * What was written inside each tag container (1.25.0), keyed by `containerKey`. A cookie
   * whose writer resolved to a container counts only when its name is the container
   * owner's own (the owner's list); every key written inside one is kept here, counted or
   * not, so a container's row can name them after the request list is lost to a worker
   * reclaim. Whether a key is counted is not stored twice: it is counted when
   * `adCookieKeys` (or `adCookieKeysUnsigned`) holds it.
   *
   * It counts nothing. Absent in older bundles; the engine's withPersistedShape derives it
   * from `network` where the requests are there.
   */
  readonly byContainer?: Readonly<Record<string, ContainerTally>>;
  /**
   * What each third-party domain the list names no company for did (1.26.0), keyed by its
   * registrable domain: the domain of the responding host, or of the writing script, never
   * the cookie's own `Domain`. No other summary keeps a cookie from such a domain: about
   * 16% of the third-party keys on the 2026-09-28 corpus. The domain may be the site's own
   * under another name, or a company the list does not carry; the record says neither.
   *
   * It counts nothing. Absent in older bundles, and not derived for them: whether a domain
   * is third party and unlisted is the list's answer, and withPersistedShape has no list.
   */
  readonly byUnlistedDomain?: Readonly<Record<string, UnlistedDomainTally>>;
  /** A domain was left out because UNLISTED_DOMAIN_CAP were held and it set no cookie. */
  readonly unlistedDomainsCapped?: true;
  /**
   * The first-party cookies (1.26.0): set by the site's own responses, or written by a
   * script and charged to the site. It counts nothing. Absent in older bundles, and not
   * derived for them, for the reason `byUnlistedDomain` gives.
   */
  readonly firstParty?: FirstPartyTally;
}

/**
 * One unlisted third-party domain's summary (1.26.0), kept as it arrives. See
 * `Tallies.byUnlistedDomain`.
 */
export interface UnlistedDomainTally {
  /** The registrable domain, as the list's suffix rules give it. */
  readonly domain: string;
  readonly requests: number;
  readonly signedRequests: number;
  /** Hostnames under the domain seen on the page. The first UNLISTED_HOST_CAP. */
  readonly hosts: readonly string[];
  /** Distinct resourceTypes Chrome reported for these requests. */
  readonly resourceTypes: readonly string[];
  /** Keys (name and domain) set from it on requests that carried the signal. */
  readonly cookieKeys: readonly string[];
  /** The same, while the signal was not on. */
  readonly cookieKeysUnsigned: readonly string[];
  /** Names of the cookies set from it that were seen going back to it. */
  readonly cookiesReturned: readonly string[];
  /** Cookies written and removed again in one task, by name. At most 20. See `probeCookies`. */
  readonly probeCookies: readonly string[];
  /** Script cookie writes the browser refused, as "name (domain)". At most 20. */
  readonly refusedWrites: readonly string[];
  /**
   * Whether code from the domain demonstrably ran, as `EntityCategoryTally.scriptRan` says
   * it for a company: a request of an active resource type, or a cookie a script from the
   * domain wrote. With the three below, what vendor-signal-check judges the domain on when
   * the requests are gone, so its Read GPC state is the same after a worker reclaim. A
   * refused write is a script from the domain writing, and says it too.
   *
   * These four are absent in a bundle stored by an early build of 1.26.0, and read as
   * false and null.
   */
  readonly scriptRan?: boolean;
  /** Whether it ran by evidence other than an XMLHttpRequest. See `EntityCategoryTally`. */
  readonly scriptRanOutsideXhr?: boolean;
  /** The first observation from the domain, and the first that showed its code running. */
  readonly firstObservationId?: string | null;
  readonly executionObservationId?: string | null;
  /** Keys set from it on a response whose request was lost. See `EntityCategoryTally`. */
  readonly cookieKeysRequestLost?: readonly string[];
  readonly requestLostCapped?: true;
  /** A key was left out because the domain already held UNLISTED_COOKIE_CAP. */
  readonly capped?: true;
  /**
   * Admitted by a cookie, a probe or a refused write once UNLISTED_DOMAIN_CAP domains were
   * held (`Tallies.unlistedDomainsCapped`): its requests before then were not kept.
   */
  readonly requestsCapped?: true;
}

/**
 * Whether an unlisted domain's summary is a row of the vendor list's last group (1.26.0): a
 * cookie, a probe or a refused write. A domain that was only contacted has no row, and
 * vendor-signal-check judges only the domains that have one.
 *
 * A cookie set on a request with or without the signal, as a company's summary gives its row
 * either way. Counting only the signed ones, a domain whose only cookies were set without the
 * signal, while it was on, would have no row, and those cookies no place on the Overview:
 * health-a-group.example's `cohsn_xs_id` on health-a.example and health-d.example, 2 of 1,447
 * third-party keys on the corpus. The row lists the signed ones, and says when there are none.
 *
 * With the signal off only the unsigned ones make a row: a cookie on a request that carried
 * the signal (sent before it was switched off) is not this visit's, and a row for it would
 * list nothing and read "no cookies set".
 *
 * `readGpc`: a script from the domain read the property or asked `__gpp` for the choice,
 * which gives a row though the domain set nothing. The tally does not hold it, so the caller
 * passes it: vendor-signal-check from the reads and calls it attributes, the popup from that
 * rule's `vendor-read-gpc` finding, which is the same fact.
 */
export function unlistedDomainHasRow(u: UnlistedDomainTally, signalOn: boolean, readGpc = false): boolean {
  return (
    readGpc ||
    (signalOn && u.cookieKeys.length > 0) ||
    u.cookieKeysUnsigned.length > 0 ||
    u.probeCookies.length > 0 ||
    u.refusedWrites.length > 0 ||
    // A cookie whose request was lost was set, whichever visit it belonged to (1.26.0).
    (u.cookieKeysRequestLost ?? []).length > 0
  );
}

/**
 * Domains kept in `Tallies.byUnlistedDomain`. The 2026-09-28 corpus had 73 such domains
 * with a cookie across all 67 pages, so the cap is far from any page measured. A domain
 * that sets a cookie is admitted past it, as a counted key is past COOKIE_DETAIL_CAP: the
 * cap bounds the domains that were only contacted.
 */
export const UNLISTED_DOMAIN_CAP = 200;

/** Keys kept per unlisted domain, signed and unsigned each. */
export const UNLISTED_COOKIE_CAP = 200;

/** Hostnames kept per unlisted domain. */
export const UNLISTED_HOST_CAP = 20;

/**
 * The first-party cookies (1.26.0). See `Tallies.firstParty`.
 *
 * First party is the charge's, as everywhere: the responding host, or the writing script's
 * host, is under the site's own registrable domain (a script with no writer found is
 * charged to the page, or to its frame's host in a cross-site frame). A cookie a
 * third-party script wrote on the site's domain is that
 * script's, and is not here.
 *
 * Two kinds, kept apart because they are different facts. A key written by a script the
 * site serves from its own domain, where the list puts that host in advertising or
 * analytics, is `firstPartyVendorCookieKeys` on signed requests, written as it was before
 * this existed, and `vendorCookieKeysUnsigned` here otherwise. Every other key is in
 * `cookieKeys` or `cookieKeysUnsigned`.
 */
export interface FirstPartyTally {
  /** Keys set on requests that carried the signal, the advertising and analytics scripts' apart. */
  readonly cookieKeys: readonly string[];
  /** The same, while the signal was not on. */
  readonly cookieKeysUnsigned: readonly string[];
  /** `firstPartyVendorCookieKeys`, while the signal was not on. */
  readonly vendorCookieKeysUnsigned: readonly string[];
  /**
   * Cookies written and removed again in one task, by name, as a vendor's `probeCookies`. At most
   * 20. Absent when there were none. The request that set one keeps it.
   */
  readonly probeCookies?: readonly string[];
  /** Keys the site set on a response whose request was lost. See `EntityCategoryTally`. */
  readonly cookieKeysRequestLost?: readonly string[];
  readonly requestLostCapped?: true;
  /** A key set on a signed request was left out because `cookieKeys` held FIRST_PARTY_COOKIE_CAP. */
  readonly capped?: true;
  /** The same, for a key set while the signal was not on, in either unsigned list. */
  readonly cappedUnsigned?: true;
}

/** Keys kept in each list of `FirstPartyTally`. */
export const FIRST_PARTY_COOKIE_CAP = 200;

/**
 * What was written inside one tag container (1.25.0), kept as it arrives. See
 * `Tallies.byContainer`.
 */
export interface ContainerTally {
  readonly manager: TagManagerKind;
  readonly id: string | null;
  /** The script URLs seen for it, query kept until redaction. The first 4. */
  readonly frameUrls: readonly string[];
  /** Keys (name and domain) set inside it on requests that carried the signal, counted or not. */
  readonly cookieKeys: readonly string[];
  /** The same, while the signal was not on. */
  readonly cookieKeysUnsigned: readonly string[];
  /** Cookies written and removed again in one task, by name. See `probeCookies`. */
  readonly probeCookies: readonly string[];
  /** Script cookie writes the browser refused, as "name (domain)". */
  readonly refusedWrites: readonly string[];
  /** A key was left out because the container already held CONTAINER_COOKIE_CAP. */
  readonly capped?: true;
}

/**
 * Keys kept per container in `ContainerTally.cookieKeys` and `cookieKeysUnsigned` each.
 * The most in the 2026-09-27 and 2026-09-28 corpus runs was 28 (one Adobe Launch
 * property), so the cap is never reached on a page anyone has measured.
 */
export const CONTAINER_COOKIE_CAP = 200;

/** Frame URLs kept per container in `ContainerTally.frameUrls`. */
export const CONTAINER_FRAME_URL_CAP = 4;

/**
 * One cookie key's detail (1.22.0). The attributes are the latest set's, since a re-set
 * replaces the cookie in the browser. See `Tallies.cookieDetails`.
 */
export interface CookieDetail {
  readonly expiresMs: number | "session" | null;
  readonly sameSite: SameSite;
  readonly secure: boolean;
  readonly partitioned: boolean;
  readonly via: CaptureMethod;
  /** Hostname of the request, or of the writing script, that set it. The first signed set's, else the first set's. */
  readonly host: string;
  /** Whether any set of it came on a redirect hop. */
  readonly onRedirect: boolean;
  /** Whether any set of it on a request that carried the signal came on a redirect hop. */
  readonly onRedirectSigned: boolean;
  /** The observation of its first set on a request that carried the signal; null if none. */
  readonly firstSignedObservationId: string | null;
  /**
   * The `containerKey` of the container its writer resolved to (1.25.0): a script-written
   * cookie whose writing script was a tag container's. The engine's cookie findings charge
   * such a key by the owner's list, not by `host`. Absent for any other cookie, and in
   * older bundles, where withPersistedShape derives it from `network`.
   */
  readonly container?: string;
  /**
   * Every set of it seen came on a response whose request was lost (1.26.0), so whether that
   * request carried the signal was not observed. Cleared by a set on an observed request.
   */
  readonly requestLost?: true;
  /**
   * The cookie was removed again (1.40.0): a later write deleted it while it was in the
   * browser, this many milliseconds after it was last set. It stays in every count and
   * summary that held it, since it was set. Cleared when the key is set again. Absent for a
   * cookie not seen removed, and in older bundles.
   */
  readonly removedAfterMs?: number;
}

/**
 * Entries in `Tallies.cookieDetails` beyond the signed counted keys, per tab.
 */
export const COOKIE_DETAIL_CAP = 1000;

/**
 * What one company did from the domains of one category (1.20.0): Microsoft from its
 * Advertising domains apart from Microsoft from its Analytics ones.
 */
export interface EntityCategoryTally {
  /** The company, as the list names it. */
  readonly entity: string;
  /** The category the list gives these domains, in the engine's names. */
  readonly category: string;
  readonly requests: number;
  readonly signedRequests: number;
  /** Hostnames of this company in this category seen on the page. */
  readonly hosts: readonly string[];
  /** Distinct resourceTypes Chrome reported for these requests. */
  readonly resourceTypes: readonly string[];
  /**
   * Whether this company's code from these domains demonstrably ran: a request of an
   * active resource type (ACTIVE_RESOURCE_TYPES), or a cookie written through
   * document.cookie or cookieStore by a script from them. `EntityTally.scriptRan`, per
   * category.
   */
  readonly scriptRan: boolean;
  /**
   * Cookie keys (name and domain) set from these domains on requests that carried the
   * signal, for the categories that do NOT count. Always empty for advertising and
   * analytics: their cookies are the counted keys in `adCookieKeys`, each with its company
   * in `adCookieEntities` and its category in `adCookieCategories`, and a row that listed
   * them from a second record could drift from the number above it.
   */
  readonly cookieKeys: readonly string[];
  /** The same, for requests that did not carry the signal. */
  readonly cookieKeysUnsigned: readonly string[];
  /** Names of the cookies set from these domains that were seen going back to them. */
  readonly cookiesReturned: readonly string[];
  /** Cookies written and removed again in one task, by name. At most 20. See `probeCookies`. */
  readonly probeCookies: readonly string[];
  /** Script cookie writes the browser refused, as "name (domain)". At most 20. */
  readonly refusedWrites: readonly string[];
  /**
   * The first observation of this company in this category, and the first that showed its
   * code running (1.22.0): what vendor-signal-check names as its artifact, so a finding
   * points at the same request before and after a worker reclaim. null when there is none.
   * Absent in older bundles; the engine's withPersistedShape derives them from `network`.
   */
  readonly firstObservationId?: string | null;
  readonly executionObservationId?: string | null;
  /**
   * Whether its code ran by evidence other than an XMLHttpRequest (1.22.0): a script request,
   * or a cookie its script wrote. vendor-signal-check reads it when
   * REQUIRE_XHR_FROM_OWN_FRAMES is on, where an XHR alone is not enough. Absent in older
   * bundles.
   */
  readonly scriptRanOutsideXhr?: boolean;
  /**
   * Keys set from these domains on a response whose request was lost (1.26.0): the request
   * went out before a worker reclaim or restart, and the response reached the next worker,
   * so whether it carried the signal was not observed. Every category, the counting ones
   * included: such a key is kept by name and never counted, in the headline or anywhere.
   * At most REQUEST_LOST_COOKIE_CAP. Absent when there were none.
   */
  readonly cookieKeysRequestLost?: readonly string[];
  /** A key was left out of `cookieKeysRequestLost` because it held REQUEST_LOST_COOKIE_CAP. */
  readonly requestLostCapped?: true;
}

/** Keys kept in each summary's `cookieKeysRequestLost`. */
export const REQUEST_LOST_COOKIE_CAP = 200;

/**
 * Whether the tallies hold anything, and so are the record the counts and findings are read
 * from rather than the request list. A request counted is not the only sign: a page whose
 * scripts wrote counted cookies and made no request the worker saw (restored from the
 * back-forward cache, say) has keys and no requests, and is as much a record as any.
 */
export function isTallied(t: Tallies): boolean {
  return (
    t.totalRequests > 0 ||
    t.adCookieKeys.length > 0 ||
    (t.adCookieKeysUnsigned ?? []).length > 0 ||
    t.firstPartyVendorCookieKeys.length > 0
  );
}

/** The key of a company and category in `Tallies.byEntityCategory`. */
export function entityCategoryKey(entity: string, category: string): string {
  return `${entity}\u0000${category}`;
}

export interface EntityTally {
  readonly requests: number;
  readonly signedRequests: number;
  /** Distinct cookie names this entity set on signed requests. */
  readonly cookieNames: readonly string[];
  /** Distinct cookie names this entity set on requests that did not carry the signal. */
  readonly cookieNamesUnsigned?: readonly string[];
  /**
   * Of those, the ones observed going BACK to this entity on a later request.
   *
   * The distinction that matters is zero versus non-zero, not how many times: an ad slot
   * refreshing returns the same identifier repeatedly, and counting that would measure
   * dwell time rather than behavior.
   */
  readonly cookiesReturned: readonly string[];
  /** Hostnames of this entity seen on the page. */
  readonly hosts: readonly string[];
  /**
   * Distinct resourceTypes Chrome reported for this entity's requests (1.13.0). Kept here
   * so the vendor panel can list them after the retained requests are gone.
   */
  readonly resourceTypes?: readonly string[];
  /**
   * Whether this entity's own code demonstrably ran (1.13.0): a request of an active
   * resource type (ACTIVE_RESOURCE_TYPES), or a cookie written through document.cookie or
   * cookieStore by a script that classifies to this same entity. The summary the engine's
   * vendor-signal-check needs when the individual requests were not retained, which is
   * what happens when the extension's worker is reclaimed while the tab stays open: the
   * tallies persist, the request list does not. Absent in a bundle recorded before 1.13.0,
   * and the engine then judges only from retained requests.
   */
  readonly scriptRan?: boolean;
}

/**
 * resourceTypes that mean "this vendor's own script executed", as opposed to a passive
 * resource (image, font, stylesheet, media, ping) merely loading from its domain. One
 * definition, used by the worker's tally (EntityTally.scriptRan) and the engine's
 * vendor-signal-check, so the two can never disagree about what counts as execution.
 */
export const ACTIVE_RESOURCE_TYPES: ReadonlySet<string> = new Set(["script", "xmlhttprequest"]);
