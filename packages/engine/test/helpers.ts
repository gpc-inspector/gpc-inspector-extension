// SPDX-License-Identifier: GPL-3.0-only
/**
 * Fixture helpers. Two things: a fake Classifier driven by simple domain rules (so
 * fixtures don't need the real Disconnect list), and a builder that fills an
 * ObservationSet with sane defaults so each fixture only specifies what it's testing.
 *
 * These are the scaffolding the golden corpus is built on. When a real "Looks wrong"
 * report arrives, its sanitized ObservationSet drops in as a fixture using this same
 * builder shape.
 */

import { SCHEMA_VERSION } from "@gpc-inspector/schema";
import type {
  ObservationSet,
  NetworkObservation,
  CookieRecord,
  SignalObservation,
  GppObservation,
  UsPrivacyObservation,
  TcfObservation,
  GtmObservation,
  ConsentApiCall,
  ConfirmationNoticeState,
  CaptureContext,
  WellKnownGpc,
  Tallies,
  ScriptInsertion,
  ScriptInsertionCoverage,
  CaptureCapabilities,
} from "@gpc-inspector/schema";
import type { Classifier, Classification, Category } from "../src/classifier.js";

/**
 * A fake classifier. Rules are matched in order against the URL's hostname; first match
 * wins. Each rule maps a substring to a category + entity. Anything unmatched is
 * third-party/unknown (the honest default). First-party is decided by comparing the
 * registrable domain against topSite via naive suffix logic — good enough for fixtures.
 */
export interface FakeRule {
  readonly match: string; // substring of the hostname
  readonly category: Category;
  readonly entityName?: string;
  readonly entityId?: string;
}

export function fakeClassifier(rules: readonly FakeRule[]): Classifier {
  return {
    classify(url: string, topSite: string): Classification {
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        host = "";
      }
      const registrableDomain = naiveRegistrable(host);
      const party = registrableDomain === topSite ? "first" : "third";

      for (const rule of rules) {
        if (host.includes(rule.match)) {
          return {
            party,
            category: rule.category,
            entity: rule.entityName
              ? { name: rule.entityName, id: rule.entityId ?? rule.entityName.toLowerCase() }
              : null,
            registrableDomain,
          };
        }
      }
      return { party, category: "unknown", entity: null, registrableDomain };
    },
  };
}

/** Naive eTLD+1: last two labels. Fine for fixtures (no PSL edge cases like co.uk here). */
function naiveRegistrable(host: string): string {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  return parts.slice(-2).join(".");
}

// --- ObservationSet builder ---

let idCounter = 0;
function nextId(): string {
  return `obs-${++idCounter}`;
}

export function cookie(partial: Partial<CookieRecord> & { name: string }): CookieRecord {
  return {
    value: "REDACTED",
    domain: `.${partial.name}.example`,
    path: "/",
    expiresMs: null,
    sameSite: "None",
    httpOnly: false,
    secure: true,
    partitioned: false,
    via: "onHeadersReceived",
    ...partial,
  };
}

export function consentApiCall(
  partial: Partial<ConsentApiCall> & { callerScriptUrl: string | null },
): ConsentApiCall {
  return {
    api: "__gpp",
    command: "getGPPData",
    viaTagManager: false,
    timeMs: 0,
    ...partial,
  };
}

export function request(
  partial: Partial<NetworkObservation> & { url: string },
): NetworkObservation {
  return {
    id: nextId(),
    method: "GET",
    resourceType: "image",
    initiator: null,
    secGpcPresent: true,
    cookiesSent: [],
    requestHeaders: [],
    statusCode: 200,
    responseHeaders: null,
    isRedirectHop: false,
    setCookies: [],
    captureMethod: "onHeadersReceived",
    timeMs: 0,
    ...partial,
  };
}

function defaultSignal(): SignalObservation {
  return {
    secGpcRequestCount: 1,
    totalRequestCount: 1,
    source: "this-extension",
    propertyValue: true,
    readTracking: "active",
    readCount: 1, // default: something read it, so signal-not-read does NOT fire by default
    // Default: reads were sampled and none was attributable to anyone. Deliberately not
    // null — null means "we could not attribute at all", and a fixture that says so by
    // default would make every vendor state look like it was decided under that condition.
    readsByScript: {},
    readAttribution: { sampled: 0, unattributed: 0, viaTagManager: 0 },
  };
}

function defaultGtm(): GtmObservation {
  return { present: false, containerIds: [], gtagIds: [], consentMode: null };
}

function defaultContext(): CaptureContext {
  return {
    finalUrl: "https://example.com/",
    topSite: "example.com",
    extensionVersion: "1.0.0",
    browserUserAgent: "test",
    os: "test",
    capturedAt: "2026-07-21T00:00:00.000Z",
    mode: "passive",
    incomplete: false,
  };
}

export interface BuildInput {
  readonly context?: Partial<CaptureContext>;
  readonly signal?: Partial<SignalObservation>;
  readonly network?: readonly NetworkObservation[];
  readonly consentApiCalls?: readonly ConsentApiCall[];
  readonly gpp?: GppObservation | null;
  readonly usPrivacy?: UsPrivacyObservation | null;
  readonly tcf?: TcfObservation | null;
  readonly gtm?: GtmObservation;
  readonly confirmationNotice?: ConfirmationNoticeState;
  readonly wellKnown?: WellKnownGpc | null;
  readonly tallies?: Tallies;
  /** Provenance (1.12.0). Absent by default, exactly as in a bundle recorded before it. */
  readonly scriptInsertions?: readonly ScriptInsertion[];
  readonly scriptInsertionCoverage?: ScriptInsertionCoverage | null;
  readonly requestInitiators?: readonly ScriptInsertion[];
  readonly requestInitiatorCoverage?: ScriptInsertionCoverage | null;
  readonly capabilities?: Partial<CaptureCapabilities>;
}

export function buildObservationSet(input: BuildInput = {}): ObservationSet {
  return {
    schemaVersion: SCHEMA_VERSION,
    context: { ...defaultContext(), ...input.context },
    signal: { ...defaultSignal(), ...input.signal },
    network: input.network ?? [],
    consentApiCalls: input.consentApiCalls ?? [],
    gpp: input.gpp ?? null,
    usPrivacy: input.usPrivacy ?? null,
    tcf: input.tcf ?? null,
    gtm: input.gtm ?? defaultGtm(),
    confirmationNotice: input.confirmationNotice ?? "indeterminate",
    wellKnown: input.wellKnown ?? null,
    tallies: input.tallies ?? {
      totalRequests: 0,
      signedRequests: 0,
      adVendorRequests: 0,
      adCookieEvents: 0,
      adCookieKeys: [],
      firstPartyVendorCookieKeys: [],
      byEntity: {},
    },
    capabilities: {
      documentCookie: true,
      cookieStore: true,
      gpp: true,
      uspapi: true,
      tcfapi: true,
      dataLayer: true,
      ...input.capabilities,
    },
    ...(input.scriptInsertions !== undefined ? { scriptInsertions: input.scriptInsertions } : {}),
    ...(input.scriptInsertionCoverage !== undefined
      ? { scriptInsertionCoverage: input.scriptInsertionCoverage }
      : {}),
    ...(input.requestInitiators !== undefined ? { requestInitiators: input.requestInitiators } : {}),
    ...(input.requestInitiatorCoverage !== undefined
      ? { requestInitiatorCoverage: input.requestInitiatorCoverage }
      : {}),
  };
}

/** Reset the id counter so fixtures using explicit ids stay stable across test files. */
export function resetIds(): void {
  idCounter = 0;
}
