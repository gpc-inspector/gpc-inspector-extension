// SPDX-License-Identifier: GPL-3.0-only
/**
 * The classification interface the engine depends on (PRD FR-17, D3).
 *
 * The engine does NOT bundle a domain list. It takes a Classifier as input. This is the
 * pluggable boundary: the real implementation lives in @gpc-inspector/lists (Disconnect
 * data + PSL + local overrides), a fake one lives in the fixtures, and swapping the data
 * source never touches engine code. It is also what keeps the engine a pure function —
 * no list file to read from disk, no network to fetch it.
 *
 * A Classifier answers two questions about a URL, both mechanical:
 *   - party: is this request first- or third-party relative to the TOP document?
 *   - entity + category: who owns the domain, and what kind of thing is it?
 */

/** First- vs third-party relative to the top-level document (via PSL eTLD+1). */
export type Party = "first" | "third";

/**
 * A domain's category, one per purpose category in Disconnect's services.json and named
 * after it: Disconnect's name in lower case, words joined by hyphens (EmailAggressive is
 * "email-aggressive", Anti-fraud is "anti-fraud"). "unknown" is the one addition, for a
 * domain Disconnect gives no category, including one it names an owner for and nothing
 * else.
 *
 * Disconnect's technique categories (FingerprintingInvasive, FingerprintingGeneral,
 * Cryptomining) have no category here. They say how a domain behaves, not whom the data is
 * for, and a domain listed only under one is "unknown" with the company Disconnect names.
 *
 * One for one on purpose. The popup labels a request with its category and credits the
 * category to Disconnect, so a category that merges or renames Disconnect's would put
 * words in Disconnect's mouth. A different list plugs in by mapping onto these names, or
 * onto "unknown".
 *
 * "advertising" and "analytics" are the only categories that can drive a cookie finding or
 * a count (PRD FR-9, 5.1). That line is this product's, not Disconnect's. Every other
 * category is context: a company in one is listed, and whether its script read GPC is
 * reported, and none of its cookies is counted. "unknown" drives no cookie finding and no
 * count (FR-18); a company Disconnect names as an owner and gives no category is listed and
 * judged like a company in any other category that does not count, and a domain with no
 * company drives nothing.
 */
export const CATEGORIES = [
  "advertising",
  "analytics",
  "social",
  "content",
  "email",
  "email-aggressive",
  "consent-managers",
  "anti-fraud",
  "unknown",
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * The order categories are listed in, and the order that decides a domain's category when
 * Disconnect gives it several: advertising first, "unknown" last. The list compiler has the same order under Disconnect's names
 * (`CATEGORY_PRECEDENCE` in its compile script), and a test in the lists package holds the
 * two together.
 */
export const CATEGORY_PRECEDENCE: readonly Category[] = [
  "advertising",
  "analytics",
  "social",
  "email",
  "email-aggressive",
  "consent-managers",
  "anti-fraud",
  "content",
  "unknown",
];

/** The categories whose cookies and requests are counted. The product's line, drawn once. */
export const COUNTING_CATEGORIES: ReadonlySet<string> = new Set<Category>(["advertising", "analytics"]);

/** Where a category sorts, by `CATEGORY_PRECEDENCE`; one the engine does not know sorts last. */
export function categoryRank(category: string): number {
  const i = (CATEGORY_PRECEDENCE as readonly string[]).indexOf(category);
  return i === -1 ? CATEGORY_PRECEDENCE.length : i;
}

/** The entity a domain rolls up to, with the display name and the domains it owns. */
export interface Entity {
  /** Display name, e.g. "Google". */
  readonly name: string;
  /**
   * A stable id for grouping (e.g. "google"). Distinct from `name` so display can
   * change without breaking grouping. Often name.toLowerCase() but not required.
   */
  readonly id: string;
}

/** What the classifier knows about one URL. */
export interface Classification {
  readonly party: Party;
  readonly category: Category;
  /** null when the domain is unclassified (unknown owner). Drives nothing (FR-18). */
  readonly entity: Entity | null;
  /** The eTLD+1 the classifier resolved for this URL (for display/debug). */
  readonly registrableDomain: string;
}

/**
 * The classifier. Pure: same URL + same top site → same classification. The engine
 * calls this and nothing else for domain questions.
 */
export interface Classifier {
  /**
   * @param url        the request URL being classified
   * @param topSite    the eTLD+1 of the top-level document (for party determination)
   */
  classify(url: string, topSite: string): Classification;
}
