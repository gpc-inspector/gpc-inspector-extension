// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import type { CookieRecord } from "@gpc-inspector/schema";
import { PrefetchedCookies, PREFETCH_LIFETIME_MS } from "../src/background/prefetched.js";

const cookie = (name: string): CookieRecord =>
  ({ name, value: "1", domain: "", path: "/", expiresMs: null, secure: false, httpOnly: false, sameSite: null, partitioned: false }) as unknown as CookieRecord;

describe("PrefetchedCookies", () => {
  it("hands a prefetch's cookies to the first request for its address in the same tab, once", () => {
    const p = new PrefetchedCookies();
    p.keep(1, "https://a.example/next", [cookie("x")], 0);
    expect(p.take(2, "https://a.example/next", 10)).toEqual([]);
    expect(p.take(1, "https://a.example/other", 10)).toEqual([]);
    expect(p.take(1, "https://a.example/next", 10).map((c) => c.name)).toEqual(["x"]);
    expect(p.take(1, "https://a.example/next", 20)).toEqual([]);
  });

  it("drops a prefetch Chrome no longer keeps", () => {
    const p = new PrefetchedCookies();
    p.keep(1, "https://a.example/next", [cookie("x")], 0);
    expect(p.take(1, "https://a.example/next", PREFETCH_LIFETIME_MS + 1)).toEqual([]);
  });

  it("keeps nothing for a prefetch that set no cookie, and forgets a closed tab", () => {
    const p = new PrefetchedCookies();
    p.keep(1, "https://a.example/none", [], 0);
    p.keep(1, "https://a.example/next", [cookie("x")], 0);
    p.forgetTab(1);
    expect(p.take(1, "https://a.example/next", 10)).toEqual([]);
  });

  it("keeps the last prefetch of an address", () => {
    const p = new PrefetchedCookies();
    p.keep(1, "https://a.example/next", [cookie("old")], 0);
    p.keep(1, "https://a.example/next", [cookie("new")], 1);
    expect(p.take(1, "https://a.example/next", 2).map((c) => c.name)).toEqual(["new"]);
  });

  it("keeps at most 100 addresses a tab, oldest out first", () => {
    const p = new PrefetchedCookies();
    for (let i = 0; i <= 100; i++) p.keep(1, `https://a.example/${i}`, [cookie(`c${i}`)], 0);
    expect(p.take(1, "https://a.example/0", 1)).toEqual([]);
    expect(p.take(1, "https://a.example/1", 1).map((c) => c.name)).toEqual(["c1"]);
    expect(p.take(1, "https://a.example/100", 1).map((c) => c.name)).toEqual(["c100"]);
  });
});
