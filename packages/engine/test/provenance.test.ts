// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { checksByContainer } from "../src/provenance.js";
import { buildObservationSet as observationSet, consentApiCall } from "./helpers.js";

const GTM_A = "https://www.googletagmanager.com/gtm.js?id=GTM-A";
const GTM_A_DL2 = "https://www.googletagmanager.com/gtm.js?id=GTM-A&l=NF2DL";
const GTM_B = "https://www.googletagmanager.com/gtm.js?id=GTM-B";
const G_1 = "https://www.googletagmanager.com/gtag/js?id=G-1";

describe("checksByContainer", () => {
  it("counts container __gpp calls and sampled container reads under the innermost container", () => {
    const obs = observationSet({
      consentApiCalls: [
        consentApiCall({ callerScriptUrl: GTM_A, viaTagManager: true, containerUrls: [GTM_A] }),
        consentApiCall({ callerScriptUrl: GTM_A_DL2, viaTagManager: true, containerUrls: [GTM_A_DL2] }),
        // A Google tag inside container A: counted under the Google tag, the innermost.
        consentApiCall({ callerScriptUrl: G_1, viaTagManager: true, containerUrls: [G_1, GTM_A] }),
        consentApiCall({ callerScriptUrl: GTM_B, viaTagManager: true, containerUrls: [GTM_B], command: "ping" }),
        // A vendor's own call made from inside a container tag is the vendor's, not the container's.
        consentApiCall({ callerScriptUrl: "https://ad.doubleclick.net/tag.js", viaTagManager: false, containerUrls: [GTM_B] }),
      ],
      signal: {
        secGpcRequestCount: 0,
        totalRequestCount: 0,
        source: "this-extension",
        propertyValue: true,
        readTracking: "active",
        readCount: 100,
        readsByScript: {},
        readAttribution: { sampled: 5, unattributed: 0, viaTagManager: 5, viaTagManagerByContainer: { [GTM_B]: 4, [G_1]: 1 } },
      },
    });

    const by = checksByContainer(obs);
    expect(by.get("gtm:GTM-A")).toEqual({
      identity: { manager: "gtm", id: "GTM-A" },
      frameUrls: [GTM_A, GTM_A_DL2].sort(),
      checks: 2,
    });
    expect(by.get("gtag:G-1")?.checks).toBe(2);
    // B: the ping is not a check (no answer reported GPP 1.1); the four sampled reads are.
    expect(by.get("gtm:GTM-B")?.checks).toBe(4);
    expect(by.size).toBe(3);
    // The per-container counts sum to what the page-wide rule counts.
    let total = 0;
    for (const e of by.values()) total += e.checks;
    expect(total).toBe(2 + 2 + 4);
  });

  it("counts a container's ping where the consent tool answers GPP 1.1, whose ping carries the string", () => {
    const calls = [consentApiCall({ callerScriptUrl: GTM_B, viaTagManager: true, containerUrls: [GTM_B], command: "ping" })];
    const gpp = (gppVersion: string) => ({ rawString: "", applicableSections: [], gppVersion, sections: {}, unparseable: false, fromWire: null });
    expect(checksByContainer(observationSet({ consentApiCalls: calls, gpp: gpp("1.1") })).get("gtm:GTM-B")?.checks).toBe(1);
    expect(checksByContainer(observationSet({ consentApiCalls: calls, gpp: gpp("1.0") })).has("gtm:GTM-B")).toBe(false);
  });

  it("keeps a pre-1.12.0 bundle's container checks under an unnamed entry rather than losing them", () => {
    const obs = observationSet({
      consentApiCalls: [
        consentApiCall({ callerScriptUrl: "https://www.googletagmanager.com/gtm.js", viaTagManager: true }),
      ],
      signal: {
        secGpcRequestCount: 0,
        totalRequestCount: 0,
        source: "this-extension",
        propertyValue: true,
        readTracking: "active",
        readCount: 10,
        readsByScript: {},
        readAttribution: { sampled: 3, unattributed: 0, viaTagManager: 3 },
      },
    });
    const by = checksByContainer(obs);
    expect(by.size).toBe(1);
    expect(by.get("google:")).toEqual({ identity: { manager: "google", id: null }, frameUrls: [], checks: 4 });
  });

  it("is empty when no check resolved into a container", () => {
    const obs = observationSet({
      consentApiCalls: [consentApiCall({ callerScriptUrl: "https://ad.doubleclick.net/tag.js" })],
    });
    expect(checksByContainer(obs).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveLoaders
// ---------------------------------------------------------------------------

import { resolveLoaders, recordKeyOf } from "../src/provenance.js";
import { evaluate } from "../src/evaluate.js";
import { fakeClassifier, request } from "./helpers.js";
import { entityCategoryKey } from "@gpc-inspector/schema";
import type { ScriptInsertion, ScriptInsertionLoader, ScriptInsertionCoverage } from "@gpc-inspector/schema";

const classify = fakeClassifier([
  { match: "facebook", category: "advertising", entityName: "Meta" },
  { match: "criteo", category: "advertising", entityName: "Criteo" },
  { match: "prebid.example", category: "advertising", entityName: "Prebid" },
  { match: "scorecardresearch", category: "analytics", entityName: "comScore" },
  { match: "cookielaw", category: "consent-managers", entityName: "OneTrust" },
]);
/** The key of a company in the category the rules above give it. */
const CATEGORY_OF: Record<string, string> = { Meta: "advertising", Criteo: "advertising", Prebid: "advertising", comScore: "analytics", OneTrust: "consent-managers" };
const pair = (name: string): string => entityCategoryKey(name, CATEGORY_OF[name]!);
const GTM_CHILD = "https://www.googletagmanager.com/gtm.js?id=GTM-CHILD";
const GTAG = "https://www.googletagmanager.com/gtag/js?id=G-1";

function loader(over: Partial<ScriptInsertionLoader> = {}): ScriptInsertionLoader {
  return {
    insertedBy: [],
    inlineFrames: false,
    currentScriptKey: null,
    containerUrls: [],
    via: "appendChild",
    frameOrigin: "https://example.com",
    topFrame: true,
    count: 1,
    timeMs: 1,
    ...over,
  };
}
function rec(url: string, ...loaders: ScriptInsertionLoader[]): ScriptInsertion {
  return { key: recordKeyOf(url), url, element: "script", loaders };
}
const coverage = (wrappedOver: boolean): ScriptInsertionCoverage => ({
  recorded: 0, parser: 0, duplicates: 0, inline: 0, inlineResolvedByCurrentScript: 0, nonExecuting: 0,
  srcUnresolved: 0, stackFailed: 0, ambiguousContainer: 0, capExceeded: 0, wrappedOver, selfDisabled: false,
});
const set = (scriptInsertions: ScriptInsertion[], wrappedOver = false) =>
  observationSet({ scriptInsertions, scriptInsertionCoverage: coverage(wrappedOver) });

describe("recordKeyOf", () => {
  it("mirrors the capture's key: query and hash off, container id kept", () => {
    expect(recordKeyOf("https://v.example/a.js?cb=1#x")).toBe("https://v.example/a.js");
    expect(recordKeyOf(GTM_A + "&l=NF2DL")).toBe(GTM_A);
  });
});

describe("resolveLoaders", () => {
  it("resolves a container frame to that container, the innermost that names an id", () => {
    const r = resolveLoaders(set([rec("https://connect.facebook.net/tag.js", loader({ insertedBy: [GTAG, GTM_A], containerUrls: [GTAG, GTM_A] }))]), classify);
    expect(r.byPair.get(pair("Meta"))).toEqual([{ kind: "container", identity: { manager: "gtag", id: "G-1" }, ancestors: [], mixed: false }]);
  });

  it("skips an id-less Google helper frame to the container beneath it", () => {
    const helper = "https://www.googletagmanager.com/helper/postscribe.js";
    const r = resolveLoaders(set([rec("https://connect.facebook.net/tag.js", loader({ insertedBy: [helper, GTM_A], containerUrls: [helper, GTM_A] }))]), classify);
    expect(r.byPair.get(pair("Meta"))?.[0]).toMatchObject({ kind: "container", identity: { manager: "gtm", id: "GTM-A" } });
  });

  it("resolves a named frame: another entity, a bare host, or the site's own file", () => {
    const r = resolveLoaders(
      set([
        rec("https://connect.facebook.net/a.js", loader({ insertedBy: ["https://cdn.cookielaw.org/cmp.js"] })),
        rec("https://static.criteo.net/b.js", loader({ insertedBy: ["https://d111111abcdef8.cloudfront.net/loader.js"] })),
        rec("https://sb.scorecardresearch.com/c.js", loader({ insertedBy: ["https://example.com/static/app.js"] })),
      ]),
      classify,
    );
    expect(r.byPair.get(pair("Meta"))).toEqual([{ kind: "entity", name: "OneTrust", category: "consent-managers" }]);
    expect(r.byPair.get(pair("Criteo"))).toEqual([{ kind: "host", domain: "cloudfront.net" }]);
    expect(r.byPair.get(pair("comScore"))).toEqual([{ kind: "site", url: "https://example.com/static/app.js" }]);
  });

  it("rolls a domain the list names no company for up by its registrable domain, apart from the companies", () => {
    const r = resolveLoaders(
      set([
        rec("https://widget.chatco.io/w.js", loader({ insertedBy: [GTM_A], containerUrls: [GTM_A], timeMs: 400 })),
        rec("https://cdn.chatco.io/late.js", loader({ insertedBy: ["https://example.com/static/app.js"], timeMs: 900 })),
        rec("https://assets.nobodyelse.net/x.js", loader({ inlineFrames: true })),
        rec("https://connect.facebook.net/a.js", loader({ insertedBy: ["https://widget.chatco.io/w.js"] })),
      ]),
      classify,
    );
    expect(r.byDomain.get("chatco.io")).toEqual([
      { kind: "container", identity: { manager: "gtm", id: "GTM-A" }, ancestors: [], mixed: true },
      { kind: "site", url: "https://example.com/static/app.js" },
    ]);
    expect(r.firstInsertionByDomain.get("chatco.io")).toBe(400);
    expect(r.undeterminedDomains.has("nobodyelse.net")).toBe(true);
    // A company's roll-up is untouched by the domains': the domain's script is its loader, by host.
    expect(r.byPair.get(pair("Meta"))).toEqual([{ kind: "container", identity: { manager: "gtm", id: "GTM-A" }, ancestors: [], mixed: false }]);
    expect([...r.byPair.keys()]).toEqual([pair("Meta")]);
    // The site's own scripts and a company's are not domains.
    expect([...r.byDomain.keys()]).toEqual(["chatco.io"]);
  });

  it("inherits transitively: a loader the container inserted carries the container to what it inserts later", () => {
    const r = resolveLoaders(
      set([
        rec("https://connect.facebook.net/loader.js", loader({ insertedBy: [GTM_A], containerUrls: [GTM_A] })),
        rec("https://connect.facebook.net/late.js", loader({ insertedBy: ["https://connect.facebook.net/loader.js?v=2"] })),
        // A bidder loaded by a wrapper the container loaded resolves to the container.
        rec("https://prebid.example/prebid.js", loader({ insertedBy: [GTM_A], containerUrls: [GTM_A] })),
        rec("https://static.criteo.net/bidder.js", loader({ insertedBy: ["https://prebid.example/prebid.js"] })),
      ]),
      classify,
    );
    expect(r.byKey.get("https://connect.facebook.net/late.js")?.[0]).toMatchObject({ kind: "container", identity: { id: "GTM-A" } });
    expect(r.byPair.get(pair("Criteo"))?.[0]).toMatchObject({ kind: "container", identity: { id: "GTM-A" } });
  });

  it("resolves an inline-only stack through currentScript: a site snippet, or a Custom HTML tag", () => {
    const r = resolveLoaders(
      set([
        // The site's parser-inserted snippet, named on the spot by the capture.
        { key: "inline:ab:1", url: "inline:ab:1", element: "script", loaders: [loader({ via: "parser" })] },
        rec("https://static.criteo.net/from-snippet.js", loader({ inlineFrames: true, currentScriptKey: "inline:ab:1" })),
        // A Custom HTML tag the container inserted, which then inserted the vendor from a callback.
        { key: "inline:ab:2", url: "inline:ab:2", element: "script", loaders: [loader({ insertedBy: [GTM_A], containerUrls: [GTM_A] })] },
        rec("https://connect.facebook.net/from-custom-html.js", loader({ inlineFrames: true, currentScriptKey: "inline:ab:2" })),
        // A deferred inline callback with no current script: undetermined.
        rec("https://sb.scorecardresearch.com/deferred.js", loader({ inlineFrames: true })),
      ]),
      classify,
    );
    expect(r.byPair.get(pair("Criteo"))).toEqual([{ kind: "site", url: null }]);
    expect(r.byPair.get(pair("Meta"))?.[0]).toMatchObject({ kind: "container", identity: { id: "GTM-A" } });
    expect(r.byPair.has(pair("comScore"))).toBe(false);
    expect(r.undeterminedPairs.has(pair("comScore"))).toBe(true);
  });

  it("resolves a parser-inserted script to the site in the top frame and to the owner in a sub-frame", () => {
    const r = resolveLoaders(
      set([
        rec("https://connect.facebook.net/in-html.js", loader({ via: "parser" })),
        rec("https://static.criteo.net/in-ad-frame.js", loader({ via: "parser", topFrame: false, frameOrigin: "https://ads.cookielaw.org" })),
      ]),
      classify,
    );
    expect(r.byPair.get(pair("Meta"))).toEqual([{ kind: "site", url: null }]);
    expect(r.byPair.get(pair("Criteo"))).toEqual([{ kind: "entity", name: "OneTrust", category: "consent-managers" }]);
  });

  it("builds the container graph and fills ancestors: two roots, a zone, a Google tag under a container", () => {
    const r = resolveLoaders(
      set([
        rec(GTM_A, loader({ via: "insertBefore", inlineFrames: true })),
        rec("https://www.googletagmanager.com/gtm.js?id=GTM-B", loader({ via: "insertBefore", inlineFrames: true })),
        rec(GTM_CHILD, loader({ insertedBy: [GTM_A], containerUrls: [GTM_A] })),
        rec(GTAG, loader({ insertedBy: [GTM_A], containerUrls: [GTM_A] })),
        rec("https://sb.scorecardresearch.com/from-child.js", loader({ insertedBy: [GTM_CHILD], containerUrls: [GTM_CHILD] })),
        rec("https://connect.facebook.net/from-gtag.js", loader({ insertedBy: [GTAG, GTM_A], containerUrls: [GTAG, GTM_A] })),
      ]),
      classify,
    );
    expect(r.parents.get("gtm:GTM-CHILD")).toEqual({ manager: "gtm", id: "GTM-A" });
    expect(r.parents.get("gtag:G-1")).toEqual({ manager: "gtm", id: "GTM-A" });
    expect(r.parents.has("gtm:GTM-A")).toBe(false);
    expect(r.parents.has("gtm:GTM-B")).toBe(false);
    expect(r.byPair.get(pair("comScore"))?.[0]).toMatchObject({ kind: "container", identity: { id: "GTM-CHILD" }, ancestors: [{ manager: "gtm", id: "GTM-A" }] });
    expect(r.byPair.get(pair("Meta"))?.[0]).toMatchObject({ kind: "container", identity: { id: "G-1" }, ancestors: [{ manager: "gtm", id: "GTM-A" }] });
  });

  it("marks an entity mixed when a container and a non-container both loaded it, keeping both", () => {
    const r = resolveLoaders(
      set([
        rec("https://static.criteo.net/a.js", loader({ insertedBy: [GTM_A], containerUrls: [GTM_A] })),
        rec("https://static.criteo.net/b.js", loader({ insertedBy: ["https://example.com/app.js"] })),
      ]),
      classify,
    );
    const ids = r.byPair.get(pair("Criteo"))!;
    expect(ids).toHaveLength(2);
    expect(ids.find((i) => i.kind === "container")).toMatchObject({ mixed: true });
  });

  it("removes a wrapper frame only when the observer saw itself wrapped over, and reports it", () => {
    const cmp = "https://cmp.osano.com/x/osano.js";
    const records = [
      ...Array.from({ length: 6 }, (_, i) => rec(`https://connect.facebook.net/${i}.js`, loader({ insertedBy: [cmp, GTM_A], containerUrls: [GTM_A] }))),
      rec("https://static.criteo.net/s.js", loader({ insertedBy: [cmp, "https://example.com/app.js"] })),
      rec("https://cdn.cookielaw.org/own.js", loader({ insertedBy: [cmp] })),
    ];
    const withFlag = resolveLoaders(set(records, true), classify);
    expect(withFlag.wrapperFrames).toEqual([cmp]);
    expect(withFlag.byPair.get(pair("Criteo"))).toEqual([{ kind: "site", url: "https://example.com/app.js" }]);
    // The CMP's own script, which it inserted alone, is undetermined rather than "loaded by the CMP".
    expect(withFlag.undeterminedPairs.has(pair("OneTrust"))).toBe(true);
    const withoutFlag = resolveLoaders(set(records, false), classify);
    expect(withoutFlag.wrapperFrames).toEqual([]);
    expect(withoutFlag.byPair.get(pair("Criteo"))?.[0]).toMatchObject({ kind: "host", domain: "osano.com" });
  });

  it("does not call a genuine loader a wrapper: a container leading every stack alone", () => {
    const records = Array.from({ length: 8 }, (_, i) => rec(`https://connect.facebook.net/${i}.js`, loader({ insertedBy: [GTM_A], containerUrls: [GTM_A] })));
    expect(resolveLoaders(set(records, true), classify).wrapperFrames).toEqual([]);
  });

  it("is empty for a bundle without insertion records", () => {
    const r = resolveLoaders(observationSet({}), classify);
    expect(r.byPair.size).toBe(0);
    expect(r.byKey.size).toBe(0);
    expect(r.parents.size).toBe(0);
  });
});

describe("vendor-signal-check attaches loadedVia without changing any flag", () => {
  const vendorFlags = new Set(["vendor-read-gpc", "vendor-did-not-read-gpc", "vendor-no-script-observed", "vendor-gpc-unread-via-container", "vendor-gpc-check-unattributable"]);
  const finding = (findings: readonly { flag: string; entity: { name: string } | null; artifact: unknown }[], name: string) =>
    findings.find((f) => f.entity?.name === name && vendorFlags.has(f.flag));

  it("a container-loaded vendor on a container page keeps its flag and gains the loader", () => {
    const obs = observationSet({
      network: [request({ url: "https://connect.facebook.net/tag.js", resourceType: "script" })],
      gtm: { present: true, containerIds: ["GTM-A"], gtagIds: [], consentMode: null },
      scriptInsertions: [rec("https://connect.facebook.net/tag.js", loader({ insertedBy: [GTM_A], containerUrls: [GTM_A] }))],
      scriptInsertionCoverage: coverage(false),
    });
    const f = finding(evaluate(obs, classify), "Meta");
    expect(f?.flag).toBe("vendor-gpc-unread-via-container");
    // A resolved vendor is judged by its chain, so the artifact is the loader kind, scoped
    // to that container.
    expect(f?.artifact).toEqual({
      kind: "vendor-check-loader",
      loader: { kind: "container", identity: { manager: "gtm", id: "GTM-A" }, ancestors: [], mixed: false },
      route: "loader",
      containerCallCount: 0,
      checkedBeforeLoad: null,
      consentModeActive: false,
      loadedVia: [{ kind: "container", identity: { manager: "gtm", id: "GTM-A" }, ancestors: [], mixed: false }],
    });
  });

  it("a site-loaded vendor with no container keeps 'did not read' and gains the loader on the network artifact", () => {
    const obs = observationSet({
      network: [request({ url: "https://static.criteo.net/tag.js", resourceType: "script" })],
      scriptInsertions: [rec("https://static.criteo.net/tag.js", loader({ insertedBy: ["https://example.com/app.js"] }))],
      scriptInsertionCoverage: coverage(false),
    });
    const f = finding(evaluate(obs, classify), "Criteo");
    expect(f?.flag).toBe("vendor-did-not-read-gpc");
    expect(f?.artifact).toMatchObject({ kind: "network", loadedVia: [{ kind: "site", url: "https://example.com/app.js" }] });
  });

  it("an undetermined vendor carries no loadedVia at all, the same as an old bundle", () => {
    const obs = observationSet({
      network: [request({ url: "https://static.criteo.net/tag.js", resourceType: "script" })],
      scriptInsertions: [rec("https://static.criteo.net/tag.js", loader({ inlineFrames: true }))],
      scriptInsertionCoverage: coverage(false),
    });
    const f = finding(evaluate(obs, classify), "Criteo");
    expect(f?.flag).toBe("vendor-did-not-read-gpc");
    expect("loadedVia" in (f!.artifact as object)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The loader-chain decision
// ---------------------------------------------------------------------------

describe("vendor-signal-check judges a fully resolved vendor by its loader chain", () => {
  const vendorFlags = new Set(["vendor-read-gpc", "vendor-did-not-read-gpc", "vendor-no-script-observed", "vendor-gpc-unread-via-container", "vendor-gpc-check-unattributable"]);
  const finding = (findings: readonly { flag: string; entity: { name: string } | null; artifact: unknown }[], name: string) =>
    findings.find((f) => f.entity?.name === name && vendorFlags.has(f.flag));
  const script = (url: string) => request({ url, resourceType: "script" });
  const containerCall = (url: string, timeMs: number) =>
    consentApiCall({ callerScriptUrl: url, viaTagManager: true, containerUrls: [url], timeMs });
  const page = (over: Parameters<typeof observationSet>[0]) =>
    observationSet({ gtm: { present: true, containerIds: ["GTM-A", "GTM-B"], gtagIds: [], consentMode: null }, scriptInsertionCoverage: coverage(false), ...over });
  const GTM_B = "https://www.googletagmanager.com/gtm.js?id=GTM-B";

  it("route loader: the container that inserted the vendor read GPC, and did so before the load", () => {
    const obs = page({
      network: [script("https://connect.facebook.net/tag.js")],
      consentApiCalls: [containerCall(GTM_A, 100)],
      scriptInsertions: [rec("https://connect.facebook.net/tag.js", loader({ insertedBy: [GTM_A], containerUrls: [GTM_A], timeMs: 500 }))],
    });
    const f = finding(evaluate(obs, classify), "Meta");
    expect(f?.flag).toBe("vendor-gpc-check-unattributable");
    expect(f?.artifact).toMatchObject({ kind: "vendor-check-loader", route: "loader", containerCallCount: 1, checkedBeforeLoad: true, loader: { kind: "container", identity: { id: "GTM-A" } } });
  });

  it("route ancestor: the vendor's own container made no read, its parent did; the child is judged like any container", () => {
    const obs = page({
      network: [script("https://sb.scorecardresearch.com/c.js")],
      consentApiCalls: [containerCall(GTM_A, 900)],
      scriptInsertions: [
        rec(GTM_CHILD, loader({ insertedBy: [GTM_A], containerUrls: [GTM_A], timeMs: 50 })),
        rec("https://sb.scorecardresearch.com/c.js", loader({ insertedBy: [GTM_CHILD], containerUrls: [GTM_CHILD], timeMs: 200 })),
      ],
    });
    const f = finding(evaluate(obs, classify), "comScore");
    // A parent's read does not reach the child's tags on its own: the state is the scoped
    // no-read; the parent that read rides along as context, with the order.
    expect(f?.flag).toBe("vendor-gpc-unread-via-container");
    expect(f?.artifact).toMatchObject({ kind: "vendor-check-loader", route: "ancestor", checkedBeforeLoad: false, loader: { kind: "container", identity: { id: "GTM-A" } } });
    expect((f?.artifact as { loadedVia?: readonly { kind: string }[] }).loadedVia?.[0]).toMatchObject({ kind: "container", identity: { id: "GTM-CHILD" } });
  });

  it("route loader, another entity: the wrapper that loaded the bidder read GPC (Prebid)", () => {
    const obs = page({
      gtm: { present: false, containerIds: [], gtagIds: [], consentMode: null },
      network: [script("https://static.criteo.net/bidder.js"), script("https://prebid.example/prebid.js")],
      consentApiCalls: [consentApiCall({ callerScriptUrl: "https://prebid.example/prebid.js", viaTagManager: false, timeMs: 100 })],
      scriptInsertions: [rec("https://static.criteo.net/bidder.js", loader({ insertedBy: ["https://prebid.example/prebid.js"], timeMs: 300 }))],
    });
    const findings = evaluate(obs, classify);
    expect(finding(findings, "Prebid")?.flag).toBe("vendor-read-gpc");
    const f = finding(findings, "Criteo");
    expect(f?.flag).toBe("vendor-gpc-check-unattributable");
    expect(f?.artifact).toMatchObject({ route: "loader", loader: { kind: "entity", name: "Prebid" }, checkedBeforeLoad: true });
  });

  it("route loader, the site: the site's own script read GPC and loaded the vendor; reads alone give no order", () => {
    const obs = page({
      gtm: { present: false, containerIds: [], gtagIds: [], consentMode: null },
      network: [script("https://static.criteo.net/tag.js")],
      signal: { readsByScript: { "https://example.com/app.js": 3 }, readAttribution: { sampled: 3, unattributed: 0, viaTagManager: 0 } },
      scriptInsertions: [rec("https://static.criteo.net/tag.js", loader({ insertedBy: ["https://example.com/app.js"] }))],
    });
    const f = finding(evaluate(obs, classify), "Criteo");
    expect(f?.flag).toBe("vendor-gpc-check-unattributable");
    expect(f?.artifact).toMatchObject({ route: "loader", loader: { kind: "site" }, containerCallCount: 3, checkedBeforeLoad: null });
  });

  it("route consent-mode: no loader read GPC, an unrelated container did and set Consent Mode", () => {
    const obs = page({
      gtm: { present: true, containerIds: ["GTM-A", "GTM-B"], gtagIds: [], consentMode: null, consentModeUpdateSetBy: GTM_B },
      network: [script("https://connect.facebook.net/tag.js")],
      consentApiCalls: [containerCall(GTM_B, 100)],
      scriptInsertions: [rec("https://connect.facebook.net/tag.js", loader({ insertedBy: [GTM_A], containerUrls: [GTM_A], timeMs: 500 }))],
    });
    const f = finding(evaluate(obs, classify), "Meta");
    expect(f?.flag).toBe("vendor-gpc-check-unattributable");
    expect(f?.artifact).toMatchObject({ route: "consent-mode", loader: { kind: "container", identity: { id: "GTM-B" } }, containerCallCount: 1 });
  });

  it("no read via the chain: another container's read with no Consent Mode route is not borrowed", () => {
    const obs = page({
      network: [script("https://connect.facebook.net/tag.js")],
      consentApiCalls: [containerCall(GTM_B, 100)],
      scriptInsertions: [rec("https://connect.facebook.net/tag.js", loader({ insertedBy: [GTM_A], containerUrls: [GTM_A] }))],
    });
    const f = finding(evaluate(obs, classify), "Meta");
    expect(f?.flag).toBe("vendor-gpc-unread-via-container");
    expect(f?.artifact).toMatchObject({ kind: "vendor-check-loader", route: "loader", containerCallCount: 0, loader: { kind: "container", identity: { id: "GTM-A" } } });
  });

  it("a site-loaded vendor on a container page that read GPC is 'did not read', not 'cannot determine'", () => {
    const obs = page({
      network: [script("https://static.criteo.net/tag.js")],
      consentApiCalls: [containerCall(GTM_A, 100)],
      scriptInsertions: [rec("https://static.criteo.net/tag.js", loader({ insertedBy: ["https://example.com/app.js"] }))],
    });
    const f = finding(evaluate(obs, classify), "Criteo");
    expect(f?.flag).toBe("vendor-did-not-read-gpc");
    expect(f?.artifact).toMatchObject({ kind: "network", loadedVia: [{ kind: "site", url: "https://example.com/app.js" }] });
  });

  it("the mixed case takes the container path", () => {
    const obs = page({
      network: [script("https://static.criteo.net/a.js"), script("https://static.criteo.net/b.js")],
      consentApiCalls: [containerCall(GTM_A, 100)],
      scriptInsertions: [
        rec("https://static.criteo.net/a.js", loader({ insertedBy: [GTM_A], containerUrls: [GTM_A] })),
        rec("https://static.criteo.net/b.js", loader({ insertedBy: ["https://example.com/app.js"] })),
      ],
    });
    const f = finding(evaluate(obs, classify), "Criteo");
    expect(f?.flag).toBe("vendor-gpc-check-unattributable");
    expect(f?.artifact).toMatchObject({ route: "loader", loader: { kind: "container", mixed: true } });
  });

  it("an undetermined loader keeps the page-wide behavior and artifact", () => {
    const obs = page({
      network: [script("https://static.criteo.net/tag.js")],
      consentApiCalls: [containerCall(GTM_A, 100)],
      scriptInsertions: [
        rec("https://static.criteo.net/tag.js", loader({ insertedBy: ["https://example.com/app.js"] })),
        rec("https://static.criteo.net/other.js", loader({ inlineFrames: true })),
      ],
    });
    const f = finding(evaluate(obs, classify), "Criteo");
    expect(f?.flag).toBe("vendor-gpc-check-unattributable");
    expect(f?.artifact).toMatchObject({ kind: "vendor-check-container", containerCallCount: 1 });
  });

  it("a bundle without records keeps the page-wide state and artifact", () => {
    const obs = observationSet({
      network: [script("https://connect.facebook.net/tag.js")],
      gtm: { present: true, containerIds: ["GTM-A"], gtagIds: [], consentMode: null },
    });
    const f = finding(evaluate(obs, classify), "Meta");
    expect(f?.flag).toBe("vendor-gpc-unread-via-container");
    expect(f?.artifact).toEqual({ kind: "vendor-check-container", containerCallCount: 0, consentModeActive: false });
  });
});

// ---------------------------------------------------------------------------
// Request initiators
// ---------------------------------------------------------------------------

import { countsAsExecution } from "../src/rules/vendor-signal-check.js";

describe("request initiators resolve like insertions, and the XHR gate", () => {
  const px = (url: string, l: ScriptInsertionLoader): ScriptInsertion => ({ key: recordKeyOf(url), url, element: "image", loaders: [l] });
  const xhr = (url: string, l: ScriptInsertionLoader): ScriptInsertion => ({ key: recordKeyOf(url), url, element: "xhr", loaders: [l] });

  it("gives a pixel-only vendor a loader from its request record", () => {
    const obs = observationSet({
      network: [request({ url: "https://www.facebook.com/tr?id=1", resourceType: "image" })],
      requestInitiators: [px("https://www.facebook.com/tr?id=1", loader({ insertedBy: [GTM_A], containerUrls: [GTM_A], via: "src" }))],
      requestInitiatorCoverage: coverage(false),
    });
    const r = resolveLoaders(obs, classify);
    expect(r.byPair.get(pair("Meta"))?.[0]).toMatchObject({ kind: "container", identity: { id: "GTM-A" } });
    const f = evaluate(obs, classify).find((x) => x.entity?.name === "Meta" && x.flag === "vendor-no-script-observed");
    expect(f?.artifact).toMatchObject({ kind: "network", loadedVia: [{ kind: "container" }] });
  });

  it("an insertion record wins a key it shares with a request record", () => {
    const obs = observationSet({
      scriptInsertions: [rec("https://static.criteo.net/x.js", loader({ insertedBy: ["https://example.com/app.js"] }))],
      requestInitiators: [px("https://static.criteo.net/x.js", loader({ insertedBy: [GTM_A], containerUrls: [GTM_A], via: "src" }))],
      scriptInsertionCoverage: coverage(false),
    });
    expect(resolveLoaders(obs, classify).byPair.get(pair("Criteo"))).toEqual([{ kind: "site", url: "https://example.com/app.js" }]);
  });

  it("countsAsExecution: an XHR made by someone else is not the vendor's execution, when required", () => {
    const url = "https://static.criteo.net/sync?u=1";
    const own = observationSet({ requestInitiators: [xhr(url, loader({ insertedBy: ["https://static.criteo.net/lib.js"], via: "open" }))] });
    const other = observationSet({ requestInitiators: [xhr(url, loader({ insertedBy: [GTM_A], containerUrls: [GTM_A], via: "open" }))] });
    const none = observationSet({});
    const net = { url, resourceType: "xmlhttprequest" };
    expect(countsAsExecution(net, "Criteo", own, resolveLoaders(own, classify), classify, true)).toBe(true);
    expect(countsAsExecution(net, "Criteo", other, resolveLoaders(other, classify), classify, true)).toBe(false);
    expect(countsAsExecution(net, "Criteo", none, resolveLoaders(none, classify), classify, true)).toBe(true);
    // Off, as shipped: every XHR counts.
    expect(countsAsExecution(net, "Criteo", other, resolveLoaders(other, classify), classify, false)).toBe(true);
    // A script request is never gated.
    expect(countsAsExecution({ url, resourceType: "script" }, "Criteo", other, resolveLoaders(other, classify), classify, true)).toBe(true);
  });
});
