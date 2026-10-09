// SPDX-License-Identifier: GPL-3.0-only
/**
 * The list of functional cookie names, and the one question asked of it: is this name on
 * it?
 *
 * The list is compiled at a release from the Open Cookie Database and this project's
 * overlay (functional-overlay.ts, scripts/compile-functional-cookies.mjs). Nothing here
 * fetches anything: the compiled file is imported at build time, like the classification
 * list.
 *
 * MATCHING IS BY NAME ALONE, case-sensitive, exact or by prefix as the entry says. No
 * domain condition, because the same load balancer's cookie appears on any vendor's host,
 * and no test of the value or the attributes, because values are never read. A provider
 * suffixes some names (`akaalb_<name>`, `BIGipServer<pool>`, `incap_ses_<id>`), which is
 * what a prefix entry is for.
 *
 * A MATCH CHANGES NO COUNT. It is a label on a cookie that is still counted: a name is a
 * string any vendor can reuse, and a list that removed cookies from the count by name
 * would let a tracker named AWSALB vanish from it.
 */

export interface FunctionalCookieEntry {
  readonly name: string;
  readonly match: "exact" | "prefix";
  /** The provider whose cookie the name is listed as. */
  readonly provider: string;
  /** The database's category for the entry. Absent on a name this project added. */
  readonly category?: string;
  /** The database's entry, by its id there, or the provider's own page for an addition. */
  readonly source: { readonly kind: "ocd"; readonly id: string } | { readonly kind: "provider"; readonly url: string };
}

export interface FunctionalCookieSource {
  readonly name: string;
  readonly repository: string;
  readonly file: string;
  readonly commit: string;
  readonly sha256: string;
  readonly license: string;
  /** The license notice for the source, carried inside the data it covers. */
  readonly notice: string;
}

export interface FunctionalCookieList {
  /** The date the list last changed. */
  readonly version: string;
  /** That this is a filtered and corrected derivative, and of what. */
  readonly modified: string;
  readonly sources: readonly FunctionalCookieSource[];
  readonly entries: readonly FunctionalCookieEntry[];
}

/** What a bundle records of the list that produced a label. */
export interface FunctionalListProvenance {
  readonly source: string;
  readonly version: string;
  readonly commit: string;
  readonly hash: string;
}

/** Validate the shape of a parsed compiled list before trusting it. */
export function loadFunctionalCookieList(raw: unknown): FunctionalCookieList {
  if (typeof raw !== "object" || raw === null) throw new Error("functional cookie list: not an object");
  const o = raw as Record<string, unknown>;
  if (typeof o["version"] !== "string") throw new Error("functional cookie list: missing version");
  if (typeof o["modified"] !== "string") throw new Error("functional cookie list: missing the statement that it was modified");
  if (!Array.isArray(o["sources"]) || o["sources"].length === 0) throw new Error("functional cookie list: missing sources");
  if (!Array.isArray(o["entries"])) throw new Error("functional cookie list: missing entries");
  for (const e of o["entries"] as unknown[]) {
    const entry = e as Record<string, unknown>;
    if (typeof entry["name"] !== "string" || entry["name"] === "") throw new Error("functional cookie list: an entry with no name");
    if (entry["match"] !== "exact" && entry["match"] !== "prefix") throw new Error(`functional cookie list: ${entry["name"]}: match is neither exact nor prefix`);
    // The database's descriptions are not shipped: many are copied from sites' own cookie
    // notices, which its license cannot relicense.
    if ("description" in entry) throw new Error(`functional cookie list: ${entry["name"]}: carries a description`);
  }
  return raw as FunctionalCookieList;
}

export class FunctionalCookies {
  readonly #exact: Map<string, FunctionalCookieEntry>;
  /** Longest first, so the most specific prefix is the one that answers. */
  readonly #prefixes: readonly FunctionalCookieEntry[];
  readonly #provenance: FunctionalListProvenance;

  constructor(list: FunctionalCookieList) {
    this.#exact = new Map();
    const prefixes: FunctionalCookieEntry[] = [];
    for (const entry of list.entries) {
      if (entry.match === "exact") this.#exact.set(entry.name, entry);
      else prefixes.push(entry);
    }
    this.#prefixes = prefixes.sort((a, b) => b.name.length - a.name.length || (a.name < b.name ? -1 : 1));
    const primary = list.sources[0];
    this.#provenance = {
      source: primary?.name ?? "unknown",
      version: list.version,
      commit: primary?.commit ?? "unknown",
      hash: primary?.sha256 ?? "unknown",
    };
  }

  /** The entry a cookie name matches, or null. By name alone, case-sensitive. */
  entryFor(name: string): FunctionalCookieEntry | null {
    const exact = this.#exact.get(name);
    if (exact !== undefined) return exact;
    for (const entry of this.#prefixes) if (name.startsWith(entry.name)) return entry;
    return null;
  }

  /** Whether a cookie name is listed. */
  lists(name: string): boolean {
    return this.entryFor(name) !== null;
  }

  /** Which list produced the labels, for the evidence bundle. */
  get provenance(): FunctionalListProvenance {
    return this.#provenance;
  }
}

/** Build the matcher from a parsed compiled list. */
export function loadFunctionalCookies(raw: unknown): FunctionalCookies {
  return new FunctionalCookies(loadFunctionalCookieList(raw));
}
