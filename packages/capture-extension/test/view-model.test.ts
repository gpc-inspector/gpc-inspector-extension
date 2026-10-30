// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { actionTitleKey, buildPopupView, cookieRemoved, cookieViaKey, describeFailedCapabilities, sentToAnyHost, shownName, iconStateFor, loadedViaRowLine, loaderLines, LIST_MARK, nativeFirstRunKey, nativeSendSetting, pageKindOf } from "../src/ui/view-model.js";
import type { KvLine, PopupView, UrlClass } from "../src/ui/view-model.js";
import { GPP_SECTIONS } from "../src/ui/iab-registry.js";
import { evaluate, US_STATE_GPP_SECTIONS, US_STATE_GPP_SECTION_IDS, type Classifier } from "@gpc-inspector/engine";
import messagesJson from "../public/_locales/en/messages.json" with { type: "json" };
import { SCHEMA_VERSION, entityCategoryKey } from "@gpc-inspector/schema";
import type { ObservationSet, Finding, EntityTally, EntityCategoryTally } from "@gpc-inspector/schema";

const EMPTY_TALLIES = {
  totalRequests: 0,
  signedRequests: 0,
  adVendorRequests: 0,
  adCookieEvents: 0,
  adCookieKeys: [],
  adCookieEventsUnsigned: 0,
  adCookieKeysUnsigned: [],
  firstPartyVendorCookieKeys: [],
  byEntity: {},
};

function obs(over: Partial<ObservationSet> = {}): ObservationSet {
  return {
    schemaVersion: SCHEMA_VERSION,
    context: {
      finalUrl: "https://example.com/",
      topSite: "example.com",
      extensionVersion: "1.0.0",
      browserUserAgent: "t",
      os: "t",
      capturedAt: "2026-08-18T00:00:00.000Z",
      mode: "passive",
      incomplete: false,
      ...over.context,
    },
    signal: {
      secGpcRequestCount: 10,
      totalRequestCount: 10,
      source: "this-extension",
      propertyValue: true,
      readTracking: "active",
      readCount: 5,
      readsByScript: {},
      readAttribution: null,
      ...over.signal,
    },
    network: over.network ?? [],
    consentApiCalls: over.consentApiCalls ?? [],
    gpp: over.gpp ?? null,
    usPrivacy: over.usPrivacy ?? null,
    tcf: over.tcf ?? null,
    gtm: over.gtm ?? { present: false, containerIds: [], gtagIds: [], consentMode: null },
    confirmationNotice: over.confirmationNotice ?? "indeterminate",
    ...(over.confirmationText !== undefined ? { confirmationText: over.confirmationText } : {}),
    wellKnown: over.wellKnown ?? null,
    tallies: over.tallies ?? EMPTY_TALLIES,
    capabilities: {
      documentCookie: true,
      cookieStore: true,
      gpp: true,
      uspapi: true,
      tcfapi: true,
      dataLayer: true,
      ...over.capabilities,
    },
  };
}

const cookieFinding = (entity: string, cookieName: string): Finding => ({
  flag: "cookie-set-with-signal",
  rank: 10,
  entity: { name: entity, domains: [] },
  artifact: { kind: "cookie", observationId: "1", cookieName },
});

const vendorSignalFinding = (
  entity: string,
  flag:
    | "vendor-read-gpc"
    | "vendor-did-not-read-gpc"
    | "vendor-no-script-observed"
    | "vendor-gpc-unread-via-container"
    | "vendor-gpc-check-unattributable",
  artifact: Finding["artifact"] = { kind: "none" },
): Finding => ({
  flag,
  rank: 41,
  entity: { name: entity, domains: [] },
  artifact,
});

/** A decoded GPP string, with whatever the usca section should say about GPC. */
const gppWith = (fields: Record<string, number>): NonNullable<ObservationSet["gpp"]> => ({
  rawString: "x",
  applicableSections: [8],
  gppVersion: "1.1",
  sections: { usca: fields },
  unparseable: false,
  fromWire: null,
});

/** What a list says of a URL, for a test: the first rule whose text the host contains. */
type Rule = readonly [match: string, entity: string | null, category: string];
const classifyWith = (rules: readonly Rule[], site = "example.com") => (url: string): UrlClass => {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* an unparseable URL is nobody's */
  }
  const domain = host.split(".").slice(-2).join(".");
  const rule = rules.find(([match]) => host.includes(match));
  return { party: domain === site ? "first" : "third", category: rule?.[2] ?? "unknown", entity: rule?.[1] ?? null, domain };
};

/** The names on a list-shaped line: "Company [category]", or a domain, the site's marked. */
const who = (line: KvLine | undefined): string[] =>
  (line?.list ?? []).map(
    (i) => `${i.text}${i.categoryKey ? ` [${i.categoryKey.replace(/^category_?/, "").toLowerCase()}]` : ""}${i.thisSite ? " (this site)" : ""}`,
  );

/**
 * The GPC read rows under "Did vendors read GPC from the page": "GPC read", "No read
 * observed" and, when someone is in that state, "Cannot determine", under the privacy
 * strings. Each list holds the names a row draws; a row with nobody in it says "none" and
 * draws no names.
 */
const readRows = (v: PopupView) => {
  const group = v.gpcReads.find((r) => r.labelKey === "labelCheckedForGpc");
  const rows = group?.rows ?? [];
  const names = (label: string): string[] => {
    const r = rows.find((x) => x.labelKey === label);
    return r === undefined || r.valueKey !== undefined ? [] : who(r.lines?.[0]);
  };
  return { group, rows, yes: names("labelReadObserved"), no: names("labelReadNotObserved"), unsure: names("labelReadUndetermined") };
};

/** A line's first key. */
const keyOf = (l: KvLine) => (l.parts[0] as { key: string }).key;

/**
 * Each GPC read row as its label, "names" or its value key, then its hint lines' keys; and
 * last, when the group has notes of its own, "group" and their keys.
 */
const readShape = (v: PopupView): string[][] => {
  const { group, rows } = readRows(v);
  const notes = group?.lines ?? [];
  return [
    ...rows.map((r) => [r.labelKey, r.valueKey ?? "names", ...(r.lines ?? []).filter((l) => l.tone === "hint").map(keyOf)]),
    ...(notes.length > 0 ? [["group", ...notes.map(keyOf)]] : []),
  ];
};

/** The hint line with this key, in whichever GPC read row it sits, or under the group. */
const readHint = (v: PopupView, key: string): KvLine | undefined =>
  [...readRows(v).rows.flatMap((r) => r.lines ?? []), ...(readRows(v).group?.lines ?? [])].find(
    (l) => l.tone === "hint" && (l.parts[0] as { key?: string }).key === key,
  );

/** A vendor check finding for a company in one category, as the engine writes them since 1.20.0. */
const pairFinding = (entity: string, category: string, flag: Finding["flag"], artifact: Finding["artifact"] = { kind: "none" }): Finding => ({
  flag,
  rank: 41,
  entity: { name: entity, domains: [], category },
  artifact,
});

/** A summary per company and category, and the record of them a tally carries. */
const summary = (entity: string, category: string, over: Partial<EntityCategoryTally> = {}): EntityCategoryTally => ({
  entity, category, requests: 2, signedRequests: 2, hosts: [], resourceTypes: ["script"], scriptRan: true,
  cookieKeys: [], cookieKeysUnsigned: [], cookiesReturned: [], probeCookies: [], refusedWrites: [], ...over,
});
const summaries = (...all: EntityCategoryTally[]): Record<string, EntityCategoryTally> =>
  Object.fromEntries(all.map((p) => [entityCategoryKey(p.entity, p.category), p]));

function build(o: ObservationSet | null, findings: Finding[] = [], adTechRequests = 5) {
  return buildPopupView({
    observations: o,
    findings,
    distinctCookies: findings.length,
    adTechRequests,
  });
}

describe("popup states (PRD 5.6)", () => {
  it("no-data when nothing has been captured", () => {
    expect(build(null).state).toBe("no-data");
  });

  it("pending for a null record only before the worker has answered", () => {
    // Pending is tested first. Passed for every null record, it would leave an unreachable
    // worker or a missing tab on "Checking this page" for as long as the popup stayed open,
    // and stateNoData would never show.
    const view = (pending: boolean) =>
      buildPopupView({ observations: null, findings: [], distinctCookies: 0, adTechRequests: 0, pending });
    expect(view(true).state).toBe("pending");
    expect(view(false).state).toBe("no-data");
  });

  it("ineligible when the tab has no trackable site", () => {
    expect(build(obs({ context: { topSite: "" } as never })).state).toBe("ineligible");
  });

  it("needs-reload when the page was open before this version could observe it load", () => {
    // After an install or an update Chrome does not run the new content scripts in a tab
    // that is already open. The few requests such a tab makes afterwards must not render as
    // "signal off" or "no ad tech": both describe a load nobody watched.
    const late = obs({
      context: { loadObserved: false } as never,
      signal: { source: "none" } as never,
    });
    expect(build(late).state).toBe("needs-reload");
    expect(build(late, [], 0).state).toBe("needs-reload");
  });

  it("does not take a late frame's report as the page's signal state", () => {
    // Frames added after the install run the new content scripts and report our accessor.
    // The top document never got it, so the row must not say the signal is set.
    const late = obs({
      context: { loadObserved: false } as never,
      signal: { source: "this-extension", propertyValue: true } as never,
    });
    const v = buildPopupView({
      observations: late, findings: [], distinctCookies: 0, adTechRequests: 0,
      sendingSignal: true, signalKnown: true,
    });
    expect(v.status).toEqual({ isSet: false, sourceKey: "sourceNeedsReload", accent: false });
  });

  it("says the header was sent when the page got no property on an observed load (1.43.0)", () => {
    // The browser had the header rule live and not yet the registered script that sets the
    // property: the page reported no property, the document's request carried Sec-GPC.
    // "not set" alone would hide the header that went out.
    const split = obs({
      context: { loadObserved: true, documentSigned: true } as never,
      signal: { source: "none", propertyValue: "absent", readTracking: "unavailable", readCount: null } as never,
    });
    const v = buildPopupView({
      observations: split, findings: [], distinctCookies: 0, adTechRequests: 0,
      sendingSignal: true, signalKnown: true,
    });
    expect(v.status).toEqual({ isSet: false, sourceKey: "sourceHeaderSentNoProperty", accent: false });
  });

  it("does not say the property was missed before the page has reported", () => {
    // Between the document's request and the page's first report the record holds the
    // header and the empty default: a page still loading, not a load that came apart.
    const loading = obs({
      context: { loadObserved: true, documentSigned: true } as never,
      signal: { source: "none", propertyValue: false, readTracking: "active", readCount: 0 } as never,
    });
    const v = buildPopupView({
      observations: loading, findings: [], distinctCookies: 0, adTechRequests: 0,
      sendingSignal: true, signalKnown: true, pending: true,
    });
    expect(v.status.sourceKey).not.toBe("sourceHeaderSentNoProperty");
    expect(v.status).toEqual({ isSet: false, sourceKey: "sourceNeedsReload", accent: false });
  });

  it("says the header was not sent when the page got the property and the document's request did not (1.43.0)", () => {
    const split = obs({
      context: { loadObserved: true, documentSigned: false } as never,
      signal: { source: "this-extension", propertyValue: true } as never,
    });
    const v = buildPopupView({
      observations: split, findings: [], distinctCookies: 0, adTechRequests: 0,
      sendingSignal: true, signalKnown: true,
    });
    expect(v.status).toEqual({ isSet: true, sourceKey: "sourcePropertySetNoHeader", accent: true });
  });

  it("says the signal is set, with the late line, where the start-up pass set it after the load (1.44.0)", () => {
    // A page open before the extension could run in it: the load was not observed, and the
    // pass injected the scripts, so the page reads true now. The status says so, and the
    // line under it says what ran before then read nothing; the read rows say the same.
    const late = obs({
      context: { loadObserved: false, propertySetLate: true } as never,
      signal: { source: "this-extension", propertyValue: true, readTracking: "active", readCount: 0 } as never,
    });
    const v = buildPopupView({
      observations: late, findings: [], distinctCookies: 0, adTechRequests: 0,
      sendingSignal: true, signalKnown: true,
    });
    expect(v.status).toEqual({ isSet: true, sourceKey: "sourceThisExtension", accent: true, hintKey: "statusHintSetLate" });

    // Without the mark the same page is the not-observed case.
    const unmarked = obs({
      context: { loadObserved: false } as never,
      signal: { source: "this-extension", propertyValue: true } as never,
    });
    const u = buildPopupView({
      observations: unmarked, findings: [], distinctCookies: 0, adTechRequests: 0,
      sendingSignal: true, signalKnown: true,
    });
    expect(u.status.hintKey).toBeUndefined();
    expect(u.status.sourceKey).toBe("sourceNeedsReload");
  });

  it("names the late setting under the read rows of an observed page (1.44.0)", () => {
    const late = obs({
      context: { loadObserved: true, propertySetLate: true, documentSigned: true } as never,
      signal: { source: "this-extension", propertyValue: true, readTracking: "active", readCount: 0 } as never,
    });
    const v = buildPopupView({
      observations: late, findings: [], distinctCookies: 0, adTechRequests: 0,
      sendingSignal: true, signalKnown: true,
    });
    expect(v.status.hintKey).toBe("statusHintSetLate");
    const keys = JSON.stringify(v.gpcReads);
    expect(keys).toContain("hintReadsSetLate");
  });

  it("keeps 'reload the page to apply' for a page loaded before sending was turned on", () => {
    // No header on the document's request and no property: the setting changed after the
    // load, which is not a load that came apart.
    const stale = obs({
      context: { loadObserved: true, documentSigned: false } as never,
      signal: { source: "none", propertyValue: "absent", readTracking: "unavailable", readCount: null } as never,
    });
    const v = buildPopupView({
      observations: stale, findings: [], distinctCookies: 0, adTechRequests: 0,
      sendingSignal: true, signalKnown: true,
    });
    expect(v.status.sourceKey).toBe("sourceNeedsReload");
  });

  it("does not take a bundle without the document fact as a load that came apart", () => {
    // Recorded before 1.43.0, or on a site the browser reported no request for.
    const old = obs({
      context: { loadObserved: true } as never,
      signal: { source: "none", propertyValue: false } as never,
    });
    const v = buildPopupView({
      observations: old, findings: [], distinctCookies: 0, adTechRequests: 0,
      sendingSignal: true, signalKnown: true,
    });
    expect(v.status.sourceKey).toBe("sourceNeedsReload");
  });

  it("keeps the signal report of a page restored from the back/forward cache (1.39.0)", () => {
    // The restored document is the one that reported at its load, so its report stands,
    // where a late frame's report on a page loaded before the extension does not.
    const restored = obs({
      context: { loadObserved: false, restoredFromCache: true } as never,
      signal: { source: "this-extension", propertyValue: true } as never,
    });
    const v = buildPopupView({
      observations: restored, findings: [], distinctCookies: 0, adTechRequests: 0,
      sendingSignal: true, signalKnown: true,
    });
    expect(v.state).toBe("needs-reload");
    expect(v.status).toEqual({ isSet: true, sourceKey: "sourceThisExtension", accent: true });
    expect(v.notices.map((n) => n.textKey)).toEqual(["stateNeedsReload"]);
  });

  it("still reports a browser-set signal on a page whose load was not observed", () => {
    const late = obs({
      context: { loadObserved: false } as never,
      signal: { source: "native", propertyValue: true } as never,
    });
    const v = buildPopupView({
      observations: late, findings: [], distinctCookies: 0, adTechRequests: 0,
      sendingSignal: true, signalKnown: true,
    });
    expect(v.status.sourceKey).toBe("sourceBrowser");
  });

  it("says so in one notice at the top, and nothing else", () => {
    // Same tone as an incomplete capture: part of this page was not observed, here all of
    // it. `incomplete` is set too, and must not add a second box saying less.
    const v = build(obs({ context: { loadObserved: false, incomplete: true } as never }));
    expect(v.notices).toEqual([
      { kind: "incomplete", tone: "unavailable", placement: "top", textKey: "stateNeedsReload" },
    ]);
  });

  it("treats a bundle with no loadObserved field as observed", () => {
    // Recorded before 1.14.0. Absence of the field is not a load we failed to see.
    expect(build(obs(), [], 3).state).toBe("observed");
    expect(build(obs({ context: { loadObserved: true } as never }), [], 3).state).toBe("observed");
  });

  it("signal-off when nothing is asserting the signal", () => {
    const v = build(obs({ signal: { source: "none" } as never }));
    expect(v.state).toBe("signal-off");
    expect(v.status.isSet).toBe(false);
    expect(v.status.sourceKey).toBe("sourceOffInSettings");
  });

  it("no-ad-tech only when NOTHING was observed", () => {
    // A site with nothing to observe is NOT a site that passed. It must never render as a
    // reassuring 0, and it is excluded from every total (5.6 row 1).
    const v = build(obs(), [], 0);
    expect(v.state).toBe("no-ad-tech");
  });

  it("observed when ad tech is present but set no cookies (5.6 row 2)", () => {
    // The state comes from the requests themselves. Derived from cookie findings, it would
    // have apparel-c.example report "no third-party ad or analytics requests observed" while 18
    // scripts read the signal (observed live). Ad tech that sets nothing is a counted
    // zero — a more interesting result than an empty page, and a different claim.
    const v = build(obs(), [], 12);
    expect(v.state).toBe("observed");
    expect(v.cookieCount).toBe(0);
    expect(v.adTechRequests).toBe(12);
  });

  it("observed in the normal case", () => {
    expect(build(obs(), [cookieFinding("Google", "IDE")]).state).toBe("observed");
  });
});

describe("a page the extension cannot inspect", () => {
  /** The view of a tab at this address, with the record the worker keeps for it. */
  const at = (tabAddress: string, record: ObservationSet | null, pending = false) =>
    buildPopupView({
      observations: record,
      findings: [],
      distinctCookies: 0,
      adTechRequests: 0,
      pending,
      sendingSignal: true,
      signalKnown: true,
      tabAddress,
    });

  /** A request as the worker records it. */
  const request = (url: string) => ({
    id: url, url, method: "GET", resourceType: "xmlhttprequest", initiator: null,
    secGpcPresent: true,
    cookiesSent: [], requestHeaders: [], statusCode: 200, responseHeaders: null,
    isRedirectHop: false, setCookies: [], captureMethod: "onHeadersReceived" as const,
    timeMs: 0,
  });

  /** What the worker keeps for a page it does not track: no site, no load, and whatever requests reached the tab. */
  const untracked = (requests = 0) =>
    obs({
      context: { finalUrl: "", topSite: "", loadObserved: false } as never,
      signal: { source: "none", propertyValue: false, secGpcRequestCount: requests, totalRequestCount: requests } as never,
      network: Array.from({ length: requests }, (_, i) => request(`https://www.google.com/async/ntp${i}`)),
    });

  /** The one notice, and nothing else the Overview would draw. */
  const onlyNotice = (v: PopupView, textKey: string) => {
    expect(v.state).toBe("ineligible");
    expect(v.notices).toEqual([{ kind: "incomplete", tone: "unavailable", placement: "top", textKey }]);
    expect(v.site).toBe("");
    expect(v.siteDid).toEqual([]);
    expect(v.privacyStrings).toEqual([]);
    expect(v.gpcReads).toEqual([]);
    expect(v.vendors).toEqual([]);
    expect(v.containers).toEqual([]);
    expect(v.countNames).toEqual([]);
    expect(v.countCaption).toBeUndefined();
    expect(v.firstParty).toBeUndefined();
    // No reload prompt anywhere: the status the view carries is the setting's alone, and
    // the renderer draws no status row in this state.
    expect(v.status.sourceKey).not.toBe("sourceNeedsReload");
    expect(JSON.stringify(v)).not.toContain("NeedsReload");
  };

  it("knows each kind of page by its address", () => {
    const kinds: [string, ReturnType<typeof pageKindOf>][] = [
      // The new tab pages, and a blank tab.
      ["chrome://newtab/", "new-tab"],
      ["chrome://new-tab-page/", "new-tab"],
      ["chrome://new-tab-page-third-party/", "new-tab"],
      ["edge://newtab/", "new-tab"],
      ["about:blank", "new-tab"],
      // The browser's own pages, other extensions' pages and DevTools.
      ["chrome://settings/", "not-inspectable"],
      ["chrome://extensions/?id=abc", "not-inspectable"],
      ["edge://settings/profiles", "not-inspectable"],
      ["about:version", "not-inspectable"],
      ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html", "not-inspectable"],
      ["devtools://devtools/bundled/devtools_app.html", "not-inspectable"],
      ["view-source:https://example.com/", "not-inspectable"],
      // The extension stores: https pages the browser keeps every extension out of.
      ["https://chromewebstore.google.com/", "not-inspectable"],
      ["https://chromewebstore.google.com/detail/some-extension/abcdefghijklmnopabcdefghijklmnop", "not-inspectable"],
      ["https://chrome.google.com/webstore/category/extensions", "not-inspectable"],
      ["https://microsoftedge.microsoft.com/addons/Microsoft-Edge-Extensions-Home", "not-inspectable"],
      // Local files.
      ["file:///Users/someone/page.html", "not-inspectable"],
      // Websites, the stores' neighbors on the same hosts included.
      ["https://example.com/", "website"],
      ["http://example.com/path?q=1", "website"],
      ["https://chrome.google.com/", "website"],
      ["https://microsoftedge.microsoft.com/", "website"],
      ["https://www.google.com/", "website"],
    ];
    expect(kinds.map(([address]) => [address, pageKindOf(address)])).toEqual(kinds);
  });

  it("has no kind for an address it does not know", () => {
    expect(pageKindOf(undefined)).toBeNull();
    expect(pageKindOf("")).toBeNull();
    expect(pageKindOf("not an address")).toBeNull();
  });

  it("a new tab: says to open a website, with no request count, status or reload prompt", () => {
    // Chrome's new tab page: the worker keeps no site for it, and the requests the page
    // makes still reach the tab's record.
    onlyNotice(at("chrome://newtab/", untracked(8)), "stateNewTab");
    // A blank tab has nothing in it either.
    onlyNotice(at("about:blank", untracked()), "stateNewTab");
  });

  it("a new tab whose page is a website the browser loads in it", () => {
    // Edge's new tab page commits a page from the browser maker's own site, so the worker
    // records a site and a load, and no request answers it: a capture that would sit on
    // "Checking this page" for as long as the tab stays open.
    const record = obs({
      context: { finalUrl: "https://newtab.browser-maker.example/ntp?locale=en-US", topSite: "newtab.browser-maker.example", loadObserved: true } as never,
      signal: { source: "none", secGpcRequestCount: 0, totalRequestCount: 0 } as never,
    });
    onlyNotice(at("edge://newtab/", record, true), "stateNewTab");
  });

  it("the browser's own pages, other extensions' pages and local files: cannot be inspected", () => {
    for (const address of ["chrome://settings/", "edge://settings/profiles", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html", "file:///Users/someone/page.html"]) {
      onlyNotice(at(address, untracked()), "stateIneligible");
    }
  });

  it("an extension store: not taken for the page a frame inside it reported on", () => {
    // The browser runs no content script in the store's own document, but a frame inside it
    // from another site gets them and reports this extension's signal, with its requests.
    // As the page's, that read "signal is set, by this extension" over a page the signal
    // never reached.
    const record = obs({
      context: { finalUrl: "https://chromewebstore.google.com/", topSite: "chromewebstore.google.com", loadObserved: true } as never,
      signal: { source: "this-extension", propertyValue: true, secGpcRequestCount: 4, totalRequestCount: 4 } as never,
      network: [request("https://apis.google.com/js/api.js")],
    });
    onlyNotice(at("https://chromewebstore.google.com/", record), "stateIneligible");
    onlyNotice(at("https://microsoftedge.microsoft.com/addons/Microsoft-Edge-Extensions-Home", record), "stateIneligible");
  });

  it("is known on the first frame, before the worker has answered", () => {
    // The popup draws one frame before the record arrives. On a new tab no record changes
    // the answer, so that frame is already the notice and never "Checking this page".
    onlyNotice(at("chrome://newtab/", null, true), "stateNewTab");
    onlyNotice(at("chrome://settings/", null, false), "stateIneligible");
  });

  it("still asks for a reload on a website whose load was not observed", () => {
    // The same record on a website: there a reload is what makes the page inspectable.
    const v = at("https://example.com/", obs({
      context: { loadObserved: false } as never,
      signal: { source: "none" } as never,
    }));
    expect(v.state).toBe("needs-reload");
    expect(v.status.sourceKey).toBe("sourceNeedsReload");
    expect(v.notices.map((n) => n.textKey)).toEqual(["stateNeedsReload"]);
  });

  it("without the tab's address, takes a record with no site as a page it cannot inspect", () => {
    onlyNotice(build(untracked(8)), "stateIneligible");
  });

  it("asks for no reload in either sentence, and names no kind of address", () => {
    // The store is an https page: a sentence naming the addresses that can be inspected
    // would be wrong there.
    const messages = messagesJson as Record<string, { message: string; description: string }>;
    for (const key of ["stateNewTab", "stateIneligible"]) {
      expect(messages[key]?.message).toBeTruthy();
      expect(messages[key]?.description).toBeTruthy();
      expect(messages[key]?.message).not.toMatch(/reload|refresh|https?:/i);
    }
  });
});

describe("signal status row", () => {
  it("accents the tag only when this extension is the source", () => {
    expect(build(obs()).status.accent).toBe(true);
    expect(build(obs({ signal: { source: "native" } as never })).status.accent).toBe(false);
  });

  it("names the browser as the source when native GPC is present", () => {
    const v = build(obs({ signal: { source: "native" } as never }));
    expect(v.status.isSet).toBe(true);
    expect(v.status.sourceKey).toBe("sourceBrowser");
  });

  it("names another extension without claiming which one", () => {
    const v = build(obs({ signal: { source: "other-extension" } as never }));
    expect(v.status.sourceKey).toBe("sourceOtherExtension");
  });

  // An owner says who decides the value, not what it is. A browser that implements GPC
  // with it switched off reads false and must not render as "set, by the browser".
  const off = (source: "native" | "other-extension", secGpcRequestCount: number, sendingSignal?: boolean) =>
    buildPopupView({
      observations: obs({ signal: { source, propertyValue: false, secGpcRequestCount } as never }),
      findings: [], distinctCookies: 0, adTechRequests: 5,
      ...(sendingSignal === undefined ? {} : { sendingSignal }), signalKnown: true,
    }).status;

  it("says not set, turned off in the browser, when the native property reads false", () => {
    expect(off("native", 0, false)).toEqual({ isSet: false, sourceKey: "sourceBrowserOff", accent: false });
  });

  it("says not set, turned off by another extension, when that extension's property reads false", () => {
    expect(off("other-extension", 0, false)).toEqual({ isSet: false, sourceKey: "sourceOtherExtensionOff", accent: false });
  });

  it("qualifies not set when our header still goes out under an owner that reads false", () => {
    // Our DNR rule does not stand down for another owner: sites get Sec-GPC: 1 while page
    // scripts read false, and the tag must say both.
    expect(off("native", 0, true).sourceKey).toBe("sourceBrowserOffHeaderSent");
    expect(off("native", 4, undefined).sourceKey).toBe("sourceBrowserOffHeaderSent");
    expect(off("other-extension", 0, true)).toEqual({
      isSet: false, sourceKey: "sourceOtherExtensionOffHeaderSent", accent: false,
    });
  });

  it("still says set, by the browser, when the native property reads true", () => {
    const v = buildPopupView({
      observations: obs({ signal: { source: "native", propertyValue: true, secGpcRequestCount: 0 } as never }),
      findings: [], distinctCookies: 0, adTechRequests: 5, sendingSignal: false, signalKnown: true,
    });
    expect(v.status).toEqual({ isSet: true, sourceKey: "sourceBrowser", accent: false });
  });

  it("keeps the needs-reload and load-error answers ahead of an owner that reads false", () => {
    const failed = buildPopupView({
      observations: obs({
        context: { loadError: "net::ERR_FAILED" } as never,
        signal: { source: "native", propertyValue: false } as never,
      }),
      findings: [], distinctCookies: 0, adTechRequests: 5, sendingSignal: true, signalKnown: true,
    });
    expect(failed.status.sourceKey).toBe("sourceThisExtension");
  });
});

describe("native signal in settings and first run", () => {
  it("makes the send toggle inert only when the browser's signal is on", () => {
    expect(nativeSendSetting({ source: "native", propertyValue: true })).toEqual({
      descKey: "settingSendSignalNative", inert: true,
    });
    // Off in the browser: the toggle still governs our own header, so it stays usable.
    expect(nativeSendSetting({ source: "native", propertyValue: false })).toEqual({
      descKey: "settingSendSignalNativeOff", inert: false,
    });
    expect(nativeSendSetting({ source: "this-extension", propertyValue: true })).toBeNull();
    expect(nativeSendSetting({ source: "other-extension", propertyValue: false })).toBeNull();
    expect(nativeSendSetting(undefined)).toBeNull();
  });

  it("picks the first-run line by what the browser's property reads", () => {
    expect(nativeFirstRunKey({ source: "native", propertyValue: true })).toBe("firstRunSignalNative");
    expect(nativeFirstRunKey({ source: "native", propertyValue: false })).toBe("firstRunSignalNativeOff");
    expect(nativeFirstRunKey({ source: "none", propertyValue: "absent" })).toBeNull();
    expect(nativeFirstRunKey(undefined)).toBeNull();
  });
});

describe("toolbar icon title", () => {
  it("names no page before the page has reported, and says set once it has", () => {
    // The default title stays on chrome:// and new-tab pages, which never report: "set on
    // this page" there would claim a signal on a page that has none.
    expect(actionTitleKey("on", false)).toBe("actionTitleSending");
    expect(actionTitleKey("on", true)).toBe("actionTitleOn");
  });

  it("reads off the same way either way", () => {
    expect(actionTitleKey("off", false)).toBe("actionTitleOff");
    expect(actionTitleKey("off", true)).toBe("actionTitleOff");
  });
});

describe("toolbar icon state", () => {
  // The icon answers "was a GPC signal observed on this page", not "are we sending".
  it("is on when the property reads true, whoever set it", () => {
    expect(iconStateFor({ propertyValue: true, documentSigned: null })).toBe("on");
  });

  it("is on when the document request carried Sec-GPC even without the property", () => {
    // A header-only signal, e.g. another extension that adds the header and never sets
    // the property. The site's server saw it; that is a signal as the page loaded.
    expect(iconStateFor({ propertyValue: "absent", documentSigned: true })).toBe("on");
  });

  it("is off for a native owner whose value is false", () => {
    // Chrome with GPC supported but not enabled: a source exists, no signal does.
    expect(iconStateFor({ propertyValue: false, documentSigned: false })).toBe("off");
  });

  it("is off when nothing asserted anything", () => {
    expect(iconStateFor({ propertyValue: "absent", documentSigned: null })).toBe("off");
  });

  it("does not light for a page that loaded before sending was switched on", () => {
    // The header rule now applies to this page's LATER requests, but the document
    // itself went out unsigned and the property was never set. The status row says
    // "reload the page to apply"; the icon must agree with it rather than flip on the
    // first signed XHR. The derivation sees only load-time facts, so this holds by
    // construction — the test pins it.
    expect(iconStateFor({ propertyValue: "absent", documentSigned: false })).toBe("off");
  });
});

describe("GPC signal vs the site's GPP string", () => {
  const mismatchFinding = (
    flag: "gpc-sent-gpp-field-no" | "gpc-not-sent-gpp-field-yes",
    gpcField: 0 | 1,
    propertyValue: true | false,
    secGpcRequestCount: number,
  ): Finding => ({
    flag,
    rank: 37,
    entity: null,
    artifact: { kind: "gpc-vs-gpp", section: "usca", gpcField, propertyValue, secGpcRequestCount },
  });

  it("states the mismatch and shows both values, without offering a cause", () => {
    const v = build(obs({ gpp: gppWith({ Gpc: 0 }) }), [
      mismatchFinding("gpc-sent-gpp-field-no", 0, true, 212),
    ]);
    const n = v.notices.find((x) => x.textKey === "findingGpcGppMismatch");
    expect(n).toBeDefined();
    // Same treatment as every other notice in this section. DESIGN.md 2: the finding tone
    // carries no hue and therefore no severity — a fact stated firmly, not a warning.
    expect(n?.tone).toBe("finding");
    expect(n?.placement).toBe("top");
    expect(n?.pairs).toEqual([
      { labelKey: "labelGpcSignalValue", valueKey: "valueGpcSignalSet", valueSubstitution: ["212"] },
      { labelKey: "labelGppGpcFieldValue", valueKey: "valueGppGpcFieldNotSet" },
    ]);
    // No caveat line under the pair: the pair states both values and the sentence already
    // says they disagree, so a third restatement would be the longest and least useful block.
    expect(Object.keys(n ?? {}).sort()).toEqual(["kind", "pairs", "placement", "textKey", "tone"]);
  });

  it("uses the same sentence for the reverse direction, with the values swapped", () => {
    const v = build(obs({ gpp: gppWith({ Gpc: 1 }) }), [
      mismatchFinding("gpc-not-sent-gpp-field-yes", 1, false, 0),
    ]);
    const n = v.notices.find((x) => x.textKey === "findingGpcGppMismatch");
    expect(n?.pairs).toEqual([
      { labelKey: "labelGpcSignalValue", valueKey: "valueGpcSignalNotSet" },
      { labelKey: "labelGppGpcFieldValue", valueKey: "valueGppGpcFieldSet" },
    ]);
  });

  it("reads as one list with the other notices, not as a lower tier", () => {
    // In the neutral tone, the one notice about the reader's own signal would be the
    // quietest block among dark ones. DESIGN.md 2 defines the finding tone as carrying no
    // hue and therefore no severity, so matching it states the fact firmly without turning
    // context into an accusation.
    const v = build(obs({ gpp: gppWith({ Gpc: 0 }) }), [
      mismatchFinding("gpc-sent-gpp-field-no", 0, true, 5),
      { flag: "gpp-conflict", rank: 12, entity: null, artifact: { kind: "none" } } as Finding,
    ]);
    const tones = new Set(v.notices.filter((n) => n.kind === "finding").map((n) => n.tone));
    expect([...tones]).toEqual(["finding"]);
  });

  it("repeats the mismatch inside the expanded GPP row, where the field is", () => {
    const v = build(
      obs({
        gpp: gppWith({ Gpc: 0 }),
        signal: { propertyValue: true, secGpcRequestCount: 9 } as never,
      }),
    );
    expect(v.privacyStrings.find((r) => r.id === "gpp")?.noteKey).toBe("gppNoteMismatchSignalSet");
  });

  it("judges the same sections the row displays", () => {
    // Both sections are specified, so the row decodes both, each beside its own comparison:
    // usnat records Gpc 1 and agrees with the signal, usca records Gpc 0 and does not. The
    // note sits under usca's group only. Both key orders.
    const usca = { Gpc: 0 };
    const usnat = { Gpc: 1, SaleOptOut: 1 };
    for (const sections of [{ usca, usnat }, { usnat, usca }]) {
      const v = build(
        obs({
          gpp: { ...gppWith({}), applicableSections: [7, 8], sections },
          signal: { propertyValue: true, secGpcRequestCount: 9 } as never,
        }),
      );
      const row = v.privacyStrings.find((r) => r.id === "gpp");
      const heads = (row?.groups ?? []).filter((g) => g.fields.some((f) => f.labelKey === "gppLabelSection"));
      expect(heads.map((g) => g.fields.find((f) => f.labelKey === "gppLabelSection")?.raw)).toEqual(["usnat", "usca"]);
      expect(heads.map((g) => g.fields.find((f) => f.labelKey === "gppFieldGpc")?.valueKey)).toEqual(["valueYes", "valueNo"]);
      expect(heads.map((g) => g.noteKey)).toEqual([undefined, "gppNoteMismatchSignalSet"]);
      expect(row?.noteKey).toBeUndefined();
    }
  });

  it("carries no row note when the two agree", () => {
    const v = build(
      obs({
        gpp: gppWith({ Gpc: 1 }),
        signal: { propertyValue: true, secGpcRequestCount: 9 } as never,
      }),
    );
    expect(v.privacyStrings.find((r) => r.id === "gpp")?.noteKey).toBeUndefined();
  });
});

describe("GPP section kinds", () => {
  it("the registry and the engine name the same us-state sections", () => {
    // The engine picks the primary section from its own set; the popup labels and gates
    // sections from the registry. A section in one and not the other would be shown by one
    // and judged by neither.
    const registry = Object.entries(GPP_SECTIONS)
      .filter(([, s]) => s.kind === "us-state")
      .map(([prefix]) => prefix)
      .sort();
    expect([...US_STATE_GPP_SECTIONS].sort()).toEqual(registry);
  });

  it("the registry and the engine give each us-state section the same id", () => {
    // The engine matches applicableSections, which carries ids, against the sections the
    // string carries; the popup labels them from the registry. A differing id would have the
    // engine judge one section while the row named another.
    const registry = Object.fromEntries(
      Object.entries(GPP_SECTIONS)
        .filter(([, s]) => s.kind === "us-state")
        .map(([prefix, s]) => [prefix, s.id]),
    );
    expect(US_STATE_GPP_SECTION_IDS).toEqual(registry);
  });
});

describe("GPP sections under their pre-rename names", () => {
  it("decodes usnatv1 as US - National and judges it", () => {
    // streaming-e.example's consent tool reports section 7 as usnatv1, the name the IAB library used
    // until July 2024. Read under the current name only, the row would say "no US state
    // section decoded" while the section was there, recording Gpc 0 and an opt-out of sale.
    const gpp = { ...gppWith({}), applicableSections: [7], sections: { uspv1: {}, usnatv1: { Gpc: 0, SaleOptOut: 1, SharingOptOut: 1, TargetedAdvertisingOptOut: 1 } } };
    const row = build(obs({ gpp })).privacyStrings.find((r) => r.id === "gpp");
    const keys = row?.summary.map((s) => s.key) ?? [];
    expect(keys).not.toContain("valueGppNoUsSection");
    expect(keys).toContain("valueGppOptedOut");
    expect(row?.groups?.[0]?.fields[0]).toMatchObject({ labelKey: "gppLabelSection", value: "US - National (7)", raw: "usnatv1" });
  });
});

describe("what this site did", () => {
  const checked = (v: ReturnType<typeof build>) =>
    v.gpcReads.find((r) => r.labelKey === "labelCheckedForGpc");

  /** A __gpp call, attributed or not. */
  const gppCall = (
    callerScriptUrl: string | null,
    viaTagManager = false,
  ): ObservationSet["consentApiCalls"][number] => ({
    api: "__gpp",
    command: "getGPPData",
    callerScriptUrl,
    viaTagManager,
    timeMs: 0,
  });

  const classify = classifyWith([
    ["criteo", "Criteo", "advertising"],
    ["doubleclick", "Google", "advertising"],
    ["adsrvr", "The Trade Desk", "advertising"],
    ["amazon", "Amazon", "advertising"],
    ["clarity", "Microsoft", "analytics"],
  ]);

  function buildWith(o: ObservationSet, findings: Finding[] = []) {
    return buildPopupView({
      observations: o,
      findings,
      distinctCookies: 0,
      adTechRequests: 5,
      classify,
    });
  }

  const readsOf = (readsByScript: Record<string, number>, attribution: Record<string, unknown>, readCount = 40) =>
    ({ readTracking: "active", readCount, readsByScript, readAttribution: attribution }) as never;
  const Y = "labelReadObserved";
  const N = "labelReadNotObserved";
  const U = "labelReadUndetermined";
  const NONE = "valueReadNone";

  it("is a group of two rows under its heading, each saying none when nobody is in it", () => {
    const v = build(obs({ signal: { readTracking: "active", readCount: 0 } as never }));
    expect(readShape(v)).toEqual([[Y, NONE], [N, NONE]]);
    // The heading stands alone: no value, and no notes of its own here.
    expect(checked(v)?.valueKey).toBeUndefined();
    expect(checked(v)?.lines).toBeUndefined();
  });

  it("keeps the rows when reads are not observable, and says so under No read observed", () => {
    // Absence of data is never a finding: "not observable" and "no read" are different
    // claims and must not be conflated.
    const v = build(obs({ signal: { readTracking: "unavailable", readCount: null } as never }));
    expect(readShape(v)).toEqual([[Y, NONE], [N, NONE, "hintReadsUnavailable"]]);
  });

  it("says reads are not counted while sending is off, rather than that they could not be observed", () => {
    // With sending off and nothing else owning the property, the extension defines none
    // (1.43.0): a choice, not a failure of the count.
    const v = buildPopupView({
      observations: obs({ signal: { source: "none", propertyValue: "absent", readTracking: "unavailable", readCount: null } as never }),
      findings: [], distinctCookies: 0, adTechRequests: 0, sendingSignal: false, signalKnown: true,
    });
    expect(readShape(v)).toEqual([[Y, NONE], [N, NONE, "hintReadsOffInSettings"]]);
  });

  it("still credits a GPP call when property reads could not be counted", () => {
    // The __gpp wrapper is independent of the property descriptor, so a call is a read we
    // saw. An unidentified caller is said so, under the readers.
    const v = build(
      obs({
        signal: { readTracking: "unavailable", readCount: null } as never,
        consentApiCalls: [gppCall(null)],
        gpp: gppWith({ Gpc: 1 }),
      }),
    );
    expect(readShape(v)).toEqual([[Y, NONE, "hintGppCalledUnidentified"], [N, NONE, "hintReadsUnavailable"]]);
  });

  it("does not present the site's GPP string as evidence that anything read it", () => {
    // A string can record the choice with no script ever asking for it.
    const v = build(obs({ signal: { readTracking: "active", readCount: 0 } as never, gpp: gppWith({ Gpc: 1 }) }));
    expect(readShape(v)).toEqual([[Y, NONE], [N, NONE], ["group", "hintNoCheckGppRecords"]]);
  });

  it("puts a GPP caller in the first row when it is a listed vendor", () => {
    const v = buildWith(
      obs({
        signal: { readTracking: "active", readCount: 0, readsByScript: {} } as never,
        consentApiCalls: [gppCall("https://securepubads.g.doubleclick.net/y.js")],
        gpp: gppWith({ Gpc: 1 }),
      }),
    );
    // The row label says which list it is, so the line is the names alone: the company and
    // the category of the domain its script came from.
    expect(readRows(v).rows[0]?.lines?.[0]?.parts).toEqual([]);
    expect(readRows(v).yes).toEqual(["Google [advertising]"]);
    expect(readShape(v)).toEqual([[Y, "names"], [N, NONE]]);
  });

  it("notes a silent GPP string at the bottom of the group, but only while the signal is on", () => {
    // With sending off a string whose GPC field is 0 is simply correct, and the call read it.
    // With the signal on the caller was told nothing of the choice: not a read, so its
    // domain is not named under the readers.
    const on = buildWith(
      obs({
        signal: { readTracking: "active", readCount: 0, readsByScript: {} } as never,
        consentApiCalls: [gppCall("https://cdn.example/cmp.js")],
        gpp: gppWith({ Gpc: 0 }),
      }),
    );
    expect(readShape(on)).toEqual([[Y, NONE], [N, NONE], ["group", "hintGppStringSilent"]]);
    const off = buildWith(
      obs({
        signal: { source: "none", readTracking: "active", readCount: 0, readsByScript: {} } as never,
        consentApiCalls: [gppCall("https://cdn.example/cmp.js")],
        gpp: gppWith({ Gpc: 0 }),
      }),
    );
    expect(readShape(off)).toEqual([[Y, NONE, "hintCheckedOtherDomains"], [N, NONE]]);
  });

  it("names one vendor in the first row", () => {
    const v = buildWith(obs({ signal: readsOf({ "https://static.criteo.net/js/ld/publishertag.js": 6 }, { sampled: 6, unattributed: 0, viaTagManager: 0 }, 1904) }));
    expect(readRows(v).yes).toEqual(["Criteo [advertising]"]);
    expect(readShape(v)).toEqual([[Y, "names"], [N, NONE]]);
  });

  it("lists every vendor in a row, however many, in the order of their names", () => {
    // No "and 1 more" with the rest in a hover: the line names every vendor.
    const v = buildWith(
      obs({
        signal: readsOf(
          {
            "https://static.criteo.net/x.js": 6,
            "https://securepubads.g.doubleclick.net/y.js": 2,
            "https://js.adsrvr.org/z.js": 1,
            "https://c.amazon-adsystem.com/w.js": 1,
            "https://www.clarity.ms/tag/x": 1,
          },
          { sampled: 11, unattributed: 0, viaTagManager: 0 },
        ),
      }),
    );
    expect(readRows(v).yes).toEqual([
      "Amazon [advertising]", "Criteo [advertising]", "Google [advertising]", "Microsoft [analytics]", "The Trade Desk [advertising]",
    ]);
    expect(readRows(v).rows[0]?.lines?.[0]).not.toHaveProperty("title");
  });

  it("unions vendors traced through reads with vendors traced through GPP calls", () => {
    const v = buildWith(
      obs({
        signal: readsOf({ "https://static.criteo.net/x.js": 6 }, { sampled: 6, unattributed: 0, viaTagManager: 0 }),
        consentApiCalls: [gppCall("https://securepubads.g.doubleclick.net/y.js")],
        gpp: gppWith({ Gpc: 1 }),
      }),
    );
    expect(readRows(v).yes).toEqual(["Criteo [advertising]", "Google [advertising]"]);
  });

  it("does not claim a vendor when the reading script is not on the list, and names its domain", () => {
    // The site's consent tool, typically, from a domain the list names no company for.
    const v = buildWith(obs({ signal: readsOf({ "https://cdn.usercentrics.eu/ui/loader.js": 40 }, { sampled: 40, unattributed: 0, viaTagManager: 0 }) }));
    expect(readShape(v)).toEqual([[Y, NONE, "hintCheckedOtherDomains"], [N, NONE]]);
    expect(readHint(v, "hintCheckedOtherDomains")).toMatchObject({ tone: "hint", parts: [{ key: "hintCheckedOtherDomains", substitution: [LIST_MARK] }] });
    expect(readHint(v, "hintCheckedOtherDomains")?.list).toEqual([{ text: "usercentrics.eu", domain: true }]);
  });

  it("adds the container, the domains of other scripts and the unidentified reads under the first row", () => {
    // Reads that resolved to nothing are one line here, and a caveat in each no-read vendor's help.
    const v = buildWith(
      obs({
        signal: readsOf(
          { "https://static.criteo.net/x.js": 6, "https://cdn.usercentrics.eu/ui/loader.js": 2 },
          { sampled: 148, unattributed: 100, viaTagManager: 40 },
          1904,
        ),
      }),
    );
    expect(readShape(v)).toEqual([[Y, "names", "hintCheckedTagManagerAlso", "hintCheckedOtherDomains", "hintReadsUnidentified"], [N, NONE]]);
  });

  it("names each domain once, the site's own first, in place of a count of scripts", () => {
    // A line such as "Also 2 scripts not on vendor list" says how many and not who.
    const v = buildWith(
      obs({
        signal: readsOf(
          {
            "https://static.criteo.net/x.js": 6,
            "https://cdn.usercentrics.eu/ui/loader.js": 2,
            "https://app.usercentrics.eu/browser-ui/bundle.js": 2,
            "https://global.ketchcdn.com/web/v3/config.js": 1,
            "https://www.example.com/app.js": 1,
          },
          { sampled: 12, unattributed: 0, viaTagManager: 0 },
        ),
      }),
    );
    const also = readHint(v, "hintCheckedOtherDomains");
    expect(who(also)).toEqual(["example.com (this site)", "ketchcdn.com", "usercentrics.eu"]);
    expect(also?.list?.every((i) => i.domain === true)).toBe(true);
  });

  it("puts the site's own script on the line of domains, whether or not the list names its owner", () => {
    // yahoo.com: a Yahoo! script that reads GPC is first party, so it is no vendor, whether
    // or not Yahoo! has a row. The rows hold third-party vendors and nothing else.
    const yahoo = classifyWith([["yahoo.com", "Yahoo!", "content"], ["yimg.com", "Yahoo!", "content"]], "yahoo.com");
    const o = obs({
      context: { topSite: "www.yahoo.com", finalUrl: "https://www.yahoo.com/" } as never,
      signal: readsOf({ "https://www.yahoo.com/consent.js": 3 }, { sampled: 3, unattributed: 0, viaTagManager: 0 }),
    });
    const bare = buildPopupView({ observations: o, findings: [], distinctCookies: 0, adTechRequests: 5, classify: yahoo });
    expect(readShape(bare)).toEqual([[Y, NONE, "hintCheckedOtherDomains"], [N, NONE]]);
    expect(who(readHint(bare, "hintCheckedOtherDomains"))).toEqual(["yahoo.com (this site)"]);
    // And the same where Yahoo! has a row of its own, from another of its domains.
    const withRow = buildPopupView({
      observations: { ...o, tallies: { ...EMPTY_TALLIES, totalRequests: 9, byEntityCategory: summaries(summary("Yahoo!", "content", { hosts: ["s.yimg.com"] })) } },
      findings: [pairFinding("Yahoo!", "content", "vendor-did-not-read-gpc")],
      distinctCookies: 0,
      adTechRequests: 5,
      classify: yahoo,
    });
    expect(readRows(withRow).yes).toEqual([]);
    expect(readRows(withRow).no).toEqual(["Yahoo! [content]"]);
    expect(who(readHint(withRow, "hintCheckedOtherDomains"))).toEqual(["yahoo.com (this site)"]);
  });

  it("names the container when its id is known, one or several, else 'the tag manager'", () => {
    const a = "https://www.googletagmanager.com/gtm.js?id=GTM-A";
    const b = "https://www.googletagmanager.com/gtm.js?id=GTM-B&l=NF2DL";
    const container = (v: PopupView) => readRows(v).rows[0]?.lines?.[0]?.parts[0];
    const one = buildWith(obs({ signal: readsOf({}, { sampled: 40, unattributed: 0, viaTagManager: 40, viaTagManagerByContainer: { [a]: 40 } }) }));
    // No vendor named in the row, so no "also".
    expect(readShape(one)).toEqual([[Y, NONE, "hintCheckedContainerRead"], [N, NONE]]);
    expect(container(one)).toEqual({ key: "hintCheckedContainerRead", substitution: ["GTM-A"] });
    const two = buildWith(obs({ signal: readsOf({}, { sampled: 40, unattributed: 0, viaTagManager: 40, viaTagManagerByContainer: { [a]: 30, [b]: 10 } }) }));
    expect(container(two)).toEqual({ key: "hintCheckedContainersRead", substitution: ["GTM-A, GTM-B"] });
    // A pre-1.12.0 record, or a helper frame from the tag manager's host.
    const unnamed = buildWith(obs({ signal: readsOf({}, { sampled: 40, unattributed: 0, viaTagManager: 40, viaTagManagerByContainer: { "https://www.googletagmanager.com/debug/bootstrap": 40 } }) }));
    expect(container(unnamed)).toEqual({ key: "hintCheckedTagManagerRead" });
    // With a vendor named in the row the container "also" read it.
    const beside = buildWith(obs({ signal: readsOf({ "https://static.criteo.net/x.js": 6 }, { sampled: 10, unattributed: 0, viaTagManager: 4, viaTagManagerByContainer: { [a]: 4 } }) }));
    expect(readRows(beside).rows[0]?.lines?.[1]?.parts[0]).toEqual({ key: "hintCheckedContainerAlso", substitution: ["GTM-A"] });
  });

  it("says reads were counted but none traced, so none does not read as nothing read it", () => {
    const none = buildWith(obs({ signal: readsOf({}, { sampled: 0, unattributed: 0, viaTagManager: 0 }, 12) }));
    expect(readShape(none)).toEqual([[Y, NONE, "hintReadsNoneTraced"], [N, NONE]]);
    const unresolved = buildWith(obs({ signal: readsOf({}, { sampled: 40, unattributed: 40, viaTagManager: 0 }) }));
    expect(readShape(unresolved)).toEqual([[Y, NONE, "hintReadsNoneTraced"], [N, NONE]]);
  });

  it("says a script also read the property unidentified, beside the reads that named one", () => {
    // One page read the property 54 times and 33 named no script; another read it once and
    // named nothing. The unnamed reads are recorded, and said.
    const beside = buildWith(obs({ signal: readsOf({ "https://static.criteo.net/x.js": 21 }, { sampled: 54, unattributed: 33, viaTagManager: 0 }, 54) }));
    expect(readShape(beside)).toEqual([[Y, "names", "hintReadsUnidentified"], [N, NONE]]);
    // Beside a container's reads, or another domain's, it is the same line.
    const container = buildWith(obs({ signal: readsOf({}, { sampled: 10, unattributed: 2, viaTagManager: 8 }) }));
    expect(readHint(container, "hintReadsUnidentified")).toBeDefined();
    // Every read unnamed: the existing line already says so, and is not repeated.
    const alone = buildWith(obs({ signal: readsOf({}, { sampled: 1, unattributed: 1, viaTagManager: 0 }, 1) }));
    expect(readShape(alone)).toEqual([[Y, NONE, "hintReadsNoneTraced"], [N, NONE]]);
    // None unnamed, or reads not observable at all: no line.
    const named = buildWith(obs({ signal: readsOf({ "https://static.criteo.net/x.js": 3 }, { sampled: 3, unattributed: 0, viaTagManager: 0 }, 3) }));
    expect(readHint(named, "hintReadsUnidentified")).toBeUndefined();
    const unavailable = buildWith(obs({ signal: { ...(readsOf({}, { sampled: 3, unattributed: 3, viaTagManager: 0 }) as object), readTracking: "unavailable" } as never }));
    expect(readHint(unavailable, "hintReadsUnidentified")).toBeUndefined();
  });

  it("lists the vendor rows' No and Cannot determine states in rows of their own, and puts the cap under No read observed", () => {
    const state = (name: string, flag: string, artifact: unknown): Finding =>
      ({ flag, rank: 40, entity: { name, domains: [] }, artifact } as never);
    const findings = [
      cookieFinding("The Trade Desk", "TDID"), state("The Trade Desk", "vendor-did-not-read-gpc", { kind: "none" }),
      cookieFinding("Google", "IDE"), state("Google", "vendor-gpc-check-unattributable", { kind: "vendor-check-container", containerCallCount: 1, consentModeActive: false }),
      cookieFinding("Criteo", "uid"), state("Criteo", "vendor-read-gpc", { kind: "signal-read" }),
      cookieFinding("comScore", "UID"), state("comScore", "vendor-no-script-observed", { kind: "none" }),
    ];
    const capped = build(obs({ signal: readsOf({}, { sampled: 2100, unattributed: 30, viaTagManager: 0, traceCapReached: true }, 5000) }), findings);
    // The 30 reads that named no script are a line of their own beside the named reader.
    expect(readShape(capped)).toEqual([[Y, "names", "hintReadsUnidentified"], [N, "names", "hintReadsCapped"], [U, "names"]]);
    // These rows come from findings that name no category, so the names stand alone.
    const r = readRows(capped);
    expect([r.yes, r.no, r.unsure]).toEqual([["Criteo"], ["The Trade Desk"], ["Google"]]);
    // Under the cap the row carries no note, and a passive vendor is in no row.
    const under = build(obs({ signal: readsOf({}, { sampled: 50, unattributed: 0, viaTagManager: 0 }, 50) }), findings);
    expect(readShape(under)).toEqual([[Y, "names"], [N, "names"], [U, "names"]]);
    expect(readRows(under).no).toEqual(["The Trade Desk"]);
  });

  it("puts the site's GPP string at the bottom of the group, under none of its rows", () => {
    const findings = [cookieFinding("Google", "IDE"), pairFinding("Google", "advertising", "vendor-gpc-check-unattributable")];
    const v = build(obs({ signal: { readTracking: "active", readCount: 0 } as never, gpp: gppWith({ Gpc: 1 }) }), findings);
    expect(readShape(v)).toEqual([[Y, NONE], [N, NONE], [U, "names"], ["group", "hintNoCheckGppRecords"]]);
  });

  it("never shows the raw read count in the row", () => {
    // A consent tool polling in a loop produces thousands of reads. The number measured
    // dwell time and read as alarming; it lives in each vendor's detail panel instead.
    const v = buildWith(obs({ signal: { readTracking: "active", readCount: 1904, readsByScript: {} } as never }));
    expect(JSON.stringify(checked(v))).not.toContain("1904");
  });

  it("does not carry the privacy strings", () => {
    // They have their own section. This section answers "how did the site respond to
    // GPC"; that one answers "what does the site broadcast about the reader". Six flat rows
    // answering two unrelated questions would make both illegible.
    const v = build(
      obs({
        gpp: gppWith({ Gpc: 1 }),
        usPrivacy: { fromApi: "1YYN", fromCookie: null, fromWire: null },
        tcf: { tcString: "x", gdprApplies: true, purposeConsents: { 1: true } },
      }),
    );
    for (const label of ["labelPrivacyString", "labelUsPrivacy", "labelTcf"]) {
      expect(v.siteDid.some((r) => r.labelKey === label)).toBe(false);
    }
  });

  it("draws no confirmation row when the scans found none", () => {
    // A site often confirms in a dialog behind a link or on a settings page, which this
    // scan cannot see, so "no" would read as a statement about the site. The heading's hover
    // text says a confirmation is listed when the page shows one.
    const v = build(obs({ confirmationNotice: "not-detected" }));
    expect(v.siteDid.map((r) => r.labelKey)).not.toContain("labelConfirmation");
    expect(v.confirmationScan).toBe("not-seen");
  });

  it("draws no confirmation row while the scans run", () => {
    const v = build(obs({ confirmationNotice: "indeterminate" }));
    expect(v.siteDid.map((r) => r.labelKey)).not.toContain("labelConfirmation");
    expect(v.confirmationScan).toBe("checking");
  });

  it("draws no confirmation row when the check was turned off, and says it was off", () => {
    const v = build(obs({ confirmationNotice: "not-checked" }));
    expect(v.siteDid.map((r) => r.labelKey)).not.toContain("labelConfirmation");
    expect(v.confirmationScan).toBe("off");
  });

  it("draws a seen confirmation as yes, with the page's words quoted and the beta tag", () => {
    const v = build(obs({ confirmationNotice: "detected", confirmationText: "Opt-Out Signal Honored" }));
    const row = v.siteDid.find((r) => r.labelKey === "labelConfirmation");
    expect(row?.valueKey).toBe("valueYes");
    expect(row?.tag).toEqual({ key: "tagBeta", titleKey: "tagBetaHelp" });
    expect(row?.hintParts).toEqual([{ key: "hintConfirmationQuote", substitution: ["Opt-Out Signal Honored"] }]);
    expect(row?.hintMono).toBeUndefined();
    expect(v.confirmationScan).toBe("seen");
  });

  it("draws a seen confirmation without a quote when the record has no words, as one made before 1.41.0", () => {
    const row = build(obs({ confirmationNotice: "detected" })).siteDid.find((r) => r.labelKey === "labelConfirmation");
    expect(row?.valueKey).toBe("valueYes");
    expect(row?.tag?.key).toBe("tagBeta");
    expect(row?.hintParts).toBeUndefined();
  });

  it("renders every row with sending off, the confirmation first and the GPC read group under the privacy strings", () => {
    // A reader turning the signal off to compare two visits needs the same panel both
    // times. Only the cookie count is withheld, and that is the count block's job to say.
    // The confirmation leads: some states require one, and none requires the file.
    const v = build(obs({ signal: { source: "none" } as never }));
    expect(v.state).toBe("signal-off");
    expect(v.siteDid.map((r) => r.labelKey)).toEqual(["labelWellKnown"]);
    const seen = build(obs({ signal: { source: "none" } as never, confirmationNotice: "detected" }));
    expect(seen.siteDid.map((r) => r.labelKey)).toEqual(["labelConfirmation", "labelWellKnown"]);
    // The read rows are not among the site's own: a GPP call is a read by what the string
    // records, so they follow the strings.
    expect(v.gpcReads.map((r) => r.labelKey)).toEqual(["labelCheckedForGpc"]);
    expect(v.gpcReads[0]?.rows?.map((r) => r.labelKey)).toEqual(["labelReadObserved", "labelReadNotObserved"]);
  });
});

const strRow = (v: ReturnType<typeof build>, id: "gpp" | "usp" | "tcf") =>
  v.privacyStrings.find((r) => r.id === id);

describe("privacy strings: GPP", () => {
  const withGpp = (sections: Record<string, Record<string, number>>, applicable = [8]) =>
    build(
      obs({
        gpp: {
          rawString: "DBABBg~BVoYYYNQ.QA",
          applicableSections: applicable,
          gppVersion: "1.1",
          sections,
          unparseable: false,
          fromWire: null,
        },
      }),
    );

  it("states the GPC field and the opt-out outcome as two plain-language halves", () => {
    const row = strRow(withGpp({ usca: { Gpc: 1, SaleOptOut: 2 } }), "gpp");
    expect(row?.summary.map((p) => p.key)).toEqual([
      "valueGpcFieldYes",
      "valueGppNotOptedOut",
    ]);
  });

  it("flags the IAB-described conflict, matching gppConflict's own condition", () => {
    // Gpc === 1 alongside an opt-out field of 2, within the same section. Derived from the
    // same condition the engine rule uses so the row and the finding notice above it can
    // never disagree.
    expect(strRow(withGpp({ usca: { Gpc: 1, SaleOptOut: 2 } }), "gpp")?.flagged).toBe(true);
    expect(strRow(withGpp({ usca: { Gpc: 1, SaleOptOut: 1 } }), "gpp")?.flagged).toBe(false);
    expect(strRow(withGpp({ usca: { Gpc: 0, SaleOptOut: 2 } }), "gpp")?.flagged).toBe(false);
  });

  it("distinguishes a GPC field of 0 from no GPC field at all", () => {
    // Two different facts that must not both render as silence: the CMP recorded that it did
    // NOT see GPC, versus the CMP omitted the sub-section entirely.
    expect(strRow(withGpp({ usca: { Gpc: 0, SaleOptOut: 2 } }), "gpp")?.summary[0]?.key).toBe(
      "valueGpcFieldNo",
    );
    expect(strRow(withGpp({ usca: { SaleOptOut: 2 } }), "gpp")?.summary[0]?.key).toBe(
      "valueGpcFieldAbsent",
    );
  });

  it("decodes only the string's own fields, not this browser's state", () => {
    // What THIS BROWSER sent is a fact about the page rather than a field of the GPP
    // string, and the first line of the popup already says the GPC signal is set on the same
    // screen, so the panel shows only what the string records.
    //
    // The comparison remains, just not adjacent: a string recording Gpc: 0 while we are
    // sending still shows its GPC field as "no" here under a status row saying the signal is
    // set.
    const row = strRow(withGpp({ usca: { Gpc: 1, SaleOptOut: 2 } }), "gpp");
    const first = row?.groups?.[0];
    expect(first?.labelKey).toBeUndefined();
    expect(first?.fields.map((f) => f.labelKey)).toEqual(["gppLabelSection", "gppFieldGpc"]);
  });

  it("keeps the raw IAB integer beside the decoded GPC field", () => {
    // The third column is the point throughout this panel: 0/1/2 do not mean what a reader
    // would guess, so the integer never appears without its decode and the decode never
    // appears without the integer that produced it.
    const gpc = strRow(withGpp({ usca: { Gpc: 0, SaleOptOut: 2 } }), "gpp")
      ?.groups?.[0]?.fields.find((f) => f.labelKey === "gppFieldGpc");
    expect(gpc?.valueKey).toBe("valueNo");
    expect(gpc?.raw).toBe("0");
  });

  it("names the section instead of printing a registry integer", () => {
    // "sections: 8" is a raw registry id shown to a consumer. Section 8 is California —
    // and 9 is Virginia, which is exactly the kind of off-by-one that makes a lookup table
    // safer than recall.
    const row = strRow(withGpp({ usca: { Gpc: 1, SaleOptOut: 2 } }), "gpp");
    const section = row?.groups?.[0]?.fields?.[0];
    expect(section?.labelKey).toBe("gppLabelSection");
    expect(section?.value).toBe("US - California (8)");
  });

  it("decodes opt-out fields with the raw integer beside the meaning", () => {
    // IAB's 2 means did-NOT-opt-out, so the integer never appears without its decode.
    const row = strRow(withGpp({ usca: { Gpc: 1, SaleOptOut: 2, SharingOptOut: 1 } }), "gpp");
    const fields = row?.groups?.find((g) => g.labelKey === "gppGroupOptOut")?.fields ?? [];
    expect(fields).toContainEqual(
      expect.objectContaining({
        labelKey: "gppFieldSaleOptOut",
        valueKey: "valueNotOptedOut",
        raw: "2",
      }),
    );
    expect(fields).toContainEqual(
      expect.objectContaining({ labelKey: "gppFieldSharingOptOut", valueKey: "valueOptedOut" }),
    );
  });

  it("decodes all three MSPA fields", () => {
    const row = strRow(
      withGpp({ usnat: { SaleOptOut: 1, MspaCoveredTransaction: 1, MspaServiceProviderMode: 2, MspaOptOutOptionMode: 0 } }, [7]),
      "gpp",
    );
    const fields = row?.groups?.find((g) => g.labelKey === "gppGroupOptOut")?.fields ?? [];
    expect(fields.filter((f) => f.labelKey?.startsWith("gppFieldMspa"))).toEqual([
      expect.objectContaining({ labelKey: "gppFieldMspaCoveredTransaction", valueKey: "valueYes", raw: "1" }),
      expect.objectContaining({ labelKey: "gppFieldMspaServiceProviderMode", valueKey: "valueNo", raw: "2" }),
      expect.objectContaining({ labelKey: "gppFieldMspaOptOutOptionMode", valueKey: "valueFieldNotApplicable", raw: "0" }),
    ]);
  });

  it("decodes a 1.31.0 bundle's misspelled MspaCoveredTransactions as the IAB field", () => {
    // Before 1.32.0 GppSectionFields named the field in the plural. withPersistedShape reads
    // it as the singular, keeping the value.
    const old = {
      ...obs({
        gpp: {
          rawString: "DBABLA~BVQVAAAAAAFY.YA",
          applicableSections: [7],
          gppVersion: "1.1",
          sections: { usnat: { SaleOptOut: 1, MspaCoveredTransactions: 2 } },
          unparseable: false,
          fromWire: null,
        },
      }),
      schemaVersion: "1.31.0",
    } as unknown as ObservationSet;
    const fields = strRow(build(old), "gpp")?.groups?.find((g) => g.labelKey === "gppGroupOptOut")?.fields ?? [];
    expect(fields).toContainEqual(
      expect.objectContaining({ labelKey: "gppFieldMspaCoveredTransaction", valueKey: "valueNo", raw: "2" }),
    );
  });

  it("summarizes the opt-out group as 'none recorded' when nothing opted out either way", () => {
    // Answers "GPC went in, and then what?" — the question a row that reports a detection
    // and stops invites.
    const row = strRow(withGpp({ usca: { Gpc: 1, SaleOptOutNotice: 1 } }), "gpp");
    expect(row?.groups?.find((g) => g.labelKey === "gppGroupOptOut")?.summaryKey).toBe(
      "valueOptOutNoneRecorded",
    );
  });

  it("never reports an opt-out state from a section that cannot express one", () => {
    // From a real news-f.example capture. Its GPP string carries tcfeuv2 ~ tcfcav1 ~ uspv1
    // and NO US state section. A fallback that takes Object.entries()[0] regardless of kind
    // would show a reader in California the CANADIAN TCF section and report that consent
    // section's lack of opt-out fields as "no opt-out recorded", while the very same
    // string's uspv1 section says 1YY-, opted out of sale, which the USP row displays. One
    // string, two rows, contradicting each other.
    const row = strRow(withGpp({ tcfeuv2: {}, tcfcav1: {}, uspv1: {} }, [2, 5, 6]), "gpp");
    expect(row?.summary[0]?.key).toBe("valueGppNoUsSection");
    // And it points at the row that does carry the answer, rather than leaving the reader
    // to reconcile the two.
    expect(row?.noteKey).toBe("gppOnlyLegacyUsNote");
    // ONE row listing all three, not one row per section repeating the same label. And
    // ordered by section id -- the string's own order -- rather than by display label,
    // which would put "US Privacy" before "EU TCF v2" on the strength of the letter U.
    const fields = row?.groups?.[0]?.fields ?? [];
    expect(fields).toHaveLength(1);
    expect(fields[0]?.labelKey).toBe("gppLabelSections");
    expect(fields[0]?.value).toBe("EU TCF v2 (2), Canada TCF (5), US Privacy (6)");
  });

  it("uses the singular label when the string carries one section", () => {
    const row = strRow(withGpp({ tcfeuv2: {} }, [2]), "gpp");
    expect(row?.groups?.[0]?.fields?.[0]?.labelKey).toBe("gppLabelSection");
    expect(row?.groups?.[0]?.fields?.[0]?.value).toBe("EU TCF v2 (2)");
  });

  it("does not list a section twice when both surfaces name it", () => {
    // applicableSections carries ids and parsedSections carries prefixes, so the same
    // section arrives under two spellings. Deduping on the label would break the moment a
    // registry name changed; this dedupes on the id itself.
    const row = strRow(withGpp({ tcfcav1: {}, uspv1: {} }, [5, 6]), "gpp");
    expect(row?.groups?.[0]?.fields?.[0]?.value).toBe("Canada TCF (5), US Privacy (6)");
  });

  it("distinguishes consent-only from legacy-US-only in the explanation", () => {
    // A string with nothing but TCF sections has no US opt-out anywhere, which is a
    // different fact from one whose opt-out is in the deprecated uspv1 section.
    const consentOnly = strRow(withGpp({ tcfeuv2: {} }, [2]), "gpp");
    expect(consentOnly?.summary[0]?.key).toBe("valueGppNoUsSection");
    expect(consentOnly?.noteKey).toBe("gppNoUsSectionNote");
  });

  it("says a US section was named with no fields when applicableSections names one the page reported nothing for", () => {
    const row = strRow(withGpp({}, [8]), "gpp");
    expect(row?.summary).toEqual([{ key: "valueGppUsSectionNoFields" }]);
    // The no-US notes would contradict the summary.
    expect(row?.noteKey).toBeUndefined();
    expect(row?.groups?.[0]?.fields).toEqual([{ labelKey: "gppLabelSection", value: "US - California (8)" }]);
  });

  it("reads -1 and 0 as no US state section, never printed raw and with no note", () => {
    for (const id of [-1, 0]) {
      const row = strRow(withGpp({}, [id]), "gpp");
      expect(row?.summary).toEqual([{ key: "valueGppNoUsSection" }]);
      expect(row?.noteKey).toBeUndefined();
      expect(row?.groups).toEqual([]);
    }
  });

  it("leaves -1 out of the section list beside a real section", () => {
    const row = strRow(withGpp({ tcfeuv2: {} }, [-1, 2]), "gpp");
    expect(row?.noteKey).toBe("gppNoUsSectionNote");
    expect(row?.groups?.[0]?.fields).toEqual([{ labelKey: "gppLabelSection", value: "EU TCF v2 (2)" }]);
  });

  it("gives the no-US note only when a consent section is present", () => {
    const row = strRow(withGpp({ xyz: {} }, []), "gpp");
    expect(row?.summary).toEqual([{ key: "valueGppNoUsSection" }]);
    expect(row?.noteKey).toBeUndefined();
    expect(row?.groups?.[0]?.fields?.[0]?.value).toBe("xyz");
  });

  it("says 'not present' for a page with no string, no sections and nothing on a request", () => {
    expect(strRow(withGpp({}, []), "gpp")?.summary).toEqual([{ key: "valueNotPresent" }]);
  });

  it("says 'opted out of some' when one opt-out field is 1 and another is 2", () => {
    const mixed = strRow(withGpp({ usca: { Gpc: 1, SaleOptOut: 1, SharingOptOut: 2 } }), "gpp");
    expect(mixed?.summary.map((p) => p.key)).toEqual(["valueGpcFieldYes", "valueGppOptedOutSome"]);
    // A 1 beside a 0 (not applicable) is still a plain opt-out.
    const plain = strRow(withGpp({ usca: { Gpc: 1, SaleOptOut: 1, SharingOptOut: 0 } }), "gpp");
    expect(plain?.summary.map((p) => p.key)).toEqual(["valueGpcFieldYes", "valueGppOptedOut"]);
  });

  it("prefers a US state section over any other kind present", () => {
    const row = strRow(
      withGpp({ tcfcav1: {}, usca: { Gpc: 1, SaleOptOut: 2 } }, [5, 8]),
      "gpp",
    );
    expect(row?.groups?.[0]?.fields?.[0]?.value).toBe("US - California (8)");
    expect(row?.summary.map((p) => p.key)).toEqual([
      "valueGpcFieldYes",
      "valueGppNotOptedOut",
    ]);
  });

  it("links the decoder WITH the string in the fragment, so it opens decoded", () => {
    // Verified 2026-09-22: "#<string>" fills the #gpp-string textarea and decodes it. A
    // fragment is never sent in the HTTP request, so rendering the link transmits nothing.
    const row = strRow(withGpp({ usca: { Gpc: 1, SaleOptOut: 2 } }), "gpp");
    expect(row?.linkUrl).toBe("https://iabgpp.com/#DBABBg~BVoYYYNQ.QA");
    expect(row?.linkTextKey).toBe("linkGppDecoder");
  });

  it("links the TCF decoder WITH the string too: the site routes a TC string to its TCF field", () => {
    // Verified 2026-09-22: a bare TC string in the fragment fills #tcfeu-string and decodes.
    const row = strRow(
      build(
        obs({
          tcf: { tcString: "CQJAbc", gdprApplies: false, purposeConsents: { 1: true } },
        }),
      ),
      "tcf",
    );
    expect(row?.linkUrl).toBe("https://iabgpp.com/#CQJAbc");
  });

  it("sends the GPP and TCF rows to the same decoder", () => {
    // iabtcf.com now redirects to iabgpp.com, whose tool carries both a GPP field and a TCF
    // field. Two constants pointing at one destination is how they drift apart.
    const gpp = strRow(withGpp({ usca: { Gpc: 1, SaleOptOut: 2 } }), "gpp")?.linkUrl;
    const tcf = strRow(
      build(
        obs({
          tcf: { tcString: "CQJAbc", gdprApplies: false, purposeConsents: { 1: true } },
        }),
      ),
      "tcf",
    )?.linkUrl;
    expect(tcf && new URL(tcf).origin).toBe(gpp && new URL(gpp).origin);
  });

  it("offers the decoder most of all when we could not read the string", () => {
    const v = build(
      obs({
        gpp: {
          rawString: "garbage",
          applicableSections: [],
          gppVersion: null,
          sections: {},
          unparseable: true,
          fromWire: null,
        },
      }),
    );
    // Still offered, and still pre-filled: an unreadable string is exactly when a reader
    // wants a second opinion.
    expect(strRow(v, "gpp")?.linkUrl).toBe("https://iabgpp.com/#garbage");
  });

  it("reports an undecodable string without calling it malformed", () => {
    // Whether the fault is the site's string or our decoder is what "Looks wrong" exists to
    // find out. The raw value travels with it so a reader can judge.
    const v = build(
      obs({
        gpp: {
          rawString: "garbage",
          applicableSections: [],
          gppVersion: null,
          sections: {},
          unparseable: true,
          fromWire: null,
        },
      }),
    );
    const row = strRow(v, "gpp");
    expect(row?.summary[0]?.key).toBe("valueStringNotReadable");
    expect(row?.raw).toBe("garbage");
  });
});

describe("privacy strings: USP", () => {
  const withUsp = (fromApi: string | null, fromCookie: string | null, fromWire: string | null) =>
    build(obs({ usPrivacy: { fromApi, fromCookie, fromWire } }));

  it("prefers the API surface, and says a wire-only string is not the page's", () => {
    expect(strRow(withUsp("1YYN", null, "1YNN"), "usp")?.summary[0]?.key).toBe(
      "valueUspOptedOutY",
    );
    // With only the wire, the row must not read as the site's own opt-out state. On
    // news-b.example (2026-09-22) the wire string was a `1NNN` hardcoded in a sync redirect,
    // on a page with no __uspapi. The string is still decoded in the panel; the row says
    // whose it is.
    const wireOnly = strRow(withUsp(null, null, "1YNN"), "usp");
    expect(wireOnly?.summary[0]?.key).toBe("valueUspWireOnly");
    expect(wireOnly?.raw).toBe("1YNN");
  });

  it("prefers the cookie surface over the wire when the API is absent", () => {
    // The cookie is still page-side truth (the CMP's own persisted state); the wire is a
    // third party's copy of it. Falling to the wire while a cookie was available would show
    // "what a vendor received" as if it were "what the page reports".
    const row = strRow(withUsp(null, "1NYN", "1NNN"), "usp");
    expect(row?.summary[0]?.key).toBe("valueUspOptedOutY");
    expect(row?.raw).toBe("1NYN");
  });

  it("decodes all four characters, not only the opt-out one", () => {
    // Decoding character 3 is not enough: the row shows WHICH character, and that three
    // others exist.
    const fields = strRow(withUsp("1YNN", null, null), "usp")?.groups?.[0]?.fields ?? [];
    expect(fields.map((f) => f.labelKey)).toEqual([
      "uspLabelVersion",
      "uspLabelNotice",
      "uspLabelOptOut",
      "uspLabelLspa",
    ]);
    expect(fields[2]).toEqual(
      expect.objectContaining({ valueKey: "valueNo", raw: "N", emphasis: true }),
    );
  });

  it("separates a stated '-' from a string it could not read", () => {
    // These must not render identically. "This site says the rule does not apply to you" and
    // "we could not read this" are different claims — the same observed-versus-unlookable
    // distinction the rest of the popup keeps, applied inside a string.
    expect(strRow(withUsp("1Y-N", null, null), "usp")?.summary[0]?.key).toBe(
      "valueUspNotApplicable",
    );
    expect(strRow(withUsp("1Y", null, null), "usp")?.summary[0]?.key).toBe(
      "valueStringNotReadable",
    );
  });
});

describe("privacy strings: TCF", () => {
  it("counts granted purposes and names each one", () => {
    const v = build(
      obs({
        tcf: {
          tcString: "CPabc",
          gdprApplies: true,
          purposeConsents: { "1": true, "2": false, "3": true },
        },
      }),
    );
    const row = strRow(v, "tcf");
    expect(row?.summary[0]?.key).toBe("valueTcfGranted");
    // The granted count only: the panel lists every purpose, so "2 of 3" is not needed.
    expect(row?.summary[0]?.substitution).toEqual(["2"]);
    // Names, not "purpose 3: denied" — IAB's own published names, a lookup and not an
    // inference. A paraphrase would change what the CMP said.
    expect(row?.groups?.[0]?.fields?.[0]?.label).toBe(
      "Store and/or access information on a device",
    );
    expect(row?.linkUrl).toBeDefined();
  });

  it("always carries the scope note", () => {
    // TCF is a GDPR mechanism with no obligation relationship to GPC and must never read as
    // a response to it.
    const v = build(
      obs({ tcf: { tcString: "CPabc", gdprApplies: null, purposeConsents: { "1": true } } }),
    );
    expect(strRow(v, "tcf")?.noteKey).toBe("tcfScopeNote");
  });

  it("uses the singular key for one granted purpose", () => {
    const v = build(obs({ tcf: { tcString: "CPabc", gdprApplies: true, purposeConsents: { "1": true, "2": false } } }));
    expect(strRow(v, "tcf")?.summary).toEqual([{ key: "valueTcfGrantedOne" }]);
  });

  it("says 'no purposes granted' when purposes are listed and none is granted", () => {
    const v = build(obs({ tcf: { tcString: "CPabc", gdprApplies: true, purposeConsents: { "1": false, "2": false } } }));
    const row = strRow(v, "tcf");
    expect(row?.summary).toEqual([{ key: "valueTcfNoneGranted" }]);
    // Still opens to the purposes, each one denied.
    expect(row?.groups?.[0]?.fields?.slice(0, 2).map((f) => f.valueKey)).toEqual(["valueDenied", "valueDenied"]);
  });

  it("says 'no purposes reported' rather than confessing to a failed decode", () => {
    // A string arrived and the CMP's purpose map was empty. We decoded nothing because
    // there was nothing in it; wording about decoding would blame us for the site's own
    // sparse payload.
    const v = build(
      obs({ tcf: { tcString: "CPabc", gdprApplies: null, purposeConsents: {} } }),
    );
    expect(strRow(v, "tcf")?.summary[0]?.key).toBe("valueTcfNoPurposes");
  });

  it("shows 'not present' when the capability installed but nothing was observed", () => {
    expect(strRow(build(obs({ tcf: null })), "tcf")?.summary[0]?.key).toBe("valueNotPresent");
  });
});

describe("notices", () => {
  it("reports a found confirmation in the section rather than as a banner", () => {
    // www.news-f.example displays "Opt-Out Signal Honored" and the popup has to be able to
    // say so — but it is something the SITE did, so it belongs with the other things the
    // site did. As a banner it would duplicate the row and, with sending off, claim the site
    // had processed a signal we were not sending.
    const v = build(obs({ confirmationNotice: "detected" }));
    expect(v.notices.some((x) => x.kind === "confirmed")).toBe(false);
    expect(v.siteDid.find((r) => r.labelKey === "labelConfirmation")?.valueKey).toBe(
      "valueYes",
    );
  });

  it("warns when capture was incomplete", () => {
    const v = build(obs({ context: { incomplete: true } as never }));
    expect(v.notices.some((n) => n.kind === "incomplete")).toBe(true);
  });
});

describe("vendor rows", () => {
  it("dedupes cookie names per entity so the count matches the badge", () => {
    const v = build(obs(), [
      cookieFinding("Google", "IDE"),
      cookieFinding("Google", "IDE"),
      cookieFinding("Google", "DSID"),
    ]);
    expect(v.vendors).toHaveLength(1);
    expect(v.vendors[0]?.cookies).toEqual(["DSID", "IDE"]);
  });

  it("does NOT stamp a page-level GTM fact onto every vendor row", () => {
    // A page-level fact such as `consentApiCalls.some(c => c.viaTagManager)`, put on every
    // vendor, reads as "this vendor was loaded through GTM". We do not know that. On
    // retailer-m.example no consent call resolved to a container though GTM ran; on news-f.example
    // some did, which would tag every vendor regardless of how it loaded. checkKey comes
    // from the engine's per-vendor finding, not from any page-level consentApiCalls scan.
    const v = build(obs(), [
      cookieFinding("Criteo", "uid"),
      vendorSignalFinding("Criteo", "vendor-did-not-read-gpc"),
    ]);
    expect(v.vendors[0]?.checkKey).toBe("vendorGpcNotRead");
  });

  it("credits a vendor that asked via GPP and got a string recording GPC", () => {
    const v = build(obs({ gpp: gppWith({ Gpc: 1, SaleOptOut: 2 }) }), [
      cookieFinding("Criteo", "uid"),
      vendorSignalFinding("Criteo", "vendor-read-gpc", {
        kind: "consent-api",
        api: "__gpp",
        callCount: 1,
      }),
    ]);
    expect(v.vendors[0]?.checkKey).toBe("vendorGpcRead");
  });

  it("credits a vendor that read the GPC property directly", () => {
    // The mechanism the GPC spec defines for scripts. One engine state, but a different
    // act and different evidence from a GPP call, so it gets its own tag.
    const v = build(obs(), [
      cookieFinding("Criteo", "uid"),
      vendorSignalFinding("Criteo", "vendor-read-gpc", { kind: "signal-read", readCount: 4 }),
    ]);
    expect(v.vendors[0]?.checkKey).toBe("vendorGpcReadProperty");
  });

  it("says a vendor asked but was not told, when the string records no GPC choice", () => {
    // The vendor did what it could. The absence belongs to the SITE's string, and the
    // help text sends the reader to the GPP row rather than leaving it on the vendor.
    const v = build(obs({ gpp: gppWith({ Gpc: 0, SaleOptOut: 2 }) }), [
      cookieFinding("Criteo", "uid"),
      vendorSignalFinding("Criteo", "vendor-read-gpc", {
        kind: "consent-api",
        api: "__gpp",
        callCount: 1,
      }),
    ]);
    expect(v.vendors[0]?.checkKey).toBe("vendorGpcAskedNoGpcField");
  });

  it("keeps a direct property read when the vendor's GPP call was not told", () => {
    // The script read navigator.globalPrivacyControl and called __gpp. The call is the
    // engine's artifact; the string recording no GPC value says nothing about the read.
    const v = build(obs({ gpp: gppWith({ Gpc: 0, SaleOptOut: 2 }) }), [
      cookieFinding("Criteo", "uid"),
      vendorSignalFinding("Criteo", "vendor-read-gpc", {
        kind: "consent-api",
        api: "__gpp",
        callCount: 1,
        readCount: 2,
      }),
    ]);
    expect(v.vendors[0]?.checkKey).toBe("vendorGpcReadProperty");
    const nobody = build(obs(), [
      cookieFinding("Criteo", "uid"),
      vendorSignalFinding("Criteo", "vendor-read-gpc", { kind: "consent-api", api: "__gpp", callCount: 1, readCount: 2 }),
    ]);
    expect(nobody.vendors[0]?.checkKey).toBe("vendorGpcReadProperty");
  });

  it("claims nothing about the response when no GPP string was captured", () => {
    // "Asked, not told" would assert something about a string we never saw. With no string
    // the copy says only what was observed: it asked.
    const v = build(obs({ gpp: null }), [
      cookieFinding("Criteo", "uid"),
      vendorSignalFinding("Criteo", "vendor-read-gpc", {
        kind: "consent-api",
        api: "__gpp",
        callCount: 1,
      }),
    ]);
    expect(v.vendors[0]?.checkKey).toBe("vendorGpcAskedNoResponse");
  });

  it("treats an unparseable string as no string, not as a silent one", () => {
    const v = build(
      obs({ gpp: { ...gppWith({ Gpc: 1 }), unparseable: true, sections: {} } }),
      [
        cookieFinding("Criteo", "uid"),
        vendorSignalFinding("Criteo", "vendor-read-gpc", {
          kind: "consent-api",
          api: "__gpp",
          callCount: 1,
        }),
      ],
    );
    expect(v.vendors[0]?.checkKey).toBe("vendorGpcAskedNoResponse");
  });

  it("does NOT credit a vendor using a different vendor's finding", () => {
    // Entity matching happens in the engine (by classifier identity, not substring), so
    // the view-model's only job is to read the RIGHT finding for the RIGHT vendor. A
    // finding for a different entity must never leak onto this one.
    const v = build(obs(), [
      cookieFinding("Criteo", "uid"),
      vendorSignalFinding("Google", "vendor-read-gpc"),
    ]);
    expect(v.vendors[0]?.checkKey).not.toBe("vendorGpcRead");
  });

  it("falls back to 'not observable' when no engine finding exists for a listed vendor", () => {
    // A vendor can appear via the persistent tallies (or a cookie finding) with no
    // corresponding vendor-signal-check finding — e.g. its network entries were evicted
    // from the retained sample. This must not silently read as "did not check".
    const v = build(obs(), [cookieFinding("Meta", "_fbp")]);
    expect(v.vendors[0]?.checkKey).toBe("vendorGpcCheckUnavailable");
  });

  it("says 'not applicable' for a vendor whose script never executed", () => {
    const v = build(obs(), [
      cookieFinding("Meta", "_fbp"),
      vendorSignalFinding("Meta", "vendor-no-script-observed"),
    ]);
    expect(v.vendors[0]?.checkKey).toBe("vendorGpcNotApplicable");
  });

  it("labels a container no-read 'No read observed', with the container help", () => {
    // The view-model side of vendor-gpc-unread-via-container (the engine's own state has
    // its own unit tests). Both the checkKey mapping and the footer-note derivation (built
    // from this SAME finding, not a separate consentApiCalls scan) are exercised together.
    const v = build(
      obs({ gtm: { present: true, containerIds: ["GTM-X"], gtagIds: [], consentMode: null } }),
      [cookieFinding("Meta", "_fbp"), vendorSignalFinding("Meta", "vendor-gpc-unread-via-container")],
    );
    // One label with vendor-did-not-read-gpc; the help keeps the difference.
    expect(v.vendors[0]?.checkKey).toBe("vendorGpcNotRead");
    expect(v.vendors[0]?.checkHelp).toEqual({ key: "vendorGpcNotReadViaContainerHelp" });
  });

  it("labels a vendor 'Cannot determine (via tag manager)'", () => {
    // The note needs a read that came through the container; see the "Consent Mode note"
    // tests below for the page where none did.
    const v = build(
      obs({
        gtm: { present: true, containerIds: ["GTM-X"], gtagIds: [], consentMode: null },
        signal: { readAttribution: { sampled: 2, unattributed: 0, viaTagManager: 2 } } as never,
      }),
      [cookieFinding("Meta", "_fbp"), vendorSignalFinding("Meta", "vendor-gpc-check-unattributable")],
    );
    expect(v.vendors[0]?.checkKey).toBe("vendorGpcCheckUnattributable");
  });

  describe("loaded-by line", () => {
    const GTM = { manager: "gtm", id: "GTM-A" } as const;
    const withLoaders = (loadedVia: unknown, flag: "vendor-did-not-read-gpc" | "vendor-gpc-unread-via-container" = "vendor-did-not-read-gpc"): Finding => ({
      flag,
      rank: 40,
      entity: { name: "Meta", domains: [] },
      artifact:
        flag === "vendor-did-not-read-gpc"
          ? ({ kind: "network", observationId: "1", loadedVia } as never)
          : ({ kind: "vendor-check-container", containerCallCount: 0, consentModeActive: false, loadedVia } as never),
    });
    const line = (v: ReturnType<typeof build>) => v.vendors.find((r) => r.name === "Meta")?.loadedVia?.parts;

    it("names the container, its parent from the graph, and nothing when undetermined", () => {
      expect(line(build(obs(), [cookieFinding("Meta", "_fbp"), withLoaders([{ kind: "container", identity: GTM, ancestors: [], mixed: false }])]))).toEqual([
        { key: "vendorLoadedViaGtm", substitution: ["GTM-A"] },
      ]);
      expect(
        line(build(obs(), [cookieFinding("Meta", "_fbp"), withLoaders([{ kind: "container", identity: { manager: "gtm", id: "GTM-CHILD" }, ancestors: [GTM], mixed: false }])])),
      ).toEqual([
        { key: "vendorLoadedViaGtm", substitution: ["GTM-CHILD"] },
        { key: "vendorLoadedViaParent", substitution: ["GTM-A"] },
      ]);
      expect(line(build(obs(), [cookieFinding("Meta", "_fbp"), withLoaders(undefined)]))).toBeUndefined();
    });

    it("says the Google tag, another manager, or an unnamed tag manager", () => {
      expect(line(build(obs(), [cookieFinding("Meta", "_fbp"), withLoaders([{ kind: "container", identity: { manager: "gtag", id: "G-1" }, ancestors: [], mixed: false }])]))).toEqual([
        { key: "vendorLoadedViaGoogleTag", substitution: ["G-1"] },
      ]);
      expect(line(build(obs(), [cookieFinding("Meta", "_fbp"), withLoaders([{ kind: "container", identity: { manager: "tealium", id: "acme/main" }, ancestors: [], mixed: false }])]))).toEqual([
        { key: "vendorLoadedViaManager", substitution: ["Tealium", "acme/main"] },
      ]);
      expect(line(build(obs(), [cookieFinding("Meta", "_fbp"), withLoaders([{ kind: "container", identity: { manager: "google", id: null }, ancestors: [], mixed: false }])]))).toEqual([
        { key: "vendorLoadedViaTagManager" },
      ]);
    });

    it("names a vendor, a bare host, the site, and a site script that loads others", () => {
      expect(line(build(obs(), [cookieFinding("Meta", "_fbp"), withLoaders([{ kind: "entity", name: "Prebid" }])]))).toEqual([{ key: "vendorLoadedViaVendor", substitution: ["Prebid"] }]);
      expect(line(build(obs(), [cookieFinding("Meta", "_fbp"), withLoaders([{ kind: "host", domain: "cloudfront.net" }])]))).toEqual([{ key: "vendorLoadedViaHost", substitution: ["cloudfront.net"] }]);
      expect(line(build(obs(), [cookieFinding("Meta", "_fbp"), withLoaders([{ kind: "site", url: null }])]))).toEqual([{ key: "vendorLoadedBySite" }]);
      // The same first-party file loaded Criteo too: the one count these lines allow, with a
      // sentence of its own for 1.
      const loadedByApp = (name: string, id: string): Finding => ({ flag: "vendor-did-not-read-gpc", rank: 40, entity: { name, domains: [] }, artifact: { kind: "network", observationId: id, loadedVia: [{ kind: "site", url: "https://example.com/app.js" }] } });
      const criteo = loadedByApp("Criteo", "2");
      expect(line(build(obs(), [cookieFinding("Meta", "_fbp"), withLoaders([{ kind: "site", url: "https://example.com/app.js" }]), criteo]))).toEqual([
        { key: "vendorLoadedBySiteScriptOne" },
      ]);
      expect(line(build(obs(), [cookieFinding("Meta", "_fbp"), withLoaders([{ kind: "site", url: "https://example.com/app.js" }]), criteo, loadedByApp("Taboola", "3")]))).toEqual([
        { key: "vendorLoadedBySiteScript", substitution: ["2"] },
      ]);
    });

    it("collapses several loaders: the container leads, the rest are 'also by'", () => {
      const v = build(obs(), [cookieFinding("Meta", "_fbp"), withLoaders(
          [
            { kind: "site", url: null },
            { kind: "container", identity: GTM, ancestors: [], mixed: true },
            { kind: "entity", name: "Prebid" },
          ],
          "vendor-gpc-unread-via-container",
        ),
      ]);
      expect(line(v)).toEqual([
        { key: "vendorLoadedViaGtm", substitution: ["GTM-A"] },
        { key: "vendorLoadedAlsoBySite" },
        { key: "vendorLoadedAlsoByVendor", substitution: ["Prebid"] },
      ]);
      // The expanded panel keeps one line per loader.
      expect(v.vendors.find((r) => r.name === "Meta")?.detail.loadedVia).toHaveLength(3);
      // Two named containers: both ids on the line.
      expect(line(build(obs(), [cookieFinding("Meta", "_fbp"), withLoaders([
        { kind: "container", identity: GTM, ancestors: [], mixed: false },
        { kind: "container", identity: { manager: "gtm", id: "GTM-B" }, ancestors: [], mixed: false },
      ])]))).toEqual([{ key: "vendorLoadedViaContainers", substitution: ["GTM-A, GTM-B"] }]);
    });

    it("picks the help text by loader kind and route, with the ordering sentence when known", () => {
      const loaderFinding = (artifact: unknown, flag: "vendor-gpc-check-unattributable" | "vendor-gpc-unread-via-container" = "vendor-gpc-check-unattributable"): Finding =>
        ({ flag, rank: 40, entity: { name: "Meta", domains: [] }, artifact } as never);
      const help = (v: ReturnType<typeof build>) => v.vendors.find((r) => r.name === "Meta")?.checkHelp;
      const container = { kind: "container", identity: GTM, ancestors: [], mixed: false };
      const base = { kind: "vendor-check-loader", containerCallCount: 1, consentModeActive: false };

      expect(help(build(obs(), [cookieFinding("Meta", "_fbp"), loaderFinding({ ...base, loader: container, route: "loader", checkedBeforeLoad: true })]))).toEqual({
        key: "vendorGpcCheckUnattributableHelpContainer", substitution: ["GTM-A"], orderKey: "vendorGpcCheckOrderBefore",
      });
      // A parent that read is context on the scoped no-read state, never a state of its own.
      expect(help(build(obs(), [cookieFinding("Meta", "_fbp"), loaderFinding({ ...base, loader: container, route: "ancestor", checkedBeforeLoad: false, loadedVia: [{ kind: "container", identity: { manager: "gtm", id: "GTM-CHILD" }, ancestors: [GTM], mixed: false }] }, "vendor-gpc-unread-via-container")]))).toEqual({
        key: "vendorGpcNotReadViaContainerHelpParentRead", substitution: ["GTM-CHILD", "GTM-A"], orderKey: "vendorGpcCheckOrderParentAfter",
      });
      expect(help(build(obs(), [cookieFinding("Meta", "_fbp"), loaderFinding({ ...base, loader: { kind: "entity", name: "Prebid" }, route: "loader", checkedBeforeLoad: null })]))).toEqual({
        key: "vendorGpcCheckUnattributableHelpVendor", substitution: ["Prebid"],
      });
      // After a vendor loader the ordering sentence names the row ("this vendor"), not "this
      // tag", which is for what a container loaded.
      expect(help(build(obs(), [cookieFinding("Meta", "_fbp"), loaderFinding({ ...base, loader: { kind: "entity", name: "Prebid" }, route: "loader", checkedBeforeLoad: false })]))).toEqual({
        key: "vendorGpcCheckUnattributableHelpVendor", substitution: ["Prebid"], orderKey: "vendorGpcCheckOrderAfterVendor",
      });
      expect(help(build(obs(), [cookieFinding("Meta", "_fbp"), loaderFinding({ ...base, loader: { kind: "site", url: null }, route: "loader", checkedBeforeLoad: null })]))).toEqual({
        key: "vendorGpcCheckUnattributableHelpSite",
      });
      // Consent Mode names the tag's own container first, then the one that set it.
      expect(help(build(obs(), [cookieFinding("Meta", "_fbp"), loaderFinding({ ...base, loader: container, route: "consent-mode", checkedBeforeLoad: null, loadedVia: [{ kind: "container", identity: { manager: "gtm", id: "GTM-OWN" }, ancestors: [], mixed: false }] })]))).toEqual({
        key: "vendorGpcCheckUnattributableHelpConsentMode", substitution: ["GTM-OWN", "GTM-A"],
      });
      expect(help(build(obs(), [cookieFinding("Meta", "_fbp"), loaderFinding({ ...base, loader: container, route: "consent-mode", checkedBeforeLoad: null })]))).toEqual({
        key: "vendorGpcCheckUnattributableHelpConsentModeUnnamed", substitution: ["GTM-A"],
      });
      expect(help(build(obs(), [cookieFinding("Meta", "_fbp"), loaderFinding({ ...base, containerCallCount: 0, loader: container, route: "loader", checkedBeforeLoad: null }, "vendor-gpc-unread-via-container")]))).toEqual({
        key: "vendorGpcNotReadViaContainerHelpContainer", substitution: ["GTM-A"],
      });
      // The page-wide artifact keeps the page-wide help.
      expect(help(build(obs(), [cookieFinding("Meta", "_fbp"), loaderFinding({ kind: "vendor-check-container", containerCallCount: 1, consentModeActive: false })]))).toEqual({
        key: "vendorGpcCheckUnattributableHelp",
      });
    });

    it("past the read-trace cap, a no-read state's help says so", () => {
      const capped = obs({ signal: { readTracking: "active", readCount: 5000, readsByScript: {}, readAttribution: { sampled: 2100, unattributed: 30, viaTagManager: 0, traceCapReached: true } } as never });
      const v = build(capped, [cookieFinding("Meta", "_fbp"), withLoaders([{ kind: "entity", name: "Prebid" }])]);
      expect(v.vendors.find((r) => r.name === "Meta")?.checkHelp).toEqual({ key: "vendorGpcNotReadHelpCapped" });
      const under = obs({ signal: { readTracking: "active", readCount: 50, readsByScript: {}, readAttribution: { sampled: 50, unattributed: 0, viaTagManager: 0 } } as never });
      expect(build(under, [cookieFinding("Meta", "_fbp"), withLoaders([{ kind: "entity", name: "Prebid" }])]).vendors.find((r) => r.name === "Meta")?.checkHelp).toEqual({ key: "vendorGpcNotReadHelpLoaderUnchecked", substitution: ["Prebid"] });
    });

    it("with a property read that named no script, a no-read state's help says it may have been this vendor's", () => {
      const unnamed = obs({ signal: { readTracking: "active", readCount: 54, readsByScript: { "https://static.criteo.net/x.js": 21 }, readAttribution: { sampled: 54, unattributed: 33, viaTagManager: 0 } } as never });
      const v = build(unnamed, [cookieFinding("Meta", "_fbp"), withLoaders([{ kind: "entity", name: "Prebid" }])]);
      const meta = v.vendors.find((r) => r.name === "Meta");
      expect(meta?.checkHelp).toEqual({ key: "vendorGpcNotReadHelpUnidentified" });
      // The state itself does not move: who made the read is not known.
      expect(meta?.checkKey).toBe("vendorGpcNotRead");
      // The cap is the larger reason and keeps its own sentence.
      const capped = obs({ signal: { readTracking: "active", readCount: 5000, readsByScript: {}, readAttribution: { sampled: 2100, unattributed: 30, viaTagManager: 0, traceCapReached: true } } as never });
      expect(build(capped, [cookieFinding("Meta", "_fbp"), withLoaders([{ kind: "entity", name: "Prebid" }])]).vendors.find((r) => r.name === "Meta")?.checkHelp).toEqual({ key: "vendorGpcNotReadHelpCapped" });
    });

  });

  it("surfaces the resourceTypes seen for a vendor, so 'Not applicable' can be checked against them", () => {
    // Regression guard for the exact real-world question this state raises: a reader
    // seeing "Not applicable" needs to be able to check the premise (no script/xhr
    // observed) rather than take it on faith. merequartz.com (Admiral) on news-f.example
    // is a live case.
    const v = buildPopupView({
      observations: obs({
        network: [
          {
            id: "1",
            url: "https://merequartz.com/pixel.gif",
            method: "GET",
            resourceType: "image",
            initiator: null,
            secGpcPresent: true,
            requestHeaders: [],
            cookiesSent: [],
            statusCode: 200,
            responseHeaders: null,
            isRedirectHop: false,
            setCookies: [],
            captureMethod: "onHeadersReceived",
            timeMs: 0,
          },
        ],
        // The vendor row list is built from the tallies (complete) rather than from
        // findings, so a vendor that set no cookie still appears — matching real captures.
        tallies: {
          ...EMPTY_TALLIES,
          byEntity: {
            Admiral: {
              requests: 1,
              signedRequests: 1,
              cookieNames: [],
              cookiesReturned: [],
              hosts: ["merequartz.com"],
            },
          },
        },
      }),
      findings: [vendorSignalFinding("Admiral", "vendor-no-script-observed")],
      distinctCookies: 0,
      adTechRequests: 1,
      classify: classifyWith([["merequartz.com", "Admiral", "advertising"]]),
    });
    const admiral = v.vendors.find((x) => x.name === "Admiral");
    expect(admiral?.checkKey).toBe("vendorGpcNotApplicable");
    expect(admiral?.detail.resourceTypes).toEqual(["image"]);
  });

  it("orders alphabetically regardless of how much each vendor set", () => {
    const v = build(obs(), [
      cookieFinding("Zeta", "a"),
      cookieFinding("Alpha", "b"),
      cookieFinding("Alpha", "c"),
    ]);
    expect(v.vendors.map((x) => x.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("is case-insensitive, so casing does not scatter the list", () => {
    const v = build(obs(), [
      cookieFinding("zeta", "a"),
      cookieFinding("Alpha", "b"),
      cookieFinding("beta", "c"),
    ]);
    expect(v.vendors.map((x) => x.name)).toEqual(["Alpha", "beta", "zeta"]);
  });

  // No initial-in-a-square avatar (docs/DESIGN.md §9): it would hold the first letter of
  // the word beside it, cost 36px of a 420px panel on the row where the name and cookie
  // list already compete, and be the most Disconnect-like element in a UI that consumes
  // Disconnect's list and must not imply their endorsement. The rule of a neutral mark,
  // never a vendor logo (D15), is satisfied by there being no mark at all.
  it("carries no avatar field for the row to render", () => {
    const row = build(obs(), [cookieFinding("Google", "IDE")]).vendors[0];
    expect(row?.name).toBe("Google");
    expect(row).not.toHaveProperty("initial");
  });
});

describe("ad tech present with zero cookies (the apparel-c.example case)", () => {
  it("is 'observed' with a countable zero, not 'no-ad-tech'", () => {
    // apparel-c.example ran a full ad stack (18 scripts read the signal) but set no cookies via
    // response headers on that load. Derived from cookie findings, the state would show it
    // encyclopedia-a's message: a factual error, not a wording preference.
    const v = buildPopupView({
      observations: obs(),
      findings: [],
      distinctCookies: 0,
      adTechRequests: 23,
    });
    expect(v.state).toBe("observed");
    expect(v.cookieCount).toBe(0);
    expect(v.adTechRequests).toBe(23);
  });

  it("is 'no-ad-tech' only when nothing was observable at all", () => {
    const v = buildPopupView({
      observations: obs(),
      findings: [],
      distinctCookies: 0,
      adTechRequests: 0,
    });
    expect(v.state).toBe("no-ad-tech");
  });
});

describe("pending state (popup opened while the page is still loading)", () => {
  it("reports the signal as set before any observation exists", () => {
    // Whether we are SENDING is our own state, not something learned from the page. A
    // blank frame while a page loads tells the user nothing and looks broken.
    const v = buildPopupView({
      observations: null,
      findings: [],
      distinctCookies: 0,
      adTechRequests: 0,
      pending: true,
      sendingSignal: true,
    });
    expect(v.state).toBe("pending");
    expect(v.status.isSet).toBe(true);
    expect(v.status.sourceKey).toBe("sourceThisExtension");
  });

  it("reports the signal as not set when sending is off", () => {
    const v = buildPopupView({
      observations: null,
      findings: [],
      distinctCookies: 0,
      adTechRequests: 0,
      pending: true,
      sendingSignal: false,
    });
    expect(v.status.isSet).toBe(false);
    expect(v.status.sourceKey).toBe("sourceOffInSettings");
  });

  it("prefers pending over no-ad-tech, so a loading page never claims an absence", () => {
    // Observations exist but nothing has arrived yet. Calling that "no ad tech" asserts
    // something we have not established.
    const v = buildPopupView({
      observations: obs(),
      findings: [],
      distinctCookies: 0,
      adTechRequests: 0,
      pending: true,
      sendingSignal: true,
    });
    expect(v.state).toBe("pending");
  });

  it("resolves to a real state once pending clears", () => {
    const v = buildPopupView({
      observations: obs(),
      findings: [],
      distinctCookies: 0,
      adTechRequests: 0,
      pending: false,
      sendingSignal: true,
    });
    expect(v.state).toBe("no-ad-tech");
  });
});

describe("unknown signal state is not the same as sending-off", () => {
  it("says 'checking' when the worker could not be reached", () => {
    // A worker that does not respond (session storage exhausted, say) leaves the state
    // unknown. Collapsed into a boolean, it would have the popup report "sending off in
    // settings", a setting the user did not make, on a page where the header was in fact
    // being sent.
    const v = buildPopupView({
      observations: null,
      findings: [],
      distinctCookies: 0,
      adTechRequests: 0,
      pending: true,
      sendingSignal: false,
      signalKnown: false,
    });
    expect(v.status.sourceKey).toBe("sourceUnknown");
    expect(v.status.isSet).toBe(false);
  });

  it("says sending-off only when that is actually the setting", () => {
    const v = buildPopupView({
      observations: null,
      findings: [],
      distinctCookies: 0,
      adTechRequests: 0,
      pending: true,
      sendingSignal: false,
      signalKnown: true,
    });
    expect(v.status.sourceKey).toBe("sourceOffInSettings");
  });

  it("reports sending when the rule is installed and the setting is on", () => {
    const v = buildPopupView({
      observations: null,
      findings: [],
      distinctCookies: 0,
      adTechRequests: 0,
      pending: true,
      sendingSignal: true,
      signalKnown: true,
    });
    expect(v.status.isSet).toBe(true);
    expect(v.status.sourceKey).toBe("sourceThisExtension");
  });
});

describe("engine findings surfaced as notices", () => {
  const finding = (flag: string): Finding => ({
    flag: flag as Finding["flag"],
    rank: 20,
    entity: null,
    artifact: { kind: "none" },
  });

  it("does NOT pair the container's Consent Mode state with a cookie count as a finding", () => {
    // Consent Mode propagates a choice to Google's tags. It does not bind other vendors,
    // and every vendor receives Sec-GPC on its own requests regardless. Pairing "the
    // container said denied" with "a cookie was set" asserts a contradiction that has not
    // been established — retailer-m.example's cookies were largely non-Google, which Consent Mode
    // never governed.
    const v = buildPopupView({
      observations: obs({
        gtm: {
          present: true,
          containerIds: ["GTM-XRTM1000"],
          gtagIds: [],
          consentMode: {
            ad_user_data: "denied",
            ad_personalization: "denied",
            ad_storage: "denied",
            analytics_storage: "denied",
            functionality_storage: "unspecified",
            personalization_storage: "unspecified",
            security_storage: "unspecified",
          },
        },
      }),
      findings: [],
      distinctCookies: 28,
      adTechRequests: 40,
    });
    expect(v.notices.some((n) => n.kind === "finding")).toBe(false);
    // The state is still reported, as context, in Privacy strings (1.25.0).
    const gcm = v.privacyStrings.find((r) => r.id === "gcm");
    expect(gcm?.summary).toEqual([{ key: "valueConsentGranted", substitution: ["0"] }]);
    expect(gcm?.groups?.[0]?.fields.find((f) => f.label === "ad_user_data")?.valueKey).toBe("valueDenied");
  });

  it("surfaces the GPP conflict", () => {
    const v = buildPopupView({
      observations: obs(),
      findings: [finding("gpp-conflict")],
      distinctCookies: 0,
      adTechRequests: 3,
    });
    expect(v.notices.some((n) => n.textKey === "findingGppConflict")).toBe(true);
  });

  /**
   * The color rule, as a test rather than a comment.
   *
   * Amber ("unavailable") means exactly one thing: we could not look. On a finding it
   * would make one tone say "we could not look" and "look at this" simultaneously, the two
   * most nearly opposite things this interface has to say. On an ad-dense page three amber
   * finding banners would stack above the fold and read as three warnings: the verdict
   * layer D4 rules out, arriving back through color.
   *
   * Asserted across every surfaced finding rather than one, because the regression is
   * per-call-site: the tone is set at three separate `out.push` sites in findingNotices,
   * and two of them are special-cased branches that a change to the third would miss.
   */
  it("never gives a finding the tone that means 'we could not look'", () => {
    const v = buildPopupView({
      observations: obs(),
      findings: [
        finding("gpp-conflict"),
        finding("signal-not-read"),
        {
          flag: "usp-surfaces-disagree",
          rank: 20,
          artifact: { kind: "usp", fromApi: "1YNN", fromCookie: null, fromWire: "1YNY" },
        } as Finding,
      ],
      distinctCookies: 1,
      adTechRequests: 3,
    });

    const findings = v.notices.filter((n) => n.kind === "finding");
    expect(findings.length).toBeGreaterThan(1);
    for (const n of findings) expect(n.tone).toBe("finding");
  });

  it("picks the Overview notice by what the capture lost (1.22.0)", () => {
    const notice = (reasons: string[] | undefined) =>
      build(obs({ context: { incomplete: true, ...(reasons ? { incompleteReasons: reasons } : {}) } as never }))
        .notices.filter((n) => n.kind === "incomplete").map((n) => n.textKey);
    // A reclaim loses only the request list, which the Overview is not built from.
    expect(notice(["worker-restarted"])).toEqual([]);
    expect(notice(["write-failed"])).toEqual(["stateSaveFailed"]);
    expect(notice(["read-failed", "worker-restarted"])).toEqual(["stateSaveFailed"]);
    expect(notice(["delivery-gap"])).toEqual(["stateDeliveryGap"]);
    expect(notice(["consent-calls-capped", "delivery-gap"])).toEqual(["stateDeliveryGap"]);
    expect(notice(["consent-calls-capped"])).toEqual(["stateConsentCallsCapped"]);
    // A prerendered page whose load was not all kept: the counts may be short (1.38.0).
    expect(notice(["prerender-lost"])).toEqual(["stateSaveFailed"]);
    // A bundle from before the reasons were recorded.
    expect(notice(undefined)).toEqual(["stateIncomplete"]);
  });

  it("treats an incomplete capture as unavailability, like a failed interceptor", () => {
    // Both say part of this page was not observed. Rendering one amber and the other plain
    // would give a single meaning two treatments on the same surface.
    const v = build(obs({ context: { incomplete: true } as never }));
    expect(v.notices.find((n) => n.textKey === "stateIncomplete")?.tone).toBe("unavailable");
  });

  it("does not repeat a flag that fired several times", () => {
    const v = buildPopupView({
      observations: obs(),
      findings: [finding("gpp-conflict"), finding("gpp-conflict"), finding("gpp-conflict")],
      distinctCookies: 0,
      adTechRequests: 3,
    });
    expect(v.notices.filter((n) => n.textKey === "findingGppConflict")).toHaveLength(1);
  });

  it("substitutes the actual page and wire values into the USP disagreement notice", () => {
    // A bare "these disagree" is not actionable: the reader would have to find the values
    // themselves in the Requests tab. The finding's own artifact already has them.
    const v = buildPopupView({
      observations: obs(),
      findings: [
        {
          flag: "usp-surfaces-disagree",
          rank: 20,
          entity: null,
          artifact: { kind: "usp", fromApi: "1YYN", fromCookie: null, fromWire: "MSPS" },
        },
      ],
      distinctCookies: 0,
      adTechRequests: 3,
    });
    const n = v.notices.find((x) => x.textKey === "findingUspDisagree");
    expect(n?.substitution).toEqual(["1YYN", "MSPS"]);
  });

  it("falls back to the cookie surface for the USP disagreement notice when the API is absent", () => {
    const v = buildPopupView({
      observations: obs(),
      findings: [
        {
          flag: "usp-surfaces-disagree",
          rank: 20,
          entity: null,
          artifact: { kind: "usp", fromApi: null, fromCookie: "1NNN", fromWire: "1YNN" },
        },
      ],
      distinctCookies: 0,
      adTechRequests: 3,
    });
    const n = v.notices.find((x) => x.textKey === "findingUspDisagree");
    expect(n?.substitution).toEqual(["1NNN", "1YNN"]);
  });

  it("substitutes the actual page and wire values into the GPP disagreement notice", () => {
    const v = buildPopupView({
      observations: obs(),
      findings: [
        {
          flag: "gpp-surfaces-disagree",
          rank: 21,
          entity: null,
          artifact: { kind: "gpp-wire", fromApi: "DBABBg~x", fromWire: "DBABBg~different" },
        },
      ],
      distinctCookies: 0,
      adTechRequests: 3,
    });
    const n = v.notices.find((x) => x.textKey === "findingGppDisagree");
    expect(n?.substitution).toEqual(["DBABBg~x", "DBABBg~different"]);
  });

  it("does not surface per-vendor findings, which have their own rows", () => {
    const v = buildPopupView({
      observations: obs(),
      findings: [finding("cookie-set-with-signal"), finding("signal-sent")],
      distinctCookies: 1,
      adTechRequests: 3,
    });
    expect(v.notices.some((n) => n.kind === "finding")).toBe(false);
  });
});


describe("notice placement", () => {
  it("keeps site behavior out of the notice strip entirely", () => {
    // Notices are for things the reader needs BEFORE the numbers mean anything: a
    // truncated capture, a blocked check. What the site did is not that.
    const v = build(obs({ confirmationNotice: "detected" }));
    expect(v.notices.every((n) => n.kind !== "confirmed")).toBe(true);
  });

  it("puts a truncated capture above the numbers", () => {
    const v = build(obs({ context: { incomplete: true } as never }));
    expect(v.notices.find((n) => n.kind === "incomplete")?.placement).toBe("top");
  });

});


describe("absence vs unavailability (the silent-failure class)", () => {
  it("says 'not present' for GPP when we looked and found nothing", () => {
    const v = build(obs());
    expect(v.privacyStrings.find((r) => r.id === "gpp")?.summary[0]?.key).toBe(
      "valueNotPresent",
    );
  });

  it("says 'not observable' for GPP when the interceptor failed to install", () => {
    // Another extension owning __gpp, or a non-configurable property, means we observed
    // nothing through it. Reporting that silence as "not present" states a fact about the
    // SITE that we did not establish.
    const v = build(obs({ capabilities: { gpp: false } as never }));
    expect(v.privacyStrings.find((r) => r.id === "gpp")?.summary[0]?.key).toBe(
      "valueNotObservable",
    );
  });

  it("says 'not observable' for US Privacy when __uspapi could not be wrapped", () => {
    const v = build(obs({ capabilities: { uspapi: false } as never }));
    expect(v.privacyStrings.find((r) => r.id === "usp")?.summary[0]?.key).toBe(
      "valueNotObservable",
    );
  });

  it("gives an unopenable row nothing to open", () => {
    // A row whose value is an absence has no interior. Rendering it as expandable would
    // teach the reader that the caret means nothing — the same erosion that makes an
    // affordance stop being one.
    const v = build(obs({ capabilities: { gpp: false } as never }));
    const row = v.privacyStrings.find((r) => r.id === "gpp");
    expect(row?.groups).toBeUndefined();
    expect(row?.raw).toBeUndefined();
  });

  it("names what could not be observed in the reader's terms, not the API's", () => {
    // The plain phrase LEADS and the identifier is absent. "documentCookie (cookies set by
    // JavaScript) or gpp (the privacy string)" would put camelCase internals in a consumer
    // sentence, each with its meaning in parentheses behind it, the unusable half first.
    // Anyone debugging their own site gets the raw capability keys in the record a finding
    // report carries (`capabilities`), which is where they belong.
    const v = build(obs({ capabilities: { documentCookie: false, gpp: false } as never }));
    const n = v.notices.find((x) => x.textKey === "stateCaptureUnavailable");
    expect(n?.placement).toBe("top");
    expect(n?.substitution).toBe("cookies set by JavaScript or the GPP privacy string");
    expect(n?.substitution).not.toContain("documentCookie");
  });

  it("stays silent when every interceptor installed", () => {
    const v = build(obs());
    expect(v.notices.some((x) => x.textKey === "stateCaptureUnavailable")).toBe(false);
  });

  describe("cookieStore on an http:// page", () => {
    // cookieStore exists only in secure contexts. Capture reads an absent store as true since
    // 1.35.0; a bundle from before says false for every http:// page, which must not make
    // the popup say "We could not observe cookies set by JavaScript" with document.cookie
    // wrapped.
    const said = (o: ObservationSet) => build(o).notices.some((x) => x.textKey === "stateCaptureUnavailable");
    const at = (finalUrl: string, cookieStore: boolean, documentCookie = true) =>
      obs({
        context: { finalUrl, topSite: "example.com" } as never,
        capabilities: { documentCookie, cookieStore } as never,
      });

    it("is not a failure in an older bundle of an http:// page", () => {
      expect(said(at("http://example.com/", false))).toBe(false);
    });

    it("is still a failure on an https:// page, where the store exists and was not wrapped", () => {
      expect(said(at("https://example.com/", false))).toBe(true);
    });

    it("is still a failure on http://localhost, which is a secure context", () => {
      expect(said(at("http://localhost:8080/", false))).toBe(true);
      expect(said(at("http://127.0.0.1/", false))).toBe(true);
    });

    it("leaves a failed document.cookie on an http:// page standing", () => {
      expect(said(at("http://example.com/", false, false))).toBe(true);
    });
  });
});

describe("describeFailedCapabilities", () => {
  const ok = {
    documentCookie: true,
    cookieStore: true,
    gpp: true,
    uspapi: true,
    tcfapi: true,
    dataLayer: true,
  };

  it("returns null when nothing failed", () => {
    expect(describeFailedCapabilities(ok)).toBeNull();
  });

  it("names a single failure without a conjunction", () => {
    expect(describeFailedCapabilities({ ...ok, gpp: false })).toBe("the GPP privacy string");
  });

  it("collapses documentCookie and cookieStore into one phrase", () => {
    // Two routes to the same thing — a cookie written by page script. Listing both would
    // read as two separate failures.
    expect(describeFailedCapabilities({ ...ok, documentCookie: false, cookieStore: false })).toBe(
      "cookies set by JavaScript",
    );
  });

  it("joins three or more with commas and a final 'or'", () => {
    expect(
      describeFailedCapabilities({ ...ok, gpp: false, uspapi: false, dataLayer: false }),
    ).toBe("the GPP privacy string, the US Privacy string or Consent Mode");
  });
});

describe("published GPC file row", () => {
  const declares = (over: Record<string, unknown> = {}) => ({
    url: "https://www.news-g.example/.well-known/gpc.json",
    present: true,
    gpc: true,
    lastUpdate: null,
    observedAtMs: 1787427803647,
    fresh: true,
    reason: null,
    ...over,
  });

  it("shows the row for a site that declares support", () => {
    // Exact shape captured from www.news-g.example.
    const v = build(obs({ wellKnown: declares() }));
    const row = v.siteDid.find((r) => r.labelKey === "labelWellKnown");
    expect(row?.valueKey).toBe("valueYes");
    // The path travels as a monospace hint, so the label can say what the file means.
    expect(row?.hintParts).toEqual([{ text: "www.news-g.example/.well-known/gpc.json" }]);
    expect(row?.hintMono).toBe(true);
  });

  it("shows a distinct value for an explicit declaration of NON-support", () => {
    const v = build(obs({ wellKnown: declares({ gpc: false }) }));
    expect(v.siteDid.find((r) => r.labelKey === "labelWellKnown")?.valueKey).toBe("valueNo");
  });

  it("does not print a staleness footnote on a cached reading", () => {
    // The caching policy is stated once in Settings, beside the control that governs it,
    // rather than as a permanent two-line footnote under a row that usually says "not
    // found": the reader cannot act on it and it costs real space in a 420px panel.
    //
    // Where staleness has teeth it holds: `declared-honor-cookie-set` requires a FRESH read
    // (engine), because resting an accusation on a declaration that may have been withdrawn
    // is the claim this product must not make. Reporting may be stale; accusing may not.
    const v = build(obs({ wellKnown: declares({ fresh: false }) }));
    const row = v.siteDid.find((r) => r.labelKey === "labelWellKnown");
    expect(row?.valueKey).toBe("valueYes");
    expect(row?.hintParts).toEqual([{ text: "www.news-g.example/.well-known/gpc.json" }]);
  });

  it("shows a NOT-FOUND row when the site publishes nothing, rather than hiding it", () => {
    // Shown although most sites lack the file. With a row that sometimes exists, the reader
    // can't tell "checked, nothing there" from "never checked" from "off in settings" if all
    // three render as no row at all. Always showing the row makes the check itself visible.
    const v = build(obs({ wellKnown: declares({ present: false, gpc: null }) }));
    expect(v.siteDid.find((r) => r.labelKey === "labelWellKnown")?.valueKey).toBe(
      "valueWellKnownNotPresent",
    );
  });

  it("shows a CHECKING row (not a disabled or not-found row) while the check has not resolved", () => {
    // wellKnown is null both while the check is still resolving and when it's off in
    // settings — the row has to consult the setting separately to tell them apart. And
    // "still resolving" is not "not found": rendering it that way would state an absence we
    // have not yet looked for, on every fresh load.
    const v = build(obs({ wellKnown: null }));
    const row = v.siteDid.find((r) => r.labelKey === "labelWellKnown");
    expect(row?.valueKey).toBe("valueChecking");
    expect(row?.hintParts).toBeUndefined();
  });

  it("shows a DISABLED row when the setting is off, even if a stale result exists", () => {
    // The setting, not the presence of cached data, decides this state — otherwise turning
    // the check off wouldn't visibly do anything until the cache expired.
    const view = buildPopupView({
      observations: obs({ wellKnown: declares() }),
      findings: [],
      distinctCookies: 0,
      adTechRequests: 5,
      checkWellKnownEnabled: false,
    });
    expect(view.siteDid.find((r) => r.labelKey === "labelWellKnown")?.valueKey).toBe(
      "valueWellKnownDisabled",
    );
  });

  it("prefers the disabled state over not-present when both would otherwise apply", () => {
    const view = buildPopupView({
      observations: obs({ wellKnown: null }),
      findings: [],
      distinctCookies: 0,
      adTechRequests: 5,
      checkWellKnownEnabled: false,
    });
    expect(view.siteDid.find((r) => r.labelKey === "labelWellKnown")?.valueKey).toBe(
      "valueWellKnownDisabled",
    );
  });
});

describe("vendors present but setting nothing", () => {
  const adRequest = (url: string) => ({
    id: url, url, method: "GET", resourceType: "script", initiator: null,
    secGpcPresent: true,
    cookiesSent: [], requestHeaders: [], statusCode: 200, responseHeaders: null,
    isRedirectHop: false, setCookies: [], captureMethod: "onHeadersReceived" as const,
    timeMs: 0,
  });

  const talliesWith = (byEntity: Record<string, EntityTally>) => ({
    totalRequests: 1,
    signedRequests: 1,
    adVendorRequests: 1,
    adCookieEvents: 0,
    adCookieKeys: [],
    firstPartyVendorCookieKeys: [],
    byEntity,
  });

  it("lists a vendor that was contacted but set no cookie", () => {
    // Derived from cookie findings rather than from presence, the list would show "No ad or
    // analytics vendors seen" directly above "87 requests to advertising domains" on
    // news-g.example: two statements contradicting each other on one screen.
    //
    // Sourced from the TALLIES, a vendor whose requests were all evicted still appears in a
    // list whose job is to say who was on the page.
    const v = buildPopupView({
      observations: obs({
        network: [adRequest("https://ads.doubleclick.net/x")],
        tallies: talliesWith({
          Google: { requests: 1, signedRequests: 1, cookieNames: [], cookiesReturned: [], hosts: ["ads.doubleclick.net"] },
        }),
      }),
      findings: [],
      distinctCookies: 0,
      adTechRequests: 1,
      classify: classifyWith([["doubleclick", "Google", "advertising"]]),
    });
    expect(v.vendors.map((x) => x.name)).toEqual(["Google"]);
    expect(v.vendors[0]?.cookies).toEqual([]);
  });

  it("lists a vendor whose requests were ALL evicted", () => {
    // The point of tallies: the retained sample is empty, and the vendor still appears
    // because the count of what happened is not the same thing as the list of what was
    // kept.
    const v = buildPopupView({
      observations: obs({
        network: [],
        tallies: talliesWith({
          Criteo: { requests: 14, signedRequests: 14, cookieNames: ["uid"], cookiesReturned: [], hosts: ["criteo.com"] },
        }),
      }),
      findings: [],
      distinctCookies: 1,
      adTechRequests: 14,
      classify: classifyWith([]),
    });
    expect(v.vendors.map((x) => x.name)).toEqual(["Criteo"]);
    expect(v.vendors[0]?.cookies).toEqual(["uid"]);
  });

  it("lists vendors that set a cookie first, then the rest, alphabetical inside each group", () => {
    const v = buildPopupView({
      observations: obs({
        network: [adRequest("https://a.example/x"), adRequest("https://b.example/y")],
        tallies: talliesWith({
          Alpha: { requests: 1, signedRequests: 1, cookieNames: [], cookiesReturned: [], hosts: [] },
          Beta: { requests: 1, signedRequests: 1, cookieNames: [], cookiesReturned: [], hosts: [] },
          Yankee: { requests: 1, signedRequests: 1, cookieNames: ["a", "b", "c"], cookiesReturned: [], hosts: [] },
          Zeta: { requests: 1, signedRequests: 1, cookieNames: ["IDE"], cookiesReturned: [], hosts: [] },
        }),
      }),
      findings: [],
      distinctCookies: 4,
      adTechRequests: 2,
      classify: classifyWith([["a.example", "Alpha", "advertising"], ["b.example", "Beta", "advertising"]]),
    });
    // The groups follow the headline's question (which vendors set these cookies). Inside a
    // group the order is the name, never how many each set: Yankee's three cookies do not
    // put it after Zeta's one, or before anything for any reason but its name.
    expect(v.vendors.map((x) => x.name)).toEqual(["Yankee", "Zeta", "Alpha", "Beta"]);
  });

  it("still shows nothing when no vendor was contacted at all", () => {
    const v = buildPopupView({
      observations: obs({ network: [] }),
      findings: [],
      distinctCookies: 0,
      adTechRequests: 0,
      classify: classifyWith([]),
    });
    expect(v.vendors).toEqual([]);
  });
});

describe("stale page versus a setting", () => {
  it("says the page needs reloading, not that sending is off", () => {
    // The page loaded before sending was turned on, so its property was never set. Calling
    // that "sending off in settings" states a setting value that is the opposite of the
    // truth — the observation is stale; the setting is not.
    const v = buildPopupView({
      observations: obs({ signal: { source: "none" } as never }),
      findings: [],
      distinctCookies: 0,
      adTechRequests: 0,
      sendingSignal: true,
      signalKnown: true,
    });
    expect(v.status.sourceKey).toBe("sourceNeedsReload");
  });

  it("says sending is off when it actually is", () => {
    const v = buildPopupView({
      observations: obs({ signal: { source: "none" } as never }),
      findings: [],
      distinctCookies: 0,
      adTechRequests: 0,
      sendingSignal: false,
      signalKnown: true,
    });
    expect(v.status.sourceKey).toBe("sourceOffInSettings");
  });
});

describe("the confirmation notice lives in the section, not above it", () => {
  it("reports a found confirmation as a row", () => {
    const v = build(obs({ confirmationNotice: "detected" }));
    expect(v.siteDid.find((r) => r.labelKey === "labelConfirmation")?.valueKey).toBe(
      "valueYes",
    );
  });

  it("does not also raise it as a banner", () => {
    // A banner would duplicate the row, and with sending off it would claim the site had
    // processed a signal we were not sending.
    const v = build(obs({ confirmationNotice: "detected" }));
    expect(v.notices.some((n) => n.kind === "confirmed")).toBe(false);
  });
});

describe("an unanswered status query is not a setting", () => {
  it("says 'checking' rather than 'sending off' when the worker did not answer", () => {
    // A get-signal-status the worker drops (a guard that requires sender.tab, which a popup
    // message does not have) leaves the popup with undefined. Rendered as "sending off in
    // settings", it would contradict a setting that is on and a DNR rule that is installed.
    const v = buildPopupView({
      observations: obs({ signal: { source: "none" } as never }),
      findings: [],
      distinctCookies: 0,
      adTechRequests: 0,
      sendingSignal: false,
      signalKnown: false,
    });
    expect(v.status.sourceKey).toBe("sourceUnknown");
  });

  it("still says sending-off when that is a known fact", () => {
    const v = buildPopupView({
      observations: obs({ signal: { source: "none" } as never }),
      findings: [],
      distinctCookies: 0,
      adTechRequests: 0,
      sendingSignal: false,
      signalKnown: true,
    });
    expect(v.status.sourceKey).toBe("sourceOffInSettings");
  });
});

describe("Read GPC names each vendor once", () => {
  // A vendor can have a row whose rule says No and a script that pinged __gpp: Criteo on
  // news-n.example (2026-09-22), JWP Connatix on news-m.example and AlibabaGroup on
  // marketplace-c.example. Counting the ping as a Yes would put it under both.
  const classify = classifyWith([
    ["criteo", "Criteo", "advertising"],
    ["doubleclick", "Google", "advertising"],
    ["bat.bing.com", "Microsoft", "advertising"],
    ["clarity.ms", "Microsoft", "analytics"],
    ["cookielaw", "OneTrust", "consent-managers"],
  ]);
  const call = (callerScriptUrl: string, command: string) => ({
    api: "__gpp" as const, command, callerScriptUrl, viaTagManager: false, timeMs: 0,
  });
  const readLines = (o: ObservationSet, findings: Finding[]) =>
    readRows(buildPopupView({ observations: o, findings, distinctCookies: 0, adTechRequests: 5, classify }));
  const everyName = (r: ReturnType<typeof readRows>) => [...r.yes, ...r.no, ...r.unsure];

  it("places a vendor with a row by its row, not by a ping", () => {
    const lines = readLines(
      obs({
        signal: { readTracking: "active", readCount: 0, readsByScript: {} } as never,
        consentApiCalls: [call("https://static.criteo.net/js/ld/publishertag.js", "ping")],
      }),
      [cookieFinding("Criteo", "uid"), vendorSignalFinding("Criteo", "vendor-did-not-read-gpc")],
    );
    expect(lines.yes).toEqual([]);
    expect(lines.no).toEqual(["Criteo"]);
  });

  it("places a vendor with a row by its row even when its script read the property", () => {
    // The row's rule already weighs that read; a second verdict here would make the two
    // lists disagree.
    const lines = readLines(
      obs({
        signal: {
          readTracking: "active", readCount: 3,
          readsByScript: { "https://static.criteo.net/js/ld/publishertag.js": 3 },
          readAttribution: { sampled: 3, unattributed: 0, viaTagManager: 0 },
        } as never,
      }),
      [cookieFinding("Criteo", "uid"), vendorSignalFinding("Criteo", "vendor-gpc-check-unattributable")],
    );
    expect(lines.yes).toEqual([]);
    expect(everyName(lines)).toEqual(["Criteo"]);
  });

  it("still names a vendor with no row whose script read GPC", () => {
    const lines = readLines(
      obs({
        signal: { readTracking: "active", readCount: 0, readsByScript: {} } as never,
        consentApiCalls: [call("https://securepubads.g.doubleclick.net/y.js", "getGPPData")],
        gpp: gppWith({ Gpc: 1 }),
      }),
      [cookieFinding("Criteo", "uid"), vendorSignalFinding("Criteo", "vendor-did-not-read-gpc")],
    );
    expect(lines.yes).toEqual(["Google [advertising]"]);
    expect(lines.no).toEqual(["Criteo"]);
  });

  it("names a vendor with no row whose script only pinged, where the consent tool answers GPP 1.1", () => {
    // health-c.example, 2026-09-30: the 1.1 ping answer carried the usnat string and Gpc. Under 1.0
    // it carries no string and is no read, as in the rule.
    const pinged = (gppVersion: string) =>
      readLines(
        obs({
          signal: { readTracking: "active", readCount: 0, readsByScript: {} } as never,
          consentApiCalls: [call("https://securepubads.g.doubleclick.net/y.js", "ping")],
          gpp: { ...gppWith({ Gpc: 1 }), gppVersion },
        }),
        [cookieFinding("Criteo", "uid"), vendorSignalFinding("Criteo", "vendor-did-not-read-gpc")],
      );
    expect(pinged("1.1").yes).toEqual(["Google [advertising]"]);
    expect(everyName(pinged("1.0"))).not.toContain("Google [advertising]");
  });

  describe("a vendor is a company in one category", () => {
    const page = (findings: Finding[], reads: Record<string, number> = {}) =>
      readLines(
        obs({
          signal: { readTracking: "active", readCount: 9, readsByScript: reads, readAttribution: { sampled: 9, unattributed: 0, viaTagManager: 0 } } as never,
          tallies: {
            ...EMPTY_TALLIES,
            totalRequests: 30,
            byEntityCategory: summaries(
              summary("Microsoft", "advertising", { hosts: ["bat.bing.com"] }),
              summary("Microsoft", "analytics", { hosts: ["www.clarity.ms"] }),
              summary("OneTrust", "consent-managers", { hosts: ["cdn.cookielaw.org"] }),
              summary("Criteo", "advertising", { hosts: ["static.criteo.net"] }),
            ),
          },
        }),
        findings,
      );

    it("names a company in two rows when its categories are in two states", () => {
      // Its analytics script read the property. Its advertising script ran and did not.
      const lines = page([
        pairFinding("Microsoft", "advertising", "vendor-did-not-read-gpc"),
        pairFinding("Microsoft", "analytics", "vendor-read-gpc", { kind: "signal-read", readCount: 3 }),
        pairFinding("OneTrust", "consent-managers", "vendor-read-gpc", { kind: "signal-read", readCount: 1 }),
        pairFinding("Criteo", "advertising", "vendor-no-script-observed"),
      ]);
      expect(lines.yes).toEqual(["Microsoft [analytics]", "OneTrust [consentmanagers]"]);
      expect(lines.no).toEqual(["Microsoft [advertising]"]);
      // A vendor that ran no script is in no row.
      expect(everyName(lines)).not.toContain("Criteo [advertising]");
    });

    it("orders one company's categories as the list does", () => {
      const lines = page([
        pairFinding("Microsoft", "analytics", "vendor-did-not-read-gpc"),
        pairFinding("Microsoft", "advertising", "vendor-did-not-read-gpc"),
        pairFinding("Criteo", "advertising", "vendor-did-not-read-gpc"),
      ]);
      expect(lines.no).toEqual(["Criteo [advertising]", "Microsoft [advertising]", "Microsoft [analytics]"]);
    });

    it("never names a company and category in two rows", () => {
      // Its row says No, and its script is in the reads: the row decides, once.
      const lines = page(
        [pairFinding("Microsoft", "advertising", "vendor-did-not-read-gpc"), pairFinding("Microsoft", "analytics", "vendor-gpc-check-unattributable")],
        { "https://bat.bing.com/bat.js": 2, "https://www.clarity.ms/tag/x": 1 },
      );
      const all = everyName(lines);
      expect(all).toEqual(["Microsoft [advertising]", "Microsoft [analytics]"]);
      expect(new Set(all).size).toBe(all.length);
      expect(lines.yes).toEqual([]);
    });

    it("gives every row of a company the one state a bundle from before the categories has", () => {
      const lines = page([vendorSignalFinding("Microsoft", "vendor-did-not-read-gpc")]);
      expect(lines.no).toEqual(["Microsoft [advertising]", "Microsoft [analytics]"]);
    });
  });
});

describe("privacy strings carried by requests", () => {
  const gppBase = { rawString: "", applicableSections: [], gppVersion: null, sections: {}, unparseable: false, fromWire: null };

  it("shows an unfilled [GPP] as what it is, with the host, and not as a string", () => {
    // news-b.example, 2026-09-22: cookie-sync URLs carried gpp=[GPP].
    const row = strRow(
      build(obs({ gpp: { ...gppBase, invalidWire: [{ value: "[GPP]", hosts: ["s.seedtag.com", "ssp.disqus.com"], placeholder: true }] } })),
      "gpp",
    );
    expect(row?.summary[0]?.key).toBe("valueNotPresent");
    expect(row?.wireLines).toEqual([
      { key: "lineGppWirePlaceholder", substitution: ["s.seedtag.com"], value: "[GPP]", title: "[GPP]\ns.seedtag.com\nssp.disqus.com" },
    ]);
  });

  it("keeps the page's decoded string and adds the invalid value beneath it", () => {
    const row = strRow(
      build(obs({ gpp: { ...gppWith({ Gpc: 1, SaleOptOut: 1 }), invalidWire: [{ value: "DBAB%%%", hosts: ["x.example"], placeholder: false }] } })),
      "gpp",
    );
    expect(row?.summary[0]?.key).not.toBe("valueNotPresent");
    expect(row?.wireLines?.[0]?.key).toBe("lineGppWireInvalid");
  });

  it("says whose a US Privacy string is when only a request carried it", () => {
    const row = strRow(
      build(obs({ usPrivacy: { fromApi: null, fromCookie: null, fromWire: "1NNN", fromWireHost: "sync.1rx.io" } })),
      "usp",
    );
    expect(row?.summary[0]?.key).toBe("valueUspWireOnly");
    expect(row?.wireLines?.[0]).toEqual({ key: "lineUspWireOnly", substitution: ["sync.1rx.io"] });
    expect(row?.groups).toBeDefined();
  });

  it("says a GPP string was only seen on a request when the page reported none", () => {
    const row = strRow(build(obs({ gpp: { ...gppBase, fromWire: "DBABz~a", wireValues: [{ value: "DBABz~a", hosts: ["ads.example"] }] } })), "gpp");
    expect(row?.summary).toEqual([{ key: "valueGppWireOnly" }]);
    expect(row?.wireLines?.map((l) => l.key)).toEqual(["lineGppWireCarried"]);
  });

  it("keeps 'not observable' for a __gpp wrapper that could not install, whatever requests carried", () => {
    const o = obs({ gpp: { ...gppBase, fromWire: "DBABz~a", wireValues: [{ value: "DBABz~a", hosts: ["ads.example"] }] } });
    const row = strRow(build({ ...o, capabilities: { ...o.capabilities, gpp: false } }), "gpp");
    expect(row?.summary).toEqual([{ key: "valueNotObservable" }]);
  });

  it("says __uspapi could not be watched when only a request carried the US Privacy string", () => {
    const o = obs({ usPrivacy: { fromApi: null, fromCookie: null, fromWire: "1NNN", fromWireHost: "sync.1rx.io" } });
    const row = strRow(build({ ...o, capabilities: { ...o.capabilities, uspapi: false } }), "usp");
    expect(row?.summary[0]?.key).toBe("valueUspWireOnly");
    expect(row?.wireLines?.[0]).toEqual({ key: "lineUspWireOnlyUnwatched", substitution: ["sync.1rx.io"] });
  });

  it("names the host in a disagreement when capture recorded it", () => {
    const v = build(
      obs({ gpp: { ...gppWith({ Gpc: 1 }), rawString: "DBABBg~BUUAAAGA.YA", fromWire: "DBABBg~BUUAAACA.YA", fromWireHost: "trc.taboola.com" } }),
      [
        {
          flag: "gpp-surfaces-disagree",
          rank: 30,
          entity: null,
          artifact: { kind: "gpp-wire", fromApi: "DBABBg~BUUAAAGA.YA", fromWire: "DBABBg~BUUAAACA.YA", fromWireHost: "trc.taboola.com" },
        },
      ],
    );
    const n = v.notices.find((x) => x.textKey === "findingGppDisagreeHost");
    expect(n?.substitution).toEqual(["DBABBg~BUUAAAGA.YA", "trc.taboola.com", "DBABBg~BUUAAACA.YA"]);
  });

  // news-h.example, 2026-09-30: the most recent request was Google's, carrying the page's own
  // 1YYN, while the value shown was Rubicon's 1---. Taken from the observation, the host
  // would have the notice say Google carried Rubicon's string.
  const newsH = {
    fromApi: "1YYN",
    fromCookie: null,
    fromWire: "1YYN",
    fromWireHost: "securepubads.g.doubleclick.net",
    wireValues: [
      { value: "1---", hosts: ["pixel.rubiconproject.com", "gum.criteo.com"] },
      { value: "1YYN", hosts: ["securepubads.g.doubleclick.net"] },
      { value: "1YNN", hosts: ["ads.pubmatic.com"] },
    ],
  };

  it("names the host that carried the value shown, from the finding", () => {
    const v = build(obs({ usPrivacy: newsH }), [
      {
        flag: "usp-surfaces-disagree",
        rank: 20,
        entity: null,
        artifact: { kind: "usp", fromApi: "1YYN", fromCookie: null, fromWire: "1---", fromWireHost: "pixel.rubiconproject.com" },
      },
    ]);
    const n = v.notices.find((x) => x.textKey === "findingUspDisagreeHost");
    expect(n?.substitution).toEqual(["1YYN", "pixel.rubiconproject.com", "1---"]);
  });

  it("lists each string requests carried that differs from the page's, under the row", () => {
    const row = strRow(build(obs({ usPrivacy: newsH })), "usp");
    expect(row?.summary[0]?.key).toBe("valueUspOptedOutY");
    expect(row?.wireLines).toEqual([
      { key: "lineUspWireDiffers", substitution: ["pixel.rubiconproject.com"], value: "1---", title: "1---\npixel.rubiconproject.com\ngum.criteo.com" },
      { key: "lineUspWireDiffers", substitution: ["ads.pubmatic.com"], value: "1YNN", title: "1YNN\nads.pubmatic.com" },
    ]);
  });

  it("decodes the first string a request carried when the page reported none, and lists the others", () => {
    const row = strRow(build(obs({ usPrivacy: { ...newsH, fromApi: null } })), "usp");
    expect(row?.summary[0]?.key).toBe("valueUspWireOnly");
    expect(row?.raw).toBe("1---");
    expect(row?.wireLines?.map((l) => [l.key, l.substitution[0]])).toEqual([
      ["lineUspWireOnly", "pixel.rubiconproject.com"],
      ["lineUspWireDiffers", "securepubads.g.doubleclick.net"],
      ["lineUspWireDiffers", "ads.pubmatic.com"],
    ]);
  });

  it("says the page's cookie disagrees when every request carried what __uspapi reports", () => {
    const usPrivacy = { fromApi: "1YYN", fromCookie: "1YNN", fromWire: "1YYN", wireValues: [{ value: "1YYN", hosts: ["a.example"] }] };
    const v = build(obs({ usPrivacy }), [
      {
        flag: "usp-surfaces-disagree",
        rank: 20,
        entity: null,
        artifact: { kind: "usp", fromApi: "1YYN", fromCookie: "1YNN", fromWire: "1YYN", fromWireHost: "a.example" },
      },
    ]);
    const n = v.notices.find((x) => x.kind === "finding");
    expect(n).toMatchObject({ textKey: "findingUspCookieDisagree", substitution: ["1YYN", "1YNN"] });
    expect(strRow(v, "usp")?.wireLines).toEqual([
      { key: "lineUspCookieDiffers", substitution: [], value: "1YNN", title: "1YNN" },
    ]);
  });

  it("names the request when one carried a string that differs, whatever the cookie holds", () => {
    const v = build(obs({ usPrivacy: { ...newsH, fromCookie: "1YNN" } }), [
      {
        flag: "usp-surfaces-disagree",
        rank: 20,
        entity: null,
        artifact: { kind: "usp", fromApi: "1YYN", fromCookie: "1YNN", fromWire: "1---", fromWireHost: "pixel.rubiconproject.com" },
      },
    ]);
    expect(v.notices.find((x) => x.kind === "finding")?.textKey).toBe("findingUspDisagreeHost");
    expect(strRow(v, "usp")?.wireLines?.map((l) => l.key)).toEqual(["lineUspCookieDiffers", "lineUspWireDiffers", "lineUspWireDiffers"]);
  });

  it("says requests did not agree when the page reported no string, naming the first two", () => {
    const values = newsH.wireValues;
    const usp = build(obs({ usPrivacy: { ...newsH, fromApi: null } }), [
      { flag: "usp-requests-disagree", rank: 22, entity: null, artifact: { kind: "wire-values", values } },
    ]);
    expect(usp.notices.find((x) => x.kind === "finding")).toMatchObject({
      textKey: "findingUspRequestsDisagree",
      substitution: ["1---", "pixel.rubiconproject.com", "1YYN", "securepubads.g.doubleclick.net"],
    });

    const gppValues = [
      { value: "DBABz~a", hosts: ["fastlane.rubiconproject.com"] },
      { value: "DBABz~b", hosts: ["ads.pubmatic.com", "x.example"] },
    ];
    const v = build(obs({ gpp: { ...gppBase, fromWire: "DBABz~b", wireValues: gppValues } }), [
      { flag: "gpp-requests-disagree", rank: 23, entity: null, artifact: { kind: "wire-values", values: gppValues } },
    ]);
    expect(v.notices.find((x) => x.kind === "finding")).toMatchObject({
      textKey: "findingGppRequestsDisagree",
      substitution: ["DBABz~a", "fastlane.rubiconproject.com", "DBABz~b", "ads.pubmatic.com"],
    });
    // The row says the string was only seen on a request, and lists each one.
    const row = strRow(v, "gpp");
    expect(row?.summary[0]?.key).toBe("valueGppWireOnly");
    expect(row?.wireLines).toEqual([
      { key: "lineGppWireCarried", substitution: ["fastlane.rubiconproject.com"], value: "DBABz~a", title: "DBABz~a\nfastlane.rubiconproject.com" },
      { key: "lineGppWireCarried", substitution: ["ads.pubmatic.com"], value: "DBABz~b", title: "DBABz~b\nads.pubmatic.com\nx.example" },
    ]);
  });

  it("lists each GPP string requests carried that differs from the page's", () => {
    const page = gppWith({ Gpc: 1 });
    const row = strRow(
      build(
        obs({
          gpp: {
            ...page,
            fromWire: page.rawString,
            wireValues: [
              { value: page.rawString, hosts: ["securepubads.g.doubleclick.net"] },
              { value: "DBABBg~stale", hosts: ["fastlane.rubiconproject.com"] },
            ],
          },
        }),
      ),
      "gpp",
    );
    expect(row?.wireLines).toEqual([
      { key: "lineGppWireDiffers", substitution: ["fastlane.rubiconproject.com"], value: "DBABBg~stale", title: "DBABBg~stale\nfastlane.rubiconproject.com" },
    ]);
  });
});

describe("the caption under the count", () => {
  // It names each kind of vendor and how many, counting companies.
  type Kind = "advertising" | "analytics";
  /** A page whose counted cookies were set by these vendors: [company, kind, cookies]. */
  const page = (setters: [string, Kind | undefined, number][], signal: "on" | "off" = "on") => {
    const keys = setters.flatMap(([name, kind, n]) =>
      Array.from({ length: n }, (_, i) => ({ key: `c${i}\u0000.${name.toLowerCase()}.${kind ?? "x"}.example`, name, kind })),
    );
    const mine = keys.map((k) => k.key);
    const off = signal === "off";
    return buildPopupView({
      observations: obs({
        ...(off ? { signal: { source: "none" } as never } : {}),
        tallies: {
          ...EMPTY_TALLIES,
          totalRequests: 30,
          adCookieKeys: off ? [] : mine,
          adCookieKeysUnsigned: off ? mine : [],
          adCookieEntities: Object.fromEntries(keys.map((k) => [k.key, k.name])),
          adCookieCategories: Object.fromEntries(keys.flatMap((k) => (k.kind ? [[k.key, k.kind]] : []))),
        },
      }),
      findings: [],
      distinctCookies: off ? 0 : mine.length,
      distinctCookiesUnsigned: off ? mine.length : 0,
      adTechRequests: 9,
    });
  };
  const caption = (...args: Parameters<typeof page>) => page(...args).countCaption;

  it("names each kind when vendors of both set cookies", () => {
    expect(caption([["Criteo", "advertising", 2], ["Kargo", "advertising", 1], ["Digioh", "analytics", 1], ["Parsely", "analytics", 1]]))
      .toEqual({ key: "countCookiesByBoth", substitution: ["2", "2"] });
  });

  it("ends on the singular when there is one analytics vendor", () => {
    expect(caption([["Criteo", "advertising", 2], ["Kargo", "advertising", 1], ["Digioh", "analytics", 1]]))
      .toEqual({ key: "countCookiesByBothOneAnalytics", substitution: ["2"] });
    expect(caption([["Criteo", "advertising", 1], ["Digioh", "analytics", 1]]))
      .toEqual({ key: "countCookiesByBothOneAnalytics", substitution: ["1"] });
  });

  it("keeps the plural after several analytics vendors, whatever the first number", () => {
    expect(caption([["Criteo", "advertising", 1], ["Digioh", "analytics", 1], ["Parsely", "analytics", 1]]))
      .toEqual({ key: "countCookiesByBoth", substitution: ["1", "2"] });
  });

  it("counts a company that set cookies from both kinds of domain once under each", () => {
    // Microsoft: MUID from its advertising domain, CLID and MUID from its analytics one.
    const v = page([["Microsoft", "advertising", 1], ["Microsoft", "analytics", 2], ["Criteo", "advertising", 1]]);
    expect(v.countCaption).toEqual({ key: "countCookiesByBothOneAnalytics", substitution: ["2"] });
    expect(v.countNames.map((n) => [n.name, n.category])).toEqual([["Criteo", "advertising"], ["Microsoft", "advertising"], ["Microsoft", "analytics"]]);
  });

  it.each([
    ["advertising", "Advertising"],
    ["analytics", "Analytics"],
  ] as const)("names one kind when only %s vendors set any", (kind, word) => {
    expect(caption([["A", kind, 2], ["B", kind, 1], ["C", kind, 1]])).toEqual({ key: `countCookiesBy${word}`, substitution: ["3"] });
    expect(caption([["A", kind, 3]])).toEqual({ key: `countCookiesByOne${word}` });
    expect(caption([["A", kind, 1]])).toEqual({ key: `countCookiesOneBy${word}` });
  });

  it("has every form again with sending off", () => {
    expect(caption([["Criteo", "advertising", 2], ["Digioh", "analytics", 1], ["Parsely", "analytics", 1]], "off"))
      .toEqual({ key: "countCookiesOffByBoth", substitution: ["1", "2"] });
    expect(caption([["Criteo", "advertising", 2], ["Digioh", "analytics", 1]], "off"))
      .toEqual({ key: "countCookiesOffByBothOneAnalytics", substitution: ["1"] });
    expect(caption([["A", "advertising", 1], ["B", "advertising", 1]], "off")).toEqual({ key: "countCookiesOffByAdvertising", substitution: ["2"] });
    expect(caption([["A", "analytics", 2]], "off")).toEqual({ key: "countCookiesOffByOneAnalytics" });
    expect(caption([["A", "analytics", 1]], "off")).toEqual({ key: "countCookiesOffOneByAnalytics" });
  });

  it("names no kind for a capture that cannot say which a vendor is", () => {
    expect(caption([["A", undefined, 1], ["B", undefined, 2]])).toEqual({ key: "countCookiesByVendors", substitution: ["2"] });
    expect(caption([["A", undefined, 2]])).toEqual({ key: "countCookiesByOneVendor" });
    expect(caption([["A", undefined, 1]])).toEqual({ key: "countCookiesOneByVendor" });
    // One vendor of unknown kind is enough: the sentence would otherwise count it as neither.
    expect(caption([["A", "advertising", 1], ["B", undefined, 1]])).toEqual({ key: "countCookiesByVendors", substitution: ["2"] });
  });

  it("says none were set for a counted zero, and never zero vendors under a count", () => {
    expect(caption([])).toEqual({ key: "countCookiesZero" });
    expect(caption([], "off")).toEqual({ key: "countCookiesOffZero" });
    // A count the tallies name nobody for: the domains, not "0 vendors".
    expect(build(obs(), [cookieFinding("X", "a")]).countCaption?.key).toMatch(/^countCookies(OneByVendor)$/);
    const unnamed = buildPopupView({ observations: obs({ tallies: { ...EMPTY_TALLIES, totalRequests: 5 } }), findings: [], distinctCookies: 3, adTechRequests: 5 });
    expect(unnamed.countCaption).toEqual({ key: "countCookies" });
  });

  describe("a domain the list names no company for", () => {
    // Its cookies are in the count and its row is under the count's category, but it is not
    // a vendor the list names, so the caption's number leaves it out.
    const withDomains = (vendors: [string, Kind, number][], domains: [string, Kind, number][], signal: "on" | "off" = "on") => {
      const keys = [
        ...vendors.flatMap(([name, kind, n]) => Array.from({ length: n }, (_, i) => ({ key: `c${i}\u0000.${name.toLowerCase()}.example`, name: name as string | null, kind }))),
        ...domains.flatMap(([domain, kind, n]) => Array.from({ length: n }, (_, i) => ({ key: `d${i}\u0000.${domain}`, name: null, kind }))),
      ];
      const mine = keys.map((k) => k.key);
      const off = signal === "off";
      return buildPopupView({
        observations: obs({
          ...(off ? { signal: { source: "none" } as never } : {}),
          tallies: {
            ...EMPTY_TALLIES,
            totalRequests: 30,
            adCookieKeys: off ? [] : mine,
            adCookieKeysUnsigned: off ? mine : [],
            adCookieEntities: Object.fromEntries(keys.flatMap((k) => (k.name === null ? [] : [[k.key, k.name]]))),
            adCookieCategories: Object.fromEntries(keys.map((k) => [k.key, k.kind])),
          },
        }),
        findings: [],
        distinctCookies: off ? 0 : mine.length,
        distinctCookiesUnsigned: off ? mine.length : 0,
        adTechRequests: 9,
      });
    };

    it("keeps its cookies under the count and leaves it out of the vendors", () => {
      const v = withDomains([["Criteo", "advertising", 2]], [["tracker.example", "advertising", 1]]);
      expect(v.cookieCount).toBe(3);
      expect(v.countNames.map((n) => [n.name, n.unlisted === true, n.cookies.length])).toEqual([
        ["Criteo", false, 2],
        ["tracker.example", true, 1],
      ]);
      expect(v.countCaption).toEqual({ key: "countCookiesByOneAdvertising" });
      expect(withDomains([["Criteo", "advertising", 1], ["Digioh", "analytics", 1]], [["tracker.example", "analytics", 2]]).countCaption)
        .toEqual({ key: "countCookiesByBothOneAnalytics", substitution: ["1"] });
    });

    it("names no vendors when every counted cookie is a domain's", () => {
      expect(withDomains([], [["tracker.example", "advertising", 2]]).countCaption).toEqual({ key: "countCookies" });
      expect(withDomains([], [["tracker.example", "advertising", 1]]).countCaption).toEqual({ key: "countCookiesOne" });
      expect(withDomains([], [["a.example", "advertising", 1], ["b.example", "analytics", 1]]).countCaption).toEqual({ key: "countCookies" });
      expect(withDomains([], [["tracker.example", "analytics", 2]], "off").countCaption).toEqual({ key: "countCookiesOff" });
      expect(withDomains([], [["tracker.example", "analytics", 1]], "off").countCaption).toEqual({ key: "countCookiesOffOne" });
    });
  });

  it("explains the missing number where there was no ad tech, and says nothing where no count is shown", () => {
    expect(build(obs(), [], 0).countCaption).toEqual({ key: "stateNoAdTech" });
    expect(build(null).countCaption).toBeUndefined();
    expect(build(obs({ context: { loadObserved: false } as never })).countCaption).toBeUndefined();
  });

  it("uses only messages that exist, and none of them says ad", () => {
    const messages: Readonly<Record<string, { message: string }>> = messagesJson;
    const keys = new Set<string>();
    for (const signal of ["on", "off"] as const) {
      for (const setters of [
        [], [["A", "advertising", 1]], [["A", "advertising", 2]], [["A", "advertising", 1], ["B", "advertising", 1]],
        [["A", "analytics", 1]], [["A", "analytics", 2]], [["A", "analytics", 1], ["B", "analytics", 1]],
        [["A", "advertising", 1], ["B", "analytics", 1]], [["A", "advertising", 1], ["B", "analytics", 1], ["C", "analytics", 1]],
        [["A", undefined, 1]], [["A", undefined, 2]], [["A", undefined, 1], ["B", undefined, 1]],
      ] as [string, Kind | undefined, number][][]) {
        const c = caption(setters, signal);
        if (c) keys.add(c.key);
      }
    }
    expect(keys.size).toBe(24);
    for (const key of keys) {
      expect(messages[key], key).toBeDefined();
      expect(messages[key]!.message, key).not.toMatch(/(?<![\w])ads?(?![\w])/i);
    }
    // The rule is for every message, and the lint holds it; this is the same check, here.
    for (const [key, m] of Object.entries(messages)) expect(m.message, key).not.toMatch(/(?<![\w])ads?(?![\w])/i);
  });
});

describe("wording and state", () => {
  it("says GDPR does not apply when the consent tool answered so", () => {
    const row = strRow(build(obs({ tcf: { tcString: "", gdprApplies: false, purposeConsents: {} } })), "tcf");
    expect(row?.summary[0]?.key).toBe("valueTcfGdprNotApplies");
    expect(row?.noteKey).toBe("tcfGdprNotAppliesNote");
    expect(row?.groups).toEqual([]);
  });

  it("keeps 'not found' and says what the server answered", () => {
    const hint = (reason: string) =>
      build(obs({ wellKnown: { url: "https://www.social-b.example/.well-known/gpc.json", present: false, gpc: null, lastUpdate: null, reason, fresh: true, observedAtMs: 0 } as never }))
        .siteDid.find((r) => r.labelKey === "labelWellKnown");
    const forbidden = hint("status 403");
    expect(forbidden?.valueKey).toBe("valueWellKnownNotPresent");
    expect(forbidden?.hintParts?.[1]).toEqual({ key: "hintWellKnownStatus", substitution: ["403"] });
    expect(hint("status 400")?.valueKey).toBe("valueWellKnownNotPresent");
    expect(hint("html response")?.hintParts).toHaveLength(1);
  });

  it("says 'could not be checked' when the server never answered", () => {
    // A timeout on a heavy page would read "not found · no response" for a site that publishes
    // `gpc: true`. No answer is not an absence.
    const row = (reason: string) =>
      build(obs({ wellKnown: { url: "https://shop.example/.well-known/gpc.json", present: false, gpc: null, lastUpdate: null, reason, fresh: true, observedAtMs: 0 } as never }))
        .siteDid.find((r) => r.labelKey === "labelWellKnown");
    for (const reason of ["request failed: TimeoutError: signal timed out", "request failed: TypeError: Failed to fetch", "redirect target not seen"]) {
      expect(row(reason)?.valueKey, reason).toBe("valueWellKnownUnchecked");
      expect(row(reason)?.hintParts, reason).toEqual([{ text: "shop.example/.well-known/gpc.json" }, { key: "hintWellKnownNoResponse" }]);
    }
    // A redirect off the site is an answer: what the site serves there.
    expect(row("redirect to another site")?.valueKey).toBe("valueWellKnownNotPresent");
  });

  describe("'We could not observe Consent Mode'", () => {
    const unavailable = (o: ObservationSet) => build(o).notices.some((n) => n.textKey === "stateCaptureUnavailable");

    it("is not shown on a page with no Google tag (marketplace-a.example)", () => {
      expect(unavailable(obs({ capabilities: { dataLayer: false } as never }))).toBe(false);
    });

    it("is still shown when a Google tag loaded and its dataLayer could not be watched", () => {
      const o = obs({
        capabilities: { dataLayer: false } as never,
        network: [{ id: "1", url: "https://www.googletagmanager.com/gtag/js?id=G-1", method: "GET", resourceType: "script", initiator: null, secGpcPresent: true, cookiesSent: [], requestHeaders: [], statusCode: 200, responseHeaders: null, isRedirectHop: false, setCookies: [], captureMethod: "onHeadersReceived", timeMs: 0 }],
      });
      expect(unavailable(o)).toBe(true);
    });
  });

  it("names each loader once", () => {
    // ebay.com: "loaded by the site itself, also by eBay, also by the site".
    const line = loadedViaRowLine(
      [
        { kind: "site", url: null },
        { kind: "entity", name: "eBay" },
        { kind: "site", url: "https://www.ebay.com/b.js" },
        { kind: "entity", name: "eBay" },
      ] as never,
      [],
    );
    expect(line?.parts).toEqual([{ key: "vendorLoadedBySite" }, { key: "vendorLoadedAlsoByVendor", substitution: ["eBay"] }]);
  });
});

describe("names under the headline", () => {
  const K = (name: string, domain: string): string => `${name}\u0000${domain}`;

  it("lists advertising vendors first, then analytics, each in list order", () => {
    // retailer-c.example: Embrace and Medallia are analytics, Google advertising.
    const keys: [string, string, "advertising" | "analytics"][] = [
      [K("lux_uid", ".retailer-c.example"), "Embrace", "analytics"],
      [K("__gads", ".doubleclick.net"), "Google", "advertising"],
      [K("kampyle_userid", ".retailer-c.example"), "Medallia", "analytics"],
      [K("uid", ".criteo.com"), "Criteo", "advertising"],
    ];
    const v = buildPopupView({
      observations: obs({
        tallies: {
          ...EMPTY_TALLIES,
          totalRequests: 20,
          adCookieKeys: keys.map(([k]) => k),
          adCookieEntities: Object.fromEntries(keys.map(([k, e]) => [k, e])),
          adCookieCategories: Object.fromEntries(keys.map(([k, , c]) => [k, c])),
        },
      }),
      findings: [],
      distinctCookies: 4,
      adTechRequests: 5,
    });
    expect(v.countNames.map((n) => [n.name, n.category])).toEqual([
      ["Criteo", "advertising"], ["Google", "advertising"], ["Embrace", "analytics"], ["Medallia", "analytics"],
    ]);
  });

  it("names a company under each category it set cookies from", () => {
    const keys: [string, string, "advertising" | "analytics"][] = [
      [K("MUID", ".bing.com"), "Microsoft", "advertising"],
      [K("CLID", ".clarity.ms"), "Microsoft", "analytics"],
      [K("MUID", ".clarity.ms"), "Microsoft", "analytics"],
      [K("kampyle_userid", ".retailer-c.example"), "Medallia", "analytics"],
    ];
    const v = buildPopupView({
      observations: obs({
        tallies: {
          ...EMPTY_TALLIES,
          totalRequests: 20,
          adCookieKeys: keys.map(([k]) => k),
          adCookieEntities: Object.fromEntries(keys.map(([k, e]) => [k, e])),
          adCookieCategories: Object.fromEntries(keys.map(([k, , c]) => [k, c])),
        },
      }),
      findings: [],
      distinctCookies: 4,
      adTechRequests: 5,
    });
    expect(v.countNames).toEqual([
      { name: "Microsoft", category: "advertising", cookies: ["MUID"], functionalCookies: [] },
      { name: "Medallia", category: "analytics", cookies: ["kampyle_userid"], functionalCookies: [] },
      { name: "Microsoft", category: "analytics", cookies: ["CLID", "MUID"], functionalCookies: [] },
    ]);
    expect(v.countNames.reduce((n, x) => n + x.cookies.length, 0)).toBe(v.cookieCount);
  });

  it("keeps the list order when categories are unknown", () => {
    const v = build(obs(), [cookieFinding("Embrace", "lux_uid"), cookieFinding("Google", "__gads")]);
    expect(v.countNames.map((n) => n.name)).toEqual(v.vendors.filter((r) => r.cookies.length > 0).map((r) => r.name));
  });
});

describe("the names and rows list exactly what the count counts (1.19.0)", () => {
  const K = (name: string, domain: string): string => `${name}\u0000${domain}`;
  const entity = (cookieNames: string[]) => ({ requests: 1, signedRequests: 1, cookieNames, cookiesReturned: [], hosts: [] });
  const view = (keys: string[], owners: Record<string, string>, byEntity: Record<string, ReturnType<typeof entity>>, findings: Finding[] = [], categories?: Record<string, "advertising" | "analytics">) =>
    buildPopupView({
      observations: obs({ tallies: { ...EMPTY_TALLIES, totalRequests: 20, adCookieKeys: keys, adCookieEntities: owners, byEntity, ...(categories ? { adCookieCategories: categories } : {}) } }),
      findings,
      distinctCookies: keys.length,
      adTechRequests: 5,
    });
  const listed = (v: ReturnType<typeof buildPopupView>): number => v.countNames.reduce((n, x) => n + x.cookies.length, 0);

  it("leaves out a probe the count left out, whatever the findings say (sports-a.example, 2026-09-23)", () => {
    // Braze's ab._gd was taken out of the count as a probe, and a finding on an older
    // retained request still names it. Listed from the finding: five counted, six named.
    const keys = [K("ab.storage.deviceId", ".sports-a.example"), K("ab.storage.sessionId", ".sports-a.example"), K("ab.storage.userId", ".sports-a.example"), K("_parsely_session", ".sports-a.example"), K("_parsely_visitor", ".sports-a.example")];
    const owners = Object.fromEntries(keys.map((k) => [k, k.startsWith("ab.") ? "Braze" : "WordPress VIP"]));
    const v = view(keys, owners, { Braze: entity(["ab._gd", "ab.storage.deviceId"]), "WordPress VIP": entity(["_parsely_session"]) }, [cookieFinding("Braze", "ab._gd")]);
    expect(v.cookieCount).toBe(5);
    expect(listed(v)).toBe(5);
    expect(v.vendors.find((r) => r.name === "Braze")?.cookies).toEqual(["ab.storage.deviceId", "ab.storage.sessionId", "ab.storage.userId"]);
  });

  it("lists a name set on two domains twice, by domain, as the count does", () => {
    const keys = [K("uid", ".a.example"), K("uid", ".b.example")];
    const v = view(keys, { [keys[0]!]: "Criteo", [keys[1]!]: "Criteo" }, { Criteo: entity(["uid"]) });
    expect(v.vendors[0]?.cookies).toEqual(["uid (.a.example)", "uid (.b.example)"]);
    expect(listed(v)).toBe(v.cookieCount);
  });

  it("names a cookie from a request with no named vendor by its domain, with what is known of it", () => {
    const keys = [K("x", ".tracker.example"), K("IDE", ".doubleclick.net")];
    const v = view(keys, { [keys[1]!]: "Google" }, { Google: entity(["IDE"]) }, [], { [keys[0]!]: "advertising", [keys[1]!]: "advertising" });
    expect(v.countNames.map((n) => n.name).sort()).toEqual(["Google", "tracker.example"]);
    expect(listed(v)).toBe(2);
    // The row says it is a domain, not a company, and takes its category from its cookies,
    // since there is no tally entry to classify.
    const row = v.vendors.find((r) => r.name === "tracker.example");
    expect(row?.category).toBe("advertising");
    expect(row?.detail.unlistedDomain).toBe(true);
    // Its own check state: "not captured" would claim a capture loss that did not happen.
    expect(row?.checkKey).toBe("vendorGpcUnlistedDomain");
    expect(row?.checkHelp).toEqual({ key: "vendorGpcUnlistedDomainHelp" });
    expect(v.vendors.find((r) => r.name === "Google")?.detail).not.toHaveProperty("unlistedDomain");
  });

  it("lists an unlisted domain under each category its cookies came from", () => {
    const keys = [K("a", ".tracker.example"), K("b", ".tracker.example")];
    const v = view(keys, {}, {}, [], { [keys[0]!]: "advertising", [keys[1]!]: "analytics" });
    expect(v.vendors.map((r) => [r.name, r.category, r.cookies, r.checkKey])).toEqual([
      ["tracker.example", "advertising", ["a"], "vendorGpcUnlistedDomain"],
      ["tracker.example", "analytics", ["b"], "vendorGpcUnlistedDomain"],
    ]);
    expect(listed(v)).toBe(v.cookieCount);
  });

  it("counts one cookie once when two vendors' requests set it", () => {
    const keys = [K("_gcl_au", ".example.com")];
    const v = view(keys, { [keys[0]!]: "Google" }, { Google: entity(["_gcl_au"]), Adobe: entity(["_gcl_au"]) });
    expect(v.countNames).toEqual([{ name: "Google", cookies: ["_gcl_au"], functionalCookies: [] }]);
  });
});

describe("a row is a company in one category", () => {
  const K = (name: string, domain: string): string => `${name}\u0000${domain}`;
  const classify = classifyWith([
    ["bat.bing.com", "Microsoft", "advertising"],
    ["clarity.ms", "Microsoft", "analytics"],
    ["bing.com", "Microsoft", "content"],
    ["facebook", "Meta", "social"],
    ["cookielaw", "OneTrust", "consent-managers"],
    ["techcrunch", "Yahoo!", "unknown"],
    ["criteo", "Criteo", "advertising"],
    ["parsely", "Parsely", "analytics"],
  ]);
  const counted: [string, string, "advertising" | "analytics"][] = [
    [K("MUID", ".bing.com"), "Microsoft", "advertising"],
    [K("CLID", ".clarity.ms"), "Microsoft", "analytics"],
    [K("uid", ".criteo.com"), "Criteo", "advertising"],
  ];
  const net = (url: string, resourceType: string, cookies: [string, string][] = []) => ({
    id: url, url, method: "GET", resourceType, initiator: null, secGpcPresent: true, cookiesSent: [], requestHeaders: [],
    statusCode: 200, responseHeaders: null, isRedirectHop: false, captureMethod: "onHeadersReceived" as const, timeMs: 1_000,
    setCookies: cookies.map(([name, domain]) => ({
      name, value: "", domain, path: "/", expiresMs: "session" as const, sameSite: "None" as const, httpOnly: false, secure: true, partitioned: false, via: "onHeadersReceived" as const,
    })),
  });
  const page = (over: Partial<ObservationSet> = {}, findings: Finding[] = []) =>
    buildPopupView({
      observations: obs({
        network: [
          net("https://bat.bing.com/action/0", "image", [["MUID", ".bing.com"]]),
          net("https://www.clarity.ms/tag/x", "script", [["CLID", ".clarity.ms"]]),
          net("https://www.bing.com/sw.js", "script", [["SRCHD", ".bing.com"]]),
        ] as never,
        tallies: {
          ...EMPTY_TALLIES,
          totalRequests: 40,
          adCookieKeys: counted.map(([k]) => k),
          adCookieKeysUnsigned: [],
          adCookieEntities: Object.fromEntries(counted.map(([k, e]) => [k, e])),
          adCookieCategories: Object.fromEntries(counted.map(([k, , c]) => [k, c])),
          byEntityCategory: summaries(
            summary("Microsoft", "advertising", { requests: 4, signedRequests: 4, hosts: ["bat.bing.com"], resourceTypes: ["image"], scriptRan: false, cookiesReturned: ["MUID"], refusedWrites: ["_uetvid (.com)"] }),
            summary("Microsoft", "analytics", { requests: 5, signedRequests: 4, hosts: ["www.clarity.ms"], probeCookies: ["_clck_test"] }),
            summary("Microsoft", "content", { requests: 1, signedRequests: 1, hosts: ["www.bing.com"], cookieKeys: [K("SRCHD", ".bing.com")], cookieKeysUnsigned: [K("SRCHUID", ".bing.com")] }),
            summary("Criteo", "advertising", { hosts: ["static.criteo.net"] }),
            summary("Parsely", "analytics", { hosts: ["cdn.parsely.com"] }),
            summary("Meta", "social", { hosts: ["connect.facebook.net"], cookieKeys: [K("fr", ".facebook.com")] }),
            summary("OneTrust", "consent-managers", { hosts: ["cdn.cookielaw.org"] }),
            summary("Yahoo!", "unknown", { hosts: ["techcrunch.com"], resourceTypes: ["image"], scriptRan: false }),
          ),
        },
        ...over,
      }),
      findings,
      distinctCookies: counted.length,
      adTechRequests: 9,
      classify,
    });
  const row = (v: ReturnType<typeof page>, name: string, category: string) => v.vendors.find((r) => r.name === name && r.category === category);

  it("lists a company under every category it has domains in, in the list's order", () => {
    const v = page();
    expect(v.vendors.map((r) => [r.name, r.category, r.counted])).toEqual([
      // Inside a category, the rows that set a cookie, then the rest.
      ["Criteo", "advertising", true],
      ["Microsoft", "advertising", true],
      ["Microsoft", "analytics", true],
      ["Parsely", "analytics", true],
      ["Meta", "social", false],
      ["OneTrust", "consent-managers", false],
      ["Microsoft", "content", false],
      // A company Disconnect names as an owner and gives no category, last.
      ["Yahoo!", "unknown", false],
    ]);
    expect(new Set(v.vendors.map((r) => r.key)).size).toBe(v.vendors.length);
  });

  it("gives each row the cookies of its own category's domains", () => {
    const v = page();
    expect(row(v, "Microsoft", "advertising")?.cookies).toEqual(["MUID"]);
    expect(row(v, "Microsoft", "analytics")?.cookies).toEqual(["CLID"]);
    // A cookie the headline does not count, from the summary that recorded it.
    expect(row(v, "Microsoft", "content")?.cookies).toEqual(["SRCHD"]);
    expect(row(v, "Meta", "social")?.cookies).toEqual(["fr"]);
    expect(row(v, "OneTrust", "consent-managers")?.cookies).toEqual([]);
  });

  it("names under the headline only what the headline counts", () => {
    const v = page();
    expect(v.countNames.map((n) => [n.name, n.category])).toEqual([
      ["Criteo", "advertising"], ["Microsoft", "advertising"], ["Microsoft", "analytics"],
    ]);
    expect(v.countNames.reduce((n, x) => n + x.cookies.length, 0)).toBe(v.cookieCount);
  });

  it("lists the cookies set without the signal when sending is off, in every category", () => {
    const v = page({ signal: { source: "none" } as never });
    expect(row(v, "Microsoft", "content")?.cookies).toEqual(["SRCHUID"]);
    expect(row(v, "Meta", "social")?.cookies).toEqual([]);
    expect(row(v, "Microsoft", "advertising")?.cookies).toEqual([]);
  });

  it("gives each row its own state", () => {
    const v = page({}, [
      pairFinding("Microsoft", "advertising", "vendor-no-script-observed"),
      pairFinding("Microsoft", "analytics", "vendor-read-gpc", { kind: "signal-read", readCount: 2 }),
      pairFinding("Microsoft", "content", "vendor-did-not-read-gpc"),
      pairFinding("Yahoo!", "unknown", "vendor-no-script-observed"),
    ]);
    expect(row(v, "Microsoft", "advertising")?.checkKey).toBe("vendorGpcNotApplicable");
    expect(row(v, "Microsoft", "analytics")?.checkKey).toBe("vendorGpcReadProperty");
    expect(row(v, "Microsoft", "content")?.checkKey).toBe("vendorGpcNotRead");
    expect(row(v, "Yahoo!", "unknown")?.checkKey).toBe("vendorGpcNotApplicable");
    // No finding for the row: not captured, never another row's answer.
    expect(row(v, "Criteo", "advertising")?.checkKey).toBe("vendorGpcCheckUnavailable");
  });

  it("limits a row's panel to its own category's domains", () => {
    const v = page({
      consentApiCalls: [{ api: "__gpp", command: "getGPPData", callerScriptUrl: "https://www.clarity.ms/tag/x", viaTagManager: false, timeMs: 0 }],
      signal: { readTracking: "active", readCount: 4, readsByScript: { "https://www.bing.com/sw.js": 4 }, readAttribution: { sampled: 4, unattributed: 0, viaTagManager: 0 } } as never,
    });
    const ad = row(v, "Microsoft", "advertising")?.detail;
    expect(ad).toMatchObject({ domains: ["bat.bing.com"], requestCount: 4, signedRequestCount: 4, resourceTypes: ["image"], consentCalls: [], signalReads: 0, refusedWrites: ["_uetvid (.com)"], probeCookies: [] });
    expect(ad?.cookies.map((c) => [c.name, c.sentBack])).toEqual([["MUID", true]]);

    const an = row(v, "Microsoft", "analytics")?.detail;
    expect(an).toMatchObject({ domains: ["www.clarity.ms"], requestCount: 5, signedRequestCount: 4, consentCalls: [{ api: "__gpp", count: 1 }], signalReads: 0, probeCookies: ["_clck_test"], refusedWrites: [] });
    expect(an?.cookies.map((c) => c.name)).toEqual(["CLID"]);

    const content = row(v, "Microsoft", "content")?.detail;
    expect(content).toMatchObject({ domains: ["www.bing.com"], requestCount: 1, signalReads: 4 });
    // SRCHUID is in the row's summary with no request left that set it: by name alone, its
    // attributes neither kept nor guessed at (1.22.0).
    expect(content?.cookies.map((c) => [c.name, c.expiry?.key, c.sameSite])).toEqual([["SRCHD", "cookieExpirySession", "None"], ["SRCHUID", undefined, undefined]]);
  });

  it("marks sent back only the cookies of that name the vendor's hosts could receive", () => {
    // The capture records the names a request's Cookie header carried. MUID went back to
    // bat.bing.com: the one set on .bing.com could have gone, the one a script wrote on the
    // page's own site and the one on another bing.com host could not.
    const keys = [K("MUID", ".bing.com"), K("MUID", ".example.com"), K("MUID", ".c.bing.com"), K("MR", ".bat.bing.com")];
    const v = page({
      tallies: {
        ...EMPTY_TALLIES,
        totalRequests: 4,
        adCookieKeys: keys,
        adCookieKeysUnsigned: [],
        adCookieEntities: Object.fromEntries(keys.map((k) => [k, "Microsoft"])),
        adCookieCategories: Object.fromEntries(keys.map((k) => [k, "advertising"])),
        byEntityCategory: summaries(summary("Microsoft", "advertising", { requests: 4, signedRequests: 4, hosts: ["bat.bing.com"], cookiesReturned: ["MUID", "MR"] })),
      },
    });
    const cookies = row(v, "Microsoft", "advertising")?.detail.cookies ?? [];
    expect(Object.fromEntries(cookies.map((c) => [`${c.name} ${c.domain}`, c.sentBack]))).toEqual({
      "MUID .bing.com": true, "MUID .example.com": false, "MUID .c.bing.com": false, "MR .bat.bing.com": true,
    });
  });

  it("sends a cookie to its domain's own host and every host under it", () => {
    expect(sentToAnyHost(".bing.com", ["bat.bing.com"])).toBe(true);
    expect(sentToAnyHost(".bing.com", ["bing.com"])).toBe(true);
    expect(sentToAnyHost("bat.bing.com", ["bat.bing.com"])).toBe(true);
    expect(sentToAnyHost(".Bing.com", ["bat.bing.com"])).toBe(true);
    expect(sentToAnyHost(".bat.bing.com", ["bing.com", "c.bing.com"])).toBe(false);
    expect(sentToAnyHost(".ing.com", ["bat.bing.com"])).toBe(false);
    expect(sentToAnyHost(".example.com", ["bat.bing.com"])).toBe(false);
    expect(sentToAnyHost(".bing.com", [])).toBe(false);
  });

  it("lists a cookie in the panel of the row that counts it, wherever its detail's host is", () => {
    // MUID is counted under Microsoft's advertising row. Its detail names a clarity.ms host,
    // an analytics domain; the panel follows the count, as the row's names do (1.22.0).
    const detail = (host: string) => ({
      expiresMs: "session" as const, sameSite: "Lax" as const, secure: true, partitioned: false, via: "onHeadersReceived" as const,
      host, onRedirect: false, onRedirectSigned: false, firstSignedObservationId: "r1",
    });
    const v = page({
      network: [],
      tallies: {
        ...EMPTY_TALLIES,
        totalRequests: 9,
        adCookieKeys: [K("CLID", ".clarity.ms"), K("MUID", ".bing.com")],
        adCookieKeysUnsigned: [],
        adCookieEntities: { [K("CLID", ".clarity.ms")]: "Microsoft", [K("MUID", ".bing.com")]: "Microsoft" },
        adCookieCategories: { [K("CLID", ".clarity.ms")]: "analytics", [K("MUID", ".bing.com")]: "advertising" },
        cookieDetails: { [K("CLID", ".clarity.ms")]: detail("www.clarity.ms"), [K("MUID", ".bing.com")]: detail("www.clarity.ms") },
        byEntityCategory: summaries(
          summary("Microsoft", "advertising", { requests: 4, signedRequests: 4, hosts: ["bat.bing.com"] }),
          summary("Microsoft", "analytics", { requests: 5, signedRequests: 5, hosts: ["www.clarity.ms"] }),
        ),
      },
    });
    expect(row(v, "Microsoft", "advertising")?.detail.cookies.map((c) => [c.name, c.sameSite])).toEqual([["MUID", "Lax"]]);
    expect(row(v, "Microsoft", "analytics")?.detail.cookies.map((c) => c.name)).toEqual(["CLID"]);
  });

  it("names a loader once when a company loaded the vendor from two of its categories", () => {
    const loaders = [
      { kind: "entity" as const, name: "Google", category: "advertising" },
      { kind: "entity" as const, name: "Google", category: "content" },
    ];
    expect(loaderLines(loaders, [])).toEqual([{ parts: [{ key: "vendorLoadedViaVendor", substitution: ["Google"] }] }]);
    expect(loadedViaRowLine(loaders, [])).toEqual({ parts: [{ key: "vendorLoadedViaVendor", substitution: ["Google"] }] });
  });

  describe("a capture from before the summaries", () => {
    const old = (findings: Finding[] = []) =>
      buildPopupView({
        observations: obs({
          tallies: {
            ...EMPTY_TALLIES,
            totalRequests: 40,
            adCookieKeys: counted.map(([k]) => k),
            adCookieEntities: Object.fromEntries(counted.map(([k, e]) => [k, e])),
            adCookieCategories: Object.fromEntries(counted.map(([k, , c]) => [k, c])),
            byEntity: {
              Microsoft: { requests: 9, signedRequests: 8, cookieNames: ["CLID", "MUID"], cookiesReturned: ["MUID"], hosts: ["bat.bing.com", "www.clarity.ms"] },
              Criteo: { requests: 2, signedRequests: 2, cookieNames: ["uid"], cookiesReturned: [], hosts: ["static.criteo.net"] },
              Parsely: { requests: 1, signedRequests: 1, cookieNames: [], cookiesReturned: [], hosts: ["cdn.parsely.com"] },
            },
          },
        }),
        findings,
        distinctCookies: counted.length,
        adTechRequests: 9,
        classify,
      });

    it("has a row for each category its cookies and hostnames give a company, and no others", () => {
      expect(old().vendors.map((r) => [r.name, r.category, r.cookies])).toEqual([
        ["Criteo", "advertising", ["uid"]],
        ["Microsoft", "advertising", ["MUID"]],
        ["Microsoft", "analytics", ["CLID"]],
        ["Parsely", "analytics", []],
      ]);
    });

    it("gives each of a company's rows the company's one state, and its one count of requests", () => {
      const v = old([vendorSignalFinding("Microsoft", "vendor-did-not-read-gpc")]);
      expect(row(v, "Microsoft", "advertising")?.checkKey).toBe("vendorGpcNotRead");
      expect(row(v, "Microsoft", "analytics")?.checkKey).toBe("vendorGpcNotRead");
      expect(row(v, "Microsoft", "advertising")?.detail).toMatchObject({ domains: ["bat.bing.com"], requestCount: 9 });
      expect(row(v, "Microsoft", "analytics")?.detail).toMatchObject({ domains: ["www.clarity.ms"], requestCount: 9 });
    });
  });

  it("leaves the category off when the capture cannot say", () => {
    const v = build(obs(), [cookieFinding("Criteo", "uid")]);
    expect(v.vendors[0]).not.toHaveProperty("category");
    expect(v.vendors[0]?.counted).toBe(true);
  });

  it("lists rows with no category first, apart from the rows a label stands over", () => {
    // The list draws a label over each category. Among the advertising rows, a row the
    // capture cannot vouch for would sit under one.
    const keys = ["a\u0000.x.example", "b\u0000.y.example"];
    const v = buildPopupView({
      observations: obs({
        tallies: {
          ...EMPTY_TALLIES,
          totalRequests: 5,
          adCookieKeys: keys,
          adCookieEntities: { [keys[0]!]: "Alpha", [keys[1]!]: "Zeta" },
          adCookieCategories: { [keys[0]!]: "advertising" },
        },
      }),
      findings: [],
      distinctCookies: 2,
      adTechRequests: 5,
    });
    expect(v.vendors.map((r) => [r.name, r.category])).toEqual([["Zeta", undefined], ["Alpha", "advertising"]]);
  });
});

describe("same-owner notice", () => {
  // Third-party is decided by domain, so a company's other domains are a third-party vendor
  // on its own site. Seen 2026-09-22: Yahoo's consent cookies from consent.cmp.oath.com were
  // counted on yahoo.com. The counts stay; the notice says what the classification means.
  const K = (name: string, domain: string): string => `${name}\u0000${domain}`;
  const classify = classifyWith(
    [["yahoo.com", "Yahoo!", "content"], ["oath.com", "Yahoo!", "advertising"], ["yimg.com", "Yahoo!", "content"], ["taboola", "Taboola", "advertising"]],
    "yahoo.com",
  );
  const yahoo = (topSite: string, findings: Finding[], tallies?: ObservationSet["tallies"]) =>
    buildPopupView({
      observations: obs({ context: { topSite, finalUrl: `https://${topSite}/` } as never, ...(tallies ? { tallies } : {}) }),
      findings,
      distinctCookies: findings.length,
      adTechRequests: 5,
      classify,
    });
  /** Yahoo!'s counted cookies, each from a domain of the category named. */
  const counting = (...categories: ("advertising" | "analytics")[]): ObservationSet["tallies"] => {
    const keys = categories.map((c, i) => [K(`c${i}`, ".oath.com"), c] as const);
    return {
      ...EMPTY_TALLIES,
      totalRequests: 12,
      adCookieKeys: keys.map(([k]) => k),
      adCookieEntities: Object.fromEntries(keys.map(([k]) => [k, "Yahoo!"])),
      adCookieCategories: Object.fromEntries(keys),
    };
  };
  const notice = (v: ReturnType<typeof yahoo>) => v.notices.find((x) => x.kind === "ownership");

  it("appears when the site's owner is one of its ad vendors, and leaves the count alone", () => {
    const v = yahoo("www.yahoo.com", [cookieFinding("Yahoo!", "gpp"), cookieFinding("Taboola", "t_gid")]);
    expect(notice(v)).toMatchObject({ tone: "neutral", placement: "top", textKey: "noticeSameOwnerAdvertising", substitution: ["Yahoo!"] });
    expect(v.cookieCount).toBe(2);
    expect(v.vendors.map((r) => r.name)).toContain("Yahoo!");
  });

  it("names analytics, not both, when the owner's domains are analytics only (tiktok-style)", () => {
    expect(notice(yahoo("www.yahoo.com", [], counting("analytics")))?.textKey).toBe("noticeSameOwnerAnalytics");
  });

  it("names both when the owner's domains are in each category (tiktok.com)", () => {
    expect(notice(yahoo("www.yahoo.com", [], counting("advertising", "analytics")))?.textKey).toBe("noticeSameOwnerBoth");
  });

  it("does not appear for an owner whose only rows are in categories that do not count", () => {
    // The notice explains a count and calls the owner an advertising or analytics vendor.
    // yimg.com is Content: a row, and nothing the headline counts.
    const v = yahoo("www.yahoo.com", [], {
      ...EMPTY_TALLIES,
      totalRequests: 12,
      byEntityCategory: summaries(summary("Yahoo!", "content", { hosts: ["s.yimg.com"], cookieKeys: [K("A3", ".yimg.com")] })),
    });
    expect(v.vendors.map((r) => [r.name, r.category])).toEqual([["Yahoo!", "content"]]);
    expect(notice(v)).toBeUndefined();
  });

  it("does not appear when the owner is not among the vendors", () => {
    expect(notice(yahoo("www.yahoo.com", [cookieFinding("Taboola", "t_gid")]))).toBeUndefined();
  });

  it("does not appear when the list names no owner for the site", () => {
    expect(notice(yahoo("www.example.com", [cookieFinding("Taboola", "t_gid")]))).toBeUndefined();
  });
});

describe("what the count left out, in the vendor panel (1.18.0)", () => {
  it("shows a vendor's probe cookies and refused writes", () => {
    const v = build(
      obs({
        tallies: {
          ...EMPTY_TALLIES,
          totalRequests: 5,
          probeCookies: { Criteo: ["cto_tld_test"] },
          refusedCookieWrites: { Criteo: ["cto_bidid (.com)"] },
          byEntity: { Criteo: { requests: 1, signedRequests: 1, cookieNames: ["uid"], cookiesReturned: [], hosts: [] } },
        },
      }),
      [cookieFinding("Criteo", "uid")],
    );
    const d = v.vendors.find((r) => r.name === "Criteo")?.detail;
    expect(d?.probeCookies).toEqual(["cto_tld_test"]);
    expect(d?.refusedWrites).toEqual(["cto_bidid (.com)"]);
  });

  it("shows neither for a capture from before the fields", () => {
    const d = build(obs(), [cookieFinding("Criteo", "uid")]).vendors[0]?.detail;
    expect(d?.probeCookies).toEqual([]);
    expect(d?.refusedWrites).toEqual([]);
  });
});

describe("the vendor panel's cookie list", () => {
  it("says how long a cookie lasts, in minutes and hours under a day", () => {
    // Rounded to days, a cookie with under twelve hours to run would read "expired": __cf_bm,
    // which lasts thirty minutes, on the rows the functional label is for.
    const lasting = (name: string, ms: number | "session") => ({
      id: name, url: "https://static.criteo.net/js/ld/publishertag.js", method: "GET", resourceType: "script",
      initiator: null, secGpcPresent: true, cookiesSent: [], requestHeaders: [], statusCode: 200,
      responseHeaders: null, isRedirectHop: false, captureMethod: "onHeadersReceived", timeMs: Date.now(),
      setCookies: [{
        name, value: "", domain: ".criteo.net", path: "/", expiresMs: ms === "session" ? ms : Date.now() + ms + 5_000,
        sameSite: "None", httpOnly: false, secure: true, partitioned: false, via: "onHeadersReceived",
      }],
    });
    const MIN = 60_000;
    const DAY = 24 * 60 * MIN;
    const v = buildPopupView({
      observations: obs({
        network: [
          lasting("half-hour", 30 * MIN), lasting("minute", 20_000), lasting("hours", 5 * 60 * MIN), lasting("days", 3 * DAY),
          lasting("months", 180 * DAY), lasting("year", 400 * DAY), lasting("session", "session"),
        ] as never,
      }),
      findings: [cookieFinding("Criteo", "half-hour")],
      distinctCookies: 1,
      adTechRequests: 5,
      classify: classifyWith([["criteo", "Criteo", "advertising"]]),
    });
    // In key order: the panel lists the tallies' cookie details (1.22.0), not the requests.
    // The words come from messages.json, as the renderer draws them.
    const messages: Readonly<Record<string, { message: string }>> = messagesJson;
    const drawn = (e: (typeof v.vendors)[number]["detail"]["cookies"][number]["expiry"]): string =>
      e === undefined ? "" : messages[e.key]!.message.replace("$COUNT$", e.substitution?.[0] ?? "");
    expect(Object.fromEntries(v.vendors[0]?.detail.cookies.map((c) => [c.name, drawn(c.expiry)]) ?? [])).toEqual({
      "half-hour": "30m", minute: "1m", hours: "5h", days: "3d", months: "6mo", year: "1y", session: "session",
    });
  });

  it("does not list a deletion as a cookie set", () => {
    // news-h.example, 2026-09-23: cto_tld_test and criteo_write_test are deletions. Under
    // Cookies set they would be listed as "expired", while the count rightly leaves them out.
    const net = (name: string, expiresMs: number | "session") => ({
      id: name, url: "https://static.criteo.net/js/ld/publishertag.js", method: "SCRIPT", resourceType: "other",
      initiator: null, secGpcPresent: true, cookiesSent: [], requestHeaders: [], statusCode: null,
      responseHeaders: null, isRedirectHop: false, captureMethod: "documentCookie", timeMs: 1_000,
      setCookies: [{ name, value: "", domain: ".example.com", path: "/", expiresMs, sameSite: "unspecified", httpOnly: false, secure: false, partitioned: false, via: "documentCookie" }],
    });
    const v = buildPopupView({
      observations: obs({ network: [net("cto_tld_test", 0), net("uid", "session")] as never }),
      findings: [cookieFinding("Criteo", "uid")],
      distinctCookies: 1,
      adTechRequests: 5,
      classify: classifyWith([["criteo", "Criteo", "advertising"]]),
    });
    expect(v.vendors[0]?.detail.cookies.map((c) => c.name)).toEqual(["uid"]);
  });

  it("names two cookies of one name by their domains, as the row does (#36)", () => {
    // Set for two hosts, and host-only against the whole domain: each its own line, with its
    // own attributes, so each line says which cookie it is. A name set once stays bare.
    const set = (name: string, domain: string, sameSite: string) => ({
      id: `${name}@${domain}`, url: "https://bidder.criteo.com/cdb", method: "GET", resourceType: "xmlhttprequest",
      initiator: null, secGpcPresent: true, cookiesSent: [], requestHeaders: [], statusCode: 200,
      responseHeaders: null, isRedirectHop: false, captureMethod: "onHeadersReceived", timeMs: 1_000,
      setCookies: [{ name, value: "x", domain, path: "/", expiresMs: "session", sameSite, httpOnly: false, secure: true, partitioned: false, via: "onHeadersReceived" }],
    });
    const v = buildPopupView({
      observations: obs({
        network: [
          set("uid", ".a.criteo.com", "None"),
          set("uid", ".b.criteo.com", "Lax"),
          set("sid", ".criteo.com", "None"),
          set("sid", "bidder.criteo.com", "Strict"),
          set("cto_bundle", ".criteo.com", "None"),
        ] as never,
      }),
      findings: [cookieFinding("Criteo", "uid")],
      distinctCookies: 5,
      adTechRequests: 5,
      classify: classifyWith([["criteo", "Criteo", "advertising"]]),
    });
    const cookies = v.vendors[0]?.detail.cookies ?? [];
    const lines = cookies.map((c) => [shownName(c, cookies), c.sameSite]);
    expect(lines).toEqual(expect.arrayContaining([
      ["uid (.a.criteo.com)", "None"],
      ["uid (.b.criteo.com)", "Lax"],
      ["sid (.criteo.com)", "None"],
      ["sid (bidder.criteo.com)", "Strict"],
      ["cto_bundle", "None"],
    ]));
    expect(lines).toHaveLength(5);
  });

  it("says how each cookie was set, a Set-Cookie header and a page script alike", () => {
    const set = (name: string, via: "onHeadersReceived" | "documentCookie" | "cookieStore") => {
      const header = via === "onHeadersReceived";
      return {
        id: name, url: "https://static.criteo.net/js/ld/publishertag.js", method: header ? "GET" : "SCRIPT",
        resourceType: header ? "script" : "other", initiator: null, secGpcPresent: true, cookiesSent: [], requestHeaders: [],
        statusCode: header ? 200 : null, responseHeaders: null, isRedirectHop: false, captureMethod: via, timeMs: 1_000,
        setCookies: [{
          name, value: "", domain: header ? ".criteo.net" : ".example.com", path: "/", expiresMs: "session",
          sameSite: "None", httpOnly: false, secure: true, partitioned: false, via,
        }],
      };
    };
    const v = buildPopupView({
      observations: obs({ network: [set("uid", "onHeadersReceived"), set("cto_bundle", "documentCookie"), set("cto_store", "cookieStore")] as never }),
      findings: [cookieFinding("Criteo", "uid")],
      distinctCookies: 1,
      adTechRequests: 5,
      classify: classifyWith([["criteo", "Criteo", "advertising"]]),
    });
    expect(Object.fromEntries(v.vendors[0]?.detail.cookies.map((c) => [c.name, c.viaKey]) ?? [])).toEqual({
      uid: "cookieViaHeader", cto_bundle: "cookieViaScript", cto_store: "cookieViaScript",
    });
  });

  it("calls every header capture Set-Cookie and every script write a page script", () => {
    expect(cookieViaKey("onHeadersReceived")).toBe("cookieViaHeader");
    expect(cookieViaKey("onResponseStarted")).toBe("cookieViaHeader");
    expect(cookieViaKey("documentCookie")).toBe("cookieViaScript");
    expect(cookieViaKey("cookieStore")).toBe("cookieViaScript");
    const messages: Readonly<Record<string, { message: string }>> = messagesJson;
    expect(messages["cookieViaHeader"]?.message).toBe("Set-Cookie");
    expect(messages["cookieViaScript"]?.message).toBe("page script");
  });

  it("lists a cookie that was removed again, counted as before, and says how long after", () => {
    // Google's test_cookie: set by one response and cleared by a later one. It was set
    // while the signal was on, so it is on the row and in the panel, marked removed.
    const K = (name: string, domain: string): string => `${name}\u0000${domain}`;
    const detail = (removedAfterMs?: number) => ({
      expiresMs: Date.now() + 900_000, sameSite: "None" as const, secure: true, partitioned: false, via: "onHeadersReceived" as const,
      host: "googleads.g.doubleclick.net", onRedirect: false, onRedirectSigned: false, firstSignedObservationId: "t1",
      ...(removedAfterMs === undefined ? {} : { removedAfterMs }),
    });
    const keys = [K("IDE", ".doubleclick.net"), K("test_cookie", ".doubleclick.net")];
    const v = buildPopupView({
      observations: obs({
        tallies: {
          ...EMPTY_TALLIES,
          totalRequests: 9,
          signedRequests: 9,
          adVendorRequests: 4,
          adCookieEvents: 2,
          adCookieKeys: keys,
          adCookieCategories: Object.fromEntries(keys.map((k) => [k, "advertising" as const])),
          adCookieEntities: Object.fromEntries(keys.map((k) => [k, "Google"])),
          byEntity: { Google: { requests: 4, signedRequests: 4, cookieNames: ["IDE", "test_cookie"], cookiesReturned: [], hosts: ["googleads.g.doubleclick.net"] } },
          cookieDetails: { [keys[0]!]: detail(), [keys[1]!]: detail(2_051) },
        },
      }),
      findings: [cookieFinding("Google", "IDE"), cookieFinding("Google", "test_cookie")],
      distinctCookies: 2,
      adTechRequests: 4,
      classify: classifyWith([["doubleclick", "Google", "advertising"]]),
    });
    expect(v.cookieCount).toBe(2);
    expect(v.vendors[0]?.cookies).toEqual(["IDE", "test_cookie"]);
    expect(v.vendors[0]?.detail.cookies.map((c) => [c.name, c.removed ?? null])).toEqual([
      ["IDE", null],
      ["test_cookie", { key: "cookieRemovedAfterSeconds", substitution: ["2"] }],
    ]);
  });

  it("words how long after its set a cookie was removed, with no number under a second", () => {
    expect(cookieRemoved(0)).toEqual({ key: "cookieRemovedAtOnce" });
    expect(cookieRemoved(400)).toEqual({ key: "cookieRemovedAtOnce" });
    expect(cookieRemoved(3_200)).toEqual({ key: "cookieRemovedAfterSeconds", substitution: ["3"] });
    expect(cookieRemoved(59_400)).toEqual({ key: "cookieRemovedAfterSeconds", substitution: ["59"] });
    expect(cookieRemoved(12 * 60_000)).toEqual({ key: "cookieRemovedAfterMinutes", substitution: ["12"] });
    expect(cookieRemoved(2 * 3_600_000)).toEqual({ key: "cookieRemovedAfterHours", substitution: ["2"] });
    const messages: Readonly<Record<string, { message: string }>> = messagesJson;
    expect(messages["cookieRemovedAtOnce"]?.message).toBe("removed within 1s");
    expect(messages["cookieRemovedAfterSeconds"]?.message).toBe("removed after $COUNT$s");
    expect(messages["cookieRemovedAfterMinutes"]?.message).toBe("removed after $COUNT$m");
    expect(messages["cookieRemovedAfterHours"]?.message).toBe("removed after $COUNT$h");
    // The write-test strings give no length of time: a test is one task of the page.
    expect(messages["hintProbeCookies"]?.message).not.toMatch(/second|moment/i);
  });
});

describe("listed as functional", () => {
  // A load balancer or a bot-protection service sets its own cookie on a vendor's host. The
  // cookie is counted, and labeled by its name. Never excluded: values are never read, and a
  // name is a string any vendor can reuse.
  const K = (name: string, domain: string): string => `${name}\u0000${domain}`;
  const LISTED = new Set(["akaalb_Instance-1", "__cf_bm", "AWSALB"]);
  const isListedFunctional = (name: string): boolean => LISTED.has(name);
  const classify = classifyWith([
    ["rokt", "Rokt", "advertising"],
    ["demdex", "Adobe", "advertising"],
    ["lightboxcdn", "Digioh", "analytics"],
    ["cookielaw", "OneTrust", "consent-managers"],
  ]);
  const counted: [string, string, "advertising" | "analytics"][] = [
    [K("akaalb_Instance-1", "apps.rokt.com"), "Rokt", "advertising"],
    [K("demdex", ".demdex.net"), "Adobe", "advertising"],
    [K("__cf_bm", ".lightboxcdn.com"), "Digioh", "analytics"],
    [K("__cf_bm", ".other.example"), "Digioh", "analytics"],
  ];
  const net = (url: string, cookies: [string, string][]) => ({
    id: url, url, method: "GET", resourceType: "script", initiator: null, secGpcPresent: true, cookiesSent: [], requestHeaders: [],
    statusCode: 200, responseHeaders: null, isRedirectHop: false, captureMethod: "onHeadersReceived" as const, timeMs: 1_000,
    setCookies: cookies.map(([name, domain]) => ({
      name, value: "", domain, path: "/", expiresMs: "session" as const, sameSite: "None" as const, httpOnly: false, secure: true, partitioned: false, via: "onHeadersReceived" as const,
    })),
  });
  /** `null` for a caller that supplies no list: `undefined` would take the default. */
  const page = (listed: ((name: string) => boolean) | null = isListedFunctional) =>
    buildPopupView({
      observations: obs({
        network: [
          net("https://apps.rokt.com/wsdk/integrations/launcher.js", [["akaalb_Instance-1", "apps.rokt.com"]]),
          net("https://dpm.demdex.net/id", [["demdex", ".demdex.net"]]),
          net("https://cdn.cookielaw.org/otSDKStub.js", [["__cf_bm", ".cookielaw.org"]]),
        ] as never,
        tallies: {
          ...EMPTY_TALLIES,
          totalRequests: 20,
          adCookieKeys: counted.map(([k]) => k),
          adCookieEntities: Object.fromEntries(counted.map(([k, e]) => [k, e])),
          adCookieCategories: Object.fromEntries(counted.map(([k, , c]) => [k, c])),
          byEntityCategory: summaries(
            summary("Rokt", "advertising", { hosts: ["apps.rokt.com"] }),
            summary("Adobe", "advertising", { hosts: ["dpm.demdex.net"] }),
            summary("Digioh", "analytics", { hosts: ["lightboxcdn.com"] }),
            summary("OneTrust", "consent-managers", { hosts: ["cdn.cookielaw.org"], cookieKeys: [K("__cf_bm", ".cookielaw.org")] }),
          ),
        },
      }),
      findings: [],
      distinctCookies: counted.length,
      adTechRequests: 9,
      classify,
      ...(listed ? { isListedFunctional: listed } : {}),
    });
  const row = (v: ReturnType<typeof page>, name: string) => v.vendors.find((r) => r.name === name);

  it("labels a counted cookie whose name is listed, and leaves it in the count", () => {
    const v = page();
    expect(row(v, "Rokt")).toMatchObject({ cookies: ["akaalb_Instance-1"], functionalCookies: ["akaalb_Instance-1"], counted: true });
    expect(row(v, "Adobe")).toMatchObject({ cookies: ["demdex"], functionalCookies: [] });
    // The number, the caption and the names under it are what they are without the list.
    const bare = page(null);
    expect(v.cookieCount).toBe(bare.cookieCount);
    expect(v.countCaption).toEqual(bare.countCaption);
    expect(v.countNames.map((n) => [n.name, n.cookies])).toEqual(bare.countNames.map((n) => [n.name, n.cookies]));
    expect(v.vendors.map((r) => [r.key, r.cookies, r.checkKey])).toEqual(bare.vendors.map((r) => [r.key, r.cookies, r.checkKey]));
  });

  it("labels the same names under the count", () => {
    expect(page().countNames.map((n) => [n.name, n.functionalCookies])).toEqual([
      ["Adobe", []],
      ["Rokt", ["akaalb_Instance-1"]],
      ["Digioh", ["__cf_bm (.lightboxcdn.com)", "__cf_bm (.other.example)"]],
    ]);
  });

  it("labels a name set on two domains under each, as it is shown", () => {
    expect(row(page(), "Digioh")).toMatchObject({
      cookies: ["__cf_bm (.lightboxcdn.com)", "__cf_bm (.other.example)"],
      functionalCookies: ["__cf_bm (.lightboxcdn.com)", "__cf_bm (.other.example)"],
    });
  });

  it("labels nothing on a row the headline does not count", () => {
    // The consent tool is behind Cloudflare too. Its __cf_bm is listed, and not counted:
    // "still included in the count" would be false of it.
    const v = page();
    expect(row(v, "OneTrust")).toMatchObject({ cookies: ["__cf_bm"], functionalCookies: [], counted: false });
    expect(row(v, "OneTrust")?.detail.cookies.map((c) => [c.name, c.functional])).toEqual([["__cf_bm", false]]);
  });

  it("labels the cookie in the vendor's panel", () => {
    const v = page();
    expect(row(v, "Rokt")?.detail.cookies.map((c) => [c.name, c.functional])).toEqual([["akaalb_Instance-1", true]]);
    expect(row(v, "Adobe")?.detail.cookies.map((c) => [c.name, c.functional])).toEqual([["demdex", false]]);
  });

  it("labels a panel's cookie only where the headline counts it", () => {
    // The note says "still included in the count". With the signal on, a listed name set on a
    // request without it is in the panel, marked, and not in the count; with it off, that is
    // the cookie the count holds, and a signed one sent before it was switched off is not.
    const SIGNED = K("akaalb_Instance-1", "apps.rokt.com");
    const UNSIGNED = K("AWSALB", "apps.rokt.com");
    const rokt = (signal: "on" | "off") =>
      buildPopupView({
        observations: obs({
          ...(signal === "off" ? { signal: { source: "none" } as never } : {}),
          tallies: {
            ...EMPTY_TALLIES,
            totalRequests: 4,
            adCookieKeys: [SIGNED],
            adCookieKeysUnsigned: [UNSIGNED],
            adCookieEntities: { [SIGNED]: "Rokt", [UNSIGNED]: "Rokt" },
            adCookieCategories: { [SIGNED]: "advertising", [UNSIGNED]: "advertising" },
            byEntityCategory: summaries(summary("Rokt", "advertising", { hosts: ["apps.rokt.com"] })),
          },
        }),
        findings: [],
        distinctCookies: signal === "on" ? 1 : 0,
        distinctCookiesUnsigned: 1,
        adTechRequests: 4,
        classify,
        isListedFunctional,
      }).vendors.find((r) => r.name === "Rokt");
    const on = rokt("on");
    expect(on?.functionalCookies).toEqual(["akaalb_Instance-1"]);
    expect(on?.detail.cookies.map((c) => [c.name, c.unsigned === true, c.functional])).toEqual([
      ["AWSALB", true, false],
      ["akaalb_Instance-1", false, true],
    ]);
    const off = rokt("off");
    expect(off?.functionalCookies).toEqual(["AWSALB"]);
    expect(off?.detail.cookies.filter((c) => c.functional).map((c) => c.name)).toEqual(["AWSALB"]);
  });

  it("labels nothing where no list is supplied", () => {
    const v = page(null);
    expect(v.vendors.flatMap((r) => r.functionalCookies)).toEqual([]);
    // Digioh's two counted cookies have no request left in this capture and are listed by name.
    expect(v.vendors.flatMap((r) => r.detail.cookies.map((c) => c.functional))).toEqual([false, false, false, false, false]);
  });
});


describe("No company found for this domain (1.26.0)", () => {
  const classify = classifyWith([
    ["criteo", "Criteo", "advertising"],
    ["techcrunch", "Yahoo!", "unknown"],
  ], "retailer-d.example");
  const GPC_JS = "https://assets.retailer-d-static.example/gpc.js";
  const unlisted = (domain: string, over: Partial<import("@gpc-inspector/schema").UnlistedDomainTally> = {}): import("@gpc-inspector/schema").UnlistedDomainTally => ({
    domain, requests: 2, signedRequests: 2, hosts: [], resourceTypes: ["script"], cookieKeys: [], cookieKeysUnsigned: [],
    cookiesReturned: [], probeCookies: [], refusedWrites: [], scriptRan: true, scriptRanOutsideXhr: true,
    firstObservationId: null, executionObservationId: null, ...over,
  });
  const byDomain = (...all: import("@gpc-inspector/schema").UnlistedDomainTally[]) => Object.fromEntries(all.map((u) => [u.domain, u]));
  const domainFinding = (domain: string, flag: Finding["flag"], artifact: Finding["artifact"] = { kind: "tally" }): Finding => ({
    flag, rank: 41, entity: { name: domain, domains: [domain], unlisted: true }, artifact,
  });
  const tallies = (withDomains = true) => ({
    ...EMPTY_TALLIES,
    adCookieKeys: ["uid\u0000.criteo.com"],
    adCookieEntities: { "uid\u0000.criteo.com": "Criteo" },
    adCookieCategories: { "uid\u0000.criteo.com": "advertising" },
    byEntityCategory: summaries(summary("Criteo", "advertising", { hosts: ["static.criteo.net"] }), summary("Yahoo!", "unknown", { hosts: ["techcrunch.com"] })),
    ...(withDomains
      ? {
          byUnlistedDomain: byDomain(
            unlisted("retailer-d-static.example", {
              hosts: ["assets.retailer-d-static.example"],
              cookieKeys: ["RTD_SESSION\u0000.retailer-d.example", "AMCV_E27100000000000000000000%40AdobeOrg\u0000.retailer-d.example"],
              cookieKeysUnsigned: ["edge_route\u0000.retailer-d.example"],
              probeCookies: ["__tld__"],
              capped: true,
            }),
            unlisted("chatco.io", { hosts: ["widget.chatco.io"], probeCookies: ["chat_cookie_check"] }),
            unlisted("survey.net", { hosts: ["cdn.survey.net"], refusedWrites: ["survey_uid (.com)"] }),
            // Only contacted: no row.
            unlisted("quiet.net", { hosts: ["img.quiet.net"], resourceTypes: ["image"], scriptRan: false }),
            // Only an unsigned cookie while the signal was on: a row, as a company's.
            unlisted("offline.io", { hosts: ["x.offline.io"], cookieKeysUnsigned: ["o\u0000.offline.io"] }),
          ),
        }
      : {}),
  });
  const findings = (): Finding[] => [
    cookieFinding("Criteo", "uid"),
    pairFinding("Criteo", "advertising", "vendor-did-not-read-gpc"),
    pairFinding("Yahoo!", "unknown", "vendor-no-script-observed"),
    domainFinding("retailer-d-static.example", "vendor-read-gpc", { kind: "signal-read", readCount: 9 }),
    domainFinding("chatco.io", "vendor-did-not-read-gpc", {
      kind: "tally",
      loadedVia: [{ kind: "container", identity: { manager: "gtm", id: "GTM-A" }, ancestors: [], mixed: false }],
    }),
    domainFinding("survey.net", "vendor-did-not-read-gpc"),
    domainFinding("quiet.net", "vendor-no-script-observed"),
    domainFinding("offline.io", "vendor-did-not-read-gpc"),
  ];
  const page = (o: Partial<ObservationSet> = {}, f: Finding[] = findings(), withDomains = true) =>
    buildPopupView({
      observations: obs({
        context: { finalUrl: "https://www.retailer-d.example/", topSite: "retailer-d.example" } as never,
        signal: {
          readTracking: "active", readCount: 12,
          readsByScript: { [GPC_JS]: 9, "https://cdn.quiet.net/q.js": 3 },
          readAttribution: { sampled: 12, unattributed: 0, viaTagManager: 0 },
        } as never,
        tallies: tallies(withDomains) as never,
        ...o,
      }),
      findings: f,
      distinctCookies: 1,
      adTechRequests: 5,
      classify,
    });
  const rowsOf = (v: ReturnType<typeof page>) => v.vendors.filter((r) => r.group === "unlisted");

  it("marks sent back only a cookie the domain's hosts could receive", () => {
    const t = tallies();
    const survey = unlisted("survey.net", {
      hosts: ["cdn.survey.net"],
      cookieKeys: ["svid\u0000.survey.net", "svid\u0000.retailer-d.example"],
      cookiesReturned: ["svid"],
    });
    const v = page({ tallies: { ...t, byUnlistedDomain: { ...t.byUnlistedDomain, "survey.net": survey } } as never });
    const cookies = rowsOf(v).find((r) => r.name === "survey.net")?.detail.cookies ?? [];
    expect(cookies.map((c) => [c.domain, c.sentBack])).toEqual([[".retailer-d.example", false], [".survey.net", true]]);
  });

  it("names two cookies of one name by their domains in a domain's panel (#36)", () => {
    const t = tallies();
    const survey = unlisted("survey.net", {
      hosts: ["cdn.survey.net"],
      cookieKeys: ["svid\u0000.survey.net", "svid\u0000cdn.survey.net", "once\u0000.survey.net"],
      cookiesReturned: [],
    });
    const v = page({ tallies: { ...t, byUnlistedDomain: { ...t.byUnlistedDomain, "survey.net": survey } } as never });
    const cookies = rowsOf(v).find((r) => r.name === "survey.net")?.detail.cookies ?? [];
    expect(cookies.map((c) => shownName(c, cookies))).toEqual(["once", "svid (.survey.net)", "svid (cdn.survey.net)"]);
  });

  it("puts one row per domain in a last group, after Uncategorized", () => {
    const v = page();
    expect(v.vendors.map((r) => [r.name, r.group ?? r.category])).toEqual([
      ["Criteo", "advertising"],
      ["Yahoo!", "unknown"],
      ["retailer-d-static.example", "unlisted"],
      ["chatco.io", "unlisted"],
      ["offline.io", "unlisted"],
      ["survey.net", "unlisted"],
    ]);
    for (const r of rowsOf(v)) expect(r).toMatchObject({ counted: false, functionalCookies: [] });
  });

  it("gives each row the engine's state for its domain, and its help", () => {
    const v = page();
    const state = Object.fromEntries(rowsOf(v).map((r) => [r.name, [r.checkKey, r.checkHelp.key]]));
    expect(state).toEqual({
      "retailer-d-static.example": ["vendorGpcReadProperty", "vendorGpcReadPropertyHelpDomain"],
      "chatco.io": ["vendorGpcNotRead", "vendorGpcNotReadHelpDomain"],
      "survey.net": ["vendorGpcNotRead", "vendorGpcNotReadHelpDomain"],
      "offline.io": ["vendorGpcNotRead", "vendorGpcNotReadHelpDomain"],
    });
    for (const r of rowsOf(v)) expect(r.checkKey).not.toBe("vendorGpcUnlistedDomain");
  });

  it("says 'this domain' in a loader-route help and its ordering sentence, 'this tag' after a container", () => {
    const loader = (l: unknown) =>
      domainFinding("survey.net", "vendor-gpc-check-unattributable", { kind: "vendor-check-loader", loader: l, route: "loader", checkedBeforeLoad: true, containerCallCount: 1, consentModeActive: false } as never);
    const help = (l: unknown) => rowsOf(page({}, [...findings().filter((x) => x.entity?.name !== "survey.net"), loader(l)])).find((r) => r.name === "survey.net")?.checkHelp;
    expect(help({ kind: "entity", name: "Prebid" })).toEqual({
      key: "vendorGpcCheckUnattributableHelpVendorDomain", substitution: ["Prebid"], orderKey: "vendorGpcCheckOrderBeforeDomain",
    });
    // About what a container loaded: the same sentence on a company row and a domain row.
    expect(help({ kind: "container", identity: { manager: "gtm", id: "GTM-A" }, ancestors: [], mixed: false })).toEqual({
      key: "vendorGpcCheckUnattributableHelpContainer", substitution: ["GTM-A"], orderKey: "vendorGpcCheckOrderBefore",
    });
  });

  it("names who loaded a domain, from its own finding", () => {
    const chat = rowsOf(page()).find((r) => r.name === "chatco.io");
    expect(chat?.loadedVia).toEqual({ parts: [{ key: "vendorLoadedViaGtm", substitution: ["GTM-A"] }] });
    expect(chat?.detail.loadedVia).toEqual([{ parts: [{ key: "vendorLoadedViaGtm", substitution: ["GTM-A"] }] }]);
    expect(rowsOf(page()).find((r) => r.name === "survey.net")?.detail.loadedVia).toEqual([]);
  });

  it("names who loaded a row that read GPC, a domain's or a company's", () => {
    const site = [{ kind: "site" as const, url: null }];
    const v = page({}, [
      ...findings().filter((f) => f.entity?.name !== "retailer-d-static.example" && f.entity?.name !== "Criteo"),
      cookieFinding("Criteo", "uid"),
      domainFinding("retailer-d-static.example", "vendor-read-gpc", { kind: "signal-read", readCount: 9, loadedVia: site }),
      pairFinding("Criteo", "advertising", "vendor-read-gpc", { kind: "consent-api", api: "__gpp", callCount: 1, loadedVia: site }),
    ]);
    const line = { parts: [{ key: "vendorLoadedBySite" }] };
    expect(v.vendors.find((r) => r.name === "retailer-d-static.example")).toMatchObject({ checkKey: "vendorGpcReadProperty", loadedVia: line, detail: { loadedVia: [line] } });
    expect(v.vendors.find((r) => r.name === "Criteo")).toMatchObject({ loadedVia: line, detail: { loadedVia: [line] } });
  });

  it("reads 'cookies set and removed' for a probe, and 'no cookies set' for a write not stored", () => {
    const rows = rowsOf(page());
    const chat = rows.find((r) => r.name === "chatco.io");
    const survey = rows.find((r) => r.name === "survey.net");
    expect(chat).toMatchObject({ cookies: [], emptyKey: "vendorCookiesSetAndRemoved" });
    expect(survey?.cookies).toEqual([]);
    expect(survey).not.toHaveProperty("emptyKey");
    // A row with names never takes the line, though it also had a probe.
    expect(rows.find((r) => r.name === "retailer-d-static.example")).not.toHaveProperty("emptyKey");
  });

  it("lists the signed cookies on the row, and both in the panel, the unsigned marked", () => {
    const rtd = rowsOf(page()).find((r) => r.name === "retailer-d-static.example");
    expect(rtd?.cookies).toEqual(["AMCV_E27100000000000000000000%40AdobeOrg", "RTD_SESSION"]);
    expect(rtd?.detail.cookies.map((c) => [c.name, c.unsigned === true])).toEqual([
      ["AMCV_E27100000000000000000000%40AdobeOrg", false],
      ["RTD_SESSION", false],
      ["edge_route", true],
    ]);
    expect(rtd?.detail.cookiesCapped).toBe(true);
    expect(rtd?.detail.probeCookies).toEqual(["__tld__"]);
  });

  it("marks nothing unsigned with sending off", () => {
    const v = page({ signal: { source: "none", propertyValue: false, readTracking: "active", readCount: 0, readsByScript: {} } as never });
    const rtd = rowsOf(v).find((r) => r.name === "retailer-d-static.example");
    expect(rtd?.cookies).toEqual(["edge_route"]);
    expect(rtd?.detail.cookies.some((c) => c.unsigned === true)).toBe(false);
    // The panel lists what the row is built from: the signed ones were set before sending
    // was switched off.
    expect(rtd?.detail.cookies.map((c) => c.name)).toEqual(["edge_route"]);
  });

  it("with sending off, gives a domain that read GPC and has only signed cookies a row whose panel lists none", () => {
    // Its cookie was set on a request that carried the signal, before sending was switched
    // off: the row says no cookies, and the panel must not list one under it.
    const t = tallies();
    const quiet = { ...t.byUnlistedDomain!["quiet.net"]!, cookieKeys: ["q\u0000.quiet.net"] };
    const f = [...findings().filter((x) => x.entity?.name !== "quiet.net"), domainFinding("quiet.net", "vendor-read-gpc", { kind: "signal-read", readCount: 3 })];
    const off = { source: "none", propertyValue: false, readTracking: "active", readCount: 0, readsByScript: {} } as never;
    const v = page({ signal: off, tallies: { ...t, byUnlistedDomain: { ...t.byUnlistedDomain, "quiet.net": quiet } } as never }, f);
    const row = rowsOf(v).find((r) => r.name === "quiet.net");
    expect(row).toMatchObject({ cookies: [] });
    expect(row?.detail.cookies).toEqual([]);
  });

  it("marks a vendor panel's cookie set on a request without GPC", () => {
    const t = { ...tallies(false), adCookieKeysUnsigned: ["anon\u0000.criteo.com"], adCookieEntities: { "uid\u0000.criteo.com": "Criteo", "anon\u0000.criteo.com": "Criteo" }, adCookieCategories: { "uid\u0000.criteo.com": "advertising", "anon\u0000.criteo.com": "advertising" } };
    const criteo = page({ tallies: t as never }, findings(), false).vendors.find((r) => r.name === "Criteo");
    expect(criteo?.cookies).toEqual(["uid"]);
    expect(criteo?.detail.cookies.map((c) => [c.name, c.unsigned === true])).toEqual([["anon", true], ["uid", false]]);
  });

  it("leaves the headline and the names under it as they were", () => {
    const withDomains = page();
    const without = page({}, findings().filter((f) => f.entity?.unlisted !== true), false);
    expect(withDomains.countCaption).toEqual(without.countCaption);
    expect(withDomains.countNames).toEqual(without.countNames);
    expect(withDomains.vendors.filter((r) => r.group === undefined)).toEqual(without.vendors);
  });

  it("builds the rows from the summaries, with the request list gone", () => {
    expect(rowsOf(page({ network: [] })).map((r) => r.name)).toEqual(["retailer-d-static.example", "chatco.io", "offline.io", "survey.net"]);
  });

  it("gives a domain whose only cookies were set without the signal a row, and says so on it", () => {
    const off = rowsOf(page()).find((r) => r.name === "offline.io");
    expect(off).toMatchObject({ cookies: [], emptyKey: "vendorCookiesWithoutGpc" });
    expect(off?.detail.cookies.map((c) => [c.name, c.unsigned === true])).toEqual([["o", true]]);
  });

  it("says the same on a company's row whose only cookies were set without the signal", () => {
    const UNSIGNED = "uid2\u0000.criteo.com";
    const v = page({ tallies: { ...tallies(), adCookieKeys: [], adCookieKeysUnsigned: [UNSIGNED], adCookieEntities: { [UNSIGNED]: "Criteo" }, adCookieCategories: { [UNSIGNED]: "advertising" } } as never });
    expect(v.vendors.find((r) => r.name === "Criteo")).toMatchObject({ cookies: [], emptyKey: "vendorCookiesWithoutGpc" });
  });

  it("names a domain with a row in the GPC read rows, and keeps one without in Also scripts from", () => {
    const v = page();
    const rows = readRows(v).rows;
    expect(rows[0]?.lines?.[0]?.list).toEqual([{ text: "retailer-d-static.example", domain: true }]);
    expect(readRows(v).no).toEqual(["chatco.io", "Criteo [advertising]", "offline.io", "survey.net"]);
    expect(rows[1]?.lines?.[0]?.list?.find((i) => i.text === "chatco.io")).toEqual({ text: "chatco.io", domain: true });
    expect(readHint(v, "hintCheckedOtherDomains")?.list?.map((i) => i.text)).toEqual(["quiet.net"]);
  });

  it("gives a domain whose script read GPC and set nothing a row, and takes it out of Also scripts from", () => {
    const f = [...findings().filter((x) => x.entity?.name !== "quiet.net"), domainFinding("quiet.net", "vendor-read-gpc", { kind: "signal-read", readCount: 3 })];
    const v = page({}, f);
    expect(rowsOf(v).find((r) => r.name === "quiet.net")).toMatchObject({ cookies: [], checkKey: "vendorGpcReadProperty", counted: false });
    expect(rowsOf(v).find((r) => r.name === "quiet.net")).not.toHaveProperty("emptyKey");
    expect(readRows(v).yes).toEqual(["quiet.net", "retailer-d-static.example"]);
    expect(readHint(v, "hintCheckedOtherDomains")).toBeUndefined();
    // Any other state for a domain that set nothing is no row: it was only contacted.
    expect(rowsOf(page()).some((r) => r.name === "quiet.net")).toBe(false);
  });

  it("does not give a company a domain's finding of the same name", () => {
    const v = page({}, [...findings(), domainFinding("Criteo", "vendor-read-gpc", { kind: "signal-read", readCount: 1 })]);
    expect(v.vendors.find((r) => r.name === "Criteo")?.checkKey).toBe("vendorGpcNotRead");
  });

  it("never names a vendor in a domain row's help, and never says it is counted", () => {
    const messages = messagesJson as unknown as Record<string, { message: string }>;
    const v = page({}, [
      ...findings().filter((f) => f.entity?.name !== "survey.net" && f.entity?.name !== "chatco.io"),
      domainFinding("chatco.io", "vendor-no-script-observed"),
      // survey.net has no finding here: nothing the engine judges it on was kept.
    ]);
    const help = Object.fromEntries(rowsOf(v).map((r) => [r.name, [r.checkKey, r.checkHelp.key]]));
    expect(help["chatco.io"]).toEqual(["vendorGpcNotApplicable", "vendorGpcNotApplicableHelpDomain"]);
    expect(help["survey.net"]).toEqual(["vendorGpcCheckUnavailable", "vendorGpcCheckUnavailableHelpDomain"]);
    for (const r of rowsOf(v)) {
      const text = messages[r.checkHelp.key]?.message ?? "";
      expect(text, r.checkHelp.key).not.toBe("");
      expect(text, r.checkHelp.key).not.toMatch(/vendor|in the count/i);
    }
    // A company's row keeps the vendor's sentence.
    expect(v.vendors.find((r) => r.name === "Yahoo!")?.checkHelp.key).toBe("vendorGpcNotApplicableHelp");
  });

  it("says the extension's own cap left a domain's requests out, and asks for no refresh", () => {
    const t = tallies();
    const capped = { ...t.byUnlistedDomain!["survey.net"]!, requests: 0, signedRequests: 0, scriptRan: false, requestsCapped: true as const };
    const v = page({ tallies: { ...t, byUnlistedDomain: { ...t.byUnlistedDomain, "survey.net": capped } } as never }, findings().filter((f) => f.entity?.name !== "survey.net"));
    const survey = rowsOf(v).find((r) => r.name === "survey.net");
    expect(survey).toMatchObject({ checkKey: "vendorGpcCheckUnavailable", checkHelp: { key: "vendorGpcCheckUnavailableHelpDomainCapped" } });
    const messages = messagesJson as unknown as Record<string, { message: string }>;
    expect(messages.vendorGpcCheckUnavailableHelpDomainCapped?.message).not.toMatch(/vendor|refresh/i);
  });

  it("shows no group for a capture from before the summary", () => {
    expect(rowsOf(page({}, findings(), false))).toEqual([]);
  });
});

describe("First-party cookies (1.26.0)", () => {
  const classify = classifyWith([["metrics.example.com", "Example Metrics", "analytics"]], "example.com");
  const K = (name: string, domain = ".example.com") => `${name}\u0000${domain}`;
  type Tally = import("@gpc-inspector/schema").FirstPartyTally;
  const NONE: Tally = { cookieKeys: [], cookieKeysUnsigned: [], vendorCookieKeysUnsigned: [] };
  const off = { signal: { source: "none", propertyValue: false, readTracking: "active", readCount: 0, readsByScript: {} } as never };
  const page = (firstParty: Tally | undefined, over: Partial<ObservationSet> = {}, tallies: object = {}) =>
    buildPopupView({
      observations: obs({
        ...over,
        context: { finalUrl: "https://www.example.com/news", topSite: "www.example.com", ...over.context } as never,
        tallies: { ...EMPTY_TALLIES, firstPartyVendorCookieKeys: [K("_m")], ...tallies, ...(firstParty ? { firstParty } : {}) } as never,
      }),
      findings: [],
      distinctCookies: 0,
      adTechRequests: 0,
      firstPartyVendorCookies: 1,
      classify,
    });
  const lists = (over: Partial<Tally> = {}): Tally => ({
    cookieKeys: [K("session"), K("prefs"), K("pref", "www.example.com"), K("pref")], cookieKeysUnsigned: [K("off")], vendorCookieKeysUnsigned: [K("_m_off")], ...over,
  });
  const full = (prefix: string) => Array.from({ length: 200 }, (_, i) => K(`${prefix}${i}`));

  it("lists a key known only from a lost request in the second list, marked, and not as unsigned", () => {
    const v = page(lists({ cookieKeysRequestLost: [K("late"), K("session")] }));
    expect(v.firstParty?.site).toContain("late");
    expect(v.firstParty?.requestLost).toEqual(["late"]);
    expect(v.firstParty?.unsigned).not.toContain("late");
    // Drawn for a lost key alone.
    expect(page({ ...NONE, cookieKeysRequestLost: [K("late")] }, {}, { firstPartyVendorCookieKeys: [] }).firstParty).toMatchObject({ site: ["late"], requestLost: ["late"] });
  });

  it("names the site's registrable domain and both lists, signed and unsigned, one entry per key", () => {
    expect(page(lists()).firstParty).toEqual({
      domain: "example.com",
      vendorWritten: ["_m", "_m_off"],
      site: ["off", "pref (.example.com)", "pref (www.example.com)", "prefs", "session"],
      unsigned: ["_m_off", "off"],
      requestLost: [],
      scriptWritesObserved: true,
      probeCookies: [],
      vendorCapped: false,
      siteCapped: false,
    });
    // The domain is the top site's, the one the worker measured first party against.
    expect(page(lists(), { context: { finalUrl: "" } as never }).firstParty?.domain).toBe("example.com");
  });

  it("lists a key the site also set once, under the script that wrote it", () => {
    expect(page(lists({ cookieKeys: [K("_m"), K("session")] })).firstParty?.site).toEqual(["off", "session"]);
  });

  it("lists a key a third party is counted for under that third party only", () => {
    const v = page(lists({ cookieKeys: [K("_ga"), K("session")] }), {}, { adCookieKeys: [K("_ga"), K("_m")], adCookieKeysUnsigned: [K("off")] });
    expect(v.firstParty).toMatchObject({ vendorWritten: ["_m_off"], site: ["session"] });
  });

  it("marks a name set only without the signal while it was on, and none with sending off", () => {
    // Set with the signal as well: not marked.
    expect(page(lists({ cookieKeysUnsigned: [K("off"), K("session")] })).firstParty?.unsigned).toEqual(["_m_off", "off"]);
    expect(page(lists(), off).firstParty).toMatchObject({ vendorWritten: ["_m", "_m_off"], unsigned: [] });
  });

  it("adds the domain to one name set on two domains across both lists", () => {
    const v = page({ ...NONE, cookieKeys: [K("_m", "www.example.com")] });
    expect(v.firstParty).toMatchObject({ vendorWritten: ["_m (.example.com)"], site: ["_m (www.example.com)"] });
  });

  it("keeps an empty list, and puts the cap note on the list that was full", () => {
    const capped = page({ ...NONE, cookieKeys: full("s"), capped: true }, {}, { firstPartyVendorCookieKeys: [] });
    expect(capped.firstParty).toMatchObject({ vendorWritten: [], vendorCapped: false, siteCapped: true });
    // One flag covers both unsigned lists: the list at the cap is the one.
    expect(page({ ...NONE, vendorCookieKeysUnsigned: full("v"), cappedUnsigned: true }).firstParty).toMatchObject({ vendorCapped: true, siteCapped: false });
    expect(page({ ...NONE, cookieKeysUnsigned: full("u"), cappedUnsigned: true }, off).firstParty).toMatchObject({ vendorCapped: false, siteCapped: true });
    // Neither at the cap (a probe taken out since): the note still shows, on the site's list.
    expect(page({ ...NONE, cappedUnsigned: true }).firstParty).toMatchObject({ vendorCapped: false, siteCapped: true });
    // With neither list holding a name there is nothing to draw.
    expect(page(NONE, {}, { firstPartyVendorCookieKeys: [] }).firstParty).toBeUndefined();
  });

  it("says the first list could not be observed when script writes were not", () => {
    const v = page({ ...NONE, cookieKeys: [K("session")] }, { capabilities: { documentCookie: false } as never }, { firstPartyVendorCookieKeys: [] });
    expect(v.firstParty).toMatchObject({ vendorWritten: [], site: ["session"], scriptWritesObserved: false });
    expect(page(lists(), { capabilities: { cookieStore: false } as never }).firstParty?.scriptWritesObserved).toBe(false);
  });

  it("names the site's probes, and draws the section for them alone", () => {
    expect(page({ ...lists({ cookieKeys: [] }), probeCookies: ["test_cookie"] }).firstParty?.probeCookies).toEqual(["test_cookie"]);
    const only = page({ ...NONE, probeCookies: ["test_cookie"] }, {}, { firstPartyVendorCookieKeys: [] });
    expect(only.firstParty).toEqual({
      domain: "example.com",
      vendorWritten: [],
      site: [],
      unsigned: [],
      requestLost: [],
      scriptWritesObserved: true,
      probeCookies: ["test_cookie"],
      vendorCapped: false,
      siteCapped: false,
    });
  });

  it("leaves the headline's line out where the section names its cookies", () => {
    expect(page(lists()).firstPartyVendorCookies).toBe(0);
  });

  it("is absent for a capture from before the summary, which keeps the headline's line", () => {
    const v = page(undefined);
    expect(v.firstParty).toBeUndefined();
    expect(v.firstPartyVendorCookies).toBe(1);
  });
});

describe("a cookie whose request was lost (1.26.0)", () => {
  const classify = classifyWith([["doubleclick", "Google", "advertising"]], "example.com");
  const LOST = "late_id\u0000.doubleclick.net";
  const page = (over: Partial<import("@gpc-inspector/schema").Tallies> = {}) =>
    buildPopupView({
      observations: obs({
        tallies: {
          ...EMPTY_TALLIES,
          byEntityCategory: summaries(summary("Google", "advertising", { hosts: ["ads.doubleclick.net"], cookieKeysRequestLost: [LOST] })),
          cookieDetails: { [LOST]: { expiresMs: "session", sameSite: "None", secure: true, partitioned: false, via: "onHeadersReceived", host: "ads.doubleclick.net", onRedirect: false, onRedirectSigned: false, firstSignedObservationId: null, requestLost: true } },
          ...over,
        } as never,
      }),
      findings: [pairFinding("Google", "advertising", "vendor-did-not-read-gpc")],
      distinctCookies: 0,
      adTechRequests: 1,
      classify,
      isListedFunctional: () => true,
    });

  it("lists it in the panel, marked, and not on the row or under the count", () => {
    const v = page();
    const google = v.vendors.find((r) => r.name === "Google");
    expect(google).toMatchObject({ cookies: [], functionalCookies: [], emptyKey: "vendorCookiesRequestLost" });
    expect(google?.detail.cookies).toEqual([
      expect.objectContaining({ name: "late_id", requestLost: true, functional: false }),
    ]);
    expect(google?.detail.cookies[0]).not.toHaveProperty("unsigned");
    expect(v.countNames).toEqual([]);
    expect(v.cookieCount).toBe(0);
  });

  it("lists a key also set on an observed request once, as that set", () => {
    // The observed set cleared the detail's mark, as the tally does.
    const detail = { expiresMs: "session", sameSite: "None", secure: true, partitioned: false, via: "onHeadersReceived", host: "ads.doubleclick.net", onRedirect: false, onRedirectSigned: false, firstSignedObservationId: "r1" } as const;
    const google = page({ adCookieKeys: [LOST], adCookieEntities: { [LOST]: "Google" }, adCookieCategories: { [LOST]: "advertising" }, cookieDetails: { [LOST]: detail } }).vendors.find((r) => r.name === "Google");
    expect(google?.cookies).toEqual(["late_id"]);
    expect(google?.detail.cookies.filter((c) => c.name === "late_id")).toHaveLength(1);
    expect(google?.detail.cookies[0]).not.toHaveProperty("requestLost");
    expect(google).not.toHaveProperty("emptyKey");
  });

  it("leaves out a key an observed set under another row cleared, one rule for every panel", () => {
    const cleared = { expiresMs: "session", sameSite: "None", secure: true, partitioned: false, via: "onHeadersReceived", host: "www.doubleclick.net", onRedirect: false, onRedirectSigned: false, firstSignedObservationId: null } as const;
    const google = page({ totalRequests: 3, cookieDetails: { [LOST]: cleared } }).vendors.find((r) => r.name === "Google");
    expect(google?.detail.cookies).toEqual([]);
    expect(google).not.toHaveProperty("emptyKey");
  });

  it("reads 'cookies set, request lost' only when every cookie its panel lists came that way", () => {
    const UNSIGNED = "ar_debug\u0000.doubleclick.net";
    const google = page({ totalRequests: 3, adCookieKeysUnsigned: [UNSIGNED], adCookieEntities: { [UNSIGNED]: "Google" }, adCookieCategories: { [UNSIGNED]: "advertising" } }).vendors.find((r) => r.name === "Google");
    expect(google?.detail.cookies.map((c) => [c.name, c.unsigned === true, c.requestLost === true])).toEqual([
      ["ar_debug", true, false],
      ["late_id", false, true],
    ]);
    // Unsigned and lost in a mix read as the unsigned do, never "no cookies set": every one
    // was set, and none on a request seen carrying the signal.
    expect(google).toMatchObject({ cookies: [], emptyKey: "vendorCookiesWithoutGpc" });
    expect(page({ totalRequests: 3 }).vendors.find((r) => r.name === "Google")).toMatchObject({ emptyKey: "vendorCookiesRequestLost" });
  });

  it("says the panel's list is incomplete when the lost keys filled their list", () => {
    const google = page({
      totalRequests: 3,
      byEntityCategory: summaries(summary("Google", "advertising", { hosts: ["ads.doubleclick.net"], cookieKeysRequestLost: [LOST], requestLostCapped: true })),
    }).vendors.find((r) => r.name === "Google");
    expect(google?.detail.cookiesCapped).toBe(true);
  });
});

describe("pages from the 2026-09-25 corpus run", () => {
  describe("a page that did not load (ticketing-b.example)", () => {
    // Chrome's error page runs no content script, so the page reports nothing, and the
    // defaults would read "signal off". The one request carried Sec-GPC.
    const failed = (over: Partial<ObservationSet> = {}) =>
      obs({
        ...over,
        context: { loadError: "net::ERR_CONNECTION_TIMED_OUT", ...over.context } as never,
        signal: { source: "none", propertyValue: false, readCount: 0, secGpcRequestCount: 1, totalRequestCount: 1 } as never,
      });

    it("is its own state, ahead of signal-off and no-ad-tech", () => {
      expect(build(failed()).state).toBe("load-failed");
      expect(build(failed(), [], 0).state).toBe("load-failed");
    });

    it("says so in one notice at the top, and nothing else", () => {
      const v = build(failed({ context: { incomplete: true } as never }));
      expect(v.notices).toEqual([
        { kind: "incomplete", tone: "unavailable", placement: "top", textKey: "stateLoadFailed" },
      ]);
    });

    it("states the signal from this extension's own setting, not from the empty defaults", () => {
      const status = (sendingSignal: boolean, signalKnown = true) =>
        buildPopupView({ observations: failed(), findings: [], distinctCookies: 0, adTechRequests: 0, sendingSignal, signalKnown })
          .status;
      expect(status(true)).toEqual({ isSet: true, sourceKey: "sourceThisExtension", accent: true });
      expect(status(false)).toEqual({ isSet: false, sourceKey: "sourceOffInSettings", accent: false });
      expect(status(true, false).sourceKey).toBe("sourceUnknown");
    });

    it("leaves a page that loaded in the observed state", () => {
      expect(build(obs({ context: { loadError: null } as never }), [], 3).state).toBe("observed");
    });
  });

  describe("Consent Mode read from Google's consent store (apparel-c.example)", () => {
    // The dataLayer the capture watched was never used; the consent store, which every
    // Google tag reads, held the state. Reading only the dataLayer, the popup would say "We
    // could not observe Consent Mode".
    const store = {
      ad_storage: { default: false, update: false, implicit: true },
      ad_user_data: { default: false, update: false },
      ad_personalization: { default: false, update: false },
      analytics_storage: { default: false, update: false },
      apc_performance: { default: false, update: true },
    };
    const apparelC = (over: Partial<ObservationSet["gtm"]> = {}) =>
      obs({
        gtm: { present: true, containerIds: ["GTM-XAPC100"], gtagIds: [], consentMode: null, effectiveConsent: store, ...over },
        capabilities: { dataLayer: false } as never,
      });

    it("does not say Consent Mode could not be observed once the store was read", () => {
      const said = (o: ObservationSet) => build(o).notices.some((n) => n.textKey === "stateCaptureUnavailable");
      expect(said(apparelC())).toBe(false);
      expect(said(apparelC({ effectiveConsent: null }))).toBe(true);
    });

    it("shows the store's values on the Consent Mode row", () => {
      const gcm = build(apparelC()).privacyStrings.find((r) => r.id === "gcm");
      expect(gcm?.summary).toEqual([{ key: "valueConsentGranted", substitution: ["0"] }]);
    });

    it("says nothing about a dataLayer on a page with no Google tag", () => {
      const said = build(obs({ capabilities: { dataLayer: false } as never })).notices.some(
        (n) => n.textKey === "stateCaptureUnavailable",
      );
      expect(said).toBe(false);
    });
  });
});

// The site's statement has its row and the cookies have the count, so no notice repeats them.
describe("declared-honor raises no notice above the count", () => {
  const finding: Finding = { flag: "declared-honor-cookie-set", rank: 13, entity: null, artifact: { kind: "none" } };
  const file = { url: "https://example.com/.well-known/gpc.json", present: true, gpc: true, lastUpdate: null, observedAtMs: 1, fresh: true, reason: null };
  const view = (o: ObservationSet) => build(o, [finding]);
  const value = (o: ObservationSet, labelKey: string) => view(o).siteDid.find((r) => r.labelKey === labelKey)?.valueKey;

  it("on the published file alone, which keeps its row", () => {
    const o = obs({ wellKnown: file });
    expect(view(o).notices.filter((n) => n.kind === "finding")).toEqual([]);
    expect(value(o, "labelWellKnown")).toBe("valueYes");
  });

  it("on the page's confirmation notice alone, which keeps its row", () => {
    const o = obs({ confirmationNotice: "detected" });
    expect(view(o).notices.filter((n) => n.kind === "finding")).toEqual([]);
    expect(value(o, "labelConfirmation")).toBe("valueYes");
  });

  it("on both", () => {
    const o = obs({ wellKnown: file, confirmationNotice: "detected" });
    expect(view(o).notices.filter((n) => n.kind === "finding")).toEqual([]);
  });

  it("and leaves the other findings their notices", () => {
    const conflict: Finding = { flag: "gpp-conflict", rank: 12, entity: null, artifact: { kind: "none" } };
    const keys = build(obs({ wellKnown: file }), [finding, conflict]).notices.filter((n) => n.kind === "finding").map((n) => n.textKey);
    expect(keys).toEqual(["findingGppConflict"]);
  });
});

describe("vendor panel wording", () => {
  const messages: Readonly<Record<string, { message: string }>> = messagesJson;

  it("says refused writes are not in the cookie jar, and that they were not counted", () => {
    expect(messages["vdetailRefusedWrites"]?.message).toBe("Not in the browser's cookie jar (not counted)");
    expect(messages["hintRefusedWrites"]?.message).toBe(
      "The browser did not set these cookies or they were removed when the extension checked cookie storage a second later. They were not counted.",
    );
  });

  it("says probe cookies were written and removed, in the section, its hint and an empty row", () => {
    expect(messages["vdetailProbeCookies"]?.message).toBe("Written and removed (not counted)");
    expect(messages["vendorCookiesSetAndRemoved"]?.message).toBe("cookies written and removed");
    expect(messages["hintProbeCookies"]?.message).toMatch(/^Written and removed again at once by the same script/);
  });

  it("says sent back only when it was seen, and what it means on the heading", () => {
    expect(messages["cookieSentBack"]?.message).toBe("sent back");
    expect(messages["cookieNotSentBack"]).toBeUndefined();
    expect(messages["hintCookiesSentBack"]?.message).toBe("Sent back: cookie was sent back to this vendor in the HTTP request header.");
  });

  it("keeps the site-loader wording", () => {
    expect(messages["vendorLoadedBySiteScriptOne"]?.message).toBe("loaded by a site script that also loads 1 other vendor");
  });
});

describe("what counts as a GPC read", () => {
  const classify = classifyWith([
    ["criteo", "Criteo", "advertising"],
    ["doubleclick", "Google", "advertising"],
    ["tracker.example", null, "advertising"],
  ]);
  const CRITEO = "https://static.criteo.net/js/ld/publishertag.js";
  const tallies = { ...EMPTY_TALLIES, byEntityCategory: summaries(summary("Criteo", "advertising")) };
  const view = (o: Partial<ObservationSet>, findings: Finding[]) =>
    buildPopupView({ observations: obs({ tallies, ...o }), findings, distinctCookies: 0, adTechRequests: 5, classify });
  const criteo = (v: ReturnType<typeof view>) => v.vendors.find((r) => r.name === "Criteo");
  /** Every line in the GPC read group: each row's, then the group's own notes. */
  const readLines = (v: ReturnType<typeof view>) => [...readRows(v).rows.flatMap((r) => r.lines ?? []), ...(readRows(v).group?.lines ?? [])];
  const keysOf = (v: ReturnType<typeof view>) => readLines(v).map((l) => (l.parts[0] && "key" in l.parts[0] ? l.parts[0].key : ""));
  /** Which GPC read row names Criteo: the row's label, or undefined when none does. */
  const lineOf = (v: ReturnType<typeof view>, name = "Criteo") => {
    const row = readRows(v).rows.find((r) => r.valueKey === undefined && (r.lines?.[0]?.list ?? []).some((i) => i.text === name));
    return row === undefined ? undefined : { key: row.labelKey };
  };
  const gppRead = pairFinding("Criteo", "advertising", "vendor-read-gpc", { kind: "consent-api", api: "__gpp", callCount: 1 });
  const gppCall = (callerScriptUrl: string | null, command = "getGPPData", viaTagManager = false) => ({
    api: "__gpp" as const, command, callerScriptUrl, viaTagManager, timeMs: 0,
  });
  const signalOff = { source: "none", propertyValue: false, readTracking: "active", readCount: 0, readsByScript: {} } as never;

  describe("only a read that returned a GPC value is a Yes", () => {
    it("puts a GPP read of a string that records GPC, and a property read, on Yes", () => {
      expect(lineOf(view({ gpp: gppWith({ Gpc: 1 }) }, [gppRead]))?.key).toBe("labelReadObserved");
      const prop = view({}, [pairFinding("Criteo", "advertising", "vendor-read-gpc", { kind: "signal-read", readCount: 2 })]);
      expect(criteo(prop)?.checkKey).toBe("vendorGpcReadProperty");
      expect(lineOf(prop)?.key).toBe("labelReadObserved");
    });

    it("puts a GPP-silent vendor on No while the signal is on", () => {
      const v = view({ gpp: gppWith({ SaleOptOut: 2 }) }, [gppRead]);
      expect(criteo(v)?.checkKey).toBe("vendorGpcAskedNoGpcField");
      expect(lineOf(v)?.key).toBe("labelReadNotObserved");
    });

    it("counts a GPP-silent vendor as a read with the signal off, with help that says why", () => {
      const v = view({ signal: signalOff, gpp: gppWith({ SaleOptOut: 2 }) }, [gppRead]);
      expect(criteo(v)?.checkKey).toBe("vendorGpcRead");
      expect(criteo(v)?.checkHelp).toEqual({ key: "vendorGpcReadHelpSignalOff" });
      expect(lineOf(v)?.key).toBe("labelReadObserved");
      // A string that records GPC keeps the ordinary help, signal on.
      expect(criteo(view({ gpp: gppWith({ Gpc: 1 }) }, [gppRead]))?.checkHelp).toEqual({ key: "vendorGpcReadHelp" });
    });

    it("puts a GPP call with no decodable string under Cannot determine", () => {
      const v = view({ gpp: null }, [gppRead]);
      expect(criteo(v)?.checkKey).toBe("vendorGpcAskedNoResponse");
      expect(lineOf(v)?.key).toBe("labelReadUndetermined");
    });

    it("counts an unidentified GPP caller only when the string records a GPC value", () => {
      const unidentified = (o: Partial<ObservationSet>) => keysOf(view({ consentApiCalls: [gppCall(null)], ...o }, [])).includes("hintGppCalledUnidentified");
      expect(unidentified({ gpp: gppWith({ Gpc: 1 }) })).toBe(true);
      expect(unidentified({ gpp: gppWith({ SaleOptOut: 2 }) })).toBe(false);
      expect(unidentified({ gpp: gppWith({ SaleOptOut: 2 }), signal: signalOff })).toBe(true);
      expect(unidentified({ gpp: null })).toBe(false);
    });

    it("does not name a GPP caller with no row when the string is silent on GPC", () => {
      const calls = [gppCall("https://securepubads.g.doubleclick.net/y.js")];
      expect(lineOf(view({ consentApiCalls: calls, gpp: gppWith({ SaleOptOut: 2 }) }, []), "Google")).toBeUndefined();
      expect(lineOf(view({ consentApiCalls: calls, gpp: gppWith({ Gpc: 1 }) }, []), "Google")?.key).toBe("labelReadObserved");
    });
  });

  describe("a container's GPP call", () => {
    const fromContainer = (command: string, version: string) =>
      view({ consentApiCalls: [gppCall("https://www.googletagmanager.com/gtm.js?id=GTM-A", command, true)], gpp: { ...gppWith({ Gpc: 1 }), gppVersion: version } }, []);
    const containerHint = (v: ReturnType<typeof view>) => keysOf(v).some((k) => k.startsWith("hintChecked") && k !== "hintCheckedOtherDomains");

    it("is not a read when it is a GPP 1.0 ping", () => {
      expect(containerHint(fromContainer("ping", "1.0"))).toBe(false);
      expect(containerHint(fromContainer("ping", "1.1"))).toBe(true);
      expect(containerHint(fromContainer("getGPPData", "1.0"))).toBe(true);
    });

    it("is not a read when the string records no GPC value", () => {
      const v = view({ consentApiCalls: [gppCall("https://www.googletagmanager.com/gtm.js?id=GTM-A", "getGPPData", true)], gpp: gppWith({ SaleOptOut: 2 }) }, []);
      expect(containerHint(v)).toBe(false);
    });
  });

  describe("a page where property reads could not be observed", () => {
    const off = { readTracking: "unavailable", readCount: null, readsByScript: {}, readAttribution: null } as never;

    it("turns a no-read vendor into Cannot determine, on that line", () => {
      for (const flag of ["vendor-did-not-read-gpc", "vendor-gpc-unread-via-container"] as const) {
        const v = view({ signal: off }, [pairFinding("Criteo", "advertising", flag, { kind: "network", observationId: "1", loadedVia: [{ kind: "entity", name: "Prebid" }] })]);
        expect(criteo(v)?.checkKey).toBe("vendorGpcCheckUntraced");
        expect(criteo(v)?.checkHelp).toEqual({ key: "vendorGpcCheckUntracedHelp" });
        expect(lineOf(v)?.key).toBe("labelReadUndetermined");
      }
    });

    it("keeps a GPP read a read", () => {
      const v = view({ signal: off, gpp: gppWith({ Gpc: 1 }) }, [gppRead]);
      expect(criteo(v)?.checkKey).toBe("vendorGpcRead");
    });

    it("does not say nothing read the GPP string", () => {
      expect(keysOf(view({ signal: off, gpp: gppWith({ Gpc: 1 }) }, []))).not.toContain("hintNoCheckGppRecords");
      expect(keysOf(view({ signal: { readTracking: "active", readCount: 0, readsByScript: {} } as never, gpp: gppWith({ Gpc: 1 }) }, []))).toContain("hintNoCheckGppRecords");
    });
  });

  describe("a counted domain with no company", () => {
    const K = "x\u0000.tracker.example";
    const domainTallies = { ...EMPTY_TALLIES, adCookieKeys: [K], adCookieEntities: {}, adCookieCategories: { [K]: "advertising" } } as ObservationSet["tallies"];
    const domainView = (findings: Finding[]) =>
      buildPopupView({ observations: obs({ tallies: domainTallies }), findings, distinctCookies: 1, adTechRequests: 5, classify });
    const row = (v: ReturnType<typeof domainView>) => v.vendors.find((r) => r.name === "tracker.example");

    it("is judged by the engine's finding for the domain when there is one", () => {
      const read: Finding = { flag: "vendor-read-gpc", rank: 41, entity: { name: "tracker.example", domains: ["tracker.example"], unlisted: true }, artifact: { kind: "signal-read", readCount: 1 } };
      const v = domainView([read]);
      expect(row(v)?.checkKey).toBe("vendorGpcReadProperty");
      expect(lineOf(v, "tracker.example")?.key).toBe("labelReadObserved");
    });

    it("says no company is listed when there is none", () => {
      const v = domainView([]);
      expect(row(v)?.checkKey).toBe("vendorGpcUnlistedDomain");
      expect(row(v)?.checkHelp).toEqual({ key: "vendorGpcUnlistedDomainHelp" });
    });
  });

  describe("help text", () => {
    it("says a loader did not read only when the chain was checked", () => {
      const notRead = (chainChecked: boolean) =>
        pairFinding("Criteo", "advertising", "vendor-did-not-read-gpc", { kind: "network", observationId: "1", loadedVia: [{ kind: "entity", name: "Prebid" }], ...(chainChecked ? { chainChecked: true as const } : {}) });
      expect(criteo(view({}, [notRead(true)]))?.checkHelp).toEqual({ key: "vendorGpcNotReadHelpLoader", substitution: ["Prebid"] });
      expect(criteo(view({}, [notRead(false)]))?.checkHelp).toEqual({ key: "vendorGpcNotReadHelpLoaderUnchecked", substitution: ["Prebid"] });
    });

    it("leaves out a container id that is null, never printing ()", () => {
      const unnamed = { kind: "container" as const, identity: { manager: "gtm" as const, id: null }, ancestors: [], mixed: false };
      const loaderFinding = (flag: "vendor-gpc-check-unattributable" | "vendor-gpc-unread-via-container", containerCallCount: number) =>
        pairFinding("Criteo", "advertising", flag, { kind: "vendor-check-loader", loader: unnamed, route: "loader", containerCallCount, checkedBeforeLoad: null, consentModeActive: false, loadedVia: [unnamed] });
      expect(criteo(view({}, [loaderFinding("vendor-gpc-check-unattributable", 1)]))?.checkHelp).toEqual({ key: "vendorGpcCheckUnattributableHelpContainerUnnamed" });
      expect(criteo(view({}, [loaderFinding("vendor-gpc-unread-via-container", 0)]))?.checkHelp).toEqual({ key: "vendorGpcNotReadViaContainerHelpContainerUnnamed" });
      // Every message the vendor rows can reach renders without an empty pair of parentheses.
      for (const key of ["vendorGpcCheckUnattributableHelpContainerUnnamed", "vendorGpcNotReadViaContainerHelpContainerUnnamed"]) {
        expect((messagesJson as Record<string, { message: string }>)[key]?.message).not.toContain("$");
      }
    });

    it("words the ordering for the ancestor route about the parent container", () => {
      const own = { kind: "container" as const, identity: { manager: "gtm" as const, id: "GTM-CHILD" }, ancestors: [], mixed: false };
      const parent = { kind: "container" as const, identity: { manager: "gtm" as const, id: "GTM-PARENT" }, ancestors: [], mixed: false };
      const f = (before: boolean) =>
        pairFinding("Criteo", "advertising", "vendor-gpc-unread-via-container", { kind: "vendor-check-loader", loader: parent, route: "ancestor", containerCallCount: 1, checkedBeforeLoad: before, consentModeActive: false, loadedVia: [own] });
      expect(criteo(view({}, [f(true)]))?.checkHelp.orderKey).toBe("vendorGpcCheckOrderParentBefore");
      expect(criteo(view({}, [f(false)]))?.checkHelp.orderKey).toBe("vendorGpcCheckOrderParentAfter");
    });
  });

  describe("the TCF and USP lines", () => {
    const tcfCall = (command: string) => ({ api: "__tcfapi" as const, command, callerScriptUrl: CRITEO, viaTagManager: false, timeMs: 0 });
    const tcf = (purposeConsents: Record<string, boolean>) => ({ tcString: "CPabc", gdprApplies: true, purposeConsents });
    const tcfLine = (command: string, purposes: Record<string, boolean>) => criteo(view({ consentApiCalls: [tcfCall(command)], tcf: tcf(purposes) }, []))?.tcf;

    it("never attributes a ping", () => {
      expect(tcfLine("ping", { 1: true })).toBeUndefined();
      expect(tcfLine("getTCData", { 1: true, 2: false })).toEqual({ key: "vendorTcfChecked", substitution: ["1/2"] });
      expect(tcfLine("addEventListener", { 1: true })).toEqual({ key: "vendorTcfChecked", substitution: ["1/1"] });
    });

    it("says no purposes in words, never 0/0", () => {
      expect(tcfLine("getTCData", {})).toEqual({ key: "vendorTcfNoPurposes" });
      expect(tcfLine("getTCData", { 1: false, 2: false })).toEqual({ key: "vendorTcfNoneGranted" });
    });

    it("shows USP only for the API's own answer", () => {
      const uspCall = { api: "__uspapi" as const, command: "getUSPData", callerScriptUrl: CRITEO, viaTagManager: false, timeMs: 0 };
      const usp = (fromApi: string | null) => criteo(view({ consentApiCalls: [uspCall], usPrivacy: { fromApi, fromCookie: "1YYN", fromWire: "1YYN" } }, []))?.usp;
      expect(usp(null)).toBeUndefined();
      expect(usp("1YNN")).toEqual({ valueKey: "valueUspOptedOutN" });
    });
  });
});

describe("a page the browser does not let this extension access", () => {
  // Site access "On click" or "On specific sites", or a host an administrator blocked: the
  // browser applies no header rule and runs no script there, and reports none of the page's
  // requests. The tab's record has its site, from the navigation, and nothing else.
  const withheld = () =>
    obs({
      signal: { source: "none", propertyValue: false, readCount: 0, secGpcRequestCount: 0, totalRequestCount: 0 } as never,
    });
  const view = (o: ObservationSet, over: Partial<Parameters<typeof buildPopupView>[0]> = {}) =>
    buildPopupView({
      observations: o, findings: [], distinctCookies: 0, adTechRequests: 0,
      sendingSignal: true, signalKnown: true, pageAccess: false, ...over,
    });

  it("says site access is limited, never to reload", () => {
    const v = view(withheld());
    expect(v.status).toEqual({ isSet: false, sourceKey: "sourceSiteAccessLimited", accent: false });
    expect(v.state).toBe("site-access-limited");
    expect(v.notices).toEqual([
      {
        kind: "incomplete",
        tone: "unavailable",
        placement: "top",
        textKey: "stateSiteAccessLimited",
        subTextKey: "stateSiteAccessLimitedHint",
      },
    ]);
  });

  it("is not left waiting for a page that will never report", () => {
    // The popup holds "Checking this page" for a record with nothing in it yet. Here nothing
    // is coming, however long it waits.
    expect(view(withheld(), { pending: true }).state).toBe("site-access-limited");
  });

  it("keeps the setting's own status while sending is off", () => {
    const v = view(withheld(), { sendingSignal: false });
    expect(v.status.sourceKey).toBe("sourceOffInSettings");
    expect(v.state).toBe("site-access-limited");
  });

  it("keeps the reload status on a page open before an update, where access is not the cause", () => {
    const late = obs({ context: { loadObserved: false } as never, signal: { source: "none" } as never });
    expect(view(late, { pageAccess: true }).status.sourceKey).toBe("sourceNeedsReload");
    // Not asked (the record is from a download, or the browser could not say): as before.
    const unasked = buildPopupView({
      observations: withheld(), findings: [], distinctCookies: 0, adTechRequests: 0, sendingSignal: true, signalKnown: true,
    });
    expect(unasked.status.sourceKey).toBe("sourceNeedsReload");
    expect(unasked.state).not.toBe("site-access-limited");
  });

  it("says site access rather than reload on a page that was also open before an update", () => {
    const late = obs({ context: { loadObserved: false } as never, signal: { source: "none" } as never });
    const v = view(late);
    expect(v.status.sourceKey).toBe("sourceSiteAccessLimited");
    expect(v.state).toBe("site-access-limited");
  });

  it("shows what was observed when access was withdrawn after the page loaded", () => {
    // The page loaded with access, and its record stands for that load.
    const loaded = obs();
    const v = view(loaded);
    expect(v.state).not.toBe("site-access-limited");
    expect(v.status.sourceKey).toBe("sourceThisExtension");
  });
});

describe("a string carrying two US sections", () => {
  // The row, the notices and the vendor Read GPC lines all read the applicable sections, the
  // ones the site's consent tool specifies (engine gpp-section.ts). Where the specification
  // and its published practice do not settle which applies, nothing is judged and the row
  // says why.
  const classify = classifyWith([["criteo", "Criteo", "advertising"]]);
  const tallies = { ...EMPTY_TALLIES, byEntityCategory: summaries(summary("Criteo", "advertising")) };
  const gppRead = pairFinding("Criteo", "advertising", "vendor-read-gpc", { kind: "consent-api", api: "__gpp", callCount: 1 });
  // No request is classified on these pages: the engine is asked about the string alone.
  const noRequests: Classifier = {
    classify: () => {
      throw new Error("no request to classify");
    },
  };
  const usca = { SaleOptOut: 1 };
  const usnat = { Gpc: 1, SaleOptOut: 2 };
  const gppRow = (v: PopupView) => v.privacyStrings.find((r) => r.id === "gpp");
  /** Each decoded section, in the row's order: its prefix and its GPC field. */
  const shown = (v: PopupView) =>
    (gppRow(v)?.groups ?? []).flatMap((g) => {
      const section = g.fields.find((f) => f.labelKey === "gppLabelSection");
      return section === undefined ? [] : [{ section: section.raw, gpc: g.fields.find((f) => f.labelKey === "gppFieldGpc")?.valueKey }];
    });
  /** The popup for a string, with the findings the engine draws from it. */
  const view = (applicableSections: number[], sections: Record<string, Record<string, number>> = { usca, usnat }, signal?: Partial<ObservationSet["signal"]>) => {
    const o = obs({ tallies, gpp: { ...gppWith({}), applicableSections, sections }, ...(signal ? { signal: signal as ObservationSet["signal"] } : {}) });
    return buildPopupView({ observations: o, findings: [...evaluate(o, noRequests), gppRead], distinctCookies: 0, adTechRequests: 5, classify });
  };
  const conflictShown = (v: PopupView) => v.notices.some((n) => n.textKey === "findingGppConflict");
  const criteo = (v: PopupView) => v.vendors.find((r) => r.name === "Criteo");

  it("[7]: shows usnat, reports its conflict and names usca", () => {
    const v = view([7]);
    expect(shown(v).map((s) => s.section)).toEqual(["usnat"]);
    expect(conflictShown(v)).toBe(true);
    expect(gppRow(v)?.flagged).toBe(true);
    expect(gppRow(v)?.sectionLine).toEqual({ key: "gppLineOthersNotSpecified", substitution: ["US - California (8)"] });
  });

  it("[8]: shows usca, with no conflict for usnat, and names usnat", () => {
    const v = view([8]);
    expect(shown(v).map((s) => s.section)).toEqual(["usca"]);
    expect(conflictShown(v)).toBe(false);
    expect(gppRow(v)?.flagged).toBe(false);
    expect(gppRow(v)?.sectionLine).toEqual({ key: "gppLineOthersNotSpecified", substitution: ["US - National (7)"] });
  });

  it("[7, 8]: shows both, reports usnat's conflict and flags the row", () => {
    const v = view([7, 8]);
    expect(shown(v).map((s) => s.section)).toEqual(["usnat", "usca"]);
    expect(gppRow(v)?.summary).toEqual([{ key: "valueGppApplicableSections", substitution: ["2"] }]);
    expect(conflictShown(v)).toBe(true);
    expect(gppRow(v)?.flagged).toBe(true);
    expect(gppRow(v)?.sectionLine).toEqual({ key: "gppLineTwoSpecified" });
  });

  it("[] and [0]: shows both, judges neither, and puts a GPP call under Cannot determine", () => {
    for (const ids of [[], [0]]) {
      const v = view(ids);
      expect(shown(v).map((s) => s.section)).toEqual(["usnat", "usca"]);
      expect(gppRow(v)?.summary).toEqual([{ key: "valueGppApplicableNotSpecified" }]);
      expect(conflictShown(v)).toBe(false);
      expect(gppRow(v)?.flagged).toBe(false);
      expect(gppRow(v)?.sectionLine).toEqual({ key: "gppLineUnspecified" });
      expect(criteo(v)?.checkKey).toBe("vendorGpcAskedNoApplicableSection");
      expect(criteo(v)?.checkHelp.key).toBe("vendorGpcAskedNoApplicableSectionHelp");
      expect(readRows(v).unsure).toEqual(["Criteo [advertising]"]);
    }
  });

  it("[-1]: says no section applies and judges nothing", () => {
    const v = view([-1]);
    expect(gppRow(v)?.summary).toEqual([{ key: "valueGppNoSectionApplies" }]);
    expect(gppRow(v)?.sectionLine).toEqual({ key: "gppLineNoneApplies" });
    expect(shown(v).map((s) => s.section)).toEqual(["usnat", "usca"]);
    expect(conflictShown(v)).toBe(false);
    expect(gppRow(v)?.flagged).toBe(false);
    expect(criteo(v)?.checkKey).toBe("vendorGpcAskedNoApplicableSection");
  });

  it("usnat alone under [8]: says the specified section is not in the string", () => {
    const v = view([8], { usnat });
    expect(gppRow(v)?.summary).toEqual([{ key: "valueGppSpecifiedNotInString" }]);
    expect(gppRow(v)?.sectionLine).toEqual({ key: "gppLineNotCarried", substitution: ["US - California (8)"] });
    expect(shown(v).map((s) => s.section)).toEqual(["usnat"]);
    expect(conflictShown(v)).toBe(false);
    expect(gppRow(v)?.flagged).toBe(false);
  });

  it("shows a section that is not applicable without the weight of a judged field", () => {
    const fields = (gppRow(view([]))?.groups ?? []).flatMap((g) => g.fields);
    expect(fields.some((f) => f.emphasis === true)).toBe(false);
  });

  describe("with usca Gpc 0, usnat Gpc 1 and the signal set", () => {
    const sections = { usca: { Gpc: 0, SaleOptOut: 1 }, usnat: { Gpc: 1 } };
    const signalSet = { propertyValue: true, secGpcRequestCount: 9 };

    it("[8]: GPC field no, the mismatch note, and the vendor on No", () => {
      const v = view([8], sections, signalSet);
      expect(shown(v)).toEqual([{ section: "usca", gpc: "valueNo" }]);
      expect(gppRow(v)?.noteKey).toBe("gppNoteMismatchSignalSet");
      expect(criteo(v)?.checkKey).toBe("vendorGpcAskedNoGpcField");
    });

    it("[7]: GPC field yes, no note, and the vendor on Yes", () => {
      const v = view([7], sections, signalSet);
      expect(shown(v)).toEqual([{ section: "usnat", gpc: "valueYes" }]);
      expect(gppRow(v)?.noteKey).toBeUndefined();
      expect(criteo(v)?.checkKey).toBe("vendorGpcRead");
    });

    it("[]: the vendor under Cannot determine, and no note", () => {
      const v = view([], sections, signalSet);
      expect(gppRow(v)?.noteKey).toBeUndefined();
      expect((gppRow(v)?.groups ?? []).some((g) => g.noteKey !== undefined)).toBe(false);
      expect(criteo(v)?.checkKey).toBe("vendorGpcAskedNoApplicableSection");
    });
  });

  it("maps a pre-rename name specified under [7]", () => {
    const v = view([7], { usnatv1: usnat });
    expect(shown(v).map((s) => s.section)).toEqual(["usnatv1"]);
    expect(gppRow(v)?.sectionLine).toBeUndefined();
    expect(conflictShown(v)).toBe(true);
  });

  it("reads the only US section when nothing is specified, and says so", () => {
    const v = view([], { usnatv1: usnat });
    expect(shown(v).map((s) => s.section)).toEqual(["usnatv1"]);
    expect(gppRow(v)?.sectionLine).toEqual({ key: "gppLineOnlySection" });
    expect(conflictShown(v)).toBe(true);
    expect(gppRow(v)?.flagged).toBe(true);
    expect(criteo(v)?.checkKey).toBe("vendorGpcRead");
  });

  it("keeps 'US section named, no fields reported' for a specified section carried without fields", () => {
    const v = view([8], { usca: {}, usnat });
    expect(gppRow(v)?.summary).toEqual([{ key: "valueGppUsSectionNoFields" }]);
    expect(conflictShown(v)).toBe(false);
    expect(gppRow(v)?.sectionLine).toEqual({ key: "gppLineOthersNotSpecified", substitution: ["US - National (7)"] });
  });

  it("says nothing of other sections on a string carrying one, specified", () => {
    expect(gppRow(view([8], { usca }))?.sectionLine).toBeUndefined();
  });
});
