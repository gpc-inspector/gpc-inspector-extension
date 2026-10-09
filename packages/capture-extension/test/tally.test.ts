// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import {
  emptyTallies, tallyRequest, tallyCookies, freezeTallies, thawTallies, noteForVendor, untallyCookie,
  noteForPair, noteForContainer, noteForUnlisted, isRecordedKey, isFirstPartyKey, noteFirstPartyProbe, hostCharge,
  type TallyClassification, type MutableTallies,
} from "../src/background/tally.js";
import {
  entityCategoryKey, COOKIE_DETAIL_CAP, CONTAINER_COOKIE_CAP,
  UNLISTED_DOMAIN_CAP, UNLISTED_COOKIE_CAP, UNLISTED_HOST_CAP, FIRST_PARTY_COOKIE_CAP, REQUEST_LOST_COOKIE_CAP,
} from "@gpc-inspector/schema";
import { cookieCharge, type Classifier, type OwnerNames } from "@gpc-inspector/engine";
import type { NetworkObservation, CookieRecord, Tallies } from "@gpc-inspector/schema";
import { cookieNamesSent } from "../src/observe/cookies.js";

const AD: TallyClassification = { party: "third", category: "advertising", entityName: "Google" };
const FIRST: TallyClassification = { party: "first", category: "unknown", entityName: null };
const UNKNOWN: TallyClassification = { party: "third", category: "unknown", entityName: null };
/** A domain the list files only as a fingerprinter: named, no category, never a counting vendor. */
const FINGERPRINTING: TallyClassification = { party: "third", category: "unknown", entityName: "Bot Guard" };

function cookie(name: string, over: Partial<CookieRecord> = {}): CookieRecord {
  return {
    name, value: "v", domain: ".doubleclick.net", path: "/", expiresMs: null,
    sameSite: "None", httpOnly: false, secure: true, partitioned: false,
    via: "onHeadersReceived", ...over,
  };
}

let n = 0;
function req(over: Partial<NetworkObservation> = {}): NetworkObservation {
  return {
    id: `r${++n}`, url: "https://ads.doubleclick.net/x", method: "GET", resourceType: "image",
    initiator: null, secGpcPresent: true, cookiesSent: [], requestHeaders: [], statusCode: 200,
    responseHeaders: null, isRedirectHop: false, setCookies: [],
    captureMethod: "onHeadersReceived", timeMs: 0, ...over,
  };
}

describe("tallies are complete regardless of retention", () => {
  it("counts every request, including ones that will later be evicted", () => {
    // Counts computed by scanning a retained array would measure what survived eviction
    // rather than what happened, and would change with the retention rule.
    const t = emptyTallies();
    for (let i = 0; i < 5000; i++) tallyRequest(t, req(), () => AD);
    expect(t.totalRequests).toBe(5000);
    expect(t.adVendorRequests).toBe(5000);
  });

  it("separates signed from unsigned requests", () => {
    const t = emptyTallies();
    tallyRequest(t, req({ secGpcPresent: true }), () => AD);
    tallyRequest(t, req({ secGpcPresent: false }), () => AD);
    expect(t.totalRequests).toBe(2);
    expect(t.signedRequests).toBe(1);
  });

  it("counts only third-party ad/analytics as vendor requests", () => {
    const t = emptyTallies();
    tallyRequest(t, req(), () => AD);
    tallyRequest(t, req(), () => FIRST);
    tallyRequest(t, req(), () => UNKNOWN);
    tallyRequest(t, req(), () => FINGERPRINTING);
    expect(t.totalRequests).toBe(4);
    expect(t.adVendorRequests).toBe(1);
    expect(t.byEntity.has("Bot Guard")).toBe(false);
  });
});

describe("cookie counting", () => {
  it("distinguishes distinct cookies from set-events", () => {
    // An ad slot refreshing re-sets the same cookie; counting events measures dwell time as
    // much as site behavior.
    const t = emptyTallies();
    for (let i = 0; i < 3; i++) {
      tallyCookies(t, req({ setCookies: [cookie("IDE")] }), () => AD);
    }
    expect(t.adCookieEvents).toBe(3);
    expect(t.adCookieKeys.size).toBe(1);
  });

  it("treats the same name on different domains as distinct", () => {
    const t = emptyTallies();
    tallyCookies(t, req({ setCookies: [cookie("uid", { domain: ".a.com" })] }), () => AD);
    tallyCookies(t, req({ setCookies: [cookie("uid", { domain: ".b.com" })] }), () => AD);
    expect(t.adCookieKeys.size).toBe(2);
  });

  it("counts cookies on unsigned requests apart from the signed headline, never into it", () => {
    // The signed count is the claim about what happened while the signal was on. The
    // unsigned count is the baseline a reader compares it against with sending off.
    const t = emptyTallies();
    tallyCookies(t, req({ secGpcPresent: false, setCookies: [cookie("IDE")] }), () => AD);
    tallyCookies(t, req({ secGpcPresent: false, setCookies: [cookie("IDE")] }), () => AD);
    expect(t.adCookieEvents).toBe(0);
    expect(t.adCookieKeys.size).toBe(0);
    expect(t.adCookieEventsUnsigned).toBe(2);
    expect(t.adCookieKeysUnsigned.size).toBe(1);
    expect([...(t.byEntity.get("Google")?.cookieNamesUnsigned ?? [])]).toEqual(["IDE"]);
    expect(t.byEntity.get("Google")?.cookieNames.size).toBe(0);
  });

  it("does not count a first-party vendor-written cookie on an unsigned request", () => {
    // Supporting detail under the signed headline, not part of the comparison.
    const t = emptyTallies();
    tallyCookies(
      t,
      req({
        url: "https://shop.example.com/",
        secGpcPresent: false,
        setCookies: [cookie("_ga", { writerScriptUrl: "https://www.googletagmanager.com/gtag.js" })],
      }),
      () => FIRST,
      () => AD,
    );
    expect(t.firstPartyVendorCookieKeys.size).toBe(0);
  });

  it("counts a first-party vendor-written cookie separately from the headline", () => {
    const t = emptyTallies();
    tallyCookies(
      t,
      req({
        url: "https://site.example/page",
        setCookies: [
          cookie("_ga", { domain: ".site.example", via: "documentCookie",
            writerScriptUrl: "https://www.google-analytics.com/analytics.js" }),
        ],
      }),
      () => FIRST,
      () => ({ party: "third", category: "analytics", entityName: "Google" }),
    );
    expect(t.adCookieKeys.size).toBe(0);
    expect(t.firstPartyVendorCookieKeys.size).toBe(1);
  });

  it("counts nothing from a fingerprinting domain, third-party or first-party-written", () => {
    // Disconnect files bot-detection and WAF challenge hosts as fingerprinters and nothing
    // else, so a challenge token set on a signed request is not a counted analytics cookie.
    const t = emptyTallies();
    tallyCookies(t, req({ url: "https://challenge.example/token", setCookies: [cookie("aws-waf-token", { domain: ".challenge.example" })] }), () => FINGERPRINTING);
    tallyCookies(
      t,
      req({
        url: "https://site.example/page",
        setCookies: [cookie("aws-waf-token", { domain: ".site.example", via: "documentCookie", writerScriptUrl: "https://challenge.example/sdk.js" })],
      }),
      () => FIRST,
      () => FINGERPRINTING,
    );
    expect(t.adCookieEvents).toBe(0);
    expect(t.adCookieKeys.size).toBe(0);
    expect(t.adCookieCategories.size).toBe(0);
    expect(t.firstPartyVendorCookieKeys.size).toBe(0);
  });

  it("does not attribute an UNattributable first-party cookie to a vendor", () => {
    const t = emptyTallies();
    tallyCookies(
      t,
      req({
        url: "https://site.example/page",
        setCookies: [cookie("_ga", { domain: ".site.example", via: "documentCookie", writerScriptUrl: null })],
      }),
      () => FIRST,
    );
    expect(t.firstPartyVendorCookieKeys.size).toBe(0);
  });
});

describe("per-entity rollup", () => {
  it("accumulates requests, signed counts, hosts and cookie names", () => {
    const t = emptyTallies();
    tallyRequest(t, req({ url: "https://a.doubleclick.net/1" }), () => AD);
    tallyRequest(t, req({ url: "https://b.doubleclick.net/2", secGpcPresent: false }), () => AD);
    tallyCookies(t, req({ setCookies: [cookie("IDE")] }), () => AD);

    const e = t.byEntity.get("Google");
    expect(e?.requests).toBe(2);
    expect(e?.signedRequests).toBe(1);
    expect([...(e?.hosts ?? [])].sort()).toEqual(["a.doubleclick.net", "b.doubleclick.net"]);
    expect([...(e?.cookieNames ?? [])]).toEqual(["IDE"]);
  });
});

describe("round-trip through storage", () => {
  it("survives freeze and thaw unchanged", () => {
    // Storage serializes to JSON, so Sets and Maps must survive the trip.
    const t = emptyTallies();
    tallyRequest(t, req(), () => AD);
    tallyCookies(t, req({ setCookies: [cookie("IDE"), cookie("DSID")] }), () => AD);

    const round = thawTallies(freezeTallies(t));
    expect(round.totalRequests).toBe(t.totalRequests);
    expect(round.adCookieKeys.size).toBe(2);
    expect(round.byEntity.get("Google")?.cookieNames.size).toBe(2);
  });

  it("orders frozen output deterministically", () => {
    const build = () => {
      const t = emptyTallies();
      // A fixed id: the cookie details (1.22.0) name the observation that set each key.
      tallyCookies(t, req({ id: "r-fixed", setCookies: [cookie("zzz"), cookie("aaa")] }), () => AD);
      return JSON.stringify(freezeTallies(t));
    };
    expect(build()).toBe(build());
  });
});

describe("invariant: nothing is stored without being counted", () => {
  it("counts one request per observation that reaches storage", () => {
    // A path that stores an observation without tallying it leaves the stored list and the
    // tallies disagreeing: the kind of drift that makes every displayed number quietly wrong.
    // A redirect hop is such a path: onSendHeaders suffixes hop ids (`req#1`), so a
    // response looked up by its exact id misses the hop's observation and pushes a new one
    // that is never tallied. A stored list of 600 against tallies of 520 requests is the
    // sign (sw.ts, onHeadersReceived).
    const t = emptyTallies();
    const stored: NetworkObservation[] = [];

    const store = (o: NetworkObservation) => {
      stored.push(o);
      tallyRequest(t, o, () => AD);
    };

    for (let i = 0; i < 25; i++) store(req());
    expect(t.totalRequests).toBe(stored.length);
  });

  it("counts a JS-set cookie", () => {
    // A JS cookie observation stored and tallied nowhere would leave the headline
    // undercounting exactly the cookies response-header capture is blind to.
    const t = emptyTallies();
    const jsCookie = req({
      url: "https://ads.doubleclick.net/x",
      captureMethod: "documentCookie",
      setCookies: [cookie("IDE", { via: "documentCookie", writerScriptUrl: "https://ads.doubleclick.net/t.js" })],
    });
    tallyCookies(t, jsCookie, () => AD);
    expect(t.adCookieKeys.size).toBe(1);
    expect(t.adCookieEvents).toBe(1);
  });

  it("never counts a cookie twice for one observation", () => {
    const t = emptyTallies();
    const o = req({ setCookies: [cookie("IDE")] });
    tallyCookies(t, o, () => AD);
    expect(t.adCookieEvents).toBe(1);
  });
});

describe("no cap: counts and list both grow without bound", () => {
  it("counts a page of 10,000 requests", () => {
    // chrome.storage.session has a ~10MB quota and observations are ~449 bytes each.
    // Observations live in memory and never reach storage, so nothing caps them, and no
    // eviction can change a displayed number by dropping the wrong observations.
    const t = emptyTallies();
    for (let i = 0; i < 10_000; i++) tallyRequest(t, req(), () => AD);
    expect(t.totalRequests).toBe(10_000);
    expect(t.adVendorRequests).toBe(10_000);
  });

  it("keeps the tallies small even on an enormous page", () => {
    // The reason this is safe: tallies are bounded by REALITY, not by traffic. A page with
    // 10,000 requests still has a handful of vendors and a handful of distinct cookies.
    const t = emptyTallies();
    for (let i = 0; i < 10_000; i++) {
      tallyRequest(t, req(), () => AD);
      tallyCookies(t, req({ setCookies: [cookie("IDE")] }), () => AD);
    }
    const size = JSON.stringify(freezeTallies(t)).length;
    expect(t.adCookieKeys.size).toBe(1);
    expect(size).toBeLessThan(2000);
  });
});

describe("cookies sent back", () => {
  it("parses names from a Cookie header without keeping values", () => {
    const names = cookieNamesSent([
      { name: "Cookie", value: "IDE=AHWqTUsecret; DSID=NO_SECRET; other=x" },
    ]);
    expect(names).toEqual(["IDE", "DSID", "other"]);
    expect(JSON.stringify(names)).not.toContain("secret");
  });

  it("returns nothing when no Cookie header was sent", () => {
    expect(cookieNamesSent([{ name: "Accept", value: "*/*" }])).toEqual([]);
  });

  it("records a cookie as returned only if this entity set it", () => {
    // A request to doubleclick.net also carries unrelated cookies on that domain. Claiming
    // those as identifiers this vendor placed would overstate what was observed.
    const t = emptyTallies();
    // Production order: onSendHeaders counts the request, onHeadersReceived its cookies.
    const first = req({ setCookies: [cookie("IDE")] });
    tallyRequest(t, first, () => AD);
    tallyCookies(t, first, () => AD);
    tallyRequest(t, req({ cookiesSent: ["IDE", "unrelated"] }), () => AD);

    const e = t.byEntity.get("Google");
    expect([...(e?.cookiesReturned ?? [])]).toEqual(["IDE"]);
  });

  it("does not mark a cookie returned when nothing came back", () => {
    const t = emptyTallies();
    const first = req({ setCookies: [cookie("IDE")] });
    tallyRequest(t, first, () => AD);
    tallyCookies(t, first, () => AD);
    tallyRequest(t, req({ cookiesSent: [] }), () => AD);
    expect(t.byEntity.get("Google")?.cookiesReturned.size).toBe(0);
  });

  it("is binary — a repeated return does not accumulate", () => {
    // Zero versus non-zero is the distinction that carries meaning. A count would measure
    // how many requests the page made rather than what the site did.
    const t = emptyTallies();
    const first = req({ setCookies: [cookie("IDE")] });
    tallyRequest(t, first, () => AD);
    tallyCookies(t, first, () => AD);
    for (let i = 0; i < 40; i++) tallyRequest(t, req({ cookiesSent: ["IDE"] }), () => AD);
    expect(t.byEntity.get("Google")?.cookiesReturned.size).toBe(1);
  });

  it("treats a partitioned cookie like any other", () => {
    // A Partitioned cookie cannot build a cross-site profile, which is a real difference —
    // but whether that makes a disclosure lawful is a legal conclusion no regulator has
    // published. Excluding it here would encode that conclusion in a filter. The attribute
    // is reported alongside the fact and the reader decides.
    const t = emptyTallies();
    const first = req({ setCookies: [cookie("IDE", { partitioned: true })] });
    tallyRequest(t, first, () => AD);
    tallyCookies(t, first, () => AD);
    tallyRequest(t, req({ cookiesSent: ["IDE"] }), () => AD);
    expect([...(t.byEntity.get("Google")?.cookiesReturned ?? [])]).toEqual(["IDE"]);
  });
});

describe("the per-vendor summary (1.13.0): what survives when the requests do not", () => {
  it("records resource types and whether the vendor's own code ran", () => {
    const t = emptyTallies();
    tallyRequest(t, req({ resourceType: "image" }), () => AD);
    let g = freezeTallies(t).byEntity["Google"]!;
    expect(g.resourceTypes).toEqual(["image"]);
    expect(g.scriptRan).toBe(false);
    tallyRequest(t, req({ resourceType: "script" }), () => AD);
    g = freezeTallies(t).byEntity["Google"]!;
    expect(g.resourceTypes).toEqual(["image", "script"]);
    expect(g.scriptRan).toBe(true);
  });

  it("counts a cookie written by the vendor's own script as its code running", () => {
    const t = emptyTallies();
    const r = req({ resourceType: "image", setCookies: [cookie("IDE", { via: "documentCookie", writerScriptUrl: "https://securepubads.g.doubleclick.net/tag.js" })] });
    tallyRequest(t, r, () => AD);
    tallyCookies(t, r, () => AD);
    expect(freezeTallies(t).byEntity["Google"]!.scriptRan).toBe(true);
    // A cookie written by someone else's script says nothing about this vendor's code.
    const t2 = emptyTallies();
    tallyRequest(t2, r, () => AD);
    tallyCookies(t2, r, () => AD, () => ({ party: "third", category: "advertising", entityName: "Criteo" }));
    expect(freezeTallies(t2).byEntity["Google"]!.scriptRan).toBe(false);
  });

  it("keeps an old tally's silence about execution through thaw and freeze", () => {
    // A tab open across the upgrade has counts but no summary. Reading its absence as
    // "no script" would judge the vendor on a fact that was never recorded.
    const old = { ...freezeTallies(emptyTallies()), byEntity: { Google: { requests: 3, signedRequests: 3, cookieNames: [], cookiesReturned: [], hosts: ["ads.doubleclick.net"] } } };
    const frozen = freezeTallies(thawTallies(old as never));
    expect(frozen.byEntity["Google"]!.scriptRan).toBeUndefined();
    expect(frozen.byEntity["Google"]!.resourceTypes).toEqual([]);
  });
});

describe("cookie categories (1.17.0)", () => {
  it("records the category of the request that first set each counted key", () => {
    const t = emptyTallies();
    tallyCookies(t, req({ setCookies: [cookie("__gads")] }), () => AD);
    tallyCookies(t, req({ url: "https://x.medallia.com/", setCookies: [cookie("kampyle_userid", { domain: ".retailer-c.example" })] }), () => ({ party: "third", category: "analytics", entityName: "Medallia" }));
    expect(freezeTallies(t).adCookieCategories).toEqual({ "__gads\u0000.doubleclick.net": "advertising", "kampyle_userid\u0000.retailer-c.example": "analytics" });
  });
});

describe("the vendor that set each counted cookie (1.19.0)", () => {
  const CRITEO: TallyClassification = { party: "third", category: "advertising", entityName: "Criteo" };
  const KEY = "__gads\u0000.doubleclick.net";

  it("keeps the first vendor to set a key, through a freeze and thaw", () => {
    const t = emptyTallies();
    tallyCookies(t, req({ setCookies: [cookie("__gads")] }), () => AD);
    tallyCookies(t, req({ setCookies: [cookie("__gads")] }), () => CRITEO);
    expect(freezeTallies(thawTallies(freezeTallies(t))).adCookieEntities).toEqual({ [KEY]: "Google" });
  });

  it("records none for a request with no named vendor", () => {
    const t = emptyTallies();
    tallyCookies(t, req({ setCookies: [cookie("__gads")] }), () => ({ ...AD, entityName: null }));
    expect(freezeTallies(t).adCookieKeys).toEqual([KEY]);
    expect(freezeTallies(t).adCookieEntities).toEqual({});
  });

  it("takes a probed name off its own vendor even when another vendor has that name", () => {
    // The name leaves the probing vendor's list even while ANOTHER vendor still holds a
    // counted cookie of that name, or a probe of a common name stays credited to it.
    const t = emptyTallies();
    const CRITEO: TallyClassification = { ...AD, entityName: "Criteo" };
    tallyCookies(t, req({ url: "https://a.example/p", setCookies: [cookie("uid", { domain: ".criteo.com" })] }), () => CRITEO);
    tallyCookies(t, req({ url: "https://b.example/p", setCookies: [cookie("uid", { domain: ".doubleclick.net" })] }), () => AD);
    untallyCookie(t, "uid\u0000.criteo.com", "uid");
    const frozen = freezeTallies(t);
    expect(frozen.byEntity["Criteo"]?.cookieNames ?? []).toEqual([]);
    expect(frozen.byEntity["Google"]?.cookieNames).toEqual(["uid"]);
  });

  it("keeps a name on a vendor charged a counted key of it after another vendor was", () => {
    // Every vendor a key is charged to holds its name, not only the first, so a probe of the
    // name elsewhere does not take it off a later vendor that still has the key.
    const t = emptyTallies();
    const CRITEO: TallyClassification = { ...AD, entityName: "Criteo" };
    const OTHER: TallyClassification = { ...AD, entityName: "Other" };
    tallyCookies(t, req({ url: "https://a.example/p", setCookies: [cookie("uid", { domain: ".x.com" })] }), () => CRITEO);
    tallyCookies(t, req({ url: "https://b.example/p", setCookies: [cookie("uid", { domain: ".x.com" })] }), () => AD);
    tallyCookies(t, req({ url: "https://c.example/p", setCookies: [cookie("uid", { domain: ".other.com" })] }), () => OTHER);
    untallyCookie(t, "uid\u0000.other.com", "uid");
    const frozen = freezeTallies(t);
    expect(frozen.byEntity["Google"]?.cookieNames).toEqual(["uid"]);
    expect(frozen.byEntity["Criteo"]?.cookieNames).toEqual(["uid"]);
    expect(frozen.byEntity["Other"]?.cookieNames ?? []).toEqual([]);
  });

  it("keeps a name on the probing vendor while a key it was charged second still holds it", () => {
    const t = emptyTallies();
    const CRITEO: TallyClassification = { ...AD, entityName: "Criteo" };
    tallyCookies(t, req({ url: "https://a.example/p", setCookies: [cookie("uid", { domain: ".x.com" })] }), () => AD);
    tallyCookies(t, req({ url: "https://b.example/p", setCookies: [cookie("uid", { domain: ".x.com" })] }), () => CRITEO);
    tallyCookies(t, req({ url: "https://c.example/p", setCookies: [cookie("uid", { domain: ".y.com" })] }), () => CRITEO);
    untallyCookie(t, "uid\u0000.y.com", "uid");
    const frozen = freezeTallies(t);
    expect(frozen.byEntity["Criteo"]?.cookieNames).toEqual(["uid"]);
    expect(frozen.byEntity["Google"]?.cookieNames).toEqual(["uid"]);
  });

  it("takes a name off a vendor charged the probe second, whatever other vendors hold", () => {
    const t = emptyTallies();
    const CRITEO: TallyClassification = { ...AD, entityName: "Criteo" };
    const OTHER: TallyClassification = { ...AD, entityName: "Other" };
    tallyCookies(t, req({ url: "https://a.example/p", setCookies: [cookie("uid", { domain: ".p.com" })] }), () => AD);
    tallyCookies(t, req({ url: "https://b.example/p", setCookies: [cookie("uid", { domain: ".p.com" })] }), () => CRITEO);
    tallyCookies(t, req({ url: "https://c.example/p", setCookies: [cookie("uid", { domain: ".q.com" })] }), () => OTHER);
    untallyCookie(t, "uid\u0000.p.com", "uid");
    const frozen = freezeTallies(t);
    expect(frozen.byEntity["Criteo"]?.cookieNames ?? []).toEqual([]);
    expect(frozen.byEntity["Google"]?.cookieNames ?? []).toEqual([]);
    expect(frozen.byEntity["Other"]?.cookieNames).toEqual(["uid"]);
  });

  it("keeps every vendor's charge across a freeze and thaw, so a probe after a reclaim takes no name it should not (1.37.0)", () => {
    const t = emptyTallies();
    const CRITEO: TallyClassification = { ...AD, entityName: "Criteo" };
    // One key charged to Google on a signed request and to Criteo on an unsigned one, then
    // a key of the same name under another domain, Criteo's and signed.
    tallyCookies(t, req({ url: "https://a.example/p", setCookies: [cookie("uid", { domain: ".x.com" })] }), () => AD);
    tallyCookies(t, req({ url: "https://b.example/p", secGpcPresent: false, setCookies: [cookie("uid", { domain: ".x.com" })] }), () => CRITEO);
    tallyCookies(t, req({ url: "https://c.example/p", setCookies: [cookie("uid", { domain: ".y.com" })] }), () => CRITEO);
    const stored = freezeTallies(t);
    expect(stored.adCookieCharges).toEqual({
      signed: { "uid\u0000.x.com": ["Google"], "uid\u0000.y.com": ["Criteo"] },
      unsigned: { "uid\u0000.x.com": ["Criteo"] },
    });
    // The worker was reclaimed; the probe of Criteo's own key is taken out afterwards.
    const back = thawTallies(stored);
    untallyCookie(back, "uid\u0000.y.com", "uid");
    const frozen = freezeTallies(back);
    expect(frozen.byEntity["Google"]?.cookieNames).toEqual(["uid"]);
    expect(frozen.byEntity["Criteo"]?.cookieNames ?? []).toEqual([]);
    // Criteo's unsigned uid is still counted: a thaw from the first vendor alone would take
    // it off.
    expect(frozen.byEntity["Criteo"]?.cookieNamesUnsigned).toEqual(["uid"]);
  });

  it("charges a key to its first vendor alone when thawing a tally stored before 1.37.0", () => {
    const t = emptyTallies();
    tallyCookies(t, req({ url: "https://a.example/p", setCookies: [cookie("uid", { domain: ".x.com" })] }), () => AD);
    const { adCookieCharges: _dropped, ...older } = freezeTallies(t);
    const back = thawTallies(older);
    expect([...back.adCookieCharges.signed.get("uid\u0000.x.com") ?? []]).toEqual(["Google"]);
  });

  it("forgets the vendor when the cookie is taken out as a probe", () => {
    const t = emptyTallies();
    tallyCookies(t, req({ setCookies: [cookie("__gads")] }), () => AD);
    untallyCookie(t, KEY, "__gads");
    expect(freezeTallies(t).adCookieEntities).toEqual({});
  });
});

describe("per-vendor probes and refused writes (1.18.0)", () => {
  it("survives a freeze and thaw, and caps each vendor at 20", () => {
    const t = emptyTallies();
    for (let i = 0; i < 25; i++) noteForVendor(t.probeCookies, "Criteo", `probe_${i}`);
    noteForVendor(t.refusedCookieWrites, "media.net", "cto_bidid (.com)");
    const back = thawTallies(freezeTallies(t));
    expect(back.probeCookies.get("Criteo")?.size).toBe(20);
    expect([...(back.refusedCookieWrites.get("media.net") ?? [])]).toEqual(["cto_bidid (.com)"]);
  });
});

describe("one summary per company and category (1.20.0)", () => {
  const MS_AD: TallyClassification = { party: "third", category: "advertising", entityName: "Microsoft" };
  const MS_AN: TallyClassification = { party: "third", category: "analytics", entityName: "Microsoft" };
  const MS_CONTENT: TallyClassification = { party: "third", category: "content", entityName: "Microsoft" };
  const META: TallyClassification = { party: "third", category: "social", entityName: "Meta" };
  const ONETRUST: TallyClassification = { party: "third", category: "consent-managers", entityName: "OneTrust" };
  /** A company Disconnect names as an owner and gives no category. */
  const OWNER_ONLY: TallyClassification = { party: "third", category: "unknown", entityName: "Yahoo!" };

  const BY_HOST: Record<string, TallyClassification> = {
    "bat.bing.com": MS_AD,
    "www.clarity.ms": MS_AN,
    "www.bing.com": MS_CONTENT,
    "connect.facebook.net": META,
    "cdn.cookielaw.org": ONETRUST,
    "techcrunch.com": OWNER_ONLY,
    "ads.doubleclick.net": AD,
    "site.example": FIRST,
    "nobody.example": UNKNOWN,
  };
  const classify = (url: string): TallyClassification => BY_HOST[new URL(url).hostname] ?? UNKNOWN;
  const pair = (t: MutableTallies, c: TallyClassification) =>
    freezeTallies(t).byEntityCategory?.[entityCategoryKey(c.entityName ?? "", c.category)];

  /** A request and then its response's cookies, in the order production sees them. */
  function exchange(t: MutableTallies, o: NetworkObservation): void {
    tallyRequest(t, o, classify);
    tallyCookies(t, o, classify);
  }

  /** Requests to counting vendors: what the headline is made of. */
  const counting = (): NetworkObservation[] => [
    req({ url: "https://bat.bing.com/action/0", resourceType: "image", setCookies: [cookie("MUID", { domain: ".bing.com" })] }),
    req({ url: "https://www.clarity.ms/tag/x", resourceType: "script", setCookies: [cookie("CLID", { domain: ".clarity.ms" }), cookie("MUID", { domain: ".clarity.ms" })] }),
    req({ url: "https://ads.doubleclick.net/x", secGpcPresent: false, setCookies: [cookie("IDE")] }),
    req({ url: "https://bat.bing.com/action/1", resourceType: "image", cookiesSent: ["MUID", "unrelated"] }),
    req({ url: "https://site.example/page", setCookies: [cookie("sid", { domain: ".site.example" })] }),
  ];
  /** Requests in categories that do not count, every one of them setting a cookie. */
  const others = (): NetworkObservation[] => [
    req({ url: "https://www.bing.com/sa/simg/sw.js", resourceType: "script", setCookies: [cookie("SRCHD", { domain: ".bing.com" })] }),
    req({ url: "https://connect.facebook.net/en_US/fbevents.js", resourceType: "script", setCookies: [cookie("fr", { domain: ".facebook.com" })] }),
    req({ url: "https://cdn.cookielaw.org/otSDKStub.js", resourceType: "script", secGpcPresent: false, setCookies: [cookie("OptanonConsent", { domain: ".cookielaw.org" })] }),
    req({ url: "https://techcrunch.com/pixel", resourceType: "image", setCookies: [cookie("A1", { domain: ".techcrunch.com" })] }),
    req({ url: "https://www.bing.com/again", resourceType: "image", cookiesSent: ["SRCHD", "MUID"] }),
    req({ url: "https://nobody.example/x", setCookies: [cookie("x", { domain: ".nobody.example" })] }),
  ];

  /**
   * Every field a 1.19.0 tally had. The cookie details (1.22.0) record every category's
   * keys too, and the unlisted domains have a summary of their own (1.26.0).
   */
  const before = (t: Tallies): Omit<Tallies, "byEntityCategory" | "cookieDetails" | "byUnlistedDomain"> => {
    const { byEntityCategory: _summaries, cookieDetails: _details, byUnlistedDomain: _unlisted, ...rest } = t;
    return rest;
  };

  it("leaves every count and every field that existed before exactly as it was", () => {
    // Recording more must never move the headline. The same visit, with and without the
    // requests in categories that do not count.
    const without = emptyTallies();
    for (const o of counting()) exchange(without, o);
    const withOthers = emptyTallies();
    const mixed = [...counting(), ...others()];
    // Interleaved, so an other-category request sits between a cookie and its return.
    for (const o of [mixed[0]!, mixed[5]!, mixed[1]!, mixed[6]!, mixed[2]!, mixed[7]!, mixed[3]!, mixed[8]!, mixed[4]!, mixed[9]!, mixed[10]!]) {
      exchange(withOthers, o);
    }

    const a = before(freezeTallies(without));
    const b = before(freezeTallies(withOthers));
    // Requests are requests, whoever they went to: these two count every one.
    expect(b.totalRequests - a.totalRequests).toBe(others().length);
    expect(b.signedRequests - a.signedRequests).toBe(others().filter((o) => o.secGpcPresent).length);
    expect({ ...b, totalRequests: 0, signedRequests: 0 }).toEqual({ ...a, totalRequests: 0, signedRequests: 0 });
    expect(b.adCookieKeys).toEqual(["CLID\u0000.clarity.ms", "MUID\u0000.bing.com", "MUID\u0000.clarity.ms"]);
    expect(b.adVendorRequests).toBe(4);
    expect(Object.keys(b.byEntity)).toEqual(["Google", "Microsoft"]);
  });

  it("keeps a company's categories apart", () => {
    const t = emptyTallies();
    for (const o of [...counting(), ...others()]) exchange(t, o);

    const ad = pair(t, MS_AD)!;
    expect(ad).toMatchObject({ entity: "Microsoft", category: "advertising", requests: 2, signedRequests: 2 });
    expect(ad.hosts).toEqual(["bat.bing.com"]);
    expect(ad.resourceTypes).toEqual(["image"]);
    expect(ad.scriptRan).toBe(false);

    const an = pair(t, MS_AN)!;
    expect(an.hosts).toEqual(["www.clarity.ms"]);
    expect(an.scriptRan).toBe(true);

    const content = pair(t, MS_CONTENT)!;
    expect(content.requests).toBe(2);
    expect(content.hosts).toEqual(["www.bing.com"]);
    expect(content.scriptRan).toBe(true);
  });

  it("covers every category, and a company with an owner and no category", () => {
    const t = emptyTallies();
    for (const o of others()) exchange(t, o);
    expect(pair(t, META)?.cookieKeys).toEqual(["fr\u0000.facebook.com"]);
    expect(pair(t, OWNER_ONLY)).toMatchObject({ category: "unknown", requests: 1, cookieKeys: ["A1\u0000.techcrunch.com"] });
    // Set on a request that did not carry the signal: kept apart, as the counts keep theirs.
    expect(pair(t, ONETRUST)).toMatchObject({ cookieKeys: [], cookieKeysUnsigned: ["OptanonConsent\u0000.cookielaw.org"] });
  });

  it("has none for the site's own requests or a domain with no company", () => {
    const t = emptyTallies();
    exchange(t, req({ url: "https://site.example/page", setCookies: [cookie("sid", { domain: ".site.example" })] }));
    exchange(t, req({ url: "https://nobody.example/x", setCookies: [cookie("x", { domain: ".nobody.example" })] }));
    // A counting category with no company named is an unlisted-domain row, from its keys.
    tallyCookies(t, req({ setCookies: [cookie("IDE")] }), () => ({ ...AD, entityName: null }));
    expect(freezeTallies(t).byEntityCategory).toEqual({});
  });

  it("keeps a counted cookie's key in the counts and nowhere else", () => {
    const t = emptyTallies();
    for (const o of counting()) exchange(t, o);
    expect(pair(t, MS_AD)?.cookieKeys).toEqual([]);
    expect(pair(t, MS_AN)?.cookieKeys).toEqual([]);
    expect(pair(t, AD)).toMatchObject({ cookieKeys: [], cookieKeysUnsigned: [] });
    // Each counted key with a company has that company's summary, in the key's category.
    const f = freezeTallies(t);
    for (const key of [...f.adCookieKeys, ...(f.adCookieKeysUnsigned ?? [])]) {
      const entity = f.adCookieEntities?.[key];
      const category = f.adCookieCategories?.[key];
      expect(f.byEntityCategory?.[entityCategoryKey(entity!, category!)], key).toBeDefined();
    }
  });

  it("marks a cookie returned only to the category that set it", () => {
    const t = emptyTallies();
    for (const o of [...counting(), ...others()]) exchange(t, o);
    // MUID went back to bat.bing.com, which set it. www.bing.com carried it too and set
    // SRCHD, not MUID: for Content only SRCHD came back.
    expect(pair(t, MS_AD)?.cookiesReturned).toEqual(["MUID"]);
    expect(pair(t, MS_CONTENT)?.cookiesReturned).toEqual(["SRCHD"]);
    expect(pair(t, MS_AN)?.cookiesReturned).toEqual([]);
  });

  it("counts a cookie a script wrote as that script's category running", () => {
    const t = emptyTallies();
    const written = req({
      url: "https://bat.bing.com/p", resourceType: "image",
      setCookies: [cookie("_uetvid", { domain: ".site.example", via: "documentCookie", writerScriptUrl: "https://www.clarity.ms/tag/x" })],
    });
    exchange(t, written);
    // The advertising request was an image. The script that wrote is Microsoft's, from its
    // analytics domain, so that is the category whose code ran.
    expect(pair(t, MS_AD)?.scriptRan).toBe(false);
    expect(pair(t, MS_AN)?.scriptRan).toBe(true);
    // Another company's script says nothing about this one.
    const t2 = emptyTallies();
    exchange(t2, { ...written, setCookies: [cookie("_uetvid", { domain: ".site.example", via: "documentCookie", writerScriptUrl: "https://connect.facebook.net/en_US/fbevents.js" })] });
    expect(pair(t2, MS_AD)?.scriptRan).toBe(false);
    expect(pair(t2, META)).toBeUndefined();
  });

  it("takes a probe out of a summary, and knows which keys it holds", () => {
    const t = emptyTallies();
    for (const o of others()) exchange(t, o);
    const key = "fr\u0000.facebook.com";
    expect(isRecordedKey(t, key)).toBe(true);
    expect(isRecordedKey(t, "MUID\u0000.bing.com")).toBe(false);
    untallyCookie(t, key, "fr");
    expect(pair(t, META)?.cookieKeys).toEqual([]);
    expect(isRecordedKey(t, key)).toBe(false);
  });

  it("records probes and refused writes per category, capped, for a named third party only", () => {
    const t = emptyTallies();
    for (let i = 0; i < 25; i++) noteForPair(t, MS_AN, "probeCookies", `probe_${i}`);
    noteForPair(t, MS_AD, "refusedWrites", "_uetvid (.com)");
    noteForPair(t, FIRST, "refusedWrites", "sid (.com)");
    noteForPair(t, UNKNOWN, "probeCookies", "x");
    expect(pair(t, MS_AN)?.probeCookies).toHaveLength(20);
    expect(pair(t, MS_AD)?.refusedWrites).toEqual(["_uetvid (.com)"]);
    expect(pair(t, MS_AD)?.probeCookies).toEqual([]);
    expect(Object.keys(freezeTallies(t).byEntityCategory ?? {})).toHaveLength(2);
    // The per-vendor lists are the worker's to write, and these calls leave them alone.
    expect(freezeTallies(t).probeCookies).toEqual({});
    expect(freezeTallies(t).refusedCookieWrites).toEqual({});
  });

  it("survives a freeze and thaw, in a stable order", () => {
    const build = (): MutableTallies => {
      // The same observation ids each time: the cookie details (1.22.0) name them.
      n = 0;
      const t = emptyTallies();
      for (const o of [...counting(), ...others()]) exchange(t, o);
      noteForPair(t, META, "probeCookies", "_fbp_test");
      return t;
    };
    const frozen = freezeTallies(build());
    expect(freezeTallies(thawTallies(frozen))).toEqual(frozen);
    expect(JSON.stringify(freezeTallies(build()))).toBe(JSON.stringify(frozen));
    expect(Object.keys(frozen.byEntityCategory ?? {})).toEqual([...Object.keys(frozen.byEntityCategory ?? {})].sort());
  });

  it("thaws a tally stored before the summaries existed, and goes on counting", () => {
    // A tab open across the update: counts and no summaries. It must not crash the worker on
    // its next request, and its counts must carry on from where they were.
    const t = emptyTallies();
    for (const o of counting()) exchange(t, o);
    const old = before(freezeTallies(t)) as Tallies;
    expect("byEntityCategory" in old).toBe(false);

    const thawed = thawTallies(old);
    expect(thawed.byEntityCategory.size).toBe(0);
    exchange(thawed, req({ url: "https://bat.bing.com/action/2", resourceType: "script" }));
    const after = freezeTallies(thawed);
    expect(after.adVendorRequests).toBe(old.adVendorRequests + 1);
    expect(after.adCookieKeys).toEqual(old.adCookieKeys);
    // The summary starts from that request. It does not invent the ones it never saw.
    expect(after.byEntityCategory?.[entityCategoryKey("Microsoft", "advertising")]).toMatchObject({ requests: 1, scriptRan: true });
  });
});

describe("cookie details (1.22.0)", () => {
  const KEY = "IDE\u0000.doubleclick.net";
  const ANALYTICS: TallyClassification = { party: "third", category: "analytics", entityName: "Google" };

  it("keeps the latest attributes, and the first signed set's request and host", () => {
    const t = emptyTallies();
    tallyCookies(t, req({ id: "u1", secGpcPresent: false, url: "https://a.doubleclick.net/x", setCookies: [cookie("IDE", { sameSite: "Lax" })] }), () => AD);
    tallyCookies(t, req({ id: "s1", url: "https://b.doubleclick.net/x", setCookies: [cookie("IDE", { sameSite: "None" })] }), () => AD);
    tallyCookies(t, req({ id: "s2", url: "https://c.doubleclick.net/x", setCookies: [cookie("IDE", { expiresMs: 123 })] }), () => AD);
    expect(t.cookieDetails.get(KEY)).toEqual({
      expiresMs: 123, sameSite: "None", secure: true, partitioned: false, via: "onHeadersReceived",
      host: "b.doubleclick.net", onRedirect: false, onRedirectSigned: false, firstSignedObservationId: "s1",
    });
  });

  it("marks a redirect only when a signed set came on one", () => {
    const t = emptyTallies();
    tallyCookies(t, req({ secGpcPresent: false, isRedirectHop: true, setCookies: [cookie("IDE")] }), () => AD);
    expect(t.cookieDetails.get(KEY)).toMatchObject({ onRedirect: true, onRedirectSigned: false });
    tallyCookies(t, req({ isRedirectHop: true, setCookies: [cookie("IDE")] }), () => AD);
    expect(t.cookieDetails.get(KEY)).toMatchObject({ onRedirect: true, onRedirectSigned: true });
  });

  it("records the categories that do not count, and never a first-party cookie nobody attributable wrote", () => {
    // The first-party summary keeps the key (1.26.0), and no detail: the cap on details stays
    // the vendor panels'.
    const t = emptyTallies();
    tallyCookies(t, req({ setCookies: [cookie("bg")] }), () => FINGERPRINTING);
    tallyCookies(t, req({ url: "https://example.com/", setCookies: [cookie("session", { domain: ".example.com" })] }), () => FIRST);
    expect([...t.cookieDetails.keys()]).toEqual(["bg\u0000.doubleclick.net"]);
    expect(freezeTallies(t).firstParty?.cookieKeys).toEqual(["session\u0000.example.com"]);
  });

  it("leaves with the key when a probe is taken out", () => {
    const t = emptyTallies();
    tallyCookies(t, req({ setCookies: [cookie("IDE")] }), () => AD);
    untallyCookie(t, KEY, "IDE");
    expect(t.cookieDetails.has(KEY)).toBe(false);
  });

  it("caps the keys the headline does not count, never the ones it does", () => {
    const t = emptyTallies();
    for (let i = 0; i < 1000; i++) {
      tallyCookies(t, req({ setCookies: [cookie(`f${i}`)] }), () => FINGERPRINTING);
    }
    expect(t.cookieDetails.size).toBe(1000);
    tallyCookies(t, req({ setCookies: [cookie("over")] }), () => FINGERPRINTING);
    expect(t.cookieDetails.has("over\u0000.doubleclick.net")).toBe(false);
    // Past the cap the summary still records the key, and the panel shows it by name.
    expect(isRecordedKey(t, "over\u0000.doubleclick.net")).toBe(true);
    // Counted keys, signed and unsigned: the findings need the one, and with sending off the
    // headline is the other.
    tallyCookies(t, req({ setCookies: [cookie("IDE")] }), () => AD);
    tallyCookies(t, req({ secGpcPresent: false, setCookies: [cookie("ANON")] }), () => ANALYTICS);
    expect(t.cookieDetails.get(KEY)?.firstSignedObservationId).not.toBeNull();
    expect(t.cookieDetails.has("ANON\u0000.doubleclick.net")).toBe(true);
  });

  it("thaws a tally stored before the details existed, and starts them with the next set", () => {
    const t = emptyTallies();
    tallyCookies(t, req({ setCookies: [cookie("IDE")] }), () => AD);
    const { cookieDetails: _none, ...old } = freezeTallies(t);
    const thawed = thawTallies(old as Tallies);
    expect(thawed.cookieDetails.size).toBe(0);
    tallyCookies(thawed, req({ id: "later", setCookies: [cookie("IDE")] }), () => AD);
    expect(thawed.cookieDetails.get(KEY)?.firstSignedObservationId).toBe("later");
  });
});

describe("what was written inside each container (1.25.0)", () => {
  const GTM_NFD = "https://www.googletagmanager.com/gtm.js?id=GTM-XNWF100";
  const GTAG = "https://www.googletagmanager.com/gtag/js?id=G-XNWF200000";
  const UTAG = "https://tags.tiqcdn.com/utag/automakere/tier1aue/prod/utag.js";
  const TOP = "example.com";

  /** The list, as the fixtures need it: whose each host is, and in which category. */
  const HOSTS: Record<string, [string, string | null]> = {
    "ads.doubleclick.net": ["advertising", "Google"],
    "www.google-analytics.com": ["analytics", "Google"],
    "tags.tiqcdn.com": ["analytics", "Tealium"],
    "www.googletagmanager.com": ["unknown", null],
  };
  const classifier: Classifier = {
    classify(url) {
      const host = new URL(url).hostname;
      const [category, entity] = HOSTS[host] ?? ["unknown", null];
      const domain = host.split(".").slice(-2).join(".");
      return { party: domain === TOP ? "first" : "third", category: category as never, entity: entity === null ? null : { name: entity, id: entity.toLowerCase() }, registrableDomain: domain };
    },
  };
  const owners: OwnerNames = {
    match(manager, name) {
      if ((manager === "gtm" || manager === "gtag") && (name === "_ga" || name.startsWith("_ga_"))) return { entity: { name: "Google", id: "google" }, category: "analytics" };
      if (manager === "tealium" && name.startsWith("utag_main")) return { entity: { name: "Tealium", id: "tealium" }, category: "analytics" };
      return null;
    },
  };
  const classify = (url: string): TallyClassification => {
    const c = classifier.classify(url, TOP);
    return { party: c.party, category: c.category, entityName: c.entity?.name ?? null };
  };
  const js = (name: string, writer: string, over: Partial<NetworkObservation> = {}): NetworkObservation =>
    req({
      url: writer, method: "SCRIPT", resourceType: "other",
      setCookies: [cookie(name, { domain: ".example.com", via: "documentCookie", writerScriptUrl: writer })],
      ...over,
    });
  /** A request and then its cookies, each charged by the engine's one rule, as the worker does. */
  function exchange(t: MutableTallies, o: NetworkObservation): void {
    if (o.method !== "SCRIPT") tallyRequest(t, o, classify);
    tallyCookies(t, o, classify, classify, (c) => cookieCharge(c, o.url, TOP, classifier, owners));
  }
  const K = (name: string) => `${name}\u0000.example.com`;

  const vendors = (): NetworkObservation[] => [
    req({ url: "https://ads.doubleclick.net/x", setCookies: [cookie("IDE")] }),
    req({ url: "https://tags.tiqcdn.com/utag/automakere/tier1aue/prod/utag.js", resourceType: "script" }),
  ];
  const writes = (): NetworkObservation[] => [
    js("nwf_byline", GTM_NFD),
    js("_ga", GTAG),
    js("AMCV_X%40AdobeOrg", UTAG),
    js("utag_main_ses_id", UTAG),
    js("nwf_section", GTM_NFD, { secGpcPresent: false }),
  ];

  it("changes no field that existed before, but for the owners' names it counts", () => {
    const without = emptyTallies();
    for (const o of vendors()) exchange(without, o);
    const withWrites = emptyTallies();
    for (const o of [...vendors(), ...writes()]) exchange(withWrites, o);
    const a = freezeTallies(without);
    const b = freezeTallies(withWrites);

    // The moved keys, by name: Google's _ga and Tealium's utag_main_ses_id enter, each
    // under its owner in the name's category. Nothing else moves.
    expect(b.adCookieKeys).toEqual([...a.adCookieKeys, K("_ga"), K("utag_main_ses_id")].sort());
    expect(b.adCookieEntities).toEqual({ ...a.adCookieEntities, [K("_ga")]: "Google", [K("utag_main_ses_id")]: "Tealium" });
    expect(b.adCookieCategories).toEqual({ ...a.adCookieCategories, [K("_ga")]: "analytics", [K("utag_main_ses_id")]: "analytics" });
    expect(b.adCookieEvents).toBe(a.adCookieEvents + 2);
    expect(b.adCookieKeysUnsigned).toEqual(a.adCookieKeysUnsigned);
    expect(b.firstPartyVendorCookieKeys).toEqual(a.firstPartyVendorCookieKeys);
    expect([b.totalRequests, b.signedRequests, b.adVendorRequests]).toEqual([a.totalRequests, a.signedRequests, a.adVendorRequests]);
    // No company holds a name its container wrote and its owner does not own.
    const held = Object.values(b.byEntityCategory ?? {}).flatMap((p) => [...p.cookieKeys, ...p.cookieKeysUnsigned]);
    expect(held.filter((k) => /^(nwf_|AMCV_)/.test(k))).toEqual([]);
    expect(Object.values(b.byEntity).flatMap((e) => [...e.cookieNames, ...(e.cookieNamesUnsigned ?? [])])).not.toContain("AMCV_X%40AdobeOrg");
  });

  it("keeps every key written inside a container, counted or not, with the frames it came from", () => {
    const t = emptyTallies();
    for (const o of [...vendors(), ...writes()]) exchange(t, o);
    expect(freezeTallies(t).byContainer).toEqual({
      "gtag:G-XNWF200000": { manager: "gtag", id: "G-XNWF200000", frameUrls: [GTAG], cookieKeys: [K("_ga")], cookieKeysUnsigned: [], probeCookies: [], refusedWrites: [] },
      "gtm:GTM-XNWF100": { manager: "gtm", id: "GTM-XNWF100", frameUrls: [GTM_NFD], cookieKeys: [K("nwf_byline")], cookieKeysUnsigned: [K("nwf_section")], probeCookies: [], refusedWrites: [] },
      "tealium:automakere/tier1aue": { manager: "tealium", id: "automakere/tier1aue", frameUrls: [UTAG], cookieKeys: [K("AMCV_X%40AdobeOrg"), K("utag_main_ses_id")], cookieKeysUnsigned: [], probeCookies: [], refusedWrites: [] },
    });
  });

  it("marks the owner's code as run in the name's category, and adds no host of the container's", () => {
    const t = emptyTallies();
    for (const o of writes()) exchange(t, o);
    const google = freezeTallies(t).byEntityCategory?.[entityCategoryKey("Google", "analytics")];
    expect(google).toMatchObject({ scriptRan: true, scriptRanOutsideXhr: true, hosts: [], requests: 0 });
    expect(freezeTallies(t).byEntity["Google"]?.scriptRan).toBe(true);
  });

  it("gives every key a container holds a detail naming the container, past the cap on details", () => {
    // Details full to the cap, from another visit's counted keys.
    const t = emptyTallies();
    for (let i = 0; i < COOKIE_DETAIL_CAP; i++) {
      exchange(t, req({ url: "https://ads.doubleclick.net/x", secGpcPresent: false, setCookies: [cookie(`u${i}`, { domain: ".example.org" })] }));
    }
    const full = emptyTallies();
    for (const [k, d] of t.cookieDetails) full.cookieDetails.set(k, d);
    exchange(full, js("nwf_byline", GTM_NFD));
    exchange(full, js("_ga", GTAG));
    const d = freezeTallies(full).cookieDetails ?? {};
    expect(d[K("nwf_byline")]).toMatchObject({ host: "www.googletagmanager.com", via: "documentCookie", container: "gtm:GTM-XNWF100" });
    expect(d[K("_ga")]).toMatchObject({ container: "gtag:G-XNWF200000", firstSignedObservationId: expect.any(String) });
    expect(d["IDE\u0000.doubleclick.net"]).toBeUndefined();
  });

  it("survives a freeze and thaw, and a 1.24.0 tally thaws with no summaries", () => {
    const t = emptyTallies();
    for (const o of [...vendors(), ...writes()]) exchange(t, o);
    const frozen = freezeTallies(t);
    expect(freezeTallies(thawTallies(frozen))).toEqual(frozen);
    const { byContainer: _none, ...old } = frozen;
    const thawed = thawTallies(old as Tallies);
    expect(thawed.byContainer.size).toBe(0);
    exchange(thawed, js("nwf_byline", GTM_NFD));
    expect(Object.keys(freezeTallies(thawed).byContainer ?? {})).toEqual(["gtm:GTM-XNWF100"]);
  });

  it("takes a probe out of the container's summary, and knows which keys a container holds", () => {
    const t = emptyTallies();
    exchange(t, js("nwf_byline", GTM_NFD));
    exchange(t, js("_ga", GTAG));
    expect(isRecordedKey(t, K("nwf_byline"))).toBe(true);
    untallyCookie(t, K("nwf_byline"), "nwf_byline");
    noteForContainer(t, { manager: "gtm", id: "GTM-XNWF100" }, "probeCookies", "nwf_byline");
    untallyCookie(t, K("_ga"), "_ga");
    const f = freezeTallies(t);
    expect(f.byContainer?.["gtm:GTM-XNWF100"]).toMatchObject({ cookieKeys: [], probeCookies: ["nwf_byline"] });
    expect(f.byContainer?.["gtag:G-XNWF200000"]?.cookieKeys).toEqual([]);
    expect(f.adCookieKeys).toEqual([]);
    expect(isRecordedKey(t, K("nwf_byline"))).toBe(false);
  });

  it("keeps at most the cap of keys each way, and says when it left one out", () => {
    const t = emptyTallies();
    for (let i = 0; i <= CONTAINER_COOKIE_CAP; i++) exchange(t, js(`c${i}`, GTM_NFD));
    const c = freezeTallies(t).byContainer?.["gtm:GTM-XNWF100"];
    expect(c?.cookieKeys).toHaveLength(CONTAINER_COOKIE_CAP);
    expect(c?.capped).toBe(true);
    // The key left out is still recorded as any other cookie is, its detail under the details' own cap.
    expect(freezeTallies(t).cookieDetails?.[K(`c${CONTAINER_COOKIE_CAP}`)]).toBeDefined();
  });

  it("caps probes and refused writes per container, as per vendor", () => {
    const t = emptyTallies();
    for (let i = 0; i < 30; i++) noteForContainer(t, { manager: "gtm", id: "GTM-A" }, "refusedWrites", `x${i} (.com)`);
    expect(freezeTallies(t).byContainer?.["gtm:GTM-A"]?.refusedWrites).toHaveLength(20);
  });
});

describe("a third-party domain with no company (1.26.0)", () => {
  const CDN: TallyClassification = { party: "third", category: "unknown", entityName: null, domain: "retailer-d-static.example" };
  const URL_CDN = "https://assets.retailer-d-static.example/lib.js";
  const KEY_CDN = "rtd\u0000.retailer-d-static.example";
  const set = (over: Partial<CookieRecord> = {}): CookieRecord => cookie("rtd", { domain: ".retailer-d-static.example", ...over });
  const summary = (t: MutableTallies, domain = "retailer-d-static.example") => freezeTallies(t).byUnlistedDomain?.[domain];

  it("keeps its requests by registrable domain, signed apart", () => {
    const t = emptyTallies();
    tallyRequest(t, req({ id: "img", url: "https://images.retailer-d-static.example/a.png", secGpcPresent: false }), () => CDN);
    tallyRequest(t, req({ id: "lib", url: URL_CDN, resourceType: "script" }), () => CDN);
    expect(summary(t)).toEqual({
      domain: "retailer-d-static.example", requests: 2, signedRequests: 1,
      hosts: ["assets.retailer-d-static.example", "images.retailer-d-static.example"], resourceTypes: ["image", "script"],
      cookieKeys: [], cookieKeysUnsigned: [], cookiesReturned: [], probeCookies: [], refusedWrites: [],
      scriptRan: true, scriptRanOutsideXhr: true, firstObservationId: "img", executionObservationId: "lib",
    });
  });

  it("records whether its code ran, as a company's summary does", () => {
    const passive = emptyTallies();
    tallyRequest(passive, req({ id: "px", url: "https://images.retailer-d-static.example/a.png" }), () => CDN);
    expect(summary(passive)).toMatchObject({ scriptRan: false, scriptRanOutsideXhr: false, firstObservationId: "px", executionObservationId: null });

    const xhr = emptyTallies();
    tallyRequest(xhr, req({ id: "x", url: URL_CDN, resourceType: "xmlhttprequest" }), () => CDN);
    expect(summary(xhr)).toMatchObject({ scriptRan: true, scriptRanOutsideXhr: false, executionObservationId: "x" });

    // A cookie its script wrote, with no request of its own seen.
    const written = emptyTallies();
    const js = cookie("rtd_js", { domain: ".retailer-d.example", via: "documentCookie", writerScriptUrl: URL_CDN });
    tallyCookies(written, req({ id: "js-1", url: URL_CDN, method: "SCRIPT", setCookies: [js] }), () => CDN);
    expect(summary(written)).toMatchObject({ requests: 0, scriptRan: true, scriptRanOutsideXhr: true, firstObservationId: "js-1", executionObservationId: "js-1" });

    // A cookie set by its response is not its code running.
    const response = emptyTallies();
    tallyCookies(response, req({ id: "r", url: URL_CDN, setCookies: [set()] }), () => CDN);
    expect(summary(response)).toMatchObject({ scriptRan: false, executionObservationId: null });
  });

  it("notes a cookie it set going back to it, and no other name", () => {
    const t = emptyTallies();
    tallyCookies(t, req({ url: URL_CDN, setCookies: [set()] }), () => CDN);
    tallyRequest(t, req({ url: URL_CDN, cookiesSent: ["rtd", "unrelated"] }), () => CDN);
    expect(summary(t)?.cookiesReturned).toEqual(["rtd"]);
  });

  it("keeps the keys it set, signed apart from unsigned, each with a detail", () => {
    const t = emptyTallies();
    tallyCookies(t, req({ url: URL_CDN, setCookies: [set()] }), () => CDN);
    tallyCookies(t, req({ url: URL_CDN, secGpcPresent: false, setCookies: [set({ name: "off" })] }), () => CDN);
    expect(summary(t)?.cookieKeys).toEqual([KEY_CDN]);
    expect(summary(t)?.cookieKeysUnsigned).toEqual(["off\u0000.retailer-d-static.example"]);
    expect(t.cookieDetails.get(KEY_CDN)).toMatchObject({ host: "assets.retailer-d-static.example", firstSignedObservationId: null });
    expect(isRecordedKey(t, KEY_CDN)).toBe(true);
  });

  it("is keyed by the charged host, not by the cookie's own domain", () => {
    // A script from the domain writing on the site's: kndctr_* on .pharmacy-a.example.
    const t = emptyTallies();
    const written = cookie("kndctr", { domain: ".pharmacy-a.example", via: "documentCookie", writerScriptUrl: URL_CDN });
    tallyCookies(t, req({ url: URL_CDN, method: "SCRIPT", setCookies: [written] }), () => CDN);
    expect(summary(t)?.cookieKeys).toEqual(["kndctr\u0000.pharmacy-a.example"]);
    expect(summary(t)?.hosts).toEqual(["assets.retailer-d-static.example"]);
    expect(freezeTallies(t).firstParty?.cookieKeys).toEqual([]);
  });

  it("stands the hostname in where the classification carries no domain", () => {
    const t = emptyTallies();
    tallyCookies(t, req({ url: "https://nobody.example/x", setCookies: [set()] }), () => UNKNOWN);
    expect(summary(t, "nobody.example")?.cookieKeys).toEqual([KEY_CDN]);
  });

  it("never moves a count, an entity or a company's summary", () => {
    const counted = (): MutableTallies => {
      const t = emptyTallies();
      tallyRequest(t, req({ id: "ad" }), () => AD);
      tallyCookies(t, req({ id: "ad", setCookies: [cookie("IDE")] }), () => AD);
      return t;
    };
    const a = counted();
    const b = counted();
    tallyRequest(b, req({ url: URL_CDN }), () => CDN);
    tallyCookies(b, req({ url: URL_CDN, setCookies: [set()] }), () => CDN);
    const fa = freezeTallies(a);
    const fb = freezeTallies(b);
    expect(fb.adCookieKeys).toEqual(fa.adCookieKeys);
    expect(fb.adCookieKeysUnsigned).toEqual(fa.adCookieKeysUnsigned);
    expect(fb.adCookieEvents).toBe(fa.adCookieEvents);
    expect(fb.adVendorRequests).toBe(fa.adVendorRequests);
    expect(fb.firstPartyVendorCookieKeys).toEqual(fa.firstPartyVendorCookieKeys);
    expect(fb.byEntity).toEqual(fa.byEntity);
    expect(fb.byEntityCategory).toEqual(fa.byEntityCategory);
  });

  it("has none for a counted domain, a company's, or the site's own", () => {
    const t = emptyTallies();
    const NO_COMPANY_AD: TallyClassification = { party: "third", category: "advertising", entityName: null, domain: "tracker.example" };
    for (const cls of [AD, FINGERPRINTING, FIRST, NO_COMPANY_AD]) {
      tallyRequest(t, req(), () => cls);
      tallyCookies(t, req({ setCookies: [cookie("c")] }), () => cls);
    }
    expect(freezeTallies(t).byUnlistedDomain).toEqual({});
  });

  it("caps the keys each way, and says so", () => {
    const t = emptyTallies();
    for (let i = 0; i < UNLISTED_COOKIE_CAP; i++) tallyCookies(t, req({ url: URL_CDN, setCookies: [set({ name: `c${i}` })] }), () => CDN);
    expect(summary(t)?.capped).toBeUndefined();
    tallyCookies(t, req({ url: URL_CDN, setCookies: [set({ name: "over" })] }), () => CDN);
    expect(summary(t)?.cookieKeys).toHaveLength(UNLISTED_COOKIE_CAP);
    expect(summary(t)?.capped).toBe(true);
    expect(isRecordedKey(t, "over\u0000.retailer-d-static.example")).toBe(false);
    // The other way has its own room.
    tallyCookies(t, req({ url: URL_CDN, secGpcPresent: false, setCookies: [set({ name: "over" })] }), () => CDN);
    expect(summary(t)?.cookieKeysUnsigned).toEqual(["over\u0000.retailer-d-static.example"]);
  });

  it("caps the hostnames", () => {
    const t = emptyTallies();
    for (let i = 0; i < UNLISTED_HOST_CAP + 5; i++) tallyRequest(t, req({ url: `https://h${i}.retailer-d-static.example/` }), () => CDN);
    expect(summary(t)?.hosts).toHaveLength(UNLISTED_HOST_CAP);
    expect(summary(t)?.requests).toBe(UNLISTED_HOST_CAP + 5);
  });

  it("caps the domains that only made requests, and admits one that sets a cookie", () => {
    const t = emptyTallies();
    const at = (i: number): TallyClassification => ({ ...CDN, domain: `d${i}.example` });
    for (let i = 0; i < UNLISTED_DOMAIN_CAP; i++) tallyRequest(t, req({ url: `https://d${i}.example/` }), () => at(i));
    expect(freezeTallies(t).unlistedDomainsCapped).toBeUndefined();
    tallyRequest(t, req({ url: "https://late.example/" }), () => ({ ...CDN, domain: "late.example" }));
    expect(t.byUnlistedDomain.size).toBe(UNLISTED_DOMAIN_CAP);
    expect(freezeTallies(t).unlistedDomainsCapped).toBe(true);
    tallyCookies(t, req({ url: "https://late.example/", setCookies: [set()] }), () => ({ ...CDN, domain: "late.example" }));
    expect(summary(t, "late.example")?.cookieKeys).toEqual([KEY_CDN]);
    // Its request came before it was admitted, and was not kept: the summary says so.
    expect(summary(t, "late.example")).toMatchObject({ requests: 0, requestsCapped: true });
    expect(summary(t, "d0.example")?.requestsCapped).toBeUndefined();
  });

  it("lets a probe leave, and keeps its name", () => {
    const t = emptyTallies();
    tallyCookies(t, req({ url: URL_CDN, setCookies: [set()] }), () => CDN);
    untallyCookie(t, KEY_CDN, "rtd");
    noteForUnlisted(t, hostCharge(CDN), "probeCookies", "rtd");
    noteForUnlisted(t, hostCharge(CDN), "refusedWrites", "wide (.com)");
    expect(summary(t)).toMatchObject({ cookieKeys: [], probeCookies: ["rtd"], refusedWrites: ["wide (.com)"] });
    expect(t.cookieDetails.has(KEY_CDN)).toBe(false);
  });

  it("takes a refused write as its code running, and a probe as nothing of the kind", () => {
    const t = emptyTallies();
    noteForUnlisted(t, hostCharge(CDN), "probeCookies", "rtd");
    expect(summary(t)).toMatchObject({ scriptRan: false, scriptRanOutsideXhr: false });
    noteForUnlisted(t, hostCharge(CDN), "refusedWrites", "wide (.com)");
    expect(summary(t)).toMatchObject({ requests: 0, scriptRan: true, scriptRanOutsideXhr: true });
  });

  it("notes nothing for a charge that is not an unlisted domain's", () => {
    const t = emptyTallies();
    noteForUnlisted(t, hostCharge(AD), "probeCookies", "IDE");
    noteForUnlisted(t, hostCharge(FIRST), "probeCookies", "sid");
    expect(t.byUnlistedDomain.size).toBe(0);
  });

  it("survives storage, and a tally stored before it thaws with none", () => {
    const t = emptyTallies();
    tallyRequest(t, req({ url: URL_CDN }), () => CDN);
    tallyCookies(t, req({ url: URL_CDN, setCookies: [set()] }), () => CDN);
    const frozen = freezeTallies(t);
    expect(freezeTallies(thawTallies(JSON.parse(JSON.stringify(frozen)) as Tallies))).toEqual(frozen);

    const { byUnlistedDomain: _u, firstParty: _f, ...old } = frozen;
    const thawed = thawTallies(old as Tallies);
    expect(thawed.byUnlistedDomain.size).toBe(0);

    // One stored by a build of 1.26.0 from before the summary kept whether the code ran.
    const { scriptRan: _r, scriptRanOutsideXhr: _x, firstObservationId: _a, executionObservationId: _e, ...early } = frozen.byUnlistedDomain!["retailer-d-static.example"]!;
    const again = thawTallies({ ...frozen, byUnlistedDomain: { "retailer-d-static.example": early as never } });
    expect(freezeTallies(again).byUnlistedDomain?.["retailer-d-static.example"]).toMatchObject({ scriptRan: false, firstObservationId: null });
    expect(freezeTallies(thawed).firstParty).toEqual({ cookieKeys: [], cookieKeysUnsigned: [], vendorCookieKeysUnsigned: [] });
  });
});

describe("the first party's cookies (1.26.0)", () => {
  const SITE = "https://www.example.com/";
  /** A host under the site's own domain that the list files as analytics. */
  const OWN_ANALYTICS: TallyClassification = { party: "first", category: "analytics", entityName: "Example Metrics" };
  const OWN_SCRIPT = "https://metrics.example.com/m.js";
  const classify = (url: string): TallyClassification => (url === OWN_SCRIPT ? OWN_ANALYTICS : FIRST);
  const own = (name: string, over: Partial<CookieRecord> = {}): CookieRecord => cookie(name, { domain: ".example.com", ...over });
  const first = (t: MutableTallies) => freezeTallies(t).firstParty;

  it("keeps what the site set, signed apart from unsigned", () => {
    const t = emptyTallies();
    tallyCookies(t, req({ url: SITE, setCookies: [own("session")] }), classify);
    tallyCookies(t, req({ url: SITE, secGpcPresent: false, setCookies: [own("prefs")] }), classify);
    expect(first(t)).toEqual({
      cookieKeys: ["session\u0000.example.com"],
      cookieKeysUnsigned: ["prefs\u0000.example.com"],
      vendorCookieKeysUnsigned: [],
    });
    expect(t.adCookieKeys.size + t.adCookieKeysUnsigned.size + t.firstPartyVendorCookieKeys.size).toBe(0);
  });

  it("leaves a vendor script's signed write where it was, and keeps its unsigned one", () => {
    const t = emptyTallies();
    const written = (name: string): CookieRecord => own(name, { via: "documentCookie", writerScriptUrl: OWN_SCRIPT });
    tallyCookies(t, req({ url: OWN_SCRIPT, method: "SCRIPT", setCookies: [written("_m")] }), classify);
    tallyCookies(t, req({ url: OWN_SCRIPT, method: "SCRIPT", secGpcPresent: false, setCookies: [written("_off")] }), classify);
    expect([...t.firstPartyVendorCookieKeys]).toEqual(["_m\u0000.example.com"]);
    expect(first(t)).toEqual({ cookieKeys: [], cookieKeysUnsigned: [], vendorCookieKeysUnsigned: ["_off\u0000.example.com"] });
  });

  it("has nothing of a third party's, listed or not", () => {
    const t = emptyTallies();
    for (const cls of [AD, FINGERPRINTING, UNKNOWN]) tallyCookies(t, req({ setCookies: [cookie("c")] }), () => cls);
    expect(first(t)).toEqual({ cookieKeys: [], cookieKeysUnsigned: [], vendorCookieKeysUnsigned: [] });
  });

  it("caps each list, says which visit's was full, and keeps no detail", () => {
    const t = emptyTallies();
    for (let i = 0; i < FIRST_PARTY_COOKIE_CAP; i++) tallyCookies(t, req({ url: SITE, secGpcPresent: false, setCookies: [own(`c${i}`)] }), classify);
    expect(first(t)?.cappedUnsigned).toBeUndefined();
    tallyCookies(t, req({ url: SITE, secGpcPresent: false, setCookies: [own("over")] }), classify);
    expect(first(t)?.cookieKeysUnsigned).toHaveLength(FIRST_PARTY_COOKIE_CAP);
    // The unsigned list was full: the signed one, what the visit with the signal on shows, was not.
    expect(first(t)).toMatchObject({ cappedUnsigned: true });
    expect(first(t)?.capped).toBeUndefined();
    for (let i = 0; i <= FIRST_PARTY_COOKIE_CAP; i++) tallyCookies(t, req({ url: SITE, setCookies: [own(`s${i}`)] }), classify);
    expect(first(t)?.capped).toBe(true);
    expect(t.cookieDetails.size).toBe(0);
  });

  it("lets a probe leave, and keeps its name", () => {
    const t = emptyTallies();
    tallyCookies(t, req({ url: SITE, setCookies: [own("test")] }), classify);
    expect(isRecordedKey(t, "test\u0000.example.com")).toBe(true);
    expect(isFirstPartyKey(t, "test\u0000.example.com")).toBe(true);
    untallyCookie(t, "test\u0000.example.com", "test");
    noteFirstPartyProbe(t, "test");
    expect(first(t)).toMatchObject({ cookieKeys: [], probeCookies: ["test"] });
    expect(isRecordedKey(t, "test\u0000.example.com")).toBe(false);
    const frozen = freezeTallies(t);
    expect(freezeTallies(thawTallies(JSON.parse(JSON.stringify(frozen)) as Tallies)).firstParty).toEqual(frozen.firstParty);
  });
});

describe("a response whose request was lost (1.26.0)", () => {
  const CDN: TallyClassification = { party: "third", category: "unknown", entityName: null, domain: "example-cdn.net" };
  const lost = (over: Partial<NetworkObservation> = {}): NetworkObservation =>
    req({ secGpcPresent: false, cookiesSent: [], requestLost: true, ...over });
  const K = (name: string, domain = ".doubleclick.net") => `${name}\u0000${domain}`;

  it("keeps each cookie in the summary of whoever set it, and counts nothing", () => {
    const t = emptyTallies();
    tallyCookies(t, lost({ setCookies: [cookie("IDE")] }), () => AD);
    tallyCookies(t, lost({ url: "https://static.example-cdn.net/x", setCookies: [cookie("edge", { domain: ".example-cdn.net" })] }), () => CDN);
    tallyCookies(t, lost({ url: "https://www.example.com/", setCookies: [cookie("session", { domain: ".example.com" })] }), () => FIRST);
    const f = freezeTallies(t);
    expect(f.byEntityCategory?.[entityCategoryKey("Google", "advertising")]?.cookieKeysRequestLost).toEqual([K("IDE")]);
    expect(f.byUnlistedDomain?.["example-cdn.net"]?.cookieKeysRequestLost).toEqual([K("edge", ".example-cdn.net")]);
    expect(f.firstParty?.cookieKeysRequestLost).toEqual([K("session", ".example.com")]);
    expect(f.adCookieKeys).toEqual([]);
    expect(f.adCookieKeysUnsigned).toEqual([]);
    expect(f.adCookieEvents + (f.adCookieEventsUnsigned ?? 0)).toBe(0);
    expect(f.byEntity).toEqual({});
    expect(f.firstParty?.cookieKeys).toEqual([]);
    expect(f.byUnlistedDomain?.["example-cdn.net"]?.cookieKeys).toEqual([]);
    // A detail says the request was lost; the first party's keys take none.
    expect(f.cookieDetails?.[K("IDE")]).toMatchObject({ requestLost: true, firstSignedObservationId: null });
    expect(f.cookieDetails?.[K("session", ".example.com")]).toBeUndefined();
    expect(isRecordedKey(t, K("IDE"))).toBe(true);
    // A first-party key is the first party's, so a probe of it is noted there.
    expect(isFirstPartyKey(t, K("session", ".example.com"))).toBe(true);
  });

  it("marks a cookie known only from a lost request as sent back, when a later request carries it", () => {
    const t = emptyTallies();
    tallyCookies(t, lost({ setCookies: [cookie("IDE")] }), () => AD);
    tallyCookies(t, lost({ url: "https://static.example-cdn.net/x", setCookies: [cookie("edge", { domain: ".example-cdn.net" })] }), () => CDN);
    tallyRequest(t, req({ cookiesSent: ["IDE"] }), () => AD);
    tallyRequest(t, req({ url: "https://static.example-cdn.net/y", cookiesSent: ["edge"] }), () => CDN);
    const f = freezeTallies(t);
    expect(f.byEntityCategory?.[entityCategoryKey("Google", "advertising")]?.cookiesReturned).toEqual(["IDE"]);
    expect(f.byUnlistedDomain?.["example-cdn.net"]?.cookiesReturned).toEqual(["edge"]);
  });

  it("is cleared from the detail by a set on an observed request, and leaves with a probe", () => {
    const t = emptyTallies();
    tallyCookies(t, lost({ setCookies: [cookie("IDE")] }), () => AD);
    tallyCookies(t, req({ setCookies: [cookie("IDE")] }), () => AD);
    expect(t.cookieDetails.get(K("IDE"))?.requestLost).toBeUndefined();
    expect([...t.adCookieKeys]).toEqual([K("IDE")]);
    untallyCookie(t, K("IDE"), "IDE");
    expect(freezeTallies(t).byEntityCategory?.[entityCategoryKey("Google", "advertising")]?.cookieKeysRequestLost).toBeUndefined();
  });

  it("caps each summary's list, and survives storage", () => {
    const t = emptyTallies();
    for (let i = 0; i <= REQUEST_LOST_COOKIE_CAP; i++) tallyCookies(t, lost({ setCookies: [cookie(`c${i}`)] }), () => AD);
    const frozen = freezeTallies(t);
    expect(frozen.byEntityCategory?.[entityCategoryKey("Google", "advertising")]?.cookieKeysRequestLost).toHaveLength(REQUEST_LOST_COOKIE_CAP);
    // The list says it is incomplete, as every capped list does.
    expect(frozen.byEntityCategory?.[entityCategoryKey("Google", "advertising")]?.requestLostCapped).toBe(true);
    expect(freezeTallies(thawTallies(JSON.parse(JSON.stringify(frozen)) as Tallies))).toEqual(frozen);
  });
});
