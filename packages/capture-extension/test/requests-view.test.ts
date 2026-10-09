// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import messagesJson from "../public/_locales/en/messages.json" with { type: "json" };
import { buildRequestsView, categoryLabelKey, detailHead, gpcAbsentKey, labelFor, redirectKey, requestCount, responseKey, rowsToText, scriptWriteNote, setCookieMark } from "../src/ui/requests-view.js";
import { CATEGORIES } from "@gpc-inspector/engine";
import { registrableDomain } from "@gpc-inspector/lists";
import { SCHEMA_VERSION } from "@gpc-inspector/schema";
import type { ObservationSet, NetworkObservation, CookieRecord } from "@gpc-inspector/schema";
import type { Classifier, OwnerNames } from "@gpc-inspector/engine";

/** Minimal classifier: doubleclick is Google advertising, the top site is first-party. */
const classifier: Classifier = {
  classify(url: string, topSite: string) {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      host = "";
    }
    // The real resolver, so the tab's grouping is tested on the list's answer.
    const registrable = registrableDomain(host);
    const topRegistrable = registrableDomain(topSite);
    const party = registrable === topRegistrable ? "first" : "third";
    if (host.includes("doubleclick.net")) {
      return {
        party,
        category: "advertising",
        entity: { name: "Google", id: "google" },
        registrableDomain: registrable,
      };
    }
    if (host.includes("challenge.example")) {
      return {
        party,
        category: "unknown",
        entity: { name: "Bot Guard", id: "bot-guard" },
        registrableDomain: registrable,
      };
    }
    // Hosts before the domains they sit under: the first to match wins.
    const listed: [string, string, string | null][] = [
      ["google-analytics.com", "analytics", "Google"],
      ["bat.bing.com", "advertising", "Microsoft"],
      ["bing.com", "content", "Microsoft"],
      ["cookielaw.org", "consent-managers", "OneTrust"],
      // Disconnect names the owner and gives no category.
      ["techcrunch.com", "unknown", "Yahoo!"],
      ["owned.example.com", "content", "Example Corp"],
      // Listed under a counting category with no company.
      ["adnoco.net", "advertising", null],
    ];
    for (const [match, category, name] of listed) {
      if (host.includes(match)) {
        return { party, category: category as never, entity: name ? { name, id: name.toLowerCase() } : null, registrableDomain: registrable };
      }
    }
    return { party, category: "unknown", entity: null, registrableDomain: registrable };
  },
};

function cookie(name: string): CookieRecord {
  return {
    name,
    value: "SECRET-SESSION-VALUE",
    domain: ".example.com",
    path: "/",
    expiresMs: null,
    sameSite: "None",
    httpOnly: false,
    secure: true,
    partitioned: false,
    via: "onHeadersReceived",
  };
}

let n = 0;
function req(partial: Partial<NetworkObservation> & { url: string }): NetworkObservation {
  return {
    id: `r${++n}`,
    method: "GET",
    resourceType: "script",
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

function obs(network: NetworkObservation[], incomplete = false): ObservationSet {
  return {
    schemaVersion: SCHEMA_VERSION,
    context: {
      finalUrl: "https://example.com/",
      topSite: "example.com",
      extensionVersion: "1.0.0",
      browserUserAgent: "t",
      os: "t",
      capturedAt: "2026-08-21T00:00:00.000Z",
      mode: "passive",
      incomplete,
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

describe("labelFor", () => {
  it("shows host and path", () => {
    expect(labelFor("https://ads.doubleclick.net/gampad/ads")).toBe(
      "ads.doubleclick.net/gampad/ads",
    );
  });

  it("omits a bare root path", () => {
    expect(labelFor("https://example.com/")).toBe("example.com");
  });

  it("drops the query string entirely", () => {
    // Not only for width: ad-tech URLs carry identifiers in their parameters, and the row
    // is the most screenshotted surface in the extension. The full URL remains available
    // in the row's detail view, where seeing it is a deliberate act.
    expect(labelFor(`https://ads.example.com/x?${"a=1&".repeat(80)}`)).toBe(
      "ads.example.com/x",
    );
  });

  it("truncates a genuinely long path", () => {
    const label = labelFor(`https://ads.example.com/${"segment/".repeat(20)}`);
    expect(label.length).toBeLessThanOrEqual(64);
    expect(label.endsWith("…")).toBe(true);
  });

  it("falls back to the raw string when the URL will not parse", () => {
    expect(labelFor("not a url")).toBe("not a url");
  });
});

describe("filters", () => {
  const network = [
    req({ url: "https://example.com/app.js" }), // first-party
    req({ url: "https://ads.doubleclick.net/x", setCookies: [cookie("IDE")] }), // third, classified, cookie
    req({ url: "https://unknown-vendor.test/px" }), // third, uncategorized
  ];

  it("counts every filter regardless of which is active", () => {
    const v = buildRequestsView(obs(network), classifier, "all");
    expect(v.counts.all).toBe(3);
    expect(v.counts["third-party"]).toBe(2);
    expect(v.counts["set-cookie"]).toBe(1);
    expect(v.counts.uncategorized).toBe(1);
  });

  it("third-party excludes the site's own requests", () => {
    const v = buildRequestsView(obs(network), classifier, "third-party");
    expect(v.rows.every((r) => r.party === "third")).toBe(true);
    expect(v.rows).toHaveLength(2);
  });

  it("set-cookie selects only responses that set one", () => {
    const v = buildRequestsView(obs(network), classifier, "set-cookie");
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0]?.cookieNames).toEqual(["IDE"]);
  });

  it("uncategorized is third-party only, never the site's own domain", () => {
    // A first-party request is not "uncategorized" in the sense that matters: the filter
    // exists to show which THIRD parties the list did not recognize.
    const v = buildRequestsView(obs(network), classifier, "uncategorized");
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0]?.label).toContain("unknown-vendor.test");
  });

  it("shows a fingerprinting domain as third-party and uncategorized, with its company", () => {
    // The list names it and files it as a fingerprinter only. A technique is not a category
    // here, so the row has none, and it still carries the company.
    const v = buildRequestsView(obs([...network, req({ url: "https://challenge.example/token", setCookies: [cookie("aws-waf-token")] })]), classifier, "all");
    expect(v.counts["third-party"]).toBe(3);
    expect(v.counts.advertising).toBe(1);
    expect(v.counts.analytics).toBe(0);
    expect(v.counts.uncategorized).toBe(2);
    const row = v.rows.find((r) => r.label.startsWith("challenge.example"));
    expect(row).toMatchObject({ party: "third", category: "unknown", entity: "Bot Guard" });
  });

  it("returns an empty view for no observations rather than throwing", () => {
    const v = buildRequestsView(null, classifier, "all");
    expect(v.rows).toEqual([]);
    expect(v.counts.all).toBe(0);
  });
});

describe("every number counts HTTP requests only", () => {
  const write = (url: string, name: string, extra: Partial<NetworkObservation> = {}) =>
    req({ url, method: "SCRIPT", resourceType: "other", statusCode: null, captureMethod: "documentCookie", setCookies: [cookie(name)], ...extra });
  const network = () => [
    req({ url: "https://example.com/app.js" }),
    req({ url: "https://ads.doubleclick.net/x", setCookies: [cookie("IDE")] }),
    req({ url: "https://www.google-analytics.com/g/collect" }),
    req({ url: "https://unknown-vendor.test/px" }),
    // A first-party write, an advertising write, two analytics writes of one cookie and an
    // uncategorized one.
    write("https://example.com/app.js", "site_pref"),
    write("https://ads.doubleclick.net/tag.js", "__gads"),
    write("https://www.google-analytics.com/analytics.js", "_ga"),
    write("https://www.google-analytics.com/analytics.js", "_ga", { timeMs: 5 }),
    write("https://unknown-vendor.test/w.js", "uv"),
  ];

  it("leaves script writes out of every filter's count, and lists them under each", () => {
    const v = buildRequestsView(obs(network()), classifier, "all");
    expect(v.counts).toEqual({ all: 4, advertising: 1, analytics: 1, "third-party": 3, "set-cookie": 1, uncategorized: 1 });
    expect(v.listed).toEqual({ all: 9, advertising: 2, analytics: 3, "third-party": 7, "set-cookie": 6, uncategorized: 2 });
    expect(v.rows).toHaveLength(9);
    expect(v.scriptWriteCount).toBe(5);
    // Under a filter, the rows are its requests and its script writes, and the note counts
    // the writes it lists.
    const analytics = buildRequestsView(obs(network()), classifier, "analytics");
    expect(analytics.rows).toHaveLength(3);
    expect(analytics.scriptWriteCount).toBe(2);
    expect(analytics.counts).toEqual(v.counts);
  });

  it("counts responses with a Set-Cookie header under set-cookie, not script writes", () => {
    const v = buildRequestsView(obs(network()), classifier, "set-cookie");
    expect(v.counts["set-cookie"]).toBe(1);
    expect(v.rows.filter((r) => !r.scriptWrite).map((r) => r.label)).toEqual(["ads.doubleclick.net/x"]);
    expect(v.rows.filter((r) => r.scriptWrite)).toHaveLength(5);
  });

  it("puts the same number on the tab's label as the list's All", () => {
    const set = obs(network());
    expect(requestCount(set)).toBe(4);
    expect(requestCount(set)).toBe(buildRequestsView(set, classifier, "advertising").counts.all);
  });

  it("counts a domain's requests on its heading, and no script write", () => {
    const groups = buildRequestsView(obs(network()), classifier, "all").groups;
    const of = (domain: string) => groups.find((g) => g.domain === domain);
    expect(of("google-analytics.com")).toMatchObject({ requestCount: 1 });
    expect(of("google-analytics.com")?.rows).toHaveLength(3);
    expect(of("example.com")).toMatchObject({ requestCount: 1 });
    expect(buildRequestsView(obs([write("https://cdn.writer.test/w.js", "w")]), classifier, "all").groups[0]).toMatchObject({ requestCount: 0 });
  });

  it("says how many script writes the list holds, once, in the singular for one", () => {
    expect(scriptWriteNote(buildRequestsView(obs(network()), classifier, "all"))).toEqual({ key: "reqScriptWritesNote", substitution: "5" });
    expect(scriptWriteNote(buildRequestsView(obs(network()), classifier, "advertising"))).toEqual({ key: "reqScriptWritesNoteOne" });
    expect(scriptWriteNote(buildRequestsView(obs(network().slice(0, 4)), classifier, "all"))).toBeNull();
    expect(scriptWriteNote(buildRequestsView(null, classifier, "all"))).toBeNull();
    const m = messagesJson as Record<string, { message: string }>;
    expect(m["reqScriptWritesNote"]?.message).toBe("Also $COUNT$ cookies written by page scripts, listed with the requests.");
    expect(m["reqScriptWritesNoteOne"]?.message).toBe("Also 1 cookie written by a page script, listed with the requests.");
  });

  it("is not empty on a page whose only rows are script writes", () => {
    const v = buildRequestsView(obs([write("https://example.com/app.js", "a"), write("https://ads.doubleclick.net/tag.js", "b")]), classifier, "all");
    expect(v.counts.all).toBe(0);
    expect(v.listed.all).toBe(2);
    expect(v.rows).toHaveLength(2);
    expect(v.scriptWriteCount).toBe(2);
    // A filter with no request but a script write still lists it, so its chip stays enabled.
    expect(v.listed.advertising).toBe(1);
  });

  it("keeps counting a lost request listed from its kept record, and not a kept script write", () => {
    const keptOf = (o: NetworkObservation) => {
      const { initiator: _i, cookiesSent: _c, requestHeaders: _q, responseHeaders: _r, setCookies, ...rest } = o;
      return { ...rest, setCookies: setCookies.map(({ value: _v, ...c }) => c) };
    };
    const live = req({ id: "live", url: "https://ads.doubleclick.net/live" });
    const base = obs([live], true);
    const set = {
      ...base,
      context: { ...base.context, incompleteReasons: ["worker-restarted"] },
      keptCookieResponses: [
        keptOf(req({ id: "lost", url: "https://ads.doubleclick.net/lost", setCookies: [cookie("IDE")] })),
        keptOf(write("https://www.google-analytics.com/analytics.js", "_ga", { id: "lost-write" })),
      ],
    } as ObservationSet;
    const v = buildRequestsView(set, classifier, "all");
    expect(v.rows.map((r) => r.id)).toEqual(["lost", "lost-write", "live"]);
    expect(v.counts.all).toBe(2);
    expect(v.counts["set-cookie"]).toBe(1);
    expect(v.scriptWriteCount).toBe(1);
    expect(v.rows[1]).toMatchObject({ scriptWrite: true, kept: true });
    expect(requestCount(set)).toBe(2);
  });
});

describe("ordering", () => {
  it("preserves capture order, so a redirect chain reads in sequence", () => {
    // Rows are not reordered to float cookie-setting requests up. Within a domain
    // group the sequence a browser actually made the requests in is the informative one,
    // and a reordered list would break a redirect chain apart.
    n = 0;
    const network = [
      req({ url: "https://example.com/1.js" }),
      req({ url: "https://ads.doubleclick.net/a", setCookies: [cookie("IDE")] }),
      req({ url: "https://example.com/2.js" }),
      req({ url: "https://ads.doubleclick.net/b", setCookies: [cookie("DSID")] }),
    ];
    const v = buildRequestsView(obs(network), classifier, "all");
    expect(v.rows.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4"]);
  });
});

describe("row facts", () => {
  it("marks a request that did NOT carry the signal", () => {
    const v = buildRequestsView(
      obs([req({ url: "https://ads.doubleclick.net/x", secGpcPresent: false })]),
      classifier,
      "all",
    );
    expect(v.rows[0]?.secGpcPresent).toBe(false);
  });

  it("carries the redirect-hop flag through", () => {
    const v = buildRequestsView(
      obs([req({ url: "https://ads.doubleclick.net/x", statusCode: 302, isRedirectHop: true })]),
      classifier,
      "all",
    );
    expect(v.rows[0]?.isRedirectHop).toBe(true);
  });

  it("reports a null status for a request with no response observed", () => {
    const v = buildRequestsView(
      obs([req({ url: "https://ads.doubleclick.net/x", statusCode: null })]),
      classifier,
      "all",
    );
    expect(v.rows[0]?.statusCode).toBeNull();
  });

  it("propagates the incomplete flag so a truncated capture can be labeled", () => {
    expect(buildRequestsView(obs([], true), classifier, "all").incomplete).toBe(true);
  });

  it("says the list was dropped only when the worker was reclaimed (1.22.0)", () => {
    const withReasons = (reasons: string[]) => {
      const o = obs([], true);
      return { ...o, context: { ...o.context, incompleteReasons: reasons } } as ObservationSet;
    };
    expect(buildRequestsView(withReasons(["worker-restarted"]), classifier, "all").requestsDropped).toBe(true);
    expect(buildRequestsView(withReasons(["write-failed"]), classifier, "all").requestsDropped).toBe(false);
    expect(buildRequestsView(obs([], true), classifier, "all").requestsDropped).toBe(false);
  });
});

describe("rows kept past a reclaim (1.27.0)", () => {
  const kept = (id: string, url: string, names: string[]) => {
    const { initiator: _i, cookiesSent: _c, requestHeaders: _q, responseHeaders: _r, setCookies, ...rest } = req({ id, url, setCookies: names.map(cookie) });
    return { ...rest, setCookies: setCookies.map(({ value: _v, ...c }) => c) };
  };
  const reclaimed = (network: NetworkObservation[], keptCookieResponses: ReturnType<typeof kept>[], incomplete = false): ObservationSet => {
    const o = obs(network, true);
    return {
      ...o,
      context: { ...o.context, incompleteReasons: ["worker-restarted"] },
      keptCookieResponses,
      ...(incomplete ? { keptCookieResponsesIncomplete: true as const } : {}),
    } as ObservationSet;
  };

  it("lists the kept records the request list lost, first, and each once", () => {
    const later = req({ id: "later", url: "https://ads.doubleclick.net/later", setCookies: [cookie("B")] });
    const v = buildRequestsView(
      reclaimed([later], [kept("early", "https://ads.doubleclick.net/early", ["A"]), kept("later", "https://ads.doubleclick.net/later", ["B"])]),
      classifier,
      "all",
    );
    expect(v.rows.map((r) => [r.id, r.cookieNames])).toEqual([["early", ["A"]], ["later", ["B"]]]);
    expect(v.rows[0]).toMatchObject({ entity: "Google", category: "advertising", secGpcPresent: true, statusCode: 200 });
    expect(v.counts["set-cookie"]).toBe(2);
    expect(v.keptShown).toBe(1);
    expect(v.keptIncomplete).toBe(false);
    expect(rowsToText(v)).not.toContain("SECRET-SESSION-VALUE");
    // The restored row says its address is what was kept; the live one says nothing.
    expect(v.rows.map((r) => r.kept === true)).toEqual([true, false]);
    const [early, live] = rowsToText(v).split("\n").slice(1);
    expect(early).toContain("query-not-kept");
    expect(live).not.toContain("query-not-kept");
  });

  it("counts the tab's label as the list's All, without building the list", () => {
    const later = req({ id: "later", url: "https://ads.doubleclick.net/later", setCookies: [cookie("B")] });
    const set = reclaimed([later], [kept("early", "https://ads.doubleclick.net/early", ["A"]), kept("later", "https://ads.doubleclick.net/later", ["B"])]);
    expect(requestCount(set)).toBe(2);
    expect(requestCount(set)).toBe(buildRequestsView(set, classifier, "advertising").counts.all);
    expect(requestCount(null)).toBe(0);
    expect(requestCount(obs([]))).toBe(0);
  });

  it("says when some were not kept", () => {
    const v = buildRequestsView(reclaimed([], [], true), classifier, "all");
    expect(v.rows).toEqual([]);
    expect(v.keptShown).toBe(0);
    expect(v.keptIncomplete).toBe(true);
  });

  it("reads a set recorded before 1.27.0, which has no kept records", () => {
    expect(buildRequestsView(obs([]), classifier, "all")).toMatchObject({ rows: [], keptShown: 0, keptIncomplete: false });
  });

  it("has a note for each case, in the locale file", () => {
    const m = messagesJson as Record<string, { message: string }>;
    for (const key of ["requestsDropped", "requestsDroppedCookiesKept", "requestsDroppedSomeCookiesKept"]) expect(m[key]?.message).toBeTruthy();
  });
});

describe("copy export", () => {
  it("never includes a cookie VALUE", () => {
    // A cookie value is a session identifier. Copy is an exfiltration path like any other
    // (FR-24), and names alone carry the finding.
    const v = buildRequestsView(
      obs([req({ url: "https://ads.doubleclick.net/x", setCookies: [cookie("IDE")] })]),
      classifier,
      "all",
    );
    const text = rowsToText(v);
    expect(text).toContain("IDE");
    expect(text).not.toContain("SECRET-SESSION-VALUE");
  });

  it("exports only the rows the active filter selected", () => {
    n = 0;
    const network = [
      req({ url: "https://example.com/app.js" }),
      req({ url: "https://ads.doubleclick.net/x", setCookies: [cookie("IDE")] }),
    ];
    const text = rowsToText(buildRequestsView(obs(network), classifier, "set-cookie"));
    expect(text).toContain("doubleclick");
    expect(text).not.toContain("app.js");
  });

  it("names the filter and the row count in the header", () => {
    const text = rowsToText(buildRequestsView(obs([]), classifier, "third-party"));
    expect(text).toContain("third-party");
  });

  it("calls a row with no company uncategorized only where the list gives no category", () => {
    n = 0;
    const network = [req({ url: "https://tag.adnoco.net/t.js" }), req({ url: "https://unknown-vendor.test/px" })];
    const lines = rowsToText(buildRequestsView(obs(network), classifier, "all")).split("\n");
    expect(lines.find((l) => l.includes("adnoco.net"))).toContain("\tadvertising\t");
    expect(lines.find((l) => l.includes("unknown-vendor.test"))).toContain("\tuncategorized\t");
  });
});

describe("domain grouping", () => {
  it("groups several hostnames of one domain together", () => {
    n = 0;
    const v = buildRequestsView(
      obs([
        req({ url: "https://securepubads.g.doubleclick.net/a", setCookies: [cookie("IDE")] }),
        req({ url: "https://cm.g.doubleclick.net/b" }),
        req({ url: "https://unknown-vendor.test/c" }),
      ]),
      classifier,
      "all",
    );
    const dc = v.groups.find((g) => g.domain === "doubleclick.net");
    expect(dc?.rows).toHaveLength(2);
    expect(dc?.cookieNames).toEqual(["IDE"]);
  });

  it("does NOT merge separate domains owned by the same entity", () => {
    // This is the point of grouping by domain rather than entity: it shows that a
    // company's cookies arrived from several distinct hostnames, which entity grouping
    // folds into one row.
    n = 0;
    const v = buildRequestsView(
      obs([
        req({ url: "https://ads.doubleclick.net/a", setCookies: [cookie("IDE")] }),
        req({ url: "https://x.doubleclick.net/b" }),
      ]),
      classifier,
      "all",
    );
    expect(v.groups.map((g) => g.domain)).toContain("doubleclick.net");
    expect(v.groups).toHaveLength(1);
  });

  it("carries the entity name on the group without grouping by it", () => {
    n = 0;
    const v = buildRequestsView(
      obs([req({ url: "https://ads.doubleclick.net/a" })]),
      classifier,
      "all",
    );
    expect(v.groups[0]?.entity).toBe("Google");
  });

  it("lists first-party first, then alphabetically", () => {
    // Not sorted by cookie count or volume: an order that encodes importance invites the
    // reader to infer a ranking, and a volume-sorted list reshuffles under them while the
    // page is still loading.
    n = 0;
    const v = buildRequestsView(
      obs([
        req({ url: "https://zeta-vendor.test/a" }),
        req({ url: "https://ads.doubleclick.net/b", setCookies: [cookie("IDE")] }),
        req({ url: "https://example.com/app.js" }),
        req({ url: "https://alpha-vendor.test/c" }),
      ]),
      classifier,
      "all",
    );
    expect(v.groups.map((g) => g.domain)).toEqual([
      "example.com",
      "alpha-vendor.test",
      "doubleclick.net",
      "zeta-vendor.test",
    ]);
  });

  it("collects distinct cookie names across a group", () => {
    n = 0;
    const v = buildRequestsView(
      obs([
        req({ url: "https://a.doubleclick.net/1", setCookies: [cookie("IDE")] }),
        req({ url: "https://b.doubleclick.net/2", setCookies: [cookie("DSID")] }),
        req({ url: "https://c.doubleclick.net/3", setCookies: [cookie("IDE")] }),
      ]),
      classifier,
      "all",
    );
    expect(v.groups[0]?.cookieNames).toEqual(["DSID", "IDE"]);
  });

  it("groups only what the active filter selected", () => {
    n = 0;
    const v = buildRequestsView(
      obs([
        req({ url: "https://example.com/app.js" }),
        req({ url: "https://ads.doubleclick.net/b", setCookies: [cookie("IDE")] }),
      ]),
      classifier,
      "set-cookie",
    );
    expect(v.groups).toHaveLength(1);
    expect(v.groups[0]?.domain).toBe("doubleclick.net");
  });

  it("groups by the Public Suffix List, not the last two labels", () => {
    n = 0;
    const v = buildRequestsView(
      obs([
        req({ url: "https://www.tpmn.co.kr/a" }),
        req({ url: "https://ads.tpmn.co.kr/b" }),
        req({ url: "https://other.co.kr/c" }),
        req({ url: "http://127.0.0.1:8080/d" }),
        req({ url: "https://store-a.myshopify.com/e" }),
        req({ url: "https://cdn.store-b.myshopify.com/f" }),
      ]),
      classifier,
      "all",
    );
    expect(v.groups.map((g) => [g.domain, g.rows.length])).toEqual([
      ["127.0.0.1", 1],
      ["other.co.kr", 1],
      ["store-a.myshopify.com", 1],
      ["store-b.myshopify.com", 1],
      ["tpmn.co.kr", 2],
    ]);
  });

  it("keeps a URL with no host as a group of its own, under the URL", () => {
    n = 0;
    const v = buildRequestsView(obs([req({ url: "not a url" }), req({ url: "also not" })]), classifier, "all");
    expect(v.groups.map((g) => g.domain)).toEqual(["also not", "not a url"]);
  });
});

describe("first-party is not third-party and not uncategorized", () => {
  const network = [
    req({ url: "https://www.example.com/app.js" }),
    req({ url: "https://cdn.example.com/style.css" }),
    req({ url: "https://ads.doubleclick.net/x", setCookies: [cookie("IDE")] }),
    req({ url: "https://unknown-vendor.test/px" }),
  ];

  it("excludes the site's own requests from third-party", () => {
    // topSite can arrive as "www.news-f.example" while requests resolve to "news-f.example".
    // Compared as strings, every one of 373 requests on that page would land as third-party.
    n = 0;
    const v = buildRequestsView(obs(network), classifier, "all");
    expect(v.counts.all).toBe(4);
    expect(v.counts["third-party"]).toBe(2);
  });

  it("excludes the site's own requests from uncategorized", () => {
    // The list carries no first-party domains; a site's own requests are not a gap in it.
    n = 0;
    const v = buildRequestsView(obs(network), classifier, "uncategorized");
    expect(v.rows.every((r) => r.party === "third")).toBe(true);
    expect(v.rows).toHaveLength(1);
  });
});

describe("the advertising and analytics filters", () => {
  // Each is one half of the rule the cookie count uses, so the tab and the Overview agree on
  // who is counted.
  const network = () => [
    req({ url: "https://example.com/app.js" }),
    req({ url: "https://ads.doubleclick.net/x", setCookies: [cookie("IDE")] }),
    req({ url: "https://www.google-analytics.com/g/collect" }),
    req({ url: "https://bat.bing.com/action/0", setCookies: [cookie("MUID")] }),
    req({ url: "https://www.bing.com/sw.js" }),
    req({ url: "https://cdn.cookielaw.org/otSDKStub.js" }),
    req({ url: "https://unknown-vendor.test/px" }),
  ];

  it("selects third-party advertising, and third-party analytics, each on its own", () => {
    n = 0;
    const ads = buildRequestsView(obs(network()), classifier, "advertising");
    expect(ads.rows.map((r) => r.label)).toEqual(["ads.doubleclick.net/x", "bat.bing.com/action/0"]);
    const analytics = buildRequestsView(obs(network()), classifier, "analytics");
    expect(analytics.rows.map((r) => r.label)).toEqual(["www.google-analytics.com/g/collect"]);
  });

  it("counts both independently of the active filter, adding up to the third-party requests in either", () => {
    n = 0;
    const v = buildRequestsView(obs(network()), classifier, "all");
    expect(v.counts).toMatchObject({ all: 7, advertising: 2, analytics: 1, "third-party": 6 });
    const counted = v.rows.filter((r) => r.party === "third" && (r.category === "advertising" || r.category === "analytics"));
    expect(v.counts.advertising + v.counts.analytics).toBe(counted.length);
  });

  it("acts per request: a domain in two categories is under a filter with that category's requests", () => {
    n = 0;
    const v = buildRequestsView(obs(network()), classifier, "advertising");
    const bing = v.groups.find((g) => g.domain === "bing.com");
    expect(bing?.rows.map((r) => r.label)).toEqual(["bat.bing.com/action/0"]);
  });

  it("names the filter in the copied text by the word on its chip", () => {
    n = 0;
    expect(rowsToText(buildRequestsView(obs(network()), classifier, "advertising")).split("\n")[0]).toBe("# 2 requests (advertising)");
    expect(rowsToText(buildRequestsView(obs(network()), classifier, "analytics")).split("\n")[0]).toBe("# 1 requests (analytics)");
  });
});

describe("a domain's row names its top category", () => {
  const view = (network: NetworkObservation[]) => buildRequestsView(obs(network), classifier, "all");
  const group = (v: ReturnType<typeof view>, domain: string) => v.groups.find((g) => g.domain === domain);

  it("takes the first category, in the list's order, among the domain's requests", () => {
    // bing.com served bat.bing.com (Advertising) and www.bing.com (Content).
    n = 0;
    const v = view([req({ url: "https://www.bing.com/sw.js" }), req({ url: "https://bat.bing.com/action/0" })]);
    expect(group(v, "bing.com")).toMatchObject({ entity: "Microsoft", topCategory: "advertising", party: "third" });
    // And each request still names its own.
    expect(group(v, "bing.com")?.rows.map((r) => r.category)).toEqual(["content", "advertising"]);
  });

  it("names every category, not only the two that count", () => {
    n = 0;
    const v = view([
      req({ url: "https://cdn.cookielaw.org/otSDKStub.js" }),
      req({ url: "https://www.google-analytics.com/g/collect" }),
    ]);
    expect(group(v, "cookielaw.org")).toMatchObject({ entity: "OneTrust", topCategory: "consent-managers" });
    expect(group(v, "google-analytics.com")).toMatchObject({ entity: "Google", topCategory: "analytics" });
  });

  it("is unknown where the list gives none, with or without a company", () => {
    n = 0;
    const v = view([req({ url: "https://techcrunch.com/pixel.gif" }), req({ url: "https://unknown-vendor.test/px" })]);
    expect(group(v, "techcrunch.com")).toMatchObject({ entity: "Yahoo!", topCategory: "unknown" });
    expect(group(v, "unknown-vendor.test")).toMatchObject({ entity: null, topCategory: "unknown" });
  });

  it("leaves the site's own domain first party, whatever the list files it under", () => {
    n = 0;
    const v = view([req({ url: "https://owned.example.com/app.js" }), req({ url: "https://ads.doubleclick.net/x" })]);
    expect(v.groups[0]).toMatchObject({ domain: "example.com", party: "first", entity: "Example Corp" });
  });

  it("keeps the list alphabetical, the site's domain first, with no sections by category", () => {
    n = 0;
    const v = view([
      req({ url: "https://cdn.cookielaw.org/otSDKStub.js" }),
      req({ url: "https://ads.doubleclick.net/x" }),
      req({ url: "https://example.com/app.js" }),
      req({ url: "https://bat.bing.com/action/0" }),
    ]);
    expect(v.groups.map((g) => g.domain)).toEqual(["example.com", "bing.com", "cookielaw.org", "doubleclick.net"]);
  });
});

describe("cookie names the count includes", () => {
  // In the attention color, as on the Overview, so a name under the count can be found
  // here. Counted means what the headline counts: set on a third-party advertising or
  // analytics request that carried the signal.
  const deleted = (name: string): CookieRecord => ({ ...cookie(name), expiresMs: 0 });
  const view = (network: NetworkObservation[], signal: "on" | "off" = "on") => {
    const o = obs(network);
    return buildRequestsView(signal === "on" ? o : { ...o, signal: { ...o.signal, source: "none", propertyValue: false } }, classifier, "all");
  };
  const group = (v: ReturnType<typeof view>, domain: string) => v.groups.find((g) => g.domain === domain);

  it("marks a cookie set on a third-party advertising or analytics request", () => {
    n = 0;
    const v = view([
      req({ url: "https://ads.doubleclick.net/x", setCookies: [cookie("IDE"), cookie("DSID")] }),
      req({ url: "https://www.google-analytics.com/g/collect", setCookies: [cookie("_ga")] }),
    ]);
    expect(v.rows[0]?.countedCookieNames).toEqual(["IDE", "DSID"]);
    expect(group(v, "doubleclick.net")?.countedCookieNames).toEqual(["DSID", "IDE"]);
    expect(group(v, "google-analytics.com")?.countedCookieNames).toEqual(["_ga"]);
  });

  it("marks none on a response whose request was lost, with the signal on or off (1.26.0)", () => {
    n = 0;
    const lost = req({ url: "https://ads.doubleclick.net/x", secGpcPresent: false, requestLost: true, setCookies: [cookie("IDE")] });
    for (const signal of ["on", "off"] as const) {
      const v = view([lost], signal);
      expect(v.rows[0]).toMatchObject({ requestLost: true, cookieNames: ["IDE"], countedCookieNames: [] });
    }
  });

  it("marks none on the site's own requests, or in a category that does not count", () => {
    // The site's own __cf_bm behind Cloudflare is not in the count, and neither is a
    // consent tool's cookie, a Content domain's, or one from a domain the list does not know.
    n = 0;
    const v = view([
      req({ url: "https://example.com/", setCookies: [cookie("__cf_bm")] }),
      req({ url: "https://cdn.cookielaw.org/otSDKStub.js", setCookies: [cookie("OptanonConsent")] }),
      req({ url: "https://www.bing.com/sw.js", setCookies: [cookie("SRCHD")] }),
      req({ url: "https://unknown-vendor.test/px", setCookies: [cookie("x")] }),
    ]);
    expect(v.rows.flatMap((r) => r.countedCookieNames)).toEqual([]);
    expect(v.groups.flatMap((g) => g.countedCookieNames)).toEqual([]);
    expect(v.rows.map((r) => r.cookieNames)).toEqual([["__cf_bm"], ["OptanonConsent"], ["SRCHD"], ["x"]]);
  });

  it("marks only the counted request's names on a domain whose requests are in two categories", () => {
    n = 0;
    const v = view([
      req({ url: "https://bat.bing.com/action/0", setCookies: [cookie("MUID")] }),
      req({ url: "https://www.bing.com/sw.js", setCookies: [cookie("SRCHD")] }),
    ]);
    expect(group(v, "bing.com")).toMatchObject({ cookieNames: ["MUID", "SRCHD"], countedCookieNames: ["MUID"] });
  });

  it("follows the count: requests that carried the signal, or that did not when sending is off", () => {
    n = 0;
    const network = () => [
      req({ url: "https://ads.doubleclick.net/signed", setCookies: [cookie("IDE")] }),
      req({ url: "https://ads.doubleclick.net/unsigned", secGpcPresent: false, setCookies: [cookie("DSID")] }),
    ];
    expect(view(network()).rows.map((r) => r.countedCookieNames)).toEqual([["IDE"], []]);
    expect(view(network(), "off").rows.map((r) => r.countedCookieNames)).toEqual([[], ["DSID"]]);
  });

  it("does not mark a deletion, which set nothing", () => {
    n = 0;
    const v = view([req({ url: "https://ads.doubleclick.net/x", timeMs: 1_000, setCookies: [cookie("IDE"), deleted("cto_tld_test")] })]);
    expect(v.rows[0]?.countedCookieNames).toEqual(["IDE"]);
  });
});

describe("loaded-by on a request row", () => {
  it("names the loader for a script the records resolved, and nothing otherwise", async () => {
    const { buildRequestsView, rowsToText } = await import("../src/ui/requests-view.js");
    const resolution = {
      wrapperFrames: [],
      parents: new Map(),
      byKey: new Map([["https://connect.facebook.net/en_US/fbevents.js", [{ kind: "container", identity: { manager: "gtm", id: "GTM-A" }, ancestors: [], mixed: false }]]]),
      byPair: new Map(),
      undeterminedPairs: new Set(),
      firstInsertionByPair: new Map(),
      checks: new Map(),
    };
    const obs = {
      schemaVersion: "1.12.0",
      context: { finalUrl: "https://example.com/", topSite: "example.com", extensionVersion: "1", browserUserAgent: "t", os: "t", capturedAt: "2026-09-13T00:00:00.000Z", mode: "passive", incomplete: false },
      signal: { secGpcRequestCount: 0, totalRequestCount: 0, source: "this-extension", propertyValue: true, readTracking: "active", readCount: 0, readsByScript: {}, readAttribution: null },
      network: [
        { id: "1", url: "https://connect.facebook.net/en_US/fbevents.js?v=2", method: "GET", resourceType: "script", initiator: null, secGpcPresent: true, requestHeaders: [], cookiesSent: [], statusCode: 200, responseHeaders: null, isRedirectHop: false, setCookies: [], captureMethod: "onHeadersReceived", timeMs: 1 },
        { id: "2", url: "https://static.criteo.net/x.js", method: "GET", resourceType: "script", initiator: null, secGpcPresent: true, requestHeaders: [], cookiesSent: [], statusCode: 200, responseHeaders: null, isRedirectHop: false, setCookies: [], captureMethod: "onHeadersReceived", timeMs: 2 },
      ],
      consentApiCalls: [], gpp: null, usPrivacy: null, tcf: null,
      gtm: { present: false, containerIds: [], gtagIds: [], consentMode: null },
      confirmationNotice: "indeterminate",
      capabilities: { documentCookie: true, cookieStore: true, gpp: true, uspapi: true, tcfapi: true, dataLayer: true },
      wellKnown: null,
      tallies: { totalRequests: 0, signedRequests: 0, adVendorRequests: 0, adCookieEvents: 0, adCookieKeys: [], firstPartyVendorCookieKeys: [], byEntity: {} },
    } as never;
    const classifier = { classify: () => ({ party: "third", category: "advertising", entity: { name: "X", id: "x" }, registrableDomain: "x.net" }) } as never;
    const view = buildRequestsView(obs, classifier, "all", resolution as never);
    expect(view.rows[0]?.loadedBy).toEqual({ parts: [{ key: "vendorLoadedViaGtm", substitution: ["GTM-A"] }] });
    expect(view.rows[1]?.loadedBy).toBeNull();
    expect(rowsToText(view)).toContain("loaded-by: GTM-A");
    expect(buildRequestsView(obs, classifier, "all").rows[0]?.loadedBy).toBeNull();
  });
});

describe("category labels", () => {
  const messages: Readonly<Record<string, { message: string; description?: string }>> = messagesJson;

  it("has a label for every category a domain can carry, and none for a category that does not exist", () => {
    // Each engine category is one of Disconnect's, and the label is Disconnect's name for it.
    // A missing label renders the raw identifier; a leftover one (such as "Content
    // delivery" or "Functional") is copy for a category the list does not produce.
    const shown = CATEGORIES.filter((c) => c !== "unknown");
    const expected = new Set(shown.map(categoryLabelKey));
    const present = new Set(Object.keys(messages).filter((k) => k.startsWith("category_")));
    expect(present).toEqual(expected);
    expect(shown.map((c) => messages[categoryLabelKey(c)]?.message)).toEqual([
      "Advertising",
      "Analytics",
      "Social",
      "Content",
      "Email",
      "Email Aggressive",
      "Consent Managers",
      "Anti-fraud",
    ]);
  });

  it("credits every label to Disconnect in its description", () => {
    for (const c of CATEGORIES.filter((x) => x !== "unknown")) {
      expect(messages[categoryLabelKey(c)]?.description, c).toContain("Disconnect's");
    }
  });
});

describe("listed as functional, on the Requests tab", () => {
  const LISTED = new Set(["__cf_bm", "AWSALB"]);
  const listed = (name: string): boolean => LISTED.has(name);
  const network = () => [
    req({ url: "https://example.com/", setCookies: [cookie("__cf_bm")] }),
    req({ url: "https://ads.doubleclick.net/x", setCookies: [cookie("IDE"), cookie("AWSALB")] }),
    req({ url: "https://cdn.cookielaw.org/otSDKStub.js", setCookies: [cookie("__cf_bm")] }),
    req({ url: "https://ads.doubleclick.net/unsigned", secGpcPresent: false, setCookies: [cookie("__cf_bm")] }),
  ];
  const view = () => buildRequestsView(obs(network()), classifier, "all", undefined, listed);

  it("marks a listed name on a counted cookie, and on no other", () => {
    n = 0;
    const v = view();
    // The site's own __cf_bm behind Cloudflare is listed too, and is not in the count.
    expect(v.rows.map((r) => r.functionalCookieNames)).toEqual([[], ["AWSALB"], [], []]);
    expect(v.groups.find((g) => g.domain === "doubleclick.net")).toMatchObject({
      cookieNames: ["AWSALB", "IDE", "__cf_bm"],
      countedCookieNames: ["AWSALB", "IDE"],
      functionalCookieNames: ["AWSALB"],
    });
    expect(v.groups.find((g) => g.domain === "example.com")?.functionalCookieNames).toEqual([]);
  });

  it("says so in words in the copied text", () => {
    n = 0;
    const text = rowsToText(view());
    expect(text).toContain("set-cookie: IDE, AWSALB (listed as functional)");
    expect(text.match(/listed as functional/g)).toHaveLength(1);
  });

  it("marks nothing where no list is supplied, and moves no count", () => {
    n = 0;
    const bare = buildRequestsView(obs(network()), classifier, "all");
    expect(bare.rows.flatMap((r) => r.functionalCookieNames)).toEqual([]);
    n = 0;
    const v = view();
    expect(v.counts).toEqual(bare.counts);
    expect(v.rows.map((r) => r.countedCookieNames)).toEqual(bare.rows.map((r) => r.countedCookieNames));
  });
});


describe("a script's record, charged per cookie (1.25.0)", () => {
  const GTAG = "https://www.googletagmanager.com/gtag/js?id=G-XNWF200000";
  const owners: OwnerNames = {
    match: (manager, name) =>
      (manager === "gtag" || manager === "gtm") && (name === "_ga" || name.startsWith("_ga_"))
        ? { entity: { name: "Google", id: "google" }, category: "analytics" }
        : null,
  };
  const js = (name: string): CookieRecord => ({ ...cookie(name), via: "documentCookie", writerScriptUrl: GTAG });
  const network = () => [req({ url: GTAG, method: "SCRIPT", resourceType: "other", setCookies: [js("_ga"), js("nwf_byline")] })];

  it("marks the owner's name amber and the site's not, and says whom the amber one is counted under", () => {
    n = 0;
    const v = buildRequestsView(obs(network()), classifier, "all", undefined, undefined, owners);
    const row = v.rows[0]!;
    // googletagmanager.com names no company: the row says so, and the name says who.
    expect(row).toMatchObject({ entity: null, category: "unknown", cookieNames: ["_ga", "nwf_byline"] });
    expect(row.countedCookieNames).toEqual(["_ga"]);
    expect(row.countedUnder).toEqual([{ name: "_ga", entity: "Google", category: "analytics" }]);
    expect(v.groups[0]?.countedCookieNames).toEqual(["_ga"]);
  });

  it("marks neither without the owner's list, and keeps them under the container's host", () => {
    n = 0;
    const row = buildRequestsView(obs(network()), classifier, "all").rows[0]!;
    expect(row.countedCookieNames).toEqual([]);
    expect(row.countedUnder).toEqual([]);
    expect(row.domain).toBe("googletagmanager.com");
  });

  it("says nothing more of a name its own row already names", () => {
    n = 0;
    const row = buildRequestsView(obs([req({ url: "https://ads.doubleclick.net/x", setCookies: [cookie("IDE")] })]), classifier, "all", undefined, undefined, owners).rows[0]!;
    expect(row.countedCookieNames).toEqual(["IDE"]);
    expect(row.countedUnder).toEqual([]);
  });
});

describe("the words on a row and its detail", () => {
  const one = (r: NetworkObservation, signal: "on" | "off" = "on") => {
    const o = obs([r]);
    return buildRequestsView(signal === "on" ? o : { ...o, signal: { ...o.signal, source: "none", propertyValue: false } }, classifier, "all").rows[0]!;
  };
  const deleted = (name: string): CookieRecord => ({ ...cookie(name), expiresMs: 0 });
  const refused = (name: string): CookieRecord => ({ ...cookie(name), jar: "not-stored" });
  const messages: Readonly<Record<string, { message: string }>> = messagesJson;

  it("says a script wrote the cookie, and speaks of the property, on a script's record", () => {
    // sw.ts records a script write as method SCRIPT with no status, and the GPC property's
    // value where a request's header would be.
    const script = (secGpcPresent: boolean) =>
      one(req({ url: "https://static.criteo.net/js/ld/publishertag.js", method: "SCRIPT", resourceType: "other", statusCode: null, secGpcPresent, captureMethod: "documentCookie", setCookies: [cookie("cto_bundle")] }));
    const unset = script(false);
    expect(unset.scriptWrite).toBe(true);
    expect(gpcAbsentKey(unset, "mark")).toBe("reqNoGpcProperty");
    expect(gpcAbsentKey(script(true), "mark")).toBeNull();
    expect(messages["reqNoGpcProperty"]?.message).toBe("GPC property not set");
  });

  it("names the writer and the property in a script write's detail, with no request, Sec-GPC or response line", () => {
    const script = (secGpcPresent: boolean) =>
      one(req({ url: "https://static.criteo.net/js/ld/publishertag.js?v=2", method: "SCRIPT", resourceType: "other", statusCode: null, secGpcPresent, captureMethod: "documentCookie", setCookies: [cookie("cto_bundle")] }));
    expect(detailHead(script(true))).toEqual([
      { labelKey: "detailWrittenBy", value: "https://static.criteo.net/js/ld/publishertag.js?v=2" },
      { labelKey: "detailGpcProperty", valueKey: "detailGpcPropertySet" },
    ]);
    expect(detailHead(script(false))[1]).toEqual({ labelKey: "detailGpcProperty", valueKey: "detailGpcPropertyNotSet" });
    expect(messages["detailWrittenBy"]?.message).toBe("Written by");
    expect(messages["detailGpcProperty"]?.message).toBe("GPC property");
    expect(messages["detailGpcPropertySet"]?.message).toBe("set");
    expect(messages["detailGpcPropertyNotSet"]?.message).toBe("not set");
    expect(messages["reqScriptWriteMeta"]?.message).toBe("cookie written by a script");
    expect(messages).not.toHaveProperty("detailResponseScript");
  });

  it("opens a request's detail with its request, Sec-GPC and response lines", () => {
    expect(detailHead(one(req({ url: "https://ads.doubleclick.net/x" })))).toEqual([
      { labelKey: "detailRequest", value: "GET script" },
      { labelKey: "detailSecGpc", value: "1" },
      { labelKey: "detailResponse", value: "200" },
    ]);
    expect(detailHead(one(req({ url: "https://ads.doubleclick.net/x", statusCode: null, secGpcPresent: false }))).slice(1)).toEqual([
      { labelKey: "detailSecGpc", valueKey: "detailSignalAbsent" },
      { labelKey: "detailResponse", valueKey: "detailNoResponse" },
    ]);
  });

  it("copies a script write as one, with the property and no Sec-GPC mark", () => {
    const write = req({ url: "https://static.criteo.net/js/ld/publishertag.js", method: "SCRIPT", resourceType: "other", statusCode: null, captureMethod: "documentCookie", setCookies: [cookie("cto_bundle")] });
    const text = rowsToText(buildRequestsView(obs([req({ url: "https://ads.doubleclick.net/x" }), write]), classifier, "all"));
    const [header, , line] = text.split("\n");
    expect(header).toBe("# 1 requests, 1 cookie write by page scripts (all)");
    expect(line).toContain("\tcookie-written-by-script\t");
    expect(line).toContain("gpc-property:set");
    expect(line).not.toContain("sec-gpc");
    const unset = rowsToText(buildRequestsView(obs([{ ...write, secGpcPresent: false }, { ...write, id: "w2" }]), classifier, "all"));
    expect(unset.split("\n")[0]).toBe("# 0 requests, 2 cookie writes by page scripts (all)");
    expect(unset.split("\n")[1]).toContain("gpc-property:not-set");
  });

  it("keeps the request's words on every other row", () => {
    const missed = one(req({ url: "https://ads.doubleclick.net/x", statusCode: null, secGpcPresent: false }));
    expect(missed).not.toHaveProperty("scriptWrite");
    expect(responseKey(missed)).toBe("detailNoResponse");
    expect(gpcAbsentKey(missed, "mark")).toBe("reqNoGpc");
    expect(gpcAbsentKey(missed, "detail")).toBe("detailSignalAbsent");
    expect(responseKey(one(req({ url: "https://ads.doubleclick.net/x" })))).toBeNull();
    expect(gpcAbsentKey(one(req({ url: "https://ads.doubleclick.net/x" })), "detail")).toBeNull();
    // A lost request's signal was not observed, whatever wrote the record.
    const lost = one(req({ url: "https://ads.doubleclick.net/x", secGpcPresent: false, requestLost: true }));
    expect(gpcAbsentKey(lost, "mark")).toBe("requestLost");
    expect(gpcAbsentKey(lost, "detail")).toBe("requestLost");
  });

  it("says a redirect set cookies only when one it set was kept", () => {
    const redirect = (setCookies: CookieRecord[]) =>
      redirectKey(one(req({ url: "https://ads.doubleclick.net/x", statusCode: 302, isRedirectHop: true, timeMs: 1_000, setCookies })));
    expect(redirect([cookie("IDE")])).toBe("detailRedirectValue");
    expect(redirect([cookie("IDE"), refused("x")])).toBe("detailRedirectValue");
    expect(redirect([])).toBe("detailRedirectNoCookies");
    expect(redirect([deleted("IDE"), refused("DSID")])).toBe("detailRedirectNoCookies");
    expect(redirectKey(one(req({ url: "https://ads.doubleclick.net/x", setCookies: [cookie("IDE")] })))).toBeNull();
    expect(messages["detailRedirectValue"]?.message).toBe("this redirect set cookies");
    expect(messages["detailRedirectNoCookies"]?.message).toBe("this response was a redirect");
  });

  it("counts only the cookies set in the row's mark, and names every record in the detail", () => {
    const row = (setCookies: CookieRecord[]) => one(req({ url: "https://ads.doubleclick.net/x", timeMs: 1_000, setCookies }));
    const mixed = row([cookie("IDE"), cookie("DSID"), deleted("cto_tld_test"), refused("probe")]);
    expect(mixed.cookieNames).toEqual(["IDE", "DSID", "cto_tld_test", "probe"]);
    expect(mixed.setCookieNames).toEqual(["IDE", "DSID"]);
    expect(setCookieMark(mixed)).toEqual({ key: "markSetCookies", substitution: "2" });
    expect(setCookieMark(row([cookie("IDE"), deleted("old")]))).toEqual({ key: "markSetOneCookie" });
    expect(setCookieMark(row([deleted("old"), refused("x")]))).toBeNull();
    expect(setCookieMark(row([]))).toBeNull();
  });
});
