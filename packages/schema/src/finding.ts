// SPDX-License-Identifier: GPL-3.0-only
/**
 * Finding — the engine's output unit (PRD FR-21, D4, Appendix B).
 *
 * A finding is a NAMED, MECHANICAL observation with the artifact that triggered it
 * attached. It is not a verdict. The wording rule is enforced structurally here:
 *
 *   - `flag` is a stable machine code (e.g. "cookie-set-with-signal"), never prose.
 *   - `artifact` points at the exact thing observed, so the finding is reproducible
 *     and a dispute is answered by re-running, not arguing (FR-21, edge cases).
 *   - There is NO `severity` and NO `verdict` field. Findings are ordered by how
 *     mechanically unambiguous they are (a Set-Cookie header outranks a text heuristic),
 *     which the engine computes as `rank`, not by a judgment of badness.
 *
 * User-facing strings are NOT stored on the finding. The UI renders copy from the flag
 * via _locales, which is what the wording lint (NFR-10) polices. Keeping prose out of
 * the engine is what lets the lint guarantee no verdict vocabulary ships.
 */

import type { PropertyValue, WireValue } from "./signal.js";
import type { ContainerIdentity } from "./tag-managers.js";

/**
 * Who loaded a vendor's script, resolved by the engine from `scriptInsertions`
 * (provenance, 1.12.0). A container names itself by id; another entity by its list name;
 * a host with no list entity by registrable domain; the site by the inserting file's URL,
 * or with no URL when the script was in the page's HTML or inserted by an inline snippet.
 */
export type LoaderIdentity =
  | {
      readonly kind: "container";
      readonly identity: ContainerIdentity;
      /** Ancestors in the container graph, nearest first (a zone's parent, its parent). */
      readonly ancestors: readonly ContainerIdentity[];
      /** True when the same entity was also loaded by a non-container loader. */
      readonly mixed: boolean;
    }
  | {
      readonly kind: "entity";
      readonly name: string;
      /**
       * The category of the loading script's domain, in the engine's names (1.20.0), so a
       * loader's own checks are the ones made from that category's domains: Google's
       * advertising script that loaded a vendor is not credited with a read by a Google
       * script from a Content domain. Absent in bundles recorded before 1.20.0.
       */
      readonly category?: string;
    }
  | { readonly kind: "host"; readonly domain: string }
  | { readonly kind: "site"; readonly url: string | null };

/**
 * By which route a loader's GPC check reached a vendor that made no check of its own.
 *
 *   loader        the loader itself checked (the container that inserted the script, or
 *                 the entity or site script that did)
 *   ancestor      a container above the loader in the container graph checked. This is
 *                 context on a "vendor-gpc-unread-via-container" finding, never a
 *                 "check-unattributable" one: a parent's read does not reach a child's
 *                 tags on its own, so the child is judged like any container and
 *                 `loader` names the parent that read
 *   consent-mode  a container the vendor was NOT loaded through checked and set Google
 *                 Consent Mode, which every container on the page shares
 *   page          provenance undetermined; the page-wide count, as before 1.12.0
 */
export type LoaderRoute = "loader" | "ancestor" | "consent-mode" | "page";

/**
 * Stable finding codes. Adding one is a rule-set change (bump ruleSetVersion). These
 * are the vocabulary of the engine's output; the UI maps each to facts-only copy.
 */
export type FindingFlag =
  // --- Signal integrity ---
  | "signal-sent" // Sec-GPC present on requests
  | "signal-property-absent" // navigator.globalPrivacyControl not readable by page
  | "signal-not-read" // no script read the property (readTracking active, readCount 0)
  | "property-tampered" // page redefined the property after we set it
  // --- What the site broadcast ---
  | "gpp-conflict" // Gpc=1 alongside SaleOptOut=2 / Sharing / TargetedAd (the flagship)
  | "gpp-unparseable"
  | "gpp-surfaces-disagree" // __gpp vs wire mismatch — same failure mode as USP, no cookie surface
  | "usp-surfaces-disagree" // __uspapi vs cookie vs wire mismatch
  // The page reported no string, and requests carried different ones (1.29.0). Not a
  // disagreement with the page, which said nothing: one among the requests themselves.
  | "usp-requests-disagree"
  | "gpp-requests-disagree"
  // --- The signal we sent vs what the site's string recorded ---
  //
  // Context, never an accusation. A consent tool can legitimately miss the signal: it may
  // load before the property exists, read it in a frame we cannot reach, or build its
  // string from a value stored on an earlier visit. What is reportable is that the two
  // disagree, which is a fact a reader acting on either one needs.
  | "gpc-sent-gpp-field-no" // we sent GPC; the site's string records its GPC field as 0
  | "gpc-not-sent-gpp-field-yes" // we sent nothing; the string records its GPC field as 1
  // --- What came back on the network ---
  | "cookie-set-with-signal" // ad/analytics domain returned Set-Cookie on a Sec-GPC:1 request
  | "cookie-set-on-redirect" // the above, specifically on a redirect hop
  // --- Who checked for GPC specifically ---
  // "gpc" is explicit in every name so a future reader never has to ask whether a USP or
  // TCF call would count. It never does: those are separate signals, decoded on
  // ObservationSet directly (see usPrivacy, tcf) rather than folded in here.
  | "vendor-read-gpc" // attributable __gpp call from this vendor, OR a direct property read
  | "vendor-did-not-read-gpc" // this vendor's own script ran, no attributable __gpp call
  | "vendor-no-script-observed" // only passive requests (image/font/etc); question n/a
  | "vendor-gpc-unread-via-container" // script ran; page's container(s) made 0 GPC calls
  | "vendor-gpc-check-unattributable" // page's container(s) made calls; which tag, unknown
  // NOTE: no GTM finding for Consent Mode's DECLARED state, and the reason does not extend
  // to the vendor states just above. Consent Mode is configuration a container broadcasts:
  // nothing "happened" that could be disputed. An observed consent-API call (or the absence
  // of one while a vendor's script ran) is an ACTION on the wire, the same epistemic class
  // as cookie-set-with-signal: if a vendor disputes it, the answer is "re-run the
  // fixture," which is exactly what a finding is for. Consent Mode's declared state remains
  // context, not a finding, and is carried only as `consentModeActive` on the artifact
  // below, for the view-model's footnote.
  // --- Vendor-specific ---
  | "rdp-param-absent" // no rdp= on Google ad requests (account-level caveat applies)
  | "ldu-param-absent" // no dpo=LDU on Meta requests
  // --- Confirmation ---
  | "confirmation-not-detected"
  // --- Declaration vs behavior ---
  | "declared-honor-cookie-set"; // gpc.json says true or the page showed a confirmation notice, and counted cookies were set

/**
 * A pointer to the exact observed thing behind a finding. The variants mirror the
 * observation types; the UI and the corrections pipeline both read this to show and
 * to reproduce. Kept as a discriminated union so each finding carries typed evidence.
 */
export type FindingArtifact =
  | {
      readonly kind: "network";
      readonly observationId: string;
      /**
       * Who loaded this vendor's script, when the insertion records say (1.12.0). Absent
       * means undetermined, so an old bundle and a new one that could not tell render the
       * same. Several entries when the entity's scripts were loaded more than one way.
       */
      readonly loadedVia?: readonly LoaderIdentity[];
      /**
       * On vendor-did-not-read-gpc only: the vendor was judged by its loader chain, so every
       * loader in `loadedVia` was checked and none read GPC (1.34.0). Absent, the loaders are
       * who inserted the script and nothing was checked of them.
       */
      readonly chainChecked?: true;
    }
  | { readonly kind: "cookie"; readonly observationId: string; readonly cookieName: string }
  | { readonly kind: "gpp-field"; readonly section: string; readonly fields: Readonly<Record<string, number>> }
  // fromWire is the first value requests carried that differs from the page's, and
  // fromWireHost the first host that carried it (1.29.0; absent when capture recorded none).
  | { readonly kind: "gpp-wire"; readonly fromApi: string; readonly fromWire: string; readonly fromWireHost?: string }
  | {
      readonly kind: "usp";
      readonly fromApi: string | null;
      readonly fromCookie: string | null;
      readonly fromWire: string | null;
      readonly fromWireHost?: string;
    }
  | {
      readonly kind: "consent-api";
      readonly api: string;
      readonly callCount: number;
      /**
       * On `vendor-read-gpc`, the sampled property reads attributed to the vendor's script
       * when it also read the property directly (1.36.0). The call is the artifact when both
       * were seen; this keeps the read, so a call whose string recorded no GPC value does not
       * hide a read of the property itself. Absent when there was none, and in older bundles.
       */
      readonly readCount?: number;
      /**
       * On `vendor-read-gpc`, who loaded the vendor's scripts, as on the other vendor states
       * (1.26.0), so a row that read GPC names its loader too. Absent when undetermined, and
       * in older bundles.
       */
      readonly loadedVia?: readonly LoaderIdentity[];
    }
  | { readonly kind: "gtm-consent"; readonly containerId: string; readonly state: Readonly<Record<string, string>> }
  /**
   * A read count of the signal property.
   *
   * Two uses, distinguished by the finding: on `signal-not-read` it is the page-wide total
   * and always 0; on `vendor-read-gpc` it is how many SAMPLED reads were attributed to that
   * vendor's script, which is a lower bound rather than a full count (see
   * SignalObservation.readsByScript). Never display it as "how often" for the vendor case.
   */
  | {
      readonly kind: "signal-read";
      readonly readCount: number;
      /** On `vendor-read-gpc`, who loaded the vendor's scripts (1.26.0). See "consent-api". */
      readonly loadedVia?: readonly LoaderIdentity[];
    }
  /**
   * Evidence for vendor-gpc-unread-via-container / vendor-gpc-check-unattributable.
   *
   * A narrower variant rather than reusing "consent-api": those two states are page-wide
   * facts, not a count of calls attributable to THIS vendor, so they carry different
   * evidence from the attributable "consent-api" cases and would otherwise force a bag of
   * optional fields onto one variant. Since 1.12.0 the page-wide kind is used only when
   * the vendor's loaders could not be resolved; "vendor-check-loader" below carries the
   * per-loader evidence otherwise.
   */
  | {
      readonly kind: "vendor-check-container";
      /**
       * Page-wide count of GPC checks that resolved into a tag-manager container: __gpp
       * calls plus sampled property reads whose stack landed in one. Both mechanisms,
       * because a container that reads the property is checking exactly as much as one
       * that calls GPP. Despite the name, the field counts checks of both kinds.
       */
      readonly containerCallCount: number;
      /** Whether Consent Mode was observed active, for the view-model's footnote only. */
      readonly consentModeActive: boolean;
      /** Who loaded this vendor's script, when the insertion records say (1.12.0). */
      readonly loadedVia?: readonly LoaderIdentity[];
    }
  /**
   * Evidence for vendor-gpc-unread-via-container / vendor-gpc-check-unattributable once
   * provenance is known (1.12.0). Used instead of "vendor-check-container" for vendors whose
   * loader could be resolved; that kind stays for the page-wide case and for old
   * bundles. The help text is chosen by `loader.kind` and `route` together.
   */
  | {
      readonly kind: "vendor-check-loader";
      /** The loader whose checks the count covers. */
      readonly loader: LoaderIdentity;
      readonly route: LoaderRoute;
      /**
       * GPC checks by that loader (route "loader"), by the ancestor (route "ancestor"),
       * by the consent-mode-setting container (route "consent-mode"), or page-wide (route
       * "page"): __gpp calls plus sampled property reads that resolved to it.
       */
      readonly containerCallCount: number;
      /**
       * Whether the loader's first check preceded the vendor's first insertion. Computed
       * from __gpp calls only, which are exact; null when the only evidence is sampled
       * reads, whose first sample can postdate a load an unsampled read preceded.
       */
      readonly checkedBeforeLoad: boolean | null;
      /** Whether Consent Mode was observed active, for the view-model's footnote only. */
      readonly consentModeActive: boolean;
      /** Every loader of this vendor's scripts, for the row line; `loader` is the one the route is about. */
      readonly loadedVia?: readonly LoaderIdentity[];
    }
  /**
   * Both sides of a GPC-signal / GPP-string disagreement, so a replayed bundle carries the
   * comparison rather than needing it re-derived — and so the popup can show the two values
   * beside each other instead of asserting a mismatch the reader has to go and verify.
   */
  | {
      readonly kind: "gpc-vs-gpp";
      /** The GPP section the field was read from, e.g. "usca". */
      readonly section: string;
      /** The string's own Gpc field: 1 (records the signal) or 0 (records not seeing it). */
      readonly gpcField: 0 | 1;
      /** What a page script would have read from navigator.globalPrivacyControl. */
      readonly propertyValue: PropertyValue;
      /** How many observed requests actually carried the Sec-GPC header. */
      readonly secGpcRequestCount: number;
    }
  /**
   * The evidence is in the running tallies (1.13.0): the entity's requests were counted,
   * and EntityTally.scriptRan says whether its code ran, but the individual requests were
   * not retained (the worker was reclaimed while the tab stayed open). Carries the same
   * loadedVia as the network artifact would have.
   */
  | { readonly kind: "tally"; readonly loadedVia?: readonly LoaderIdentity[]; readonly chainChecked?: true }
  /** On usp-requests-disagree and gpp-requests-disagree: every distinct string, first seen first. */
  | { readonly kind: "wire-values"; readonly values: readonly WireValue[] }
  | { readonly kind: "none" };

/**
 * The entity a finding is about, when it concerns a specific vendor. Rolled up from
 * domains via the classification list (PRD FR-17). null for site-level findings.
 */
export interface FindingEntity {
  /** Display name, e.g. "Google". */
  readonly name: string;
  /** The domains that rolled up to this entity for this finding. */
  readonly domains: readonly string[];
  /**
   * The category of those domains, in the engine's names (1.20.0), on a finding that is
   * about one category of a company's domains: the vendor check states, where Microsoft's
   * Advertising domains are judged apart from its Analytics ones. Absent on every other
   * finding, and in bundles recorded before 1.20.0, which carry one state per company.
   */
  readonly category?: string;
  /**
   * The finding is about a third-party registrable domain the list names no company for
   * (1.26.0), judged as a company in a category is: `name` is the domain, `domains` holds
   * it alone, and there is no `category`. Only the vendor check states carry it, and only
   * for a domain with a row (`unlistedDomainHasRow`, or a script from it that read GPC or
   * asked `__gpp`) in a bundle whose tallies keep `byUnlistedDomain`. It makes no claim
   * about who operates the domain.
   */
  readonly unlisted?: true;
}

export interface Finding {
  readonly flag: FindingFlag;
  /**
   * Mechanical-unambiguity rank for ordering (PRD FR-21). Lower = more unambiguous and
   * sorts first. A Set-Cookie header (rank ~10) outranks a text-match heuristic
   * (rank ~50). This is NOT a severity score; it never encodes "how bad".
   */
  readonly rank: number;
  /** The vendor this finding concerns, or null for a site-level finding. */
  readonly entity: FindingEntity | null;
  /** The exact observed thing behind this finding. */
  readonly artifact: FindingArtifact;
}
