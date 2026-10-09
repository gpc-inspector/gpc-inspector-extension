// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { SCHEMA_VERSION, entityCategoryKey } from "@gpc-inspector/schema";
import {
  COUNTING_CATEGORIES,
  evaluate,
  withPersistedShape,
  countDistinctCookiesSetWithSignal,
  countDistinctCookiesSetWithoutSignal,
  countAdTechRequests,
  countFirstPartyVendorCookies,
  countCookiesSetWithSignal,
  NO_OWNERS,
} from "@gpc-inspector/engine";
import type { ObservationSet } from "@gpc-inspector/schema";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPopupView, nativeFirstRunKey, nativeSendSetting } from "../src/ui/view-model.js";
import { classifiedInput } from "../src/ui/view-input.js";
import { requestCount } from "../src/ui/requests-view.js";
import { FIXTURES, TAB_ADDRESSES } from "../harness/fixtures.mjs";
import { SHOTS } from "../harness/store-shots.mjs";
import { FICTIONAL_VENDORS } from "../harness/fictional-vendors.mjs";
// The harness's classifier: the real list, plus the store screenshots' fictional vendors,
// all on the reserved .example TLD (harness/fictional-vendors.mjs). Every real domain
// classifies as the extension classifies it, so "the real list" below still holds for them.
import { getClassifier, getFunctionalCookies, getOwnerNames } from "../harness/classifier.mjs";
import { getClassifier as realClassifier } from "../src/background/classifier.js";

/**
 * The harness renders every popup surface from these fixtures, and nothing else checks
 * them. A fixture that falls behind the capture, with keys in an old shape and no vendor
 * recorded, shows a count over fewer names or a vendor with no category, neither of which a
 * real capture produces. This holds them to what the capture writes.
 */
describe("harness fixtures", () => {
  const withData = Object.entries(FIXTURES).flatMap(([name, make]) => {
    const obs = make();
    return obs === null ? [] : [[name, obs] as const];
  });

  it.each(withData)("%s: is at the current schema version", (_name, obs) => {
    expect(obs.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it.each(withData)("%s: every tallied vendor is one the real list would tally, under that name", (_name, obs) => {
    // The popup labels and orders a vendor row by classifying its hosts with the real list.
    // A fixture vendor with no host the list files as advertising or analytics under that
    // name renders with no label, and the capture would never have tallied it. Meta's pixel
    // hosts are not an analytics vendor: Disconnect files them as Social.
    const classifier = getClassifier();
    for (const [name, entity] of Object.entries(obs.tallies.byEntity)) {
      const counted = entity.hosts.filter((host) => {
        const c = classifier.classify(`https://${host}/`, obs.context.topSite);
        return c.party === "third" && (c.category === "advertising" || c.category === "analytics") && c.entity?.name === name;
      });
      expect(counted, `${name}: a host the list files as advertising or analytics under that name`).not.toHaveLength(0);
    }
  });

  it.each(withData)("%s: names every counted cookie under a vendor, and records who set it", (_name, obs) => {
    const t = obs.tallies;
    const keys = [...t.adCookieKeys, ...(t.adCookieKeysUnsigned ?? [])];
    for (const key of keys) {
      expect(key, "a key is name and domain joined by NUL").toMatch(/^[^\u0000]+\u0000[^\u0000]+$/);
      expect(t.adCookieCategories?.[key], `${key} has a category`).toBeDefined();
    }
    const signalOn = obs.signal.source !== "none";
    const counted = signalOn ? t.adCookieKeys.length : (t.adCookieKeysUnsigned ?? []).length;
    const v = buildPopupView({
      observations: obs,
      findings: [],
      distinctCookies: t.adCookieKeys.length,
      distinctCookiesUnsigned: (t.adCookieKeysUnsigned ?? []).length,
      adTechRequests: t.adVendorRequests,
    });
    const named = v.countNames.reduce((n, x) => n + x.cookies.length, 0);
    expect(named, "the names under the headline add up to the count").toBe(counted);
    // The rows the headline counts. A row in another category lists its cookies and is
    // never under the number.
    const setters = v.vendors.filter((r) => r.counted && r.cookies.length > 0);
    expect(v.countNames.map((x) => [x.name, x.category]), "the names are the counted rows that set a cookie, in order").toEqual(setters.map((r) => [r.name, r.category]));
    // A setter is a tallied vendor, or a domain the list names no company for, which the
    // row says of itself.
    for (const row of setters) {
      if (t.byEntity[row.name]) expect(row.detail).not.toHaveProperty("unlistedDomain");
      else expect(row.detail.unlistedDomain, `${row.name} is a tallied vendor or says it is an unlisted domain`).toBe(true);
    }
    // And every key without a recorded vendor is such a row, named after its domain.
    for (const key of keys) {
      if (t.adCookieEntities?.[key] !== undefined) continue;
      const domain = key.split("\u0000")[1]!.replace(/^\./, "");
      expect(v.vendors.find((r) => r.name === domain)?.detail.unlistedDomain, `${key} is listed under ${domain}`).toBe(true);
    }
  });

  const summarized = withData.filter(([, obs]) => obs.tallies.byEntityCategory !== undefined);

  it("has fixtures with the summaries and one without, so both are drawn", () => {
    const vendors = (obs: (typeof withData)[number][1]): boolean => Object.keys(obs.tallies.byEntity).length > 0;
    expect(summarized.some(([, obs]) => vendors(obs))).toBe(true);
    expect(withData.some(([, obs]) => vendors(obs) && obs.tallies.byEntityCategory === undefined)).toBe(true);
  });

  it.each(summarized)("%s: every summary is one the real list gives that company and category", (_name, obs) => {
    // A row is drawn for each, under the company's name in the category's group. A summary
    // the list would not write is a row no capture has.
    const classifier = getClassifier();
    for (const [key, p] of Object.entries(obs.tallies.byEntityCategory ?? {})) {
      expect(key).toBe(entityCategoryKey(p.entity, p.category));
      expect(p.hosts, `${p.entity} / ${p.category}: a hostname`).not.toHaveLength(0);
      for (const host of p.hosts) {
        const c = classifier.classify(`https://${host}/`, obs.context.topSite);
        expect([c.party, c.entity?.name, c.category], host).toEqual(["third", p.entity, p.category]);
      }
    }
  });

  it.each(summarized)("%s: the summaries count what the tallies count, and hold no counted cookie", (_name, obs) => {
    const t = obs.tallies;
    const pairs = Object.values(t.byEntityCategory ?? {});
    for (const [name, entity] of Object.entries(t.byEntity)) {
      const mine = pairs.filter((p) => p.entity === name && COUNTING_CATEGORIES.has(p.category));
      expect(mine.reduce((n, p) => n + p.requests, 0), `${name}: requests`).toBe(entity.requests);
      expect(mine.reduce((n, p) => n + p.signedRequests, 0), `${name}: signed requests`).toBe(entity.signedRequests);
    }
    for (const p of pairs.filter((x) => COUNTING_CATEGORIES.has(x.category))) {
      expect([...p.cookieKeys, ...p.cookieKeysUnsigned], `${p.entity} / ${p.category}`).toEqual([]);
    }
    for (const key of [...t.adCookieKeys, ...(t.adCookieKeysUnsigned ?? [])]) {
      const entity = t.adCookieEntities?.[key];
      if (entity === undefined) continue;
      expect(t.byEntityCategory?.[entityCategoryKey(entity, t.adCookieCategories![key]!)], `${key}: its vendor's summary`).toBeDefined();
    }
  });

  const unlisted = withData.filter(([, obs]) => obs.tallies.byUnlistedDomain !== undefined);

  it("has a fixture with domains the list names no company for, its reclaimed variant, and the side panel's store shot", () => {
    expect(unlisted.map(([name]) => name).sort()).toEqual(["store-side-panel", "unlisted-domains", "unlisted-domains-reclaimed"]);
  });

  it.each(unlisted)("%s: every unlisted domain is one the real list names no company for, and none is counted", (_name, obs) => {
    const classifier = getClassifier();
    const t = obs.tallies;
    const counted = new Set([...t.adCookieKeys, ...(t.adCookieKeysUnsigned ?? [])]);
    for (const [key, u] of Object.entries(t.byUnlistedDomain ?? {})) {
      expect(key).toBe(u.domain);
      for (const host of u.hosts) {
        const c = classifier.classify(`https://${host}/`, obs.context.topSite);
        expect([c.party, c.entity, COUNTING_CATEGORIES.has(c.category), c.registrableDomain], host).toEqual(["third", null, false, u.domain]);
      }
      for (const k of [...u.cookieKeys, ...u.cookieKeysUnsigned]) expect(counted.has(k), `${k} is not in adCookieKeys`).toBe(false);
    }
  });

  // The side panel's store shot has its own rows, held under "store screenshots" below.
  const unlistedKinds = unlisted.filter(([name]) => name.startsWith("unlisted-domains"));
  it.each(unlistedKinds)("%s: draws the group last, a row per domain with a cookie, a probe, a refused write or a read of GPC", (_name, obs) => {
    const classifier = getClassifier();
    const owners = getOwnerNames();
    const v = buildPopupView({
      observations: obs,
      findings: evaluate(obs, classifier, owners),
      distinctCookies: countDistinctCookiesSetWithSignal(obs, classifier, owners),
      adTechRequests: countAdTechRequests(obs, classifier),
      classify: (url: string) => {
        const c = classifier.classify(url, obs.context.topSite);
        return { party: c.party, category: c.category, entity: c.entity?.name ?? null, domain: c.registrableDomain };
      },
    });
    expect(v.vendors.map((r) => [r.name, r.group ?? r.category, r.checkKey, r.emptyKey ?? null])).toEqual([
      ["Criteo", "advertising", "vendorGpcNotRead", null],
      ["Yahoo!", "unknown", "vendorGpcNotApplicable", null],
      ["example-homestatic.com", "unlisted", "vendorGpcReadProperty", null],
      ["example-insights.io", "unlisted", "vendorGpcNotRead", null],
      ["example-chat.com", "unlisted", "vendorGpcNotRead", "vendorCookiesSetAndRemoved"],
      // Its only cookie set without the signal, while it was on: a row of its own.
      ["example-cohesion.com", "unlisted", "vendorGpcNotRead", "vendorCookiesWithoutGpc"],
      ["example-lost.net", "unlisted", "vendorGpcNotRead", "vendorCookiesRequestLost"],
      // Its script read GPC and it set nothing: a row of its own, not only a name under
      // "Also scripts from".
      ["example-quiet.net", "unlisted", "vendorGpcReadProperty", null],
      ["example-survey.net", "unlisted", "vendorGpcNotRead", null],
    ]);
    expect(v.vendors.find((r) => r.name === "example-lost.net")?.detail.cookies).toMatchObject([{ name: "lost_uid", requestLost: true }]);
    const insights = v.vendors.find((r) => r.name === "example-insights.io")!;
    expect(insights.detail.cookies.filter((c) => c.unsigned).map((c) => c.name)).toEqual(["edge_route"]);
    expect(insights.detail.cookiesCapped).toBe(true);
    expect(v.vendors.find((r) => r.name === "Criteo")!.detail.cookies.filter((c) => c.unsigned).map((c) => c.name)).toEqual(["cto_late"]);
  });

  const firstPartyOf = (obs: ObservationSet) => {
    const classifier = getClassifier();
    return buildPopupView({
      observations: obs, findings: [], distinctCookies: obs.tallies.adCookieKeys.length, adTechRequests: obs.tallies.adVendorRequests,
      classify: (url: string) => {
        const c = classifier.classify(url, obs.context.topSite);
        return { party: c.party, category: c.category, entity: c.entity?.name ?? null, domain: c.registrableDomain };
      },
    }).firstParty;
  };

  // The summaries may hold one key twice (the first-party fixture's `_ga` is also set by the
  // site's response), and the view lists it once. A key counted under a third party is
  // listed only there: see view-model.test.ts, since no fixture counts a key on the site's
  // own domain.
  it.each(withData.filter(([, obs]) => obs.tallies.firstParty !== undefined))("%s: lists each first-party name once", (_name, obs) => {
    const fp = firstPartyOf(obs)!;
    const names = [...fp.vendorWritten, ...fp.site];
    expect(names).toEqual([...new Set(names)]);
  });

  it("draws the first-party section with both lists and capped, and with one list empty", () => {
    const view = (name: string) => firstPartyOf(withData.find(([n]) => n === name)![1]);
    expect(view("first-party")).toEqual({
      domain: "example-news.com",
      vendorWritten: ["RT", "_ga"],
      site: ["__cf_bm", "ab_bucket", "consent_state", "edition (.example-news.com)", "edition (www.example-news.com)", "session_id", "site_author", "site_section", "subscriber_state"],
      unsigned: [],
      requestLost: [],
      scriptWritesObserved: true,
      probeCookies: ["cookie_test"],
      vendorCapped: false,
      siteCapped: true,
    });
    expect(view("unlisted-domains")).toMatchObject({ domain: "example-home.com", vendorWritten: [], vendorCapped: false, siteCapped: false });
    expect(view("heavy")).toBeUndefined();
  });

  // What each fixture's headline counts, and who the caption says set it. Rows in other
  // categories, company and category as the unit, and the caption's forms move no number here.
  const HEADLINES: Record<string, [count: number | null, caption: string, substitution?: string[]]> = {
    heavy: [10, "countCookiesByBoth", ["5", "2"]],
    // The Tag containers rows (1.25.0): the owners' names written inside containers are
    // counted, Adobe's names inside Tealium are not.
    containers: [6, "countCookiesByBoth", ["3", "2"]],
    "containers-reclaimed": [6, "countCookiesByBoth", ["3", "2"]],
    sevenTags: [4, "countCookiesByBothOneAnalytics", ["1"]],
    // The group of domains the list names no company for (1.26.0): nothing in the group is
    // counted, so only Criteo's two signed keys are.
    "unlisted-domains": [2, "countCookiesByOneAdvertising"],
    "unlisted-domains-reclaimed": [2, "countCookiesByOneAdvertising"],
    // The heavy page with the first-party summary (1.26.0): the section moves no count.
    "first-party": [10, "countCookiesByBoth", ["5", "2"]],
    // The list of functional cookie names: two of its four are listed.
    functional: [4, "countCookiesByBothOneAnalytics", ["2"]],
    "signal-off": [10, "countCookiesOffByBoth", ["5", "2"]],
    mismatch: [2, "countCookiesByAdvertising", ["2"]],
    // Five counted cookies, one of them tracker.example's, a domain the list names no
    // company for: it stays in the count and is not one of the vendors.
    direct: [5, "countCookiesByBothOneAnalytics", ["3"]],
    "shown-and-set": [5, "countCookiesByBothOneAnalytics", ["3"]],
    "quiet-container": [1, "countCookiesOneByAdvertising"],
    "consent-store": [1, "countCookiesOneByAdvertising"],
    "two-containers": [1, "countCookiesOneByAdvertising"],
    zone: [1, "countCookiesOneByAdvertising"],
    honored: [0, "countCookiesZero"],
    unavailable: [2, "countCookiesByAdvertising", ["2"]],
    clean: [null, "stateNoAdTech"],
    // The clean page with privacy strings only requests carried (1.29.0).
    "requests-disagree": [null, "stateNoAdTech"],
    // The heavy page, incomplete for one reason each (1.22.0): the headline does not move,
    // a reclaim included, since it is counted from the tallies.
    reclaimed: [10, "countCookiesByBoth", ["5", "2"]],
    // With the requests that set a cookie kept (1.27.0): rows on the Requests tab only.
    "reclaimed-kept": [10, "countCookiesByBoth", ["5", "2"]],
    "reclaimed-some-kept": [10, "countCookiesByBoth", ["5", "2"]],
    "save-failed": [10, "countCookiesByBoth", ["5", "2"]],
    "prerender-lost": [10, "countCookiesByBoth", ["5", "2"]],
    "delivery-gap": [10, "countCookiesByBoth", ["5", "2"]],
    "consent-capped": [10, "countCookiesByBoth", ["5", "2"]],
    // The store screenshots, and the browser that sends the signal itself, on a quiet page.
    "store-honored": [0, "countCookiesZero"],
    "store-brave": [null, "stateNoAdTech"],
    "store-brave-off": [null, "stateNoAdTech"],
    "store-notice-cookies": [10, "countCookiesByBoth", ["4", "3"]],
    "store-read-gpc": [7, "countCookiesByBothOneAnalytics", ["5"]],
    "store-privacy-strings": [4, "countCookiesByBothOneAnalytics", ["3"]],
    "store-side-panel": [12, "countCookiesByBoth", ["8", "2"]],
  };

  // The reclaim rule (1.22.0): a worker reclaim empties the request list and nothing else,
  // so every finding and the whole Overview must be the same without it. Over every fixture
  // a current capture could produce, with the fields it records (withPersistedShape).
  const current = withData.filter(([, obs]) => obs.tallies.byEntityCategory !== undefined);
  it.each(current)("%s: a worker reclaim changes no finding and nothing on the Overview", (_name, raw) => {
    const classifier = getClassifier();
    const owners = getOwnerNames();
    const view = (o: ObservationSet) => {
      const findings = evaluate(o, classifier, owners);
      return {
        findings,
        view: buildPopupView({
          observations: o,
          findings,
          distinctCookies: countDistinctCookiesSetWithSignal(o, classifier, owners),
          distinctCookiesUnsigned: countDistinctCookiesSetWithoutSignal(o, classifier, owners),
          adTechRequests: countAdTechRequests(o, classifier),
          firstPartyVendorCookies: countFirstPartyVendorCookies(o, classifier, owners),
          owners,
          classify: (url: string) => {
            const c = classifier.classify(url, o.context.topSite);
            return { party: c.party, category: c.category, entity: c.entity?.name ?? null, domain: c.registrableDomain };
          },
          isListedFunctional: (name: string) => getFunctionalCookies().lists(name),
          sendingSignal: true,
          signalKnown: true,
        }),
      };
    };
    const shaped = withPersistedShape(raw);
    expect(view({ ...shaped, network: [] })).toEqual(view(shaped));
  });

  // The counting rule (1.25.0) moves only a key written inside a container, and each one
  // it moves is named here by fixture. Every other finding and every count is the same with
  // the owner's list and without it.
  const MOVED: Record<string, readonly string[]> = {
    // Written inside Tealium's container and Google's tags, and each the owner's own name.
    containers: ["_ga", "_ga_EX4MPL3R5", "_gcl_au", "utag_main_ses_id"],
    "containers-reclaimed": ["_ga", "_ga_EX4MPL3R5", "_gcl_au", "utag_main_ses_id"],
    sevenTags: ["_ga", "_ga_XRTM1000", "_ga_XRTM4000", "_gcl_au"],
  };
  it.each(withData)("%s: the owner's list moves no finding or count but the keys named for it", (name, obs) => {
    const classifier = getClassifier();
    const owners = getOwnerNames();
    const named = (f: ReturnType<typeof evaluate>[number]) => (f.artifact.kind === "cookie" ? f.artifact.cookieName : null);
    const moved = new Set(MOVED[name] ?? []);
    const withList = evaluate(obs, classifier, owners);
    const without = evaluate(obs, classifier, NO_OWNERS);
    const changed = [...withList.filter((f) => !without.some((g) => JSON.stringify(g) === JSON.stringify(f))), ...without.filter((f) => !withList.some((g) => JSON.stringify(g) === JSON.stringify(f)))];
    expect(changed.map(named).filter((n) => n === null || !moved.has(n))).toEqual([]);
    for (const count of [countDistinctCookiesSetWithSignal, countDistinctCookiesSetWithoutSignal, countCookiesSetWithSignal, countFirstPartyVendorCookies]) {
      expect(count(obs, classifier, owners)).toBe(count(obs, classifier, NO_OWNERS));
    }
  });

  it.each(withData)("%s: draws Google Consent Mode in Privacy strings, and nothing under the vendor list", (_name, obs) => {
    const v = buildPopupView({ observations: obs, findings: [], distinctCookies: obs.tallies.adCookieKeys.length, adTechRequests: obs.tallies.adVendorRequests });
    if (v.privacyStrings.length > 0) expect(v.privacyStrings.map((r) => r.id)).toEqual(["gpp", "usp", "tcf", "gcm"]);
    expect(v.notices.every((n) => n.placement === "top")).toBe(true);
    expect(JSON.stringify(v.notices)).not.toMatch(/"gtm|stateTags/);
  });

  it.each(Object.entries(TAB_ADDRESSES))("%s: draws one notice at its tab's address", (name, tabAddress) => {
    const obs = FIXTURES[name]!();
    const v = buildPopupView({ observations: obs, findings: [], distinctCookies: 0, adTechRequests: 0, sendingSignal: true, signalKnown: true, tabAddress });
    expect(v.state).toBe("ineligible");
    expect(v.notices.map((n) => n.textKey)).toEqual([name === "new-tab" ? "stateNewTab" : "stateIneligible"]);
  });

  it("has a headline on record for every fixture that shows one", () => {
    // A page whose load was not observed, or that did not load, shows its one notice and no headline.
    const shown = withData.filter(([, obs]) => obs.context.loadObserved !== false && !obs.context.loadError).map(([name]) => name);
    expect(Object.keys(HEADLINES).sort()).toEqual([...shown].sort());
  });

  it.each(Object.entries(HEADLINES))("%s: the headline counts what it counted, and says who by kind", (name, [count, key, substitution]) => {
    const obs = withData.find(([n]) => n === name)![1];
    const t = obs.tallies;
    const off = obs.signal.source === "none";
    const v = buildPopupView({
      observations: obs,
      findings: [],
      distinctCookies: t.adCookieKeys.length,
      distinctCookiesUnsigned: (t.adCookieKeysUnsigned ?? []).length,
      adTechRequests: t.adVendorRequests,
    });
    if (count !== null) expect(off ? v.unsignedCookieCount : v.cookieCount).toBe(count);
    expect(v.countCaption).toEqual({ key, ...(substitution ? { substitution } : {}) });
  });

  it("functional: the list that ships labels the counted cookies it should, and no others", () => {
    // The real list, on this fixture's page: Rokt's cookie is Akamai's load balancer's,
    // Digioh's is Cloudflare's bot management. Adobe's two are its own. The site's and the
    // consent tool's __cf_bm are listed and not counted.
    const obs = withData.find(([n]) => n === "functional")![1];
    const classifier = getClassifier();
    const v = buildPopupView({
      observations: obs,
      findings: [],
      distinctCookies: obs.tallies.adCookieKeys.length,
      adTechRequests: obs.tallies.adVendorRequests,
      classify: (url) => {
        const c = classifier.classify(url, obs.context.topSite);
        return { party: c.party, category: c.category, entity: c.entity?.name ?? null, domain: c.registrableDomain };
      },
      isListedFunctional: (name) => getFunctionalCookies().lists(name),
    });
    expect(v.cookieCount).toBe(4);
    expect(v.vendors.map((r) => [r.name, r.category, r.cookies, r.functionalCookies])).toEqual([
      ["Adobe", "advertising", ["demdex", "everest_g_v2"], []],
      ["Rokt", "advertising", ["akaalb_Instance-1"], ["akaalb_Instance-1"]],
      ["Digioh", "analytics", ["__cf_bm"], ["__cf_bm"]],
      ["OneTrust", "consent-managers", ["__cf_bm"], []],
    ]);
  });
});

/**
 * The store screenshots. Each caption states something the popup shows; these hold each
 * fixture to what its caption says of it, so a change to the engine or the view that moves
 * a shot fails here.
 */
describe("store screenshots", () => {
  const open = (name: string) => {
    const obs = FIXTURES[name]?.();
    if (!obs) throw new Error(`no fixture ${name}`);
    const functional = getFunctionalCookies();
    const input = classifiedInput(obs, { classifier: getClassifier(), owners: getOwnerNames(), isListedFunctional: (n) => functional.lists(n) });
    // As the popup opens on a finished page, with this extension's sending on (the default).
    const view = buildPopupView({ ...input, pending: false, sendingSignal: true, signalKnown: true, checkWellKnownEnabled: true });
    return { obs, flags: input.findings.map((f) => f.flag), view, reads: Object.fromEntries(view.vendors.map((r) => [r.name, r.checkKey])) };
  };

  it("lists six shots, five of them for the Chrome Web Store", () => {
    expect(SHOTS.map((s) => s.name)).toEqual(["shot-honored", "shot-notice-vs-cookies", "shot-read-gpc", "shot-privacy-strings", "shot-side-panel", "shot-brave"]);
    expect(SHOTS.filter((s) => s.chromeStore)).toHaveLength(5);
  });

  it("the fictional vendors are all on the reserved .example TLD, so none can shadow a real domain", () => {
    for (const v of FICTIONAL_VENDORS) expect(v.domain, v.entityName).toMatch(/^[a-z]+\.example$/);
    // And the extension's own classifier does not know them: they exist in the harness only.
    for (const v of FICTIONAL_VENDORS) expect(realClassifier().classify(`https://x.${v.domain}/`, "shop.example").entity).toBeNull();
  });

  it.each(SHOTS.map((s) => [s.name, s] as const))("%s: names no real company", (_name, shot) => {
    const fictional = new Set(FICTIONAL_VENDORS.map((v) => v.entityName));
    for (const row of open(shot.fixture).view.vendors) {
      if (row.group === "unlisted") expect(row.name, row.name).toMatch(/\.example$/);
      else expect(fictional.has(row.name), row.name).toBe(true);
    }
  });

  it.each(SHOTS.map((s) => [s.name, s] as const))("%s: a fictional site on the reserved .example TLD", (_name, shot) => {
    const { obs } = open(shot.fixture);
    const site = obs.context.topSite;
    expect(site).toMatch(/^[a-z]+\.example$/);
    expect(new URL(shot.site).hostname).toBe(`www.${site}`);
    expect(new URL(obs.context.finalUrl).hostname).toBe(`www.${site}`);
    for (const domain of Object.keys(obs.tallies.byUnlistedDomain ?? {})) expect(domain).toMatch(/\.example$/);
  });

  it.each(SHOTS.map((s) => [s.name, s.fixture] as const))("%s: lists as many requests as its tallies count, per company and in all", (_name, fixture) => {
    // The frame shows the Requests tab's number beside panels that say "N/N requests carried
    // your signal"; on a capture whose list was kept, the two agree. The tab's number leaves
    // the script cookie writes out, as the tallies do.
    const { obs } = open(fixture);
    const requests = obs.network.filter((n) => n.method !== "SCRIPT");
    expect(requests).toHaveLength(obs.tallies.totalRequests);
    expect(requestCount(obs)).toBe(obs.tallies.totalRequests);
    const hostOf = (url: string) => new URL(url).hostname;
    for (const p of Object.values(obs.tallies.byEntityCategory ?? {})) {
      expect(requests.filter((n) => p.hosts.includes(hostOf(n.url))), `${p.entity} / ${p.category}`).toHaveLength(p.requests);
    }
    for (const u of Object.values(obs.tallies.byUnlistedDomain ?? {})) {
      expect(requests.filter((n) => u.hosts.includes(hostOf(n.url))), u.domain).toHaveLength(u.requests);
    }
  });

  it("captions fit one line, name no company, and pass the wording lint", () => {
    const companies = new Set(SHOTS.flatMap((s) => open(s.fixture).view.vendors.map((r) => r.name)));
    const dir = mkdtempSync(join(tmpdir(), "store-captions-"));
    writeFileSync(join(dir, "captions.json"), JSON.stringify(Object.fromEntries(SHOTS.map((s) => [s.name, { message: s.caption }]))));
    for (const { caption } of SHOTS) {
      expect(caption.length, caption).toBeLessThanOrEqual(90);
      for (const company of companies) expect(caption, company).not.toContain(company);
    }
    const lint = spawnSync(process.execPath, [fileURLToPath(new URL("../../../scripts/wording-lint.mjs", import.meta.url)), dir], { encoding: "utf8" });
    expect(lint.status, lint.stderr).toBe(0);
  });

  it("shot-honored: the file says true, the page showed a notice, the consent manager read GPC, and no cookie was counted", () => {
    const { obs, flags, view, reads } = open("store-honored");
    expect(obs.wellKnown).toMatchObject({ present: true, gpc: true, fresh: true });
    expect(obs.confirmationNotice).toBe("detected");
    expect(view.cookieCount).toBe(0);
    expect(flags).not.toContain("declared-honor-cookie-set");
    expect(reads).toMatchObject({ Harborline: "vendorGpcReadProperty", Adlark: "vendorGpcRead" });
  });

  it("shot-notice-vs-cookies: a notice detected and cookies counted, so the declared-honor finding fires on the notice", () => {
    const { obs, flags, view } = open("store-notice-cookies");
    expect(obs.confirmationNotice).toBe("detected");
    expect(obs.wellKnown?.present).toBe(false);
    expect(flags).toContain("declared-honor-cookie-set");
    expect(view.notices.map((n) => n.textKey)).toContain("findingConfirmationShownButSet");
    expect(view.cookieCount).toBe(10);
  });

  it("shot-read-gpc: who read GPC and who did not, and Adlark's cookies one sent back and one not", () => {
    const { obs, view, reads } = open("store-read-gpc");
    expect(obs.wellKnown).toMatchObject({ present: true, gpc: true, fresh: true });
    expect(reads).toEqual({
      Adlark: "vendorGpcRead",
      Bidmoor: "vendorGpcReadProperty",
      "Dunmore Exchange": "vendorGpcRead",
      "Glimmer Media": "vendorGpcNotRead",
      Pixelmoss: "vendorGpcNotRead",
      Tallyhall: "vendorGpcNotApplicable",
    });
    const adlark = view.vendors.find((r) => r.name === "Adlark")!;
    expect(adlark.detail.cookies.map((c) => [c.name, c.sentBack])).toEqual([["alk_bundle", false], ["alk_uid", true]]);
  });

  it("shot-privacy-strings: the GPP string has the GPC field set and records no opt-out, and the conflict notice shows", () => {
    const { obs, flags, view } = open("store-privacy-strings");
    expect(obs.gpp?.sections["usnat"]).toMatchObject({ Gpc: 1, SaleOptOut: 2, SharingOptOut: 2, TargetedAdvertisingOptOut: 2 });
    expect(flags).toContain("gpp-conflict");
    expect(view.notices.map((n) => n.textKey)).toContain("findingGppConflict");
    expect(view.privacyStrings.map((r) => r.id)).toEqual(["gpp", "usp", "tcf", "gcm"]);
  });

  it("shot-side-panel: vendors in Advertising and Analytics, then the domains with no company, one that read GPC", () => {
    const { view, reads } = open("store-side-panel");
    const groups = [...new Set(view.vendors.map((r) => r.group ?? r.category))];
    expect(groups).toEqual(["advertising", "analytics", "unlisted"]);
    expect(view.vendors.filter((r) => (r.group ?? r.category) === "advertising")).toHaveLength(8);
    expect(view.vendors.filter((r) => r.group === "unlisted").map((r) => r.name)).toEqual(["marketcdn.example", "reviews.example"]);
    expect(reads).toMatchObject({ "marketcdn.example": "vendorGpcReadProperty", "reviews.example": "vendorGpcNotRead", "Glimmer Media": "vendorGpcNotRead" });
    const cdn = view.vendors.find((r) => r.name === "marketcdn.example")!;
    expect(cdn.detail.cookies.map((c) => c.name)).toEqual(["mk_session", "mk_visitor"]);
  });

  it("shot-brave: the browser set the signal, Settings points at the browser's setting, and so does a returning user's first run", () => {
    const on = open("store-brave");
    expect(on.view.status).toMatchObject({ isSet: true, sourceKey: "sourceBrowser" });
    expect(nativeSendSetting(on.obs.signal)).toEqual({ descKey: "settingSendSignalNative", inert: true });
    expect(nativeFirstRunKey(on.obs.signal)).toBe("firstRunSignalNative");
    const off = open("store-brave-off");
    // The browser has it off and this extension's rule still sends the header.
    expect(off.view.status).toMatchObject({ isSet: false, sourceKey: "sourceBrowserOffHeaderSent" });
    expect(nativeSendSetting(off.obs.signal)).toEqual({ descKey: "settingSendSignalNativeOff", inert: false });
    expect(nativeFirstRunKey(off.obs.signal)).toBe("firstRunSignalNativeOff");
  });
});
