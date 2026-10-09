// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { buildPopupView, type UrlClass, type PopupView } from "../src/ui/view-model.js";
import { SCHEMA_VERSION } from "@gpc-inspector/schema";
import { recordKeyOf } from "@gpc-inspector/engine";
import type { ContainerTally, ObservationSet, ScriptInsertion, ScriptInsertionLoader, Tallies } from "@gpc-inspector/schema";

/**
 * The Tag containers rows and the Google Consent Mode row (1.25.0), from the view model.
 * Modeled on automaker-e.example: a Tealium profile loaded by the site that wrote Adobe's names
 * and its own, a GTM container loaded by the site that loaded two Google tag ids, and an id
 * the loader scan found with nothing recorded.
 */

const GTM = "https://www.googletagmanager.com/gtm.js?id=GTM-XAUE1000";
const GTAG = "https://www.googletagmanager.com/gtag/js?id=G-XAUE100000";
const GTAG_AW = "https://www.googletagmanager.com/gtag/js?id=AW-521000000";
const UTAG = "https://tags.tiqcdn.com/utag/automakere/tier1aue/prod/utag.js";
const SNAP = "https://sc-static.snapchat.com/scevent.min.js";

const RULES: readonly (readonly [string, string | null, string])[] = [
  ["snapchat.com", "Snap", "advertising"],
  ["tiqcdn.com", "Tealium", "analytics"],
  ["google-analytics.com", "Google", "analytics"],
  ["doubleclick.net", "Google", "advertising"],
];
const classify = (url: string): UrlClass => {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* nobody's */
  }
  const domain = host.split(".").slice(-2).join(".");
  const rule = RULES.find(([m]) => host.includes(m));
  return { party: domain === "automaker-e.example" ? "first" : "third", category: rule?.[2] ?? "unknown", entity: rule?.[1] ?? null, domain };
};

function loader(over: Partial<ScriptInsertionLoader>): ScriptInsertionLoader {
  return {
    insertedBy: [], inlineFrames: false, currentScriptKey: null, containerUrls: [], via: "appendChild",
    frameOrigin: "https://www.automaker-e.example", topFrame: true, count: 1, timeMs: 1, ...over,
  };
}
const rec = (url: string, ...loaders: ScriptInsertionLoader[]): ScriptInsertion => ({ key: recordKeyOf(url), url, element: "script", loaders });
const bySite = loader({ insertedBy: ["https://www.automaker-e.example/app.js"] });
const inside = (frame: string) => loader({ insertedBy: [frame], containerUrls: [frame] });
const K = (n: string) => `${n}\u0000.automaker-e.example`;
const tally = (manager: ContainerTally["manager"], id: string, frames: string[], keys: string[]): ContainerTally => ({
  manager, id, frameUrls: frames, cookieKeys: keys, cookieKeysUnsigned: [], probeCookies: [], refusedWrites: [],
});
const detail = (container: string) => ({
  expiresMs: "session" as const, sameSite: "Lax" as const, secure: false, partitioned: false, via: "documentCookie" as const,
  host: "tags.tiqcdn.com", onRedirect: false, onRedirectSigned: false, firstSignedObservationId: "js-1", container,
});

function tallies(): Tallies {
  return {
    totalRequests: 3, signedRequests: 3, adVendorRequests: 2, adCookieEvents: 3,
    adCookieKeys: [K("_ga"), K("_ga_XAUE100000"), K("utag_main_ses_id")],
    adCookieKeysUnsigned: [],
    adCookieEntities: { [K("_ga")]: "Google", [K("_ga_XAUE100000")]: "Google", [K("utag_main_ses_id")]: "Tealium" },
    adCookieCategories: { [K("_ga")]: "analytics", [K("_ga_XAUE100000")]: "analytics", [K("utag_main_ses_id")]: "analytics" },
    firstPartyVendorCookieKeys: [],
    byEntity: {},
    byEntityCategory: {},
    cookieDetails: {
      [K("_ga")]: { ...detail("gtag:G-XAUE100000"), host: "www.googletagmanager.com" },
      [K("_ga_XAUE100000")]: { ...detail("gtag:G-XAUE100000"), host: "www.googletagmanager.com" },
      [K("utag_main_ses_id")]: detail("tealium:automakere/tier1aue"),
      [K("AMCV_X%40AdobeOrg")]: { ...detail("tealium:automakere/tier1aue"), firstSignedObservationId: null },
    },
    byContainer: {
      "gtag:G-XAUE100000": tally("gtag", "G-XAUE100000", [GTAG], [K("_ga"), K("_ga_XAUE100000")]),
      "tealium:automakere/tier1aue": tally("tealium", "automakere/tier1aue", [UTAG], [K("AMCV_X%40AdobeOrg"), K("utag_main_ses_id")]),
    },
  };
}

function obs(over: Partial<ObservationSet> = {}): ObservationSet {
  return {
    schemaVersion: SCHEMA_VERSION,
    context: {
      finalUrl: "https://www.automaker-e.example/us/en", topSite: "automaker-e.example", extensionVersion: "1.0.0", browserUserAgent: "t",
      os: "t", capturedAt: "2026-09-28T00:00:00.000Z", mode: "passive", incomplete: false, ...over.context,
    },
    signal: {
      secGpcRequestCount: 3, totalRequestCount: 3, source: "this-extension", propertyValue: true, readTracking: "active", readCount: 21,
      readsByScript: {},
      readAttribution: { sampled: 21, unattributed: 0, viaTagManager: 21, viaTagManagerByContainer: { [GTM]: 18, [UTAG]: 3 } },
      ...over.signal,
    },
    network: over.network ?? [],
    consentApiCalls: over.consentApiCalls ?? [],
    gpp: over.gpp ?? null,
    usPrivacy: null,
    tcf: null,
    gtm: over.gtm ?? { present: true, containerIds: ["GTM-XAUE1000", "GTM-QUIET"], gtagIds: ["G-XAUE100000", "AW-521000000"], consentMode: null, effectiveConsent: null, scriptFetched: true },
    confirmationNotice: "indeterminate",
    wellKnown: null,
    capabilities: { documentCookie: true, cookieStore: true, gpp: true, uspapi: true, tcfapi: true, dataLayer: true, scriptInsertion: true, requestInitiation: true, ...over.capabilities },
    scriptInsertions: over.scriptInsertions ?? [
      rec(GTM, bySite),
      rec(GTAG, inside(GTM)),
      rec(GTAG_AW, inside(GTM)),
      rec(UTAG, bySite),
      rec(SNAP, inside(UTAG)),
    ],
    requestInitiators: over.requestInitiators ?? [rec("https://tr.snapchat.com/p", inside(UTAG)), rec("https://region1.google-analytics.com/g/collect", inside(GTAG))],
    tallies: over.tallies ?? tallies(),
  };
}

const view = (o: ObservationSet): PopupView =>
  buildPopupView({
    observations: o, findings: [], distinctCookies: o.tallies.adCookieKeys.length, adTechRequests: 2, classify,
    isListedFunctional: () => false, sendingSignal: true, signalKnown: true,
  });

describe("the Tag containers rows", () => {
  it("draws one row per container, every Google tag id on one row, a container before what it loaded", () => {
    const v = view(obs());
    expect(v.containers.map((c) => [c.managerKey ?? c.manager, c.ids])).toEqual([
      // Rows that wrote a cookie first; the Google tag follows the container that loaded it.
      ["Tealium", ["automakere/tier1aue"]],
      ["Google Tag Manager", ["GTM-XAUE1000"]],
      ["containerNameGoogleTag", ["AW-521000000", "G-XAUE100000"]],
    ]);
  });

  it("names an id found with nothing recorded once, with no row of its own", () => {
    const v = view(obs());
    expect(v.containersQuiet).toEqual(["GTM-QUIET"]);
    expect(v.containers.flatMap((c) => c.ids)).not.toContain("GTM-QUIET");
  });

  it("leads with whether a tag inside read GPC, and says which of the three states it is", () => {
    const state = (o: ObservationSet) => view(o).containers.map((c) => [c.ids[0], c.checkKey, c.checkHelp.key]);
    expect(state(obs())).toEqual([
      ["automakere/tier1aue", "containerTagRead", "containerTagReadHelp"],
      ["GTM-XAUE1000", "containerTagRead", "containerTagReadHelp"],
      ["AW-521000000", "containerNoRead", "containerNoReadHelp"],
    ]);
    const capped = obs({ signal: { readAttribution: { sampled: 0, unattributed: 0, viaTagManager: 0, traceCapReached: true } } as never });
    expect(state(capped).map(([, k, h]) => [k, h])).toContainEqual(["containerCannotDetermine", "containerCannotDetermineHelp"]);
    const off = obs({ signal: { readTracking: "unavailable", readAttribution: null } as never });
    expect(state(off).map(([, k, h]) => [k, h])).toContainEqual(["containerCannotDetermine", "containerCannotDetermineHelpOff"]);
  });

  it("says a tag read GPC through GPP only when the string records a GPC value", () => {
    // The Google Tag Manager container made a GPP call and no traced read.
    const gppOnly = (gpp: ObservationSet["gpp"], signal: Partial<ObservationSet["signal"]> = {}) =>
      obs({
        signal: { readAttribution: { sampled: 3, unattributed: 0, viaTagManager: 3, viaTagManagerByContainer: { [UTAG]: 3 } }, ...signal } as never,
        consentApiCalls: [{ api: "__gpp", command: "getGPPData", callerScriptUrl: GTM, viaTagManager: true, containerUrls: [GTM], timeMs: 0 }],
        gpp,
      });
    const gtm = (o: ObservationSet) => view(o).containers.find((c) => c.ids[0] === "GTM-XAUE1000");
    const string = (fields: Record<string, number>): ObservationSet["gpp"] => ({ rawString: "x", applicableSections: [8], gppVersion: "1.1", sections: { usca: fields }, unparseable: false, fromWire: null });
    expect(gtm(gppOnly(string({ Gpc: 1 })))?.checkKey).toBe("containerTagRead");
    expect(gtm(gppOnly(string({ SaleOptOut: 2 })))?.checkKey).toBe("containerNoRead");
    expect(gtm(gppOnly(string({ SaleOptOut: 2 }), { source: "none", propertyValue: false }))?.checkKey).toBe("containerTagRead");
    const unknown = gtm(gppOnly(null));
    expect([unknown?.checkKey, unknown?.checkHelp.key]).toEqual(["containerCannotDetermine", "containerCannotDetermineHelpGpp"]);
  });

  it("names every cookie written inside, amber where the count includes it", () => {
    const [tealium, , google] = view(obs()).containers;
    expect(tealium?.cookies).toEqual([
      { name: "AMCV_X%40AdobeOrg", counted: false },
      { name: "utag_main_ses_id", counted: true },
    ]);
    expect(google?.cookies).toEqual([
      { name: "_ga", counted: true },
      { name: "_ga_XAUE100000", counted: true },
    ]);
  });

  it("says whom a counted name is counted under, and a name that is not, that it is not", () => {
    const tealium = view(obs()).containers[0]!;
    expect(tealium.detail.cookies.map((c) => [c.name, c.countedUnder ?? null])).toEqual([
      ["AMCV_X%40AdobeOrg", null],
      ["utag_main_ses_id", { entity: "Tealium", category: "analytics" }],
    ]);
    expect(tealium.detail.cookies[1]).toMatchObject({ expiry: "session", via: "page script", sameSite: "Lax" });
  });

  it("gives every counted name on a container row a place under the headline", () => {
    const v = view(obs());
    const counted = v.containers.flatMap((c) => c.cookies.filter((k) => k.counted).map((k) => k.name));
    const named = v.countNames.flatMap((n) => n.cookies);
    for (const name of counted) expect(named).toContain(name);
    expect(new Set(named).size).toBe(v.cookieCount);
  });

  it("says who loaded it in the vendor row's words", () => {
    const [tealium, gtm, google] = view(obs()).containers;
    expect(tealium?.loadedVia).toEqual({ parts: [{ key: "vendorLoadedBySite" }] });
    expect(gtm?.loadedVia).toEqual({ parts: [{ key: "vendorLoadedBySite" }] });
    expect(google?.loadedVia).toEqual({ parts: [{ key: "vendorLoadedViaGtm", substitution: ["GTM-XAUE1000"] }] });
  });

  it("fills every panel's sections, and leaves the containers it loaded off the Google tag's", () => {
    const [tealium, gtm, google] = view(obs()).containers;
    expect(tealium?.detail).toMatchObject({
      vendorsLoaded: [{ entity: "Snap", category: "advertising" }],
      containersLoaded: [],
      requestsTo: [{ entity: "Snap", category: "advertising", domain: "snapchat.com", hosts: ["tr.snapchat.com"] }],
      scripts: ["tags.tiqcdn.com/utag/automakere/tier1aue/prod/utag.js"],
      insertionsObserved: true,
      requestsObserved: true,
    });
    expect(gtm?.detail.containersLoaded).toEqual([{ name: "Google tag", nameKey: "containerNameGoogleTag", ids: ["AW-521000000", "G-XAUE100000"] }]);
    expect(google?.detail).not.toHaveProperty("containersLoaded");
    expect(google?.detail.scripts).toEqual([
      "www.googletagmanager.com/gtag/js?id=AW-521000000",
      "www.googletagmanager.com/gtag/js?id=G-XAUE100000",
    ]);
    expect(google?.detail.requestsTo).toEqual([
      { entity: "Google", category: "analytics", domain: "google-analytics.com", hosts: ["region1.google-analytics.com"] },
    ]);
  });

  it("never names a tag, and never counts requests", () => {
    const text = JSON.stringify(view(obs()).containers);
    expect(text).not.toMatch(/"(count|requestCount|signedRequestCount)":/);
    expect(text).not.toContain("utag.12.js");
  });

  it("is the same after a worker reclaim empties the request list", () => {
    const o = obs({ network: [{ id: "js-1", url: UTAG, method: "SCRIPT", resourceType: "other", initiator: null, secGpcPresent: true, cookiesSent: [], requestHeaders: [], statusCode: null, responseHeaders: null, isRedirectHop: false, setCookies: [], captureMethod: "documentCookie", timeMs: 0 }] });
    const reclaimed = { ...o, network: [], context: { ...o.context, incomplete: true, incompleteReasons: ["worker-restarted" as const] } };
    expect(view(reclaimed).containers).toEqual(view(o).containers);
    expect(view(reclaimed).containersQuiet).toEqual(view(o).containersQuiet);
  });

  it("is left out when the page ran no container", () => {
    const v = view(obs({ gtm: { present: false, containerIds: [], gtagIds: [], consentMode: null }, scriptInsertions: [], requestInitiators: [], signal: { readAttribution: null } as never, tallies: { ...tallies(), byContainer: {} } }));
    expect(v.containers).toEqual([]);
    expect(v.containersQuiet).toEqual([]);
  });

  it("says a capture from before the record predates it, rather than that nothing was set", () => {
    const { byContainer: _none, ...older } = tallies();
    const v = view(obs({ tallies: older as Tallies }));
    expect(v.containers.every((c) => c.cookiesPredate === true && c.cookies.length === 0)).toBe(true);
  });
});

describe("the Google Consent Mode row, case by case", () => {
  const gcm = (gtm: Partial<ObservationSet["gtm"]>) =>
    view(obs({ gtm: { present: true, containerIds: ["GTM-X"], gtagIds: [], consentMode: null, effectiveConsent: null, ...gtm } })).privacyStrings.find((r) => r.id === "gcm")!;
  const values = (row: ReturnType<typeof gcm>) => Object.fromEntries((row.groups ?? []).flatMap((g) => g.fields.map((f) => [f.label, f.valueKey])));
  const commands = (over: Partial<NonNullable<ObservationSet["gtm"]["consentMode"]>>): NonNullable<ObservationSet["gtm"]["consentMode"]> => ({
    ad_storage: "unspecified", ad_user_data: "unspecified", ad_personalization: "unspecified", analytics_storage: "unspecified",
    functionality_storage: "unspecified", personalization_storage: "unspecified", security_storage: "unspecified", ...over,
  });

  it("is the fourth row of Privacy strings", () => {
    expect(view(obs()).privacyStrings.map((r) => r.id)).toEqual(["gpp", "usp", "tcf", "gcm"]);
  });

  it("no Google tag: 'no Google tags', and it does not open", () => {
    const row = gcm({ present: false, containerIds: [], gtagIds: [], scriptFetched: false });
    expect(row.summary).toEqual([{ key: "valueConsentNoGoogleTags" }]);
    expect(row.groups).toBeUndefined();
  });

  it("Google's tags ran, every type without a value: 'not set', and it opens to say so", () => {
    const row = gcm({ effectiveConsent: { ad_storage: { implicit: true }, analytics_storage: {}, ad_user_data: { implicit: false } } });
    expect(row.summary).toEqual([{ key: "valueConsentNotSet" }]);
    expect(row.groups?.[0]).toMatchObject({ labelKey: "consentGroupTypes", noteKey: "consentNoneSetNote" });
    expect(row.groups?.[0]?.fields.map((f) => [f.label, f.valueKey, f.absence])).toEqual([
      ["ad_storage", "valueConsentTypeNotSet", true],
      ["ad_user_data", "valueConsentTypeNotSet", true],
      ["ad_personalization", "valueConsentTypeNotSet", true],
      ["analytics_storage", "valueConsentTypeNotSet", true],
    ]);
    expect(row.groups).toHaveLength(1);
  });

  it("analytics_storage updated to granted over three denied defaults: 1 of 4, from the store", () => {
    const row = gcm({
      effectiveConsent: {
        ad_storage: { default: false }, ad_user_data: { default: false }, ad_personalization: { default: false },
        analytics_storage: { default: false, update: true },
      },
      consentMode: commands({ ad_storage: "denied", analytics_storage: "denied" }),
    });
    expect(row.summary).toEqual([{ key: "valueConsentGranted", substitution: ["1"] }]);
    expect(values(row)["analytics_storage"]).toBe("valueGranted");
    expect(row.groups?.map((g) => g.labelKey)).toEqual(["consentGroupTypes", "consentGroupStorage"]);
  });

  it("values in the store and no command on the dataLayer, as on apparel-c.example: the count from the store", () => {
    const row = gcm({ effectiveConsent: { ad_storage: { default: true }, ad_user_data: { default: true }, ad_personalization: { default: true }, analytics_storage: { default: true } } });
    expect(row.summary).toEqual([{ key: "valueConsentGranted", substitution: ["4"] }]);
  });

  it("no store, a default with two types granted: 2 of 4, from the dataLayer", () => {
    const row = gcm({ effectiveConsent: null, consentMode: commands({ ad_storage: "granted", analytics_storage: "granted", ad_user_data: "denied" }) });
    expect(row.summary).toEqual([{ key: "valueConsentGranted", substitution: ["2"] }]);
    expect(values(row)["ad_personalization"]).toBe("valueConsentTypeNotSet");
  });

  it("no store, no command and no dataLayer watched: 'could not be read', and it does not open", () => {
    const row = view(
      obs({
        gtm: { present: true, containerIds: ["GTM-X"], gtagIds: [], consentMode: null, effectiveConsent: null },
        capabilities: { dataLayer: false } as ObservationSet["capabilities"],
      }),
    ).privacyStrings.find((r) => r.id === "gcm")!;
    expect(row.summary).toEqual([{ key: "valueConsentUnread" }]);
    expect(row.groups).toBeUndefined();
  });

  it("no store and no command, but a dataLayer was watched: 'not set', and it opens", () => {
    const row = gcm({ effectiveConsent: null, consentMode: null });
    expect(row.summary).toEqual([{ key: "valueConsentNotSet" }]);
    expect(values(row)["ad_storage"]).toBe("valueConsentTypeNotSet");
  });

  it("a store read empty: 'not set', and it opens", () => {
    const row = gcm({ effectiveConsent: {} });
    expect(row.summary).toEqual([{ key: "valueConsentNotSet" }]);
    expect(Object.keys(values(row))).toEqual(["ad_storage", "ad_user_data", "ad_personalization", "analytics_storage"]);
  });

  it("a type with a false default and a true implicit value reads denied", () => {
    const row = gcm({ effectiveConsent: { ad_storage: { default: false, implicit: true } } });
    expect(values(row)["ad_storage"]).toBe("valueDenied");
  });

  it("does not show a site's own consent type beside Google's", () => {
    const row = gcm({ effectiveConsent: { ad_storage: { default: true }, site_marketing: { default: true } } });
    expect(Object.keys(values(row))).not.toContain("site_marketing");
    expect(Object.keys(values(row))).toHaveLength(7);
  });

  it("names nobody, when a container sent the command", () => {
    const row = gcm({
      effectiveConsent: null,
      consentMode: commands({ analytics_storage: "granted" }),
      consentModeUpdateSetBy: "https://www.googletagmanager.com/gtm.js?id=GTM-X",
      consentModeDefaultSetBy: null,
    });
    expect(JSON.stringify(row)).not.toContain("GTM-X");
    expect(row).not.toHaveProperty("api");
    expect(row).not.toHaveProperty("nameKey");
  });

  it("never draws a value in color, and never says default or update", () => {
    const row = gcm({ effectiveConsent: { ad_storage: { default: false, update: true } } });
    expect(row.flagged).toBe(false);
    expect(JSON.stringify(row)).not.toMatch(/default|update/i);
  });
});
