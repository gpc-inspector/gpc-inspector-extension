// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import type { ContainerTally, ScriptInsertion, ScriptInsertionLoader } from "@gpc-inspector/schema";
import { containerSummaries, checksByContainer, recordKeyOf, withPersistedShape } from "../src/index.js";
import { buildObservationSet, fakeClassifier, request, cookie, consentApiCall } from "./helpers.js";

/**
 * What each tag container did (1.25.0), from the records that survive a worker reclaim.
 * Modeled on automaker-e.example (a Tealium profile loading vendors, a GTM container loading
 * Google tag ids) and news-f.example (a GTM container whose tags wrote the site's names).
 */

const classify = fakeClassifier([
  { match: "doubleclick.net", category: "advertising", entityName: "Google" },
  { match: "google-analytics.com", category: "analytics", entityName: "Google" },
  { match: "demdex.net", category: "advertising", entityName: "Adobe" },
  { match: "snapchat.com", category: "advertising", entityName: "Snap" },
  { match: "tiqcdn.com", category: "analytics", entityName: "Tealium" },
]);

const GTM = "https://www.googletagmanager.com/gtm.js?id=GTM-XAUE1000";
const GTAG = "https://www.googletagmanager.com/gtag/js?id=G-XAUE100000";
const GTAG_AW = "https://www.googletagmanager.com/gtag/js?id=AW-521000000";
const HELPER = "https://www.googletagmanager.com/static/service_worker/5a/sw_iframe.html";
const UTAG = "https://tags.tiqcdn.com/utag/automakere/tier1aue/prod/utag.js";
const UTAG_TAG = "https://tags.tiqcdn.com/utag/automakere/tier1aue/prod/utag.12.js";
const SNAP = "https://sc-static.snapchat.com/scevent.min.js";
const CDN = "https://cdn.unlisted-helper.net/lib.js";

function loader(over: Partial<ScriptInsertionLoader>): ScriptInsertionLoader {
  return {
    insertedBy: [], inlineFrames: false, currentScriptKey: null, containerUrls: [], via: "appendChild",
    frameOrigin: "https://www.example.com", topFrame: true, count: 1, timeMs: 1, ...over,
  };
}
const rec = (url: string, ...loaders: ScriptInsertionLoader[]): ScriptInsertion => ({ key: recordKeyOf(url), url, element: "script", loaders });
const bySite = loader({ insertedBy: ["https://www.example.com/app.js"] });
const byContainer = (frame: string) => loader({ insertedBy: [frame], containerUrls: [frame] });

const K = (n: string) => `${n}\u0000.example.com`;
const tally = (manager: ContainerTally["manager"], id: string | null, frames: string[], keys: string[]): ContainerTally => ({
  manager, id, frameUrls: frames, cookieKeys: keys, cookieKeysUnsigned: [], probeCookies: [], refusedWrites: [],
});

function capture() {
  return buildObservationSet({
    capabilities: { scriptInsertion: true, requestInitiation: true },
    gtm: { present: true, containerIds: ["GTM-XAUE1000", "GTM-QUIET"], gtagIds: ["G-XAUE100000", "AW-521000000"], consentMode: null },
    signal: {
      readAttribution: {
        sampled: 21, unattributed: 0, viaTagManager: 21,
        viaTagManagerByContainer: { [`${GTM}&l=dataLayer`]: 18, [UTAG]: 3 },
      },
    },
    consentApiCalls: [
      // A call from inside the Tealium profile whose stack also ran through a helper frame:
      // counted under the innermost frame that names an id.
      consentApiCall({ callerScriptUrl: null, viaTagManager: true, command: "getGPPData", containerUrls: [HELPER, UTAG] }),
      consentApiCall({ callerScriptUrl: null, viaTagManager: true, command: "ping", containerUrls: [GTAG] }),
    ],
    scriptInsertions: [
      rec(GTM, bySite),
      rec(GTAG, byContainer(GTM)),
      rec(GTAG_AW, byContainer(GTM)),
      rec(UTAG, bySite),
      rec(UTAG_TAG, byContainer(UTAG)),
      rec(SNAP, byContainer(UTAG)),
      rec(CDN, byContainer(UTAG)),
      // A helper of Google's, inserted from the GTM container's frames.
      rec(HELPER, byContainer(GTM)),
    ],
    requestInitiators: [
      rec("https://dpm.demdex.net/id?d_visid_ver=5", byContainer(UTAG)),
      rec("https://tr.snapchat.com/p", byContainer(UTAG)),
      rec("https://region1.google-analytics.com/g/collect", byContainer(GTAG)),
      rec("https://googleads.g.doubleclick.net/pagead/viewthroughconversion/521000000/", byContainer(GTAG_AW)),
    ],
    network: [
      request({ url: UTAG, method: "SCRIPT", setCookies: [cookie({ name: "utag_main_ses_id", domain: ".example.com", via: "documentCookie", writerScriptUrl: UTAG })] }),
    ],
    tallies: {
      totalRequests: 1, signedRequests: 1, adVendorRequests: 1, adCookieEvents: 1, adCookieKeys: [K("utag_main_ses_id")],
      firstPartyVendorCookieKeys: [], byEntity: {}, cookieDetails: {},
      byContainer: {
        "tealium:automakere/tier1aue": tally("tealium", "automakere/tier1aue", [UTAG], [K("AMCV_X%40AdobeOrg"), K("utag_main_ses_id")]),
        "gtag:G-XAUE100000": tally("gtag", "G-XAUE100000", [GTAG], [K("_ga"), K("_ga_XAUE100000")]),
        // Written from the helper's frame: its container's.
        "google:": tally("google", null, [HELPER], [K("_gcl_au")]),
      },
    },
  });
}

const byKey = (o = capture()) => new Map(containerSummaries(o, classify).map((s) => [`${s.identity.manager}:${s.identity.id ?? ""}`, s]));

describe("containerSummaries", () => {
  it("names who loaded each container, and the container graph's parent", () => {
    const s = byKey();
    expect(s.get("gtm:GTM-XAUE1000")?.loadedBy).toEqual([{ kind: "site", url: "https://www.example.com/app.js" }]);
    expect(s.get("gtag:G-XAUE100000")?.parent).toEqual({ manager: "gtm", id: "GTM-XAUE1000" });
    expect(s.get("gtag:G-XAUE100000")?.loadedBy).toMatchObject([{ kind: "container", identity: { manager: "gtm", id: "GTM-XAUE1000" } }]);
    expect(s.get("gtm:GTM-XAUE1000")?.loadedContainers).toEqual([
      { manager: "gtag", id: "AW-521000000" },
      { manager: "gtag", id: "G-XAUE100000" },
    ]);
  });

  it("lists the companies and the unlisted domains a container loaded, never its own tag files", () => {
    const t = byKey().get("tealium:automakere/tier1aue")!;
    expect(t.loaded).toEqual([{ entity: "Snap", category: "advertising" }]);
    expect(t.loadedDomains).toEqual(["unlisted-helper.net"]);
    expect(t.scripts).toEqual([UTAG]);
  });

  it("says where its tags sent requests, by company and category, with hostnames and no count", () => {
    const t = byKey().get("tealium:automakere/tier1aue")!;
    expect(t.requestsTo).toEqual([
      { entity: "Adobe", category: "advertising", domain: "demdex.net", hosts: ["dpm.demdex.net"] },
      { entity: "Snap", category: "advertising", domain: "snapchat.com", hosts: ["tr.snapchat.com"] },
    ]);
    expect(byKey().get("gtag:G-XAUE100000")?.requestsTo).toEqual([
      { entity: "Google", category: "analytics", domain: "google-analytics.com", hosts: ["region1.google-analytics.com"] },
    ]);
  });

  it("counts reads and calls under the innermost frame that names an id", () => {
    const s = byKey();
    expect(s.get("gtm:GTM-XAUE1000")?.reads).toBe(18);
    expect(s.get("tealium:automakere/tier1aue")).toMatchObject({ reads: 3, gppRead: true, consentCalls: [{ api: "__gpp", count: 1 }] });
    // A ping is a call, and not a read of the choice where no answer reported GPP 1.1.
    expect(s.get("gtag:G-XAUE100000")).toMatchObject({ gppRead: false, consentCalls: [{ api: "__gpp", count: 1 }] });
    // Under GPP 1.1 the ping's answer carries the string, so it is one.
    const v11 = { ...capture(), gpp: { rawString: "", applicableSections: [], gppVersion: "1.1", sections: {}, unparseable: false, fromWire: null } };
    expect(byKey(v11).get("gtag:G-XAUE100000")?.gppRead).toBe(true);
    // checksByContainer follows the same rule: the Tealium call is Tealium's, not the helper's.
    expect(checksByContainer(capture()).get("tealium:automakere/tier1aue")?.checks).toBe(4);
  });

  it("joins a frame that names no id to the named container that loaded it", () => {
    const s = byKey();
    expect(s.has("google:")).toBe(false);
    const gtm = s.get("gtm:GTM-XAUE1000")!;
    expect(gtm.cookies?.cookieKeys).toEqual([K("_gcl_au")]);
    expect(gtm.frameUrls).toContain(HELPER);
  });

  it("keeps what was written inside each container, as the tallies kept it", () => {
    const s = byKey();
    expect(s.get("tealium:automakere/tier1aue")?.cookies?.cookieKeys).toEqual([K("AMCV_X%40AdobeOrg"), K("utag_main_ses_id")]);
    expect(s.get("gtag:AW-521000000")?.cookies).toBeNull();
  });

  it("marks an id found on the page with nothing recorded under it", () => {
    const s = byKey();
    expect(s.get("gtm:GTM-QUIET")?.quiet).toBe(true);
    expect(s.get("gtm:GTM-XAUE1000")?.quiet).toBe(false);
  });

  it("is the same after a worker reclaim empties the request list", () => {
    const o = withPersistedShape(capture());
    const reclaimed = { ...o, network: [], context: { ...o.context, incomplete: true, incompleteReasons: ["worker-restarted" as const] } };
    expect(containerSummaries(reclaimed, classify)).toEqual(containerSummaries(o, classify));
  });
});
