// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { redact } from "@gpc-inspector/schema";
import type { CookieDetail, Tallies, TagManagerKind } from "@gpc-inspector/schema";
import {
  cookieCharge,
  isCounted,
  evaluate,
  NO_OWNERS,
  withPersistedShape,
  countDistinctCookiesSetWithSignal,
  countCookiesSetWithSignal,
  countFirstPartyVendorCookies,
  type OwnerNames,
} from "../src/index.js";
import { cookieSetWithSignal } from "../src/rules/cookie-with-signal.js";
import { buildObservationSet, fakeClassifier, request, cookie } from "./helpers.js";

/**
 * Whom a cookie is charged to (1.25.0): one rule for the tally, the findings, the counts
 * and the Requests tab.
 */

const classify = fakeClassifier([
  { match: "doubleclick.net", category: "advertising", entityName: "Google" },
  { match: "google-analytics.com", category: "analytics", entityName: "Google" },
  { match: "facebook.net", category: "social", entityName: "Meta" },
  { match: "tiqcdn.com", category: "analytics", entityName: "Tealium" },
]);

/** The owner's list, as a fake: Google's, Tealium's and Adobe's names, as the real list gives them. */
const OWNERS: OwnerNames = {
  match(manager: TagManagerKind, name: string) {
    const google = { name: "Google", id: "google" };
    if (manager === "gtm" || manager === "gtag" || manager === "google") {
      if (name === "_ga" || name.startsWith("_ga_")) return { entity: google, category: "analytics" };
      if (name.startsWith("_gcl_")) return { entity: google, category: "advertising" };
      return null;
    }
    if (manager === "tealium" && (name === "utag_main" || name.startsWith("utag_main_"))) {
      return { entity: { name: "Tealium", id: "tealium" }, category: "analytics" };
    }
    if (manager === "adobe-launch" && (name === "s_cc" || name.startsWith("AMCV_"))) {
      return { entity: { name: "Adobe", id: "adobe" }, category: name === "s_cc" ? "analytics" : "advertising" };
    }
    return null;
  },
};

const GTM_NFD = "https://www.googletagmanager.com/gtm.js?id=GTM-XNWF100";
const GTM_5HQ = "https://www.googletagmanager.com/gtm.js?id=GTM-XRTM1000";
const GTAG = "https://www.googletagmanager.com/gtag/js?id=G-XNWF200000";
const UTAG = "https://tags.tiqcdn.com/utag/automakere/tier1aue/prod/utag.js";
const UTAG_RETAILER_I = "https://tiq.retailer-i.example/utag/retaileri/storeus/prod/utag.js";
const LAUNCH = "https://assets.adobedtm.com/abc123/launch-EN0123456789abcdef.min.js";
const FBEVENTS = "https://connect.facebook.net/en_US/fbevents.js";

const js = (name: string, writer: string | null) =>
  cookie({ name, domain: ".example.com", via: "documentCookie", writerScriptUrl: writer, writerViaTagManager: false });
const charge = (c: ReturnType<typeof cookie>, url: string, topSite = "example.com") => cookieCharge(c, url, topSite, classify, OWNERS);

describe("the charge, case by case", () => {
  it("a response from doubleclick.net setting IDE: host, Google, Advertising, counted", () => {
    const got = charge(cookie({ name: "IDE", domain: ".doubleclick.net" }), "https://ad.doubleclick.net/pixel");
    expect(got).toEqual({ kind: "host", party: "third", category: "advertising", entity: { name: "Google", id: "google" }, domain: "doubleclick.net" });
    expect(isCounted(got)).toBe(true);
  });

  it("fbevents.js writing _fbp: host, Meta, Social, not counted", () => {
    const got = charge(js("_fbp", FBEVENTS), FBEVENTS);
    expect(got).toMatchObject({ kind: "host", party: "third", category: "social", entity: { name: "Meta" } });
    expect(isCounted(got)).toBe(false);
  });

  it("gtm.js?id=GTM-XNWF100 writing nwf_byline: the container, not counted", () => {
    const got = charge(js("nwf_byline", GTM_NFD), GTM_NFD);
    expect(got).toEqual({ kind: "container", party: "third", container: { manager: "gtm", id: "GTM-XNWF100" } });
    expect(isCounted(got)).toBe(false);
  });

  it("gtm.js?id=GTM-XRTM1000 writing _gcl_au: the owner, Google, Advertising, counted", () => {
    const got = charge(js("_gcl_au", GTM_5HQ), GTM_5HQ);
    expect(got).toEqual({
      kind: "owner", party: "third", category: "advertising", entity: { name: "Google", id: "google" },
      container: { manager: "gtm", id: "GTM-XRTM1000" },
    });
    expect(isCounted(got)).toBe(true);
  });

  it("gtag/js?id=G-XNWF200000 writing _ga_XNWF200000: the owner, Google, Analytics, counted", () => {
    const got = charge(js("_ga_XNWF200000", GTAG), GTAG);
    expect(got).toMatchObject({ kind: "owner", category: "analytics", entity: { name: "Google" }, container: { manager: "gtag", id: "G-XNWF200000" } });
    expect(isCounted(got)).toBe(true);
  });

  it("utag.js from tags.tiqcdn.com writing utag_main_ses_id: the owner, Tealium, Analytics, counted", () => {
    const got = charge(js("utag_main_ses_id", UTAG), UTAG);
    expect(got).toMatchObject({ kind: "owner", party: "third", category: "analytics", entity: { name: "Tealium" }, container: { manager: "tealium", id: "automakere/tier1aue" } });
    expect(isCounted(got)).toBe(true);
  });

  it("utag.js from tags.tiqcdn.com writing AMCV_: the container, never re-charged to Adobe by name", () => {
    const got = charge(js("AMCV_3C3B1234%40AdobeOrg", UTAG), UTAG);
    expect(got).toEqual({ kind: "container", party: "third", container: { manager: "tealium", id: "automakere/tier1aue" } });
    expect(isCounted(got)).toBe(false);
  });

  it("utag.js from tiq.retailer-i.example on retailer-i.example writing utag_main_ses_id: the owner, first party, not counted", () => {
    const got = charge(js("utag_main_ses_id", UTAG_RETAILER_I), UTAG_RETAILER_I, "retailer-i.example");
    expect(got).toMatchObject({ kind: "owner", party: "first", entity: { name: "Tealium" } });
    expect(isCounted(got)).toBe(false);
  });

  it("launch-*.js from assets.adobedtm.com writing s_cc: the owner, Adobe, counted", () => {
    const got = charge(js("s_cc", LAUNCH), LAUNCH);
    expect(got).toMatchObject({ kind: "owner", party: "third", category: "analytics", entity: { name: "Adobe" }, container: { manager: "adobe-launch" } });
    expect(isCounted(got)).toBe(true);
  });

  it("a script with no URL: the page's host, first party, not counted", () => {
    const got = charge(js("_ga", null), "https://www.example.com/");
    expect(got).toEqual({ kind: "host", party: "first", category: "unknown", entity: null, domain: "example.com" });
    expect(isCounted(got)).toBe(false);
  });

  it("takes the container from the writer's URL, not from writerViaTagManager", () => {
    // A capture from before the rule: the boolean says tag manager, the writer is Meta's
    // own script, and the charge is Meta's. And the other way round.
    const flagged = cookie({ name: "_fbp", via: "documentCookie", writerScriptUrl: FBEVENTS, writerViaTagManager: true });
    expect(charge(flagged, FBEVENTS)).toMatchObject({ kind: "host", entity: { name: "Meta" } });
    const unflagged = cookie({ name: "_ga", via: "documentCookie", writerScriptUrl: GTAG });
    expect(charge(unflagged, GTAG)).toMatchObject({ kind: "owner", entity: { name: "Google" } });
  });

  it("charges a response's cookie by its host, whatever writer field it carries", () => {
    const got = charge(cookie({ name: "_ga", writerScriptUrl: GTAG }), "https://www.google-analytics.com/collect");
    expect(got).toMatchObject({ kind: "host", entity: { name: "Google" }, category: "analytics" });
  });

  it("charges every container write to no one without an owner's list", () => {
    expect(cookieCharge(js("_ga", GTAG), GTAG, "example.com", classify, NO_OWNERS)).toMatchObject({ kind: "container" });
  });
});

describe("the findings and the counts charge a container's key by the owner's list", () => {
  const detail = (over: Partial<CookieDetail>): CookieDetail => ({
    expiresMs: null, sameSite: "Lax", secure: false, partitioned: false, via: "documentCookie",
    host: "www.googletagmanager.com", onRedirect: false, onRedirectSigned: false, firstSignedObservationId: "js-1", ...over,
  });
  const K = (name: string, domain = ".example.com") => `${name}\u0000${domain}`;
  // What the worker records for one GA4 tag, one GTM tag and a Tealium container: the
  // owners' names counted, every name kept by its container.
  const network = () => [
    request({ id: "js-1", url: GTAG, method: "SCRIPT", resourceType: "other", setCookies: [js("_ga", GTAG), js("_ga_XNWF200000", GTAG)] }),
    request({ id: "js-2", url: GTM_NFD, method: "SCRIPT", resourceType: "other", setCookies: [js("nwf_byline", GTM_NFD)] }),
    request({ id: "js-3", url: UTAG, method: "SCRIPT", resourceType: "other", setCookies: [js("utag_main_ses_id", UTAG), js("AMCV_X%40AdobeOrg", UTAG)] }),
  ];
  const tallies = (): Tallies => ({
    totalRequests: 1, signedRequests: 1, adVendorRequests: 1, adCookieEvents: 3,
    adCookieKeys: [K("_ga"), K("_ga_XNWF200000"), K("utag_main_ses_id")],
    adCookieKeysUnsigned: [],
    adCookieEntities: { [K("_ga")]: "Google", [K("_ga_XNWF200000")]: "Google", [K("utag_main_ses_id")]: "Tealium" },
    adCookieCategories: { [K("_ga")]: "analytics", [K("_ga_XNWF200000")]: "analytics", [K("utag_main_ses_id")]: "analytics" },
    firstPartyVendorCookieKeys: [],
    byEntity: {},
    byEntityCategory: {
      // Made by the owners' names alone: no host of Google's, and its code ran.
      "Google\u0000analytics": {
        entity: "Google", category: "analytics", requests: 0, signedRequests: 0, hosts: [], resourceTypes: [], scriptRan: true,
        cookieKeys: [], cookieKeysUnsigned: [], cookiesReturned: [], probeCookies: [], refusedWrites: [],
        firstObservationId: "js-1", executionObservationId: "js-1", scriptRanOutsideXhr: true,
      },
      "Tealium\u0000analytics": {
        entity: "Tealium", category: "analytics", requests: 1, signedRequests: 1, hosts: ["tags.tiqcdn.com"], resourceTypes: ["script"], scriptRan: true,
        cookieKeys: [], cookieKeysUnsigned: [], cookiesReturned: [], probeCookies: [], refusedWrites: [],
        firstObservationId: "js-3", executionObservationId: "js-3", scriptRanOutsideXhr: true,
      },
    },
    cookieDetails: {
      [K("_ga")]: detail({ container: "gtag:G-XNWF200000" }),
      [K("_ga_XNWF200000")]: detail({ container: "gtag:G-XNWF200000" }),
      [K("nwf_byline")]: detail({ container: "gtm:GTM-XNWF100", firstSignedObservationId: null }),
      [K("utag_main_ses_id")]: detail({ host: "tags.tiqcdn.com", container: "tealium:automakere/tier1aue", firstSignedObservationId: "js-3" }),
      [K("AMCV_X%40AdobeOrg")]: detail({ host: "tags.tiqcdn.com", container: "tealium:automakere/tier1aue", firstSignedObservationId: null }),
    },
    byContainer: {
      "gtag:G-XNWF200000": { manager: "gtag", id: "G-XNWF200000", frameUrls: [GTAG], cookieKeys: [K("_ga"), K("_ga_XNWF200000")], cookieKeysUnsigned: [], probeCookies: [], refusedWrites: [] },
      "gtm:GTM-XNWF100": { manager: "gtm", id: "GTM-XNWF100", frameUrls: [GTM_NFD], cookieKeys: [K("nwf_byline")], cookieKeysUnsigned: [], probeCookies: [], refusedWrites: [] },
      "tealium:automakere/tier1aue": { manager: "tealium", id: "automakere/tier1aue", frameUrls: [UTAG], cookieKeys: [K("AMCV_X%40AdobeOrg"), K("utag_main_ses_id")], cookieKeysUnsigned: [], probeCookies: [], refusedWrites: [] },
    },
  });

  it("names the owner and the name's category, never the container's host", () => {
    const findings = cookieSetWithSignal(buildObservationSet({ network: network(), tallies: tallies() }), classify, OWNERS);
    expect(findings.map((f) => [f.artifact.kind === "cookie" ? f.artifact.cookieName : "", f.entity?.name])).toEqual([
      ["_ga", "Google"],
      ["_ga_XNWF200000", "Google"],
      ["utag_main_ses_id", "Tealium"],
    ]);
    expect(findings[0]?.entity?.domains).toEqual(["googletagmanager.com"]);
  });

  it("raises no finding for a key the owner's list no longer gives its owner", () => {
    // As with a host the list has dropped: the key is in the count the capture made, and
    // today's list names nobody for it.
    const findings = cookieSetWithSignal(buildObservationSet({ network: network(), tallies: tallies() }), classify, NO_OWNERS);
    expect(findings).toEqual([]);
  });

  it("gives the same findings with the request list gone, and for the set's redaction", () => {
    const set = buildObservationSet({ network: network(), tallies: tallies() });
    const gone = buildObservationSet({ network: [], tallies: tallies() });
    expect(evaluate(gone, classify, OWNERS)).toEqual(evaluate(set, classify, OWNERS));
    const withQuery = buildObservationSet({
      network: network().map((n) => ({ ...n, url: `${n.url}&gtm_auth=tok_1`, setCookies: n.setCookies.map((c) => ({ ...c, writerScriptUrl: `${c.writerScriptUrl}&gtm_auth=tok_1` })) })),
      tallies: tallies(),
    });
    expect(evaluate(redact(withQuery), classify, OWNERS)).toEqual(evaluate(withQuery, classify, OWNERS));
  });

  it("judges an owner whose only sign is its own name written inside its container", () => {
    const findings = evaluate(buildObservationSet({ network: [], tallies: tallies() }), classify, OWNERS);
    const google = findings.find((f) => f.flag.startsWith("vendor-") && f.entity?.name === "Google");
    expect(google).toMatchObject({ flag: "vendor-did-not-read-gpc", entity: { category: "analytics", domains: [] }, artifact: { observationId: "js-1" } });
  });

  it("counts per cookie with no tallies, by the same rule", () => {
    const set = buildObservationSet({ network: network() });
    // _ga, _ga_XNWF200000 and utag_main_ses_id: the owners' names, and nothing else.
    expect(countDistinctCookiesSetWithSignal(set, classify, OWNERS)).toBe(3);
    expect(countCookiesSetWithSignal(set, classify, OWNERS)).toBe(3);
    expect(cookieSetWithSignal(set, classify, OWNERS).map((f) => f.entity?.name)).toEqual(["Google", "Google", "Tealium"]);
    // With no owner's list, no name written inside a container counts.
    expect(countDistinctCookiesSetWithSignal(set, classify, NO_OWNERS)).toBe(0);
  });

  it("counts no first-party container's names as a vendor's", () => {
    const capture = buildObservationSet({
      context: { topSite: "retailer-i.example", finalUrl: "https://www.retailer-i.example/" },
      network: [request({ url: UTAG_RETAILER_I, method: "SCRIPT", setCookies: [js("utag_main_ses_id", UTAG_RETAILER_I)] })],
    });
    const retailerIClassify = fakeClassifier([{ match: "retailer-i.example", category: "analytics", entityName: "retailer-i" }]);
    expect(countFirstPartyVendorCookies(capture, retailerIClassify, OWNERS)).toBe(0);
    expect(countDistinctCookiesSetWithSignal(capture, retailerIClassify, OWNERS)).toBe(0);
  });
});

describe("a capture from before 1.25.0 reads as one charged by the rule", () => {
  const K = (name: string) => `${name}\u0000.example.com`;
  const network = () => [
    request({ id: "js-1", url: GTAG, method: "SCRIPT", setCookies: [js("_ga", GTAG)] }),
    request({ id: "js-2", url: UTAG, method: "SCRIPT", secGpcPresent: false, setCookies: [js("AMCV_X%40AdobeOrg", UTAG)] }),
    request({ id: "js-3", url: FBEVENTS, method: "SCRIPT", setCookies: [js("_fbp", FBEVENTS)] }),
  ];

  it("derives each container's summary and each key's container from its requests", () => {
    const set = withPersistedShape(buildObservationSet({ network: network() }));
    expect(set.tallies.byContainer).toEqual({
      "gtag:G-XNWF200000": { manager: "gtag", id: "G-XNWF200000", frameUrls: [GTAG], cookieKeys: [K("_ga")], cookieKeysUnsigned: [], probeCookies: [], refusedWrites: [] },
      "tealium:automakere/tier1aue": { manager: "tealium", id: "automakere/tier1aue", frameUrls: [UTAG], cookieKeys: [], cookieKeysUnsigned: [K("AMCV_X%40AdobeOrg")], probeCookies: [], refusedWrites: [] },
    });
    expect(set.tallies.cookieDetails?.[K("_ga")]?.container).toBe("gtag:G-XNWF200000");
    expect(set.tallies.cookieDetails?.[K("AMCV_X%40AdobeOrg")]?.container).toBe("tealium:automakere/tier1aue");
    expect(set.tallies.cookieDetails?.[K("_fbp")]).not.toHaveProperty("container");
  });

  it("leaves a current capture's summaries as they are", () => {
    const current = buildObservationSet({
      network: network(),
      tallies: {
        totalRequests: 0, signedRequests: 0, adVendorRequests: 0, adCookieEvents: 0, adCookieKeys: [], firstPartyVendorCookieKeys: [], byEntity: {},
        cookieDetails: {}, byContainer: {},
      },
    });
    expect(withPersistedShape(current).tallies.byContainer).toEqual({});
  });

  it("gives an older capture's container key no finding when the name is not the owner's", () => {
    // Counted under Tealium when it was captured; charged to no one when read today.
    const K2 = (n: string) => `${n}\u0000.example.com`;
    const old = buildObservationSet({
      network: [request({ id: "js-9", url: UTAG, method: "SCRIPT", setCookies: [js("AMCV_X%40AdobeOrg", UTAG)] })],
      tallies: {
        totalRequests: 1, signedRequests: 1, adVendorRequests: 1, adCookieEvents: 1,
        adCookieKeys: [K2("AMCV_X%40AdobeOrg")], firstPartyVendorCookieKeys: [], byEntity: {},
      },
    });
    expect(cookieSetWithSignal(old, classify, OWNERS)).toEqual([]);
    expect(cookieSetWithSignal(old, classify, NO_OWNERS)).toEqual([]);
  });
});
