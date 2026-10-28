// SPDX-License-Identifier: GPL-3.0-only
/**
 * Extracting the strings a site broadcasts to its advertising vendors
 * (PRD FR-12, FR-13, FR-15).
 *
 * Pure functions: data in, schema shapes out. No DOM, no chrome.*, so every branch is
 * testable in Node — which matters because this is where the flagship finding's inputs
 * come from, and a decoding mistake here would produce a confident, wrong accusation.
 *
 * We do NOT decode the raw GPP base64 string ourselves. The CMP's own API returns the
 * parsed sections, and asking it is both more reliable and more defensible: the values we
 * report are the values the CMP itself says it is broadcasting. Rolling our own base64
 * section decoder would mean any disagreement becomes an argument about our decoder
 * rather than about the site's behavior.
 */

import type {
  GppObservation,
  GppSectionFields,
  UsPrivacyObservation,
  TcfObservation,
  GtmObservation,
  GtmConsentState,
  ConsentValue,
  EffectiveConsentEntry,
  InvalidWireValue,
  WireValue,
} from "@gpc-inspector/schema";
import { containerIdentity } from "@gpc-inspector/schema";

/** Shape the CMP returns from __gpp('getGPPData') / ping, loosely typed on purpose. */
interface GppPayload {
  gppString?: unknown;
  gppVersion?: unknown;
  applicableSections?: unknown;
  parsedSections?: unknown;
  supportedAPIs?: unknown;
}

const NUMERIC_FIELDS = [
  "Gpc",
  "SaleOptOut",
  "SharingOptOut",
  "TargetedAdvertisingOptOut",
  "MspaCoveredTransaction",
  "MspaServiceProviderMode",
  "MspaOptOutOptionMode",
  "SaleOptOutNotice",
  "SharingOptOutNotice",
  "TargetedAdvertisingOptOutNotice",
] as const;

/**
 * Unwrap the several shapes a __gpp callback can deliver.
 *
 * The GPP CMP API returns different payloads per command. Observed traffic on a real news
 * site had 8 __gpp calls, and handling only one shape gets no data from any of them:
 *
 *   getGPPData      -> { gppString, parsedSections, applicableSections, ... }
 *   ping            -> { gppVersion, applicableSections, signalStatus, ... } (no string)
 *   addEventListener-> { eventName, listenerId, data, pingData: { ...ping fields } }
 *
 * The addEventListener form is the common one for CMPs that push updates, and its payload
 * is nested. Returning the outer event object would silently yield an empty observation.
 */
function unwrapGppPayload(payload: unknown): GppPayload | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  // addEventListener event: prefer the nested ping/data payload when present.
  const nested = p["pingData"] ?? p["data"];
  if (nested && typeof nested === "object") {
    const n = nested as Record<string, unknown>;
    // Merge: the event's own fields plus the nested ones, nested winning.
    return { ...p, ...n } as GppPayload;
  }

  return p as GppPayload;
}

/**
 * Build a GppObservation from whatever the CMP handed back.
 *
 * Returns `unparseable: true` with the raw string preserved when the payload cannot be
 * understood. Recording the raw string and refusing to guess is the required behavior
 * (PRD §8): a half-decoded section could invent a conflict that isn't there.
 */
export function toGppObservation(payload: unknown): GppObservation | null {
  const p = unwrapGppPayload(payload);
  if (p === null) return null;

  const rawString = typeof p.gppString === "string" ? p.gppString : "";
  const gppVersion =
    typeof p.gppVersion === "string"
      ? p.gppVersion
      : typeof p.gppVersion === "number"
        ? String(p.gppVersion)
        : null;

  const applicableSections = Array.isArray(p.applicableSections)
    ? p.applicableSections.filter((n): n is number => typeof n === "number")
    : [];

  const sections: Record<string, GppSectionFields> = {};
  let sawSection = false;

  if (p.parsedSections && typeof p.parsedSections === "object") {
    for (const [name, value] of Object.entries(p.parsedSections as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      // A section is one object, or an ARRAY of segment objects: the IAB reference
      // decoder splits the US sections into a core segment and an optional GPC segment
      // (`SubsectionType: 1, Gpc`), and a CMP that passes that through delivers an array.
      // Reading field names off the array finds nothing, and the section would count as
      // present with no fields, so every object in it is read.
      const segments = (Array.isArray(value) ? value : [value]).filter(
        (seg): seg is Record<string, unknown> => !!seg && typeof seg === "object" && !Array.isArray(seg),
      );
      const fields: Record<string, number> = {};
      for (const src of segments) {
        for (const key of NUMERIC_FIELDS) {
          const v = src[key];
          if (typeof v === "number") fields[key] = v;
          // Gpc is a flag, and the decoder represents it as a boolean; OneTrust on sports-a.example
          // delivers `Gpc: true` (verified 2026-09-17). Read as a number it is undefined,
          // so a string that records the signal would show as "no GPC field", every vendor
          // that called __gpp would show "Read GPP, GPC not set", and the GPP conflict rule
          // (Gpc = 1 beside did-not-opt-out) could never fire. Strings stay rejected: "1" is
          // not a decoded value.
          else if (key === "Gpc" && typeof v === "boolean") fields[key] = v ? 1 : 0;
        }
      }
      // A section with no numeric fields we recognize is still recorded, so its presence
      // is visible even when its contents are not useful to us.
      sections[name] = fields as GppSectionFields;
      sawSection = true;
    }
  }

  const unparseable = rawString !== "" && !sawSection && applicableSections.length === 0;

  return { rawString, applicableSections, gppVersion, sections, unparseable, fromWire: null };
}

/**
 * Merge a newly-observed GPP payload into what we already have.
 *
 * A CMP emits several payloads per page: a ping with applicableSections but no string,
 * then getGPPData with the string and parsed sections. Replacing wholesale would let a
 * later, sparser payload erase richer earlier data — so each field is kept when the new
 * payload does not carry it. Sections are merged by name, new winning.
 */
export function mergeGpp(
  existing: GppObservation | null,
  incoming: GppObservation | null,
): GppObservation | null {
  if (!incoming) return existing;
  if (!existing) return incoming;

  const sections = { ...existing.sections };
  for (const [name, fields] of Object.entries(incoming.sections)) {
    sections[name] = { ...(existing.sections[name] ?? {}), ...fields };
  }

  const rawString = incoming.rawString || existing.rawString;
  const merged: GppObservation = {
    // What only the wire path records (the host, the invalid values, every value seen) is
    // kept: listing the fields one by one would drop them whenever a __gpp payload arrives
    // after a request has carried a string.
    ...existing,
    rawString,
    applicableSections:
      incoming.applicableSections.length > 0
        ? incoming.applicableSections
        : existing.applicableSections,
    gppVersion: incoming.gppVersion ?? existing.gppVersion,
    sections,
    // Only unparseable if we have a string and still no sections after merging.
    unparseable: false,
    // incoming always arrives via the __gpp callback path (toGppObservation), which never
    // sets fromWire — so this only ever preserves whatever mergeGppWire already recorded,
    // the same "don't erase a known surface with an unrelated payload" rule as mergeGpp's
    // other fields.
    fromWire: incoming.fromWire ?? existing.fromWire,
    // The page's string changed: what requests carried before it matched what the page said
    // then, so the comparison starts over (see WireValue).
    ...(existing.rawString !== "" && rawString !== existing.rawString ? { wireValues: [] } : {}),
  };

  const hasString = merged.rawString !== "";
  const hasContent =
    Object.keys(merged.sections).length > 0 || merged.applicableSections.length > 0;
  return { ...merged, unparseable: hasString && !hasContent };
}

/** The US Privacy string as returned by __uspapi('getUSPData'). */
export function uspStringFrom(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const s = (payload as { uspString?: unknown }).uspString;
  return typeof s === "string" ? s : null;
}

/**
 * The `usprivacy` cookie from a `document.cookie` string: the first-party cookie the IAB's
 * US Privacy spec recommends the consent tool keep the string in. Null when there is none
 * or it is empty. The first one wins when several paths set it: `document.cookie` lists the
 * most specific path first, which is the one the page's own scripts read.
 */
export function uspCookieFrom(cookies: string): string | null {
  for (const pair of cookies.split(";")) {
    const i = pair.indexOf("=");
    if (i < 0 || pair.slice(0, i).trim() !== "usprivacy") continue;
    const value = pair.slice(i + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

/** Merge a newly-seen surface into the three-surface US Privacy record (FR-13). */
export function mergeUsPrivacy(
  existing: UsPrivacyObservation | null,
  surface: "api" | "cookie" | "wire",
  value: string | null,
  wireHost?: string,
): UsPrivacyObservation {
  const base: UsPrivacyObservation = existing ?? {
    fromApi: null,
    fromCookie: null,
    fromWire: null,
  };
  if (value === null) return base;
  if (surface === "wire") {
    return {
      ...base,
      fromWire: value,
      ...(wireHost !== undefined ? { fromWireHost: wireHost } : {}),
      wireValues: addWireValue(base.wireValues, value, wireHost),
    };
  }
  const next = { ...base, ...(surface === "api" ? { fromApi: value } : { fromCookie: value }) };
  // The page's own string changed, so the comparison starts over (see WireValue). Changed
  // means the surface the page's string is read from reported a new value: the API's, else
  // the cookie's while the API has not answered. A stale cookie catching up with an API that
  // has not changed is not a change, and nor is the API's first answer after the cookie was
  // read at document_start: that is the page's string arriving, and what requests carried
  // before it is still set against it.
  const changed =
    surface === "api"
      ? base.fromApi !== null && value !== base.fromApi
      : base.fromApi === null && base.fromCookie !== null && value !== base.fromCookie;
  return changed ? { ...next, wireValues: [] } : next;
}

/** Distinct valid values kept per string, and hosts kept per value. */
export const MAX_WIRE_VALUES = 5;
const MAX_WIRE_HOSTS = 5;

/**
 * Add a valid wire value to the list, or its host to the value already there. A value past
 * the cap is dropped: with five distinct values kept, at most one of them matches the page,
 * so a disagreement is already on record.
 */
function addWireValue(list: readonly WireValue[] | undefined, value: string, host: string | undefined): readonly WireValue[] {
  const current = list ?? [];
  const hosts = host === undefined ? [] : [host];
  const i = current.findIndex((w) => w.value === value);
  if (i < 0) return current.length >= MAX_WIRE_VALUES ? current : [...current, { value, hosts }];
  const existing = current[i] as WireValue;
  if (host === undefined || existing.hosts.includes(host) || existing.hosts.length >= MAX_WIRE_HOSTS) return current;
  return current.map((w, j) => (j === i ? { ...w, hosts: [...w.hosts, host] } : w));
}

/** Extract the `us_privacy` query parameter from an outbound request URL (FR-13). */
export function usPrivacyFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.searchParams.get("us_privacy");
  } catch {
    return null;
  }
}

/** Extract the `gpp` query parameter from an outbound request URL. Mirrors usPrivacyFromUrl. */
export function gppFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.searchParams.get("gpp");
  } catch {
    return null;
  }
}

/**
 * Merge a GPP wire observation (the `gpp=` parameter on an outbound request) into what we
 * already have. Independent of mergeGpp/the __gpp callback path — a wire read can arrive
 * before any API payload has, so it needs its own null-safe base rather than assuming
 * `existing` came from toGppObservation.
 */
export function mergeGppWire(
  existing: GppObservation | null,
  wireValue: string | null,
  wireHost?: string,
): GppObservation | null {
  if (wireValue === null) return existing;
  const base = emptyGppBase(existing);
  return {
    ...base,
    fromWire: wireValue,
    ...(wireHost !== undefined ? { fromWireHost: wireHost } : {}),
    wireValues: addWireValue(base.wireValues, wireValue, wireHost),
  };
}

function emptyGppBase(existing: GppObservation | null): GppObservation {
  return (
    existing ?? {
      rawString: "",
      applicableSections: [],
      gppVersion: null,
      sections: {},
      unparseable: false,
      fromWire: null,
    }
  );
}

// --- Privacy strings taken from outbound requests ----------------------------------
//
// A parameter on a request is whatever the tag that built the URL put there, and that is
// not always a string. news-b.example's cookie-sync URLs carried `gpp=[GPP]`, a macro the tag
// never filled in (2026-09-22); stored as the GPP string "sent to advertising domains", it
// would raise a disagreement with the page's real one. marketplace-c.example carried an empty
// `us_privacy=`, which would show as "string not readable". So values are checked first: a
// valid one is recorded, an empty one is ignored, and anything else is kept apart so the
// popup can show exactly what was sent without treating it as a string.

export type WireCheck =
  | { readonly kind: "valid"; readonly value: string }
  | { readonly kind: "invalid"; readonly value: string; readonly placeholder: boolean };

/** An unfilled template macro: `[GPP]`, `{gpp}`, `${GPP_STRING}`, `%%US_PRIVACY%%`. */
function looksLikePlaceholder(v: string): boolean {
  return /^(\[|\{|\$\{|%%)/.test(v) || /GPP|US_?PRIVACY|USP/.test(v);
}

/** A US Privacy string: version 1, then three of Y, N or -. */
export function checkUspWire(value: string | null): WireCheck | null {
  if (value === null || value.trim() === "") return null;
  if (/^1[YN-]{3}$/i.test(value)) return { kind: "valid", value };
  return { kind: "invalid", value, placeholder: looksLikePlaceholder(value) };
}

/**
 * A GPP string, by shape: the v1 header always encodes to "DB", followed by base64url,
 * with sections separated by "~". Deliberately a shape check, not a decode: whether we
 * can decode a string is a separate question the row already answers.
 */
export function checkGppWire(value: string | null): WireCheck | null {
  if (value === null || value.trim() === "") return null;
  if (/^DB[A-Za-z0-9_-]*(~[A-Za-z0-9_.-]+)*$/.test(value)) return { kind: "valid", value };
  return { kind: "invalid", value, placeholder: looksLikePlaceholder(value) };
}

/** Distinct invalid values kept per string, and hosts kept per value. */
export const MAX_INVALID_WIRE_VALUES = 5;
const MAX_INVALID_WIRE_HOSTS = 5;
const MAX_INVALID_WIRE_CHARS = 1024;

function addInvalidWire(
  list: readonly InvalidWireValue[] | undefined,
  check: Extract<WireCheck, { kind: "invalid" }>,
  host: string,
): readonly InvalidWireValue[] {
  const value = check.value.slice(0, MAX_INVALID_WIRE_CHARS);
  const current = list ?? [];
  const i = current.findIndex((w) => w.value === value);
  if (i < 0) {
    if (current.length >= MAX_INVALID_WIRE_VALUES) return current;
    return [...current, { value, hosts: [host], placeholder: check.placeholder }];
  }
  const existing = current[i] as InvalidWireValue;
  if (existing.hosts.includes(host) || existing.hosts.length >= MAX_INVALID_WIRE_HOSTS) return current;
  return current.map((w, j) => (j === i ? { ...w, hosts: [...w.hosts, host] } : w));
}

/** Record a `gpp=` value that is not a GPP string. Never touches fromWire. */
export function withInvalidGppWire(
  existing: GppObservation | null,
  check: Extract<WireCheck, { kind: "invalid" }>,
  host: string,
): GppObservation {
  const base = emptyGppBase(existing);
  return { ...base, invalidWire: addInvalidWire(base.invalidWire, check, host) };
}

/** Record a `us_privacy=` value that is not a US Privacy string. Never touches fromWire. */
export function withInvalidUspWire(
  existing: UsPrivacyObservation | null,
  check: Extract<WireCheck, { kind: "invalid" }>,
  host: string,
): UsPrivacyObservation {
  const base: UsPrivacyObservation = existing ?? { fromApi: null, fromCookie: null, fromWire: null };
  return { ...base, invalidWire: addInvalidWire(base.invalidWire, check, host) };
}

// --- TCF (IAB Transparency & Consent Framework) --------------------------------
//
// A GDPR mechanism, unrelated to GPC (see TcfObservation) — decoded here purely so it can
// be displayed as its own fact, never to feed a GPC finding. Like GPP, we do not parse the
// base64 tcString ourselves: getTCData's `purpose.consents` is already pre-parsed by the
// CMP, so asking it is both more reliable and more defensible than rolling our own decoder.

interface TcfPayload {
  tcString?: unknown;
  gdprApplies?: unknown;
  purpose?: { consents?: unknown };
}

/**
 * Build a TcfObservation from whatever __tcfapi handed back.
 *
 * Returns null for payloads with no tcString yet (a `ping` carries status flags but no
 * string) — there is nothing to show and nothing to merge, so unlike GPP's unparseable
 * flag there is no partial state worth recording.
 */
export function toTcfObservation(payload: unknown): TcfObservation | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as TcfPayload;

  const tcString = typeof p.tcString === "string" ? p.tcString : "";
  const gdprApplies = typeof p.gdprApplies === "boolean" ? p.gdprApplies : null;
  // No string, and the consent tool said GDPR does not apply to this visit: an answer, not
  // an absence. news-l.example, news-m.example and portal-a.example answer this way outside the EU
  // (2026-09-22), and recording nothing would make the row read "not present" as though
  // there were no TCF at all. With no string and no such answer (a ping, or a tool still
  // loading) there is still nothing to record.
  if (tcString === "") return gdprApplies === false ? { tcString: "", gdprApplies: false, purposeConsents: {} } : null;

  const purposeConsents: Record<string, boolean> = {};
  const consents =
    p.purpose && typeof p.purpose === "object"
      ? (p.purpose as Record<string, unknown>).consents
      : undefined;
  if (consents && typeof consents === "object") {
    for (const [id, v] of Object.entries(consents as Record<string, unknown>)) {
      if (typeof v === "boolean") purposeConsents[id] = v;
    }
  }

  return { tcString, gdprApplies, purposeConsents };
}

/** Merge a newly-observed TCF payload into what we already have, same shape as mergeGpp. */
export function mergeTcf(
  existing: TcfObservation | null,
  incoming: TcfObservation | null,
): TcfObservation | null {
  if (!incoming) return existing;
  if (!existing) return incoming;
  return {
    tcString: incoming.tcString || existing.tcString,
    gdprApplies: incoming.gdprApplies ?? existing.gdprApplies,
    purposeConsents: { ...existing.purposeConsents, ...incoming.purposeConsents },
  };
}

// --- Google Tag Manager (FR-15) -------------------------------------------------

function toConsentValue(v: unknown): ConsentValue {
  if (v === "granted") return "granted";
  if (v === "denied") return "denied";
  return "unspecified";
}

/**
 * Normalize one dataLayer.push() argument to a real array.
 *
 * `dataLayer.push(['consent', 'default', {...}])` arrives as a genuine array, but
 * `gtag('consent', 'default', {...})` — Google's own currently-recommended entry point —
 * forwards its `arguments` object instead, which is array-LIKE but fails `Array.isArray`.
 * consentFromDataLayerPush reads positionally (args[0], args[1], args[2]); an
 * un-normalized arguments object silently returns null there, so skipping this step misses
 * every gtag()-originated consent call specifically, while genuine dataLayer.push() calls
 * keep working — a gap invisible unless someone thinks to check which loader a site uses.
 */
export function dataLayerPushArgs(item: unknown): unknown[] | null {
  if (Array.isArray(item)) return item;
  if (item && typeof item === "object" && "length" in item) {
    return Array.from(item as ArrayLike<unknown>);
  }
  return null;
}

/**
 * Fold a `gtag('consent', 'default'|'update', {...})` dataLayer push into consent state.
 *
 * Returns null for pushes that are not consent commands. `update` overrides `default`,
 * and later updates override earlier ones, which is exactly Google's own semantics — so
 * the final state we report is what the container was actually operating under.
 */
export function consentFromDataLayerPush(
  args: unknown[],
  previous: GtmConsentState | null,
): GtmConsentState | null {
  if (args.length < 3) return null;
  if (args[0] !== "consent") return null;
  const mode = args[1];
  if (mode !== "default" && mode !== "update") return null;
  const payload = args[2];
  if (!payload || typeof payload !== "object") return null;

  const p = payload as Record<string, unknown>;
  const EMPTY: GtmConsentState = {
    ad_storage: "unspecified",
    ad_user_data: "unspecified",
    ad_personalization: "unspecified",
    analytics_storage: "unspecified",
    functionality_storage: "unspecified",
    personalization_storage: "unspecified",
    security_storage: "unspecified",
  };
  const base: GtmConsentState = previous ?? EMPTY;

  // Only keys the push actually carries are updated; the rest keep their prior value.
  // A partial update must not silently reset types the container declared earlier.
  const next = { ...base } as Record<string, ConsentValue>;
  for (const key of Object.keys(EMPTY)) {
    if (key in p) next[key] = toConsentValue(p[key]);
  }
  return next as unknown as GtmConsentState;
}

/** Detect GTM containers from the page's own globals. */
export function detectGtmContainers(win: Window & typeof globalThis): string[] {
  const holder = (win as unknown as Record<string, unknown>)["google_tag_manager"];
  if (!holder || typeof holder !== "object") return [];
  return Object.keys(holder as Record<string, unknown>).filter((k) => k.startsWith("GTM-"));
}

/**
 * dataLayer names that running Google tags report for themselves, on
 * `window.google_tag_manager`.
 *
 * A loader URL is not always readable. apparel-c.example serves Tag Manager from its own path
 * (`/fpx7k2/<token>`, no query string) with the dataLayer renamed to
 * `storeClientDataLayer` (2026-09-25), so gtmLoadersFromDocument finds no name; with
 * only `dataLayer` watched, four consent commands went unobserved there while the popup said
 * "no signals observed". Once a container or Google tag runs, it lists itself on this global
 * with the name of the array it reads, whatever path served it. Read-only: nothing on the
 * object is called or written.
 */
export function dataLayerNamesFromGtmGlobal(win: unknown): string[] {
  const names = new Set<string>();
  let holder: unknown;
  try {
    holder = (win as Record<string, unknown> | null)?.["google_tag_manager"];
  } catch {
    return [];
  }
  if (!holder || typeof holder !== "object") return [];
  let entries: unknown[];
  try {
    entries = Object.values(holder as Record<string, unknown>);
  } catch {
    return [];
  }
  for (const entry of entries) {
    try {
      if (!entry || typeof entry !== "object") continue;
      const dl = (entry as Record<string, unknown>)["dataLayer"];
      if (!dl || typeof dl !== "object") continue;
      const name = (dl as Record<string, unknown>)["name"];
      // A global name, nothing else: this becomes a property watched on window.
      if (typeof name === "string" && /^[A-Za-z_$][\w$]{0,99}$/.test(name)) names.add(name);
    } catch {
      /* an entry that throws on read is skipped, never guessed at */
    }
  }
  return [...names];
}

/**
 * Container ids and dataLayer names taken from the GTM loader URLs in the document.
 *
 * GTM's loader accepts `l=` to RENAME the dataLayer global — observed in the wild as
 * `gtm.js?id=GTM-XNWF100&l=NF2DL`, which means `window.dataLayer` does not exist and a
 * check for it reports "no GTM" on a page running two containers. Reading the loader URL
 * is deterministic, unlike guessing at which global looks like a dataLayer.
 */
export function gtmLoadersFromDocument(doc: Document): {
  containerIds: string[];
  gtagIds: string[];
  dataLayerNames: string[];
} {
  const containerIds = new Set<string>();
  const gtagIds = new Set<string>();
  const dataLayerNames = new Set<string>(["dataLayer"]); // the default is always a candidate

  let scripts: NodeListOf<HTMLScriptElement>;
  try {
    scripts = doc.querySelectorAll("script[src]");
  } catch {
    return { containerIds: [], gtagIds: [], dataLayerNames: [...dataLayerNames] };
  }

  for (const el of Array.from(scripts)) {
    const src = el.getAttribute("src") ?? "";
    const isContainer = src.includes("googletagmanager.com/gtm.js");
    // gtag.js loads from the same host on a different path. It is the Google tag, not a
    // container: a site can run it with no Tag Manager at all.
    const isGtag = src.includes("googletagmanager.com/gtag/js");
    if (!isContainer && !isGtag) continue;

    try {
      const u = new URL(src, doc.baseURI);
      const id = u.searchParams.get("id");
      if (id) {
        if (id.startsWith("GTM-")) containerIds.add(id);
        else gtagIds.add(id); // G-…, AW-…, DC-…, GT-…
      }
      const l = u.searchParams.get("l");
      if (l) dataLayerNames.add(l);
    } catch {
      /* malformed src; skip it rather than guess */
    }
  }

  return {
    containerIds: [...containerIds],
    gtagIds: [...gtagIds],
    dataLayerNames: [...dataLayerNames],
  };
}

/** Assemble the GTM observation. */
export function toGtmObservation(
  containerIds: readonly string[],
  gtagIds: readonly string[],
  consentMode: GtmConsentState | null,
  dataLayerPresent: boolean,
  extras: {
    readonly consentModeDefaultSetBy?: string | null;
    readonly consentModeUpdateSetBy?: string | null;
    readonly effectiveConsent?: Readonly<Record<string, EffectiveConsentEntry>> | null;
  } = {},
): GtmObservation {
  return {
    present: containerIds.length > 0 || gtagIds.length > 0 || dataLayerPresent,
    containerIds: [...containerIds],
    gtagIds: [...gtagIds],
    consentMode,
    consentModeDefaultSetBy: extras.consentModeDefaultSetBy ?? null,
    consentModeUpdateSetBy: extras.consentModeUpdateSetBy ?? null,
    effectiveConsent: extras.effectiveConsent ?? null,
  };
}

/** Which consent command a dataLayer push is, or null when it is not one. */
export function consentCommandOf(args: unknown[]): "default" | "update" | null {
  if (args.length < 3 || args[0] !== "consent") return null;
  return args[1] === "default" || args[1] === "update" ? args[1] : null;
}

/**
 * Read the page's shared consent store, `google_tag_data.ics.entries`, as it stands.
 *
 * Consent Mode state is one page-level object shared by every container and every Google
 * tag on the page (verified live 2026-09-12 on a two-container page: an update pushed
 * through one container's dataLayer landed in the object the other reads). Reading it
 * directly is the only way to see consent set from a sandboxed template, which never
 * touches the dataLayer, and it is the effective state by every route.
 *
 * It is an undocumented Google internal, so the read is guarded by a shape check and
 * returns null on any surprise or a missing store. null means "could not read", never "no
 * consent mode"; the dataLayer-derived state stands on its own either way. A store whose
 * `entries` is an object holding no usable entry returns {}: read, and nothing set (schema
 * 1.33.0). Null there would make the row say "could not be read". Keyed by arbitrary string
 * because sites add their own consent types to the same store (measured: two of five).
 * Passive: nothing is registered on the object and nothing is written.
 */
export function readEffectiveConsent(
  win: unknown,
): Readonly<Record<string, EffectiveConsentEntry>> | null {
  try {
    const gtd = (win as Record<string, unknown> | null)?.["google_tag_data"];
    if (!gtd || typeof gtd !== "object") return null;
    const ics = (gtd as Record<string, unknown>)["ics"];
    if (!ics || typeof ics !== "object") return null;
    const entries = (ics as Record<string, unknown>)["entries"];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return null;

    const out: Record<string, EffectiveConsentEntry> = {};
    for (const [type, raw] of Object.entries(entries as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      const entry: { default?: boolean; update?: boolean; implicit?: boolean } = {};
      if (typeof e["default"] === "boolean") entry.default = e["default"];
      if (typeof e["update"] === "boolean") entry.update = e["update"];
      if (typeof e["implicit"] === "boolean") entry.implicit = e["implicit"];
      if (Object.keys(entry).length === 0) continue;
      out[type] = entry;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Add containers seen on check stacks to the reported id lists.
 *
 * A frame on a stack proves the container RAN; a loader tag or a global only proves it
 * exists. The frame is also the only evidence for a container loaded in a way the loader
 * scan misses. GTM ids join `containerIds`, Google-tag ids join `gtagIds`, other managers'
 * ids are not Google's and have no list here. Order preserved, nothing removed.
 */
export function withFrameSeenContainers(
  gtm: GtmObservation,
  frameUrls: readonly string[],
): GtmObservation {
  const containerIds = [...gtm.containerIds];
  const gtagIds = [...gtm.gtagIds];
  for (const url of frameUrls) {
    const id = containerIdentity(url);
    if (!id || id.id === null) continue;
    if (id.manager === "gtm" && !containerIds.includes(id.id)) containerIds.push(id.id);
    else if (id.manager === "gtag" && !gtagIds.includes(id.id)) gtagIds.push(id.id);
  }
  if (containerIds.length === gtm.containerIds.length && gtagIds.length === gtm.gtagIds.length) {
    return gtm;
  }
  return { ...gtm, present: true, containerIds, gtagIds };
}

// --- Confirmation notice (FR-14) ------------------------------------------------

/** The evidence behind a confirmation match. */
export interface ConfirmationMatch {
  /** The matched phrase plus surrounding context, so a reader can judge it themselves. */
  readonly snippet: string;
  /** Which pattern fired, for tuning without re-deriving it from the snippet. */
  readonly patternIndex: number;
}

/**
 * Patterns for the §7025(c)(6) confirmation notice.
 *
 * Since 2026-01-01 California's regulations say a business "must display whether it has
 * processed" the opt-out preference signal "on its website" (11 CCR §7025(c)(6)); before
 * that it was "may". The wording is NOT prescribed: "Opt-Out Request Honored" follows "For
 * example", and the Agency's statement of reasons calls the subsection an example that
 * "does not reflect all factual scenarios". Colorado allows the same display (Rule 5.08(E),
 * "may") and no other state law we checked asks for one. So every site writes its own
 * phrase, and this list only knows the phrases seen on real pages or documented by a consent
 * tool as the text it shows. That is why the only claim it produces is "not detected on this
 * page", never "the site didn't show one".
 *
 * The list grows as real notices turn up that it misses. The rule for adding a phrase, and
 * what each pattern covers, are in docs/LIMITATIONS.md ("The notice is matched by its
 * wording"). Keep the two in step.
 */
const CONFIRMATION_PATTERNS = [
  /opt[- ]?out (request signal|request|preference signal|signal)s? (has been |was )?(honored|honoured|processed|received|applied)/i,
  /your opt[- ]?out (preference|request) (has been|was) (received|processed|applied)/i,
  /we (have )?(processed|received|honored|honoured) your opt[- ]?out/i,
  /global privacy control[^.]{0,60}\b(detected|received|honored|honoured|processed|applied)\b/i,
  // From the 2026-09-30 corpus run, each from a page that showed it only with the signal
  // on (retailer-i, automaker-a). New patterns go last so a recorded patternIndex keeps its meaning.
  // Both stay tied to a word that names the signal or the reader's own choice: a bare
  // "opt-out honored" or "requests are processed" also reads as policy copy.
  /\bbrowser opt[- ]?out (has been |was )?(honored|honoured|processed|received|applied)\b/i,
  /your opt[- ]?out preference choices? (are|is|have been|has been) (honored|honoured|processed|applied)\b/i,
  // "Detected" alone only counts in the past tense and right after "signal": "an opt-out
  // signal is detected" is the conditional of policy copy, not a statement about this visit.
  /\bopt[- ]?out (preference )?signal (was|has been) detected\b/i,
  // "GPC" names the signal as directly as "opt-out signal" does, so it counts as the word
  // that ties the notice to the signal. The verb must follow it, with at most "signal",
  // "has been" or "was" between, as in pattern 4: "we honor GPC" and "GPC signals are
  // honored" are policy copy.
  /\bGPC (signal )?(has been |was )?(honored|honoured|processed|received|applied)\b/i,
  // From consent tools' documented status text and from pages that show a line only with the
  // signal on. Each is no wider than the phrasings seen, and each keeps a word that names the
  // signal or the reader's own choice.
  // "Detected" right after "GPC signal", or after "GPC enabled and": a status line, where
  // policy copy says "if a GPC signal is detected".
  /\bGPC (signal|enabled and) detected\b/i,
  /\bGPC opt[- ]?out preference (honored|honoured)\b/i,
  /\bopt[- ]?out preference signal detected and (honored|honoured)\b/i,
  // "Is honored" in the present tense ends the sentence: "we make sure the GPC signal is
  // honored" and "your opt-out preference signal is honored where required" are policy copy.
  /(?<=^|[.!?]\s+)the GPC signal is (honored|honoured)(?=[.!]|[ \t]*$)/im,
  /\byour opt[- ]?out preference signal is (honored|honoured)(?=[.!]|[ \t]*$)/im,
  /\bopt[- ]?out signal is being (honored|honoured)\b/i,
  /\byour opt[- ]?out signal is active and (being honored|being honoured|respected)\b/i,
  /\byour global privacy preferences have been applied\b/i,
  /\byour opt[- ]?out preference signal \(GPC\) has been (honored|honoured)\b/i,
  // Shown after any opt-out, the signal's included: it names the reader's own choice, which
  // pattern 1 accepts for "received", "processed" and "applied".
  /\byour opt[- ]?out preference has been (honored|honoured)\b/i,
];

/**
 * A negation never counts, for every pattern: "not" (or "never", or "n't") inside the match,
 * as in pattern 3's "Global Privacy Control ... not detected", and "no" or "not" right before
 * it on the same line, as in "No Opt-Out Preference Signal has been detected.". Consent tools
 * show such a line when the signal did not arrive.
 */
const NEGATION_IN_MATCH = /\b(not|never)\b|n't\b/i;
const NEGATION_BEFORE = /\b(no|not)[ \t]+$/i;

function isNegated(text: string, match: RegExpExecArray): boolean {
  if (NEGATION_IN_MATCH.test(match[0])) return true;
  const before = text.slice(Math.max(0, match.index - 16), match.index);
  return NEGATION_BEFORE.test(before.slice(before.lastIndexOf("\n") + 1));
}

/** Each pattern with the `g` flag, so a negated match lets the scan go on to the next one. */
const CONFIRMATION_SCANNERS = CONFIRMATION_PATTERNS.map((re) => new RegExp(re.source, re.flags + "g"));

// Deliberately NOT matched: a "Do Not Sell or Share: On" toggle. §7025(c)(6) requires the
// business to display that it PROCESSED the signal; a control's current state is not that
// statement, and treating it as one would manufacture a confirmation the site never made.
// The toggle is a separate requirement (§7026(g), a means to confirm in privacy settings),
// and a consumer can switch it on without any signal at all.

/**
 * Does this text contain something matching the required confirmation?
 *
 * MUST only be given TOP-FRAME text. Content scripts run in all frames (each frame has
 * its own navigator, so the signal must be asserted everywhere), but a confirmation
 * inside a third-party ad or CMP iframe is not the site confirming anything. Scanning all
 * frames produces a false "detected" on a page whose top-level text contains no matching
 * phrase at all: the match comes from an embedded CMP's own consent UI.
 */
export function matchesConfirmationNotice(text: string): boolean {
  return findConfirmationNotice(text) !== null;
}

/**
 * Find the confirmation notice AND return the text that matched.
 *
 * A finding must carry the artifact that produced it (PRD FR-21). For this detector that
 * is doubly true: it is the weakest signal in the product, it is the one with an explicit
 * false-positive gate, and "the site confirmed your opt-out" is a claim nobody should
 * have to take on faith. Returning the surrounding text lets a reader — or a "Looks
 * wrong" report — judge the match without re-running anything.
 */
export function findConfirmationNotice(text: string): ConfirmationMatch | null {
  if (!text) return null;
  // The whole text, however long. Until 2026-10-27 the scan stopped at 200,000 characters, and
  // a notice in the footer of a page whose text ran past that was never seen: a long feed
  // or an article with its comments passes the cap, and the footer is where many sites put
  // the notice. Each pattern is built on a literal word, so a scan is one pass over the
  // text, far cheaper than the rendered-text read that produced it.

  for (let i = 0; i < CONFIRMATION_SCANNERS.length; i++) {
    const re = CONFIRMATION_SCANNERS[i];
    if (!re) continue;
    for (const m of text.matchAll(re)) {
      if (isNegated(text, m)) continue;
      const start = Math.max(0, m.index - 90);
      const end = Math.min(text.length, m.index + m[0].length + 90);
      return {
        snippet: text.slice(start, end).replace(/\s+/g, " ").trim(),
        patternIndex: i,
      };
    }
  }
  return null;
}
