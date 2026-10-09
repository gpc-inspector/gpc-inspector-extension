// SPDX-License-Identifier: GPL-3.0-only
/**
 * @gpc-inspector/lists — domain classification for the engine.
 *
 * Bundled classification data is Disconnect's, under CC BY-NC-SA 4.0. The list of
 * functional cookie names is compiled from the Open Cookie Database, under Apache-2.0. See
 * LICENSE and NOTICE in this package for which file is under which. The list of the names
 * each tag manager's owner writes is compiled from the same database, under the same
 * license. Registrable domains come from the Public Suffix List, under MPL-2.0. The engine
 * itself carries no data and is unencumbered; swapping this package for
 * a differently-licensed source is a supported path.
 */

export { DisconnectClassifier } from "./classifier.js";
export type { CompiledList, Override, ListProvenance } from "./classifier.js";
export { LOCAL_OVERRIDES } from "./overrides.js";
export { registrableDomain, hostnameOf, domainSuffixes, isPublicSuffix, PUBLIC_SUFFIX_LIST_VERSION } from "./public-suffix.js";
export { loadDefaultClassifier, loadCompiledList } from "./load.js";
export { FunctionalCookies, loadFunctionalCookies, loadFunctionalCookieList } from "./functional-cookies.js";
export type {
  FunctionalCookieEntry,
  FunctionalCookieList,
  FunctionalCookieSource,
  FunctionalListProvenance,
} from "./functional-cookies.js";
export { OwnerCookies, loadOwnerCookies, loadOwnerCookieList } from "./owner-cookies.js";
export type { OwnerCookieEntry, OwnerCookieList, OwnerListProvenance } from "./owner-cookies.js";
