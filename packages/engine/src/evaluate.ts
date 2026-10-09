// SPDX-License-Identifier: GPL-3.0-only
/**
 * The engine (PRD FR-25, D5). A pure function: ObservationSet + Classifier in, Finding[]
 * out. No chrome.*, no DOM, no network, no clock. The Classifier is injected (see
 * classifier.ts) so even domain classification is not a hidden dependency.
 *
 * evaluate() runs every rule, concatenates their findings, and sorts them deterministically
 * so the same input always yields byte-identical output (required for the golden corpus
 * determinism gate, NFR-3, and for stable evidence bundles).
 *
 * Sort order (PRD FR-21): by rank ascending (mechanical unambiguity), then a stable
 * tiebreak by flag, entity name and the entity's category, so ties never reorder
 * run-to-run.
 */

import type { Finding, ObservationSet } from "@gpc-inspector/schema";
import type { Classifier } from "./classifier.js";
import { categoryRank } from "./classifier.js";

import { gppConflict } from "./rules/gpp-conflict.js";
import { cookieSetWithSignal } from "./rules/cookie-with-signal.js";
import { signalIntegrity } from "./rules/signal-integrity.js";
import {
  confirmationNotice,
  uspSurfacesDisagree,
  gppSurfacesDisagree,
  uspRequestsDisagree,
  gppRequestsDisagree,
} from "./rules/notices.js";
import { declaredHonorCookieSet } from "./rules/declared-honor.js";
import { vendorSignalCheck } from "./rules/vendor-signal-check.js";
import { gpcVsGpp } from "./rules/gpc-vs-gpp.js";
import { withPersistedShape } from "./normalize.js";
import { NO_OWNERS, type OwnerNames } from "./owner-names.js";

/** Deterministic comparator: rank, then flag, then entity name. Total order. */
function compareFindings(a: Finding, b: Finding): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.flag !== b.flag) return a.flag < b.flag ? -1 : 1;
  const an = a.entity?.name ?? "";
  const bn = b.entity?.name ?? "";
  if (an !== bn) return an < bn ? -1 : 1;
  // A company is judged once per category (1.20.0), so its findings differ by category.
  const ac = a.entity?.category ?? "";
  const bc = b.entity?.category ?? "";
  if (ac !== bc) return categoryRank(ac) - categoryRank(bc) || (ac < bc ? -1 : 1);
  // Final tiebreak on artifact kind, so identical-looking findings still order stably.
  return a.artifact.kind < b.artifact.kind ? -1 : a.artifact.kind > b.artifact.kind ? 1 : 0;
}

/**
 * Run all rules against an observation set and return sorted findings.
 * Pure and total: never throws on well-formed input, never reads anything external.
 * `owners` is the container owners' cookie names (1.25.0), injected like the classifier;
 * without it a cookie written inside a container is charged to no one.
 */
export function evaluate(given: ObservationSet, classifier: Classifier, owners: OwnerNames = NO_OWNERS): Finding[] {
  // Every rule reads the persisted fields; an older bundle has them derived here, once.
  const obs = withPersistedShape(given);
  const findings: Finding[] = [
    ...signalIntegrity(obs),
    ...gppConflict(obs),
    ...cookieSetWithSignal(obs, classifier, owners),
    ...declaredHonorCookieSet(obs, classifier, owners),
    ...uspSurfacesDisagree(obs),
    ...gppSurfacesDisagree(obs),
    ...uspRequestsDisagree(obs),
    ...gppRequestsDisagree(obs),
    ...confirmationNotice(obs),
    ...gpcVsGpp(obs),
    ...vendorSignalCheck(obs, classifier, owners),
  ];

  return findings.sort(compareFindings);
}
