// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { redact, redactUrl, REDACTED } from "../src/redact.js";
import { canonicalize } from "../src/canonicalize.js";
import { sealBundle } from "../src/hash.js";
import { containerIdentity } from "../src/tag-managers.js";
import { SCHEMA_VERSION } from "../src/version.js";
import type { ObservationSet } from "../src/observation-set.js";
import type { NetworkObservation, ScriptInsertion } from "../src/observation.js";

// Values that must never appear in an export. Each is distinctive enough that a substring
// check on the canonical form is a real assertion rather than a coincidence.
const SESSION = "sess_9f8e7d6c5b4a";
const AUTH = "Bearer eyJhbGciOiJIUzI1NiJ9.secret";
const QUERY_TOKEN = "tok_31415926";
const PAGE_QUERY = "q=my+private+search";

const GTM_A = "https://www.googletagmanager.com/gtm.js?id=GTM-ABC";

function network(over: Partial<NetworkObservation> = {}): NetworkObservation {
  return {
    id: "n1",
    url: `https://ads.vendor.example/pixel?uid=${QUERY_TOKEN}#frag`,
    method: "GET",
    resourceType: "image",
    initiator: `https://www.example.com/search?${PAGE_QUERY}`,
    secGpcPresent: true,
    requestHeaders: [
      { name: "Cookie", nameLower: "cookie", value: `sid=${SESSION}; other=1` },
      { name: "Authorization", nameLower: "authorization", value: AUTH },
      { name: "Accept", nameLower: "accept", value: "*/*" },
      { name: "Referer", nameLower: "referer", value: `https://www.example.com/account?${PAGE_QUERY}#top` },
    ],
    cookiesSent: ["sid", "other"],
    statusCode: 200,
    responseHeaders: [
      { name: "Set-Cookie", nameLower: "set-cookie", value: `sid=${SESSION}; Path=/; Secure; SameSite=None` },
      { name: "Content-Type", nameLower: "content-type", value: "image/gif" },
      { name: "Location", nameLower: "location", value: `/callback?code=${QUERY_TOKEN}` },
    ],
    isRedirectHop: false,
    setCookies: [
      {
        name: "sid",
        value: SESSION,
        domain: ".vendor.example",
        path: "/",
        expiresMs: null,
        sameSite: "None",
        httpOnly: false,
        secure: true,
        partitioned: false,
        via: "onHeadersReceived",
      },
      {
        name: "js",
        value: SESSION,
        domain: ".example.com",
        path: "/",
        expiresMs: "session",
        sameSite: "Lax",
        httpOnly: false,
        secure: false,
        partitioned: false,
        via: "documentCookie",
        writerScriptUrl: `https://cdn.vendor.example/tag.js?v=${QUERY_TOKEN}`,
        writerViaTagManager: false,
        writerWrapperUrl: `https://cmp.example/osano.js?key=${QUERY_TOKEN}`,
      },
    ],
    captureMethod: "onHeadersReceived",
    timeMs: 1,
    ...over,
  };
}

function insertion(): ScriptInsertion {
  return {
    key: "https://cdn.vendor.example/tag.js",
    url: `https://cdn.vendor.example/tag.js?cb=${QUERY_TOKEN}`,
    element: "script",
    loaders: [
      {
        insertedBy: [`${GTM_A}&l=dataLayer&gtm_auth=${QUERY_TOKEN}`, `https://www.example.com/app.js?v=${QUERY_TOKEN}`],
        wrapperFrames: [`https://cmp.example/osano.js?key=${QUERY_TOKEN}`],
        inlineFrames: false,
        currentScriptKey: null,
        containerUrls: [`${GTM_A}&l=dataLayer&gtm_auth=${QUERY_TOKEN}`],
        via: "appendChild",
        frameOrigin: "https://www.example.com",
        topFrame: true,
        count: 1,
        timeMs: 2,
      },
    ],
  };
}

function observations(): ObservationSet {
  return {
    schemaVersion: SCHEMA_VERSION,
    context: {
      finalUrl: `https://www.example.com/search?${PAGE_QUERY}`,
      topSite: "example.com",
      extensionVersion: "1.0.0",
      browserUserAgent: "test",
      os: "test",
      capturedAt: "2026-09-16T00:00:00.000Z",
      mode: "passive",
      incomplete: false,
    },
    signal: {
      secGpcRequestCount: 1,
      totalRequestCount: 1,
      source: "this-extension",
      propertyValue: true,
      readTracking: "active",
      readCount: 5,
      readsByScript: {
        [`https://cdn.vendor.example/tag.js?cb=${QUERY_TOKEN}`]: 2,
        "https://cdn.vendor.example/tag.js?cb=other": 3,
      },
      readAttribution: {
        sampled: 5,
        unattributed: 0,
        viaTagManager: 5,
        // Two frames of one container that differ only in their query: one key after.
        viaTagManagerByContainer: {
          [`${GTM_A}&l=dataLayer&gtm_auth=${QUERY_TOKEN}`]: 2,
          [`${GTM_A}&gtm_preview=env-7&gtm_cookies_win=x`]: 3,
        },
      },
    },
    network: [network()],
    consentApiCalls: [
      {
        api: "__gpp",
        command: "getGPPData",
        callerScriptUrl: `https://cdn.vendor.example/tag.js?cb=${QUERY_TOKEN}`,
        viaTagManager: false,
        containerUrls: [`${GTM_A}&gtm_auth=${QUERY_TOKEN}`],
        timeMs: 3,
      },
    ],
    gpp: null,
    usPrivacy: null,
    tcf: null,
    gtm: {
      present: true,
      containerIds: ["GTM-ABC"],
      gtagIds: [],
      consentMode: null,
      consentModeDefaultSetBy: `${GTM_A}&l=dataLayer&gtm_auth=${QUERY_TOKEN}`,
      consentModeUpdateSetBy: null,
    },
    confirmationNotice: "not-detected",
    wellKnown: null,
    scriptInsertions: [insertion()],
    scriptInsertionCoverage: null,
    tallies: {
      totalRequests: 1,
      signedRequests: 1,
      adVendorRequests: 1,
      adCookieEvents: 1,
      adCookieKeys: ["sid@.vendor.example"],
      firstPartyVendorCookieKeys: [],
      byEntity: {},
      byContainer: {
        "gtm:GTM-ABC": {
          manager: "gtm",
          id: "GTM-ABC",
          frameUrls: [`${GTM_A}&l=dataLayer&gtm_auth=${QUERY_TOKEN}`],
          cookieKeys: ["nwf_byline\u0000.www.example.com"],
          cookieKeysUnsigned: [],
          probeCookies: [],
          refusedWrites: [],
        },
      },
    },
    capabilities: {
      documentCookie: true,
      cookieStore: true,
      gpp: true,
      uspapi: true,
      tcfapi: true,
      dataLayer: true,
    },
  };
}

describe("redactUrl", () => {
  it("drops the query and the fragment", () => {
    expect(redactUrl("https://v.example/a.js?cb=1#x")).toBe("https://v.example/a.js");
    expect(redactUrl("https://v.example/a.js#x?notaquery")).toBe("https://v.example/a.js");
    expect(redactUrl("https://v.example/a.js")).toBe("https://v.example/a.js");
  });

  it("keeps a tag-manager loader's id and nothing else from its query", () => {
    expect(redactUrl(`${GTM_A}&l=dataLayer&gtm_auth=${QUERY_TOKEN}`)).toBe(GTM_A);
    expect(redactUrl("https://www.googletagmanager.com/gtag/js?id=G-1&l=x")).toBe(
      "https://www.googletagmanager.com/gtag/js?id=G-1",
    );
  });

  it("gives containerIdentity the same answer before and after", () => {
    const urls = [
      `${GTM_A}&l=dataLayer`,
      "https://www.googletagmanager.com/gtag/js?id=G-1",
      "https://www.googletagmanager.com/gtm.js",
      "https://tags.tiqcdn.com/utag/acct/prof/prod/utag.js?utv=1",
      "https://assets.adobedtm.com/x/launch-abc.min.js?x=1",
      "https://cdn.segment.com/analytics.js/v1/KEY/analytics.min.js?x=1",
      "https://ads.vendor.example/pixel?uid=1",
    ];
    for (const u of urls) expect(containerIdentity(redactUrl(u))).toEqual(containerIdentity(u));
  });

  it("is idempotent", () => {
    const once = redactUrl(`${GTM_A}&l=dataLayer`);
    expect(redactUrl(once)).toBe(once);
  });
});

describe("redact", () => {
  it("leaves no cookie value, credential header or query string in the canonical form", async () => {
    const bundle = await sealBundle({
      schemaVersion: SCHEMA_VERSION,
      scanId: "00000000-0000-0000-0000-000000000000",
      createdAt: "2026-09-16T00:00:00.000Z",
      provenance: {
        schemaVersion: SCHEMA_VERSION,
        ruleSetVersion: "1.0.0",
        ruleSetHash: "",
        listSource: "disconnect",
        listVersion: "2026-09-01",
        listHash: "",
      },
      redacted: "redacted",
      observations: redact(observations()),
      findings: [],
    });
    const canonical = canonicalize(bundle);
    expect(canonical).not.toContain(SESSION);
    expect(canonical).not.toContain(AUTH);
    expect(canonical).not.toContain(QUERY_TOKEN);
    expect(canonical).not.toContain(PAGE_QUERY);
    // The unredacted input, sealed the same way, does carry every one of them. Without
    // this the assertions above would pass against a fixture that never held the values.
    const raw = canonicalize(observations());
    for (const v of [SESSION, AUTH, QUERY_TOKEN, PAGE_QUERY]) expect(raw).toContain(v);
  });

  it("masks cookie values and keeps names, domains and attributes", () => {
    const r = redact(observations());
    const net = r.network[0]!;
    expect(net.setCookies.map((c) => c.value)).toEqual([REDACTED, REDACTED]);
    expect(net.setCookies.map((c) => c.name)).toEqual(["sid", "js"]);
    expect(net.setCookies[0]).toMatchObject({ domain: ".vendor.example", sameSite: "None", secure: true });
    expect(net.setCookies[1]!.writerScriptUrl).toBe("https://cdn.vendor.example/tag.js");
    expect(net.setCookies[1]!.writerWrapperUrl).toBe("https://cmp.example/osano.js");
    expect(net.cookiesSent).toEqual(["sid", "other"]);
  });

  it("masks the Cookie and Authorization request headers and leaves the rest", () => {
    const r = redact(observations());
    expect(r.network[0]!.requestHeaders).toEqual([
      { name: "Cookie", nameLower: "cookie", value: REDACTED },
      { name: "Authorization", nameLower: "authorization", value: REDACTED },
      { name: "Accept", nameLower: "accept", value: "*/*" },
      { name: "Referer", nameLower: "referer", value: "https://www.example.com/account" },
    ]);
  });

  it("masks the Set-Cookie header's value and keeps its name and attributes", () => {
    const r = redact(observations());
    expect(r.network[0]!.responseHeaders).toEqual([
      { name: "Set-Cookie", nameLower: "set-cookie", value: `sid=${REDACTED}; Path=/; Secure; SameSite=None` },
      { name: "Content-Type", nameLower: "content-type", value: "image/gif" },
      { name: "Location", nameLower: "location", value: "/callback" },
    ]);
  });

  it("strips query strings from request, initiator and page URLs", () => {
    const r = redact(observations());
    expect(r.network[0]!.url).toBe("https://ads.vendor.example/pixel");
    expect(r.network[0]!.initiator).toBe("https://www.example.com/search");
    expect(r.context.finalUrl).toBe("https://www.example.com/search");
  });

  it("strips frame URLs in provenance and consent calls, keeping the container id", () => {
    const r = redact(observations());
    const loader = r.scriptInsertions![0]!.loaders[0]!;
    expect(r.scriptInsertions![0]!.url).toBe("https://cdn.vendor.example/tag.js");
    expect(loader.insertedBy).toEqual([GTM_A, "https://www.example.com/app.js"]);
    expect(loader.wrapperFrames).toEqual(["https://cmp.example/osano.js"]);
    expect(loader.containerUrls).toEqual([GTM_A]);
    expect(r.consentApiCalls[0]!.callerScriptUrl).toBe("https://cdn.vendor.example/tag.js");
    expect(r.consentApiCalls[0]!.containerUrls).toEqual([GTM_A]);
  });

  it("merges reads keyed by URLs that differ only in their query, keeping the total", () => {
    const r = redact(observations());
    expect(r.signal.readsByScript).toEqual({ "https://cdn.vendor.example/tag.js": 5 });
    expect(r.signal.readCount).toBe(5);
  });

  it("strips container frame URLs in the read split and the Consent Mode setters, keeping the container", () => {
    const o = observations();
    const r = redact(o);
    const split = r.signal.readAttribution!.viaTagManagerByContainer!;
    expect(split).toEqual({ [GTM_A]: 5 });
    expect(r.signal.readAttribution!.viaTagManager).toBe(5);
    expect(r.gtm.consentModeDefaultSetBy).toBe(GTM_A);
    expect(r.gtm.consentModeUpdateSetBy).toBeNull();
    for (const u of Object.keys(o.signal.readAttribution!.viaTagManagerByContainer!)) {
      expect(containerIdentity(redactUrl(u))).toEqual(containerIdentity(u));
    }
    const setBy = o.gtm.consentModeDefaultSetBy!;
    expect(containerIdentity(r.gtm.consentModeDefaultSetBy!)).toEqual(containerIdentity(setBy));
  });

  it("strips the frame URLs a container's summary keeps, keeping the container (1.25.0)", () => {
    const o = observations();
    const r = redact(o);
    const before = o.tallies.byContainer!["gtm:GTM-ABC"]!;
    const after = r.tallies.byContainer!["gtm:GTM-ABC"]!;
    expect(after.frameUrls).toEqual([GTM_A]);
    expect(after.cookieKeys).toEqual(before.cookieKeys);
    expect(containerIdentity(after.frameUrls[0]!)).toEqual(containerIdentity(before.frameUrls[0]!));
    // A set recorded before 1.25.0 does not gain the field.
    const { byContainer: _c, ...tallies } = o.tallies;
    expect("byContainer" in redact({ ...o, tallies }).tallies).toBe(false);
  });

  it("redacts an update setter on its own, and leaves a null read attribution null", () => {
    const o = observations();
    const r = redact({
      ...o,
      signal: { ...o.signal, readAttribution: null },
      gtm: { ...o.gtm, consentModeDefaultSetBy: null, consentModeUpdateSetBy: `${GTM_A}&gtm_auth=${QUERY_TOKEN}` },
    });
    expect(r.signal.readAttribution).toBeNull();
    expect(r.gtm.consentModeDefaultSetBy).toBeNull();
    expect(r.gtm.consentModeUpdateSetBy).toBe(GTM_A);
  });

  it("does not add the read split or the Consent Mode setters to a set recorded before 1.12.0", () => {
    const o = observations();
    const { viaTagManagerByContainer: _s, ...attribution } = o.signal.readAttribution!;
    const { consentModeDefaultSetBy: _d, consentModeUpdateSetBy: _u, ...gtm } = o.gtm;
    const r = redact({ ...o, signal: { ...o.signal, readAttribution: attribution }, gtm });
    expect("viaTagManagerByContainer" in r.signal.readAttribution!).toBe(false);
    expect("consentModeDefaultSetBy" in r.gtm).toBe(false);
    expect("consentModeUpdateSetBy" in r.gtm).toBe(false);
  });

  it("does not add optional fields a set never had", () => {
    const o = observations();
    const { scriptInsertions: _a, scriptInsertionCoverage: _b, ...older } = o;
    const r = redact(older as ObservationSet);
    expect("scriptInsertions" in r).toBe(false);
    expect("requestInitiators" in r).toBe(false);
    const c = { ...o.consentApiCalls[0]! };
    delete (c as { containerUrls?: unknown }).containerUrls;
    const r2 = redact({ ...o, consentApiCalls: [c] });
    expect("containerUrls" in r2.consentApiCalls[0]!).toBe(false);
  });

  it("reads a set recorded before 1.23.0, which has neither cookie field, without adding them", () => {
    const o = observations();
    const [sid, js] = o.network[0]!.setCookies;
    const { writerWrapperUrl: _w, ...olderJs } = js!;
    const older: ObservationSet = { ...o, schemaVersion: "1.22.0" as ObservationSet["schemaVersion"], network: [{ ...o.network[0]!, setCookies: [sid!, olderJs] }] };
    const r = redact(older);
    expect("cookieCoverage" in r).toBe(false);
    expect("writerWrapperUrl" in r.network[0]!.setCookies[1]!).toBe(false);
    expect(r.network[0]!.setCookies[1]!.writerScriptUrl).toBe("https://cdn.vendor.example/tag.js");
  });

  it("strips the query from kept cookie-setting records and leaves the field absent when a set has none (1.27.0)", () => {
    const o = observations();
    const { value: _v1, ...sid } = o.network[0]!.setCookies[0]!;
    const { value: _v2, ...js } = o.network[0]!.setCookies[1]!;
    const kept = {
      id: "k1",
      url: `https://ads.vendor.example/pixel?uid=${QUERY_TOKEN}`,
      method: "GET",
      resourceType: "image" as const,
      statusCode: 200,
      secGpcPresent: true,
      isRedirectHop: false,
      captureMethod: "onHeadersReceived" as const,
      timeMs: 1,
      setCookies: [sid, js],
    };
    const r = redact({ ...o, keptCookieResponses: [kept] });
    expect(canonicalize(r)).not.toContain(QUERY_TOKEN);
    expect(r.keptCookieResponses![0]!.url).toBe("https://ads.vendor.example/pixel");
    expect(r.keptCookieResponses![0]!.setCookies[1]!.writerScriptUrl).toBe("https://cdn.vendor.example/tag.js");
    expect(r.keptCookieResponses![0]!.setCookies[1]!.writerWrapperUrl).toBe("https://cmp.example/osano.js");
    expect("keptCookieResponses" in redact(o)).toBe(false);
  });

  it("drops a value a kept record's cookie carries, which its type has no room for (1.27.0)", () => {
    // Held by the pass, not by how the record was written: a fixture, a later writer or an
    // edited bundle can put one there.
    const o = observations();
    const withValue = { ...o.network[0]!.setCookies[0]!, value: "sess_4b1d" };
    const kept = {
      id: "k1", url: "https://ads.vendor.example/pixel", method: "GET", resourceType: "image" as const,
      statusCode: 200, secGpcPresent: true, isRedirectHop: false, captureMethod: "onHeadersReceived" as const,
      timeMs: 1, setCookies: [withValue],
    };
    const r = redact({ ...o, keptCookieResponses: [kept] });
    expect(canonicalize(r)).not.toContain("sess_4b1d");
    expect("value" in r.keptCookieResponses![0]!.setCookies[0]!).toBe(false);
    expect(r.keptCookieResponses![0]!.setCookies[0]!.name).toBe(withValue.name);
  });

  it("keeps the cookie coverage flags as they are: they hold nothing to mask", () => {
    const o = { ...observations(), cookieCoverage: { wrappedOver: true, onInstance: false } };
    expect(redact(o).cookieCoverage).toEqual({ wrappedOver: true, onInstance: false });
  });

  it("is pure: the input is unchanged, and applying it twice changes nothing more", () => {
    const o = observations();
    const before = canonicalize(o);
    const once = redact(o);
    expect(canonicalize(o)).toBe(before);
    expect(canonicalize(redact(once))).toBe(canonicalize(once));
  });
});
