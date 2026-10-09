// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import {
  normalizeHeaders,
  hostOf,
  observationFromRequest,
  observationFromResponse,
  mergeResponse,
  hopId,
  isRetainable,
  belongsToRequest,
  isTrackableTopLevel,
  dedupeCookies,
} from "../src/background/requests.js";
import type { CookieRecord } from "@gpc-inspector/schema";

function hdr(name: string, value: string) {
  return { name, value };
}

describe("header normalization", () => {
  it("precomputes a lowercased name for stable matching", () => {
    const h = normalizeHeaders([hdr("Set-Cookie", "a=1")]);
    expect(h[0]).toEqual({ name: "Set-Cookie", nameLower: "set-cookie", value: "a=1" });
  });

  it("treats a missing value as empty rather than dropping the header", () => {
    const h = normalizeHeaders([{ name: "X-Empty" }] as never);
    expect(h[0]?.value).toBe("");
  });

  it("returns [] for undefined input", () => {
    expect(normalizeHeaders(undefined)).toEqual([]);
  });
});

describe("hostOf", () => {
  it("extracts the hostname", () => {
    expect(hostOf("https://ads.doubleclick.net/x?y=1")).toBe("ads.doubleclick.net");
  });
  it("returns empty string rather than throwing on garbage", () => {
    expect(hostOf("not a url")).toBe("");
  });
});

describe("observationFromRequest (FR-7)", () => {
  const base = {
    requestId: "req-1",
    url: "https://doubleclick.net/ads",
    method: "GET",
    type: "image",
    timeStamp: 1000,
  };

  it("records whether Sec-GPC: 1 was on THIS request", () => {
    const withSignal = observationFromRequest({
      ...base,
      requestHeaders: [hdr("Sec-GPC", "1")],
    });
    expect(withSignal.secGpcPresent).toBe(true);

    const without = observationFromRequest({ ...base, requestHeaders: [] });
    expect(without.secGpcPresent).toBe(false);
  });

  it("only accepts the exact value 1 (the spec defines no others)", () => {
    const bogus = observationFromRequest({
      ...base,
      requestHeaders: [hdr("Sec-GPC", "true")],
    });
    expect(bogus.secGpcPresent).toBe(false);
  });

  it("leaves response fields null until a response is seen", () => {
    const o = observationFromRequest(base);
    expect(o.statusCode).toBeNull();
    expect(o.responseHeaders).toBeNull();
    expect(o.setCookies).toEqual([]);
    expect(o.isRedirectHop).toBe(false);
  });

  it("preserves the resource type verbatim (an open string)", () => {
    // Real sites produce media/websocket/other, which a closed enum would drop.
    for (const type of ["image", "media", "websocket", "other", "something_new"]) {
      expect(observationFromRequest({ ...base, type }).resourceType).toBe(type);
    }
  });
});

describe("mergeResponse (FR-8)", () => {
  const req = observationFromRequest({
    requestId: "req-1",
    url: "https://doubleclick.net/ads",
    method: "GET",
    type: "image",
    timeStamp: 1000,
    requestHeaders: [hdr("Sec-GPC", "1")],
  });

  it("captures Set-Cookie from the response", () => {
    const merged = mergeResponse(req, {
      statusCode: 200,
      url: "https://doubleclick.net/ads",
      responseHeaders: [hdr("Set-Cookie", "IDE=abc; Path=/; Domain=.doubleclick.net")],
    });
    expect(merged.setCookies).toHaveLength(1);
    expect(merged.setCookies[0]?.name).toBe("IDE");
    expect(merged.setCookies[0]?.domain).toBe(".doubleclick.net");
  });

  it("flags a redirect response as a hop", () => {
    const merged = mergeResponse(req, {
      statusCode: 302,
      url: "https://doubleclick.net/ads",
      responseHeaders: [hdr("Set-Cookie", "IDE=abc")],
    });
    expect(merged.isRedirectHop).toBe(true);
    expect(merged.setCookies).toHaveLength(1); // cookies on hops are NOT discarded
  });

  it("does not flag a 200 as a hop", () => {
    expect(
      mergeResponse(req, { statusCode: 200, url: req.url, responseHeaders: [] }).isRedirectHop,
    ).toBe(false);
  });

  it("preserves the request-side facts when merging", () => {
    const merged = mergeResponse(req, { statusCode: 200, url: req.url, responseHeaders: [] });
    expect(merged.secGpcPresent).toBe(true);
    expect(merged.id).toBe("req-1");
  });

  it("falls back to the response host when the cookie omits Domain", () => {
    const merged = mergeResponse(req, {
      statusCode: 200,
      url: "https://tracker.example.com/px",
      responseHeaders: [hdr("Set-Cookie", "uid=1")],
    });
    expect(merged.setCookies[0]?.domain).toBe(".tracker.example.com");
  });
});

describe("observationFromResponse (1.26.0)", () => {
  it("builds an observation from a response alone, its cookies parsed and its request marked lost", () => {
    const o = observationFromResponse({
      requestId: "late-1", url: "https://ads.doubleclick.net/x", method: "GET", type: "xmlhttprequest", timeStamp: 5,
      statusCode: 200, responseHeaders: [hdr("Set-Cookie", "IDE=abc; Path=/; Domain=.doubleclick.net")],
    });
    expect(o).toMatchObject({ id: "late-1", requestLost: true, secGpcPresent: false, cookiesSent: [], requestHeaders: [], statusCode: 200, timeMs: 5 });
    expect(o.setCookies.map((c) => c.name)).toEqual(["IDE"]);
  });
});

describe("hop ids", () => {
  it("keeps the plain requestId for the first response and suffixes later hops", () => {
    expect(hopId("req-1", 0)).toBe("req-1");
    expect(hopId("req-1", 1)).toBe("req-1#1");
    expect(hopId("req-1", 2)).toBe("req-1#2");
  });
});

describe("retention filter", () => {
  it("keeps ordinary http(s) observations", () => {
    const o = observationFromRequest({
      requestId: "r",
      url: "https://example.com/x",
      method: "GET",
      type: "script",
      timeStamp: 0,
    });
    expect(isRetainable(o)).toBe(true);
  });

  it("drops browser- and extension-internal requests", () => {
    for (const url of [
      "chrome://settings",
      "chrome-extension://abc/page.html",
      "about:blank",
      "data:text/html,hi",
    ]) {
      const o = observationFromRequest({
        requestId: "r",
        url,
        method: "GET",
        type: "other",
        timeStamp: 0,
      });
      expect(isRetainable(o)).toBe(false);
    }
  });
});

describe("belongsToRequest — prefix-collision guard", () => {
  it("matches the exact requestId and its hop suffixes", () => {
    expect(belongsToRequest("147", "147")).toBe(true);
    expect(belongsToRequest("147#1", "147")).toBe(true);
    expect(belongsToRequest("147#12", "147")).toBe(true);
  });

  it("does NOT match a numerically longer requestId", () => {
    // Chrome requestIds are sequential numbers, so "147" vs "1470" collides under a
    // naive startsWith test. That misattributes a response to an unrelated request.
    expect(belongsToRequest("1470", "147")).toBe(false);
    expect(belongsToRequest("1471#1", "147")).toBe(false);
    expect(belongsToRequest("14712", "147")).toBe(false);
  });

  it("does not match an unrelated id", () => {
    expect(belongsToRequest("999", "147")).toBe(false);
  });
});

describe("isTrackableTopLevel", () => {
  it("accepts http and https pages", () => {
    expect(isTrackableTopLevel("https://example.com/")).toBe(true);
    expect(isTrackableTopLevel("http://example.com/")).toBe(true);
  });

  it("rejects browser-internal pages that cannot host content scripts", () => {
    // Observed in the wild: chrome://new-tab-page produced topSite "new-tab-page",
    // against which party classification is meaningless.
    for (const url of [
      "chrome://new-tab-page",
      "chrome://settings",
      "chrome-extension://abc/x.html",
      "about:blank",
      "file:///Users/x/index.html",
      "not a url",
    ]) {
      expect(isTrackableTopLevel(url)).toBe(false);
    }
  });
});

describe("dedupeCookies", () => {
  const c = (name: string, domain: string, path = "/"): CookieRecord => ({
    name,
    value: "v",
    domain,
    path,
    expiresMs: null,
    sameSite: "None",
    httpOnly: false,
    secure: true,
    partitioned: false,
    via: "onHeadersReceived",
  });

  it("collapses an identical name+domain+path, keeping the last", () => {
    const out = dedupeCookies([
      c("SIDCC", ".google.com"),
      c("SIDCC", ".google.com"),
      c("SIDCC", ".google.com"),
    ]);
    expect(out).toHaveLength(1);
  });

  it("keeps the same name on DIFFERENT domains — those are distinct cookies", () => {
    const out = dedupeCookies([
      c("SIDCC", ".google.com"),
      c("SIDCC", ".calendar.google.com"),
    ]);
    expect(out).toHaveLength(2);
  });

  it("keeps the same name on different paths", () => {
    const out = dedupeCookies([c("a", ".x.com", "/"), c("a", ".x.com", "/sub")]);
    expect(out).toHaveLength(2);
  });

  it("reproduces the observed Google case: 6 headers, 3 distinct cookies", () => {
    const out = dedupeCookies([
      c("SIDCC", ".google.com"),
      c("__Secure-1PSIDCC", ".google.com"),
      c("__Secure-3PSIDCC", ".google.com"),
      c("SIDCC", ".google.com"),
      c("__Secure-1PSIDCC", ".google.com"),
      c("__Secure-3PSIDCC", ".google.com"),
    ]);
    expect(out.map((x) => x.name).sort()).toEqual([
      "SIDCC",
      "__Secure-1PSIDCC",
      "__Secure-3PSIDCC",
    ]);
  });

  it("dedupes through mergeResponse end to end", () => {
    const req = observationFromRequest({
      requestId: "r",
      url: "https://calendar.google.com/x",
      method: "GET",
      type: "xmlhttprequest",
      timeStamp: 0,
      requestHeaders: [hdr("Sec-GPC", "1")],
    });
    const merged = mergeResponse(req, {
      statusCode: 200,
      url: "https://calendar.google.com/x",
      responseHeaders: [
        hdr("Set-Cookie", "SIDCC=a; Domain=.google.com; Path=/"),
        hdr("Set-Cookie", "SIDCC=b; Domain=.google.com; Path=/"),
      ],
    });
    expect(merged.setCookies).toHaveLength(1);
    expect(merged.setCookies[0]?.value).toBe("b"); // last write wins
  });
});

describe("storage read failure is not an empty tab", () => {
  it("marks the state incomplete when the read throws", async () => {
    // Read as empty, a read failure would look like a genuinely new tab, and the
    // read-modify-write chain would then write that empty state back, destroying prior
    // observations without a trace.
    const original = globalThis.chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        session: {
          get: () => Promise.reject(new Error("storage unavailable")),
          set: () => Promise.resolve(),
          remove: () => Promise.resolve(),
        },
      },
    };
    try {
      const { getTabState } = await import("../src/background/state.js");
      const state = await getTabState(42);
      expect(state.incomplete).toBe(true);
      expect(state.network).toEqual([]);
    } finally {
      (globalThis as { chrome?: unknown }).chrome = original;
    }
  });
});

describe("holding a top-level navigation's events until its commit (1.26.0)", () => {
  const obs = (id: string) => ({ ...observationFromRequest({ requestId: id, url: `https://a.example/${id}`, method: "GET", type: "main_frame", timeStamp: 0 }) });

  it("holds main-frame events only while awaiting a commit, up to the cap, and hands them back in order", async () => {
    const { emptyTabState, holdTopLevel, takeHeldTopLevel, HELD_TOP_LEVEL_CAP } = await import("../src/background/state.js");
    const s = emptyTabState(1);
    // No navigation started under this worker: counted as they arrive.
    expect(holdTopLevel(s, "main_frame", "x", "request")).toBe(false);
    s.awaitingCommit = true;
    expect(holdTopLevel(s, "script", "sub", "request")).toBe(false);
    for (let i = 0; i < HELD_TOP_LEVEL_CAP; i++) {
      s.network.push(obs(`r${i}`));
      expect(holdTopLevel(s, "main_frame", `r${i}`, i % 2 === 0 ? "request" : "response")).toBe(true);
    }
    // Past the cap, counted as before.
    expect(holdTopLevel(s, "main_frame", "over", "request")).toBe(false);
    // One whose observation is gone (a crash mid-navigation) is dropped from the hand-back.
    s.network.splice(1, 1);
    const taken = takeHeldTopLevel(s);
    expect(taken.map((h) => h.obs.id).slice(0, 3)).toEqual(["r0", "r2", "r3"]);
    expect(taken[0]?.what).toBe("request");
    expect(taken).toHaveLength(HELD_TOP_LEVEL_CAP - 1);
    expect(s.awaitingCommit).toBe(false);
    expect(s.heldTopLevel).toEqual([]);
    expect(holdTopLevel(s, "main_frame", "after", "request")).toBe(false);
  });
});
