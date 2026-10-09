// SPDX-License-Identifier: GPL-3.0-only
/**
 * DisconnectClassifier — implements the engine's Classifier interface (PRD FR-17, D3).
 *
 * Answers, for a request URL: first- or third-party (against the TOP document), what
 * category, and which entity owns it. Backed by the compiled Disconnect index plus a
 * local override layer.
 *
 * THE OVERRIDE LAYER (PRD FR-17) exists because Disconnect does not accept pull requests
 * — their repo states PRs are not reviewed and will be closed. So when a "Looks wrong"
 * report shows a misclassification, there is no upstream fix to send. Overrides are a
 * small delta file under our own license, applied on top of the upstream data at load,
 * and they are the mechanism by which corrections actually land.
 *
 * Lookup is longest-suffix-first: securepubads.g.doubleclick.net matches the entry for
 * doubleclick.net. A subdomain never resolves to something more general than its parent.
 */

import type {
  Classifier,
  Classification,
  Category,
  Party,
} from "@gpc-inspector/engine";
import { CATEGORIES } from "@gpc-inspector/engine";
import { registrableDomain, hostnameOf, domainSuffixes } from "./public-suffix.js";

/** The compiled index shape produced by scripts/compile-list.mjs. */
export interface CompiledList {
  readonly version: string;
  readonly sources: readonly {
    readonly name: string;
    readonly file: string;
    readonly sha256: string;
    readonly license: string;
    /**
     * The upstream file's own license notice, verbatim: copyright line, license name and
     * URLs, warranty disclaimer, exclusion of Disconnect's marks. Kept inside the data so
     * it ships wherever the data does (CC BY-NC-SA 4.0 §3(a)(1)(A)).
     */
    readonly notice: string;
  }[];
  /** entityId -> display name */
  readonly entities: Readonly<Record<string, string>>;
  /** domain -> [entityId, category] */
  readonly domains: Readonly<Record<string, readonly [string, string]>>;
}

/** A single local correction to upstream classification. */
export interface Override {
  /** Exact domain this applies to (matched with the same suffix logic as the list). */
  readonly domain: string;
  /** Corrected category, or omit to leave the upstream category alone. */
  readonly category?: Category;
  /** Corrected entity display name, or omit to leave upstream ownership alone. */
  readonly entityName?: string;
  /** Why — required, so the delta file is reviewable and each entry is defensible. */
  readonly reason: string;
}

/** The engine's categories, which are Disconnect's names. Anything else loads as unknown. */
const VALID_CATEGORIES: ReadonlySet<string> = new Set<Category>(CATEGORIES);

function toCategory(raw: string): Category {
  return VALID_CATEGORIES.has(raw) ? (raw as Category) : "unknown";
}

function entityIdFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Is this entity name too degenerate to show a user?
 *
 * Upstream data quality varies. Observed on retailer-m.example: Google's ad domains resolved to an
 * entity literally named "G.", which the popup dutifully rendered beside cookies named
 * GCL_AW_P and test_cookie. A one-or-two-character name identifies nothing, and the whole
 * point of the entity rollup is that a person recognizes who received their data.
 *
 * When the name is unusable we fall back to the registrable domain, which is always
 * meaningful and is a fact rather than a guess. The alternative — inventing "Google"
 * because the cookies look like Google's — would be exactly the kind of inference this
 * product refuses to make.
 */
function isDegenerateName(name: string): boolean {
  const stripped = name.replace(/[^A-Za-z0-9]/g, "");
  return stripped.length <= 2;
}

/** Provenance for the evidence bundle (PRD FR-23). */
export interface ListProvenance {
  readonly source: string;
  readonly version: string;
  readonly hash: string;
}

export class DisconnectClassifier implements Classifier {
  readonly #domains: Map<string, readonly [string, Category]>;
  readonly #entities: Map<string, string>;
  readonly #overrides: Map<string, Override>;
  readonly #provenance: ListProvenance;
  /** The last top site classified against and its registrable domain, resolved once. */
  #topSite = "";
  #topRegistrable = "";

  constructor(list: CompiledList, overrides: readonly Override[] = []) {
    this.#domains = new Map();
    for (const [domain, [entityId, category]] of Object.entries(list.domains)) {
      this.#domains.set(domain, [entityId, toCategory(category)]);
    }

    this.#entities = new Map(Object.entries(list.entities));

    this.#overrides = new Map();
    for (const o of overrides) {
      this.#overrides.set(o.domain.toLowerCase(), o);
    }

    // Hash identity of the upstream data, for the bundle's provenance block.
    const primary = list.sources[0];
    this.#provenance = {
      source: "disconnect",
      version: list.version,
      hash: primary?.sha256 ?? "unknown",
    };
  }

  /** Provenance to record in every evidence bundle (FR-23). */
  get provenance(): ListProvenance {
    return this.#provenance;
  }

  classify(url: string, topSite: string): Classification {
    const host = hostnameOf(url);

    // Unparseable URL: honest unknown, third-party by default (never first-party by
    // accident, which would suppress a finding).
    if (host === null) {
      return {
        party: "third",
        category: "unknown",
        entity: null,
        registrableDomain: "",
      };
    }

    const regDomain = registrableDomain(host);

    // Normalize the top site before comparing.
    //
    // The schema documents topSite as eTLD+1, but capture derives it from the navigation
    // URL's hostname, which includes the subdomain. Compared as given, "news-f.example"
    // never equals "www.news-f.example", so every request a site makes to itself would
    // classify as third-party, and then as unclassified, since the list carries no
    // first-party domains.
    //
    // Normalizing here rather than only at the call site keeps the comparison correct for
    // any caller, at the cost of one function call.
    if (topSite !== this.#topSite) {
      this.#topSite = topSite;
      this.#topRegistrable = registrableDomain(topSite);
    }
    const party: Party = regDomain === this.#topRegistrable ? "first" : "third";

    // Longest suffix first, so a subdomain resolves to its most specific known parent.
    for (const candidate of domainSuffixes(host)) {
      const override = this.#overrides.get(candidate);
      const upstream = this.#domains.get(candidate);

      if (!override && !upstream) continue;

      const upstreamEntityId = upstream?.[0];
      const upstreamCategory = upstream?.[1] ?? "unknown";

      const category = override?.category ?? upstreamCategory;

      let entityName: string | undefined;
      let entityId: string | undefined;
      if (override?.entityName) {
        entityName = override.entityName;
        entityId = entityIdFromName(override.entityName);
      } else if (upstreamEntityId) {
        entityId = upstreamEntityId;
        entityName = this.#entities.get(upstreamEntityId);
      }

      // A name we cannot show is worse than no name: fall back to the domain, which is
      // always meaningful and always a fact.
      if (entityName !== undefined && isDegenerateName(entityName)) {
        entityName = regDomain;
        entityId = entityIdFromName(regDomain);
      }

      return {
        party,
        category,
        entity: entityName && entityId ? { name: entityName, id: entityId } : null,
        registrableDomain: regDomain,
      };
    }

    // Not in the list: unclassified. Drives no finding and no count (FR-18).
    return { party, category: "unknown", entity: null, registrableDomain: regDomain };
  }
}
