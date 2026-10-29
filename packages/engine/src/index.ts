// SPDX-License-Identifier: GPL-3.0-only
/**
 * @gpc-inspector/engine — the pure verdict engine.
 *
 * Public surface: the evaluate() function, the badge count, the classifier interface
 * (so callers can supply @gpc-inspector/lists or a fake), and the rank scale.
 */

export { evaluate } from "./evaluate.js";
export {
  countCookiesSetWithSignal,
  countDistinctCookiesSetWithSignal,
  countCookiesSetWithoutSignal,
  countDistinctCookiesSetWithoutSignal,
  countAdTechRequests,
  countFirstPartyVendorCookies,
} from "./rules/cookie-with-signal.js";
export { RANK } from "./ranks.js";
export { cookieCharge, isCounted } from "./cookie-charge.js";
export type { CookieCharge } from "./cookie-charge.js";
export { NO_OWNERS } from "./owner-names.js";
export type { OwnerNames } from "./owner-names.js";
export { withPersistedShape } from "./normalize.js";
export { honorDeclarations } from "./rules/declared-honor.js";
export type { HonorDeclarations } from "./rules/declared-honor.js";
export { checksByContainer, resolveLoaders, recordKeyOf, innermostNamed } from "./provenance.js";
export { containerSummaries } from "./containers.js";
export { gppCheckTest, pingReturnsString } from "./gpp-check.js";
export { primaryGppSection, usStateGppSectionId, US_STATE_GPP_SECTIONS, US_STATE_GPP_SECTION_IDS, LEGACY_GPP_SECTION_NAMES, currentGppSectionName, type ApplicableGppSection } from "./gpp-section.js";
export type { ContainerSummary } from "./containers.js";
export type { ContainerChecks, ProvenanceResolution } from "./provenance.js";

export type {
  Classifier,
  Classification,
  Category,
  Party,
  Entity,
} from "./classifier.js";
export { CATEGORIES, CATEGORY_PRECEDENCE, COUNTING_CATEGORIES, categoryRank } from "./classifier.js";
