// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { CATEGORIES } from "@gpc-inspector/engine";
import type { TagManagerKind } from "@gpc-inspector/schema";
import { OwnerCookies, loadOwnerCookies, loadOwnerCookieList } from "../src/owner-cookies.js";
import type { OwnerCookieList } from "../src/owner-cookies.js";
import { loadDefaultClassifier } from "../src/load.js";
import * as overlay from "../src/owner-overlay.js";
import * as functionalOverlay from "../src/functional-overlay.js";
// The compile's own parts, so the file that ships is held to the code that writes it.
// @ts-expect-error a build script, with no types of its own
import { compileOwnerEntries, ownersOf } from "../scripts/compile-owner-cookies.mjs";

const read = async (file: string): Promise<unknown> => JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
const compiled = (await read("../data/container-owner-cookies.json")) as OwnerCookieList;
const functional = (await read("../data/likely-functional-cookies.json")) as { version: string; entries: { name: string }[]; sources: { commit: string }[] };
const owners = loadOwnerCookies(compiled);

const MANAGERS: readonly TagManagerKind[] = [
  "gtm", "gtag", "google", "tealium", "adobe-launch", "segment", "matomo", "piwik-pro", "ensighten", "commanders-act",
];

describe("the compiled list of container owners' names", () => {
  it("loads, and every entry has a source and a category the engine knows", () => {
    expect(() => loadOwnerCookieList(compiled)).not.toThrow();
    for (const e of compiled.entries) {
      expect(CATEGORIES as readonly string[]).toContain(e.category);
      if (e.source.kind === "ocd") expect(e.source.id).toMatch(/^[0-9a-f-]{36}$/);
      else expect(e.source.url).toMatch(/^https:\/\//);
    }
  });

  it("names an owner for every manager, and every owner has names", () => {
    for (const m of MANAGERS) expect(owners.ownerOf(m)).not.toBeNull();
    for (const owner of new Set(Object.values(compiled.owners))) {
      expect(compiled.entries.some((e) => e.owner === owner)).toBe(true);
    }
  });

  it("names Google for the Google managers and Adobe for Launch", () => {
    expect(owners.ownerOf("gtm")).toBe("Google");
    expect(owners.ownerOf("gtag")).toBe("Google");
    expect(owners.ownerOf("google")).toBe("Google");
    expect(owners.ownerOf("adobe-launch")).toBe("Adobe");
  });

  it("names, for every other manager, the company the classification list names for its host", async () => {
    // The list is the source of these owners, and the overlay has to keep up with it.
    const classifier = loadDefaultClassifier(await read("../data/compiled-list.json"));
    for (const [manager, rule] of Object.entries(overlay.OWNERS)) {
      if (rule.loaderHost === undefined) continue;
      const cls = classifier.classify(`https://${rule.loaderHost}/`, "example.com");
      expect([manager, cls.entity?.name]).toEqual([manager, rule.owner]);
    }
  });

  it("matches the names the owners' libraries write, and `_ga_` and `utag_main_` by prefix", () => {
    expect(owners.entryFor("gtag", "_ga")).toMatchObject({ owner: "Google", category: "analytics", match: "exact" });
    expect(owners.entryFor("gtag", "_ga_XNWF200000")).toMatchObject({ name: "_ga_", owner: "Google", category: "analytics", match: "prefix" });
    expect(owners.entryFor("gtm", "_gcl_au")).toMatchObject({ owner: "Google", category: "advertising" });
    expect(owners.entryFor("tealium", "utag_main")).toMatchObject({ owner: "Tealium", category: "analytics", match: "exact" });
    expect(owners.entryFor("tealium", "utag_main_ses_id")).toMatchObject({ name: "utag_main_", owner: "Tealium", match: "prefix" });
    expect(owners.entryFor("adobe-launch", "s_cc")).toMatchObject({ owner: "Adobe", category: "analytics" });
    expect(owners.entryFor("adobe-launch", "AMCV_3C3B1234%40AdobeOrg")).toMatchObject({ name: "AMCV_", owner: "Adobe", category: "advertising" });
    expect(owners.entryFor("adobe-launch", "mboxEdgeCluster")).toMatchObject({ owner: "Adobe", category: "advertising", source: { kind: "provider" } });
  });

  it("answers a name only for its own owner's managers", () => {
    // AMCV_ is Adobe's, and written inside a Tealium container it is nobody's.
    expect(owners.entryFor("tealium", "AMCV_3C3B1234%40AdobeOrg")).toBeNull();
    expect(owners.entryFor("gtm", "utag_main")).toBeNull();
    expect(owners.entryFor("tealium", "_fbp")).toBeNull();
    expect(owners.entryFor("gtm", "nwf_byline")).toBeNull();
    // A google.com sign-in cookie is not taken, though the database files it under Google.
    expect(owners.entryFor("gtm", "SID")).toBeNull();
    expect(owners.entryFor("gtm", "NID")).toBeNull();
  });

  it("takes `s_vi` exactly, so an Adobe plugin's `s_visit` is not the visitor id", () => {
    expect(owners.entryFor("adobe-launch", "s_vi")).toMatchObject({ match: "exact" });
    expect(owners.entryFor("adobe-launch", "s_visit")).toBeNull();
  });

  it("tells Matomo's and Piwik PRO's `_pk_` names apart by owner", () => {
    expect(owners.entryFor("matomo", "_pk_id.1.abcd")).toMatchObject({ name: "_pk_id", owner: "InnoCraft" });
    expect(owners.entryFor("piwik-pro", "_pk_id.1.abcd")).toMatchObject({ name: "_pk_id.", owner: "CookieInformation" });
  });

  it("gives a name in a database category that does not count the category `unknown`", () => {
    expect(owners.entryFor("adobe-launch", "at_check")).toMatchObject({ owner: "Adobe", category: "unknown" });
    expect(owners.entryFor("ensighten", "_cq_duid")).toMatchObject({ owner: "CHEQ", category: "unknown" });
  });

  it("takes Tealium's and Segment's names from their own pages, which the database lacks", () => {
    for (const name of ["utag_main", "utag_main_", "ajs_anonymous_id", "ajs_user_id", "ajs_group_id"]) {
      const e = compiled.entries.find((x) => x.name === name);
      expect(e?.source.kind).toBe("provider");
    }
  });

  it("is compiled from the database at the commit the functional list pins", () => {
    expect(compiled.sources[0]?.commit).toBe(functionalOverlay.DATABASE.commit);
    expect(compiled.sources[0]?.commit).toBe(functional.sources[0]?.commit);
    expect(owners.provenance).toMatchObject({ source: "open-cookie-database", commit: functionalOverlay.DATABASE.commit });
  });

  it("ships no description", () => {
    for (const e of compiled.entries) expect(e).not.toHaveProperty("description");
    expect(() => loadOwnerCookieList({ ...compiled, entries: [{ ...compiled.entries[0], description: "x" }] })).toThrow(/description/);
  });

  it("leaves the functional list as it was", () => {
    // A second list, not a change to the first: the functional list keeps its version, and
    // shares no name with this one.
    expect(functional.version).toBe("2026-09-27");
    const names = new Set(functional.entries.map((e) => e.name));
    expect(compiled.entries.filter((e) => names.has(e.name))).toEqual([]);
  });

  it("is what the compile produces from the overlay", () => {
    const rows = compiled.entries
      .filter((e) => e.source.kind === "ocd")
      .map((e) => ({
        ID: (e.source as { id: string }).id,
        Platform: overlay.TAKEN.find((t) => t.owner === e.owner && t.names.includes(e.name))?.platform ?? "",
        Category: e.category === "analytics" ? "Analytics" : e.category === "advertising" ? "Marketing" : "Functional",
        "Cookie / Data Key name": e.name,
        // The database's flag: `s_vi` is a prefix there, taken as exact by the overlay.
        "Wildcard match": e.match === "prefix" || e.name === "s_vi" ? "1" : "0",
      }));
    const out = compileOwnerEntries(rows, overlay) as { entries: unknown[]; missing: string[] };
    expect(out.missing).toEqual([]);
    expect(out.entries).toEqual(compiled.entries);
    expect(ownersOf(overlay)).toEqual(compiled.owners);
  });
});

describe("matching, on a hand-built list", () => {
  const list: OwnerCookieList = {
    version: "2026-09-28",
    modified: "test",
    sources: [{ name: "open-cookie-database", repository: "r", file: "f", commit: "c0ffee", sha256: "abc", license: "Apache-2.0", notice: "n" }],
    owners: { gtm: "Google", tealium: "Tealium" },
    entries: [
      { name: "_ga", match: "exact", owner: "Google", category: "analytics", source: { kind: "ocd", id: "a" } },
      { name: "_ga_", match: "prefix", owner: "Google", category: "analytics", source: { kind: "ocd", id: "b" } },
      { name: "_g", match: "prefix", owner: "Google", category: "advertising", source: { kind: "ocd", id: "c" } },
    ],
  };
  const m = new OwnerCookies(list);

  it("prefers the exact entry, then the longest prefix, case-sensitive", () => {
    expect(m.entryFor("gtm", "_ga")?.source).toEqual({ kind: "ocd", id: "a" });
    expect(m.entryFor("gtm", "_ga_XYZ")?.name).toBe("_ga_");
    expect(m.entryFor("gtm", "_gx")?.name).toBe("_g");
    expect(m.entryFor("gtm", "_GA")).toBeNull();
  });

  it("answers nothing for a manager with no owner, or an owner with no names", () => {
    expect(m.ownerOf("segment")).toBeNull();
    expect(m.entryFor("segment", "_ga")).toBeNull();
    expect(m.entryFor("tealium", "_ga")).toBeNull();
  });

  it("refuses an entry whose owner owns no manager", () => {
    expect(() => loadOwnerCookieList({ ...list, entries: [{ ...list.entries[0]!, owner: "Adobe" }] })).toThrow(/owns no manager/);
  });
});
