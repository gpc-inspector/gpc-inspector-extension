// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DisconnectClassifier, loadDefaultClassifier, loadCompiledList } from "../src/index.js";
import { registrableDomain, domainSuffixes, isPublicSuffix, PUBLIC_SUFFIX_LIST_VERSION } from "../src/public-suffix.js";
import type { CompiledList, Override } from "../src/classifier.js";
// @ts-expect-error a build script, with no types of its own
import { compilePublicSuffixList } from "../scripts/compile-public-suffix.mjs";
import { CATEGORIES } from "@gpc-inspector/engine";
import {
  upstreamCategories,
  upstreamCategoryNames,
  applicableCategories,
  applicablePurposes,
  techniqueOnlyHosts,
  upstreamPurposeNames,
  engineName,
  COUNTED_CATEGORIES,
  TECHNIQUE_CATEGORIES,
} from "./upstream.js";

const here = dirname(fileURLToPath(import.meta.url));
const listPath = join(here, "..", "data", "compiled-list.json");
const list: CompiledList = loadCompiledList(
  JSON.parse(readFileSync(listPath, "utf8")),
);
const classifier = new DisconnectClassifier(list);

describe("registrableDomain (eTLD+1)", () => {
  it("handles plain two-label domains", () => {
    expect(registrableDomain("example.com")).toBe("example.com");
  });

  it("strips subdomains", () => {
    expect(registrableDomain("securepubads.g.doubleclick.net")).toBe("doubleclick.net");
    expect(registrableDomain("a.b.c.d.example.com")).toBe("example.com");
  });

  it("handles multi-part public suffixes", () => {
    expect(registrableDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("shop.example.com.au")).toBe("example.com.au");
    expect(registrableDomain("news.example.co.jp")).toBe("example.co.jp");
  });

  it("leaves IP literals and single labels alone", () => {
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
    expect(registrableDomain("localhost")).toBe("localhost");
  });

  it("is case-insensitive and tolerates a trailing dot", () => {
    expect(registrableDomain("WWW.Example.COM.")).toBe("example.com");
  });
});

describe("the Public Suffix List, in full", () => {
  it("makes each customer of a private suffix a site of its own", () => {
    // Seen on the corpus.
    expect(registrableDomain("menswear-a.myshopify.com")).toBe("menswear-a.myshopify.com");
    expect(registrableDomain("checkout.menswear-a.myshopify.com")).toBe("menswear-a.myshopify.com");
    expect(registrableDomain("trial-eum-clientnsv4-s.akamaihd.net")).toBe("trial-eum-clientnsv4-s.akamaihd.net");
    expect(registrableDomain("rum.hlx.page")).toBe("rum.hlx.page");
    expect(registrableDomain("fonts.googleapis.com")).toBe("fonts.googleapis.com");
    expect(registrableDomain("d111111abcdef8.cloudfront.net")).toBe("d111111abcdef8.cloudfront.net");
  });

  it("reads suffixes of four labels, wildcards and exceptions as the list defines them", () => {
    expect(registrableDomain("a1b2c3d4e5.execute-api.us-west-1.amazonaws.com")).toBe("a1b2c3d4e5.execute-api.us-west-1.amazonaws.com");
    // *.compute.amazonaws.com: any one label there is a suffix.
    expect(registrableDomain("a.b.us-east-2.compute.amazonaws.com")).toBe("b.us-east-2.compute.amazonaws.com");
    // *.ck, with !www.ck the exception: www.ck is registrable, any other second label is not.
    expect(registrableDomain("shop.example.co.ck")).toBe("example.co.ck");
    expect(registrableDomain("a.www.ck")).toBe("www.ck");
  });

  it("reads a Unicode rule in the ASCII form a hostname arrives in", () => {
    // 公司.cn is a rule; a URL's hostname carries it as xn--55qx5d.cn.
    expect(registrableDomain(new URL("https://www.example.公司.cn/").hostname)).toBe("example.xn--55qx5d.cn");
  });

  it("leaves a public suffix and an IP literal as they are", () => {
    expect(registrableDomain("myshopify.com")).toBe("myshopify.com");
    expect(registrableDomain("co.uk")).toBe("co.uk");
    expect(registrableDomain("[2001:db8::1]")).toBe("[2001:db8::1]");
  });

  it("says which domains no site can set a cookie on, a private suffix included", () => {
    for (const d of ["com", ".co.uk", "myshopify.com", ".akamaihd.net", "us-east-2.compute.amazonaws.com"]) expect(isPublicSuffix(d), d).toBe(true);
    for (const d of ["example.com", ".bbc.co.uk", "menswear-a.myshopify.com", "www.ck", "127.0.0.1", ""]) expect(isPublicSuffix(d), d).toBe(false);
  });

  it("names the list it was compiled from", () => {
    expect(PUBLIC_SUFFIX_LIST_VERSION.source).toBe("https://publicsuffix.org/list/public_suffix_list.dat");
    expect(PUBLIC_SUFFIX_LIST_VERSION.version).toMatch(/^\d{4}-\d{2}-\d{2}_/);
    expect(PUBLIC_SUFFIX_LIST_VERSION.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("ships exactly what the compile makes of the vendored list, from either line ending", () => {
    // The file that ships is held to the list and the code that writes it.
    const dat = readFileSync(join(here, "..", "data", "public_suffix_list.dat"), "utf8");
    const shipped: unknown = JSON.parse(readFileSync(join(here, "..", "data", "public-suffix-list.json"), "utf8"));
    expect(compilePublicSuffixList(dat)).toEqual(shipped);
    expect(compilePublicSuffixList(dat.replace(/\n/g, "\r\n"))).toEqual(shipped);
  });

  it("judges another customer of the site's own hosting suffix as a third party", () => {
    // A site served under a private suffix: another store's host under the same suffix is
    // a third party to it, and the site's own subdomain is first party.
    expect(classifier.classify("https://other-store.myshopify.com/x.js", "my-store.myshopify.com").party).toBe("third");
    expect(classifier.classify("https://cdn.my-store.myshopify.com/x.js", "my-store.myshopify.com").party).toBe("first");
  });
});

describe("domainSuffixes", () => {
  it("returns progressively shorter suffixes, longest first, never a bare TLD", () => {
    expect(domainSuffixes("a.b.example.com")).toEqual([
      "a.b.example.com",
      "b.example.com",
      "example.com",
    ]);
  });
});

describe("classification against the real Disconnect data", () => {
  const TOP = "example.com";

  it("classifies doubleclick.net as advertising owned by Google", () => {
    const c = classifier.classify("https://doubleclick.net/ads", TOP);
    expect(c.category).toBe("advertising");
    expect(c.entity?.name).toBe("Google");
    expect(c.party).toBe("third");
  });

  it("matches a deep subdomain to its parent's classification", () => {
    const c = classifier.classify(
      "https://securepubads.g.doubleclick.net/gampad/ads?foo=1",
      TOP,
    );
    expect(c.category).toBe("advertising");
    expect(c.entity?.name).toBe("Google");
    expect(c.registrableDomain).toBe("doubleclick.net");
  });

  it("resolves the multi-category case deterministically to Advertising", () => {
    // doubleclick.net appears under BOTH "Email" and "Advertising" upstream.
    // Category precedence must always pick Advertising, on every run.
    for (let i = 0; i < 25; i++) {
      expect(classifier.classify("https://doubleclick.net/x", TOP).category).toBe(
        "advertising",
      );
    }
  });

  it("classifies google-analytics.com as Google", () => {
    const c = classifier.classify("https://www.google-analytics.com/g/collect", TOP);
    expect(c.entity?.name).toBe("Google");
    expect(["advertising", "analytics"]).toContain(c.category);
  });

  it("rolls distinct Google domains up to one entity id", () => {
    const a = classifier.classify("https://doubleclick.net/x", TOP);
    const b = classifier.classify("https://googlesyndication.com/y", TOP);
    expect(a.entity?.id).toBe(b.entity?.id);
  });

  it("recognizes other major vendors", () => {
    const criteo = classifier.classify("https://static.criteo.net/js/ld.js", TOP);
    expect(criteo.entity).not.toBeNull();
    const fb = classifier.classify("https://connect.facebook.net/en_US/fbevents.js", TOP);
    expect(fb.entity).not.toBeNull();
  });

  it("returns unclassified/unknown for a domain not in the list", () => {
    const c = classifier.classify("https://nobody-has-heard-of-this-xyz.example/t", TOP);
    expect(c.category).toBe("unknown");
    expect(c.entity).toBeNull();
  });

  it("determines party against the TOP document, not the request host", () => {
    expect(classifier.classify("https://cdn.example.com/a.js", "example.com").party).toBe(
      "first",
    );
    expect(classifier.classify("https://doubleclick.net/x", "example.com").party).toBe(
      "third",
    );
    // Same URL, different top site → different party.
    expect(classifier.classify("https://doubleclick.net/x", "doubleclick.net").party).toBe(
      "first",
    );
  });

  it("treats an unparseable URL as third-party unknown, never first-party", () => {
    const c = classifier.classify("not a url", "example.com");
    expect(c.party).toBe("third");
    expect(c.category).toBe("unknown");
  });

  it("is deterministic: identical inputs give identical output", () => {
    const a = JSON.stringify(classifier.classify("https://doubleclick.net/x", TOP));
    const b = JSON.stringify(classifier.classify("https://doubleclick.net/x", TOP));
    expect(a).toBe(b);
  });
});

describe("override layer", () => {
  const TOP = "example.com";

  it("can correct a category for a domain the upstream list got wrong", () => {
    const overrides: Override[] = [
      {
        domain: "doubleclick.net",
        category: "content",
        reason: "test-only: verifies override precedence over upstream",
      },
    ];
    const c = new DisconnectClassifier(list, overrides);
    expect(c.classify("https://doubleclick.net/x", TOP).category).toBe("content");
    // and it applies through subdomains too
    expect(c.classify("https://ads.g.doubleclick.net/x", TOP).category).toBe("content");
  });

  it("can add a classification for a domain absent from upstream", () => {
    const overrides: Override[] = [
      {
        domain: "brand-new-adtech.example",
        category: "advertising",
        entityName: "Brand New AdTech",
        reason: "test-only: verifies additive override",
      },
    ];
    const c = new DisconnectClassifier(list, overrides);
    const r = c.classify("https://pixel.brand-new-adtech.example/t", TOP);
    expect(r.category).toBe("advertising");
    expect(r.entity?.name).toBe("Brand New AdTech");
  });

  it("leaves upstream category intact when the override only renames the entity", () => {
    const overrides: Override[] = [
      {
        domain: "doubleclick.net",
        entityName: "Google LLC",
        reason: "test-only: entity rename without category change",
      },
    ];
    const c = new DisconnectClassifier(list, overrides);
    const r = c.classify("https://doubleclick.net/x", TOP);
    expect(r.entity?.name).toBe("Google LLC");
    expect(r.category).toBe("advertising");
  });
});

describe("provenance", () => {
  it("exposes source, version, and hash for the evidence bundle", () => {
    const p = classifier.provenance;
    expect(p.source).toBe("disconnect");
    expect(p.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // CC BY-NC-SA 4.0 §3(a)(1)(A): the creator, the copyright notice, the license reference
  // and the warranty disclaimer are retained wherever the data is shared. The compiled file
  // is what the extension bundles, so each source carries its upstream notice verbatim.
  it("carries each upstream file's license notice verbatim, so it ships inside the data", () => {
    expect(list.sources.length).toBeGreaterThan(0);
    for (const source of list.sources) {
      const upstream = JSON.parse(readFileSync(join(here, "..", "data", source.file), "utf8")) as {
        license?: unknown;
      };
      expect(source.notice, `${source.file} notice`).toBe(upstream.license);
      expect(source.notice).toContain("Copyright");
      expect(source.notice).toContain("Disconnect, Inc.");
      expect(source.notice).toContain("https://creativecommons.org/licenses/by-nc-sa/4.0/");
    }
  });
});

describe("loader validation", () => {
  it("rejects malformed compiled lists rather than silently misclassifying", () => {
    expect(() => loadCompiledList(null)).toThrow();
    expect(() => loadCompiledList({})).toThrow();
    expect(() => loadCompiledList({ version: "x" })).toThrow();
    expect(() => loadCompiledList({ version: "x", domains: {}, entities: {} })).toThrow();
  });

  it("builds a working classifier through loadDefaultClassifier", () => {
    const c = loadDefaultClassifier(JSON.parse(readFileSync(listPath, "utf8")));
    expect(c.classify("https://doubleclick.net/x", "example.com").entity?.name).toBe(
      "Google",
    );
  });
});

describe("degenerate entity names", () => {
  const TOP = "example.com";

  it("falls back to the domain when the upstream name is unusably short", () => {
    // Observed on retailer-m.example: Google ad domains resolved to an entity named "G.", which
    // the popup rendered beside GCL_AW_P and test_cookie. A one-character name identifies
    // nothing to a reader.
    const c = new DisconnectClassifier(list, [
      { domain: "shortname.example", category: "advertising", entityName: "G.", reason: "test" },
    ]);
    const r = c.classify("https://pixel.shortname.example/x", TOP);
    expect(r.entity?.name).toBe("shortname.example");
  });

  it("keeps names of three or more characters", () => {
    const c = new DisconnectClassifier(list, [
      { domain: "ok.example", category: "advertising", entityName: "AOL", reason: "test" },
    ]);
    expect(c.classify("https://ok.example/x", TOP).entity?.name).toBe("AOL");
  });

  it("does not invent a name from cookie contents", () => {
    // Falling back to the domain is a fact. Guessing "Google" because the cookies look
    // Google-ish would be an inference this product does not make.
    const c = new DisconnectClassifier(list, [
      { domain: "mystery.example", category: "advertising", entityName: "X", reason: "test" },
    ]);
    expect(c.classify("https://mystery.example/x", TOP).entity?.name).toBe("mystery.example");
  });
});

describe("first-party detection with a subdomain top site", () => {
  it("treats a site's own requests as first-party when topSite carries a subdomain", () => {
    // Capture derives topSite from the navigation hostname, so it arrives as
    // "www.news-f.example" while requests resolve to "news-f.example". Comparing those
    // directly put every one of a real page's 373 requests in the third-party bucket.
    const c = classifier.classify("https://www.news-f.example/news", "www.news-f.example");
    expect(c.party).toBe("first");
  });

  it("matches across differing subdomains of the same site", () => {
    expect(classifier.classify("https://cdn.news-f.example/x.js", "www.news-f.example").party).toBe(
      "first",
    );
    expect(classifier.classify("https://news-f.example/x.js", "www.news-f.example").party).toBe(
      "first",
    );
  });

  it("still calls a genuine third party third-party", () => {
    expect(
      classifier.classify("https://doubleclick.net/x", "www.news-f.example").party,
    ).toBe("third");
  });

  it("works when topSite is already a registrable domain", () => {
    expect(classifier.classify("https://news-f.example/x", "news-f.example").party).toBe("first");
  });
});

describe("categories are Disconnect's, under Disconnect's names", () => {
  const TOP = "example.com";
  const upstream = upstreamCategories();
  const compiled = Object.keys(list.domains);

  it("has one engine category per purpose category of Disconnect's, named after it", () => {
    // One for one, never merged or renamed: the popup credits the category to Disconnect. A
    // category Disconnect adds fails here until it is added, or named as a technique.
    const names = upstreamPurposeNames();
    expect(names.length).toBeGreaterThan(5);
    expect(new Set(CATEGORIES.filter((c) => c !== "unknown"))).toEqual(new Set(names.map(engineName)));
    expect(upstreamCategoryNames().filter((c) => TECHNIQUE_CATEGORIES.has(c))).toHaveLength(TECHNIQUE_CATEGORIES.size);
  });

  it("gives every domain a purpose Disconnect gives it or a listed parent, and unknown only when it gives none", () => {
    // The whole compiled index, not only services.json's hosts: a domain known only as a
    // company's property is in the index too, and its entry is found before its parent's.
    // Parents count because Disconnect matches by suffix.
    for (const domain of compiled) {
      const given = [...applicablePurposes(domain, upstream)];
      const category = classifier.classify(`https://${domain}/`, TOP).category;
      if (given.length === 0) expect(category, domain).toBe("unknown");
      else expect(given.map(engineName), `${domain} is ${given.join("+")} upstream`).toContain(category);
    }
    expect(compiled.length).toBeGreaterThan(8000);
  });

  it("lists the loaded categories exactly as compiled, so none turns into unknown at load", () => {
    for (const [domain, [, category]] of Object.entries(list.domains)) {
      expect(CATEGORIES as readonly string[], domain).toContain(category);
    }
  });

  it("shows the purpose Disconnect gives a host, and never a technique it gives the same host", () => {
    // facebook.net is Social and FingerprintingGeneral upstream. Social says whom the data is
    // for; fingerprinting says how.
    const c = classifier.classify("https://connect.facebook.net/en_US/fbevents.js", TOP);
    expect(c.category).toBe("social");
    expect(c.entity?.name).toBe("Meta");
    const techniques = [...TECHNIQUE_CATEGORIES].map(engineName);
    for (const [domain, [, category]] of Object.entries(list.domains)) {
      expect(techniques, domain).not.toContain(category);
    }
  });

  it("gives no category to a host Disconnect files under a technique and nothing else, and keeps the company", () => {
    // Fingerprinting and cryptomining say how a domain behaves. The product shows the
    // purpose or none.
    const only = techniqueOnlyHosts(upstream);
    expect(only.length).toBeGreaterThan(100);
    for (const host of only) {
      const c = classifier.classify(`https://${host}/`, TOP);
      expect(c.category, host).toBe("unknown");
      // The company survives, so the Requests tab names it where Disconnect does.
      expect(c.entity, host).not.toBeNull();
    }
  });

  it("gives a technique-only host under a purpose-classified parent the parent's purpose", () => {
    // fullstory.com is Analytics; edge.fullstory.com is listed by name as FingerprintingInvasive.
    // Disconnect's suffix matching applies the parent's entry to the host, so it is an
    // analytics domain in Disconnect's terms, the same as an unlisted fullstory.com host.
    for (const host of ["edge.fullstory.com", "tag.dtk.abtasty.com"]) {
      expect(classifier.classify(`https://${host}/`, TOP).category, host).toBe("analytics");
    }
    for (const [host, own] of upstream) {
      if (![...own].every((c) => TECHNIQUE_CATEGORIES.has(c))) continue;
      const parentCats = [...applicableCategories(host, upstream)].filter((c) => !own.has(c));
      if (!parentCats.some((c) => COUNTED_CATEGORIES.has(c))) continue;
      expect(["advertising", "analytics"], `${host} under ${parentCats.join("+")}`).toContain(
        classifier.classify(`https://${host}/`, TOP).category,
      );
    }
  });

  it("gives a company's property its parent's category, and none when no parent is listed", () => {
    // apps.fbsbx.com is only a Meta property in entities.json; fbsbx.com is Social. Its own
    // entry, written as unknown, would hide the parent's category.
    expect(classifier.classify("https://apps.fbsbx.com/", TOP)).toMatchObject({ category: "social", entity: { name: "Meta" } });
    // techcrunch.com is a Yahoo! property with no category anywhere: a company, no category.
    expect(classifier.classify("https://techcrunch.com/", TOP)).toMatchObject({ category: "unknown", entity: { name: "Yahoo!" } });
  });
});

describe("the order of the categories", () => {
  it("is the same in the list compiler and the engine", async () => {
    // The compiler decides a domain's category by this order, under Disconnect's names; the
    // engine lists a company's categories and orders the vendor list by it, under its own.
    // Read from the script's text: importing the script would run the compile.
    const { readFile } = await import("node:fs/promises");
    const { CATEGORY_PRECEDENCE } = await import("@gpc-inspector/engine");
    const src = await readFile(new URL("../scripts/compile-list.mjs", import.meta.url), "utf8");
    const order = /const CATEGORY_PRECEDENCE = \[([^\]]+)\]/.exec(src)?.[1];
    const map = /const CATEGORY_MAP = \{([^}]+)\}/.exec(src)?.[1];
    expect(order, "CATEGORY_PRECEDENCE in compile-list.mjs").toBeDefined();
    expect(map, "CATEGORY_MAP in compile-list.mjs").toBeDefined();
    const names = [...order!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    const engineName = Object.fromEntries(
      [...map!.matchAll(/(?:"([^"]+)"|(\w+)):\s*"([^"]+)"/g)].map((m) => [m[1] ?? m[2], m[3]]),
    );
    expect(names.map((n) => engineName[n])).toEqual(CATEGORY_PRECEDENCE.filter((c) => c !== "unknown"));
    expect(CATEGORY_PRECEDENCE.at(-1)).toBe("unknown");
  });
});
