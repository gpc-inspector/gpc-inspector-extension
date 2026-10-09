// SPDX-License-Identifier: GPL-3.0-only
/**
 * Consent-API calls, merged as they arrive.
 *
 * The list lives in chrome.storage.session with every other tab's state, so it cannot hold
 * every call a page makes to `__gpp`, `__uspapi` or `__tcfapi` as its own record. On
 * news-i.example (2026-09-22) the site's own bundle polled `__uspapi` 20,096 times in a few
 * minutes: 2.6 MB of JSON for one tab, which Chrome counts at roughly four times that
 * against a 10 MB quota the whole extension shares. Stored one record a call, every write
 * for every tab then fails, the tallies freeze, and the popup keeps rendering the frozen
 * numbers as current.
 *
 * Nothing downstream needs the calls one by one. The engine and the popup ask whether a
 * caller made a call, how many, and when the first one was; all three survive merging.
 * So identical calls fold into one record with a count, and storage grows with the number
 * of distinct callers, not the number of calls.
 */

import type { ConsentApiCall } from "@gpc-inspector/schema";

/**
 * Distinct records kept per tab. Far above anything seen live (news-i.example's 20,096 calls
 * were 4 records; the busiest page in the 30-site run had a few dozen), so reaching it means
 * a page doing something unusual, and the capture says it is incomplete rather than
 * letting one page exhaust storage for every tab.
 */
export const MAX_CONSENT_CALL_RECORDS = 200;

/** Everything that makes two calls "the same call". Time is not part of it. */
function keyOf(c: ConsentApiCall): string {
  return [c.api, c.command ?? "", c.callerScriptUrl ?? "", c.viaTagManager ? "1" : "0", ...(c.containerUrls ?? [])].join("\u0000");
}

export type MergeOutcome = "merged" | "added" | "dropped";

/**
 * Fold one call into the tab's list, in place.
 *
 * "dropped" means the list was full and the call matched no existing record: the caller
 * marks the capture incomplete, since a check this record would have carried is now
 * missing from what the engine sees.
 */
export function mergeConsentCall(
  calls: ConsentApiCall[],
  call: ConsentApiCall,
  max: number = MAX_CONSENT_CALL_RECORDS,
): MergeOutcome {
  const key = keyOf(call);
  const n = call.count ?? 1;
  const at = call.lastTimeMs ?? call.timeMs;
  for (let i = 0; i < calls.length; i++) {
    const existing = calls[i];
    if (!existing || keyOf(existing) !== key) continue;
    calls[i] = {
      ...existing,
      timeMs: Math.min(existing.timeMs, call.timeMs),
      count: (existing.count ?? 1) + n,
      lastTimeMs: Math.max(existing.lastTimeMs ?? existing.timeMs, at),
    };
    return "merged";
  }
  if (calls.length >= max) return "dropped";
  calls.push(call);
  return "added";
}
