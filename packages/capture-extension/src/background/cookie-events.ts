// SPDX-License-Identifier: GPL-3.0-only
/**
 * Which cookie writes count as cookies set.
 *
 * Three kinds of write leave no cookie behind, and a headline that counted every write held
 * each of them:
 *
 * - Writes the browser rejects. A script looking for the widest domain it may write to
 *   tries `domain=.com` before `domain=.site.com`; Chrome refuses the first.
 * - Deletions. An expiry in the past removes a cookie; it is not a set.
 * - Write tests. A cookie written and removed again in the same task, to test whether
 *   writing works (`cto_tld_test`, `criteo_write_test`, `lotame_domain_check`,
 *   `__cheq_tld_<time>`). The page reports the pair as a write test, by the task and never
 *   by the time between the two (js-cookies.ts), and the writes it removed are never
 *   reported.
 *
 * Every other cookie the browser stored counts, and stays counted: one removed later, by a
 * script or by a response, was set. No span of time makes a removal undo a set, because any
 * span chosen falls inside what pages do (a response clears a cookie from 40 ms to 2 s after
 * another set it, a script on a timer 3 to 4 s after), and the count would then turn on how
 * fast a page loaded. Such a cookie carries how long after its last set it was removed
 * (CookieDetail.removedAfterMs), once the browser's cookie jar is found not to hold it
 * (jar-check.ts), and the ledger keeps what that needs.
 */

import { isPublicSuffix } from "@gpc-inspector/lists";

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
   * When each cookie key the tallies hold was last set and has not been seen removed since:
   * what a removal's "how long after" is measured from. The counted keys, and the keys a
   * summary recorded.
   */
  setAt: Record<string, number>;
  /** Keys found to be write tests, for the record. */
  probes: string[];
  /**
   * Keys the browser's cookie jar was found to hold on this page (1.30.0, jar-check.ts). A
   * later write of one is not checked again, and a later write the jar does not hold does
   * not take it out of the count. Absent in a state stored before the check.
   */
  landed?: string[];
  /**
   * Keys in the tallies whose first jar check has not answered. The record handed to the
   * popup, the badge and an export leaves them out (sw.ts, buildObservationSet), so a
   * cookie appears nowhere before the jar has been asked and a count never has to take one
   * back. A key leaves the list when a check of it answers, cannot be made, or a removal
   * shows it was in the browser. One the bundle already shows is never put on it.
   */
  pending?: string[];
  /**
   * When each key was seen removed while it was in the browser, since its last set. A jar
   * check of that set finds nothing, because of the removal and not because the browser
   * kept nothing, so its answer is not applied.
   */
  removedAt?: Record<string, number>;
  /**
   * Removals waiting for the jar's answer, by key: how long after its last set the cookie
   * was removed, and that set's time, which a removal the jar shows did not take effect
   * gives back. Absent in a state stored before the check.
   */
  removing?: Record<string, { afterMs: number; setAt: number }>;
}

/** Record that the tallies hold a key set at `atMs`: it is no longer removed. */
export function markCounted(ledger: CookieLedger, key: string, atMs: number): void {
  ledger.setAt[key] = atMs;
  if (ledger.removedAt !== undefined) delete ledger.removedAt[key];
  // Set again before the jar answered for the removal: the cookie is in the browser again.
  if (ledger.removing !== undefined) delete ledger.removing[key];
}

/** Whether a key's first jar check has yet to answer. */
export function isPending(ledger: CookieLedger, key: string): boolean {
  return ledger.pending?.includes(key) === true;
}

/** Put a key on the list of keys waiting for their first jar check. */
export function hold(ledger: CookieLedger, key: string): void {
  if (!isPending(ledger, key)) ledger.pending = [...(ledger.pending ?? []), key];
}

/** Take a key off that list: it is shown from now on. */
export function release(ledger: CookieLedger, key: string): void {
  if (isPending(ledger, key)) ledger.pending = (ledger.pending ?? []).filter((k) => k !== key);
}

/**
 * Record that a key was removed at `atMs` while it was in the browser, and say how long
 * after its last set that was; null when the ledger holds no set of it to measure from (it
 * was not set on this page, or was already seen removed). The removal waits for the jar's
 * answer (settleRemoval) before the cookie is said to be removed.
 */
export function markRemoved(ledger: CookieLedger, key: string, atMs: number): number | null {
  const setAt = ledger.setAt[key];
  if (setAt === undefined) return null;
  delete ledger.setAt[key];
  ledger.removedAt = { ...(ledger.removedAt ?? {}), [key]: atMs };
  // Whole milliseconds: a request's time is a fraction of one.
  const afterMs = Math.max(0, Math.round(atMs - setAt));
  ledger.removing = { ...(ledger.removing ?? {}), [key]: { afterMs, setAt } };
  return afterMs;
}

/**
 * Apply the jar's answer to a key's removal: how long after its last set the cookie was
 * removed when the jar no longer holds it, which is then said; null when it still does, or
 * no removal of the key waits. A removal the jar shows did not take effect (the browser
 * declined it, or it named another cookie of the same key) is undone: the key is set at its
 * last set again, and a later removal is measured from there.
 */
export function settleRemoval(ledger: CookieLedger, key: string, held: boolean): number | null {
  const removal = ledger.removing?.[key];
  if (ledger.removing === undefined || removal === undefined) return null;
  delete ledger.removing[key];
  if (!held) return removal.afterMs;
  ledger.setAt[key] = removal.setAt;
  if (ledger.removedAt !== undefined) delete ledger.removedAt[key];
  return null;
}
