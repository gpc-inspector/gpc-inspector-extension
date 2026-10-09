// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect, beforeEach } from "vitest";
import { redact, redactUrl, entityCategoryKey } from "@gpc-inspector/schema";
import type { ScriptInsertion, ScriptInsertionLoader } from "@gpc-inspector/schema";
import {
  evaluate,
  resolveLoaders,
  recordKeyOf,
  countDistinctCookiesSetWithSignal,
  countAdTechRequests,
  checksByContainer,
} from "../src/index.js";
import {
  buildObservationSet,
  fakeClassifier,
  request,
  cookie,
  consentApiCall,
  resetIds,
  type FakeRule,
} from "./helpers.js";

/**
 * Replayability across redaction (FR-23 against FR-24).
 *
 * A bundle is sealed with the REDACTED set and the findings computed from it. A third party
 * re-running the engine on the bundle must get those findings back, and they must be the
 * findings the reader saw. Both hold only if the engine reads nothing the redaction pass
 * changes. This test states that dependency once, over a fixture that exercises each field
 * the pass touches, so a future rule that reads a query string or a cookie value fails
 * here rather than in a dispute.
 */

const RULES: FakeRule[] = [
  { match: "doubleclick.net", category: "advertising", entityName: "Google" },
  { match: "criteo.com", category: "advertising", entityName: "Criteo" },
  { match: "facebook.net", category: "advertising", entityName: "Meta" },
];
const classify = fakeClassifier(RULES);

const GTM_A = "https://www.googletagmanager.com/gtm.js?id=GTM-A";
const GTM_B = "https://www.googletagmanager.com/gtm.js?id=GTM-B";
const SECRET = "tok_2718281828";

function loader(over: Partial<ScriptInsertionLoader>): ScriptInsertionLoader {
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

function fixture() {
  return buildObservationSet({
    context: { finalUrl: `https://example.com/search?q=${SECRET}`, topSite: "example.com" },
    signal: {
      readCount: 4,
      readsByScript: {
        [`https://static.criteo.com/tag.js?v=${SECRET}`]: 1,
        "https://static.criteo.com/tag.js?v=2": 3,
      },
      readAttribution: {
        sampled: 6,
        unattributed: 0,
        viaTagManager: 5,
        // Two frames of one container that differ only in their query collapse to one key.
        viaTagManagerByContainer: {
          [`${GTM_A}&gtm_auth=${SECRET}`]: 2,
          [`${GTM_A}&gtm_preview=env-7`]: 1,
          [`${GTM_B}&l=dl2`]: 2,
        },
      },
    },
    network: [
      request({
        url: `https://ad.doubleclick.net/pixel?id=${SECRET}`,
        initiator: `https://example.com/search?q=${SECRET}`,
        requestHeaders: [{ name: "Cookie", nameLower: "cookie", value: `IDE=${SECRET}` }],
        cookiesSent: ["IDE"],
        responseHeaders: [
          { name: "Set-Cookie", nameLower: "set-cookie", value: `IDE=${SECRET}; Path=/; Secure` },
        ],
        setCookies: [cookie({ name: "IDE", value: SECRET, domain: ".doubleclick.net" })],
      }),
      request({
        url: `https://connect.facebook.net/tag.js?cb=${SECRET}`,
        resourceType: "script",
        setCookies: [
          cookie({
            name: "_fbp",
            value: SECRET,
            domain: ".example.com",
            via: "documentCookie",
            writerScriptUrl: `https://connect.facebook.net/tag.js?cb=${SECRET}`,
          }),
        ],
      }),
    ],
    consentApiCalls: [
      consentApiCall({
        callerScriptUrl: `https://static.criteo.com/tag.js?v=${SECRET}`,
        containerUrls: [`${GTM_A}&gtm_auth=${SECRET}`],
      }),
    ],
    gtm: {
      present: true,
      containerIds: ["GTM-A", "GTM-B"],
      gtagIds: [],
      consentMode: null,
      consentModeDefaultSetBy: `${GTM_A}&gtm_auth=${SECRET}`,
      consentModeUpdateSetBy: `${GTM_B}&l=dl2`,
    },
    scriptInsertions: [
      rec(
        `https://connect.facebook.net/tag.js?cb=${SECRET}`,
        loader({ insertedBy: [`${GTM_A}&l=dataLayer`], containerUrls: [`${GTM_A}&l=dataLayer`] }),
      ),
      rec(
        `https://static.criteo.com/tag.js?v=${SECRET}`,
        loader({ insertedBy: [`https://example.com/app.js?v=${SECRET}`] }),
      ),
    ],
    scriptInsertionCoverage: {
      recorded: 2, parser: 0, duplicates: 0, inline: 0, inlineResolvedByCurrentScript: 0,
      nonExecuting: 0, srcUnresolved: 0, stackFailed: 0, ambiguousContainer: 0,
      capExceeded: 0, wrappedOver: false, selfDisabled: false,
    },
  });
}

beforeEach(() => resetIds());

describe("the engine reads nothing redaction changes", () => {
  it("evaluates to the same findings before and after", () => {
    const o = fixture();
    const before = evaluate(o, classify);
    expect(before.length).toBeGreaterThan(0);
    // The one URL a finding carries is a site script's that loaded a vendor, named on the
    // artifact (a read's too, since 1.26.0), not read by any rule. It comes out redacted.
    const named = JSON.parse(JSON.stringify(before), (key, value) =>
      key === "url" && typeof value === "string" ? redactUrl(value) : value,
    );
    expect(evaluate(redact(o), classify)).toEqual(named);
  });

  it("resolves the same loaders before and after; a site script is named by its redacted URL", () => {
    const o = fixture();
    const before = resolveLoaders(o, classify);
    const after = resolveLoaders(redact(o), classify);
    // The one URL that travels INTO an identity is the site script's, carried as the
    // artifact naming the loader rather than read by any rule. It comes out redacted.
    const named = [...before.byPair].map(([pair, loaders]) => [
      pair,
      loaders.map((l) => (l.kind === "site" && l.url !== null ? { ...l, url: redactUrl(l.url) } : l)),
    ]);
    expect([...after.byPair]).toEqual(named);
    expect(after.byPair.get(entityCategoryKey("Criteo", "advertising"))).toEqual([{ kind: "site", url: "https://example.com/app.js" }]);
    expect([...after.undeterminedPairs]).toEqual([...before.undeterminedPairs]);
  });

  it("counts the same checks per container: frame URLs collapse, identities and totals do not", () => {
    const o = fixture();
    const strip = (m: ReturnType<typeof checksByContainer>) =>
      [...m].map(([key, e]) => [key, e.identity, e.checks]);
    expect(checksByContainer(o).size).toBe(2);
    expect(strip(checksByContainer(redact(o)))).toEqual(strip(checksByContainer(o)));
  });

  it("counts the same", () => {
    const o = fixture();
    expect(countDistinctCookiesSetWithSignal(redact(o), classify)).toBe(
      countDistinctCookiesSetWithSignal(o, classify),
    );
    expect(countAdTechRequests(redact(o), classify)).toBe(countAdTechRequests(o, classify));
  });

  it("keeps every record key: a redacted URL has the key the capture gave the original", () => {
    for (const u of [
      `${GTM_A}&l=dataLayer&gtm_auth=${SECRET}`,
      "https://www.googletagmanager.com/gtag/js?id=G-1&l=x",
      `https://connect.facebook.net/tag.js?cb=${SECRET}#x`,
      "https://tags.tiqcdn.com/utag/acct/prof/prod/utag.js?utv=1",
    ]) {
      expect(recordKeyOf(redactUrl(u))).toBe(recordKeyOf(u));
    }
  });
});
