// SPDX-License-Identifier: GPL-3.0-only
/**
 * Fixture ObservationSets for the visual harness.
 *
 * Not shipped. These exist so every popup surface can be rendered side by side at 420px
 * and compared: cross-surface inconsistencies only become visible when two surfaces sit
 * next to each other.
 */

// Bundled by build.mjs, so the packages can be imported: the schema's version, the
// engine's withPersistedShape, which gives an older-shaped fixture the fields a current
// capture records as it goes (1.22.0), and the worker's own form of a kept record (1.27.0).
import { SCHEMA_VERSION } from "@gpc-inspector/schema";
import { withPersistedShape } from "@gpc-inspector/engine";
import { toKept } from "../src/background/kept-cookies.ts";

const hdr = (name, value) => ({ name, nameLower: name.toLowerCase(), value });

const cookie = (name, domain, over = {}) => ({
  name,
  value: "REDACTED",
  domain,
  path: "/",
  expiresMs: Date.now() + 1000 * 60 * 60 * 24 * 400,
  sameSite: "None",
  httpOnly: false,
  secure: true,
  partitioned: false,
  via: "onHeadersReceived",
  ...over,
});

/** Insertion-record helpers (provenance). */
const insertion = (url, ...loaders) => ({ key: url.replace(/\?(?!id=)[^#]*|#.*$/g, ""), url, element: "script", loaders });
const loaderBy = (insertedBy, containerUrls, over = {}) => ({
  insertedBy,
  inlineFrames: false,
  currentScriptKey: null,
  containerUrls,
  via: "appendChild",
  frameOrigin: "https://www.example-news.com",
  topFrame: true,
  count: 1,
  timeMs: Date.now(),
  ...over,
});
const coverage = () => ({
  recorded: 6, parser: 4, duplicates: 0, inline: 3, inlineResolvedByCurrentScript: 1, nonExecuting: 0,
  srcUnresolved: 0, stackFailed: 0, ambiguousContainer: 0, capExceeded: 0, wrappedOver: false, selfDisabled: false,
});

/**
 * Counted cookies in the tally's own shape (1.19.0): each key is name and domain, with the
 * vendor whose request set it and that request's category. The names under the headline and
 * the vendor rows are built from exactly these, so a fixture that counts a cookie no vendor
 * set would show a number its names do not add up to.
 */
const K = (name, domain) => `${name}\u0000${domain}`;
const counted = (rows) => ({
  adCookieKeys: rows.map(([n, d]) => K(n, d)),
  // A row with no entity is a domain the list categorizes but names no company for; the
  // popup lists it under the domain.
  adCookieEntities: Object.fromEntries(rows.filter(([, , entity]) => entity).map(([n, d, entity]) => [K(n, d), entity])),
  adCookieCategories: Object.fromEntries(rows.map(([n, d, , category]) => [K(n, d), category])),
});

/**
 * The category Disconnect gives each hostname the fixtures use, in the engine's names. This
 * file runs in the browser unbundled and cannot ask the list; test/harness-fixtures.test.ts
 * holds every summary built from it to the real one. www.googletagmanager.com is in neither
 * of Disconnect's files, so it has none.
 */
const CATEGORY_OF_HOST = {
  "securepubads.g.doubleclick.net": "advertising",
  "www.google-analytics.com": "analytics",
  "insight.adsrvr.org": "advertising",
  "match.adsrvr.org": "advertising",
  "static.criteo.net": "advertising",
  "bidder.criteo.com": "advertising",
  "cdn.permutive.com": "advertising",
  "api.permutive.app": "advertising",
  "pixel.quantserve.com": "advertising",
  "c.amazon-adsystem.com": "advertising",
  "bat.bing.com": "advertising",
  "sb.scorecardresearch.com": "analytics",
  "s.go-mpulse.net": "analytics",
  "dpm.demdex.net": "advertising",
  "cm.everesttech.net": "advertising",
  "apps.rokt.com": "advertising",
  "lightboxcdn.com": "analytics",
  "region1.google-analytics.com": "analytics",
  "googleads.g.doubleclick.net": "advertising",
  "sc-static.net": "advertising",
  "tr.snapchat.com": "advertising",
  "tags.tiqcdn.com": "analytics",
  // The store fixtures' fictional vendors (harness/fictional-vendors.mjs).
  "tag.adlark.example": "advertising",
  "bid.adlark.example": "advertising",
  "tag.bidmoor.example": "advertising",
  "ads.bidmoor.example": "advertising",
  "id.bidmoor.example": "advertising",
  "cm.bidmoor.example": "advertising",
  "px.crestline.example": "advertising",
  "c.dunmore.example": "advertising",
  "bid.dunmore.example": "advertising",
  "tag.fernbid.example": "advertising",
  "px.fernbid.example": "advertising",
  "fast.glimmer.example": "advertising",
  "sync.glimmer.example": "advertising",
  "js.inkwell.example": "advertising",
  "px.inkwell.example": "advertising",
  "px.pixelmoss.example": "advertising",
  "bid.pixelmoss.example": "advertising",
  "px.tallyhall.example": "analytics",
  "cdn.quillstat.example": "analytics",
  "cdn.ridgeway.example": "analytics",
};

const ACTIVE_TYPES = new Set(["script", "xmlhttprequest"]);
const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

/**
 * The summaries per company and category a capture writes beside `byEntity` (1.20.0): one
 * for each category a company's hostnames fall in, and one for each vendor in a category
 * that does not count, which `byEntity` never held. The vendor list is built from these,
 * a row for each.
 *
 * Built from the fixture's own tallies and requests, so the two cannot disagree: a
 * company's requests are shared between its categories, and what ran is what the requests
 * to its hostnames say unless the tally says otherwise. `others` are the vendors outside
 * advertising and analytics: [company, category, hostnames, requests, what differs].
 */
function summariesOf(byEntity, network, others) {
  const out = [];
  // Requests only: the worker tallies a request's type as it is sent (tallyRequest), and a
  // cookie a script wrote is a record of its own with no request behind it.
  const typesOf = (hosts) => network.filter((n) => n.method !== "SCRIPT" && hosts.includes(hostOf(n.url))).map((n) => n.resourceType);
  const add = (entity, category, hosts, requests, signedRequests, over = {}) => {
    const resourceTypes = [...new Set([...(over.resourceTypes ?? []), ...typesOf(hosts)])].sort();
    out.push([
      `${entity}\u0000${category}`,
      {
        entity,
        category,
        requests,
        signedRequests,
        hosts: [...hosts].sort(),
        cookieKeys: [],
        cookieKeysUnsigned: [],
        cookiesReturned: [],
        probeCookies: [],
        refusedWrites: [],
        ...over,
        resourceTypes,
        scriptRan: over.scriptRan ?? resourceTypes.some((t) => ACTIVE_TYPES.has(t)),
      },
    ]);
  };
  for (const [entity, e] of Object.entries(byEntity)) {
    const byCategory = new Map();
    for (const h of e.hosts) {
      const category = CATEGORY_OF_HOST[h];
      if (category !== undefined) byCategory.set(category, [...(byCategory.get(category) ?? []), h]);
    }
    const categories = [...byCategory];
    categories.forEach(([category, hosts], i) => {
      const share = (n) => Math.floor(n / categories.length) + (i === 0 ? n % categories.length : 0);
      add(entity, category, hosts, share(e.requests), share(e.signedRequests), {
        ...(i === 0 ? { cookiesReturned: e.cookiesReturned } : {}),
        ...(e.resourceTypes ? { resourceTypes: e.resourceTypes } : {}),
        ...(e.scriptRan !== undefined ? { scriptRan: e.scriptRan } : {}),
      });
    });
  }
  for (const [entity, category, hosts, requests, over] of others) add(entity, category, hosts, requests, requests, over);
  return Object.fromEntries(out.sort(([a], [b]) => (a < b ? -1 : 1)));
}

let seq = 0;
const req = (url, over = {}) => ({
  id: String(++seq),
  url,
  method: "GET",
  resourceType: "script",
  initiator: "https://www.example-news.com/",
  secGpcPresent: true,
  requestHeaders: [hdr("Sec-GPC", "1"), hdr("User-Agent", "Mozilla/5.0")],
  cookiesSent: [],
  statusCode: 200,
  responseHeaders: [hdr("Content-Type", "application/javascript")],
  isRedirectHop: false,
  setCookies: [],
  captureMethod: "onHeadersReceived",
  timeMs: Date.now(),
  ...over,
});

const base = (over = {}) => ({
  schemaVersion: SCHEMA_VERSION,
  context: {
    finalUrl: "https://www.example-news.com/politics/story",
    topSite: "example-news.com",
    extensionVersion: "1.0.0",
    browserUserAgent: "Mozilla/5.0 Chrome/140",
    os: "MacIntel",
    capturedAt: "2026-08-31T10:00:00.000Z",
    mode: "passive",
    incomplete: false,
    ...over.context,
  },
  signal: {
    secGpcRequestCount: 418,
    totalRequestCount: 431,
    source: "this-extension",
    propertyValue: true,
    readTracking: "active",
    readCount: 1904,
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
  ...(over.scriptInsertions ? { scriptInsertions: over.scriptInsertions, scriptInsertionCoverage: over.scriptInsertionCoverage ?? null } : {}),
  ...(over.requestInitiators ? { requestInitiators: over.requestInitiators, requestInitiatorCoverage: null } : {}),
  confirmationNotice: over.confirmationNotice ?? "indeterminate",
  wellKnown: over.wellKnown ?? null,
  // A fixture's tallies get the summaries a capture would have written with them, unless
  // it says `summaries: false`: a capture from before 1.20.0, which has a row per company.
  tallies:
    over.tallies === undefined
      ? {
          totalRequests: 0,
          signedRequests: 0,
          adVendorRequests: 0,
          adCookieEvents: 0,
          adCookieKeys: [],
          firstPartyVendorCookieKeys: [],
          byEntity: {},
        }
      : over.summaries === false
        ? over.tallies
        : { ...over.tallies, byEntityCategory: summariesOf(over.tallies.byEntity, over.network ?? [], over.otherVendors ?? []) },
  capabilities: {
    documentCookie: true,
    cookieStore: true,
    gpp: true,
    uspapi: true,
    tcfapi: true,
    dataLayer: true,
    ...over.capabilities,
  },
});

// --- heavy: an ad-dense publisher. The densest surface the popup has to hold. ---

const heavyNetwork = [
  req("https://securepubads.g.doubleclick.net/gampad/ads?iu=/1234/news&sz=300x250&correlator=8812", {
    resourceType: "xmlhttprequest",
    setCookies: [cookie("IDE", ".doubleclick.net")],
    cookiesSent: ["IDE"],
  }),
  req("https://securepubads.g.doubleclick.net/tag/js/gpt.js"),
  req("https://www.googletagmanager.com/gtm.js?id=GTM-WKX4T9"),
  req("https://www.google-analytics.com/g/collect?v=2&tid=G-8QZ1", {
    resourceType: "ping",
    statusCode: 204,
  }),
  req("https://insight.adsrvr.org/track/cei?adv=k8d9", {
    resourceType: "sub_frame",
    statusCode: 302,
    isRedirectHop: true,
    setCookies: [cookie("TDID", ".adsrvr.org")],
  }),
  req("https://match.adsrvr.org/track/cmf/generic?ttd_pid=casale", {
    resourceType: "image",
    statusCode: 200,
    setCookies: [cookie("TDCPM", ".adsrvr.org")],
  }),
  req("https://cdn.permutive.com/12ab/permutive.js", { statusCode: 200 }),
  req("https://api.permutive.app/v2/identify", {
    resourceType: "xmlhttprequest",
    method: "POST",
    setCookies: [cookie("permutive-id", ".permutive.app", { sameSite: "Lax" })],
  }),
  req("https://sb.scorecardresearch.com/b2?c1=2&c2=6035083", {
    resourceType: "image",
    setCookies: [cookie("UID", ".scorecardresearch.com")],
  }),
  req("https://static.criteo.net/js/ld/publishertag.prebid.js"),
  req("https://bidder.criteo.com/cdb?profileId=207", {
    resourceType: "xmlhttprequest",
    setCookies: [cookie("uid", ".criteo.com"), cookie("cto_bundle", ".criteo.com")],
  }),
  req("https://s.go-mpulse.net/boomerang/9KTQ2-XYZ", {
    resourceType: "other",
    statusCode: null,
    responseHeaders: null,
    setCookies: [cookie("RT", "www.example-news.com", { via: "documentCookie" })],
    captureMethod: "documentCookie",
  }),
  req("https://cdn.cookielaw.org/scripttemplates/otSDKStub.js", { secGpcPresent: true }),
  req("https://www.example-news.com/assets/app.9f2a.js", {
    initiator: "https://www.example-news.com/",
    secGpcPresent: false,
  }),
  req("https://fonts.gstatic.com/s/inter/v13/font.woff2", { resourceType: "font" }),
  // Vendors in categories the headline does not count: listed, judged, never counted.
  req("https://www.facebook.com/tr?id=4410&ev=PageView", {
    resourceType: "image",
    setCookies: [cookie("fr", ".facebook.com")],
  }),
  req("https://techcrunch.com/wp-content/uploads/embed-card.png", { resourceType: "image" }),
];

/**
 * The vendors on the ad-dense page outside advertising and analytics, one for each kind of
 * row: a company also listed above (Google), a consent tool that read GPC, a company whose
 * cookie is listed and not counted (Meta), and one Disconnect names as an owner and gives
 * no category (Yahoo!, for techcrunch.com).
 */
const heavyOthers = [
  ["Google", "content", ["fonts.gstatic.com"], 4],
  ["OneTrust", "consent-managers", ["cdn.cookielaw.org"], 3],
  ["Meta", "social", ["www.facebook.com"], 2, { cookieKeys: [`fr\u0000.facebook.com`] }],
  ["Yahoo!", "unknown", ["techcrunch.com"], 1],
];

const heavy = () =>
  base({
    // Read attribution as a real busy page produces it: the count is complete, a fraction
    // of it was traced, and most of THAT lands nowhere nameable. One vendor (Permutive)
    // read the property and never called GPP.
    signal: {
      // The consent tool read it too, and so did the site's own script: the first is a
      // vendor in a category that does not count, the second is named by its domain.
      readsByScript: {
        "https://cdn.permutive.com/12ab/permutive.js": 7,
        "https://bidder.criteo.com/cdb": 2,
        "https://cdn.cookielaw.org/scripttemplates/otSDKStub.js": 3,
        "https://www.example-news.com/assets/app.9f2a.js": 1,
      },
      readAttribution: { sampled: 148, unattributed: 92, viaTagManager: 43 },
    },
    network: heavyNetwork,
    otherVendors: heavyOthers,
    consentApiCalls: [
      { api: "__gpp", command: "getGPPData", callerScriptUrl: null, viaTagManager: true, timeMs: 1 },
      { api: "__uspapi", command: "getUSPData", callerScriptUrl: "https://bidder.criteo.com/cdb", viaTagManager: false, timeMs: 2 },
      { api: "__tcfapi", command: "getTCData", callerScriptUrl: "https://cdn.permutive.com/12ab/permutive.js", viaTagManager: false, timeMs: 3 },
    ],
    gpp: {
      rawString: "DBABzw~1YNN~BVQqAAAAAgA.QA",
      applicableSections: [7, 8],
      gppVersion: "1.1",
      sections: {
        usnat: { Gpc: 1, SaleOptOut: 2, SharingOptOut: 2, TargetedAdvertisingOptOut: 2, MspaCoveredTransactions: 1, MspaServiceProviderMode: 2 },
        usca: { Gpc: 1, SaleOptOut: 2, SharingOptOut: 2 },
      },
      unparseable: false,
      fromWire: "DBABzw~1YNN~BVQqAAAAAgA.QA",
    },
    // The most recent request carried the page's own string, and earlier ones did not: the
    // disagreement stays on screen (1.29.0), and the panel lists each other string.
    usPrivacy: {
      fromApi: "1YNN",
      fromCookie: "1YNN",
      fromWire: "1YNN",
      fromWireHost: "securepubads.g.doubleclick.net",
      wireValues: [
        { value: "1YNY", hosts: ["bidder.criteo.com", "fastlane.rubiconproject.com"] },
        { value: "1YNN", hosts: ["securepubads.g.doubleclick.net"] },
        { value: "1---", hosts: ["ads.pubmatic.com"] },
      ],
    },
    tcf: {
      tcString: "CQJAbcAQJAbcAAKA1AENBhFgAP_gAAAAAAYgJ2pB",
      gdprApplies: false,
      purposeConsents: { 1: true, 2: false, 3: false, 4: false, 7: true, 9: false, 10: false },
    },
    gtm: {
      present: true,
      containerIds: ["GTM-WKX4T9"],
      gtagIds: ["G-8QZ1MK", "AW-449201"],
      consentMode: {
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
        analytics_storage: "granted",
        functionality_storage: "granted",
        personalization_storage: "unspecified",
        security_storage: "granted",
      },
    },
    confirmationNotice: "not-detected",
    wellKnown: {
      url: "https://www.example-news.com/.well-known/gpc.json",
      present: true,
      gpc: true,
      lastUpdate: "2026-01-14",
      observedAtMs: Date.now(),
      fresh: true,
      reason: null,
    },
    tallies: {
      totalRequests: 431,
      signedRequests: 418,
      adVendorRequests: 187,
      adCookieEvents: 34,
      // Every category the vendor list labels: advertising only, Google in both, and the
      // analytics vendors after them. Criteo's cto_bundle on two domains is two cookies.
      ...counted([
        ["IDE", ".doubleclick.net", "Google", "advertising"],
        ["TDID", ".adsrvr.org", "The Trade Desk", "advertising"],
        ["TDCPM", ".adsrvr.org", "The Trade Desk", "advertising"],
        ["uid", ".criteo.com", "Criteo", "advertising"],
        ["cto_bundle", ".criteo.com", "Criteo", "advertising"],
        ["cto_bundle", ".example-news.com", "Criteo", "advertising"],
        ["UID", ".scorecardresearch.com", "comScore", "analytics"],
        ["permutive-id", ".permutive.app", "Permutive", "advertising"],
        ["mc", ".quantserve.com", "Quantcast", "advertising"],
        ["RT", ".go-mpulse.net", "Akamai", "analytics"],
      ]),
      firstPartyVendorCookieKeys: [K("RT", "www.example-news.com"), K("_ga", "www.example-news.com")],
      // Ad and analytics vendors only, as the tally keeps them: OneTrust's CMP is on the page
      // and in the requests, never in this list.
      byEntity: {
        Google: { requests: 96, signedRequests: 96, cookieNames: ["IDE"], cookiesReturned: ["IDE"], hosts: ["securepubads.g.doubleclick.net", "www.googletagmanager.com", "www.google-analytics.com"] },
        "The Trade Desk": { requests: 22, signedRequests: 22, cookieNames: ["TDID", "TDCPM"], cookiesReturned: ["TDID"], hosts: ["insight.adsrvr.org", "match.adsrvr.org"] },
        Criteo: { requests: 18, signedRequests: 18, cookieNames: ["uid", "cto_bundle"], cookiesReturned: [], hosts: ["static.criteo.net", "bidder.criteo.com"] },
        comScore: { requests: 5, signedRequests: 5, cookieNames: ["UID"], cookiesReturned: [], hosts: ["sb.scorecardresearch.com"] },
        Permutive: { requests: 14, signedRequests: 14, cookieNames: ["permutive-id"], cookiesReturned: [], hosts: ["cdn.permutive.com", "api.permutive.app"] },
        // In the counts with no retained request (the worker was reclaimed). Judged from the
        // summary since 1.13.0, so the name must be the one the classifier gives its host;
        // the "capture gaps" fixture keeps the old shape, which renders "Not captured".
        Quantcast: { requests: 9, signedRequests: 9, cookieNames: ["mc"], cookiesReturned: ["mc"], hosts: ["pixel.quantserve.com"], resourceTypes: ["image", "script"], scriptRan: true },
        Akamai: { requests: 6, signedRequests: 6, cookieNames: ["RT"], cookiesReturned: [], hosts: ["s.go-mpulse.net"] },
      },
    },
  });

// --- honored: ad tech present, nothing set. ---

const honored = () =>
  base({
    context: { finalUrl: "https://www.example-paper.com/", topSite: "example-paper.com" },
    network: [
      req("https://securepubads.g.doubleclick.net/tag/js/gpt.js"),
      req("https://www.googletagmanager.com/gtm.js?id=GTM-P2LM"),
      req("https://sb.scorecardresearch.com/b2?c1=2", { resourceType: "image" }),
    ],
    consentApiCalls: [
      { api: "__gpp", command: "getGPPData", callerScriptUrl: "https://securepubads.g.doubleclick.net/tag/js/gpt.js", viaTagManager: false, timeMs: 1 },
    ],
    gpp: {
      rawString: "DBABBg~BUoAAABY.QA",
      applicableSections: [8],
      gppVersion: "1.1",
      sections: { usca: { Gpc: 1, SaleOptOut: 1, SharingOptOut: 1 } },
      unparseable: false,
      fromWire: "DBABBg~BUoAAABY.QA",
    },
    gtm: { present: true, containerIds: ["GTM-P2LM"], gtagIds: [], consentMode: null },
    confirmationNotice: "detected",
    wellKnown: {
      url: "https://www.example-paper.com/.well-known/gpc.json",
      present: true,
      gpc: true,
      lastUpdate: "2026-03-02",
      observedAtMs: Date.now() - 1000 * 60 * 40,
      fresh: false,
      reason: null,
    },
    tallies: {
      totalRequests: 74,
      signedRequests: 74,
      adVendorRequests: 21,
      adCookieEvents: 0,
      adCookieKeys: [],
      firstPartyVendorCookieKeys: [],
      byEntity: {
        Google: { requests: 14, signedRequests: 14, cookieNames: [], cookiesReturned: [], hosts: ["securepubads.g.doubleclick.net", "www.googletagmanager.com"] },
        comScore: { requests: 7, signedRequests: 7, cookieNames: [], cookiesReturned: [], hosts: ["sb.scorecardresearch.com"] },
      },
    },
  });

// --- functional: a count that is partly load balancers and bot protection. ---
//
// retailer-a.example on the 2026-09-25 corpus run: Rokt's whole contribution was Akamai's
// load-balancer cookie on apps.rokt.com. The cookies are counted, and the ones whose name
// is on the list of functional cookie names are labeled. The site is behind Cloudflare
// too, and so is its consent tool: their __cf_bm is listed, not counted, and not labeled.

const functionalNetwork = [
  req("https://www.example-shop.com/", { resourceType: "main_frame", setCookies: [cookie("__cf_bm", ".example-shop.com")] }),
  req("https://dpm.demdex.net/id?d_visid_ver=5.2.0", { resourceType: "image", setCookies: [cookie("demdex", ".demdex.net")] }),
  req("https://cm.everesttech.net/cm/dd?d_uuid=88", { resourceType: "image", setCookies: [cookie("everest_g_v2", ".everesttech.net")] }),
  req("https://apps.rokt.com/wsdk/integrations/launcher.js"),
  req("https://apps.rokt.com/v1/placements", {
    resourceType: "xmlhttprequest",
    method: "POST",
    setCookies: [cookie("akaalb_Instance-1", "apps.rokt.com", { expiresMs: Date.now() + 1000 * 60 * 60 * 24 * 180 })],
    cookiesSent: ["akaalb_Instance-1"],
  }),
  req("https://lightboxcdn.com/vendor/0x1/lightbox_inline.js", { setCookies: [cookie("__cf_bm", ".lightboxcdn.com", { expiresMs: Date.now() + 1000 * 60 * 30 })] }),
  req("https://cdn.cookielaw.org/scripttemplates/otSDKStub.js", { setCookies: [cookie("__cf_bm", ".cookielaw.org", { expiresMs: Date.now() + 1000 * 60 * 30 })] }),
];

const functional = () =>
  base({
    context: { finalUrl: "https://www.example-shop.com/", topSite: "example-shop.com" },
    network: functionalNetwork,
    otherVendors: [["OneTrust", "consent-managers", ["cdn.cookielaw.org"], 1, { cookieKeys: [K("__cf_bm", ".cookielaw.org")] }]],
    signal: {
      readsByScript: { "https://cdn.cookielaw.org/scripttemplates/otSDKStub.js": 2 },
      readAttribution: { sampled: 2, unattributed: 0, viaTagManager: 0 },
      readCount: 2,
      secGpcRequestCount: 7,
      totalRequestCount: 7,
    },
    confirmationNotice: "not-detected",
    tallies: {
      totalRequests: 7,
      signedRequests: 7,
      adVendorRequests: 5,
      adCookieEvents: 4,
      ...counted([
        ["demdex", ".demdex.net", "Adobe", "advertising"],
        ["everest_g_v2", ".everesttech.net", "Adobe", "advertising"],
        ["akaalb_Instance-1", "apps.rokt.com", "Rokt", "advertising"],
        ["__cf_bm", ".lightboxcdn.com", "Digioh", "analytics"],
      ]),
      firstPartyVendorCookieKeys: [],
      byEntity: {
        Adobe: { requests: 2, signedRequests: 2, cookieNames: ["demdex", "everest_g_v2"], cookiesReturned: [], hosts: ["dpm.demdex.net", "cm.everesttech.net"] },
        Rokt: { requests: 2, signedRequests: 2, cookieNames: ["akaalb_Instance-1"], cookiesReturned: ["akaalb_Instance-1"], hosts: ["apps.rokt.com"] },
        Digioh: { requests: 1, signedRequests: 1, cookieNames: ["__cf_bm"], cookiesReturned: [], hosts: ["lightboxcdn.com"] },
      },
    },
  });

// --- clean: no third-party ad or analytics at all. ---

const clean = () =>
  base({
    context: { finalUrl: "https://en.encyclopedia-a.example/wiki/Privacy", topSite: "encyclopedia-a.example" },
    network: [
      req("https://en.encyclopedia-a.example/w/load.php?modules=startup", { initiator: "https://en.encyclopedia-a.example/" }),
      req("https://upload.encyclopedia-a-media.example/encyclopedia-a/commons/a/b/img.svg", { resourceType: "image" }),
    ],
    tallies: {
      totalRequests: 31,
      signedRequests: 31,
      adVendorRequests: 0,
      adCookieEvents: 0,
      adCookieKeys: [],
      firstPartyVendorCookieKeys: [],
      byEntity: {},
    },
  });

// --- requests-disagree: the page reported no US Privacy or GPP string of its own, and
// requests carried different ones (1.29.0). ---

const requestsDisagree = () => {
  const c = clean();
  return {
    ...c,
    usPrivacy: {
      fromApi: null,
      fromCookie: null,
      fromWire: "1YYN",
      fromWireHost: "securepubads.g.doubleclick.net",
      wireValues: [
        { value: "1---", hosts: ["pixel.rubiconproject.com", "gum.criteo.com"] },
        { value: "1YYN", hosts: ["securepubads.g.doubleclick.net"] },
      ],
    },
    gpp: {
      rawString: "",
      applicableSections: [],
      gppVersion: null,
      sections: {},
      unparseable: false,
      fromWire: "DBABBg~BUoAAABY.QA",
      fromWireHost: "ads.pubmatic.com",
      wireValues: [
        { value: "DBABBg~BUUAAACA.YA", hosts: ["fastlane.rubiconproject.com"] },
        { value: "DBABBg~BUoAAABY.QA", hosts: ["ads.pubmatic.com"] },
      ],
    },
  };
};

// --- needs-reload: the tab was open before the extension was installed or updated. Only
// the requests it made afterwards were seen, and no content script ran in the page. ---

const needsReload = () =>
  base({
    context: { finalUrl: "https://www.example-news.com/live", topSite: "example-news.com", loadObserved: false },
    network: [
      req("https://www.example-news.com/api/live?since=1", { resourceType: "xmlhttprequest" }),
      req("https://securepubads.g.doubleclick.net/gampad/ads?refresh=1", { resourceType: "xmlhttprequest" }),
    ],
    signal: { source: "none", propertyValue: false, readCount: 0, secGpcRequestCount: 2, totalRequestCount: 2 },
    wellKnown: null,
  });

// --- new-tab: the browser's new tab page. No content script runs in it and the worker keeps
// no site for it, but the requests the page makes still reach the tab's record. Drawn with
// the tab's address (TAB_ADDRESSES), as the popup reads it from the tab. ---

const newTab = () =>
  base({
    context: { finalUrl: "", topSite: "", loadObserved: false },
    network: [
      req("https://www.google.com/async/newtab_promos", { resourceType: "xmlhttprequest", initiator: "chrome://new-tab-page" }),
      req("https://www.gstatic.com/og/_/js/k=og.qtm.en_US/rt=j", { initiator: "chrome://new-tab-page" }),
      req("https://www.gstatic.com/images/branding/googlelogo/svg/googlelogo_clr_74x24px.svg", { resourceType: "image", initiator: "chrome://new-tab-page" }),
    ],
    signal: { source: "none", propertyValue: false, readCount: 0, secGpcRequestCount: 3, totalRequestCount: 3 },
    wellKnown: null,
  });

// --- browser-page: one of the browser's own pages (chrome://settings). The worker clears the
// tab's record when it navigates there, and nothing reaches it after. ---

const browserPage = () =>
  base({
    context: { finalUrl: "", topSite: "", loadObserved: false },
    signal: { source: "none", propertyValue: false, readCount: 0, secGpcRequestCount: 0, totalRequestCount: 0 },
    wellKnown: null,
  });

// --- restored: a page brought back from the back/forward cache (1.39.0). Its load happened
// under an earlier capture; its own signal report, from that load, still holds. ---

const restored = () =>
  base({
    context: { finalUrl: "https://www.example-news.com/live", topSite: "example-news.com", loadObserved: false, restoredFromCache: true },
    network: [req("https://www.example-news.com/api/live?since=2", { resourceType: "xmlhttprequest" })],
    signal: { source: "this-extension", propertyValue: true, readCount: 0, secGpcRequestCount: 1, totalRequestCount: 1 },
    wellKnown: null,
  });

// --- unavailable: capture capabilities failed. The amber surface. ---

const unavailable = () =>
  base({
    context: { finalUrl: "https://shop.example.com/", topSite: "example.com", incomplete: true },
    network: heavyNetwork.slice(0, 6),
    // A capture from before the summaries: one row for each company in each category its
    // cookies and hostnames give it, and nothing outside advertising and analytics.
    summaries: false,
    capabilities: { documentCookie: false, cookieStore: true, gpp: false, uspapi: true, tcfapi: true, dataLayer: false },
    signal: { readTracking: "unavailable", readCount: null },
    gtm: { present: true, containerIds: ["GTM-QQ11"], gtagIds: [], consentMode: null },
    wellKnown: null,
    tallies: {
      totalRequests: 210,
      signedRequests: 198,
      adVendorRequests: 64,
      adCookieEvents: 5,
      ...counted([
        ["IDE", ".doubleclick.net", "Google", "advertising"],
        ["TDID", ".adsrvr.org", "The Trade Desk", "advertising"],
      ]),
      firstPartyVendorCookieKeys: [],
      byEntity: {
        Google: { requests: 40, signedRequests: 40, cookieNames: ["IDE"], cookiesReturned: [], hosts: ["securepubads.g.doubleclick.net"] },
        "The Trade Desk": { requests: 8, signedRequests: 8, cookieNames: ["TDID"], cookiesReturned: [], hosts: ["insight.adsrvr.org"] },
      },
    },
  });

// --- mismatch: we sent GPC, the site's string recorded that it saw none. ---
//
// The mismatch hides itself: gpp-conflict needs Gpc = 1, so a string that never registered
// the signal cannot show the conflict at all, and every vendor that asked via GPP was told
// nothing.

const mismatch = () =>
  base({
    context: { finalUrl: "https://www.example-news.com/", topSite: "example-news.com" },
    network: heavyNetwork,
    otherVendors: heavyOthers,
    signal: {
      readsByScript: { "https://cdn.permutive.com/12ab/permutive.js": 4 },
      readAttribution: { sampled: 96, unattributed: 71, viaTagManager: 21 },
    },
    consentApiCalls: [
      { api: "__gpp", command: "getGPPData", callerScriptUrl: "https://bidder.criteo.com/cdb", viaTagManager: false, timeMs: 2 },
    ],
    gpp: {
      rawString: "DBABzw~1YNN~BAAAAAAAAgA.QA",
      applicableSections: [8],
      gppVersion: "1.1",
      sections: { usca: { Gpc: 0, SaleOptOut: 2, SharingOptOut: 2 } },
      unparseable: false,
      fromWire: null,
    },
    gtm: { present: true, containerIds: ["GTM-QQ11"], gtagIds: ["G-4XYZ"], consentMode: null },
    tallies: {
      totalRequests: 431,
      signedRequests: 418,
      adVendorRequests: 96,
      adCookieEvents: 12,
      ...counted([
        ["IDE", ".doubleclick.net", "Google", "advertising"],
        ["TDID", ".adsrvr.org", "The Trade Desk", "advertising"],
      ]),
      firstPartyVendorCookieKeys: [],
      byEntity: {
        Google: { requests: 40, signedRequests: 40, cookieNames: ["IDE"], cookiesReturned: [], hosts: ["securepubads.g.doubleclick.net"] },
        "The Trade Desk": { requests: 8, signedRequests: 8, cookieNames: ["TDID"], cookiesReturned: [], hosts: ["insight.adsrvr.org"] },
        Criteo: { requests: 6, signedRequests: 6, cookieNames: [], cookiesReturned: [], hosts: ["bidder.criteo.com"] },
      },
    },
  });

// --- direct: no tag manager at all. The states that only exist without a container. ---
//
// "No check seen" and "No check on the page" are mutually exclusive on one page — the
// second needs a container and the first needs none — so the full set of vendor states
// cannot be shown on a single capture. This is the container-free half.

const directNetwork = [
  // Criteo: script ran, called GPP attributably, and the string records GPC -> "Asked via GPP".
  req("https://static.criteo.net/js/ld/publishertag.prebid.js"),
  req("https://bidder.criteo.com/cdb?profileId=207", {
    resourceType: "xmlhttprequest",
    setCookies: [cookie("uid", ".criteo.com")],
  }),
  // Permutive: script ran, read the property, never called GPP -> "Read GPC property".
  req("https://cdn.permutive.com/12ab/permutive.js"),
  req("https://api.permutive.app/v2/identify", {
    resourceType: "xmlhttprequest",
    method: "POST",
    setCookies: [cookie("permutive-id", ".permutive.app", { sameSite: "Lax" })],
  }),
  // The Trade Desk: script ran, neither mechanism attributable -> "No check seen".
  req("https://insight.adsrvr.org/bid", {
    resourceType: "xmlhttprequest",
    setCookies: [cookie("TDID", ".adsrvr.org")],
  }),
  // comScore: a pixel and nothing else -> "No script ran".
  req("https://sb.scorecardresearch.com/b2?c1=2", {
    resourceType: "image",
    setCookies: [cookie("UID", ".scorecardresearch.com")],
  }),
];

const direct = () =>
  base({
    context: { finalUrl: "https://www.example-news.com/", topSite: "example-news.com" },
    network: directNetwork,
    signal: {
      readCount: 7400,
      readsByScript: { "https://cdn.permutive.com/12ab/permutive.js": 5 },
      // Past the read-trace cap (5,000 traced, then one in sixteen): the no-read state says a
      // read may have been missed and points at the setting.
      readAttribution: { sampled: 5150, unattributed: 40, viaTagManager: 0, traceCapReached: true },
    },
    consentApiCalls: [
      { api: "__gpp", command: "getGPPData", callerScriptUrl: "https://bidder.criteo.com/cdb", viaTagManager: false, timeMs: 2 },
    ],
    gpp: {
      rawString: "DBABzw~1YNN~BVQqAAAAAgA.QA",
      applicableSections: [8],
      gppVersion: "1.1",
      sections: { usca: { Gpc: 1, SaleOptOut: 2, SharingOptOut: 2 } },
      unparseable: false,
      fromWire: null,
    },
    gtm: { present: false, containerIds: [], gtagIds: [], consentMode: null },
    tallies: {
      totalRequests: 96,
      signedRequests: 96,
      adVendorRequests: 22,
      adCookieEvents: 3,
      ...counted([
        ["uid", ".criteo.com", "Criteo", "advertising"],
        ["TDID", ".adsrvr.org", "The Trade Desk", "advertising"],
        ["UID", ".scorecardresearch.com", "comScore", "analytics"],
        ["permutive-id", ".permutive.app", "Permutive", "advertising"],
        ["ts", ".tracker.example", undefined, "advertising"],
      ]),
      firstPartyVendorCookieKeys: [],
      byEntity: {
        Criteo: { requests: 6, signedRequests: 6, cookieNames: ["uid"], cookiesReturned: [], hosts: ["bidder.criteo.com"] },
        "The Trade Desk": { requests: 4, signedRequests: 4, cookieNames: ["TDID"], cookiesReturned: [], hosts: ["insight.adsrvr.org"] },
        Permutive: { requests: 5, signedRequests: 5, cookieNames: ["permutive-id"], cookiesReturned: [], hosts: ["cdn.permutive.com", "api.permutive.app"] },
        comScore: { requests: 2, signedRequests: 2, cookieNames: ["UID"], cookiesReturned: [], hosts: ["sb.scorecardresearch.com"] },
      },
    },
  });

// --- quiet container: a container runs and nothing on the page checked GPC at all. ---
//
// A container present, zero GPC checks page-wide, and a vendor whose own script ran
// regardless.
//
// The vendor is Microsoft's UET tag here and in the two provenance fixtures below: Disconnect
// files bat.bing.com as Advertising, and bat.js writes _uetvid into the site's own jar. Not
// Meta's pixel: Disconnect files facebook.net as Social, so a real capture never tallies it.

const quietContainer = () =>
  base({
    context: { finalUrl: "https://shop.example.com/", topSite: "example.com" },
    network: [
      req("https://www.googletagmanager.com/gtm.js?id=GTM-QQ11"),
      req("https://bat.bing.com/bat.js"),
      req("https://bat.bing.com/action/0?ti=5100011&evt=pageLoad", {
        resourceType: "image",
        setCookies: [cookie("_uetvid", "shop.example.com", { via: "documentCookie" })],
      }),
      req("https://static.criteo.net/js/ld/publishertag.prebid.js"),
    ],
    signal: {
      readCount: 12,
      readsByScript: {},
      readAttribution: { sampled: 12, unattributed: 12, viaTagManager: 0 },
    },
    consentApiCalls: [],
    gpp: null,
    gtm: { present: true, containerIds: ["GTM-QQ11"], gtagIds: [], consentMode: null },
    tallies: {
      totalRequests: 58,
      signedRequests: 58,
      adVendorRequests: 9,
      adCookieEvents: 1,
      ...counted([["_uetvid", "shop.example.com", "Microsoft", "advertising"]]),
      firstPartyVendorCookieKeys: [K("_uetvid", "shop.example.com")],
      byEntity: {
        Microsoft: { requests: 3, signedRequests: 3, cookieNames: ["_uetvid"], cookiesReturned: [], hosts: ["bat.bing.com"] },
      },
    },
  });

/**
 * Two containers on one page, and only one of them checked. The checked row names the
 * container, and the footer becomes one line per container so the reader can see which
 * one the vendor rows are about. The Google tag under the first container gets its own
 * line, since checks are counted under the innermost frame.
 */
const twoContainers = () =>
  base({
    context: { finalUrl: "https://www.example-news.com/", topSite: "example-news.com" },
    network: [
      req("https://www.googletagmanager.com/gtm.js?id=GTM-AAA111"),
      req("https://www.googletagmanager.com/gtm.js?id=GTM-BBB222&l=NF2DL"),
      req("https://www.googletagmanager.com/gtag/js?id=G-CCC333"),
      req("https://bat.bing.com/bat.js"),
      req("https://static.criteo.net/js/ld/publishertag.prebid.js"),
      req("https://bat.bing.com/action/0?ti=5100011&evt=pageLoad", {
        resourceType: "image",
        setCookies: [cookie("_uetvid", "example-news.com", { via: "documentCookie" })],
      }),
    ],
    signal: {
      readCount: 260,
      readsByScript: {},
      readAttribution: {
        sampled: 32,
        unattributed: 4,
        viaTagManager: 28,
        viaTagManagerByContainer: {
          "https://www.googletagmanager.com/gtm.js?id=GTM-AAA111": 22,
          "https://www.googletagmanager.com/gtag/js?id=G-CCC333": 6,
        },
      },
    },
    consentApiCalls: [
      {
        api: "__gpp",
        command: "getGPPData",
        callerScriptUrl: "https://www.googletagmanager.com/gtm.js?id=GTM-AAA111",
        viaTagManager: true,
        containerUrls: ["https://www.googletagmanager.com/gtm.js?id=GTM-AAA111"],
        timeMs: Date.now(),
      },
    ],
    gpp: null,
    gtm: {
      present: true,
      containerIds: ["GTM-AAA111", "GTM-BBB222"],
      gtagIds: ["G-CCC333"],
      consentMode: null,
      consentModeDefaultSetBy: null,
      consentModeUpdateSetBy: "https://www.googletagmanager.com/gtm.js?id=GTM-AAA111",
      effectiveConsent: { ad_storage: { implicit: true }, analytics_storage: { implicit: true, update: false } },
    },
    // Provenance: Microsoft's UET tag inserted by the first container, Criteo by the site's
    // own bundle, the Google tag a child of the first container.
    scriptInsertions: [
      insertion("https://bat.bing.com/bat.js", loaderBy(["https://www.googletagmanager.com/gtm.js?id=GTM-AAA111"], ["https://www.googletagmanager.com/gtm.js?id=GTM-AAA111"])),
      insertion("https://static.criteo.net/js/ld/publishertag.prebid.js", loaderBy(["https://www.example-news.com/static/app.js"], [])),
      insertion("https://www.googletagmanager.com/gtag/js?id=G-CCC333", loaderBy(["https://www.googletagmanager.com/gtm.js?id=GTM-AAA111"], ["https://www.googletagmanager.com/gtm.js?id=GTM-AAA111"])),
    ],
    scriptInsertionCoverage: coverage(),
    tallies: {
      totalRequests: 96,
      signedRequests: 96,
      adVendorRequests: 14,
      adCookieEvents: 1,
      ...counted([["_uetvid", "example-news.com", "Microsoft", "advertising"]]),
      firstPartyVendorCookieKeys: [K("_uetvid", "example-news.com")],
      byEntity: {
        Microsoft: { requests: 3, signedRequests: 3, cookieNames: ["_uetvid"], cookiesReturned: [], hosts: ["bat.bing.com"] },
        Criteo: { requests: 2, signedRequests: 2, cookieNames: [], cookiesReturned: [], hosts: ["static.criteo.net"] },
      },
    },
  });

/**
 * A zone and a bidder chain. The root container loads a child container and a
 * header-bidding wrapper; the child inserts Comscore, the wrapper inserts Criteo, and
 * the wrapper itself checked GPC. Microsoft's tag is loaded by the child AND by the site:
 * mixed.
 */
const zone = () => {
  const ROOT = "https://www.googletagmanager.com/gtm.js?id=GTM-ROOT01";
  const CHILD = "https://www.googletagmanager.com/gtm.js?id=GTM-CHILD1";
  const WRAPPER = "https://c.amazon-adsystem.com/aax2/apstag.js";
  return base({
    context: { finalUrl: "https://www.example-news.com/", topSite: "example-news.com" },
    network: [
      req(ROOT),
      req(CHILD),
      req(WRAPPER),
      req("https://sb.scorecardresearch.com/beacon.js"),
      req("https://static.criteo.net/js/ld/publishertag.prebid.js"),
      req("https://bat.bing.com/bat.js"),
      req("https://bat.bing.com/action/0?ti=5100011&evt=pageLoad", {
        resourceType: "image",
        setCookies: [cookie("_uetvid", "example-news.com", { via: "documentCookie" })],
      }),
    ],
    signal: {
      readCount: 90,
      readsByScript: {},
      readAttribution: { sampled: 20, unattributed: 2, viaTagManager: 18, viaTagManagerByContainer: { [ROOT]: 18 } },
    },
    consentApiCalls: [
      { api: "__gpp", command: "getGPPData", callerScriptUrl: WRAPPER, viaTagManager: false, containerUrls: [], timeMs: Date.now() },
    ],
    gpp: null,
    gtm: { present: true, containerIds: ["GTM-ROOT01", "GTM-CHILD1"], gtagIds: [], consentMode: null },
    scriptInsertions: [
      insertion(CHILD, loaderBy([ROOT], [ROOT])),
      insertion(WRAPPER, loaderBy([ROOT], [ROOT])),
      insertion("https://sb.scorecardresearch.com/beacon.js", loaderBy([CHILD], [CHILD])),
      insertion("https://static.criteo.net/js/ld/publishertag.prebid.js", loaderBy([WRAPPER], [])),
      insertion("https://bat.bing.com/bat.js", loaderBy([CHILD], [CHILD]), loaderBy([], [], { via: "parser", timeMs: 1 })),
    ],
    scriptInsertionCoverage: coverage(),
    tallies: {
      totalRequests: 120,
      signedRequests: 120,
      adVendorRequests: 22,
      adCookieEvents: 1,
      ...counted([["_uetvid", "example-news.com", "Microsoft", "advertising"]]),
      firstPartyVendorCookieKeys: [K("_uetvid", "example-news.com")],
      byEntity: {
        Microsoft: { requests: 3, signedRequests: 3, cookieNames: ["_uetvid"], cookiesReturned: [], hosts: ["bat.bing.com"] },
        Criteo: { requests: 2, signedRequests: 2, cookieNames: [], cookiesReturned: [], hosts: ["static.criteo.net"] },
        comScore: { requests: 2, signedRequests: 2, cookieNames: [], cookiesReturned: [], hosts: ["sb.scorecardresearch.com"] },
        Amazon: { requests: 4, signedRequests: 4, cookieNames: [], cookiesReturned: [], hosts: ["c.amazon-adsystem.com"] },
      },
    },
  });
};

/**
 * The ad-heavy page with sending off. The panel renders in full so two visits can be
 * compared; the cookie count is the one thing withheld, and the checked row should not say
 * "not told" about a string that correctly reads 0.
 */
const signalOff = () => {
  const f = heavy();
  return {
    ...f,
    signal: { ...f.signal, source: "none", propertyValue: false, secGpcRequestCount: 0 },
    // Everything that was signed is unsigned on this visit.
    tallies: {
      ...f.tallies,
      signedRequests: 0,
      adCookieEvents: 0,
      adCookieKeys: [],
      adCookieEventsUnsigned: f.tallies.adCookieEvents,
      adCookieKeysUnsigned: f.tallies.adCookieKeys,
      byEntity: Object.fromEntries(
        Object.entries(f.tallies.byEntity).map(([k, e]) => [
          k,
          { ...e, signedRequests: 0, cookieNames: [], cookieNamesUnsigned: e.cookieNames },
        ]),
      ),
      byEntityCategory: Object.fromEntries(
        Object.entries(f.tallies.byEntityCategory).map(([k, p]) => [
          k,
          { ...p, signedRequests: 0, cookieKeys: [], cookieKeysUnsigned: p.cookieKeys },
        ]),
      ),
    },
    gpp: {
      ...f.gpp,
      sections: {
        usnat: { ...f.gpp.sections.usnat, Gpc: 0 },
        usca: { ...f.gpp.sections.usca, Gpc: 0 },
      },
    },
  };
};

// --- incomplete, by reason (1.22.0). The heavy page with one reason each. ---

/** The heavy page with the capture marked incomplete for these reasons. */
const incompleteFor = (reasons, over = {}) => () => {
  const f = heavy();
  return { ...f, ...over, context: { ...f.context, incomplete: true, incompleteReasons: reasons } };
};

// The worker was reclaimed: the list is gone and everything else stayed, the cookie details
// included. Nothing on the Overview; one line on the Requests tab. Shaped first, as a
// capture is before its list goes, then emptied.
const reclaimed = () => {
  const f = withPersistedShape(heavy());
  return { ...f, network: [], context: { ...f.context, incomplete: true, incompleteReasons: ["worker-restarted"] } };
};
// The same, with the requests that set a cookie kept past the reclaim (1.27.0): each made by
// the worker's own toKept, so a container's `?id=` stays on its URL and a writer's URL loses
// its query, as they do live. Then with the later half dropped to make room.
const keptOf = (network) => network.filter((n) => n.setCookies.length > 0).map(toKept);
const reclaimedKept = () => ({ ...reclaimed(), keptCookieResponses: keptOf(heavy().network) });
const reclaimedSomeKept = () => {
  const kept = keptOf(heavy().network);
  return { ...reclaimed(), keptCookieResponses: kept.slice(0, Math.ceil(kept.length / 2)), keptCookieResponsesIncomplete: true };
};
const saveFailed = incompleteFor(["write-failed"]);
// A prerendered page shown after the worker that held its load had stopped (1.38.0).
const prerenderLost = incompleteFor(["prerender-lost"]);
const deliveryGap = incompleteFor(["delivery-gap"]);
const consentCapped = incompleteFor(["consent-calls-capped"]);

// --- containers: tag containers as automaker-e.example ran them (1.25.0) ---
//
// A Tealium profile loaded by the site, whose tags wrote Adobe's names beside Tealium's own
// (only Tealium's counts), loaded Snap and a script from a domain no company is named for,
// and sent requests to Adobe and Snap; a GTM container loaded by the site that read GPC and
// loaded two Google tag ids; one of those ids loaded by Tealium too; and an id the loader
// scan found with nothing recorded. Google's consent store holds implicit values only, so
// Google Consent Mode reads "not set".

const SITE_JS = "https://www.example-autos.com/assets/app.js";
const UTAG = "https://tags.tiqcdn.com/utag/example/autos/prod/utag.js";
const GTM_AUTOS = "https://www.googletagmanager.com/gtm.js?id=GTM-EX4MPL3";
const GTAG_G = "https://www.googletagmanager.com/gtag/js?id=G-EX4MPL3R5";
const GTAG_AW = "https://www.googletagmanager.com/gtag/js?id=AW-448210";
const SNAP = "https://sc-static.net/scevent.min.js";
const UNLISTED = "https://cdn.example-autos-cdn.net/lib/loader.js";

/** A cookie a page script wrote: its observation is the writer's, with no response. */
const written = (writer, cookies) =>
  req(writer, {
    method: "SCRIPT", resourceType: "other", statusCode: null, responseHeaders: null, requestHeaders: [],
    captureMethod: "documentCookie",
    setCookies: cookies.map(([name, domain]) => cookie(name, domain, { via: "documentCookie", writerScriptUrl: writer, expiresMs: "session", sameSite: "Lax", secure: false })),
  });
/** A detail as the worker keeps one (1.22.0), with the writer's container (1.25.0). */
const detailOf = (host, container, signedId, over = {}) => ({
  expiresMs: "session", sameSite: "Lax", secure: false, partitioned: false, via: "documentCookie", host,
  onRedirect: false, onRedirectSigned: false, firstSignedObservationId: signedId, ...(container ? { container } : {}), ...over,
});
const containerTally = (manager, id, frame, keys) => ({
  manager, id, frameUrls: [frame], cookieKeys: keys, cookieKeysUnsigned: [], probeCookies: [], refusedWrites: [],
});

const containers = () => {
  const AUTOS = ".example-autos.com";
  const network = [
    req(GTM_AUTOS),
    req(UTAG),
    req(GTAG_G),
    req(GTAG_AW),
    req(SNAP),
    req("https://dpm.demdex.net/id?d_visid_ver=5.4.0", { resourceType: "xmlhttprequest", setCookies: [cookie("demdex", ".demdex.net")] }),
    req("https://tr.snapchat.com/p", { resourceType: "image" }),
    req("https://region1.google-analytics.com/g/collect?v=2&tid=G-EX4MPL3R5", { resourceType: "ping", statusCode: 204 }),
    req("https://googleads.g.doubleclick.net/pagead/viewthroughconversion/448210/", { resourceType: "image" }),
    written(UTAG, [["utag_main_ses_id", AUTOS], ["AMCV_4F2A1C%40AdobeOrg", AUTOS], ["s_cc", AUTOS]]),
    written(GTAG_G, [["_ga", AUTOS], ["_ga_EX4MPL3R5", AUTOS]]),
    written(GTAG_AW, [["_gcl_au", AUTOS]]),
    written(SNAP, [["_scid", AUTOS]]),
  ];
  const idOf = (url) => network.find((n) => n.url === url && n.method !== "SCRIPT")?.id ?? null;
  const jsId = (writer) => network.find((n) => n.url === writer && n.method === "SCRIPT")?.id ?? null;
  const bySite = loaderBy([SITE_JS], []);
  const inside = (frame, over = {}) => loaderBy([frame], [frame], over);
  return base({
    context: { finalUrl: "https://www.example-autos.com/us/en", topSite: "example-autos.com" },
    signal: {
      readAttribution: { sampled: 40, unattributed: 19, viaTagManager: 21, viaTagManagerByContainer: { [GTM_AUTOS]: 18, [UTAG]: 3 } },
    },
    network,
    capabilities: { scriptInsertion: true, requestInitiation: true },
    scriptInsertions: [
      insertion(GTM_AUTOS, bySite),
      insertion(UTAG, bySite),
      insertion(GTAG_G, inside(GTM_AUTOS), inside(UTAG)),
      insertion(GTAG_AW, inside(GTM_AUTOS)),
      insertion(SNAP, inside(UTAG)),
      insertion(UNLISTED, inside(UTAG)),
    ],
    scriptInsertionCoverage: coverage(),
    requestInitiators: [
      insertion("https://dpm.demdex.net/id?d_visid_ver=5.4.0", inside(UTAG, { via: "fetch" })),
      insertion("https://tr.snapchat.com/p", inside(UTAG, { via: "src" })),
      insertion("https://region1.google-analytics.com/g/collect?v=2&tid=G-EX4MPL3R5", inside(GTAG_G, { via: "sendBeacon" })),
      insertion("https://googleads.g.doubleclick.net/pagead/viewthroughconversion/448210/", inside(GTAG_AW, { via: "src" })),
    ],
    gtm: {
      present: true,
      containerIds: ["GTM-EX4MPL3", "GTM-QU13T7"],
      gtagIds: ["G-EX4MPL3R5", "AW-448210"],
      consentMode: null,
      effectiveConsent: { ad_storage: { implicit: true }, ad_user_data: { implicit: true }, ad_personalization: { implicit: true }, analytics_storage: { implicit: true } },
      scriptFetched: true,
    },
    confirmationNotice: "detected",
    tallies: {
      totalRequests: 212,
      signedRequests: 212,
      adVendorRequests: 64,
      adCookieEvents: 6,
      ...counted([
        ["demdex", ".demdex.net", "Adobe", "advertising"],
        ["_scid", AUTOS, "Snap", "advertising"],
        ["_gcl_au", AUTOS, "Google", "advertising"],
        ["utag_main_ses_id", AUTOS, "Tealium", "analytics"],
        ["_ga", AUTOS, "Google", "analytics"],
        ["_ga_EX4MPL3R5", AUTOS, "Google", "analytics"],
      ]),
      firstPartyVendorCookieKeys: [],
      byEntity: {
        Adobe: { requests: 6, signedRequests: 6, cookieNames: ["demdex"], cookiesReturned: [], hosts: ["dpm.demdex.net"] },
        Snap: { requests: 5, signedRequests: 5, cookieNames: ["_scid"], cookiesReturned: [], hosts: ["sc-static.net", "tr.snapchat.com"] },
        Tealium: { requests: 14, signedRequests: 14, cookieNames: ["utag_main_ses_id"], cookiesReturned: [], hosts: ["tags.tiqcdn.com"] },
        // Its own names written inside its tags mark its code as run (1.25.0), as the worker does.
        Google: { requests: 11, signedRequests: 11, cookieNames: ["_ga", "_ga_EX4MPL3R5", "_gcl_au"], cookiesReturned: [], hosts: ["region1.google-analytics.com", "googleads.g.doubleclick.net"], scriptRan: true },
      },
      cookieDetails: {
        [K("demdex", ".demdex.net")]: detailOf("dpm.demdex.net", null, idOf("https://dpm.demdex.net/id?d_visid_ver=5.4.0"), { via: "onHeadersReceived", expiresMs: Date.now() + 180 * 86_400_000, sameSite: "None", secure: true }),
        [K("_scid", AUTOS)]: detailOf("sc-static.net", null, jsId(SNAP)),
        [K("utag_main_ses_id", AUTOS)]: detailOf("tags.tiqcdn.com", "tealium:example/autos", jsId(UTAG)),
        [K("AMCV_4F2A1C%40AdobeOrg", AUTOS)]: detailOf("tags.tiqcdn.com", "tealium:example/autos", null, { expiresMs: Date.now() + 400 * 86_400_000 }),
        // Written and removed again a moment later, in another task: set, and listed.
        [K("s_cc", AUTOS)]: detailOf("tags.tiqcdn.com", "tealium:example/autos", null, { removedAfterMs: 400 }),
        [K("_ga", AUTOS)]: detailOf("www.googletagmanager.com", "gtag:G-EX4MPL3R5", jsId(GTAG_G), { expiresMs: Date.now() + 400 * 86_400_000 }),
        [K("_ga_EX4MPL3R5", AUTOS)]: detailOf("www.googletagmanager.com", "gtag:G-EX4MPL3R5", jsId(GTAG_G), { expiresMs: Date.now() + 400 * 86_400_000 }),
        [K("_gcl_au", AUTOS)]: detailOf("www.googletagmanager.com", "gtag:AW-448210", jsId(GTAG_AW), { expiresMs: Date.now() + 90 * 86_400_000 }),
      },
      byContainer: {
        "gtag:AW-448210": containerTally("gtag", "AW-448210", GTAG_AW, [K("_gcl_au", AUTOS)]),
        "gtag:G-EX4MPL3R5": containerTally("gtag", "G-EX4MPL3R5", GTAG_G, [K("_ga", AUTOS), K("_ga_EX4MPL3R5", AUTOS)]),
        "tealium:example/autos": containerTally("tealium", "example/autos", UTAG, [K("AMCV_4F2A1C%40AdobeOrg", AUTOS), K("s_cc", AUTOS), K("utag_main_ses_id", AUTOS)]),
      },
    },
  });
};

// The containers page after a worker reclaim: the request list is gone, and the rows are not.
const containersReclaimed = () => {
  const f = withPersistedShape(containers());
  return { ...f, network: [], context: { ...f.context, incomplete: true, incompleteReasons: ["worker-restarted"] } };
};

// --- sevenTags: one container that loaded seven Google tag ids, as retailer-m.example ran it ---
//
// The Google tag's row holds seven ids, which have to wrap at 320px. One consent type of
// four is granted: analytics_storage, by an update over a denied default. The container sent
// the update, and nothing on the row says so.

const GTM_SHOP = "https://www.googletagmanager.com/gtm.js?id=GTM-XRTM100";
const SHOP_TAGS = ["G-XRTM1000", "G-XRTM4000", "AW-71100000", "AW-71200000", "AW-7130000", "AW-7140000", "AW-7150000"];
const gtagUrl = (id) => `https://www.googletagmanager.com/gtag/js?id=${id}`;

const sevenTags = () => {
  const SHOP = ".example-shop.com";
  const network = [
    req(GTM_SHOP),
    ...SHOP_TAGS.map((id) => req(gtagUrl(id))),
    req("https://region1.google-analytics.com/g/collect?v=2&tid=G-XRTM1000", { resourceType: "ping", statusCode: 204 }),
    req("https://googleads.g.doubleclick.net/pagead/viewthroughconversion/71100000/", { resourceType: "image" }),
    written(GTM_SHOP, [["_gcl_au", SHOP]]),
    written(gtagUrl("G-XRTM1000"), [["_ga", SHOP], ["_ga_XRTM1000", SHOP]]),
    written(gtagUrl("G-XRTM4000"), [["_ga_XRTM4000", SHOP]]),
  ];
  const jsId = (writer) => network.find((n) => n.url === writer && n.method === "SCRIPT")?.id ?? null;
  const inside = (frame, over = {}) => loaderBy([frame], [frame], over);
  return base({
    context: { finalUrl: "https://www.example-shop.com/", topSite: "example-shop.com" },
    signal: { readAttribution: { sampled: 12, unattributed: 12, viaTagManager: 0, viaTagManagerByContainer: {} } },
    network,
    capabilities: { scriptInsertion: true, requestInitiation: true },
    scriptInsertions: [insertion(GTM_SHOP, loaderBy(["https://www.example-shop.com/_next/app.js"], [])), ...SHOP_TAGS.map((id) => insertion(gtagUrl(id), inside(GTM_SHOP)))],
    scriptInsertionCoverage: coverage(),
    requestInitiators: [
      insertion("https://region1.google-analytics.com/g/collect?v=2&tid=G-XRTM1000", inside(gtagUrl("G-XRTM1000"), { via: "sendBeacon" })),
      insertion("https://googleads.g.doubleclick.net/pagead/viewthroughconversion/71100000/", inside(gtagUrl("AW-71100000"), { via: "src" })),
    ],
    gtm: {
      present: true,
      containerIds: ["GTM-XRTM100"],
      gtagIds: SHOP_TAGS,
      consentMode: {
        ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted",
        functionality_storage: "unspecified", personalization_storage: "unspecified", security_storage: "unspecified",
      },
      consentModeDefaultSetBy: null,
      consentModeUpdateSetBy: GTM_SHOP,
      effectiveConsent: {
        ad_storage: { default: false }, ad_user_data: { default: false }, ad_personalization: { default: false },
        analytics_storage: { default: false, update: true },
        functionality_storage: { default: true }, security_storage: { default: true },
        site_preferences: { default: true },
      },
      scriptFetched: true,
    },
    tallies: {
      totalRequests: 96,
      signedRequests: 96,
      adVendorRequests: 12,
      adCookieEvents: 4,
      ...counted([
        ["_gcl_au", SHOP, "Google", "advertising"],
        ["_ga", SHOP, "Google", "analytics"],
        ["_ga_XRTM1000", SHOP, "Google", "analytics"],
        ["_ga_XRTM4000", SHOP, "Google", "analytics"],
      ]),
      firstPartyVendorCookieKeys: [],
      byEntity: {
        Google: { requests: 12, signedRequests: 12, cookieNames: ["_ga", "_ga_XRTM1000", "_ga_XRTM4000", "_gcl_au"], cookiesReturned: [], hosts: ["region1.google-analytics.com", "googleads.g.doubleclick.net"], scriptRan: true },
      },
      cookieDetails: {
        [K("_gcl_au", SHOP)]: detailOf("www.googletagmanager.com", "gtm:GTM-XRTM100", jsId(GTM_SHOP), { expiresMs: Date.now() + 90 * 86_400_000 }),
        [K("_ga", SHOP)]: detailOf("www.googletagmanager.com", "gtag:G-XRTM1000", jsId(gtagUrl("G-XRTM1000")), { expiresMs: Date.now() + 400 * 86_400_000 }),
        [K("_ga_XRTM1000", SHOP)]: detailOf("www.googletagmanager.com", "gtag:G-XRTM1000", jsId(gtagUrl("G-XRTM1000")), { expiresMs: Date.now() + 400 * 86_400_000 }),
        [K("_ga_XRTM4000", SHOP)]: detailOf("www.googletagmanager.com", "gtag:G-XRTM4000", jsId(gtagUrl("G-XRTM4000")), { expiresMs: Date.now() + 400 * 86_400_000 }),
      },
      byContainer: {
        "gtm:GTM-XRTM100": containerTally("gtm", "GTM-XRTM100", GTM_SHOP, [K("_gcl_au", SHOP)]),
        "gtag:G-XRTM1000": containerTally("gtag", "G-XRTM1000", gtagUrl("G-XRTM1000"), [K("_ga", SHOP), K("_ga_XRTM1000", SHOP)]),
        "gtag:G-XRTM4000": containerTally("gtag", "G-XRTM4000", gtagUrl("G-XRTM4000"), [K("_ga_XRTM4000", SHOP)]),
      },
    },
  });
};

// --- first-party: the site's own cookies (1.26.0), both lists and a list that was full ---
//
// The heavy page with the first-party summary a current capture writes: a probe, the two cookies the
// site's own analytics host wrote (the headline's first-party line, which the section
// replaces), the ones its responses and other scripts set, one of them on two domains and one
// (`_ga`) also written by the analytics host, so listed once, under it, and a list that held
// as many as it can.
const firstParty = () => {
  const f = heavy();
  const NEWS = ".example-news.com";
  return {
    ...f,
    tallies: {
      ...f.tallies,
      firstParty: {
        cookieKeys: [
          K("__cf_bm", NEWS), K("_ga", "www.example-news.com"), K("ab_bucket", NEWS), K("consent_state", NEWS), K("edition", "www.example-news.com"),
          K("edition", NEWS), K("session_id", NEWS), K("site_author", NEWS), K("site_section", NEWS), K("subscriber_state", NEWS),
        ],
        cookieKeysUnsigned: [],
        vendorCookieKeysUnsigned: [],
        // A site script testing whether it can write cookies.
        probeCookies: ["cookie_test"],
        capped: true,
      },
    },
  };
};

// --- unlisted-domains: third-party domains the list names no company for (1.26.0) ---
//
// As retailer-d.example ran its own content domain, with illustrative example- domains for each
// other kind of row: the site's content domain, whose scripts read GPC and wrote the site's
// cookies (one of them Adobe's long AMCV_ name); a vendor the list does not carry, whose
// scripts read nothing, with a cookie set on a request without GPC and a summary that was
// full; a domain that only set and removed a cookie; one whose only write the browser did
// not store; and one that read GPC and set nothing, which has no row. Criteo is counted, with
// a cookie set on a request without GPC in its panel, and Yahoo! is Uncategorized, so the
// group is drawn after it.

const HOME = ".example-home.com";
const HOME_JS = "https://www.example-home.com/assets/app.js";
const STATIC_GPC = "https://assets.example-homestatic.com/gpc.js";
const STATIC_3P = "https://assets.example-homestatic.com/3p.js";
const INSIGHTS = "https://cdn.example-insights.io/tag.js";
const CHAT = "https://widget.example-chat.com/w.js";
const SURVEY = "https://cdn.example-survey.net/s.js";
const QUIET = "https://cdn.example-quiet.net/consent.js";
const AMCV = "AMCV_E27100000000000000000000%40AdobeOrg";

/** An unlisted domain's summary as the worker keeps it (1.26.0). */
const unlistedTally = (domain, over = {}) => ({
  domain, requests: 0, signedRequests: 0, hosts: [], resourceTypes: [], cookieKeys: [], cookieKeysUnsigned: [],
  cookiesReturned: [], probeCookies: [], refusedWrites: [], scriptRan: false, scriptRanOutsideXhr: false,
  firstObservationId: null, executionObservationId: null, ...over,
});

const unlistedDomains = () => {
  const STATIC_KEYS = [
    ["AKA_A2", HOME], [AMCV, HOME], ["DELIVERY_ZIP", HOME], ["OptOutOnRequest", HOME], ["OptOutOnRequest", ".www.example-home.com"],
    ["RTD_PERSIST", HOME], ["RTD_SESSION", HOME], ["kndctr_E27100000000000000000000_AdobeOrg_identity", HOME], ["rtda.u", HOME],
  ];
  const network = [
    req(STATIC_GPC),
    req(STATIC_3P),
    req("https://images.example-homestatic.com/hero.jpg", { resourceType: "image" }),
    req(INSIGHTS),
    req("https://cdn.example-insights.io/collect", { resourceType: "xmlhttprequest", setCookies: [cookie("ins_id", ".example-insights.io")] }),
    req("https://cdn.example-insights.io/edge", { resourceType: "xmlhttprequest", secGpcPresent: false, requestHeaders: [], setCookies: [cookie("edge_route", ".example-insights.io", { expiresMs: Date.now() + 30 * 60_000 })] }),
    req(CHAT),
    req(SURVEY),
    req(QUIET),
    req("https://static.criteo.net/js/ld/publishertag.js"),
    req("https://bidder.criteo.com/cdb", { resourceType: "xmlhttprequest", setCookies: [cookie("uid", ".criteo.com")] }),
    req("https://bidder.criteo.com/late", { resourceType: "xmlhttprequest", secGpcPresent: false, requestHeaders: [], setCookies: [cookie("cto_late", ".criteo.com")] }),
    req("https://techcrunch.com/pixel.gif", { resourceType: "image" }),
    written(STATIC_3P, STATIC_KEYS),
    written("https://static.criteo.net/js/ld/publishertag.js", [["cto_bundle", HOME]]),
  ];
  const idOf = (url) => network.find((n) => n.url === url && n.method !== "SCRIPT")?.id ?? null;
  const jsId = (writer) => network.find((n) => n.url === writer && n.method === "SCRIPT")?.id ?? null;
  const bySite = loaderBy([HOME_JS], [], { frameOrigin: "https://www.example-home.com" });
  const staticKeys = STATIC_KEYS.map(([n, d]) => K(n, d));
  // The rest of a full summary, cut for the fixture: the list says it was full.
  const insightsKeys = [K("ins_id", ".example-insights.io")];
  return base({
    context: { finalUrl: "https://www.example-home.com/", topSite: "example-home.com" },
    signal: {
      readCount: 21,
      readsByScript: { [STATIC_GPC]: 3, [STATIC_3P]: 6, [QUIET]: 2 },
      readAttribution: { sampled: 11, unattributed: 0, viaTagManager: 0 },
    },
    network,
    capabilities: { scriptInsertion: true, requestInitiation: true },
    scriptInsertions: [insertion(STATIC_GPC, bySite), insertion(STATIC_3P, bySite), insertion(INSIGHTS, bySite)],
    scriptInsertionCoverage: coverage(),
    otherVendors: [["Yahoo!", "unknown", ["techcrunch.com"], 1]],
    tallies: {
      totalRequests: 240,
      signedRequests: 236,
      adVendorRequests: 3,
      adCookieEvents: 2,
      ...(({ adCookieKeys, adCookieEntities, adCookieCategories }) => ({
        adCookieKeys: adCookieKeys.filter((k) => k !== K("cto_late", ".criteo.com")),
        adCookieEntities,
        adCookieCategories,
      }))(counted([
        ["cto_bundle", HOME, "Criteo", "advertising"],
        ["uid", ".criteo.com", "Criteo", "advertising"],
        // Set on a request without GPC, while the signal was on: in the panel, not on the row.
        ["cto_late", ".criteo.com", "Criteo", "advertising"],
      ])),
      adCookieEventsUnsigned: 1,
      adCookieKeysUnsigned: [K("cto_late", ".criteo.com")],
      firstPartyVendorCookieKeys: [],
      byEntity: {
        Criteo: { requests: 3, signedRequests: 2, cookieNames: ["cto_bundle", "uid"], cookieNamesUnsigned: ["cto_late"], cookiesReturned: ["uid"], hosts: ["bidder.criteo.com", "static.criteo.net"] },
      },
      cookieDetails: {
        [K("cto_bundle", HOME)]: detailOf("static.criteo.net", null, jsId("https://static.criteo.net/js/ld/publishertag.js"), { expiresMs: Date.now() + 395 * 86_400_000 }),
        [K("uid", ".criteo.com")]: detailOf("bidder.criteo.com", null, idOf("https://bidder.criteo.com/cdb"), { via: "onHeadersReceived", expiresMs: Date.now() + 395 * 86_400_000, sameSite: "None", secure: true }),
        [K("cto_late", ".criteo.com")]: detailOf("bidder.criteo.com", null, null, { via: "onHeadersReceived", expiresMs: Date.now() + 395 * 86_400_000, sameSite: "None", secure: true }),
        ...Object.fromEntries(staticKeys.map((k) => [k, detailOf("assets.example-homestatic.com", null, jsId(STATIC_3P), { expiresMs: Date.now() + 400 * 86_400_000 })])),
        [K("ins_id", ".example-insights.io")]: detailOf("cdn.example-insights.io", null, idOf("https://cdn.example-insights.io/collect"), { via: "onHeadersReceived", expiresMs: Date.now() + 365 * 86_400_000, sameSite: "None", secure: true }),
        // Set by one response and cleared by a later one: counted where it counts, and marked removed.
        [K("edge_route", ".example-insights.io")]: detailOf("cdn.example-insights.io", null, null, { via: "onHeadersReceived", expiresMs: Date.now() + 30 * 60_000, sameSite: "None", secure: true, removedAfterMs: 3_200 }),
        [K("cohsn_xs_id", ".example-cohesion.com")]: detailOf("cdn.example-cohesion.com", null, null, { expiresMs: Date.now() + 365 * 86_400_000 }),
        [K("lost_uid", ".example-lost.net")]: detailOf("api.example-lost.net", null, null, { via: "onHeadersReceived", expiresMs: Date.now() + 365 * 86_400_000, sameSite: "None", secure: true, requestLost: true }),
      },
      // The site's own, and no script of its own the list puts in advertising or analytics:
      // the first-party section's first list is empty, as on retailer-d.example.
      firstParty: {
        cookieKeys: [K("SLOT_DECISIONS", HOME), K("_abck", HOME), K("bm_lso", HOME), K("bm_lso", ".www.example-home.com"), K("bm_s", HOME), K("thx_guid", HOME)],
        cookieKeysUnsigned: [],
        vendorCookieKeysUnsigned: [],
      },
      byUnlistedDomain: {
        "example-chat.com": unlistedTally("example-chat.com", {
          requests: 4, signedRequests: 4, hosts: ["widget.example-chat.com"], resourceTypes: ["script", "xmlhttprequest"],
          probeCookies: ["chat_cookie_check"], scriptRan: true, scriptRanOutsideXhr: true, firstObservationId: idOf(CHAT), executionObservationId: idOf(CHAT),
        }),
        // Written from its own frame without the signal, while it was on: a row of its own,
        // as health-a-group.example's cohsn_xs_id on health-a.example.
        "example-cohesion.com": unlistedTally("example-cohesion.com", {
          requests: 1, signedRequests: 0, hosts: ["cdn.example-cohesion.com"], resourceTypes: ["sub_frame"],
          cookieKeysUnsigned: [K("cohsn_xs_id", ".example-cohesion.com")], scriptRan: true, scriptRanOutsideXhr: true,
        }),
        "example-homestatic.com": unlistedTally("example-homestatic.com", {
          requests: 231, signedRequests: 231, hosts: ["assets.example-homestatic.com", "images.example-homestatic.com"],
          resourceTypes: ["font", "image", "script", "stylesheet"], cookieKeys: [...staticKeys].sort(), cookiesReturned: ["AKA_A2"],
          probeCookies: ["__tld__", "com.adobe.alloy.getTld"], scriptRan: true, scriptRanOutsideXhr: true,
          firstObservationId: idOf(STATIC_GPC), executionObservationId: idOf(STATIC_GPC),
        }),
        "example-insights.io": unlistedTally("example-insights.io", {
          requests: 3, signedRequests: 2, hosts: ["cdn.example-insights.io"], resourceTypes: ["script", "xmlhttprequest"],
          cookieKeys: insightsKeys, cookieKeysUnsigned: [K("edge_route", ".example-insights.io")], cookiesReturned: ["edge_route"],
          scriptRan: true, scriptRanOutsideXhr: true, firstObservationId: idOf(INSIGHTS), executionObservationId: idOf(INSIGHTS), capped: true,
        }),
        // Its response reached the worker after a restart: the request was not seen (1.26.0).
        "example-lost.net": unlistedTally("example-lost.net", {
          requests: 1, signedRequests: 1, hosts: ["api.example-lost.net"], resourceTypes: ["xmlhttprequest"],
          cookieKeysRequestLost: [K("lost_uid", ".example-lost.net")], scriptRan: true, scriptRanOutsideXhr: false,
        }),
        // Its consent script read GPC and set nothing: a row of its own.
        "example-quiet.net": unlistedTally("example-quiet.net", {
          requests: 1, signedRequests: 1, hosts: ["cdn.example-quiet.net"], resourceTypes: ["script"],
          scriptRan: true, scriptRanOutsideXhr: true, firstObservationId: idOf(QUIET), executionObservationId: idOf(QUIET),
        }),
        "example-survey.net": unlistedTally("example-survey.net", {
          requests: 2, signedRequests: 2, hosts: ["cdn.example-survey.net"], resourceTypes: ["script"],
          refusedWrites: ["survey_uid (.com)"], scriptRan: true, scriptRanOutsideXhr: true, firstObservationId: idOf(SURVEY), executionObservationId: idOf(SURVEY),
        }),
      },
    },
  });
};

// The same page after a worker reclaim: the request list is gone, and every row stays.
const unlistedDomainsReclaimed = () => {
  const f = withPersistedShape(unlistedDomains());
  return { ...f, network: [], context: { ...f.context, incomplete: true, incompleteReasons: ["worker-restarted"] } };
};
// --- load-failed: the top document did not load and Chrome showed its own error page
// (ticketing-b.example, 2026-09-25). The document request carried the header; no content
// script ran, so the signal fields are the capture's empty defaults, not a report. ---

const loadFailed = () =>
  base({
    context: {
      finalUrl: "https://www.example-tickets.com/",
      topSite: "www.example-tickets.com",
      loadError: "net::ERR_CONNECTION_TIMED_OUT",
    },
    network: [
      req("https://www.example-tickets.com/", {
        resourceType: "main_frame",
        initiator: null,
        statusCode: null,
        responseHeaders: null,
      }),
    ],
    signal: { source: "none", propertyValue: false, readCount: 0, secGpcRequestCount: 1, totalRequestCount: 1 },
    wellKnown: null,
  });

// --- consent-store: Consent Mode read from Google's shared consent store because the
// dataLayer showed no consent command (apparel-c.example, 2026-09-25: Tag Manager served from a
// first-party path under a renamed dataLayer, every type set to denied). ---

const consentStore = () => {
  const o = quietContainer();
  return {
    ...o,
    gtm: {
      ...o.gtm,
      effectiveConsent: {
        ad_storage: { default: false, update: false, implicit: true },
        ad_user_data: { default: false, update: false, implicit: true },
        ad_personalization: { default: false, update: false, implicit: true },
        analytics_storage: { default: false, update: false, implicit: true },
        functionality_storage: { default: true },
        site_own_type: { default: false, update: true },
      },
    },
    capabilities: { ...o.capabilities, dataLayer: false },
  };
};

// --- shown-and-set: the page showed a GPC confirmation notice and ad cookies were set on
// signed requests, with no published file (retailer-b.example, 2026-09-25). The row and the
// count report them. ---

const shownAndSet = () => ({ ...direct(), confirmationNotice: "detected" });

// --- store: the Chrome Web Store screenshots ---
//
// One fixture per shot, each a fictional site on the reserved .example TLD, and every vendor
// a fictional company on a fictional .example host (the images name no real company),
// classified through harness/fictional-vendors.mjs on top of the real list.
// Cookie names are the fictional vendors' own. The numbers are modeled on the 2026-09-30
// corpus run. Each GPP string is encoded for the fields it shows and decodes to them at
// iabgpp.com.

/** A request made from one of the store sites. */
const fromSite = (origin) => (url, over = {}) => req(url, { initiator: `${origin}/`, ...over });

/**
 * The request list made as long as the tallies say it was: each company's and each unlisted
 * domain's hosts get repeats of their last request (same type, no cookies) up to the number
 * its summary counts, then the site's own assets fill the list to the total. The Requests
 * tab's number and each panel's "requests carried your signal" then agree, as they do on a
 * capture whose list was kept. The other fixtures keep a sample, which is fine unframed.
 */
function fullList(origin, obs) {
  const network = [...obs.network];
  const isRequest = (n) => n.method !== "SCRIPT";
  const groups = [
    ...Object.values(obs.tallies.byEntityCategory ?? {}).map((p) => [p.hosts, p.requests]),
    ...Object.values(obs.tallies.byUnlistedDomain ?? {}).map((u) => [u.hosts, u.requests]),
  ];
  for (const [hosts, count] of groups) {
    const rows = network.filter((n) => isRequest(n) && hosts.includes(hostOf(n.url)));
    const last = rows[rows.length - 1];
    if (!last) continue;
    for (let i = rows.length; i < count; i++) {
      network.push(req(`${last.url}${last.url.includes("?") ? "&" : "?"}n=${i}`, { resourceType: last.resourceType, initiator: last.initiator }));
    }
  }
  const assets = [["image", "img/i", "webp"], ["script", "js/chunk", "js"], ["stylesheet", "css/s", "css"], ["font", "fonts/f", "woff2"], ["xmlhttprequest", "api/item", "json"]];
  for (let k = 0; network.filter(isRequest).length < obs.tallies.totalRequests; k++) {
    const [type, path, ext] = assets[k % assets.length];
    network.push(req(`${origin}/${path}-${k}.${ext}`, { resourceType: type, initiator: `${origin}/` }));
  }
  return { ...obs, network };
}
/** A store site's published file, read during this navigation. */
const publishedFile = (origin) => ({
  url: `${origin}/.well-known/gpc.json`, present: true, gpc: true, lastUpdate: "2026-06-01",
  observedAtMs: Date.now(), fresh: true, reason: null,
});
/** The usnat fields a site's consent manager reports, with the GPC sub-section. */
const usnat = (optOut) => ({
  SharingNotice: 1, SaleOptOutNotice: 1, SharingOptOutNotice: 1, TargetedAdvertisingOptOutNotice: 1,
  SaleOptOut: optOut, SharingOptOut: optOut, TargetedAdvertisingOptOut: optOut,
  MspaCoveredTransaction: 2, MspaOptOutOptionMode: 0, MspaServiceProviderMode: 0, Gpc: 1,
});
/** usnat only, every opt-out at 1 (opted out), GPC field set. */
const GPP_OPTED_OUT = "DBABLA~BVQVAAAAAgA.YA";
/** uspv1 1YNN and usnat with every opt-out at 2 (did not opt out), GPC field set. */
const GPP_CONFLICT = "DBABzw~1YNN~BVQqAAAAAgA.YA";

// shot-honored: the site publishes its file, shows a confirmation, its consent manager reads
// GPC, and no advertising or analytics domain sets a cookie (retailer-f.example on the corpus: a
// notice, no cookies, the consent manager read GPC).

const SHOP = "https://www.shop.example";
const SHOP_AD = "https://tag.adlark.example/js/adlark.js";
const SHOP_CMP = "https://cdn.harborline.example/cm/shop/consent.js";

const storeHonored = () => {
  const at = fromSite(SHOP);
  return fullList(SHOP, base({
    context: { finalUrl: `${SHOP}/`, topSite: "shop.example" },
    signal: {
      secGpcRequestCount: 266, totalRequestCount: 266, readCount: 5,
      readsByScript: { [SHOP_CMP]: 3, [`${SHOP}/assets/storefront.js`]: 2 },
      readAttribution: { sampled: 5, unattributed: 0, viaTagManager: 0 },
    },
    network: [
      at(`${SHOP}/`, { resourceType: "main_frame", initiator: null }),
      at(`${SHOP}/assets/storefront.js`),
      at(SHOP_CMP),
      at(SHOP_AD),
      at("https://bid.adlark.example/v2/slot?site=shop&sz=728x90", { resourceType: "xmlhttprequest" }),
      at("https://px.tallyhall.example/b?site=shop", { resourceType: "image" }),
    ],
    otherVendors: [["Harborline", "consent-managers", ["cdn.harborline.example"], 3]],
    consentApiCalls: [{ api: "__gpp", command: "getGPPData", callerScriptUrl: SHOP_AD, viaTagManager: false, timeMs: 1 }],
    gpp: { rawString: GPP_OPTED_OUT, applicableSections: [7], gppVersion: "1.1", sections: { usnat: usnat(1) }, unparseable: false, fromWire: GPP_OPTED_OUT },
    confirmationNotice: "detected",
    wellKnown: publishedFile(SHOP),
    tallies: {
      totalRequests: 266,
      signedRequests: 266,
      adVendorRequests: 7,
      adCookieEvents: 0,
      adCookieKeys: [],
      firstPartyVendorCookieKeys: [],
      byEntity: {
        Adlark: { requests: 5, signedRequests: 5, cookieNames: [], cookiesReturned: [], hosts: ["tag.adlark.example", "bid.adlark.example"] },
        Tallyhall: { requests: 2, signedRequests: 2, cookieNames: [], cookiesReturned: [], hosts: ["px.tallyhall.example"] },
      },
    },
  }));
};

// shot-brave: a quiet page in a browser that sends the signal itself (Brave today, Chrome
// under AB 566): the page property is the browser's own, so the status row says "by the
// browser", Settings points at the browser's setting, and so does the first-run line. The
// extension's own rule stays installed (sw.ts does not stand down for another owner), so
// requests carry one Sec-GPC header either way. No advertising or analytics domain, as on
// encyclopedia-a.example on the corpus, and as Brave's Shields leave many pages. -off is the browser
// with its signal off.

const RECIPES = "https://www.recipes.example";

const storeQuiet = (propertyValue) => {
  const at = fromSite(RECIPES);
  return fullList(RECIPES, base({
    context: { finalUrl: `${RECIPES}/soups/winter-squash`, topSite: "recipes.example" },
    signal: { source: "native", propertyValue, secGpcRequestCount: 38, totalRequestCount: 38, readCount: 0, readsByScript: {}, readAttribution: null },
    network: [at(`${RECIPES}/soups/winter-squash`, { resourceType: "main_frame", initiator: null }), at(`${RECIPES}/assets/site.js`)],
    confirmationNotice: "not-detected",
    wellKnown: { url: `${RECIPES}/.well-known/gpc.json`, present: false, gpc: null, lastUpdate: null, observedAtMs: Date.now(), fresh: true, reason: "status 404" },
    tallies: { totalRequests: 38, signedRequests: 38, adVendorRequests: 0, adCookieEvents: 0, adCookieKeys: [], firstPartyVendorCookieKeys: [], byEntity: {} },
  }));
};
const storeBrave = () => storeQuiet(true);
const storeBraveOff = () => storeQuiet(false);

// shot-download, the page behind the Download findings screen: it shows a GPC confirmation
// while advertising and analytics domains set cookies on requests that carried the signal:
// the row says yes and the count says how many (automaker-g.example and automaker-f.example
// on the corpus: a notice and an advertising vendor's identity cookies).

const AUTOS = "https://www.autos.example";
const AUTOS_QS = "https://cdn.quillstat.example/q/autos.js";
const AUTOS_RW = "https://cdn.ridgeway.example/embed/autos.js";
const AUTOS_CMP = "https://cdn.harborline.example/cm/autos/consent.js";

const storeNoticeCookies = () => {
  const at = fromSite(AUTOS);
  const D = ".autos.example";
  return fullList(AUTOS, base({
    context: { finalUrl: `${AUTOS}/`, topSite: "autos.example" },
    signal: {
      secGpcRequestCount: 214, totalRequestCount: 214, readCount: 4,
      readsByScript: { [AUTOS_CMP]: 4 },
      readAttribution: { sampled: 4, unattributed: 0, viaTagManager: 0 },
    },
    network: [
      at(`${AUTOS}/`, { resourceType: "main_frame", initiator: null }),
      at(AUTOS_CMP),
      at("https://id.bidmoor.example/id?site=autos", {
        resourceType: "xmlhttprequest",
        setCookies: [cookie("bm_uid", ".bidmoor.example", { expiresMs: Date.now() + 180 * 86_400_000 }), cookie("bm_sync", ".bidmoor.example", { expiresMs: Date.now() + 180 * 86_400_000 })],
      }),
      at("https://cm.bidmoor.example/match?site=autos", { resourceType: "image", setCookies: [cookie("bm_match", ".bidmoor.example")] }),
      at("https://tag.fernbid.example/f.js"),
      at("https://px.fernbid.example/e?evt=pageLoad", { resourceType: "image", setCookies: [cookie("fnb_vid", ".fernbid.example")] }),
      at("https://px.pixelmoss.example/track?adv=autos", { resourceType: "image", setCookies: [cookie("pm_id", ".pixelmoss.example")] }),
      at("https://px.pixelmoss.example/sync?adv=autos", { resourceType: "image", setCookies: [cookie("pm_sync", ".pixelmoss.example")] }),
      at("https://px.crestline.example/p?site=autos", { resourceType: "image", setCookies: [cookie("cl_at", ".crestline.example")] }),
      at("https://px.tallyhall.example/b?site=autos", { resourceType: "image", setCookies: [cookie("th_uid", ".tallyhall.example")] }),
      at(AUTOS_QS),
      at(AUTOS_RW),
      written(AUTOS_QS, [["qs_user", D]]),
      written(AUTOS_RW, [["rw_visitor", D]]),
    ],
    otherVendors: [["Harborline", "consent-managers", ["cdn.harborline.example"], 2]],
    confirmationNotice: "detected",
    wellKnown: { url: `${AUTOS}/.well-known/gpc.json`, present: false, gpc: null, lastUpdate: null, observedAtMs: Date.now(), fresh: true, reason: "status 404" },
    tallies: {
      totalRequests: 214,
      signedRequests: 214,
      adVendorRequests: 28,
      adCookieEvents: 10,
      ...counted([
        ["bm_match", ".bidmoor.example", "Bidmoor", "advertising"],
        ["bm_sync", ".bidmoor.example", "Bidmoor", "advertising"],
        ["bm_uid", ".bidmoor.example", "Bidmoor", "advertising"],
        ["cl_at", ".crestline.example", "Crestline Ads", "advertising"],
        ["fnb_vid", ".fernbid.example", "Fernbid", "advertising"],
        ["pm_id", ".pixelmoss.example", "Pixelmoss", "advertising"],
        ["pm_sync", ".pixelmoss.example", "Pixelmoss", "advertising"],
        ["qs_user", D, "Quillstat", "analytics"],
        ["rw_visitor", D, "Ridgeway Insights", "analytics"],
        ["th_uid", ".tallyhall.example", "Tallyhall", "analytics"],
      ]),
      firstPartyVendorCookieKeys: [],
      byEntity: {
        Bidmoor: { requests: 6, signedRequests: 6, cookieNames: ["bm_match", "bm_sync", "bm_uid"], cookiesReturned: ["bm_uid"], hosts: ["id.bidmoor.example", "cm.bidmoor.example"] },
        "Crestline Ads": { requests: 2, signedRequests: 2, cookieNames: ["cl_at"], cookiesReturned: [], hosts: ["px.crestline.example"] },
        Fernbid: { requests: 4, signedRequests: 4, cookieNames: ["fnb_vid"], cookiesReturned: ["fnb_vid"], hosts: ["tag.fernbid.example", "px.fernbid.example"] },
        Pixelmoss: { requests: 3, signedRequests: 3, cookieNames: ["pm_id", "pm_sync"], cookiesReturned: [], hosts: ["px.pixelmoss.example"] },
        Quillstat: { requests: 6, signedRequests: 6, cookieNames: ["qs_user"], cookiesReturned: [], hosts: ["cdn.quillstat.example"] },
        "Ridgeway Insights": { requests: 5, signedRequests: 5, cookieNames: ["rw_visitor"], cookiesReturned: [], hosts: ["cdn.ridgeway.example"] },
        Tallyhall: { requests: 2, signedRequests: 2, cookieNames: ["th_uid"], cookiesReturned: [], hosts: ["px.tallyhall.example"] },
      },
    },
  }));
};

// shot-read-gpc: the site publishes gpc.json true; two vendors read GPC through the GPP
// consent API, one through the property, two ran with no read observed; Adlark's panel is
// open, one cookie sent back to it and one not (news-g.example on the corpus: the file says
// true, three vendors set cookies, the GPP string has the GPC field set).

const NEWS = "https://www.news.example";
const NEWS_ADLARK = "https://tag.adlark.example/js/prebid-adlark.js";
const NEWS_DUNMORE = "https://c.dunmore.example/dx/tag.js";
const NEWS_BIDMOOR = "https://tag.bidmoor.example/js/bm.js";

const storeReadGpc = () => {
  const at = fromSite(NEWS);
  const D = ".news.example";
  return fullList(NEWS, base({
    context: { finalUrl: `${NEWS}/world/2026/10/01/harbor-report`, topSite: "news.example" },
    signal: {
      secGpcRequestCount: 607, totalRequestCount: 607, readCount: 9,
      readsByScript: { [NEWS_BIDMOOR]: 2, [`${NEWS}/static/reader.js`]: 3 },
      readAttribution: { sampled: 9, unattributed: 4, viaTagManager: 0 },
    },
    network: [
      at(`${NEWS}/world/2026/10/01/harbor-report`, { resourceType: "main_frame", initiator: null }),
      at(`${NEWS}/static/reader.js`),
      at(NEWS_BIDMOOR),
      at("https://ads.bidmoor.example/slot?site=news&sz=300x250", { resourceType: "xmlhttprequest", setCookies: [cookie("bm_uid", ".bidmoor.example")], cookiesSent: ["bm_uid"] }),
      at(NEWS_ADLARK),
      at("https://bid.adlark.example/v2/bid?site=news", { resourceType: "xmlhttprequest", setCookies: [cookie("alk_uid", ".adlark.example")], cookiesSent: ["alk_uid"] }),
      written(NEWS_ADLARK, [["alk_bundle", D]]),
      at(NEWS_DUNMORE),
      at("https://bid.dunmore.example/e/bid?site=news", { resourceType: "xmlhttprequest", setCookies: [cookie("dx_id", ".dunmore.example")] }),
      at("https://bid.pixelmoss.example/prebid?site=news", { resourceType: "xmlhttprequest", setCookies: [cookie("pm_id", ".pixelmoss.example")] }),
      at("https://fast.glimmer.example/a/api/fast.json?site=news", { resourceType: "xmlhttprequest", setCookies: [cookie("gm_id", ".glimmer.example")] }),
      at("https://px.tallyhall.example/b?site=news", { resourceType: "image", setCookies: [cookie("th_uid", ".tallyhall.example")] }),
    ],
    consentApiCalls: [
      { api: "__gpp", command: "getGPPData", callerScriptUrl: NEWS_ADLARK, viaTagManager: false, timeMs: 2 },
      { api: "__gpp", command: "getGPPData", callerScriptUrl: NEWS_DUNMORE, viaTagManager: false, timeMs: 3 },
    ],
    gpp: { rawString: GPP_OPTED_OUT, applicableSections: [7], gppVersion: "1.1", sections: { usnat: usnat(1) }, unparseable: false, fromWire: GPP_OPTED_OUT },
    confirmationNotice: "not-detected",
    wellKnown: publishedFile(NEWS),
    tallies: {
      totalRequests: 607,
      signedRequests: 607,
      adVendorRequests: 75,
      adCookieEvents: 7,
      ...counted([
        ["alk_bundle", D, "Adlark", "advertising"],
        ["alk_uid", ".adlark.example", "Adlark", "advertising"],
        ["bm_uid", ".bidmoor.example", "Bidmoor", "advertising"],
        ["dx_id", ".dunmore.example", "Dunmore Exchange", "advertising"],
        ["gm_id", ".glimmer.example", "Glimmer Media", "advertising"],
        ["pm_id", ".pixelmoss.example", "Pixelmoss", "advertising"],
        ["th_uid", ".tallyhall.example", "Tallyhall", "analytics"],
      ]),
      firstPartyVendorCookieKeys: [],
      byEntity: {
        Adlark: { requests: 12, signedRequests: 12, cookieNames: ["alk_bundle", "alk_uid"], cookiesReturned: ["alk_uid"], hosts: ["tag.adlark.example", "bid.adlark.example"] },
        Bidmoor: { requests: 38, signedRequests: 38, cookieNames: ["bm_uid"], cookiesReturned: ["bm_uid"], hosts: ["tag.bidmoor.example", "ads.bidmoor.example"] },
        "Dunmore Exchange": { requests: 9, signedRequests: 9, cookieNames: ["dx_id"], cookiesReturned: [], hosts: ["c.dunmore.example", "bid.dunmore.example"] },
        "Glimmer Media": { requests: 6, signedRequests: 6, cookieNames: ["gm_id"], cookiesReturned: [], hosts: ["fast.glimmer.example"] },
        Pixelmoss: { requests: 5, signedRequests: 5, cookieNames: ["pm_id"], cookiesReturned: [], hosts: ["bid.pixelmoss.example"] },
        Tallyhall: { requests: 5, signedRequests: 5, cookieNames: ["th_uid"], cookiesReturned: [], hosts: ["px.tallyhall.example"] },
      },
    },
  }));
};

// shot-privacy-strings: the site's own GPP string has the GPC field set and records that
// the visitor did not opt out of sale, sharing or targeted advertising (airline-a.example on the
// corpus), with its US Privacy string. No Google tag, so the image names no real company
// anywhere.

const TRAVEL = "https://www.travel.example";

const storePrivacyStrings = () => {
  const at = fromSite(TRAVEL);
  return fullList(TRAVEL, base({
    context: { finalUrl: `${TRAVEL}/`, topSite: "travel.example" },
    signal: {
      secGpcRequestCount: 405, totalRequestCount: 405, readCount: 7,
      readsByScript: { [`${TRAVEL}/assets/consent.js`]: 7 },
      readAttribution: { sampled: 7, unattributed: 0, viaTagManager: 0 },
    },
    network: [
      at(`${TRAVEL}/`, { resourceType: "main_frame", initiator: null }),
      at(`${TRAVEL}/assets/consent.js`),
      at("https://ads.bidmoor.example/slot?site=travel&sz=300x250", { resourceType: "xmlhttprequest", setCookies: [cookie("bm_uid", ".bidmoor.example")] }),
      at("https://tag.fernbid.example/f.js"),
      at("https://px.fernbid.example/e?evt=pageLoad", { resourceType: "image", setCookies: [cookie("fnb_vid", ".fernbid.example")] }),
      at("https://px.pixelmoss.example/track?adv=travel", { resourceType: "image", setCookies: [cookie("pm_id", ".pixelmoss.example")] }),
      at("https://px.tallyhall.example/b?site=travel", { resourceType: "image", setCookies: [cookie("th_uid", ".tallyhall.example")] }),
    ],
    gpp: { rawString: GPP_CONFLICT, applicableSections: [7], gppVersion: "1.1", sections: { usnat: usnat(2) }, unparseable: false, fromWire: GPP_CONFLICT },
    usPrivacy: {
      fromApi: "1YNN",
      fromCookie: "1YNN",
      fromWire: "1YNN",
      fromWireHost: "ads.bidmoor.example",
      wireValues: [{ value: "1YNN", hosts: ["ads.bidmoor.example"] }],
    },
    confirmationNotice: "not-detected",
    wellKnown: { url: `${TRAVEL}/.well-known/gpc.json`, present: false, gpc: null, lastUpdate: null, observedAtMs: Date.now(), fresh: true, reason: "status 404" },
    tallies: {
      totalRequests: 405,
      signedRequests: 405,
      adVendorRequests: 132,
      adCookieEvents: 4,
      ...counted([
        ["bm_uid", ".bidmoor.example", "Bidmoor", "advertising"],
        ["fnb_vid", ".fernbid.example", "Fernbid", "advertising"],
        ["pm_id", ".pixelmoss.example", "Pixelmoss", "advertising"],
        ["th_uid", ".tallyhall.example", "Tallyhall", "analytics"],
      ]),
      firstPartyVendorCookieKeys: [],
      byEntity: {
        Bidmoor: { requests: 96, signedRequests: 96, cookieNames: ["bm_uid"], cookiesReturned: [], hosts: ["ads.bidmoor.example"] },
        Fernbid: { requests: 18, signedRequests: 18, cookieNames: ["fnb_vid"], cookiesReturned: [], hosts: ["tag.fernbid.example", "px.fernbid.example"] },
        Pixelmoss: { requests: 10, signedRequests: 10, cookieNames: ["pm_id"], cookiesReturned: [], hosts: ["px.pixelmoss.example"] },
        Tallyhall: { requests: 8, signedRequests: 8, cookieNames: ["th_uid"], cookiesReturned: [], hosts: ["px.tallyhall.example"] },
      },
    },
  }));
};

// shot-side-panel: a busy retail page in the side panel (retailer-k.example on the corpus: 121 cookies
// from 40 advertising vendors; this is a fraction of that). Vendors in Advertising and
// Analytics, then two domains no company is named for: the site's own content domain, whose
// script read GPC and wrote cookies, and a reviews widget that set one and read nothing.

const MARKET = "https://www.market.example";
const MARKET_CDN = "https://assets.marketcdn.example/js/app.js";
const MARKET_REVIEWS = "https://widget.reviews.example/embed.js";
const MARKET_DUNMORE = "https://c.dunmore.example/dx/tag.js";
const MARKET_INKWELL = "https://js.inkwell.example/rt/market.js";
const MARKET_QS = "https://cdn.quillstat.example/q/market.js";

const storeSidePanel = () => {
  const at = fromSite(MARKET);
  const D = ".market.example";
  const network = [
    at(`${MARKET}/`, { resourceType: "main_frame", initiator: null }),
    at(MARKET_CDN),
    at("https://assets.marketcdn.example/img/hero.webp", { resourceType: "image" }),
    at(MARKET_REVIEWS),
    at("https://widget.reviews.example/api/summary", { resourceType: "xmlhttprequest", setCookies: [cookie("rv_session", ".reviews.example", { expiresMs: Date.now() + 30 * 60_000 })] }),
    written(MARKET_CDN, [["mk_visitor", D], ["mk_session", D]]),
    at("https://tag.adlark.example/js/adlark.js"),
    at("https://bid.adlark.example/v2/bid?site=market", { resourceType: "xmlhttprequest", setCookies: [cookie("alk_uid", ".adlark.example")], cookiesSent: ["alk_uid"] }),
    at("https://tag.bidmoor.example/js/bm.js"),
    at("https://ads.bidmoor.example/slot?site=market&sz=300x250", { resourceType: "xmlhttprequest", setCookies: [cookie("bm_uid", ".bidmoor.example")], cookiesSent: ["bm_uid"] }),
    at("https://px.crestline.example/p?site=market", { resourceType: "image", setCookies: [cookie("cl_at", ".crestline.example")] }),
    at(MARKET_DUNMORE),
    at("https://bid.dunmore.example/e/bid?site=market", { resourceType: "xmlhttprequest", setCookies: [cookie("dx_id", ".dunmore.example")] }),
    at("https://tag.fernbid.example/f.js"),
    at("https://px.fernbid.example/e?evt=pageLoad", { resourceType: "image", setCookies: [cookie("fnb_vid", ".fernbid.example")] }),
    at("https://fast.glimmer.example/a/api/fast.json?site=market", { resourceType: "xmlhttprequest", setCookies: [cookie("gm_id", ".glimmer.example")] }),
    at("https://sync.glimmer.example/exchange/sync?p=market", { resourceType: "image", setCookies: [cookie("gm_audit", ".glimmer.example")] }),
    at(MARKET_INKWELL),
    at("https://px.inkwell.example/u?rd=1", { resourceType: "image", setCookies: [cookie("ink_id", ".inkwell.example"), cookie("ink_seg", ".inkwell.example")] }),
    at("https://px.pixelmoss.example/track?adv=market", { resourceType: "image", setCookies: [cookie("pm_id", ".pixelmoss.example")] }),
    at("https://px.tallyhall.example/b?site=market", { resourceType: "image", setCookies: [cookie("th_uid", ".tallyhall.example")] }),
    at(MARKET_QS),
    written(MARKET_QS, [["qs_session", D]]),
  ];
  const idOf = (url) => network.find((n) => n.url === url && n.method !== "SCRIPT")?.id ?? null;
  return fullList(MARKET, base({
    context: { finalUrl: `${MARKET}/`, topSite: "market.example" },
    signal: {
      secGpcRequestCount: 684, totalRequestCount: 684, readCount: 6,
      readsByScript: { [MARKET_CDN]: 3, [MARKET_DUNMORE]: 2, [MARKET_INKWELL]: 1 },
      readAttribution: { sampled: 6, unattributed: 0, viaTagManager: 0 },
    },
    network,
    confirmationNotice: "not-detected",
    wellKnown: { url: `${MARKET}/.well-known/gpc.json`, present: false, gpc: null, lastUpdate: null, observedAtMs: Date.now(), fresh: true, reason: "status 404" },
    tallies: {
      totalRequests: 684,
      signedRequests: 684,
      adVendorRequests: 182,
      adCookieEvents: 14,
      ...counted([
        ["alk_uid", ".adlark.example", "Adlark", "advertising"],
        ["bm_uid", ".bidmoor.example", "Bidmoor", "advertising"],
        ["cl_at", ".crestline.example", "Crestline Ads", "advertising"],
        ["dx_id", ".dunmore.example", "Dunmore Exchange", "advertising"],
        ["fnb_vid", ".fernbid.example", "Fernbid", "advertising"],
        ["gm_audit", ".glimmer.example", "Glimmer Media", "advertising"],
        ["gm_id", ".glimmer.example", "Glimmer Media", "advertising"],
        ["ink_id", ".inkwell.example", "Inkwell Retarget", "advertising"],
        ["ink_seg", ".inkwell.example", "Inkwell Retarget", "advertising"],
        ["pm_id", ".pixelmoss.example", "Pixelmoss", "advertising"],
        ["qs_session", D, "Quillstat", "analytics"],
        ["th_uid", ".tallyhall.example", "Tallyhall", "analytics"],
      ]),
      firstPartyVendorCookieKeys: [],
      byEntity: {
        Adlark: { requests: 18, signedRequests: 18, cookieNames: ["alk_uid"], cookiesReturned: ["alk_uid"], hosts: ["tag.adlark.example", "bid.adlark.example"] },
        Bidmoor: { requests: 64, signedRequests: 64, cookieNames: ["bm_uid"], cookiesReturned: ["bm_uid"], hosts: ["tag.bidmoor.example", "ads.bidmoor.example"] },
        "Crestline Ads": { requests: 9, signedRequests: 9, cookieNames: ["cl_at"], cookiesReturned: [], hosts: ["px.crestline.example"] },
        "Dunmore Exchange": { requests: 22, signedRequests: 22, cookieNames: ["dx_id"], cookiesReturned: [], hosts: ["c.dunmore.example", "bid.dunmore.example"] },
        Fernbid: { requests: 6, signedRequests: 6, cookieNames: ["fnb_vid"], cookiesReturned: [], hosts: ["tag.fernbid.example", "px.fernbid.example"] },
        "Glimmer Media": { requests: 14, signedRequests: 14, cookieNames: ["gm_audit", "gm_id"], cookiesReturned: ["gm_id"], hosts: ["fast.glimmer.example", "sync.glimmer.example"] },
        "Inkwell Retarget": { requests: 31, signedRequests: 31, cookieNames: ["ink_id", "ink_seg"], cookiesReturned: ["ink_id"], hosts: ["js.inkwell.example", "px.inkwell.example"] },
        Pixelmoss: { requests: 7, signedRequests: 7, cookieNames: ["pm_id"], cookiesReturned: [], hosts: ["px.pixelmoss.example"] },
        Quillstat: { requests: 8, signedRequests: 8, cookieNames: ["qs_session"], cookiesReturned: [], hosts: ["cdn.quillstat.example"] },
        Tallyhall: { requests: 3, signedRequests: 3, cookieNames: ["th_uid"], cookiesReturned: [], hosts: ["px.tallyhall.example"] },
      },
      byUnlistedDomain: {
        "marketcdn.example": unlistedTally("marketcdn.example", {
          requests: 180, signedRequests: 180, hosts: ["assets.marketcdn.example"], resourceTypes: ["image", "script"],
          cookieKeys: [K("mk_session", D), K("mk_visitor", D)], scriptRan: true, scriptRanOutsideXhr: true,
          firstObservationId: idOf(MARKET_CDN), executionObservationId: idOf(MARKET_CDN),
        }),
        "reviews.example": unlistedTally("reviews.example", {
          requests: 3, signedRequests: 3, hosts: ["widget.reviews.example"], resourceTypes: ["script", "xmlhttprequest"],
          cookieKeys: [K("rv_session", ".reviews.example")], scriptRan: true, scriptRanOutsideXhr: true,
          firstObservationId: idOf(MARKET_REVIEWS), executionObservationId: idOf(MARKET_REVIEWS),
        }),
      },
    },
  }));
};

export const FIXTURES = {
  heavy,
  functional,
  "signal-off": signalOff,
  mismatch,
  direct,
  "quiet-container": quietContainer,
  "two-containers": twoContainers,
  zone,
  honored,
  clean,
  "requests-disagree": requestsDisagree,
  unavailable,
  "needs-reload": needsReload,
  "new-tab": newTab,
  "browser-page": browserPage,
  restored,
  reclaimed,
  "reclaimed-kept": reclaimedKept,
  "reclaimed-some-kept": reclaimedSomeKept,
  "save-failed": saveFailed,
  "prerender-lost": prerenderLost,
  "delivery-gap": deliveryGap,
  "consent-capped": consentCapped,
  "load-failed": loadFailed,
  "consent-store": consentStore,
  "shown-and-set": shownAndSet,
  "no-data": () => null,
  containers,
  "containers-reclaimed": containersReclaimed,
  sevenTags,
  "unlisted-domains": unlistedDomains,
  "first-party": firstParty,
  "unlisted-domains-reclaimed": unlistedDomainsReclaimed,
  "store-honored": storeHonored,
  "store-brave": storeBrave,
  "store-brave-off": storeBraveOff,
  "store-notice-cookies": storeNoticeCookies,
  "store-read-gpc": storeReadGpc,
  "store-privacy-strings": storePrivacyStrings,
  "store-side-panel": storeSidePanel,
};

/**
 * The tab's address, for a fixture whose page is not the record's: the popup reads it from
 * the tab, and a page the extension cannot inspect is known by it alone. Every other fixture's
 * tab shows its record's finalUrl.
 */
export const TAB_ADDRESSES = {
  "new-tab": "chrome://newtab/",
  "browser-page": "chrome://settings/",
};
