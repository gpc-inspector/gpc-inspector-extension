// SPDX-License-Identifier: GPL-3.0-only
/**
 * The part of the popup's view input that comes from the engine and the lists.
 *
 * The view model stays free of the classification list; the popup supplies these closures
 * and counts. They live here rather than in popup.ts, where nothing outside a browser can
 * reach them, so a test replaying a real capture (test/corpus-replay.test.ts) uses them
 * too. One function, used by both, keeps the replayed view the view a reader gets.
 */

import {
  evaluate,
  countDistinctCookiesSetWithSignal,
  countDistinctCookiesSetWithoutSignal,
  countAdTechRequests,
  countFirstPartyVendorCookies,
  type Classifier,
  type OwnerNames,
} from "@gpc-inspector/engine";
import type { ObservationSet } from "@gpc-inspector/schema";
import type { BuildInput } from "./view-model.js";

/** The lists the popup reads a capture by. */
export interface ViewLists {
  readonly classifier: Classifier;
  readonly owners: OwnerNames;
  readonly isListedFunctional: (cookieName: string) => boolean;
}

export type ClassifiedInput = Pick<
  BuildInput,
  | "observations"
  | "findings"
  | "distinctCookies"
  | "distinctCookiesUnsigned"
  | "adTechRequests"
  | "firstPartyVendorCookies"
  | "classify"
  | "owners"
  | "isListedFunctional"
>;

export function classifiedInput(observations: ObservationSet | null, lists: ViewLists): ClassifiedInput {
  const { classifier, owners, isListedFunctional } = lists;
  if (!observations) {
    return {
      observations: null,
      findings: [],
      distinctCookies: 0,
      distinctCookiesUnsigned: 0,
      adTechRequests: 0,
      firstPartyVendorCookies: 0,
      classify: () => undefined,
      owners,
      isListedFunctional,
    };
  }
  const topSite = observations.context.topSite;
  return {
    observations,
    findings: evaluate(observations, classifier, owners),
    // Counted in the ENGINE, not here. Duplicating the classification predicate in the UI
    // is how the popup and the badge come to disagree, and the whole product rests on those
    // numbers agreeing.
    distinctCookies: countDistinctCookiesSetWithSignal(observations, classifier, owners),
    distinctCookiesUnsigned: countDistinctCookiesSetWithoutSignal(observations, classifier, owners),
    adTechRequests: countAdTechRequests(observations, classifier),
    firstPartyVendorCookies: countFirstPartyVendorCookies(observations, classifier, owners),
    classify: (url: string) => {
      const c = classifier.classify(url, topSite);
      return { party: c.party, category: c.category, entity: c.entity?.name ?? null, domain: c.registrableDomain };
    },
    owners,
    isListedFunctional,
  };
}
