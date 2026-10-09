// SPDX-License-Identifier: GPL-3.0-only
/**
 * End-to-end: the engine running against REAL Disconnect classification data.
 *
 * The engine's own tests use a fake classifier — correct, because the engine must not
 * depend on any particular list. This file closes the other half: it proves the real
 * data plugs into the same interface and produces the findings the product ships.
 *
 * If this file passes, the two packages that matter are wired together and working.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluate, countCookiesSetWithSignal, countAdTechRequests } from "@gpc-inspector/engine";
import { SCHEMA_VERSION } from "@gpc-inspector/schema";
import type { ObservationSet, NetworkObservation, CookieRecord } from "@gpc-inspector/schema";
import { loadDefaultClassifier } from "../src/index.js";
import { techniqueOnlyHosts } from "./upstream.js";

const here = dirname(fileURLToPath(import.meta.url));
const classifier = loadDefaultClassifier(
  JSON.parse(readFileSync(join(here, "..", "data", "compiled-list.json"), "utf8")),
);

function cookie(name: string, partial: Partial<CookieRecord> = {}): CookieRecord {
  return {
    name,
    value: "REDACTED",
    domain: ".example",
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

let n = 0;
function req(partial: Partial<NetworkObservation> & { url: string }): NetworkObservation {
  return {
    id: `n-${++n}`,
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

function obsSet(network: NetworkObservation[], topSite = "wsj.com"): ObservationSet {
  return {
    schemaVersion: SCHEMA_VERSION,
    context: {
      finalUrl: `https://${topSite}/`,
      topSite,
      extensionVersion: "1.0.0",
      browserUserAgent: "test",
      os: "test",
      capturedAt: "2026-08-14T00:00:00.000Z",
      mode: "passive",
      incomplete: false,
    },
    signal: {
      secGpcRequestCount: network.length,
      totalRequestCount: network.length,
      source: "this-extension",
      propertyValue: true,
      readTracking: "active",
      readCount: 1,
      readsByScript: {},
      readAttribution: null,
    },
    network,
    consentApiCalls: [],
    gpp: null,
    usPrivacy: null,
    tcf: null,
    gtm: { present: false, containerIds: [], gtagIds: [], consentMode: null },
    confirmationNotice: "indeterminate",
    wellKnown: null,
    tallies: {
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
    },
  };
}

describe("engine + real Disconnect data", () => {
  it("produces the flagship cookie finding with the real entity name", () => {
    const obs = obsSet([
      req({
        url: "https://securepubads.g.doubleclick.net/gampad/ads",
        setCookies: [cookie("IDE", { domain: ".doubleclick.net", expiresMs: 63072000000 })],
      }),
    ]);

    const findings = evaluate(obs, classifier);
    const cookieFindings = findings.filter((f) => f.flag === "cookie-set-with-signal");

    expect(cookieFindings).toHaveLength(1);
    expect(cookieFindings[0]!.entity?.name).toBe("Google");
    expect(cookieFindings[0]!.artifact).toMatchObject({
      kind: "cookie",
      cookieName: "IDE",
    });
  });

  it("counts only ad/analytics cookies, ignoring first-party and unclassified", () => {
    const obs = obsSet([
      // ad tech — counts
      req({
        url: "https://securepubads.g.doubleclick.net/gampad/ads",
        setCookies: [cookie("IDE")],
      }),
      // first-party — does not count
      req({
        url: "https://wsj.com/api/session",
        setCookies: [cookie("sessionid")],
      }),
      // unclassified third party — does not count (FR-18)
      req({
        url: "https://unknown-vendor-xyz.example/px",
        setCookies: [cookie("uid")],
      }),
    ]);

    expect(countCookiesSetWithSignal(obs, classifier)).toBe(1);
  });

  it("does not count a cookie from a domain Disconnect files only as fingerprinting", () => {
    // A host Disconnect files only under a fingerprinting category, such as a WAF challenge
    // host, has no category at all, so its Set-Cookie is not counted: the headline says what
    // it counts, and this is not in it. Taken from the data rather than named, so the test
    // follows the list.
    const host = techniqueOnlyHosts()[0];
    expect(host).toBeDefined();
    const obs = obsSet([
      req({ url: `https://${host}/challenge`, setCookies: [cookie("token", { domain: `.${host}` })] }),
    ]);
    expect(classifier.classify(`https://${host}/`, "wsj.com").category).toBe("unknown");
    expect(countCookiesSetWithSignal(obs, classifier)).toBe(0);
    expect(countAdTechRequests(obs, classifier)).toBe(0);
    expect(evaluate(obs, classifier).some((f) => f.flag.startsWith("cookie-set"))).toBe(false);
  });

  it("separates redirect-hop cookies from final-response cookies", () => {
    const obs = obsSet([
      req({
        url: "https://ad.doubleclick.net/pixel",
        statusCode: 302,
        isRedirectHop: true,
        setCookies: [cookie("IDE")],
      }),
    ]);

    const findings = evaluate(obs, classifier);
    expect(findings.some((f) => f.flag === "cookie-set-on-redirect")).toBe(true);
    expect(findings.some((f) => f.flag === "cookie-set-with-signal")).toBe(false);
  });

  it("does not produce cookie findings for a site with no ad tech (denominator rule)", () => {
    const obs = obsSet([
      req({ url: "https://wsj.com/style.css", setCookies: [] }),
      req({ url: "https://wsj.com/api/data", setCookies: [cookie("sessionid")] }),
    ]);

    const findings = evaluate(obs, classifier);
    expect(findings.some((f) => f.flag.startsWith("cookie-set"))).toBe(false);
    expect(countCookiesSetWithSignal(obs, classifier)).toBe(0);
  });

  it("is deterministic end to end", () => {
    const build = () => {
      n = 0;
      return obsSet([
        req({
          url: "https://securepubads.g.doubleclick.net/gampad/ads",
          setCookies: [cookie("IDE")],
        }),
        req({
          url: "https://connect.facebook.net/tr",
          setCookies: [cookie("_fbp")],
        }),
      ]);
    };
    const a = JSON.stringify(evaluate(build(), classifier));
    const b = JSON.stringify(evaluate(build(), classifier));
    expect(a).toBe(b);
  });
});
