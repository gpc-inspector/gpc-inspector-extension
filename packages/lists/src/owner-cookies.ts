// SPDX-License-Identifier: GPL-3.0-only
/**
 * The list of container owners' cookie names, and the one question asked of it: is this
 * name, written inside this manager's container, the container owner's own?
 *
 * The list is compiled at a release from the Open Cookie Database and this project's
 * overlay (owner-overlay.ts, scripts/compile-owner-cookies.mjs), like the functional list.
 * Nothing here fetches anything: the compiled file is imported at build time.
 *
 * MATCHING IS BY NAME ALONE, among the entries of the manager's owner, case-sensitive,
 * exact first and then the longest prefix, as FunctionalCookies matches. The caller asks
 * only about a cookie whose writer resolved to that manager's container: a match here
 * charges the cookie to the owner, and no match leaves it charged to no one. A name is
 * never used to charge a cookie written anywhere else.
 */

import type { TagManagerKind } from "@gpc-inspector/schema";
import type { FunctionalCookieSource, FunctionalListProvenance } from "./functional-cookies.js";

export interface OwnerCookieEntry {
  readonly name: string;
  readonly match: "exact" | "prefix";
  /** The company whose own name this is, as the classification list spells it. */
  readonly owner: string;
  /** In the engine's names. Only advertising and analytics count. */
  readonly category: "advertising" | "analytics" | "unknown";
  /** The database's entry, by its id there, or the provider's own page for an addition. */
  readonly source: { readonly kind: "ocd"; readonly id: string } | { readonly kind: "provider"; readonly url: string };
}

export interface OwnerCookieList {
  /** The date the list last changed. */
  readonly version: string;
  /** That this is a filtered and corrected derivative, and of what. */
  readonly modified: string;
  readonly sources: readonly FunctionalCookieSource[];
  /** The owner of each manager. */
  readonly owners: Readonly<Record<string, string>>;
  readonly entries: readonly OwnerCookieEntry[];
}

/** What a bundle records of the list that produced the charges. The functional list's shape. */
export type OwnerListProvenance = FunctionalListProvenance;

const CATEGORIES: ReadonlySet<string> = new Set(["advertising", "analytics", "unknown"]);

/** Validate the shape of a parsed compiled list before trusting it. */
export function loadOwnerCookieList(raw: unknown): OwnerCookieList {
  if (typeof raw !== "object" || raw === null) throw new Error("owner cookie list: not an object");
  const o = raw as Record<string, unknown>;
  if (typeof o["version"] !== "string") throw new Error("owner cookie list: missing version");
  if (typeof o["modified"] !== "string") throw new Error("owner cookie list: missing the statement that it was modified");
  if (!Array.isArray(o["sources"]) || o["sources"].length === 0) throw new Error("owner cookie list: missing sources");
  if (typeof o["owners"] !== "object" || o["owners"] === null) throw new Error("owner cookie list: missing owners");
  if (!Array.isArray(o["entries"])) throw new Error("owner cookie list: missing entries");
  const owners = new Set(Object.values(o["owners"] as Record<string, unknown>));
  for (const e of o["entries"] as unknown[]) {
    const entry = e as Record<string, unknown>;
    const name = entry["name"];
    if (typeof name !== "string" || name === "") throw new Error("owner cookie list: an entry with no name");
    if (entry["match"] !== "exact" && entry["match"] !== "prefix") throw new Error(`owner cookie list: ${name}: match is neither exact nor prefix`);
    if (!owners.has(entry["owner"])) throw new Error(`owner cookie list: ${name}: its owner owns no manager`);
    if (typeof entry["category"] !== "string" || !CATEGORIES.has(entry["category"])) throw new Error(`owner cookie list: ${name}: a category the engine does not know`);
    if (typeof entry["source"] !== "object" || entry["source"] === null) throw new Error(`owner cookie list: ${name}: no source`);
    // The database's descriptions are not shipped, for the reason the functional list gives.
    if ("description" in entry) throw new Error(`owner cookie list: ${name}: carries a description`);
  }
  return raw as OwnerCookieList;
}

interface OwnerIndex {
  readonly exact: Map<string, OwnerCookieEntry>;
  /** Longest first, so the most specific prefix is the one that answers. */
  readonly prefixes: readonly OwnerCookieEntry[];
}

export class OwnerCookies {
  readonly #owners: ReadonlyMap<string, string>;
  readonly #byOwner: ReadonlyMap<string, OwnerIndex>;
  readonly #provenance: OwnerListProvenance;

  constructor(list: OwnerCookieList) {
    this.#owners = new Map(Object.entries(list.owners));
    const byOwner = new Map<string, { exact: Map<string, OwnerCookieEntry>; prefixes: OwnerCookieEntry[] }>();
    for (const entry of list.entries) {
      const index = byOwner.get(entry.owner) ?? { exact: new Map<string, OwnerCookieEntry>(), prefixes: [] as OwnerCookieEntry[] };
      if (entry.match === "exact") index.exact.set(entry.name, entry);
      else index.prefixes.push(entry);
      byOwner.set(entry.owner, index);
    }
    for (const index of byOwner.values()) {
      index.prefixes.sort((a, b) => b.name.length - a.name.length || (a.name < b.name ? -1 : 1));
    }
    this.#byOwner = byOwner;
    const primary = list.sources[0];
    this.#provenance = {
      source: primary?.name ?? "unknown",
      version: list.version,
      commit: primary?.commit ?? "unknown",
      hash: primary?.sha256 ?? "unknown",
    };
  }

  /** The company that owns a manager, or null for a manager with no owner. */
  ownerOf(manager: TagManagerKind): string | null {
    return this.#owners.get(manager) ?? null;
  }

  /** The owner's entry for a name written inside the manager's container, or null. */
  entryFor(manager: TagManagerKind, name: string): OwnerCookieEntry | null {
    const owner = this.ownerOf(manager);
    const index = owner === null ? undefined : this.#byOwner.get(owner);
    if (index === undefined) return null;
    const exact = index.exact.get(name);
    if (exact !== undefined) return exact;
    for (const entry of index.prefixes) if (name.startsWith(entry.name)) return entry;
    return null;
  }

  /** Which list produced the charges, for the evidence bundle. */
  get provenance(): OwnerListProvenance {
    return this.#provenance;
  }
}

/** Build the matcher from a parsed compiled list. */
export function loadOwnerCookies(raw: unknown): OwnerCookies {
  return new OwnerCookies(loadOwnerCookieList(raw));
}
