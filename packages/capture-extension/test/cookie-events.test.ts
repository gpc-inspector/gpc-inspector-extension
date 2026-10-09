// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import {
  cookieWriteAccepted,
  classifyCookieEvent,
  markCounted,
  PROBE_WINDOW_MS,
  type CookieLedger,
} from "../src/background/cookie-events.js";
import { emptyTallies, tallyCookies, untallyCookie, type TallyClassification } from "../src/background/tally.js";
import type { NetworkObservation, CookieRecord } from "@gpc-inspector/schema";

describe("which cookie writes the browser keeps", () => {
  it("refuses a public-suffix Domain: the first step of a domain probe", () => {
    // media.net and Criteo on news-g.example, 2026-09-22: `.com` first, then `.news-g.example`.
    expect(cookieWriteAccepted(".com", "www.news-g.example")).toBe(false);
    expect(cookieWriteAccepted(".news-g.example", "www.news-g.example")).toBe(true);
    expect(cookieWriteAccepted(".co.uk", "www.news-i.co.uk")).toBe(false);
    expect(cookieWriteAccepted(".news-i.co.uk", "www.news-i.co.uk")).toBe(true);
  });

  it("refuses a company's public suffix, as Chrome does: the private section of the list", () => {
    expect(cookieWriteAccepted(".myshopify.com", "my-store.myshopify.com")).toBe(false);
    expect(cookieWriteAccepted(".my-store.myshopify.com", "my-store.myshopify.com")).toBe(true);
    expect(cookieWriteAccepted(".github.io", "someone.github.io")).toBe(false);
  });

  it("refuses a Domain the writing frame is not under", () => {
    expect(cookieWriteAccepted(".criteo.com", "www.news-g.example")).toBe(false);
    expect(cookieWriteAccepted(".g.example", "www.news-g.example")).toBe(false);
  });

  it("accepts a host-only cookie, including on a single-label host", () => {
    expect(cookieWriteAccepted(".www.news-g.example", "www.news-g.example")).toBe(true);
    expect(cookieWriteAccepted(".localhost", "localhost")).toBe(true);
    expect(cookieWriteAccepted("", "www.news-g.example")).toBe(true);
  });

  it("still refuses a public suffix when the frame host is unknown", () => {
    expect(cookieWriteAccepted(".com", "")).toBe(false);
    expect(cookieWriteAccepted(".news-g.example", "")).toBe(true);
  });
});

describe("sets, deletions and probes", () => {
  const ledger = (): CookieLedger => ({ setAt: {}, probes: [] });
  const k = "cto_tld_test\u0000.news-g.example";

  it("a cookie with a future or no expiry is a set", () => {
    expect(classifyCookieEvent(ledger(), k, { expiresMs: "session" }, 1_000)).toBe("set");
    expect(classifyCookieEvent(ledger(), k, { expiresMs: 5_000 }, 1_000)).toBe("set");
  });

  it("a deletion of a cookie never counted is only a deletion", () => {
    expect(classifyCookieEvent(ledger(), k, { expiresMs: 0 }, 1_000)).toBe("deletion");
  });

  it("a counted cookie deleted within the window is a probe", () => {
    const l = ledger();
    markCounted(l, k, 1_000);
    expect(classifyCookieEvent(l, k, { expiresMs: 0 }, 1_050)).toBe("probe");
    expect(l.probes).toEqual([k]);
    expect(l.setAt[k]).toBeUndefined();
  });

  it("a counted cookie deleted after the window was a real cookie", () => {
    const l = ledger();
    markCounted(l, k, 1_000);
    expect(classifyCookieEvent(l, k, { expiresMs: 0 }, 1_000 + PROBE_WINDOW_MS + 1)).toBe("deletion");
    expect(l.probes).toEqual([]);
  });
});

describe("taking a probe back out of the tallies", () => {
  const AD = (entityName: string): TallyClassification => ({ party: "third", category: "advertising", entityName });
  const cookie = (name: string, domain: string): CookieRecord => ({
    name, value: "v", domain, path: "/", expiresMs: "session", sameSite: "None",
    httpOnly: false, secure: true, partitioned: false, via: "onHeadersReceived",
  });
  const req = (setCookies: CookieRecord[]): NetworkObservation => ({
    id: "r", url: "https://x.example/", method: "GET", resourceType: "script", initiator: null,
    secGpcPresent: true, cookiesSent: [], requestHeaders: [], statusCode: 200, responseHeaders: null,
    isRedirectHop: false, setCookies, captureMethod: "onHeadersReceived", timeMs: 0,
  });

  it("removes the key and the vendor's name", () => {
    const t = emptyTallies();
    tallyCookies(t, req([cookie("cto_tld_test", ".news-g.example"), cookie("uid", ".criteo.com")]), () => AD("Criteo"));
    untallyCookie(t, "cto_tld_test\u0000.news-g.example", "cto_tld_test");
    expect([...t.adCookieKeys]).toEqual(["uid\u0000.criteo.com"]);
    expect([...(t.byEntity.get("Criteo")?.cookieNames ?? [])]).toEqual(["uid"]);
  });

  it("keeps a name another counted domain still carries", () => {
    const t = emptyTallies();
    tallyCookies(t, req([cookie("uid", ".criteo.com"), cookie("uid", ".news-g.example")]), () => AD("Criteo"));
    untallyCookie(t, "uid\u0000.news-g.example", "uid");
    expect([...t.adCookieKeys]).toEqual(["uid\u0000.criteo.com"]);
    expect(t.byEntity.get("Criteo")?.cookieNames.has("uid")).toBe(true);
  });
});
