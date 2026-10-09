// SPDX-License-Identifier: GPL-3.0-only
/**
 * Our part of the list of container owners' cookie names: which company owns each tag
 * manager, which of the Open Cookie Database's entries are taken as that owner's own
 * names, and the names it lacks.
 *
 * WHAT THE LIST IS FOR. A cookie written by code running inside a tag container resolves
 * to the container's script, because a container runs other companies' code inside
 * itself. Such a cookie counts only when its name is the container owner's own: `_ga`
 * written inside a Google tag counts under Google, `AMCV_*` written inside a Tealium
 * container is recorded and counted nowhere. The name is never used to charge a cookie
 * written anywhere else: a name is a string any vendor can reuse, the line the functional
 * list draws too.
 *
 * WHY NAMES, BY OWNER. Entries are taken by name, never a platform whole: the database's
 * "Google" platform holds google.com's sign-in cookies (`SID`, `NID`), and a site's own
 * cookie of that name written by a Custom HTML tag inside GTM would be charged to Google.
 * The names are the ones each manager's own library writes, checked against the provider's
 * documentation on 2026-09-28.
 *
 * WHO OWNS A MANAGER. Google owns GTM and the Google tag, and Adobe owns Launch, set here
 * because the list names no company for googletagmanager.com or assets.adobedtm.com.
 * Every other manager's owner is the company the classification list names for its
 * loader's host, spelled as Disconnect spells it; a test holds the two together.
 *
 * A CATEGORY PER NAME. The database's Analytics is `analytics` and its Marketing is
 * `advertising`. Any other category is `unknown`, which counts nothing: such a name is
 * charged to its owner and recorded, like any cookie in a category that does not count.
 * A name this project adds carries the category given here, with its reason.
 *
 * This file is this project's own work, under GPL-3.0-only. The list compiled from it is
 * Apache-2.0, as the database is. See LICENSE and NOTICE in this package.
 */

import type { TagManagerKind } from "@gpc-inspector/schema";
export { DATABASE } from "./functional-overlay.js";

/** The engine's categories a name may have. Only the first two count. */
export type OwnerCategory = "advertising" | "analytics" | "unknown";

/** The database's categories, in the engine's names. Anything else is `unknown`. */
export const CATEGORY_OF: Readonly<Record<string, OwnerCategory>> = {
  Analytics: "analytics",
  Marketing: "advertising",
};

export interface ManagerOwner {
  /** The company, as the classification list spells it. */
  readonly owner: string;
  /**
   * A loader host the classification list names the owner for. Absent where the list
   * names nobody and the owner is set here instead.
   */
  readonly loaderHost?: string;
  readonly reason: string;
}

export const OWNERS: Readonly<Record<TagManagerKind, ManagerOwner>> = {
  gtm: { owner: "Google", reason: "Set here, because the list names no company for googletagmanager.com." },
  gtag: { owner: "Google", reason: "Set here, because the list names no company for googletagmanager.com. On 22 corpus sites gtag.js wrote only `_ga`, `_ga_<id>` and `_gcl_au`." },
  google: { owner: "Google", reason: "A googletagmanager.com script that names no container, as GTM." },
  "adobe-launch": { owner: "Adobe", reason: "Set here, because the list names no company for assets.adobedtm.com." },
  tealium: { owner: "Tealium", loaderHost: "tags.tiqcdn.com", reason: "The company the list names for the loader's host." },
  segment: { owner: "Twilio", loaderHost: "cdn.segment.com", reason: "The company the list names for the loader's host." },
  matomo: { owner: "InnoCraft", loaderHost: "cdn.matomo.cloud", reason: "The company the list names for Matomo Cloud's host." },
  "piwik-pro": { owner: "CookieInformation", loaderHost: "example.containers.piwik.pro", reason: "The company the list names for the loader's host." },
  ensighten: { owner: "CHEQ", loaderHost: "nexus.ensighten.com", reason: "The company the list names for the loader's host." },
  "commanders-act": { owner: "CommandersAct", loaderHost: "cdn.tagcommander.com", reason: "The company the list names for the loader's host." },
};

export interface OwnerTaken {
  /** The platform, spelled as the database spells it, its misspellings included. */
  readonly platform: string;
  /** The owner, as in OWNERS. */
  readonly owner: string;
  /** The names taken, as the database spells them. A name it does not have stops the compile. */
  readonly names: readonly string[];
  /**
   * Names the database marks as a prefix that are taken as exact, each for the reason given
   * in `reason`: a prefix that also matches another library's cookie.
   */
  readonly exact?: readonly string[];
  readonly reason: string;
}

export const TAKEN: readonly OwnerTaken[] = [
  {
    platform: "Google Analytics",
    owner: "Google",
    names: ["_ga", "_ga_", "_gid", "_gat", "_gat_gtag_", "_dc_gtm_", "_gac_", "FPID", "FPLC", "FPAU"],
    reason: "What gtag.js and GTM's Google Analytics tags write. Universal Analytics' `__utm*` are analytics.js's and ga.js's, which load from google-analytics.com and are charged by their host.",
  },
  {
    platform: "Google Ads",
    owner: "Google",
    names: ["_gcl_aw", "_gcl_gs", "_gcl_gb", "_gac_gb_"],
    reason: "The conversion linker's cookies. The platform's `__Secure-*` and `AEC` are google.com's own and are never written into a site's jar.",
  },
  {
    platform: "Google",
    owner: "Google",
    names: ["_gcl_au", "_gcl_dc"],
    reason: "The conversion linker's cookies. The rest of the platform is google.com's sign-in and preference cookies.",
  },
  {
    platform: "Adobe Analytics",
    owner: "Adobe",
    names: ["s_cc", "s_sq", "s_vi", "s_fid", "s_ecid", "s_ppv", "s_tp"],
    exact: ["s_vi"],
    reason:
      "What AppMeasurement writes. `fid` and `sat_track` are left out: short or generic names a site's own code also uses. `s_vi` is exact, where the database has a prefix: Adobe's page names `s_vi` alone, and the prefix would take in `s_visit`, a plugin's cookie seen on a corpus site.",
  },
  {
    platform: "Adobe Audience Manager",
    owner: "Adobe",
    names: ["AMCV_", "AMCVS_", "mbox", "at_check", "demdex"],
    reason: "The Experience Cloud ID service's and Target's cookies. `dextp`, `dst`, `_dp` and `dpm` are set on demdex.net by its own responses.",
  },
  {
    platform: "Matomo",
    owner: "InnoCraft",
    names: ["_pk_id", "_pk_ses", "_pk_ref", "mtm_consent", "mtm_consent_removed", "mtm_cookie_consent"],
    reason: "What Matomo's tracker and its tag manager write.",
  },
  {
    platform: "Piwik",
    owner: "CookieInformation",
    names: [
      "_pk_id.",
      "_pk_ses.",
      "ppms_privacy_",
      "stg_traffic_source_priority",
      "stg_last_interaction",
      "stg_returning_visitor",
      "stg_externalReferrer",
      "stg_fired__",
      "stg_utm_campaign",
      "stg_pk_campaign",
      "stg_global_opt_out",
    ],
    reason: "What Piwik PRO's tracker and its tag manager write.",
  },
  {
    platform: "CHEQ AI Technologies",
    owner: "CHEQ",
    names: ["_cq_duid", "_cq_suid"],
    reason: "CHEQ's own cookies. Ensighten publishes no page that names the cookies its bootstrap writes (searched 2026-09-28).",
  },
  {
    platform: "Command Act",
    owner: "CommandersAct",
    names: [
      "tc_cj_v2",
      "tc_cj_v2_cmp.",
      "tc_cj_v2_med",
      "tc_test_cookie",
      "tc_sample_",
      "tc_caids",
      "tc_cj_ss",
      "tc_ss",
      "TC_PRIVACY",
      "TC_PRIVACY_CENTER",
      "TCIPD",
    ],
    reason: "What Commanders Act's container and privacy banner write, as the database spells them. `CAID`, `TCID` and `WID` are left out: short names a site's own code also uses.",
  },
];

export interface OwnerAddition {
  readonly name: string;
  readonly match: "exact" | "prefix";
  readonly owner: string;
  readonly category: OwnerCategory;
  /** The provider's own page that names the cookie. */
  readonly url: string;
  /** When the page was last read and found to say so. */
  readonly checked: string;
  /** Why the category, where the page gives none in the engine's terms. */
  readonly reason: string;
}

const GOOGLE_ADS_COOKIES = "https://business.safety.google/adscookies/";
const ADOBE_WEB_SDK_COOKIES = "https://experienceleague.adobe.com/en/docs/core-services/interface/data-collection/cookies/web-sdk";
const ADOBE_ANALYTICS_COOKIES = "https://experienceleague.adobe.com/en/docs/core-services/interface/data-collection/cookies/analytics";
const TEALIUM_COOKIES = "https://docs.tealium.com/iq-tag-management/data-layer/cookies/";
const SEGMENT_COOKIES = "https://segment.com/docs/connections/sources/catalog/libraries/website/javascript/cookie-validity-update/";

export const ADDED: readonly OwnerAddition[] = [
  { name: "_gcl_ag", match: "exact", owner: "Google", category: "advertising", url: GOOGLE_ADS_COOKIES, checked: "2026-09-28", reason: "Listed under Google Ads." },
  { name: "_gcl_gf", match: "exact", owner: "Google", category: "advertising", url: GOOGLE_ADS_COOKIES, checked: "2026-09-28", reason: "Listed under Google Flights, beside the other conversion linker names." },
  { name: "_gcl_ha", match: "exact", owner: "Google", category: "advertising", url: GOOGLE_ADS_COOKIES, checked: "2026-09-28", reason: "Listed under Google Hotel Ads, beside the other conversion linker names." },
  {
    name: "kndctr_",
    match: "prefix",
    owner: "Adobe",
    category: "advertising",
    url: ADOBE_WEB_SDK_COOKIES,
    checked: "2026-09-28",
    reason: "The Web SDK's cookies, `kndctr_<orgId>_identity` among them, which holds the Experience Cloud ID that `AMCV_*` holds; the database files `AMCV_` as Marketing.",
  },
  {
    name: "mboxEdgeCluster",
    match: "exact",
    owner: "Adobe",
    category: "advertising",
    url: ADOBE_WEB_SDK_COOKIES,
    checked: "2026-09-28",
    reason: "Target's edge routing, beside `mbox`, which the database files as Marketing. Seen written by Launch on a corpus site.",
  },
  {
    name: "s_ac",
    match: "exact",
    owner: "Adobe",
    category: "analytics",
    url: ADOBE_ANALYTICS_COOKIES,
    checked: "2026-09-28",
    reason: "AppMeasurement's domain test, which it removes at once; listed with Adobe Analytics' cookies.",
  },
  { name: "utag_main", match: "exact", owner: "Tealium", category: "analytics", url: TEALIUM_COOKIES, checked: "2026-09-28", reason: "utag.js 4.49 and earlier. The list names Tealium's host as Analytics." },
  { name: "utag_main_", match: "prefix", owner: "Tealium", category: "analytics", url: TEALIUM_COOKIES, checked: "2026-09-28", reason: "utag.js 4.50 and later write one cookie per key. The list names Tealium's host as Analytics." },
  { name: "ajs_anonymous_id", match: "exact", owner: "Twilio", category: "analytics", url: SEGMENT_COOKIES, checked: "2026-09-28", reason: "Analytics.js's visitor id. The database files it under Trustpilot." },
  { name: "ajs_user_id", match: "exact", owner: "Twilio", category: "analytics", url: SEGMENT_COOKIES, checked: "2026-09-28", reason: "Analytics.js's user id. The database files it under Trustpilot." },
  { name: "ajs_group_id", match: "exact", owner: "Twilio", category: "analytics", url: SEGMENT_COOKIES, checked: "2026-09-28", reason: "Analytics.js's group id. The database files it under Trustpilot." },
];

// Not added: `utag_ck_gtid`, seen under Tealium on corpus pages, which Tealium's cookie
// page does not name; `utag_env_<account>_<profile>`, which it does, is Web Companion's
// saved environment and never written for a visitor. Ensighten's own names, for want of a
// page from Ensighten that names them.

/** What the compiled file says of itself, so a reader knows it is not the database. */
export const MODIFIED =
  "Compiled from the Open Cookie Database: filtered to the names tag managers' owners write, by owner, with names added by this project from each provider's own documentation (packages/lists/src/owner-overlay.ts). Names, categories and owners only; the database's descriptions are not included. Not the database as published.";
