// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect, beforeEach } from "vitest";
import { cookieSetWithSignal } from "../src/rules/cookie-with-signal.js";
import {
  evaluate,
  countCookiesSetWithSignal,
  countDistinctCookiesSetWithSignal,
  countCookiesSetWithoutSignal,
  countDistinctCookiesSetWithoutSignal,
  countFirstPartyVendorCookies,
  countAdTechRequests,
  honorDeclarations,
} from "../src/index.js";
import type { GppObservation, UsPrivacyObservation } from "@gpc-inspector/schema";
import {
  buildObservationSet,
  fakeClassifier,
  request,
  cookie,
  consentApiCall,
  resetIds,
  type FakeRule,
} from "./helpers.js";

// A classifier that knows the vendors our fixtures use.
const RULES: FakeRule[] = [
  { match: "doubleclick.net", category: "advertising", entityName: "Google" },
  { match: "google-analytics.com", category: "analytics", entityName: "Google" },
  { match: "criteo.com", category: "advertising", entityName: "Criteo" },
  { match: "bing.com", category: "advertising", entityName: "Microsoft" },
  { match: "facebook.com", category: "advertising", entityName: "Meta" },
  { match: "cdn.example", category: "content" }, // context, no entity
  // A domain the list files as a fingerprinter and nothing else: a company and no
  // category, never counted.
  { match: "challenge.example", category: "unknown", entityName: "Bot Guard" },
];
const classify = fakeClassifier(RULES);

beforeEach(() => resetIds());

// --- helper to build a GPP observation with one section ---
function gppWith(section: string, fields: Record<string, number>): GppObservation {
  return {
    rawString: "DBABz~encoded",
    applicableSections: [8],
    gppVersion: "1.0",
    sections: { [section]: fields },
    unparseable: false,
    fromWire: null,
  };
}

describe("fixture: GPP conflict (the flagship)", () => {
  it("flags Gpc=1 beside SaleOptOut=2 in the same section, site-level", () => {
    const obs = buildObservationSet({
      gpp: gppWith("usca", { Gpc: 1, SaleOptOut: 2, SharingOptOut: 2 }),
    });
    const findings = evaluate(obs, classify);
    const conflict = findings.filter((f) => f.flag === "gpp-conflict");
    expect(conflict).toHaveLength(1);
    expect(conflict[0]!.entity).toBeNull();
    expect(conflict[0]!.artifact).toEqual({
      kind: "gpp-field",
      section: "usca",
      fields: { Gpc: 1, SaleOptOut: 2, SharingOptOut: 2 },
    });
  });

  it("does NOT flag when Gpc is present but no opt-out field says did-not-opt-out", () => {
    const obs = buildObservationSet({
      gpp: gppWith("usca", { Gpc: 1, SaleOptOut: 1 }), // 1 = opted out; consistent
    });
    expect(evaluate(obs, classify).some((f) => f.flag === "gpp-conflict")).toBe(false);
  });

  it("does NOT flag when the string is unparseable (record raw, never guess)", () => {
    const obs = buildObservationSet({
      gpp: {
        rawString: "garbage",
        applicableSections: [],
        gppVersion: null,
        sections: {},
        unparseable: true,
        fromWire: null,
      },
    });
    expect(evaluate(obs, classify).some((f) => f.flag === "gpp-conflict")).toBe(false);
  });
});

describe("fixture: GPP surfaces disagree (same failure mode as USP, one surface fewer)", () => {
  it("flags when the API string and the wire string differ", () => {
    const obs = buildObservationSet({
      gpp: gppWith("usca", { Gpc: 1 }), // rawString: "DBABz~encoded", fromWire: null
    });
    // Override fromWire directly — gppWith's fixture doesn't take it as a parameter.
    const withWire = { ...obs, gpp: { ...obs.gpp!, fromWire: "DBABz~different" } };
    const findings = evaluate(withWire, classify);
    const disagree = findings.filter((f) => f.flag === "gpp-surfaces-disagree");
    expect(disagree).toHaveLength(1);
    expect(disagree[0]!.entity).toBeNull();
    expect(disagree[0]!.artifact).toEqual({
      kind: "gpp-wire",
      fromApi: "DBABz~encoded",
      fromWire: "DBABz~different",
    });
  });

  it("does NOT flag when the API string and the wire string match", () => {
    const obs = buildObservationSet({ gpp: gppWith("usca", { Gpc: 1 }) });
    const same = { ...obs, gpp: { ...obs.gpp!, fromWire: obs.gpp!.rawString } };
    expect(evaluate(same, classify).some((f) => f.flag === "gpp-surfaces-disagree")).toBe(false);
  });

  it("does NOT flag when the wire surface was never observed", () => {
    const obs = buildObservationSet({ gpp: gppWith("usca", { Gpc: 1 }) }); // fromWire: null
    expect(evaluate(obs, classify).some((f) => f.flag === "gpp-surfaces-disagree")).toBe(false);
  });

  it("does NOT flag when there is no API string, even if a wire value was seen", () => {
    // A wire-only observation (mergeGppWire's synthetic base) has rawString === "" — an
    // absent API surface, not a disagreement with it.
    const obs = buildObservationSet({
      gpp: {
        rawString: "",
        applicableSections: [],
        gppVersion: null,
        sections: {},
        unparseable: false,
        fromWire: "DBABz~x",
      },
    });
    expect(evaluate(obs, classify).some((f) => f.flag === "gpp-surfaces-disagree")).toBe(false);
  });
});

describe("every string requests carried, not the last one (1.29.0)", () => {
  // news-h.example, 2026-09-30: the page reported 1YYN, Google's requests carried 1YYN and
  // Rubicon's 1---. Judged from the last request, the notice came and went.
  const newsH = {
    fromApi: "1YYN",
    fromCookie: null,
    fromWire: "1YYN",
    fromWireHost: "securepubads.g.doubleclick.net",
    wireValues: [
      { value: "1---", hosts: ["pixel.rubiconproject.com", "gum.criteo.com"] },
      { value: "1YYN", hosts: ["securepubads.g.doubleclick.net"] },
    ],
  };
  const usp = (u: UsPrivacyObservation) =>
    evaluate(buildObservationSet({ usPrivacy: u }), classify).filter((f) => f.flag === "usp-surfaces-disagree");

  it("flags a USP string any request carried that differs, even when the last one matched", () => {
    const found = usp(newsH);
    expect(found).toHaveLength(1);
    expect(found[0]!.artifact).toEqual({
      kind: "usp",
      fromApi: "1YYN",
      fromCookie: null,
      fromWire: "1---",
      fromWireHost: "pixel.rubiconproject.com",
    });
  });

  it("does not flag when every request carried the page's string", () => {
    expect(usp({ ...newsH, wireValues: [{ value: "1YYN", hosts: ["a.example"] }] })).toHaveLength(0);
  });

  it("does not flag an empty list, which a change of the page's string leaves, from fromWire", () => {
    expect(usp({ ...newsH, fromWire: "1---", wireValues: [] })).toHaveLength(0);
  });

  it("judges an older bundle from fromWire, with its host", () => {
    const old = { fromApi: "1YYN", fromCookie: null, fromWire: "1YNN", fromWireHost: "sync.example" };
    expect(usp(old)[0]!.artifact).toMatchObject({ fromWire: "1YNN", fromWireHost: "sync.example" });
    expect(usp({ ...old, fromWire: "1YYN" })).toHaveLength(0);
  });

  it("does not flag requests that differ only among themselves when the page reported nothing", () => {
    expect(usp({ ...newsH, fromApi: null })).toHaveLength(0);
  });

  it("flags that case as the requests disagreeing, with every string", () => {
    const flags = (u: UsPrivacyObservation) =>
      evaluate(buildObservationSet({ usPrivacy: u }), classify).filter((f) => f.flag === "usp-requests-disagree");
    expect(flags({ ...newsH, fromApi: null }).map((f) => f.artifact)).toEqual([
      { kind: "wire-values", values: newsH.wireValues },
    ]);
    // The page reported a string: the page-vs-request finding covers it instead.
    expect(flags(newsH)).toHaveLength(0);
    expect(flags({ ...newsH, fromApi: null, fromCookie: "1YYN" })).toHaveLength(0);
    // One string, however many hosts: nothing disagreed.
    expect(flags({ ...newsH, fromApi: null, wireValues: [newsH.wireValues[0]!] })).toHaveLength(0);
  });

  it("flags GPP requests disagreeing when the page reported no GPP string", () => {
    const base = { rawString: "", applicableSections: [], gppVersion: null, sections: {}, unparseable: false, fromWire: "DBABz~b" };
    const values = [
      { value: "DBABz~a", hosts: ["fastlane.rubiconproject.com"] },
      { value: "DBABz~b", hosts: ["ads.pubmatic.com"] },
    ];
    const flags = (gpp: GppObservation) =>
      evaluate(buildObservationSet({ gpp }), classify).filter((f) => f.flag.startsWith("gpp-") && f.flag.endsWith("disagree"));
    expect(flags({ ...base, wireValues: values }).map((f) => [f.flag, f.artifact])).toEqual([
      ["gpp-requests-disagree", { kind: "wire-values", values }],
    ]);
    expect(flags({ ...base, wireValues: [values[0]!] })).toHaveLength(0);
    expect(flags({ ...base, rawString: "DBABz~b", wireValues: values }).map((f) => f.flag)).toEqual(["gpp-surfaces-disagree"]);
  });

  it("still flags the API and the cookie disagreeing with no request at all", () => {
    expect(usp({ fromApi: "1YYN", fromCookie: "1YNN", fromWire: null })).toHaveLength(1);
  });

  it("flags a GPP string any request carried that differs, naming its first host", () => {
    const obs = buildObservationSet({ gpp: gppWith("usca", { Gpc: 1 }) });
    const gpp = {
      ...obs.gpp!,
      fromWire: obs.gpp!.rawString,
      wireValues: [
        { value: obs.gpp!.rawString, hosts: ["securepubads.g.doubleclick.net"] },
        { value: "DBABz~stale", hosts: ["fastlane.rubiconproject.com", "ads.pubmatic.com"] },
      ],
    };
    const found = evaluate({ ...obs, gpp }, classify).filter((f) => f.flag === "gpp-surfaces-disagree");
    expect(found.map((f) => f.artifact)).toEqual([
      { kind: "gpp-wire", fromApi: "DBABz~encoded", fromWire: "DBABz~stale", fromWireHost: "fastlane.rubiconproject.com" },
    ]);
    const agreeing = { ...gpp, wireValues: [gpp.wireValues[0]!] };
    expect(evaluate({ ...obs, gpp: agreeing }, classify).some((f) => f.flag === "gpp-surfaces-disagree")).toBe(false);
  });
});

describe("fixture: redirect-hop cookie", () => {
  it("distinguishes a cookie set on a redirect hop from a final-response cookie", () => {
    const obs = buildObservationSet({
      network: [
        request({
          url: "https://ad.doubleclick.net/pixel",
          statusCode: 302,
          isRedirectHop: true,
          setCookies: [cookie({ name: "IDE" })],
        }),
        request({
          url: "https://bat.bing.com/action",
          statusCode: 200,
          isRedirectHop: false,
          setCookies: [cookie({ name: "MUID" })],
        }),
      ],
    });
    const findings = evaluate(obs, classify);
    const redirect = findings.filter((f) => f.flag === "cookie-set-on-redirect");
    const normal = findings.filter((f) => f.flag === "cookie-set-with-signal");

    expect(redirect).toHaveLength(1);
    expect(redirect[0]!.entity?.name).toBe("Google");
    expect(redirect[0]!.artifact).toMatchObject({ kind: "cookie", cookieName: "IDE" });

    expect(normal).toHaveLength(1);
    expect(normal[0]!.entity?.name).toBe("Microsoft");

    // redirect cookie ranks just after the normal one (both in the 10s band)
    expect(redirect[0]!.rank).toBeGreaterThan(normal[0]!.rank);
  });

  it("does not flag a cookie when the request did NOT carry the signal", () => {
    const obs = buildObservationSet({
      network: [
        request({
          url: "https://ad.doubleclick.net/pixel",
          secGpcPresent: false,
          cookiesSent: [],
          setCookies: [cookie({ name: "IDE" })],
        }),
      ],
    });
    expect(
      evaluate(obs, classify).some((f) => f.flag.startsWith("cookie-set")),
    ).toBe(false);
  });

  it("does not flag an unclassified (unknown) domain's cookie", () => {
    const obs = buildObservationSet({
      network: [
        request({
          url: "https://who-knows.example/t",
          setCookies: [cookie({ name: "x" })],
        }),
      ],
    });
    expect(
      evaluate(obs, classify).some((f) => f.flag.startsWith("cookie-set")),
    ).toBe(false);
  });
});

describe("fixture: GTM-heavy site", () => {
  it("produces NO finding from the container's Consent Mode state", () => {
    // Consent Mode is how a container passes a choice to Google's tags. It is not the
    // obligation: every vendor receives Sec-GPC on its own requests whether or not a
    // container told them anything, and Consent Mode does not bind non-Google vendors at
    // all. Pairing "the container recorded denied" with "a cookie was set" asserts a
    // contradiction that has not been established: on retailer-m.example the cookies were largely
    // from vendors Consent Mode never governed.
    //
    // The container's state is reported as context in the UI. The cookies are counted on
    // their own terms. Neither needs the other to be meaningful.
    const obs = buildObservationSet({
      gtm: {
        present: true,
        containerIds: ["GTM-WKX4"],
        gtagIds: [],
        consentMode: {
          ad_user_data: "denied",
          ad_personalization: "denied",
          ad_storage: "denied",
          analytics_storage: "denied",
        },
      },
      network: [
        request({
          url: "https://ad.doubleclick.net/ads",
          setCookies: [cookie({ name: "IDE", domain: ".doubleclick.net" })],
        }),
      ],
    });

    const findings = evaluate(obs, classify);
    expect(findings.some((f) => f.flag.startsWith("gtm"))).toBe(false);

    // The cookie finding stands entirely on its own.
    expect(findings.some((f) => f.flag === "cookie-set-with-signal")).toBe(true);
  });

  it("counts cookies on a GTM page exactly as it would anywhere else", () => {
    const withGtm = buildObservationSet({
      gtm: { present: true, containerIds: ["GTM-X"], gtagIds: [], consentMode: null },
      network: [
        request({
          url: "https://ad.doubleclick.net/ads",
          setCookies: [cookie({ name: "IDE", domain: ".doubleclick.net" })],
        }),
      ],
    });
    const withoutGtm = buildObservationSet({
      network: [
        request({
          url: "https://ad.doubleclick.net/ads",
          setCookies: [cookie({ name: "IDE", domain: ".doubleclick.net" })],
        }),
      ],
    });
    expect(countDistinctCookiesSetWithSignal(withGtm, classify)).toBe(
      countDistinctCookiesSetWithSignal(withoutGtm, classify),
    );
  });
});

describe("fixture: no ad tech (the denominator case)", () => {
  it("produces zero cookie findings and a zero count", () => {
    const obs = buildObservationSet({
      network: [
        request({ url: "https://cdn.example/font.woff2", setCookies: [] }),
        request({ url: "https://example.com/api", setCookies: [cookie({ name: "session" })] }),
      ],
      confirmationNotice: "indeterminate",
    });
    const findings = evaluate(obs, classify);
    expect(findings.some((f) => f.flag.startsWith("cookie-set"))).toBe(false);
    expect(countCookiesSetWithSignal(obs, classify)).toBe(0);
  });

  it("treats a fingerprinting domain as context: no finding, no count, not ad tech", () => {
    // Disconnect's fingerprinting categories describe a technique, and a domain carrying only
    // one of them (a bot-detection or WAF challenge host) has no category and is not an
    // advertising or analytics domain. Its cookie is a fact for the Requests tab, never for the headline, and its
    // request does not make the page one with ad tech on it.
    const obs = buildObservationSet({
      network: [
        request({ url: "https://challenge.example/token", setCookies: [cookie({ name: "aws-waf-token", domain: ".challenge.example" })] }),
      ],
    });
    const findings = evaluate(obs, classify);
    expect(findings.some((f) => f.flag.startsWith("cookie-set"))).toBe(false);
    expect(countCookiesSetWithSignal(obs, classify)).toBe(0);
    expect(countDistinctCookiesSetWithSignal(obs, classify)).toBe(0);
    expect(countAdTechRequests(obs, classify)).toBe(0);
  });
});

describe("signal-not-read (Meta's never-checked failure)", () => {
  it("fires only when read tracking is active, property true, and readCount 0", () => {
    const obs = buildObservationSet({
      signal: {
        secGpcRequestCount: 1,
        totalRequestCount: 1,
        source: "this-extension",
        propertyValue: true,
        readTracking: "active",
        readCount: 0,
        readsByScript: {},
      },
    });
    expect(evaluate(obs, classify).some((f) => f.flag === "signal-not-read")).toBe(true);
  });

  it("does NOT fire when read tracking is unavailable (absence is not a finding)", () => {
    const obs = buildObservationSet({
      signal: {
        secGpcRequestCount: 1,
        totalRequestCount: 1,
        source: "other-extension",
        propertyValue: true,
        readTracking: "unavailable",
        readCount: null,
        readsByScript: {},
      },
    });
    expect(evaluate(obs, classify).some((f) => f.flag === "signal-not-read")).toBe(false);
  });

  it("does NOT fire when the site's own GPP string records that it saw GPC", () => {
    // A CMP can receive the signal from the Sec-GPC request header, or decide server-side,
    // without any script reading the property. "No script read the property" stays true,
    // but this finding is read as "nothing on this page registered your signal", and the
    // site's own broadcast contradicts that second claim. Rendering both puts two of the
    // site's facts on one screen looking like a contradiction that is ours, not theirs.
    const obs = buildObservationSet({
      signal: {
        secGpcRequestCount: 1,
        totalRequestCount: 1,
        source: "this-extension",
        propertyValue: true,
        readTracking: "active",
        readCount: 0,
        readsByScript: {},
        readAttribution: { sampled: 0, unattributed: 0, viaTagManager: 0 },
      },
      gpp: gppWith("usca", { Gpc: 1 }),
    });
    expect(evaluate(obs, classify).some((f) => f.flag === "signal-not-read")).toBe(false);
  });

  it("still fires when the string records that it did NOT see GPC", () => {
    const obs = buildObservationSet({
      signal: {
        secGpcRequestCount: 1,
        totalRequestCount: 1,
        source: "this-extension",
        propertyValue: true,
        readTracking: "active",
        readCount: 0,
        readsByScript: {},
        readAttribution: { sampled: 0, unattributed: 0, viaTagManager: 0 },
      },
      gpp: gppWith("usca", { Gpc: 0 }),
    });
    expect(evaluate(obs, classify).some((f) => f.flag === "signal-not-read")).toBe(true);
  });

  it("does NOT fire when the property was switched off (nothing was there to read)", () => {
    // The rule requires propertyValue true. The capture side observes the property value
    // rather than deriving it from the signal source, where any source at all would give
    // `true` and a switched-off signal could carry this finding. This is the case that
    // guards.
    const obs = buildObservationSet({
      signal: {
        secGpcRequestCount: 0,
        totalRequestCount: 1,
        source: "native",
        propertyValue: false,
        readTracking: "active",
        readCount: 0,
        readsByScript: {},
      },
    });
    expect(evaluate(obs, classify).some((f) => f.flag === "signal-not-read")).toBe(false);
  });
});

describe("gpc-vs-gpp (the signal we sent vs the string the site published)", () => {
  const sentSignal = {
    secGpcRequestCount: 12,
    totalRequestCount: 12,
    source: "this-extension" as const,
    propertyValue: true as const,
    readTracking: "active" as const,
    readCount: 3,
    readsByScript: {},
    readAttribution: { sampled: 0, unattributed: 0, viaTagManager: 0 },
  };
  const noSignal = { ...sentSignal, secGpcRequestCount: 0, propertyValue: false as const, source: "none" as const };

  it("reports the disagreement when we sent GPC and the string records none", () => {
    const obs = buildObservationSet({ signal: sentSignal, gpp: gppWith("usca", { Gpc: 0 }) });
    const f = evaluate(obs, classify).find((x) => x.flag === "gpc-sent-gpp-field-no");
    expect(f).toBeDefined();
    expect(f?.entity).toBeNull(); // site-level: our signal against the site's own string
    expect(f?.artifact).toEqual({
      kind: "gpc-vs-gpp",
      section: "usca",
      gpcField: 0,
      propertyValue: true,
      secGpcRequestCount: 12,
    });
  });

  it("reports the reverse: a string recording GPC while we sent none", () => {
    const obs = buildObservationSet({ signal: noSignal, gpp: gppWith("usca", { Gpc: 1 }) });
    const flags = evaluate(obs, classify).map((f) => f.flag);
    expect(flags).toContain("gpc-not-sent-gpp-field-yes");
  });

  it("says nothing when the two agree", () => {
    const agreeing = buildObservationSet({ signal: sentSignal, gpp: gppWith("usca", { Gpc: 1 }) });
    const other = buildObservationSet({ signal: noSignal, gpp: gppWith("usca", { Gpc: 0 }) });
    for (const obs of [agreeing, other]) {
      expect(evaluate(obs, classify).some((f) => f.flag.startsWith("gpc-"))).toBe(false);
    }
  });

  it("says nothing when the string carries no GPC field", () => {
    // Silence is not a statement, and most strings are silent. Firing here would put a
    // notice on nearly every GPP site and tell the reader nothing.
    const obs = buildObservationSet({ signal: sentSignal, gpp: gppWith("usca", { SaleOptOut: 2 }) });
    expect(evaluate(obs, classify).some((f) => f.flag.startsWith("gpc-"))).toBe(false);
  });

  it("says nothing when the string could not be decoded", () => {
    const obs = buildObservationSet({
      signal: sentSignal,
      gpp: { ...gppWith("usca", { Gpc: 0 }), unparseable: true },
    });
    expect(evaluate(obs, classify).some((f) => f.flag.startsWith("gpc-"))).toBe(false);
  });

  it("requires BOTH sent-surfaces to agree before calling the signal sent", () => {
    // A consent tool can consult the property or the request header, so this
    // two-mechanism question is never decided from one mechanism.
    const propertyOnly = buildObservationSet({
      signal: { ...sentSignal, secGpcRequestCount: 0 },
      gpp: gppWith("usca", { Gpc: 0 }),
    });
    const wireOnly = buildObservationSet({
      signal: { ...sentSignal, propertyValue: false },
      gpp: gppWith("usca", { Gpc: 0 }),
    });
    for (const obs of [propertyOnly, wireOnly]) {
      expect(evaluate(obs, classify).some((f) => f.flag.startsWith("gpc-"))).toBe(false);
    }
  });

  it("reads the section the popup displays, not the first with a Gpc field", () => {
    // usca records Gpc 0, usnat records Gpc 1 and states an opt-out. The GPP row shows
    // usnat, so the rule judges usnat: GPC sent and recorded, no disagreement. Both key
    // orders, because the choice must not follow insertion order.
    const usca = { Gpc: 0 };
    const usnat = { Gpc: 1, SaleOptOut: 1 };
    for (const sections of [{ usca, usnat }, { usnat, usca }]) {
      const obs = buildObservationSet({ signal: sentSignal, gpp: { ...gppWith("usca", usca), sections } });
      expect(evaluate(obs, classify).some((f) => f.flag.startsWith("gpc-"))).toBe(false);
    }
  });

  it("records the primary section in the artifact", () => {
    // usnat states an opt-out and records Gpc 0, so it is primary over usca's bare Gpc 1.
    const obs = buildObservationSet({
      signal: sentSignal,
      gpp: { ...gppWith("usca", {}), sections: { usca: { Gpc: 1 }, usnat: { Gpc: 0, SaleOptOut: 2 } } },
    });
    const f = evaluate(obs, classify).find((x) => x.flag === "gpc-sent-gpp-field-no");
    expect(f?.artifact).toMatchObject({ kind: "gpc-vs-gpp", section: "usnat", gpcField: 0 });
  });

  it("judges a section reported under its pre-rename IAB name", () => {
    // A consent tool on an older IAB library names section 7 usnatv1 (streaming-e.example, 2026-10-02):
    // the same section as usnat, so Gpc 0 beside a sent signal is the same mismatch.
    const obs = buildObservationSet({
      signal: sentSignal,
      gpp: { ...gppWith("usnat", {}), sections: { uspv1: {}, usnatv1: { Gpc: 0, SaleOptOut: 1 } } },
    });
    const f = evaluate(obs, classify).find((x) => x.flag === "gpc-sent-gpp-field-no");
    expect(f?.artifact).toMatchObject({ kind: "gpc-vs-gpp", section: "usnatv1", gpcField: 0 });
  });

  it("sorts below the flagship and the cookie findings", () => {
    // Context, not accusation. A contradiction inside the site's own string outranks the
    // two of us disagreeing.
    const obs = buildObservationSet({
      signal: noSignal,
      gpp: gppWith("usca", { Gpc: 1, SaleOptOut: 2 }),
      network: [
        request({ url: "https://ad.doubleclick.net/x", setCookies: [cookie({ name: "IDE" })] }),
      ],
    });
    const flags = evaluate(obs, classify).map((f) => f.flag);
    const mismatch = flags.indexOf("gpc-not-sent-gpp-field-yes");
    expect(mismatch).toBeGreaterThan(flags.indexOf("gpp-conflict"));
  });

  it("does not suppress gpp-conflict, which is internal to the string", () => {
    // The IAB defines that conflict within the string itself; whether WE were sending has
    // no bearing on it.
    const obs = buildObservationSet({ signal: noSignal, gpp: gppWith("usca", { Gpc: 1, SaleOptOut: 2 }) });
    expect(evaluate(obs, classify).some((f) => f.flag === "gpp-conflict")).toBe(true);
  });
});

describe("engine determinism and ordering", () => {
  it("orders findings by rank ascending (mechanical unambiguity first)", () => {
    const obs = buildObservationSet({
      gpp: gppWith("usca", { Gpc: 1, SaleOptOut: 2 }),
      network: [
        request({ url: "https://ad.doubleclick.net/x", setCookies: [cookie({ name: "IDE" })] }),
      ],
      confirmationNotice: "not-detected",
    });
    const findings = evaluate(obs, classify);
    const ranks = findings.map((f) => f.rank);
    const sorted = [...ranks].sort((a, b) => a - b);
    expect(ranks).toEqual(sorted);
    // cookie (10) should come before confirmation-not-detected (50)
    const cookieIdx = findings.findIndex((f) => f.flag === "cookie-set-with-signal");
    const confIdx = findings.findIndex((f) => f.flag === "confirmation-not-detected");
    expect(cookieIdx).toBeLessThan(confIdx);
  });

  it("produces byte-identical output across repeated runs (NFR-3)", () => {
    const build = () =>
      buildObservationSet({
        gpp: gppWith("usca", { Gpc: 1, SaleOptOut: 2, TargetedAdvertisingOptOut: 2 }),
        network: [
          request({ url: "https://ad.doubleclick.net/x", setCookies: [cookie({ name: "IDE" })] }),
          request({ url: "https://criteo.com/e", setCookies: [cookie({ name: "uid" })] }),
        ],
        confirmationNotice: "not-detected",
      });
    resetIds();
    const a = JSON.stringify(evaluate(build(), classify));
    resetIds();
    const b = JSON.stringify(evaluate(build(), classify));
    expect(a).toBe(b);
  });
});

describe("distinct vs per-event cookie counting (the badge number)", () => {
  it("counts a refreshed cookie once, though the event fired repeatedly", () => {
    // Observed live: an ad slot re-setting IDE every ~30s drove the badge from 44 to 53
    // while the page sat idle. Both counts are true; only one is stable.
    const obs = buildObservationSet({
      network: [
        request({ url: "https://ad.doubleclick.net/1", setCookies: [cookie({ name: "IDE", domain: ".doubleclick.net" })] }),
        request({ url: "https://ad.doubleclick.net/2", setCookies: [cookie({ name: "IDE", domain: ".doubleclick.net" })] }),
        request({ url: "https://ad.doubleclick.net/3", setCookies: [cookie({ name: "IDE", domain: ".doubleclick.net" })] }),
      ],
    });
    expect(countCookiesSetWithSignal(obs, classify)).toBe(3);
    expect(countDistinctCookiesSetWithSignal(obs, classify)).toBe(1);
  });

  it("does not count a deletion as a cookie set, as a finding or in a count", () => {
    // An expiry in the past removes a cookie (max-age=0 is recorded as 0). Counting it
    // counts a vendor's clean-up against it; probe cookies set and removed within a second
    // were counted twice (2026-09-22).
    const obs = buildObservationSet({
      network: [
        request({ url: "https://ad.doubleclick.net/x", timeMs: 1_000, setCookies: [cookie({ name: "probe", domain: ".doubleclick.net", expiresMs: 0 })] }),
        request({ url: "https://ad.doubleclick.net/y", timeMs: 1_000, setCookies: [cookie({ name: "old", domain: ".doubleclick.net", expiresMs: 500 })] }),
      ],
    });
    expect(countDistinctCookiesSetWithSignal(obs, classify)).toBe(0);
    expect(countCookiesSetWithSignal(obs, classify)).toBe(0);
    expect(cookieSetWithSignal(obs, classify)).toEqual([]);
  });

  it("counts the same cookie name on different domains separately", () => {
    const obs = buildObservationSet({
      network: [
        request({ url: "https://ad.doubleclick.net/x", setCookies: [cookie({ name: "uid", domain: ".doubleclick.net" })] }),
        request({ url: "https://criteo.com/x", setCookies: [cookie({ name: "uid", domain: ".criteo.com" })] }),
      ],
    });
    expect(countDistinctCookiesSetWithSignal(obs, classify)).toBe(2);
  });

  it("still excludes unclassified and unsigned requests", () => {
    const obs = buildObservationSet({
      network: [
        request({ url: "https://unknown-xyz.example/x", setCookies: [cookie({ name: "a" })] }),
        request({ url: "https://ad.doubleclick.net/x", secGpcPresent: false, setCookies: [cookie({ name: "b" })] }),
      ],
    });
    expect(countDistinctCookiesSetWithSignal(obs, classify)).toBe(0);
  });

  it("counts unsigned advertising cookies in their own counter, still excluding unclassified", () => {
    // The baseline for a with/without comparison. Same classification rule as the signed
    // count, opposite signal test, never summed with it.
    const obs = buildObservationSet({
      network: [
        request({ url: "https://unknown-xyz.example/x", secGpcPresent: false, setCookies: [cookie({ name: "a" })] }),
        request({ url: "https://ad.doubleclick.net/x", secGpcPresent: false, setCookies: [cookie({ name: "b", domain: ".doubleclick.net" })] }),
        request({ url: "https://ad.doubleclick.net/y", secGpcPresent: false, setCookies: [cookie({ name: "b", domain: ".doubleclick.net" })] }),
        request({ url: "https://ad.doubleclick.net/z", setCookies: [cookie({ name: "c", domain: ".doubleclick.net" })] }),
      ],
    });
    expect(countCookiesSetWithoutSignal(obs, classify)).toBe(2);
    expect(countDistinctCookiesSetWithoutSignal(obs, classify)).toBe(1);
    expect(countDistinctCookiesSetWithSignal(obs, classify)).toBe(1);
  });

  it("counts nothing from a response whose request was lost, with no tallies to read (1.26.0)", () => {
    const obs = buildObservationSet({
      network: [
        request({ url: "https://ad.doubleclick.net/x", secGpcPresent: false, requestLost: true, setCookies: [cookie({ name: "b", domain: ".doubleclick.net" })] }),
      ],
    });
    expect(countCookiesSetWithoutSignal(obs, classify)).toBe(0);
    expect(countDistinctCookiesSetWithoutSignal(obs, classify)).toBe(0);
    expect(countAdTechRequests(obs, classify)).toBe(0);
  });

  it("agrees with the per-event count when nothing repeats", () => {
    const obs = buildObservationSet({
      network: [
        request({ url: "https://ad.doubleclick.net/x", setCookies: [cookie({ name: "IDE", domain: ".doubleclick.net" })] }),
        request({ url: "https://criteo.com/x", setCookies: [cookie({ name: "uid", domain: ".criteo.com" })] }),
      ],
    });
    expect(countDistinctCookiesSetWithSignal(obs, classify)).toBe(
      countCookiesSetWithSignal(obs, classify),
    );
  });
});

describe("party matters once JS cookies are captured", () => {
  it("counts a third-party ad cookie in the headline number", () => {
    const o = buildObservationSet({
      network: [
        request({
          url: "https://ad.doubleclick.net/x",
          setCookies: [cookie({ name: "IDE", domain: ".doubleclick.net" })],
        }),
      ],
    });
    expect(countDistinctCookiesSetWithSignal(o, classify)).toBe(1);
  });

  it("excludes a FIRST-party cookie from the headline number", () => {
    // A first-party _ga written into the site's own jar is a real fact and a different
    // one: the vendor's code ran, but nothing crossed a site boundary in that act.
    // Counting it in the headline would inflate a number that does not describe it.
    const o = buildObservationSet({
      context: { topSite: "example.com" } as never,
      network: [
        request({
          url: "https://example.com/page",
          setCookies: [
            cookie({
              name: "_ga",
              domain: ".example.com",
              via: "documentCookie",
              writerScriptUrl: "https://www.google-analytics.com/analytics.js",
            } as never),
          ],
        }),
      ],
    });
    expect(countDistinctCookiesSetWithSignal(o, classify)).toBe(0);
  });

  it("counts an attributable first-party vendor cookie separately", () => {
    const o = buildObservationSet({
      context: { topSite: "example.com" } as never,
      network: [
        request({
          url: "https://example.com/page",
          setCookies: [
            cookie({
              name: "_ga",
              domain: ".example.com",
              via: "documentCookie",
              writerScriptUrl: "https://www.google-analytics.com/analytics.js",
            } as never),
          ],
        }),
      ],
    });
    expect(countFirstPartyVendorCookies(o, classify)).toBe(1);
  });

  it("does not count an UNATTRIBUTABLE JS cookie against a vendor", () => {
    // Without a writing script we cannot tell the site's own code from a vendor's.
    // Attributing on the strength of the cookie's name would be a guess.
    const o = buildObservationSet({
      context: { topSite: "example.com" } as never,
      network: [
        request({
          url: "https://example.com/page",
          setCookies: [
            cookie({
              name: "_ga",
              domain: ".example.com",
              via: "documentCookie",
              writerScriptUrl: null,
            } as never),
          ],
        }),
      ],
    });
    expect(countFirstPartyVendorCookies(o, classify)).toBe(0);
  });
});

describe("a bundle recorded before 1.23.0 still reads", () => {
  it("gives the same findings and counts with or without the cookie wrapper and coverage fields", () => {
    const js = (withNew: boolean) =>
      cookie({
        name: "_ga",
        domain: ".example.com",
        via: "documentCookie",
        writerScriptUrl: "https://www.google-analytics.com/analytics.js",
        writerViaTagManager: false,
        ...(withNew ? { writerWrapperUrl: "https://cmp.osano.com/x/osano.js" } : {}),
      });
    const build = (withNew: boolean) => {
      resetIds();
      const o = buildObservationSet({
        context: { topSite: "example.com" } as never,
        network: [
          request({ url: "https://ad.doubleclick.net/x", setCookies: [cookie({ name: "IDE", domain: ".doubleclick.net" })] }),
          request({ url: "https://example.com/page", setCookies: [js(withNew)] }),
        ],
      });
      return withNew
        ? { ...o, cookieCoverage: { wrappedOver: true, onInstance: false } }
        : { ...o, schemaVersion: "1.22.0" as typeof o.schemaVersion };
    };
    const older = build(false);
    const newer = build(true);
    expect(evaluate(older, classify)).toEqual(evaluate(newer, classify));
    expect(countDistinctCookiesSetWithSignal(older, classify)).toBe(1);
    expect(countFirstPartyVendorCookies(older, classify)).toBe(countFirstPartyVendorCookies(newer, classify));
  });
});

describe("declared-honor-cookie-set (FR-20)", () => {
  const declares = (over: Record<string, unknown> = {}) => ({
    url: "https://example.com/.well-known/gpc.json",
    present: true,
    gpc: true,
    lastUpdate: "2026-01-15",
    observedAtMs: Date.now(),
    fresh: true,
    reason: null,
    ...over,
  });

  const withAdCookie = () => [
    request({
      url: "https://ad.doubleclick.net/x",
      setCookies: [cookie({ name: "IDE", domain: ".doubleclick.net" })],
    }),
  ];

  it("fires when a fresh declaration of support meets ad cookies on signed requests", () => {
    // The strongest artifact-only claim in the product: both facts come from the site
    // itself — its own published file and its own responses.
    const obs = buildObservationSet({ wellKnown: declares(), network: withAdCookie() });
    expect(evaluate(obs, classify).some((f) => f.flag === "declared-honor-cookie-set")).toBe(true);
  });

  it("does NOT fire on a CACHED declaration", () => {
    // A site can retract the file at any time. An accusation resting on a statement that
    // may have been withdrawn is exactly the claim this product must not make.
    const obs = buildObservationSet({
      wellKnown: declares({ fresh: false }),
    tallies: {
      totalRequests: 0,
      signedRequests: 0,
      adVendorRequests: 0,
      adCookieEvents: 0,
      adCookieKeys: [],
      firstPartyVendorCookieKeys: [],
      byEntity: {},
    },
      network: withAdCookie(),
    });
    expect(evaluate(obs, classify).some((f) => f.flag === "declared-honor-cookie-set")).toBe(false);
  });

  it("does NOT fire when the file declares NON-support", () => {
    // Setting cookies after publicly saying you do not honor the signal is consistent
    // behavior, not a contradiction. Reporting it as one would punish a site for honesty.
    const obs = buildObservationSet({
      wellKnown: declares({ gpc: false }),
      network: withAdCookie(),
    });
    expect(evaluate(obs, classify).some((f) => f.flag === "declared-honor-cookie-set")).toBe(false);
  });

  it("does NOT fire when no file was found", () => {
    const obs = buildObservationSet({
      wellKnown: declares({ present: false, gpc: null, reason: "status 404" }),
      network: withAdCookie(),
    });
    expect(evaluate(obs, classify).some((f) => f.flag === "declared-honor-cookie-set")).toBe(false);
  });

  it("does NOT fire when the check never ran", () => {
    const obs = buildObservationSet({ wellKnown: null, network: withAdCookie() });
    expect(evaluate(obs, classify).some((f) => f.flag === "declared-honor-cookie-set")).toBe(false);
  });

  it("does NOT fire when a declaring site set no ad cookies — the compliant case", () => {
    const obs = buildObservationSet({ wellKnown: declares(), network: [] });
    expect(evaluate(obs, classify).some((f) => f.flag === "declared-honor-cookie-set")).toBe(false);
  });

  describe("rests on the cookies the headline counts, not on the writes", () => {
    const fired = (obs: ReturnType<typeof buildObservationSet>) =>
      evaluate(obs, classify).some((f) => f.flag === "declared-honor-cookie-set");
    const IDE_KEY = "IDE\u0000.doubleclick.net";
    const tallied = (over: Record<string, unknown>) => ({
      totalRequests: 3,
      signedRequests: 3,
      adVendorRequests: 1,
      adCookieEvents: 0,
      adCookieKeys: [] as string[],
      firstPartyVendorCookieKeys: [],
      byEntity: {},
      ...over,
    });

    it("does NOT fire when every counted write left the count: writes recorded, no cookie counted", () => {
      // The one counted cookie was not in the browser's jar when checked. Its key is out of
      // the count and its write is still in the write counter.
      const obs = buildObservationSet({
        wellKnown: declares(),
        tallies: tallied({ adCookieEvents: 1 }),
        network: [
          request({
            url: "https://ad.doubleclick.net/x",
            setCookies: [cookie({ name: "IDE", domain: ".doubleclick.net", jar: "not-stored" })],
          }),
        ],
      });
      expect(countDistinctCookiesSetWithSignal(obs, classify)).toBe(0);
      expect(fired(obs)).toBe(false);
      // The page's notice is a declaration too, and rests on the same count.
      expect(fired({ ...obs, wellKnown: null, confirmationNotice: "detected" })).toBe(false);
    });

    it("does NOT fire on a recorded request list whose only counted cookie the jar did not hold", () => {
      const obs = buildObservationSet({
        wellKnown: declares(),
        network: [
          request({
            url: "https://ad.doubleclick.net/x",
            setCookies: [cookie({ name: "IDE", domain: ".doubleclick.net", jar: "not-stored" })],
          }),
        ],
      });
      expect(fired(obs)).toBe(false);
    });

    it("fires on one counted cookie however many times it was written", () => {
      const obs = buildObservationSet({
        wellKnown: declares(),
        tallies: tallied({ adCookieEvents: 40, adCookieKeys: [IDE_KEY] }),
      });
      expect(fired(obs)).toBe(true);
    });

    it("reads a stored bundle as before: tallies with no later field, and a request list with none", () => {
      // Tallies as an early version stored them, with nothing but the counts: the finding
      // still rests on the counted key.
      const stored = buildObservationSet({
        wellKnown: declares(),
        tallies: tallied({ adCookieEvents: 2, adCookieKeys: [IDE_KEY] }),
        network: withAdCookie(),
      });
      expect(fired(stored)).toBe(true);
      // No tallies at all: both counts are read from the request list, and agree.
      const listed = buildObservationSet({ wellKnown: declares(), network: [...withAdCookie(), ...withAdCookie()] });
      expect(countCookiesSetWithSignal(listed, classify)).toBe(2);
      expect(countDistinctCookiesSetWithSignal(listed, classify)).toBe(1);
      expect(fired(listed)).toBe(true);
    });
  });

  describe("the page's confirmation notice is a declaration too", () => {
    const fires = (over: Parameters<typeof buildObservationSet>[0]) =>
      evaluate(buildObservationSet(over), classify).filter((f) => f.flag === "declared-honor-cookie-set");

    it("fires when the page showed the notice and ad cookies were set on signed requests", () => {
      // retailer-b.example: "Opt-Out Request Honored" on the page, 23 cookies, no gpc.json.
      expect(fires({ confirmationNotice: "detected", wellKnown: null, network: withAdCookie() })).toHaveLength(1);
    });

    it("fires once when the file and the notice both say so", () => {
      expect(fires({ confirmationNotice: "detected", wellKnown: declares(), network: withAdCookie() })).toHaveLength(1);
    });

    it("does NOT fire without cookies, whatever the notice says (retailer-f.example)", () => {
      expect(fires({ confirmationNotice: "detected", wellKnown: null, network: [] })).toHaveLength(0);
    });

    it("does NOT fire on a notice that was not found or not yet scanned", () => {
      expect(fires({ confirmationNotice: "not-detected", wellKnown: null, network: withAdCookie() })).toHaveLength(0);
      expect(fires({ confirmationNotice: "indeterminate", wellKnown: null, network: withAdCookie() })).toHaveLength(0);
    });

    it("names the statements it rests on", () => {
      const both = buildObservationSet({ confirmationNotice: "detected", wellKnown: declares() });
      expect(honorDeclarations(both)).toEqual({ wellKnown: true, confirmation: true });
      const stale = buildObservationSet({ confirmationNotice: "detected", wellKnown: declares({ fresh: false }) });
      expect(honorDeclarations(stale)).toEqual({ wellKnown: false, confirmation: true });
    });
  });
});

describe("vendor-signal-check", () => {
  const VENDOR_SIGNAL_FLAGS = new Set([
    "vendor-read-gpc",
    "vendor-did-not-read-gpc",
    "vendor-no-script-observed",
    "vendor-gpc-unread-via-container",
    "vendor-gpc-check-unattributable",
  ]);
  function vendorFlag(findings: readonly { flag: string; entity: { name: string } | null }[], name: string): string | undefined {
    return findings.find((f) => f.entity?.name === name && VENDOR_SIGNAL_FLAGS.has(f.flag))?.flag;
  }

  it("vendor-read-gpc: an attributable direct __gpp call from the vendor's own script", () => {
    const obs = buildObservationSet({
      network: [request({ url: "https://ad.doubleclick.net/tag.js", resourceType: "script" })],
      consentApiCalls: [
        consentApiCall({ callerScriptUrl: "https://ad.doubleclick.net/tag.js", viaTagManager: false }),
      ],
    });
    const findings = evaluate(obs, classify);
    expect(vendorFlag(findings, "Google")).toBe("vendor-read-gpc");
  });

  it("vendor-did-not-read-gpc: script ran directly, no container on the page, no call", () => {
    const obs = buildObservationSet({
      network: [request({ url: "https://static.criteo.com/js/tag.js", resourceType: "script" })],
    });
    const findings = evaluate(obs, classify);
    expect(vendorFlag(findings, "Criteo")).toBe("vendor-did-not-read-gpc");
  });

  it("vendor-no-script-observed: a vendor seen only through a tracking pixel", () => {
    // A vendor contacted only via a tracking pixel (no script, no XHR) stays distinct from
    // one whose ad-tech ran and never checked: the two never share a "no attributable
    // check" state.
    const obs = buildObservationSet({
      network: [request({ url: "https://bing.com/pixel.gif", resourceType: "image" })],
    });
    const findings = evaluate(obs, classify);
    expect(vendorFlag(findings, "Microsoft")).toBe("vendor-no-script-observed");
  });

  describe("judged from the tallies' summary when the requests were not retained (1.13.0)", () => {
    const tallyFor = (name: string, host: string, scriptRan: boolean | undefined) => ({
      totalRequests: 3, signedRequests: 3, adVendorRequests: 3, adCookieEvents: 0, adCookieKeys: [],
      adCookieEventsUnsigned: 0, adCookieKeysUnsigned: [], firstPartyVendorCookieKeys: [],
      byEntity: { [name]: { requests: 3, signedRequests: 3, cookieNames: [], cookiesReturned: [], hosts: [host], resourceTypes: scriptRan ? ["script"] : ["image"], ...(scriptRan === undefined ? {} : { scriptRan }) } },
    });

    it("its code ran, no container: did not read, with the tally artifact", () => {
      const obs = buildObservationSet({ network: [], tallies: tallyFor("Meta", "connect.facebook.com", true) });
      const findings = evaluate(obs, classify);
      expect(vendorFlag(findings, "Meta")).toBe("vendor-did-not-read-gpc");
      expect(findings.find((f) => f.entity?.name === "Meta")?.artifact).toEqual({ kind: "tally" });
    });

    it("only passive resources: no script observed, with the tally artifact", () => {
      const obs = buildObservationSet({ network: [], tallies: tallyFor("Microsoft", "bing.com", false) });
      const findings = evaluate(obs, classify);
      expect(vendorFlag(findings, "Microsoft")).toBe("vendor-no-script-observed");
      expect(findings.find((f) => f.entity?.name === "Microsoft")?.artifact).toEqual({ kind: "tally" });
    });

    it("a tally from before the summary existed gives no finding", () => {
      const obs = buildObservationSet({ network: [], tallies: tallyFor("Meta", "connect.facebook.com", undefined) });
      expect(vendorFlag(evaluate(obs, classify), "Meta")).toBeUndefined();
    });

    it("a retained request still wins over the summary for the artifact", () => {
      const obs = buildObservationSet({
        network: [request({ url: "https://connect.facebook.com/tag.js", resourceType: "script" })],
        tallies: tallyFor("Meta", "connect.facebook.com", true),
      });
      const f = evaluate(obs, classify).find((x) => x.entity?.name === "Meta");
      expect(f?.artifact.kind).toBe("network");
    });
  });

  it("vendor-gpc-unread-via-container: script ran, page has a container, container made zero GPC calls", () => {
    const obs = buildObservationSet({
      network: [request({ url: "https://connect.facebook.com/tag.js", resourceType: "script" })],
      gtm: { present: true, containerIds: ["GTM-X"], gtagIds: [], consentMode: null },
    });
    const findings = evaluate(obs, classify);
    expect(vendorFlag(findings, "Meta")).toBe("vendor-gpc-unread-via-container");
    const f = findings.find((f) => f.entity?.name === "Meta");
    expect(f?.artifact).toEqual({
      kind: "vendor-check-container",
      containerCallCount: 0,
      consentModeActive: false,
    });
  });

  it("vendor-gpc-check-unattributable: container made GPC calls, which tag is unknown", () => {
    const obs = buildObservationSet({
      network: [request({ url: "https://connect.facebook.com/tag.js", resourceType: "script" })],
      gtm: { present: true, containerIds: ["GTM-X"], gtagIds: [], consentMode: null },
      consentApiCalls: [
        consentApiCall({ callerScriptUrl: "https://www.googletagmanager.com/gtm.js", viaTagManager: true }),
      ],
    });
    const findings = evaluate(obs, classify);
    expect(vendorFlag(findings, "Meta")).toBe("vendor-gpc-check-unattributable");
    const f = findings.find((f) => f.entity?.name === "Meta");
    expect(f?.artifact).toEqual({
      kind: "vendor-check-container",
      containerCallCount: 1,
      consentModeActive: false,
    });
  });

  it("carries consentModeActive on the container artifact for the view-model's footnote, without it changing the state", () => {
    const obs = buildObservationSet({
      network: [request({ url: "https://connect.facebook.com/tag.js", resourceType: "script" })],
      gtm: {
        present: true,
        containerIds: ["GTM-X"],
        gtagIds: [],
        consentMode: {
          ad_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
          analytics_storage: "denied",
          functionality_storage: "unspecified",
          personalization_storage: "unspecified",
          security_storage: "unspecified",
        },
      },
    });
    const findings = evaluate(obs, classify);
    expect(vendorFlag(findings, "Meta")).toBe("vendor-gpc-unread-via-container");
    const f = findings.find((f) => f.entity?.name === "Meta");
    expect(f?.artifact).toMatchObject({ consentModeActive: true });
  });

  it("a JS-written cookie counts as script execution even when the resourceType is not script/xhr", () => {
    const obs = buildObservationSet({
      network: [
        request({
          url: "https://connect.facebook.com/beacon",
          resourceType: "other",
          captureMethod: "documentCookie",
          setCookies: [
            cookie({
              name: "fbp",
              via: "documentCookie",
              writerScriptUrl: "https://connect.facebook.com/tag.js",
            }),
          ],
        }),
      ],
    });
    const findings = evaluate(obs, classify);
    // No container present, so a script that ran and made no call is a direct claim.
    expect(vendorFlag(findings, "Meta")).toBe("vendor-did-not-read-gpc");
  });

  it("emits exactly one vendor-signal-check finding per entity", () => {
    const obs = buildObservationSet({
      network: [
        request({ url: "https://ad.doubleclick.net/tag.js", resourceType: "script" }),
        request({ url: "https://ad.doubleclick.net/pixel.gif", resourceType: "image" }),
      ],
    });
    const findings = evaluate(obs, classify).filter((f) => f.entity?.name === "Google");
    expect(findings.length).toBe(1);
  });

  // --- the second mechanism: a direct read of navigator.globalPrivacyControl ---

  it("vendor-read-gpc: an attributable direct property read, with no GPP call at all", () => {
    // Judged from __gpp calls alone, a vendor that read the property directly (the
    // mechanism the GPC spec defines for scripts) and never touched GPP would be reported
    // as not having read GPC: an absence not looked for, reported as one observed, under a
    // label naming the very mechanism not measured.
    const obs = buildObservationSet({
      network: [request({ url: "https://static.criteo.com/js/tag.js", resourceType: "script" })],
      signal: {
        readsByScript: { "https://static.criteo.com/js/tag.js": 3 },
        readAttribution: { sampled: 3, unattributed: 0, viaTagManager: 0 },
      },
    });
    const findings = evaluate(obs, classify);
    expect(vendorFlag(findings, "Criteo")).toBe("vendor-read-gpc");
    expect(findings.find((f) => f.entity?.name === "Criteo")?.artifact).toEqual({
      kind: "signal-read",
      readCount: 3,
    });
  });

  it("prefers the call artifact when a vendor both called GPP and read the property", () => {
    // A call count is exact; an attributed read count comes from a sample. When both are
    // available the evidence that does not need a caveat is the one to carry.
    const obs = buildObservationSet({
      network: [request({ url: "https://ad.doubleclick.net/tag.js", resourceType: "script" })],
      consentApiCalls: [
        consentApiCall({ callerScriptUrl: "https://ad.doubleclick.net/tag.js", viaTagManager: false }),
      ],
      signal: {
        readsByScript: { "https://ad.doubleclick.net/tag.js": 9 },
        readAttribution: { sampled: 9, unattributed: 0, viaTagManager: 0 },
      },
    });
    const findings = evaluate(obs, classify);
    expect(vendorFlag(findings, "Google")).toBe("vendor-read-gpc");
    // The read rides along: whether the call read GPC depends on the string, the read does not.
    expect(findings.find((f) => f.entity?.name === "Google")?.artifact).toEqual({
      kind: "consent-api",
      api: "__gpp",
      callCount: 1,
      readCount: 9,
    });
  });

  it("counts a container's property read as a container check, not just its GPP calls", () => {
    // The same case one level up: a container that reads the property is checking exactly
    // as much as one that calls GPP, and counting only calls would report "no check on the
    // page" while a check was demonstrably made.
    const obs = buildObservationSet({
      network: [request({ url: "https://connect.facebook.com/tag.js", resourceType: "script" })],
      gtm: { present: true, containerIds: ["GTM-X"], gtagIds: [], consentMode: null },
      signal: {
        readsByScript: {},
        readAttribution: { sampled: 1, unattributed: 0, viaTagManager: 1 },
      },
    });
    const findings = evaluate(obs, classify);
    expect(vendorFlag(findings, "Meta")).toBe("vendor-gpc-check-unattributable");
    expect(findings.find((f) => f.entity?.name === "Meta")?.artifact).toEqual({
      kind: "vendor-check-container",
      containerCallCount: 1,
      consentModeActive: false,
    });
  });

  it("does not turn a first-party read into a vendor, or into any state at all", () => {
    // A read attributed to the site's own script says nothing about a third-party vendor,
    // and must not conjure an entity that was never on the page.
    const obs = buildObservationSet({
      network: [request({ url: "https://static.criteo.com/js/tag.js", resourceType: "script" })],
      signal: {
        readsByScript: { "https://example.com/app.js": 12 },
        readAttribution: { sampled: 12, unattributed: 0, viaTagManager: 0 },
      },
    });
    const findings = evaluate(obs, classify);
    expect(vendorFlag(findings, "Criteo")).toBe("vendor-did-not-read-gpc");
    expect(findings.some((f) => f.entity?.name === "example.com")).toBe(false);
  });

  it("leaves every state alone when reads were sampled but none could be attributed", () => {
    // The common case: bundled and inline callers. Unattributed reads are evidence about
    // OUR reach, not about any vendor, and must move nothing.
    const obs = buildObservationSet({
      network: [request({ url: "https://static.criteo.com/js/tag.js", resourceType: "script" })],
      signal: {
        readsByScript: {},
        readAttribution: { sampled: 40, unattributed: 40, viaTagManager: 0 },
      },
    });
    expect(vendorFlag(evaluate(obs, classify), "Criteo")).toBe("vendor-did-not-read-gpc");
  });

  describe("a ping, by the version of the page's consent tool", () => {
    const pinged = (gppVersion: string | null) =>
      buildObservationSet({
        network: [request({ url: "https://static.criteo.com/js/tag.js", resourceType: "script" })],
        consentApiCalls: [
          consentApiCall({
            command: "ping",
            callerScriptUrl: "https://static.criteo.com/js/tag.js",
            viaTagManager: false,
          }),
        ],
        gpp: gppVersion === null ? null : { ...gppWith("usnat", { Gpc: 1 }), gppVersion },
      });

    it("does not count a GPP 1.0 ping as asking what the reader chose", () => {
      // Under 1.0, ping returns version and signal status and no string at all. Counting it
      // would let a vendor that only checked whether a CMP exists read as having asked for
      // the choice, and the help text for that state says the call carried it.
      expect(vendorFlag(evaluate(pinged("1.0"), classify), "Criteo")).toBe("vendor-did-not-read-gpc");
    });

    it("counts a GPP 1.1 ping, whose answer carries the string (health-c.example, 2026-09-30)", () => {
      // ID5 called only ping on health-c.example and news-f.example, and the 1.1 answer carried the
      // usnat string with Gpc. It read the choice, and not counting the ping would show it as
      // not reading it.
      const f = evaluate(pinged("1.1"), classify).find((x) => x.entity?.name === "Criteo");
      expect(f).toMatchObject({ flag: "vendor-read-gpc", artifact: { kind: "consent-api", api: "__gpp", callCount: 1 } });
    });

    it("does not count a ping when no answer reported a version", () => {
      // Nothing shows the ping returned a string.
      expect(vendorFlag(evaluate(pinged(null), classify), "Criteo")).toBe("vendor-did-not-read-gpc");
    });
  });

  it("counts a real GPP command from the same vendor", () => {
    const obs = buildObservationSet({
      network: [request({ url: "https://static.criteo.com/js/tag.js", resourceType: "script" })],
      consentApiCalls: [
        consentApiCall({
          command: "getGPPData",
          callerScriptUrl: "https://static.criteo.com/js/tag.js",
          viaTagManager: false,
        }),
      ],
    });
    expect(vendorFlag(evaluate(obs, classify), "Criteo")).toBe("vendor-read-gpc");
  });

  it("replays a bundle recorded before read attribution existed", () => {
    // Schema 1.9.0 carried no readAttribution. The rule must read it as "nothing
    // attributed" rather than throwing or inventing a check.
    const obs = buildObservationSet({
      network: [request({ url: "https://static.criteo.com/js/tag.js", resourceType: "script" })],
      signal: { readsByScript: {}, readAttribution: null },
    });
    expect(vendorFlag(evaluate(obs, classify), "Criteo")).toBe("vendor-did-not-read-gpc");
  });
});

describe("vendor-signal-check: one company, one category at a time", () => {
  // Hosts listed before the domains they sit under, since the first rule to match wins.
  const PAIRS = fakeClassifier([
    { match: "bat.bing.com", category: "advertising", entityName: "Microsoft" },
    { match: "clarity.ms", category: "analytics", entityName: "Microsoft" },
    { match: "bing.com", category: "content", entityName: "Microsoft" },
    { match: "doubleclick.net", category: "advertising", entityName: "Google" },
    { match: "google.com", category: "content", entityName: "Google" },
    { match: "facebook.net", category: "social", entityName: "Meta" },
    { match: "cookielaw.org", category: "consent-managers", entityName: "OneTrust" },
    { match: "criteo", category: "advertising", entityName: "Criteo" },
    // Disconnect names the owner and gives no category.
    { match: "techcrunch.com", category: "unknown", entityName: "Yahoo!" },
  ]);
  const VENDOR_FLAGS = new Set([
    "vendor-read-gpc", "vendor-did-not-read-gpc", "vendor-no-script-observed",
    "vendor-gpc-unread-via-container", "vendor-gpc-check-unattributable",
  ]);
  type F = ReturnType<typeof evaluate>;
  const states = (findings: F): Record<string, string> =>
    Object.fromEntries(
      findings.filter((f) => VENDOR_FLAGS.has(f.flag)).map((f) => [`${f.entity?.name} / ${f.entity?.category}`, f.flag]),
    );
  const script = (url: string) => request({ url, resourceType: "script" });
  const image = (url: string) => request({ url, resourceType: "image" });
  const reads = (...urls: string[]) => ({ readsByScript: Object.fromEntries(urls.map((u) => [u, 1])) });

  it("judges a company's categories apart", () => {
    // Microsoft's analytics script read the property. Its advertising script ran and did
    // not. Two facts about two products, and one company name.
    const obs = buildObservationSet({
      network: [script("https://bat.bing.com/bat.js"), script("https://www.clarity.ms/tag/x")],
      signal: reads("https://www.clarity.ms/tag/x"),
    });
    const findings = evaluate(obs, PAIRS);
    expect(states(findings)).toEqual({
      "Microsoft / analytics": "vendor-read-gpc",
      "Microsoft / advertising": "vendor-did-not-read-gpc",
    });
    const ad = findings.find((f) => f.entity?.name === "Microsoft" && f.entity.category === "advertising");
    expect(ad?.entity).toEqual({ name: "Microsoft", domains: ["bing.com"], category: "advertising" });
  });

  it("does not credit a pixel with a read made from another category's script", () => {
    const obs = buildObservationSet({
      network: [image("https://ad.doubleclick.net/pixel.gif"), script("https://www.google.com/recaptcha/api.js")],
      signal: reads("https://www.google.com/recaptcha/api.js"),
    });
    expect(states(evaluate(obs, PAIRS))).toEqual({
      "Google / advertising": "vendor-no-script-observed",
      "Google / content": "vendor-read-gpc",
    });
  });

  it("does not hold a pixel to a script that ran in another category and read nothing", () => {
    // Judged as one company, the script would put the pixel under "did not read": a claim
    // about the advertising tag made from another product.
    const obs = buildObservationSet({
      network: [image("https://ad.doubleclick.net/pixel.gif"), script("https://www.google.com/recaptcha/api.js")],
    });
    expect(states(evaluate(obs, PAIRS))).toEqual({
      "Google / advertising": "vendor-no-script-observed",
      "Google / content": "vendor-did-not-read-gpc",
    });
  });

  it("judges every category, and a company with an owner and no category", () => {
    const obs = buildObservationSet({
      network: [
        script("https://cdn.cookielaw.org/otSDKStub.js"),
        script("https://connect.facebook.net/en_US/fbevents.js"),
        image("https://techcrunch.com/pixel.gif"),
      ],
      consentApiCalls: [consentApiCall({ callerScriptUrl: "https://cdn.cookielaw.org/otSDKStub.js" })],
    });
    expect(states(evaluate(obs, PAIRS))).toEqual({
      "OneTrust / consent-managers": "vendor-read-gpc",
      "Meta / social": "vendor-did-not-read-gpc",
      "Yahoo! / unknown": "vendor-no-script-observed",
    });
  });

  it("judges nobody for the site's own requests or a domain with no company", () => {
    const obs = buildObservationSet({
      network: [script("https://example.com/app.js"), script("https://nobody.example/x.js")],
      signal: reads("https://example.com/app.js", "https://nobody.example/x.js"),
    });
    expect(states(evaluate(obs, PAIRS))).toEqual({});
  });

  it("counts the same with or without requests in the categories that do not count", () => {
    // Widening who is judged must never move a count. The same page with and without the
    // requests in categories that do not count, every one of them setting a cookie.
    const counted = () => [
      request({ url: "https://bat.bing.com/action/0", setCookies: [cookie({ name: "MUID", domain: ".bing.com" })] }),
      request({ url: "https://www.clarity.ms/tag/x", resourceType: "script", setCookies: [cookie({ name: "CLID", domain: ".clarity.ms" })] }),
      request({ url: "https://ad.doubleclick.net/x", secGpcPresent: false, setCookies: [cookie({ name: "IDE", domain: ".doubleclick.net" })] }),
    ];
    const others = () => [
      request({ url: "https://www.bing.com/sw.js", resourceType: "script", setCookies: [cookie({ name: "SRCHD", domain: ".bing.com" })] }),
      request({ url: "https://connect.facebook.net/en_US/fbevents.js", resourceType: "script", setCookies: [cookie({ name: "fr", domain: ".facebook.com" })] }),
      request({ url: "https://cdn.cookielaw.org/otSDKStub.js", resourceType: "script", setCookies: [cookie({ name: "OptanonConsent", domain: ".cookielaw.org" })] }),
      request({ url: "https://techcrunch.com/pixel.gif", setCookies: [cookie({ name: "A1", domain: ".techcrunch.com" })] }),
    ];
    resetIds();
    const without = buildObservationSet({ network: counted() });
    resetIds();
    const withOthers = buildObservationSet({ network: [...counted(), ...others()] });

    for (const count of [
      countCookiesSetWithSignal, countDistinctCookiesSetWithSignal, countCookiesSetWithoutSignal,
      countDistinctCookiesSetWithoutSignal, countFirstPartyVendorCookies, countAdTechRequests,
    ]) {
      expect(count(withOthers, PAIRS), count.name).toBe(count(without, PAIRS));
    }
    const cookieFindings = (o: typeof without) => evaluate(o, PAIRS).filter((f) => f.flag.startsWith("cookie-set"));
    expect(cookieFindings(withOthers)).toEqual(cookieFindings(without));
    expect(cookieFindings(withOthers)).toHaveLength(2);
    // And every company judged without them is judged the same with them.
    const before = states(evaluate(without, PAIRS));
    const after = states(evaluate(withOthers, PAIRS));
    for (const [pair, flag] of Object.entries(before)) expect(after[pair], pair).toBe(flag);
  });

  it("orders one company's findings by category, the same way every time", () => {
    const obs = buildObservationSet({
      network: [script("https://www.bing.com/sw.js"), script("https://www.clarity.ms/tag/x"), script("https://bat.bing.com/bat.js")],
    });
    const order = (o: typeof obs) => evaluate(o, PAIRS).filter((f) => f.entity?.name === "Microsoft").map((f) => f.entity?.category);
    expect(order(obs)).toEqual(["advertising", "analytics", "content"]);
    expect(order({ ...obs, network: [...obs.network].reverse() })).toEqual(["advertising", "analytics", "content"]);
  });

  describe("judged from the summaries when the requests were not retained (1.20.0)", () => {
    const base = {
      totalRequests: 6, signedRequests: 6, adVendorRequests: 4, adCookieEvents: 0, adCookieKeys: [],
      adCookieEventsUnsigned: 0, adCookieKeysUnsigned: [], firstPartyVendorCookieKeys: [],
    };
    const summary = (entity: string, category: string, host: string, scriptRan: boolean) => ({
      entity, category, requests: 2, signedRequests: 2, hosts: [host], resourceTypes: scriptRan ? ["script"] : ["image"],
      scriptRan, cookieKeys: [], cookieKeysUnsigned: [], cookiesReturned: [], probeCookies: [], refusedWrites: [],
    });
    const perCompany = {
      Microsoft: { requests: 4, signedRequests: 4, cookieNames: [], cookiesReturned: [], hosts: ["bat.bing.com", "www.clarity.ms"], resourceTypes: ["image", "script"], scriptRan: true },
    };

    it("takes each category's own answer", () => {
      const obs = buildObservationSet({
        network: [],
        tallies: {
          ...base,
          byEntity: perCompany,
          byEntityCategory: {
            "Microsoft\u0000advertising": summary("Microsoft", "advertising", "bat.bing.com", false),
            "Microsoft\u0000analytics": summary("Microsoft", "analytics", "www.clarity.ms", true),
            "Meta\u0000social": summary("Meta", "social", "connect.facebook.net", true),
          },
        },
      });
      const findings = evaluate(obs, PAIRS);
      expect(states(findings)).toEqual({
        "Microsoft / advertising": "vendor-no-script-observed",
        "Microsoft / analytics": "vendor-did-not-read-gpc",
        "Meta / social": "vendor-did-not-read-gpc",
      });
      expect(findings.find((f) => f.entity?.name === "Meta")?.artifact).toEqual({ kind: "tally" });
    });

    it("leaves out a summary the list no longer gives to that company and category", () => {
      const obs = buildObservationSet({
        network: [],
        tallies: { ...base, byEntity: {}, byEntityCategory: { "Meta\u0000advertising": summary("Meta", "advertising", "connect.facebook.net", true) } },
      });
      expect(states(evaluate(obs, PAIRS))).toEqual({});
    });

    it("gives each category the company's one answer for a tally from before the summaries", () => {
      const obs = buildObservationSet({ network: [], tallies: { ...base, byEntity: perCompany } });
      expect(states(evaluate(obs, PAIRS))).toEqual({
        "Microsoft / advertising": "vendor-did-not-read-gpc",
        "Microsoft / analytics": "vendor-did-not-read-gpc",
      });
    });
  });

  describe("a loader is credited with its own category's checks", () => {
    const loaded = (by: string) => [{
      key: "https://static.criteo.net/bidder.js", url: "https://static.criteo.net/bidder.js", element: "script" as const,
      loaders: [{
        insertedBy: [by], inlineFrames: false, currentScriptKey: null, containerUrls: [], via: "appendChild" as const,
        frameOrigin: "https://example.com", topFrame: true, count: 1, timeMs: 300,
      }],
    }];
    const GPT = "https://securepubads.g.doubleclick.net/tag/js/gpt.js";
    const RECAPTCHA = "https://www.google.com/recaptcha/api.js";
    const page = (readBy: string) => buildObservationSet({
      network: [script("https://static.criteo.net/bidder.js"), script(GPT), script(RECAPTCHA)],
      signal: reads(readBy),
      scriptInsertions: loaded(GPT),
    });

    it("names the loader's category, and counts a read from that category", () => {
      const f = evaluate(page(GPT), PAIRS).find((x) => x.entity?.name === "Criteo");
      expect(f?.flag).toBe("vendor-gpc-check-unattributable");
      expect(f?.artifact).toMatchObject({ kind: "vendor-check-loader", route: "loader", loader: { kind: "entity", name: "Google", category: "advertising" } });
    });

    it("does not count a read the same company made from another category", () => {
      // Google's advertising script loaded the bidder. Google's Content script read GPC.
      // The loader did not, so there is nothing it could have passed on.
      const findings = evaluate(page(RECAPTCHA), PAIRS);
      expect(states(findings)).toMatchObject({
        "Criteo / advertising": "vendor-did-not-read-gpc",
        "Google / advertising": "vendor-did-not-read-gpc",
        "Google / content": "vendor-read-gpc",
      });
    });

    it("marks a no-read the chain decided, and only that one (1.34.0)", () => {
      // The view says "neither did <loader>" only when the loader was checked.
      const criteo = (o: ReturnType<typeof page>) => evaluate(o, PAIRS).find((x) => x.entity?.name === "Criteo");
      expect(criteo(page(RECAPTCHA))?.artifact).toMatchObject({ kind: "network", chainChecked: true, loadedVia: [{ kind: "entity", name: "Google" }] });
      // A second script of the vendor's whose loader resolved to nothing: the chain is not
      // trusted, the loaders stay on the artifact, and nothing was checked of them.
      const unresolved = page(RECAPTCHA);
      const [first] = loaded(GPT);
      const partly = { ...unresolved, scriptInsertions: [...unresolved.scriptInsertions!, { ...first!, key: "https://static.criteo.net/other.js", url: "https://static.criteo.net/other.js", loaders: [{ ...first!.loaders[0]!, insertedBy: [] }] }] };
      const f = criteo(partly);
      expect(f?.flag).toBe("vendor-did-not-read-gpc");
      expect(f?.artifact).not.toHaveProperty("chainChecked");
    });
  });
});

describe("findings from the tallies, the same after a worker reclaim (1.22.0)", () => {
  const detail = (over: Partial<import("@gpc-inspector/schema").CookieDetail> = {}): import("@gpc-inspector/schema").CookieDetail => ({
    expiresMs: null, sameSite: "None", secure: true, partitioned: false, via: "onHeadersReceived",
    host: "ad.doubleclick.net", onRedirect: false, onRedirectSigned: false, firstSignedObservationId: "r1", ...over,
  });
  const pairTally = (over: Partial<import("@gpc-inspector/schema").EntityCategoryTally>): import("@gpc-inspector/schema").EntityCategoryTally => ({
    entity: "Google", category: "advertising", requests: 1, signedRequests: 1, hosts: ["ad.doubleclick.net"],
    resourceTypes: ["script"], scriptRan: true, cookieKeys: [], cookieKeysUnsigned: [], cookiesReturned: [],
    probeCookies: [], refusedWrites: [], firstObservationId: "r1", executionObservationId: "r1", ...over,
  });
  // Three Set-Cookie events of IDE (a refreshing ad slot), one of MUID on a redirect hop.
  const network = () => [
    request({ id: "r1", url: "https://ad.doubleclick.net/gpt.js", resourceType: "script", setCookies: [cookie({ name: "IDE", domain: ".doubleclick.net" })] }),
    request({ id: "r2", url: "https://ad.doubleclick.net/slot", setCookies: [cookie({ name: "IDE", domain: ".doubleclick.net" })] }),
    request({ id: "r3", url: "https://ad.doubleclick.net/slot", setCookies: [cookie({ name: "IDE", domain: ".doubleclick.net" })] }),
    request({ id: "r4", url: "https://bat.bing.com/action", statusCode: 302, isRedirectHop: true, setCookies: [cookie({ name: "MUID", domain: ".bing.com" })] }),
  ];
  const tallies = (): import("@gpc-inspector/schema").Tallies => ({
    totalRequests: 4, signedRequests: 4, adVendorRequests: 4, adCookieEvents: 4,
    adCookieKeys: ["IDE\u0000.doubleclick.net", "MUID\u0000.bing.com"],
    adCookieKeysUnsigned: ["ANON\u0000.doubleclick.net"],
    firstPartyVendorCookieKeys: [], byEntity: {},
    byEntityCategory: {
      "Google\u0000advertising": pairTally({ requests: 3, signedRequests: 3 }),
      "Microsoft\u0000advertising": pairTally({ entity: "Microsoft", hosts: ["bat.bing.com"], resourceTypes: ["image"], scriptRan: false, firstObservationId: "r4", executionObservationId: null }),
      // Seen only through a cookie its script wrote: no requests, and its code ran.
      "Criteo\u0000advertising": pairTally({ entity: "Criteo", requests: 0, signedRequests: 0, hosts: ["static.criteo.com"], resourceTypes: [], firstObservationId: "js-1", executionObservationId: "js-1" }),
    },
    cookieDetails: {
      "IDE\u0000.doubleclick.net": detail(),
      "MUID\u0000.bing.com": detail({ host: "bat.bing.com", onRedirect: true, onRedirectSigned: true, firstSignedObservationId: "r4" }),
      "ANON\u0000.doubleclick.net": detail({ firstSignedObservationId: null }),
    },
  });

  it("raises one cookie finding per distinct signed cookie, not one per Set-Cookie event", () => {
    const findings = cookieSetWithSignal(buildObservationSet({ network: network(), tallies: tallies() }), classify);
    expect(findings).toEqual([
      { flag: "cookie-set-with-signal", rank: findings[0]!.rank, entity: { name: "Google", domains: ["doubleclick.net"] }, artifact: { kind: "cookie", observationId: "r1", cookieName: "IDE" } },
      { flag: "cookie-set-on-redirect", rank: findings[1]!.rank, entity: { name: "Microsoft", domains: ["bing.com"] }, artifact: { kind: "cookie", observationId: "r4", cookieName: "MUID" } },
    ]);
  });

  it("reads tallies that hold cookies and no counted request as the record", () => {
    // A page restored without a request the worker saw, whose scripts wrote counted
    // cookies: the tallies have keys and totalRequests 0, and are still what is read.
    const t = { ...tallies(), totalRequests: 0, signedRequests: 0, adVendorRequests: 0 };
    const withList = buildObservationSet({ network: network(), tallies: t });
    const without = buildObservationSet({ network: [], tallies: t });
    expect(cookieSetWithSignal(without, classify)).toEqual(cookieSetWithSignal(withList, classify));
    expect(cookieSetWithSignal(without, classify)).toHaveLength(2);
    expect(countDistinctCookiesSetWithSignal(without, classify)).toBe(2);
  });

  it("gives the same findings, every rule, with the request list gone", () => {
    const withList = evaluate(buildObservationSet({ network: network(), tallies: tallies() }), classify);
    const without = evaluate(buildObservationSet({ network: [], tallies: tallies() }), classify);
    expect(without).toEqual(withList);
  });

  it("never reads the kept cookie records (1.27.0): they list rows, and count and judge nothing", () => {
    // Records of every cookie-setting request, plus one the tallies never saw, on sets with
    // and without tallies: the findings are those of the same set without them.
    const kept = network().map(({ initiator: _i, cookiesSent: _c, requestHeaders: _q, responseHeaders: _r, setCookies, ...rest }) => ({
      ...rest,
      setCookies: setCookies.map(({ value: _v, ...c }) => c),
    }));
    const extra = { ...kept[0]!, id: "k9", setCookies: [{ ...kept[0]!.setCookies[0]!, name: "EXTRA" }] };
    for (const base of [buildObservationSet({ network: [], tallies: tallies() }), buildObservationSet({ network: [] })]) {
      const withKept = { ...base, keptCookieResponses: [...kept, extra] };
      expect(evaluate(withKept, classify)).toEqual(evaluate(base, classify));
      expect(countDistinctCookiesSetWithSignal(withKept, classify)).toBe(countDistinctCookiesSetWithSignal(base, classify));
    }
  });

  it("judges vendors from the summaries alone, naming the request each recorded", () => {
    const findings = evaluate(buildObservationSet({ network: [], tallies: tallies() }), classify);
    const vendor = (name: string) => findings.find((f) => f.flag.startsWith("vendor-") && f.entity?.name === name);
    expect(vendor("Google")).toMatchObject({ flag: "vendor-did-not-read-gpc", artifact: { kind: "network", observationId: "r1" } });
    expect(vendor("Microsoft")).toMatchObject({ flag: "vendor-no-script-observed", artifact: { kind: "network", observationId: "r4" } });
    expect(vendor("Criteo")).toMatchObject({ flag: "vendor-did-not-read-gpc", artifact: { kind: "network", observationId: "js-1" } });
  });

  it("reads a bundle from before the details the same way, deriving them from its requests", () => {
    const { cookieDetails: _none, ...old } = tallies();
    const derived = cookieSetWithSignal(buildObservationSet({ network: network(), tallies: old }), classify);
    expect(derived).toEqual(cookieSetWithSignal(buildObservationSet({ network: network(), tallies: tallies() }), classify));
  });

  it("still reads a set with no tallies one finding per event, the only record it has", () => {
    const findings = cookieSetWithSignal(buildObservationSet({ network: network() }), classify);
    expect(findings.filter((f) => f.artifact.kind === "cookie" && f.artifact.cookieName === "IDE")).toHaveLength(3);
  });
});

describe("vendor-signal-check: a domain with no company (1.26.0)", () => {
  const DOMAINS = fakeClassifier([
    { match: "doubleclick.net", category: "advertising", entityName: "Google" },
    // Listed in a counting category with no company: stays under its category, not judged here.
    { match: "adnoco.net", category: "advertising" },
  ]);
  const VENDOR_FLAGS = new Set([
    "vendor-read-gpc", "vendor-did-not-read-gpc", "vendor-no-script-observed",
    "vendor-gpc-unread-via-container", "vendor-gpc-check-unattributable",
  ]);
  type F = ReturnType<typeof evaluate>;
  const domainStates = (findings: F): Record<string, string> =>
    Object.fromEntries(findings.filter((f) => VENDOR_FLAGS.has(f.flag) && f.entity?.unlisted === true).map((f) => [f.entity!.name, f.flag]));
  const companyFindings = (findings: F): F => findings.filter((f) => f.entity?.unlisted !== true);
  const script = (id: string, url: string) => request({ id, url, resourceType: "script" });
  const image = (id: string, url: string) => request({ id, url, resourceType: "image" });
  const GPC_JS = "https://assets.retailer-d-static.example/gpc.js";
  const CHAT_JS = "https://widget.chatco.io/w.js";
  const PIXEL = "https://img.pixelco.net/p.gif";
  const unlisted = (
    domain: string,
    over: Partial<import("@gpc-inspector/schema").UnlistedDomainTally> = {},
  ): import("@gpc-inspector/schema").UnlistedDomainTally => ({
    // Each with a cookie of this visit, so each is a row and is judged.
    domain, requests: 1, signedRequests: 1, hosts: [], resourceTypes: ["script"], cookieKeys: [`c\u0000.${domain}`], cookieKeysUnsigned: [],
    cookiesReturned: [], probeCookies: [], refusedWrites: [], scriptRan: true, scriptRanOutsideXhr: true,
    firstObservationId: null, executionObservationId: null, ...over,
  });
  const network = () => [
    script("g1", "https://securepubads.doubleclick.net/gpt.js"),
    script("t1", GPC_JS),
    script("c1", CHAT_JS),
    image("p1", PIXEL),
    script("n1", "https://tag.adnoco.net/t.js"),
  ];
  const tallies = (): import("@gpc-inspector/schema").Tallies => ({
    totalRequests: 5, signedRequests: 5, adVendorRequests: 2, adCookieEvents: 0, adCookieKeys: [],
    adCookieEventsUnsigned: 0, adCookieKeysUnsigned: [], firstPartyVendorCookieKeys: [], byEntity: {},
    byEntityCategory: {
      "Google\u0000advertising": {
        entity: "Google", category: "advertising", requests: 1, signedRequests: 1, hosts: ["securepubads.doubleclick.net"],
        resourceTypes: ["script"], scriptRan: true, cookieKeys: [], cookieKeysUnsigned: [], cookiesReturned: [],
        probeCookies: [], refusedWrites: [], firstObservationId: "g1", executionObservationId: "g1", scriptRanOutsideXhr: true,
      },
    },
    byUnlistedDomain: {
      "retailer-d-static.example": unlisted("retailer-d-static.example", { hosts: ["assets.retailer-d-static.example"], firstObservationId: "t1", executionObservationId: "t1" }),
      "chatco.io": unlisted("chatco.io", { hosts: ["widget.chatco.io"], firstObservationId: "c1", executionObservationId: "c1" }),
      "pixelco.net": unlisted("pixelco.net", { hosts: ["img.pixelco.net"], resourceTypes: ["image"], scriptRan: false, scriptRanOutsideXhr: false, firstObservationId: "p1" }),
    },
  });
  const page = (over: Parameters<typeof buildObservationSet>[0] = {}) =>
    buildObservationSet({ network: network(), tallies: tallies(), signal: { readsByScript: { [GPC_JS]: 3 } }, ...over });

  it("judges each domain to the same states as a company", () => {
    const findings = evaluate(page(), DOMAINS);
    expect(domainStates(findings)).toEqual({
      "retailer-d-static.example": "vendor-read-gpc",
      "chatco.io": "vendor-did-not-read-gpc",
      "pixelco.net": "vendor-no-script-observed",
    });
    const read = findings.find((f) => f.entity?.name === "retailer-d-static.example");
    expect(read?.entity).toEqual({ name: "retailer-d-static.example", domains: ["retailer-d-static.example"], unlisted: true });
    expect(read?.artifact).toEqual({ kind: "signal-read", readCount: 3 });
    expect(findings.find((f) => f.entity?.name === "chatco.io")?.artifact).toEqual({ kind: "network", observationId: "c1" });
    expect(findings.find((f) => f.entity?.name === "pixelco.net")?.artifact).toEqual({ kind: "network", observationId: "p1" });
  });

  it("counts a GPP call from the domain's script as a read, and a ping as none", () => {
    const calls = [consentApiCall({ callerScriptUrl: CHAT_JS, command: "ping" })];
    expect(domainStates(evaluate(page({ consentApiCalls: calls }), DOMAINS))["chatco.io"]).toBe("vendor-did-not-read-gpc");
    calls.push(consentApiCall({ callerScriptUrl: CHAT_JS }));
    const f = evaluate(page({ consentApiCalls: calls }), DOMAINS).find((x) => x.entity?.name === "chatco.io");
    expect(f).toMatchObject({ flag: "vendor-read-gpc", artifact: { kind: "consent-api", api: "__gpp", callCount: 1 } });
  });

  it("judges a domain on a page with a container as a company is judged", () => {
    const gtm = { present: true, containerIds: ["GTM-A"], gtagIds: [], consentMode: null };
    expect(domainStates(evaluate(page({ gtm }), DOMAINS))["chatco.io"]).toBe("vendor-gpc-unread-via-container");
    const read = { readsByScript: { [GPC_JS]: 3 }, readAttribution: { sampled: 4, unattributed: 0, viaTagManager: 2 } };
    const f = evaluate(page({ gtm, signal: read }), DOMAINS).find((x) => x.entity?.name === "chatco.io");
    expect(f).toMatchObject({ flag: "vendor-gpc-check-unattributable", artifact: { kind: "vendor-check-container", containerCallCount: 2 } });
  });

  it("resolves who loaded a domain's script, and judges it by that loader", () => {
    const record = (url: string, by: string, containerUrls: string[] = []) => ({
      key: url, url, element: "script" as const,
      loaders: [{
        insertedBy: [by], inlineFrames: false, currentScriptKey: null, containerUrls, via: "appendChild" as const,
        frameOrigin: "https://example.com", topFrame: true, count: 1, timeMs: 300,
      }],
    });
    const GTM = "https://www.googletagmanager.com/gtm.js?id=GTM-A";
    const findings = evaluate(
      page({
        gtm: { present: true, containerIds: ["GTM-A"], gtagIds: [], consentMode: null },
        scriptInsertions: [record(CHAT_JS, GTM, [GTM]), record(GPC_JS, "https://example.com/app.js")],
      }),
      DOMAINS,
    );
    const chat = findings.find((f) => f.entity?.name === "chatco.io");
    expect(chat).toMatchObject({
      flag: "vendor-gpc-unread-via-container",
      artifact: { kind: "vendor-check-loader", loader: { kind: "container", identity: { manager: "gtm", id: "GTM-A" } }, route: "loader" },
    });
    // The domain that read is "read" whoever loaded it, and the read names its loader too.
    expect(findings.find((f) => f.entity?.name === "retailer-d-static.example")).toMatchObject({
      flag: "vendor-read-gpc",
      artifact: { kind: "signal-read", readCount: 3, loadedVia: [{ kind: "site", url: "https://example.com/app.js" }] },
    });
  });

  it("names a company's loader on its read, a call or a sampled read alike", () => {
    const record = (url: string) => ({
      key: url, url, element: "script" as const,
      loaders: [{
        insertedBy: ["https://example.com/app.js"], inlineFrames: false, currentScriptKey: null, containerUrls: [], via: "appendChild" as const,
        frameOrigin: "https://example.com", topFrame: true, count: 1, timeMs: 300,
      }],
    });
    const GPT = "https://securepubads.doubleclick.net/gpt.js";
    const site = [{ kind: "site", url: "https://example.com/app.js" }];
    const called = evaluate(page({ scriptInsertions: [record(GPT)], consentApiCalls: [consentApiCall({ callerScriptUrl: GPT })] }), DOMAINS);
    expect(called.find((f) => f.entity?.name === "Google")?.artifact).toEqual({ kind: "consent-api", api: "__gpp", callCount: 1, loadedVia: site });
    const read = evaluate(page({ scriptInsertions: [record(GPT)], signal: { readsByScript: { [GPT]: 2 } } }), DOMAINS);
    expect(read.find((f) => f.entity?.name === "Google")?.artifact).toEqual({ kind: "signal-read", readCount: 2, loadedVia: site });
    // No records, no loaders: the artifact carries no loadedVia.
    expect(evaluate(page({ signal: { readsByScript: { [GPT]: 2 } } }), DOMAINS).find((f) => f.entity?.name === "Google")?.artifact).toEqual({ kind: "signal-read", readCount: 2 });
  });

  it("gives the same findings with the request list gone", () => {
    const withList = evaluate(page(), DOMAINS);
    const without = evaluate(page({ network: [] }), DOMAINS);
    expect(without).toEqual(withList);
    expect(domainStates(without)).toEqual(domainStates(withList));
  });

  it("changes no company's finding, and judges no domain in a bundle without the summary", () => {
    const { byUnlistedDomain: _none, ...older } = tallies();
    const before = evaluate(page({ tallies: older }), DOMAINS);
    const after = evaluate(page(), DOMAINS);
    expect(companyFindings(after)).toEqual(before);
    expect(before.some((f) => f.entity?.unlisted === true)).toBe(false);
    // Nor in one from before the summaries, judged from its requests.
    expect(evaluate(page({ tallies: undefined }), DOMAINS).some((f) => f.entity?.unlisted === true)).toBe(false);
  });

  it("judges no domain that is not a row: only contacted", () => {
    const t = tallies();
    const quiet = { ...t.byUnlistedDomain!["pixelco.net"]!, cookieKeys: [] };
    const findings = evaluate(page({ tallies: { ...t, byUnlistedDomain: { ...t.byUnlistedDomain, "pixelco.net": quiet } } }), DOMAINS);
    expect(Object.keys(domainStates(findings)).sort()).toEqual(["chatco.io", "retailer-d-static.example"]);
    // A cookie set without the signal, while it was on, is a row as a signed one is.
    const unsignedOnly = evaluate(page({ tallies: { ...t, byUnlistedDomain: { ...t.byUnlistedDomain, "pixelco.net": { ...quiet, cookieKeysUnsigned: ["c\u0000.pixelco.net"] } } } }), DOMAINS);
    expect(Object.keys(domainStates(unsignedOnly)).sort()).toEqual(["chatco.io", "pixelco.net", "retailer-d-static.example"]);
    // A probe or a refused write is a row as a cookie is.
    const probed = evaluate(page({ tallies: { ...t, byUnlistedDomain: { ...t.byUnlistedDomain, "pixelco.net": { ...quiet, probeCookies: ["p"] } } } }), DOMAINS);
    expect(domainStates(probed)["pixelco.net"]).toBe("vendor-no-script-observed");
  });

  it("judges a domain whose script read GPC and set nothing, where its summary is kept", () => {
    const t = tallies();
    const quiet = { ...t.byUnlistedDomain!["retailer-d-static.example"]!, cookieKeys: [] };
    const set = (byUnlistedDomain: import("@gpc-inspector/schema").Tallies["byUnlistedDomain"]) => ({ ...t, byUnlistedDomain });
    // A sampled read of the property.
    const read = evaluate(page({ tallies: set({ ...t.byUnlistedDomain, "retailer-d-static.example": quiet }) }), DOMAINS);
    expect(read.find((f) => f.entity?.name === "retailer-d-static.example")).toMatchObject({ flag: "vendor-read-gpc", artifact: { kind: "signal-read", readCount: 3 } });
    // A __gpp call, and a ping, which is no check.
    const quietChat = { ...t.byUnlistedDomain!["chatco.io"]!, cookieKeys: [] };
    const called = (command: string) =>
      evaluate(page({ tallies: set({ ...t.byUnlistedDomain, "chatco.io": quietChat }), consentApiCalls: [consentApiCall({ callerScriptUrl: CHAT_JS, command })] }), DOMAINS);
    expect(domainStates(called("getGPPData"))["chatco.io"]).toBe("vendor-read-gpc");
    expect(domainStates(called("ping"))["chatco.io"]).toBeUndefined();
    // No summary kept for it (past the cap): no row to show it in, so not judged.
    const { "retailer-d-static.example": _gone, ...rest } = t.byUnlistedDomain!;
    expect(domainStates(evaluate(page({ tallies: set(rest) }), DOMAINS))["retailer-d-static.example"]).toBeUndefined();
  });

  it("judges a domain whose only record is a refused write, on the summary alone", () => {
    const refused = unlisted("refuser.net", {
      requests: 0, signedRequests: 0, resourceTypes: [], cookieKeys: [], refusedWrites: ["wide (.com)"],
      scriptRan: true, scriptRanOutsideXhr: true,
    });
    const t = tallies();
    const f = evaluate(page({ tallies: { ...t, byUnlistedDomain: { ...t.byUnlistedDomain, "refuser.net": refused } } }), DOMAINS);
    expect(f.find((x) => x.entity?.name === "refuser.net")).toMatchObject({ flag: "vendor-did-not-read-gpc", artifact: { kind: "tally" } });
  });

  it("reads a summary stored by an early 1.26.0 build as not having run, with no observation", () => {
    const { scriptRan: _r, scriptRanOutsideXhr: _x, firstObservationId: _a, executionObservationId: _e, ...early } = unlisted("chatco.io", { hosts: ["widget.chatco.io"] });
    const t = tallies();
    const f = evaluate(page({ network: [], tallies: { ...t, byUnlistedDomain: { ...t.byUnlistedDomain, "chatco.io": early } } }), DOMAINS);
    expect(f.find((x) => x.entity?.name === "chatco.io")).toMatchObject({ flag: "vendor-no-script-observed", artifact: { kind: "tally" } });
  });

  it("does not judge a counted domain with no company, a company's, or the site's own", () => {
    const findings = evaluate(page({ network: [...network(), script("s1", "https://www.example.com/app.js")] }), DOMAINS);
    expect(Object.keys(domainStates(findings)).sort()).toEqual(["chatco.io", "pixelco.net", "retailer-d-static.example"]);
  });

  it("takes a cookie the domain's script wrote as its code running, where the requests are read", () => {
    // A bundle whose company summaries are absent reads the requests: the write is the proof.
    const { byEntityCategory: _e, ...t } = tallies();
    const js = cookie({ name: "rtd_js", domain: ".example.com", via: "documentCookie", writerScriptUrl: "https://img.pixelco.net/w.js" });
    const obs = page({
      tallies: { ...t, byUnlistedDomain: { "pixelco.net": unlisted("pixelco.net", { hosts: ["img.pixelco.net"], scriptRan: false, firstObservationId: "p1" }) } },
      network: [image("p1", PIXEL), request({ id: "js-1", url: "https://img.pixelco.net/w.js", method: "SCRIPT", setCookies: [js] })],
      signal: { readsByScript: {} },
    });
    const f = evaluate(obs, DOMAINS).find((x) => x.entity?.name === "pixelco.net");
    expect(f).toMatchObject({ flag: "vendor-did-not-read-gpc", artifact: { kind: "network", observationId: "js-1" } });
  });
});
