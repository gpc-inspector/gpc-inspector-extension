// SPDX-License-Identifier: GPL-3.0-only
/**
 * Which cookie writes count as cookies set.
 *
 * Three kinds of write leave no cookie behind, and a 30-site run on 2026-09-22 found each
 * of them in a headline that counted every write:
 *
 * - Writes the browser rejects. A script looking for the widest domain it may write to
 *   tries `domain=.com` before `domain=.site.com`; Chrome refuses the first. media.net and
 *   Criteo on news-g.example, the Meta pixel on marketplace-b.example, CHEQ on retailer-e.example and Forter on
 *   retailer-d.example each wrote a `.com` cookie.
 * - Deletions. An expiry in the past removes a cookie; it is not a set.
 * - Probes. A cookie written and removed within moments to test whether writing works
 *   (`cto_tld_test`, `criteo_write_test`, `lotame_domain_check`, `__cheq_tld_<time>`).
 *   retailer-e.example's whole finding, two cookies from one vendor, was one such probe.
 *
 * Only the first two can be decided from a single write. A probe needs its deletion, so
 * the ledger remembers when each counted cookie was last set.
 */

import { isPublicSuffix } from "@gpc-inspector/lists";
import { isCookieDeletion, type CookieRecord } from "@gpc-inspector/schema";

/**
 * A cookie deleted within this long of being set is a probe, not a cookie set. Live probes
 * are removed within the same task; five seconds is well clear of that and far below the
 * lifetime of any cookie that does something.
 */
export const PROBE_WINDOW_MS = 5_000;

/**
 * Whether the browser would store a cookie with this Domain written from this host.
 *
 * The host must be the domain or a subdomain of it, and the domain must not be a public
 * suffix. A domain equal to the host is always accepted: that is a host-only cookie, which
 * is what a write with no Domain attribute is recorded as, even on a single-label host.
 * An empty host (a record from before the field existed) skips the match and keeps the
 * public-suffix check.
 */
export function cookieWriteAccepted(domain: string, host: string): boolean {
  const d = domain.toLowerCase().replace(/^\./, "");
  const h = host.toLowerCase();
  if (d === "") return true;
  if (h !== "" && d === h) return true;
  if (h !== "" && !h.endsWith(`.${d}`)) return false;
  return !isPublicSuffix(d);
}

/** What the capture remembers between writes, per tab. */
export interface CookieLedger {
  /**
   * When each cookie key the tallies hold was last set, so a quick deletion reads as a
   * probe: the COUNTED keys, and since 1.20.0 the keys a summary per company and category
   * recorded for a category that does not count.
   */
  setAt: Record<string, number>;
  /** Keys found to be probes, for the record. */
  probes: string[];
  /**
   * Keys the browser's cookie jar was found to hold on this page (1.30.0, jar-check.ts). A
   * later write of one is not checked again, and a later write the jar does not hold does
   * not take it out of the count. Absent in a state stored before the check.
   */
  landed?: string[];
}

export type CookieEvent = "set" | "deletion" | "probe";

/**
 * Classify one cookie record, and forget the key if it was deleted.
 *
 * "set" is counted. "deletion" is not counted. "probe" is a deletion of a cookie
 * counted within PROBE_WINDOW_MS, which the caller removes from the counts. A key only
 * enters `setAt` when the caller says the tallies hold it (markCounted), so the ledger
 * stays as small as they are.
 */
export function classifyCookieEvent(
  ledger: CookieLedger,
  key: string,
  cookie: Pick<CookieRecord, "expiresMs">,
  atMs: number,
): CookieEvent {
  if (!isCookieDeletion(cookie, atMs)) return "set";
  const setAt = ledger.setAt[key];
  delete ledger.setAt[key];
  if (setAt !== undefined && atMs - setAt <= PROBE_WINDOW_MS) {
    if (!ledger.probes.includes(key)) ledger.probes.push(key);
    return "probe";
  }
  return "deletion";
}

/** Record that a key was counted at `atMs`. */
export function markCounted(ledger: CookieLedger, key: string, atMs: number): void {
  ledger.setAt[key] = atMs;
}
