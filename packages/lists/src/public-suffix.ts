// SPDX-License-Identifier: GPL-3.0-only
/**
 * Registrable-domain (eTLD+1) resolution (PRD FR-17), over the Public Suffix List.
 *
 * The list is a published standard (https://publicsuffix.org), compiled offline from
 * data/public_suffix_list.dat into data/public-suffix-list.json (scripts/
 * compile-public-suffix.mjs), both under the Mozilla Public License 2.0. Both of its
 * sections apply: the ICANN section (co.uk, com.au) and the private one, the suffixes a
 * company runs for its customers (myshopify.com, akamaihd.net, cloudfront.net). Chrome
 * applies both when it decides whether a site may set a cookie on a domain, and a
 * customer's host under a private suffix is a site of its own: two Shopify stores are two
 * sites, not one "myshopify.com".
 *
 * It reads the whole list, not a short table of multi-part suffixes chosen here: such a
 * table groups every customer of an unlisted hosting suffix under the suffix's name and,
 * for a site hosted under one, makes every other customer's host first party.
 *
 * The rules, as the list defines them: the longest matching rule wins; a wildcard rule
 * (*.ck) matches any one label in its place; an exception rule (!www.ck) wins over every
 * other and makes its own leftmost label registrable; a name no rule matches has a public
 * suffix of one label (the implicit "*").
 */

// Unlike the other lists (see load.ts), this one is not handed in by the caller:
// registrableDomain is a plain function the classifier and the cookie checks call, and the
// list is a published standard with no other source to swap in. It is checked and indexed
// on the first lookup, not at import.
import psl from "../data/public-suffix-list.json" with { type: "json" };

interface CompiledPsl {
  readonly version: string;
  readonly commit: string;
  readonly source: string;
  readonly icann: readonly string[];
  readonly private: readonly string[];
}

/** Which Public Suffix List is compiled in, for a bundle's provenance. */
export const PUBLIC_SUFFIX_LIST_VERSION: { readonly source: string; readonly version: string; readonly commit: string } = {
  source: (psl as CompiledPsl).source,
  version: (psl as CompiledPsl).version,
  commit: (psl as CompiledPsl).commit,
};

/** The compiled list, checked before a rule is read, so a bad compile fails with a reason. */
function checkedList(raw: unknown): CompiledPsl {
  const o = raw as Record<string, unknown>;
  for (const section of ["icann", "private"]) {
    const rules = o[section];
    if (!Array.isArray(rules) || rules.length === 0 || !rules.every((r) => typeof r === "string")) {
      throw new Error(`public-suffix-list.json: no ${section} rules`);
    }
  }
  return o as unknown as CompiledPsl;
}

interface SuffixIndex {
  readonly rules: ReadonlySet<string>;
  readonly wildcards: ReadonlySet<string>;
  readonly exceptions: ReadonlySet<string>;
}

let index: SuffixIndex | null = null;

/**
 * The rules by kind, built on the first lookup: a worker start or a popup open that
 * resolves nothing pays nothing for them.
 */
function suffixIndex(): SuffixIndex {
  if (index !== null) return index;
  const list = checkedList(psl);
  const rules = new Set<string>();
  const wildcards = new Set<string>();
  const exceptions = new Set<string>();
  for (const rule of [...list.icann, ...list.private]) {
    if (rule.startsWith("!")) exceptions.add(rule.slice(1));
    else if (rule.startsWith("*.")) wildcards.add(rule.slice(2));
    else rules.add(rule);
  }
  index = { rules, wildcards, exceptions };
  return index;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** A host that no suffix rule applies to: an IPv4 or IPv6 literal. */
function isIpLiteral(host: string): boolean {
  return IPV4.test(host) || host.includes(":") || host.startsWith("[");
}

/**
 * How many labels of `host` are the public suffix, by the list's rules. Walks from the
 * rightmost label leftwards, one candidate per label, each a slice of the host.
 */
function publicSuffixLength(host: string): number {
  const { rules, wildcards, exceptions } = suffixIndex();
  let best = 1; // the implicit "*"
  let exception = -1;
  let parent = "";
  let n = 0;
  for (let end = host.length; end >= 0; ) {
    const dot = end === 0 ? -1 : host.lastIndexOf(".", end - 1);
    const candidate = host.slice(dot + 1);
    n += 1;
    // An exception wins over every other rule: its leftmost label is registrable. The
    // longest one that matches is the one that applies.
    if (exceptions.has(candidate)) exception = n - 1;
    else if (rules.has(candidate) || (n > 1 && wildcards.has(parent))) best = n;
    parent = candidate;
    end = dot;
  }
  return exception >= 0 ? exception : best;
}

/** A hostname, lowercased, without a trailing dot. */
function normalize(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

/**
 * Resolve the registrable domain (eTLD+1) of a hostname: the public suffix and one label
 * before it. Returns the host itself when it has no dot ("localhost"), is an IP literal, or
 * is itself a public suffix ("co.uk", "myshopify.com"), which has no registrable domain.
 */
export function registrableDomain(hostname: string): string {
  const host = normalize(hostname);
  if (!host || !host.includes(".") || isIpLiteral(host)) return host;
  const labels = host.split(".");
  const suffix = publicSuffixLength(host);
  if (labels.length <= suffix) return host;
  return labels.slice(-(suffix + 1)).join(".");
}

/**
 * Whether a domain is itself a public suffix, so no site can set a cookie on it: a bare TLD
 * ("com"), a registry's ("co.uk") or a company's for its customers ("myshopify.com"), by the
 * same list as registrableDomain. A leading dot is ignored.
 */
export function isPublicSuffix(domain: string): boolean {
  const d = normalize(domain).replace(/^\./, "");
  if (d === "" || isIpLiteral(d)) return false;
  return publicSuffixLength(d) >= d.split(".").length;
}

/** Extract a hostname from a URL string. Returns null when unparseable. */
export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Every domain suffix of a hostname, longest first: for "a.b.example.com" →
 * ["a.b.example.com", "b.example.com", "example.com"]. Used for list lookup so a
 * subdomain matches its parent's classification (securepubads.g.doubleclick.net →
 * doubleclick.net). Stops at two labels; never returns a bare TLD.
 */
export function domainSuffixes(hostname: string): string[] {
  const host = hostname.toLowerCase();
  const parts = host.split(".");
  const out: string[] = [];
  for (let i = 0; i <= parts.length - 2; i++) {
    out.push(parts.slice(i).join("."));
  }
  return out;
}
