// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { FunctionalCookies, loadFunctionalCookies, loadFunctionalCookieList } from "../src/functional-cookies.js";
import type { FunctionalCookieList } from "../src/functional-cookies.js";
import * as overlay from "../src/functional-overlay.js";
// The compile's own parts, so the file that ships is held to the code that writes it.
// @ts-expect-error a build script, with no types of its own
import { parseCsv, compileEntries, candidates } from "../scripts/compile-functional-cookies.mjs";

const compiled = JSON.parse(
  await readFile(new URL("../data/likely-functional-cookies.json", import.meta.url), "utf8"),
) as FunctionalCookieList;

const list = (entries: FunctionalCookieList["entries"]): FunctionalCookieList => ({
  version: "2026-09-27",
  modified: "test",
  sources: [{ name: "open-cookie-database", repository: "r", file: "f", commit: "c0ffee", sha256: "abc", license: "Apache-2.0", notice: "n" }],
  entries,
});
const ocd = (name: string, match: "exact" | "prefix" = "exact") =>
  ({ name, match, provider: "P", category: "Functional", source: { kind: "ocd" as const, id: name } });

describe("matching a cookie name", () => {
  const cookies = new FunctionalCookies(list([ocd("AWSALB"), ocd("__cf_bm"), ocd("akaalb_", "prefix"), ocd("incap_ses_", "prefix"), ocd("incap_", "prefix")]));

  it("matches a name exactly", () => {
    expect(cookies.entryFor("AWSALB")?.name).toBe("AWSALB");
    expect(cookies.lists("__cf_bm")).toBe(true);
  });

  it("does not match a longer name on an exact entry", () => {
    // AWSALBCORS is its own entry in the database. An exact entry is not a prefix.
    expect(cookies.lists("AWSALBCORS")).toBe(false);
    expect(cookies.lists("AWSALB2")).toBe(false);
  });

  it("matches what a provider suffixes on a prefix entry", () => {
    expect(cookies.entryFor("akaalb_Instance-1")?.name).toBe("akaalb_");
    expect(cookies.lists("akaalb_")).toBe(true);
  });

  it("answers with the longest prefix", () => {
    expect(cookies.entryFor("incap_ses_1234_5678")?.name).toBe("incap_ses_");
    expect(cookies.entryFor("incap_other")?.name).toBe("incap_");
  });

  it("is case-sensitive", () => {
    // The database lists DataDome's cookie as "Datadome". The cookie is "datadome".
    expect(cookies.lists("awsalb")).toBe(false);
    expect(cookies.lists("AKAALB_Instance-1")).toBe(false);
  });

  it("matches nothing else, and nothing on an empty name", () => {
    expect(cookies.lists("IDE")).toBe(false);
    expect(cookies.lists("")).toBe(false);
    expect(cookies.entryFor("_ga")).toBeNull();
  });

  it("says which list it is, for the evidence bundle", () => {
    expect(cookies.provenance).toEqual({ source: "open-cookie-database", version: "2026-09-27", commit: "c0ffee", hash: "abc" });
  });
});

describe("loading a compiled list", () => {
  it("refuses one that does not say it was modified, or has no source", () => {
    expect(() => loadFunctionalCookieList({ version: "v", sources: [{}], entries: [] })).toThrow(/modified/);
    expect(() => loadFunctionalCookieList({ version: "v", modified: "m", sources: [], entries: [] })).toThrow(/sources/);
    expect(() => loadFunctionalCookieList(null)).toThrow();
  });

  it("refuses an entry that carries a description", () => {
    // Many of the database's are copied from sites' own cookie notices, which its license
    // cannot relicense. The popup quotes none of them, and the file ships none.
    const withText = { ...list([]), entries: [{ ...ocd("AWSALB"), description: "cannot identify you as an individual" }] };
    expect(() => loadFunctionalCookieList(withText)).toThrow(/description/);
  });

  it("refuses an entry with no name, or no way to match", () => {
    expect(() => loadFunctionalCookieList({ ...list([]), entries: [{ name: "", match: "exact" }] })).toThrow(/no name/);
    expect(() => loadFunctionalCookieList({ ...list([]), entries: [{ name: "x", match: "regex" }] })).toThrow(/match/);
  });
});

describe("the compile", () => {
  const CSV = [
    "ID,Platform,Category,Cookie / Data Key name,Domain,Description,Retention period,Data Controller,User Privacy & GDPR Rights Portals,Wildcard match",
    '1,Cloudflare,Functional,__cf_bm,,"Bot management, with a comma and a ""quote""",30 minutes,Cloudflare,,0',
    '2,Imperva,Functional,incap_ses_,,"Session,\nover two lines",session,Imperva,,1',
    "3,Amazon Web Services,Functional,AWSALB,,Load balancer,7 days,AWS,,0",
    "4,Amazon Web Services,Functional,aws-userInfo,,Console sign-in,session,AWS,,0",
    "5,HAproxy,Functional,SERVERID,,Load balancer,session,HAProxy,,0",
    "6,Datadome,Functional,Datadome,,Bot protection,1 year,DataDome,,0",
    "7,DoubleClick,Functional,test_cookie,,Checks whether cookies can be set,15 minutes,Google,,0",
    "8,Cloudflare,Marketing,cf_marketing,,Not infrastructure,1 year,Cloudflare,,0",
    "9,Google,Functional,GCLB,,Google Cloud load balancer stickiness,session,Google,,0",
  ].join("\n");
  const rows = parseCsv(CSV) as Record<string, string>[];
  const result = compileEntries(rows, overlay) as { entries: FunctionalCookieList["entries"]; unmatchedExclusions: string[]; nowUpstream: string[] };
  const names = result.entries.map((e) => e.name);

  it("reads quoted fields, doubled quotes and line breaks inside them", () => {
    expect(rows).toHaveLength(9);
    expect(rows[0]?.["Description"]).toBe('Bot management, with a comma and a "quote"');
    expect(rows[1]?.["Description"]).toBe("Session,\nover two lines");
    expect(rows[1]?.["Wildcard match"]).toBe("1");
  });

  it("takes a provider's entries, by the database's flag for a prefix", () => {
    expect(result.entries.find((e) => e.name === "__cf_bm")).toEqual({
      name: "__cf_bm", match: "exact", provider: "Cloudflare", category: "Functional", source: { kind: "ocd", id: "1" },
    });
    expect(result.entries.find((e) => e.name === "incap_ses_")?.match).toBe("prefix");
  });

  it("takes only the named subset of a provider that mixes products", () => {
    expect(names).toContain("AWSALB");
    expect(names).not.toContain("aws-userInfo");
  });

  it("leaves out an advertising platform's Functional entry, and a provider's Marketing one", () => {
    // Taking the database's Functional category whole would label DoubleClick's
    // test_cookie as infrastructure, on the platform's own description.
    expect(names).not.toContain("test_cookie");
    expect(names).not.toContain("cf_marketing");
  });

  it("drops what the overlay excludes, and adds what it adds with the provider's page", () => {
    expect(names).not.toContain("SERVERID");
    expect(names).not.toContain("Datadome");
    expect(result.unmatchedExclusions).toEqual([]);
    expect(result.entries.find((e) => e.name === "datadome")).toEqual({
      name: "datadome", match: "exact", provider: "DataDome", source: { kind: "provider", url: "https://docs.datadome.co/docs/cookie-session-storage" },
    });
  });

  it("carries no description, whatever the database says", () => {
    for (const e of result.entries) expect(Object.keys(e).sort()).toEqual(e.source.kind === "ocd" ? ["category", "match", "name", "provider", "source"] : ["match", "name", "provider", "source"]);
  });

  it("says when the database has a name the overlay adds, and takes the database's entry", () => {
    const upstream = parseCsv(`${CSV}\n10,Akamai,Functional,akaalb_,,Load balancer,session,Akamai,,1`) as Record<string, string>[];
    const r = compileEntries(upstream, overlay) as typeof result;
    expect(r.nowUpstream).toEqual(["akaalb_"]);
    expect(r.entries.find((e) => e.name === "akaalb_")?.source).toEqual({ kind: "ocd", id: "10" });
  });

  it("says when an exclusion matched nothing", () => {
    const without = rows.filter((r) => r["Cookie / Data Key name"] !== "SERVERID");
    expect((compileEntries(without, overlay) as typeof result).unmatchedExclusions).toEqual(["SERVERID"]);
  });

  it("offers entries outside the filter that read like infrastructure, for a person to decide", () => {
    expect(candidates(rows, overlay)).toEqual(["Google: GCLB"]);
  });
});

describe("the list that ships", () => {
  const cookies = loadFunctionalCookies(compiled);

  it("loads, says it was modified, and names its source, commit and license", () => {
    expect(compiled.modified).toBe(overlay.MODIFIED);
    expect(compiled.modified).toMatch(/Not the database as published/);
    expect(compiled.sources).toHaveLength(1);
    expect(compiled.sources[0]).toMatchObject({
      name: "open-cookie-database",
      repository: overlay.DATABASE.repository,
      commit: overlay.DATABASE.commit,
      license: "Apache-2.0",
    });
    expect(compiled.sources[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(compiled.sources[0]?.notice).toContain("Apache License, Version 2.0");
  });

  it("is what the overlay yields at the commit it records: 36 from the database and the 7 added", () => {
    const added = compiled.entries.filter((e) => e.source.kind === "provider");
    expect(compiled.entries).toHaveLength(43);
    expect(added.map((e) => e.name).sort()).toEqual(overlay.ADDED.map((a) => a.name).sort());
    expect(compiled.entries.map((e) => e.name)).toEqual([...compiled.entries.map((e) => e.name)].sort());
    expect(new Set(compiled.entries.map((e) => e.name)).size).toBe(43);
  });

  it("has every name the overlay takes by name, and none it excludes", () => {
    const names = new Set(compiled.entries.map((e) => e.name));
    for (const rule of overlay.TAKEN) for (const n of rule.names ?? []) expect(names.has(n), n).toBe(true);
    for (const x of overlay.EXCLUDED) expect(names.has(x.name), x.name).toBe(false);
  });

  it("gives every addition a provider's page, read on a date", () => {
    for (const a of overlay.ADDED) {
      expect(a.url, a.name).toMatch(/^https:\/\//);
      expect(a.checked, a.name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("carries no description", () => {
    expect(JSON.stringify(compiled)).not.toMatch(/"description"/i);
  });

  it("labels the infrastructure cookies a corpus run counted, and not SERVERID", () => {
    // Each was counted on a vendor's host on the 2026-09-25 corpus run: retailer-a.example and
    // delivery-b.example, automaker-a.example, retailer-k.example, news-f.example, automaker-e.example, health-c.example,
    // retailer-m.example, automaker-f.example.
    for (const name of [
      "akaalb_Instance-1", "AWSALBTG", "AWSALBTGCORS", "INGRESSCOOKIE", "AWSALB", "AWSALBCORS",
      "ARRAffinity", "ARRAffinitySameSite", "__cf_bm", "aws-waf-token",
    ]) {
      expect(cookies.lists(name), name).toBe(true);
    }
    expect(cookies.lists("SERVERID")).toBe(false);
  });

  it("labels no cookie of an advertising or analytics platform", () => {
    for (const name of ["IDE", "test_cookie", "ANID", "__eoi", "_ga", "_gid", "MUID", "_fbp", "uid", "cto_bundle", "TDID", "at_check"]) {
      expect(cookies.lists(name), name).toBe(false);
    }
  });
});
