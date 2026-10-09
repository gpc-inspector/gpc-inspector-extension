// SPDX-License-Identifier: GPL-3.0-only
/**
 * Our part of the list of functional cookie names: which of the Open Cookie Database's
 * entries are taken, which are dropped, and the names it lacks.
 *
 * WHAT THE LIST IS FOR. The headline counts cookies by who set them, never by what they
 * are for, and vendors run their endpoints behind load balancers and bot protection that
 * add cookies of their own on the vendor's hostname. On the 2026-09-25 corpus run 21 of
 * 733 counted cookies were of this kind, and retailer-a.example's whole count was one of them.
 * Such a cookie is still counted, and labeled "listed as functional". It is never
 * excluded: the extension reads no cookie values, so a name is all it has to go on, and a
 * name is a string any vendor can reuse.
 *
 * WHY A FILTER. The database categorizes as a consent banner does: does this cookie need
 * the visitor's consent? Its Functional category holds 185 entries from advertising and
 * analytics platforms (DoubleClick's `test_cookie`, AdSense's `ANID`), and taking it whole
 * would label those as infrastructure on the platform's own description. So entries are
 * taken by PROVIDER, and only from providers of infrastructure.
 *
 * Four kinds of line, each with its reason: a provider taken whole, a named subset of a
 * provider that mixes products, an exclusion, and an addition with the provider's own
 * page. An addition without that page does not merge, and is offered to the database as a
 * pull request when it lands; the compile says when the database has it, so this file
 * shrinks over time.
 *
 * This file is this project's own work, under GPL-3.0-only. The list compiled from it is
 * Apache-2.0, as the database is. See LICENSE and NOTICE in this package.
 */

/** Where the database is read from, and the commit the shipped list was compiled at. */
export const DATABASE = {
  name: "open-cookie-database",
  repository: "https://github.com/jkwakman/Open-Cookie-Database",
  file: "open-cookie-database.csv",
  /** Moved by hand at a release, with the diff the compile prints read by a person. */
  commit: "749c37c17eb910fa95621f4fee34d9a6d4126c23",
  /** The git blob of the CSV at that commit. What was read is checked against it. */
  csvBlob: "747c2b676f5be696beacf8f3491b4162b363701c",
  license: "Apache-2.0",
  licenseUrl: "http://www.apache.org/licenses/LICENSE-2.0",
} as const;

/**
 * The database's categories an entry may have. Its consent-banner split also has
 * Marketing, Analytics and Personalization, which are never infrastructure.
 */
export const TAKEN_CATEGORIES: readonly string[] = ["Functional", "Security", "Necessary"];

export interface ProviderRule {
  /** The platform, spelled as the database spells it, its misspellings included. */
  readonly platform: string;
  /** The provider's name as this project writes it. */
  readonly provider: string;
  /** The names taken, for a provider that mixes products. Absent: every entry is taken. */
  readonly names?: readonly string[];
  readonly reason: string;
}

export const TAKEN: readonly ProviderRule[] = [
  { platform: "Akamai", provider: "Akamai", reason: "Content delivery and bot management; every entry is one or the other." },
  { platform: "Akamai Botmanager", provider: "Akamai Bot Manager", reason: "Bot detection." },
  { platform: "Citrix", provider: "Citrix", reason: "NetScaler load-balancer persistence." },
  { platform: "Cloudflare", provider: "Cloudflare", reason: "Load balancing, bot management and challenge cookies." },
  { platform: "CloudFlare", provider: "Cloudflare", reason: "The same provider under the database's second spelling." },
  { platform: "Datadome", provider: "DataDome", reason: "Bot protection. Its one entry is excluded below and added back under its real name." },
  { platform: "f5 BIG-IP", provider: "F5 BIG-IP", reason: "Load-balancer persistence." },
  { platform: "HAproxy", provider: "HAProxy", reason: "Load-balancer persistence. Its one entry is excluded below." },
  { platform: "Imperva", provider: "Imperva", reason: "Web application firewall and load balancing." },
  { platform: "NGINX Ingresss", provider: "ingress-nginx", reason: "Session affinity in the Kubernetes ingress controller." },
  {
    platform: "Amazon Web Services",
    provider: "AWS load balancer",
    names: ["AWSALB", "AWSALBCORS", "AWSALBTG", "AWSALBTGCORS", "AWSELB", "AWSELBCORS"],
    reason: "The database files AWS console cookies under the same platform. Only the load balancers' names are taken.",
  },
  {
    platform: "Azure / Microsoft",
    provider: "Azure",
    names: ["ARRAffinity", "ARRAffinitySameSite", "ApplicationGatewayAffinity", "ApplicationGatewayAffinityCORS", "ASLBSA", "ASLBSACORS"],
    reason:
      "The database files sign-in cookies and Dynamics365PortalAnalytics, which it describes as telling visitors apart, under the same platform. Only the load balancers' names are taken.",
  },
];

export interface Exclusion {
  readonly platform: string;
  readonly name: string;
  readonly reason: string;
}

export const EXCLUDED: readonly Exclusion[] = [
  {
    platform: "HAproxy",
    name: "SERVERID",
    reason: "HAProxy's documentation uses it as an example name, and operators choose their own. A label on it would rest on a name nobody in particular uses.",
  },
  {
    platform: "Datadome",
    name: "Datadome",
    reason: "The cookie is lower case, `datadome`, and matching is case-sensitive. Added below under its real name.",
  },
];

export interface Addition {
  readonly name: string;
  readonly match: "exact" | "prefix";
  readonly provider: string;
  /** The provider's own page that names the cookie and says what it is for. */
  readonly url: string;
  /** When the page was last read and found to say so. */
  readonly checked: string;
}

export const ADDED: readonly Addition[] = [
  {
    name: "akaalb_",
    match: "prefix",
    provider: "Akamai Application Load Balancer",
    url: "https://techdocs.akamai.com/cloudlets/docs/config-app-load-balancer-beh",
    checked: "2026-09-25",
  },
  {
    name: "AWSALBAPP-",
    match: "prefix",
    provider: "AWS Application Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html",
    checked: "2026-09-25",
  },
  {
    name: "aws-waf-token",
    match: "exact",
    provider: "AWS WAF",
    url: "https://docs.aws.amazon.com/waf/latest/developerguide/waf-tokens-details.html",
    checked: "2026-09-25",
  },
  {
    name: "datadome",
    match: "exact",
    provider: "DataDome",
    url: "https://docs.datadome.co/docs/cookie-session-storage",
    checked: "2026-09-25",
  },
  {
    name: "_px3",
    match: "exact",
    provider: "HUMAN Security",
    url: "https://docs.humansecurity.com/applications/use-of-cookies-web-storage",
    checked: "2026-09-25",
  },
  {
    name: "_pxhd",
    match: "exact",
    provider: "HUMAN Security",
    url: "https://docs.humansecurity.com/applications/use-of-cookies-web-storage",
    checked: "2026-09-25",
  },
  {
    name: "_pxvid",
    match: "exact",
    provider: "HUMAN Security",
    url: "https://docs.humansecurity.com/applications/use-of-cookies-web-storage",
    checked: "2026-09-25",
  },
];

// Not added, for want of a provider page that states a purpose: Akamai's `bm_sz`, listed on
// Akamai's cookie page without one, and `bm_s` and `bm_sc`, found only in other companies'
// cookie notices. Several defaults can be renamed by the operator (BIGipServer,
// INGRESSCOOKIE, Akamai's load-balancer label), so some deployments will show no label.

/** What the compiled file says of itself, so a reader knows it is not the database. */
export const MODIFIED =
  "Compiled from the Open Cookie Database: filtered to entries of infrastructure providers, with entries dropped and names added by this project (packages/lists/src/functional-overlay.ts). Names, categories and providers only; the database's descriptions are not included. Not the database as published.";
