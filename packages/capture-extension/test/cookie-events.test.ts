// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import {
  cookieWriteAccepted,
  markCounted,
  markRemoved,
  hold,
  release,
  isPending,
  type CookieLedger,
} from "../src/background/cookie-events.js";
import {
  emptyTallies,
  freezeTallies,
  tallyCookies,
  talliesWithout,
  untallyCookie,
  noteRemovedAfter,
  noteWriteTest,
  type TallyClassification,
} from "../src/background/tally.js";
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

describe("what the ledger remembers of a key", () => {
  const ledger = (): CookieLedger => ({ setAt: {}, probes: [] });
  const k = "KCCH\u0000.pubmatic.com";

  it("holds a key until it is released, once", () => {
    const l = ledger();
    expect(isPending(l, k)).toBe(false);
    hold(l, k);
    hold(l, k);
    expect(l.pending).toEqual([k]);
    expect(isPending(l, k)).toBe(true);
    release(l, k);
    expect(l.pending).toEqual([]);
    expect(isPending(l, k)).toBe(false);
  });

  it("says how long after its last set a key was removed, whatever the span", () => {
    // No span of time makes a removal anything but a removal: three seconds, as a script on
    // a timer does it, and an hour.
    const soon = ledger();
    markCounted(soon, k, 1_000);
    expect(markRemoved(soon, k, 4_000)).toBe(3_000);
    expect(soon.removedAt).toEqual({ [k]: 4_000 });
    expect(soon.setAt[k]).toBeUndefined();

    const late = ledger();
    markCounted(late, k, 1_000);
    expect(markRemoved(late, k, 3_601_000)).toBe(3_600_000);
  });

  it("has nothing to say of a key not set on this page, or already removed", () => {
    const l = ledger();
    expect(markRemoved(l, k, 1_000)).toBeNull();
    markCounted(l, k, 1_000);
    markRemoved(l, k, 1_500);
    expect(markRemoved(l, k, 1_600)).toBeNull();
    expect(l.removedAt).toEqual({ [k]: 1_500 });
  });

  it("a key set again is no longer removed", () => {
    const l = ledger();
    markCounted(l, k, 1_000);
    markRemoved(l, k, 1_500);
    markCounted(l, k, 2_000);
    expect(l.removedAt).toEqual({});
    expect(l.setAt[k]).toBe(2_000);
  });

  it("never reports a removal before the set as a negative span", () => {
    // A response's time is its request's, and a request can go out before the response that
    // set the cookie arrives.
    const l = ledger();
    markCounted(l, k, 1_000);
    expect(markRemoved(l, k, 900)).toBe(0);
  });
});

describe("taking a key the jar did not hold back out of the tallies", () => {
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

  it("shows the tallies without the keys that wait, and leaves the tallies as they were", () => {
    const t = emptyTallies();
    tallyCookies(t, req([cookie("IDE", ".doubleclick.net"), cookie("lidid", ".liadm.com")]), () => AD("Google"));
    const full = freezeTallies(t);
    const shown = talliesWithout(full, ["lidid\u0000.liadm.com"]);
    expect(shown.adCookieKeys).toEqual(["IDE\u0000.doubleclick.net"]);
    expect(shown.byEntity["Google"]?.cookieNames).toEqual(["IDE"]);
    expect(Object.keys(shown.cookieDetails ?? {})).toEqual(["IDE\u0000.doubleclick.net"]);
    // The stored tallies still hold it, for the check's answer to keep or take out.
    expect(full.adCookieKeys).toEqual(["IDE\u0000.doubleclick.net", "lidid\u0000.liadm.com"]);
    expect(talliesWithout(full, [])).toBe(full);
  });

  it("records a removal on the key's detail, and a set after it clears it", () => {
    const t = emptyTallies();
    const key = "test_cookie\u0000.doubleclick.net";
    tallyCookies(t, req([cookie("test_cookie", ".doubleclick.net")]), () => AD("Google"));
    noteRemovedAfter(t, key, 2_051);
    expect(t.cookieDetails.get(key)?.removedAfterMs).toBe(2_051);
    expect([...t.adCookieKeys]).toEqual([key]);
    tallyCookies(t, req([cookie("test_cookie", ".doubleclick.net")]), () => AD("Google"));
    expect(t.cookieDetails.get(key)?.removedAfterMs).toBeUndefined();
    // A key with no detail keeps no mark, and nothing throws.
    noteRemovedAfter(t, "none\u0000.example", 5);
  });

  it("clears the mark on a set the first-party summary takes, which records no detail", () => {
    // A vendor's script sets the cookie on the site, the site's own script removes it and
    // sets it again: the browser holds it, and nothing reads as removed.
    const t = emptyTallies();
    const key = "demo_id\u0000.news-g.example";
    tallyCookies(t, req([cookie("demo_id", ".news-g.example")]), () => AD("Criteo"));
    noteRemovedAfter(t, key, 300);
    const FIRST: TallyClassification = { party: "first", category: "unknown", entityName: null };
    tallyCookies(t, req([cookie("demo_id", ".news-g.example")]), () => FIRST);
    expect(t.cookieDetails.get(key)?.removedAfterMs).toBeUndefined();
  });
});

describe("a write test is noted where its write would have been kept, and counts nothing", () => {
  const cookie = (name: string, domain: string, writerScriptUrl?: string): CookieRecord => ({
    name, value: "", domain, path: "/", expiresMs: 0, sameSite: "None",
    httpOnly: false, secure: true, partitioned: false, via: "documentCookie",
    ...(writerScriptUrl === undefined ? {} : { writerScriptUrl }),
  });
  const classifyScript = (url: string): TallyClassification =>
    url.includes("criteo") ? { party: "third", category: "advertising", entityName: "Criteo" } : { party: "first", category: "unknown", entityName: null };
  /** The script-write observation a removal is recorded on. */
  const written = (c: CookieRecord): NetworkObservation => ({
    id: `js-${c.name}-1`, url: c.writerScriptUrl ?? "https://www.news-g.example/", method: "SCRIPT", resourceType: "other", initiator: null,
    secGpcPresent: true, cookiesSent: [], requestHeaders: [], statusCode: null, responseHeaders: null,
    isRedirectHop: false, setCookies: [c], captureMethod: "documentCookie", timeMs: 1_000,
  });

  it("on the vendor's list for a cookie that would have counted", () => {
    const t = emptyTallies();
    const removal = cookie("cto_tld_test", ".criteo.com", "https://static.criteo.net/js/ld/publishertag.js");
    noteWriteTest(t, written(removal), removal, { kind: "host", party: "third", category: "advertising", entity: { name: "Criteo", id: "Criteo" } }, classifyScript);
    const f = freezeTallies(t);
    expect(f.probeCookies).toEqual({ Criteo: ["cto_tld_test"] });
    expect(f.adCookieKeys).toEqual([]);
    expect(f.adCookieEvents).toBe(0);
    // Its script ran, as a kept write of its own would say.
    expect(f.byEntity["Criteo"]?.scriptRan).toBe(true);
    expect(f.byEntityCategory?.["Criteo\u0000advertising"]).toMatchObject({ scriptRan: true, probeCookies: ["cto_tld_test"], cookieKeys: [], cookieKeysUnsigned: [] });
  });

  it("on the first party's list for the site's own, and on no vendor's", () => {
    const t = emptyTallies();
    const removal = cookie("cookietest", ".www.news-g.example");
    noteWriteTest(t, written(removal), removal, { kind: "host", party: "first", category: "unknown", entity: null }, classifyScript);
    const f = freezeTallies(t);
    expect(f.firstParty?.probeCookies).toEqual(["cookietest"]);
    expect(f.probeCookies).toEqual({});
  });
});
