// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import {
  buildReport,
  cookieNamesCarried,
  evidenceFileName,
  exportPreview,
  trimBundleForIssue,
  MAX_URL_LENGTH,
  MAX_BUNDLE_CHARS,
  type Environment,
} from "../src/ui/feedback.js";
import { SCHEMA_VERSION } from "@gpc-inspector/schema";
import type { ObservationSet, EvidenceBundle } from "@gpc-inspector/schema";

const REPO = "https://github.com/gpc-inspector/gpc-inspector-extension";

const env: Environment = {
  extensionVersion: "1.0.0",
  browser: "Chrome/150",
  os: "macOS",
  listSource: "disconnect",
  listVersion: "2026-08-14",
};

function obs(over: Partial<ObservationSet> = {}): ObservationSet {
  return {
    schemaVersion: SCHEMA_VERSION,
    context: {
      finalUrl: "https://www.news-g.example/", topSite: "www.news-g.example",
      extensionVersion: "1.0.0", browserUserAgent: "t", os: "t",
      capturedAt: "2026-08-22T00:00:00.000Z", mode: "passive", incomplete: false,
    },
    signal: {
      secGpcRequestCount: 630, totalRequestCount: 630, source: "this-extension",
      propertyValue: true, readTracking: "active", readCount: 7, readsByScript: {}, readAttribution: null,
    },
    network: [], consentApiCalls: [], gpp: null, usPrivacy: null, tcf: null,
    gtm: { present: false, containerIds: [], gtagIds: [], consentMode: null },
    confirmationNotice: "not-detected", wellKnown: null,
    capabilities: {
      documentCookie: true, cookieStore: true, gpp: true,
      uspapi: true, tcfapi: true, dataLayer: true,
    },
    tallies: {
      totalRequests: 630, signedRequests: 630, adVendorRequests: 38,
      adCookieEvents: 0, adCookieKeys: [], firstPartyVendorCookieKeys: [],
      byEntity: { Google: { requests: 12, signedRequests: 12, cookieNames: [], cookiesReturned: [], hosts: [] } },
    },
    ...over,
  };
}

const bundle = (o: ObservationSet): EvidenceBundle =>
  ({
    schemaVersion: SCHEMA_VERSION, scanId: "test", createdAt: "2026-08-22T00:00:00.000Z",
    provenance: {
      schemaVersion: SCHEMA_VERSION, ruleSetVersion: "1.0.0", ruleSetHash: "",
      listSource: "disconnect", listVersion: "2026-08-14", listHash: "abc",
    },
    redacted: "redacted", observations: o, findings: [], bundleHash: "seal",
  }) as EvidenceBundle;

describe("bug and feature reports carry no page data", () => {
  it("a bug report mentions no site", () => {
    // The natural worry about a privacy tool's feedback button is what it uploads. A bug
    // report that carried browsing data would be worse than having no bug reporting.
    const r = buildReport(REPO, {
      kind: "bug", environment: env,
      settingsSummary: "send=true observe=true",
    });
    expect(r.body).not.toContain("news-g");
    expect(r.body).not.toContain("http");
    expect(r.clipboard).toBeNull();
  });

  it("names the Public Suffix List, which decides first or third party", () => {
    const r = buildReport(REPO, {
      kind: "bug", environment: { ...env, publicSuffixList: "2026-09-24_13-26-36_UTC 0a1b2c3" },
      settingsSummary: "send=true observe=true",
    });
    expect(r.body).toContain("- Public Suffix List: 2026-09-24_13-26-36_UTC 0a1b2c3");
  });

  it("a feature request carries only the extension version", () => {
    const r = buildReport(REPO, { kind: "feature", environment: env });
    expect(r.body).toContain("1.0.0");
    expect(r.body).not.toContain("news-g");
    expect(r.clipboard).toBeNull();
  });

  it("states the absence of page data rather than leaving it to inference", () => {
    // A real subject-and-value row, not a label with an EMPTY value cell: no row in the grid
    // has nothing on its right-hand side, on the screen whose whole job is to account for
    // what travels with the report.
    const r = buildReport(REPO, { kind: "feature", environment: env });
    const line = r.preview.find((p) => p.label === "previewPageData");
    expect(line).toBeDefined();
    expect(line?.valueKey).toBe("previewPageDataNone");
  });

  it("carries the settings and nothing about the current tab", () => {
    // Which capture mechanisms failed is a fact about the tab the popup was opened on, and
    // the report says nothing about the pages visited.
    const r = buildReport(REPO, {
      kind: "bug", environment: env,
      settingsSummary: "send=true observe=true badge=true wellknown=true observeScriptLoading=true capReadTraces=true",
    });
    expect(r.body).toContain("- Settings: send=true observe=true badge=true wellknown=true observeScriptLoading=true capReadTraces=true");
    expect(r.body).not.toContain("Capture");
  });

  it("shows the browser on a bug report and leaves it out of a feature request, which does not carry it", () => {
    const labels = (r: ReturnType<typeof buildReport>) => r.preview.map((p) => p.label);
    expect(labels(buildReport(REPO, { kind: "bug", environment: env, settingsSummary: "x" }))).toEqual([
      "previewVersion", "previewBrowser", "previewPageData",
    ]);
    expect(labels(buildReport(REPO, { kind: "feature", environment: env }))).toEqual(["previewVersion", "previewPageData"]);
    expect(buildReport(REPO, { kind: "feature", environment: env }).body).not.toContain("Chrome");
  });
});

describe("finding reports", () => {
  it("says why a capture is incomplete (1.22.0)", () => {
    const base = obs();
    const report = (context: ObservationSet["context"]) => {
      const o = { ...base, context };
      return buildReport(REPO, { kind: "finding", environment: env, observations: o, bundle: bundle(o) }).body;
    };
    expect(report(base.context)).toContain("Capture complete: yes");
    expect(report({ ...base.context, incomplete: true, incompleteReasons: ["worker-restarted"] })).toContain("Capture complete: no (worker-restarted)");
    expect(report({ ...base.context, incomplete: true })).toContain("Capture complete: no (reason not recorded)");
  });

  it("summarizes from the tallies, which are complete", () => {
    const o = obs();
    const r = buildReport(REPO, {
      kind: "finding", environment: env, observations: o, bundle: bundle(o),
    });
    expect(r.body).toContain("www.news-g.example");
    expect(r.body).toContain("38");
    expect(r.body).toContain("Google");
  });

  it("puts the bundle on the clipboard, never in the URL", () => {
    // GitHub's prefill is carried in the URL and caps out around 8KB. The better reason is
    // that a URL ends up in browser history and server logs; a clipboard does not.
    const o = obs();
    const r = buildReport(REPO, {
      kind: "finding", environment: env, observations: o, bundle: bundle(o),
    });
    expect(r.clipboard).not.toBeNull();
    expect(r.url).not.toContain("bundleHash");
  });

  it("keeps the URL under the prefill limit even for a huge capture", () => {
    const o = obs({
      tallies: {
        totalRequests: 50_000, signedRequests: 50_000, adVendorRequests: 9000,
        adCookieEvents: 4000, adCookieKeys: Array.from({ length: 2000 }, (_, i) => `c${i}`),
        firstPartyVendorCookieKeys: [],
        byEntity: Object.fromEntries(
          Array.from({ length: 400 }, (_, i) => [
            `Vendor${i}`, { requests: 5, signedRequests: 5, cookieNames: [], cookiesReturned: [], hosts: [] },
          ]),
        ),
      },
    });
    const r = buildReport(REPO, {
      kind: "finding", environment: env, observations: o, bundle: bundle(o),
    });
    expect(r.url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
  });

  it("titles the report with the site", () => {
    const o = obs();
    const r = buildReport(REPO, {
      kind: "finding", environment: env, observations: o, bundle: bundle(o),
    });
    expect(r.title).toBe("Looks wrong: www.news-g.example");
  });

  it("shows the site in the preview, so the person sees it before deciding", () => {
    const o = obs();
    const r = buildReport(REPO, {
      kind: "finding", environment: env, observations: o, bundle: bundle(o),
    });
    const site = r.preview.find((p) => p.label === "previewSite");
    expect(site?.value).toBe("www.news-g.example");
  });
});

describe("issue URL", () => {
  it("routes each kind to its own issue form template", () => {
    // Labels come from the template rather than being asserted in the URL. Passing `body=`
    // would bypass the template entirely and open a blank issue.
    const o = obs();
    expect(
      buildReport(REPO, { kind: "finding", environment: env, observations: o, bundle: bundle(o) }).url,
    ).toContain("template=looks-wrong.yml");
    expect(
      buildReport(REPO, { kind: "bug", environment: env, settingsSummary: "" }).url,
    ).toContain("template=bug.yml");
    expect(buildReport(REPO, { kind: "feature", environment: env }).url).toContain(
      "template=feature.yml",
    );
  });

  it("prefills by field id, not by a body parameter", () => {
    const r = buildReport(REPO, {
      kind: "bug", environment: env, settingsSummary: "x",
    });
    expect(r.url).toContain("environment=");
    expect(r.url).not.toContain("&body=");
  });

  it("points at the repository's new-issue endpoint", () => {
    expect(buildReport(REPO, { kind: "feature", environment: env }).url).toContain(
      "github.com/gpc-inspector/gpc-inspector-extension/issues/new",
    );
  });
});

describe("the issue body matches the copy flow", () => {
  it("asks the person to paste rather than asserting the copy already happened", () => {
    // Copying is an explicit press they may not have made. An issue body claiming a copy
    // that did not occur is the kind of small lie that makes a reporter distrust the rest.
    const o = obs();
    const r = buildReport(REPO, {
      kind: "finding", environment: env, observations: o, bundle: bundle(o),
    });
    // The bundle is pasted into the template's own field, so the body carries no paste
    // instructions: the template does.
    expect(r.clipboard).not.toBeNull();
  });

  it("does not put the bundle in the URL", () => {
    const o = obs();
    const r = buildReport(REPO, {
      kind: "finding", environment: env, observations: o, bundle: bundle(o),
    });
    expect(r.url).not.toContain("bundleHash");
  });

  it("keeps the paste target even when the body is truncated to fit the URL", () => {
    // Truncation must not remove the thing the instructions point at.
    const o = obs({
      tallies: {
        totalRequests: 50_000, signedRequests: 50_000, adVendorRequests: 9000,
        adCookieEvents: 4000, adCookieKeys: Array.from({ length: 3000 }, (_, i) => `c${i}`),
        firstPartyVendorCookieKeys: [],
        byEntity: Object.fromEntries(
          Array.from({ length: 500 }, (_, i) => [
            `Vendor${i}`, { requests: 5, signedRequests: 5, cookieNames: [], cookiesReturned: [], hosts: [] },
          ]),
        ),
      },
    });
    const r = buildReport(REPO, {
      kind: "finding", environment: env, observations: o, bundle: bundle(o),
    });
    expect(r.url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
  });
});

describe("GitHub's 65,536-character body limit", () => {
  function bigBundle(requests: number): EvidenceBundle {
    const network = Array.from({ length: requests }, (_, i) => ({
      id: `r${i}`,
      url: `https://securepubads.g.doubleclick.net/gampad/ads?gdfp_req=1&pvsid=${i}&u_w=1512`,
      method: "GET", resourceType: "image", initiator: "https://www.news-g.example",
      secGpcPresent: true,
      cookiesSent: [],
      requestHeaders: [{ name: "Sec-GPC", nameLower: "sec-gpc", value: "1" }],
      statusCode: 200, responseHeaders: null, isRedirectHop: false,
      setCookies: i % 12 === 0
        ? [{ name: "IDE", value: "REDACTED", domain: ".doubleclick.net", path: "/",
             expiresMs: 1849999999999, sameSite: "None", httpOnly: false, secure: true,
             partitioned: false, via: "onHeadersReceived" }]
        : [],
      captureMethod: "onHeadersReceived", timeMs: 1787427803647,
    }));
    const o = obs({ network } as Partial<ObservationSet>);
    return { ...bundle(o), observations: o };
  }

  it("trims a bundle that would exceed the limit", () => {
    // A 630-request page produces roughly 400,000 characters — six times over. GitHub
    // rejects the issue outright, so the bundle has to fit before it is offered.
    const r = trimBundleForIssue(bigBundle(630));
    expect(r.trimmed).toBe(true);
    expect(r.json.length).toBeLessThanOrEqual(MAX_BUNDLE_CHARS);
    expect(r.total).toBe(630);
    expect(r.kept).toBeLessThan(630);
  });

  it("cuts the cookie details when the tallies alone pass the budget (1.22.0)", () => {
    // A page with hundreds of distinct cookies carries tens of kilobytes of details: with no
    // requests at all the bundle can still be over, and the issue then fails.
    const detail = (i: number) => ({
      expiresMs: 1849999999999, sameSite: "None" as const, secure: true, partitioned: false, via: "onHeadersReceived" as const,
      host: "securepubads.g.doubleclick.net", onRedirect: false, onRedirectSigned: false, firstSignedObservationId: `r${i}`,
    });
    const heavy = (counted: number, other: number): EvidenceBundle => {
      const b = bigBundle(10);
      const keys = Array.from({ length: counted }, (_, i) => `c${i}\u0000.doubleclick.net`);
      const others = Array.from({ length: other }, (_, i) => `o${i}\u0000.doubleclick.net`);
      const tallies = {
        ...b.observations.tallies,
        adCookieKeys: keys,
        cookieDetails: Object.fromEntries([...keys, ...others].map((k, i) => [k, detail(i)])),
      };
      return { ...b, observations: { ...b.observations, tallies } };
    };

    // The details of cookies the headline does not count go first.
    const some = trimBundleForIssue(heavy(100, 400));
    const parsedSome = JSON.parse(some.json) as { cookieDetailsTruncated?: boolean; observations: { tallies: { cookieDetails?: Record<string, unknown> } } };
    expect(some.json.length).toBeLessThanOrEqual(MAX_BUNDLE_CHARS);
    expect(parsedSome.cookieDetailsTruncated).toBe(true);
    // Every request fit, and the bundle is still trimmed: the person is asked to attach it.
    expect(some).toMatchObject({ trimmed: true, detailsCut: true, kept: 10, total: 10 });
    expect(Object.keys(parsedSome.observations.tallies.cookieDetails ?? {})).toHaveLength(100);

    // Then all of them; the counts stay whole either way.
    const all = trimBundleForIssue(heavy(400, 0));
    const parsedAll = JSON.parse(all.json) as { cookieDetailsTruncated?: boolean; observations: { tallies: { cookieDetails?: unknown; adCookieKeys: string[] } } };
    expect(all.json.length).toBeLessThanOrEqual(MAX_BUNDLE_CHARS);
    expect(parsedAll.cookieDetailsTruncated).toBe(true);
    expect(parsedAll.observations.tallies.cookieDetails).toBeUndefined();
    expect(parsedAll.observations.tallies.adCookieKeys).toHaveLength(400);
  });

  describe("with kept cookie records (1.27.0)", () => {
    const kept = (id: string) => ({
      id, url: `https://securepubads.g.doubleclick.net/gampad/${id}`, method: "GET", resourceType: "image",
      statusCode: 200, secGpcPresent: true, isRedirectHop: false, captureMethod: "onHeadersReceived" as const,
      timeMs: 1787427803647,
      setCookies: [{ name: "IDE", domain: ".doubleclick.net", path: "/", expiresMs: 1849999999999, sameSite: "None" as const,
                     httpOnly: false, secure: true, partitioned: false, via: "onHeadersReceived" as const }],
    });
    const withKept = (b: EvidenceBundle, records: ReturnType<typeof kept>[]): EvidenceBundle =>
      ({ ...b, observations: { ...b.observations, keptCookieResponses: records } });
    type Parsed = {
      networkTruncated?: true;
      keptCookieResponsesTruncated?: true;
      observations: { network: { id: string; setCookies: unknown[] }[]; keptCookieResponses: { id: string }[] };
    };

    it("leaves out the records the list repeats, and then needs nothing else cut", () => {
      // Every cookie-setting request is kept twice while the list holds it. On news-g.example
      // the copies alone passed the budget, which would leave the pasted bundle no request.
      const b = bigBundle(60);
      const repeats = Array.from({ length: 300 }, (_, i) => kept(`r${i % 60}`));
      const r = trimBundleForIssue(withKept(b, repeats));
      const parsed = JSON.parse(r.json) as Parsed;
      expect(r.json.length).toBeLessThanOrEqual(MAX_BUNDLE_CHARS);
      expect(parsed.observations.network).toHaveLength(60);
      expect(parsed.observations.keptCookieResponses).toEqual([]);
      expect(r).toMatchObject({ trimmed: false, kept: 60, total: 60, detailsCut: false });
    });

    it("fits the records of requests a reclaim took as requests, after the ones that set a cookie", () => {
      const b = bigBundle(60);
      const lost = Array.from({ length: 2000 }, (_, i) => kept(`lost${i}`));
      const r = trimBundleForIssue(withKept(b, [kept("r0"), ...lost]));
      const parsed = JSON.parse(r.json) as Parsed;
      expect(r.json.length).toBeLessThanOrEqual(MAX_BUNDLE_CHARS);
      // The requests still listed that set a cookie come first, then as many lost ones as fit.
      const cookieSetting = b.observations.network.filter((o) => o.setCookies.length > 0).map((o) => o.id);
      expect(parsed.observations.network.map((o) => o.id)).toEqual(cookieSetting);
      expect(parsed.observations.keptCookieResponses.length).toBeGreaterThan(0);
      expect(parsed.observations.keptCookieResponses.every((k) => k.id.startsWith("lost"))).toBe(true);
      expect(parsed.networkTruncated).toBe(true);
      expect(parsed.keptCookieResponsesTruncated).toBe(true);
      expect(r).toMatchObject({ trimmed: true, total: 2060, kept: cookieSetting.length + parsed.observations.keptCookieResponses.length });
    });

    it("counts a record whose sets were all probes as no request, as the Requests tab lists none", () => {
      // Taken back out as it was from its request, it set nothing: the tab leaves it out, so
      // the report neither counts it nor spends the budget on it.
      const b = bigBundle(60);
      const probe = { ...kept("probe0"), setCookies: [] };
      const lost = Array.from({ length: 2000 }, (_, i) => kept(`lost${i}`));
      const r = trimBundleForIssue(withKept(b, [probe, ...lost]));
      const parsed = JSON.parse(r.json) as Parsed;
      expect(r.total).toBe(2060);
      expect(parsed.observations.keptCookieResponses[0]?.id).toBe("lost0");
      expect(parsed.observations.keptCookieResponses.some((k) => k.id === "probe0")).toBe(false);
    });
  });

  it("leaves a small bundle whole", () => {
    const r = trimBundleForIssue(bigBundle(10));
    expect(r.trimmed).toBe(false);
    expect(r.kept).toBe(10);
  });

  it("keeps the observations a finding refers to, above everything else", () => {
    // A report disputing a finding is worthless without the evidence for that finding.
    const big = bigBundle(630);
    const withFinding: EvidenceBundle = {
      ...big,
      findings: [
        { flag: "cookie-set-with-signal", rank: 10, entity: null,
          artifact: { kind: "cookie", observationId: "r624", cookieName: "IDE" } },
      ] as EvidenceBundle["findings"],
    };
    const r = trimBundleForIssue(withFinding);
    expect(r.json).toContain("r624");
  });

  it("prefers cookie-setting observations over ordinary ones", () => {
    const r = trimBundleForIssue(bigBundle(630));
    const parsed = JSON.parse(r.json) as { observations: { network: { setCookies: unknown[] }[] } };
    const withCookies = parsed.observations.network.filter((o) => o.setCookies.length > 0);
    expect(withCookies.length).toBeGreaterThan(0);
  });

  it("marks the bundle as truncated rather than letting it look complete", () => {
    const r = trimBundleForIssue(bigBundle(630));
    expect(r.json).toContain("networkTruncated");
  });

  it("carries the tallies whole, so counts survive trimming", () => {
    // The counts are what the report is about. Trimming changes what can be enumerated and
    // must never change what is counted.
    const r = trimBundleForIssue(bigBundle(630));
    const parsed = JSON.parse(r.json) as { observations: { tallies: { totalRequests: number } } };
    expect(parsed.observations.tallies.totalRequests).toBe(630);
  });

  it("keeps each container's record through trimming, the cookie details cut or not (1.25.0)", () => {
    // A few kilobytes that the Tag containers rows are drawn from, and not a provenance list.
    const b = bigBundle(630);
    const byContainer = {
      "gtm:GTM-XNWF100": {
        manager: "gtm" as const, id: "GTM-XNWF100", frameUrls: ["https://www.googletagmanager.com/gtm.js?id=GTM-XNWF100"],
        cookieKeys: ["nwf_byline\u0000.www.news-g.example"], cookieKeysUnsigned: [], probeCookies: [], refusedWrites: [],
      },
    };
    const withContainers = { ...b, observations: { ...b.observations, tallies: { ...b.observations.tallies, byContainer } } };
    const parsed = JSON.parse(trimBundleForIssue(withContainers).json) as { observations: { tallies: { byContainer?: unknown } } };
    expect(parsed.observations.tallies.byContainer).toEqual(byContainer);
  });

  it("offers the full bundle separately when trimming happened", () => {
    const big = bigBundle(630);
    const r = buildReport(REPO, {
      kind: "finding", environment: env, observations: big.observations, bundle: big,
    });
    expect(r.bundleTrim?.trimmed).toBe(true);
    expect(r.fullBundle).not.toBeNull();
    expect((r.fullBundle ?? "").length).toBeGreaterThan(MAX_BUNDLE_CHARS);
  });
});

describe("a finding report is always masked", () => {
  it("refuses a bundle sealed as unmasked", () => {
    // The report goes to a public issue tracker. There is no setting that lets values
    // into it, and the builder checks rather than trusting its caller.
    const o = obs();
    const unmasked = { ...bundle(o), redacted: "unmasked" } as EvidenceBundle;
    expect(() =>
      buildReport(REPO, { kind: "finding", environment: env, observations: o, bundle: unmasked }),
    ).toThrow();
  });

  it("states that the cookies row holds names and no values", () => {
    const o = obs();
    const r = buildReport(REPO, {
      kind: "finding", environment: env, observations: o, bundle: bundle(o),
    });
    const row = r.preview.find((l) => l.label === "previewCookies");
    expect(row?.valueKey).toBe("previewCookieNames");
  });
});

describe("the saved bundle's name", () => {
  it("is a log, with the site and the capture date", () => {
    const o = obs();
    expect(evidenceFileName(bundle(o))).toBe(
      `gpc-inspector-log-${o.context.topSite}-2026-08-22.json`,
    );
  });

  it("says so in the name when the file holds sensitive information", () => {
    const unmasked = { ...bundle(obs()), redacted: "unmasked" } as EvidenceBundle;
    expect(evidenceFileName(unmasked)).toBe(`gpc-inspector-log-${obs().context.topSite}-2026-08-22-sensitive.json`);
  });

  it("names the finding report's file as the masked log", () => {
    const o = obs();
    const r = buildReport(REPO, { kind: "finding", environment: env, observations: o, bundle: bundle(o) });
    expect(r.fileName).toBe(evidenceFileName(bundle(o)));
    expect(r.fileName).toMatch(/^gpc-inspector-log-.*\d\.json$/);
  });

  it("keeps only what a hostname can hold", () => {
    // The site came from a page. A path separator in it must never reach a file name.
    const o = obs({ context: { ...obs().context, topSite: "../Evil Site/x.com" } });
    expect(evidenceFileName(bundle(o))).toBe("gpc-inspector-log-evilsitex.com-2026-08-22.json");
  });

  it("still names the file for a page with no site", () => {
    const o = obs({ context: { ...obs().context, topSite: "" } });
    expect(evidenceFileName(bundle(o))).toBe("gpc-inspector-log-2026-08-22.json");
  });
});

describe("the export preview", () => {
  it("describes the record without values, as two of the three files hold it", () => {
    const cookies = exportPreview(env, obs()).find((l) => l.label === "previewCookies");
    expect(cookies?.valueKey).toBe("previewCookieNames");
  });

  it("counts requests and vendors into the translated sentence", () => {
    const requests = exportPreview(env, obs()).find((l) => l.label === "previewRequests");
    expect(requests).toMatchObject({ valueKey: "previewRequestsValue", valueSubstitution: ["630", "1"] });
  });
});

describe("the cookie names the record carries", () => {
  const cookie = (name: string, domain: string) => ({
    name, value: "", domain, path: "/", expiresMs: "session" as const, sameSite: "Lax" as const,
    httpOnly: false, secure: true, partitioned: false, via: "set-cookie-header",
  });

  it("counts every distinct name, wherever the record holds it, once", () => {
    // Not only the advertising and analytics keys: the record carries the first-party,
    // unlisted-domain and container cookies and the request list too.
    const base = obs();
    const o = obs({
      network: [
        { id: "r1", setCookies: [cookie("IDE", ".doubleclick.net")], cookiesSent: ["sent_only"] },
      ] as unknown as ObservationSet["network"],
      keptCookieResponses: [{ id: "k1", setCookies: [cookie("kept_only", ".example.com")] }] as unknown as NonNullable<ObservationSet["keptCookieResponses"]>,
      tallies: {
        ...base.tallies,
        adCookieKeys: ["IDE\u0000.doubleclick.net", "_ga\u0000.news-g.example"],
        adCookieKeysUnsigned: ["_ga\u0000.other.com"],
        probeCookies: { Google: ["probe"] },
        refusedCookieWrites: { Google: ["refused (com)"] },
        byContainer: {
          "gtm:GTM-X": {
            manager: "gtm", id: "GTM-X", frameUrls: [], cookieKeys: ["nwf_byline\u0000.www.news-g.example"],
            cookieKeysUnsigned: [], probeCookies: [], refusedWrites: [],
          },
        },
        byUnlistedDomain: {
          "health-a-group.example": {
            domain: "health-a-group.example", requests: 1, signedRequests: 1, hosts: [], resourceTypes: [],
            cookieKeys: [], cookieKeysUnsigned: ["cohsn_xs_id\u0000.health-a-group.example"], cookiesReturned: [],
            probeCookies: [], refusedWrites: [],
          },
        },
        firstParty: { cookieKeys: ["nwg-a\u0000.news-g.example"], cookieKeysUnsigned: [], vendorCookieKeysUnsigned: [] },
      },
    });
    expect([...cookieNamesCarried(o)].sort()).toEqual(
      ["IDE", "_ga", "cohsn_xs_id", "kept_only", "nwf_byline", "nwg-a", "probe", "refused", "sent_only"],
    );
    const row = exportPreview(env, o).find((l) => l.label === "previewCookies");
    expect(row?.valueSubstitution).toEqual(["9"]);
  });
});

describe("the provenance lists fit the issue too", () => {
  // A news front page, 2026-09-28: requestInitiators and scriptInsertions came to 93,000
  // characters between them, and the copy was 104,329 with no request in it. GitHub
  // rejects an issue body over 65,536.
  const insertion = (i: number) => ({
    url: `https://cdn.example.com/lib/script-${i}.js`,
    loaders: [{ insertedBy: [`https://www.example.com/app-${i}.js`], containerUrls: [] }],
  });
  const heavy = (): EvidenceBundle => {
    const o = obs();
    return bundle({
      ...o,
      scriptInsertions: Array.from({ length: 100 }, (_, i) => insertion(i)),
      requestInitiators: Array.from({ length: 900 }, (_, i) => insertion(i)),
    } as unknown as ObservationSet);
  };

  it("keeps the copy inside the budget", () => {
    const r = trimBundleForIssue(heavy());
    expect(r.json.length).toBeLessThanOrEqual(MAX_BUNDLE_CHARS);
    expect(r.trimmed).toBe(true);
  });

  it("says the lists were cut, and keeps the insertions before the initiators", () => {
    const parsed = JSON.parse(trimBundleForIssue(heavy()).json) as {
      provenanceTruncated?: boolean;
      observations: { scriptInsertions: unknown[]; requestInitiators: unknown[] };
    };
    expect(parsed.provenanceTruncated).toBe(true);
    expect(parsed.observations.scriptInsertions.length).toBe(100);
    expect(parsed.observations.requestInitiators.length).toBeLessThan(900);
  });

  it("reports the cut as its own, not as requests or cookie details left out", () => {
    // The screen chooses its sentence from these. With every request kept and the
    // details whole, it must not say the cookie details were left out.
    const o = obs();
    const r = trimBundleForIssue(
      bundle({
        ...o,
        requestInitiators: Array.from({ length: 900 }, (_, i) => insertion(i)),
      } as unknown as ObservationSet),
    );
    expect(r.provenanceCut).toBe(true);
    expect(r.detailsCut).toBe(false);
    expect(r.kept).toBe(r.total);
    expect(r.trimmed).toBe(true);
  });

  it("leaves a bundle that fits as it came", () => {
    const o = obs();
    const small = bundle({ ...o, scriptInsertions: [insertion(1)] } as unknown as ObservationSet);
    const r = trimBundleForIssue(small);
    expect(r.trimmed).toBe(false);
    expect(r.json).not.toContain("provenanceTruncated");
  });
});
