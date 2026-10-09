// SPDX-License-Identifier: GPL-3.0-only
/**
 * Which `__gpp` calls count as a check of the reader's choice: one rule, called by the
 * vendor rule, the per-container counts, the container rows and the popup's "Checked for
 * GPC" lists, so a vendor is never Yes in one place and No in another.
 *
 * Every command counts except `ping` under GPP 1.0. In 1.0 ping's answer carries version and
 * signal status and no string, so a vendor that only pinged asked whether a consent tool
 * exists, not what the reader chose. In 1.1 the answer (PingReturn) also carries
 * `gppString` and `parsedSections`, the GPC field included: verified on health-c.example
 * 2026-09-30, where ping answered with the usnat string and `Gpc`. A ping there is as much a
 * read of the choice as `getGPPData`.
 *
 * The version is the one the page's consent tool reported (`gpp.gppVersion`), recorded from
 * every `__gpp` answer including ping's own. A page has one consent tool, so its version
 * holds for every call on the page. When no answer reported one, a ping is not counted: the
 * capture cannot show that it returned a string. Every capture in the 2026-09-30 corpus run
 * that recorded a ping also recorded version 1.1.
 */

import type { ConsentApiCall, ObservationSet } from "@gpc-inspector/schema";

/** True when a GPP version's ping answer carries the string: 1.1 and later. */
export function pingReturnsString(gppVersion: string | null | undefined): boolean {
  const m = /^\s*(\d+)\.(\d+)/.exec(gppVersion ?? "");
  if (m === null) return false;
  const major = Number(m[1]);
  return major > 1 || (major === 1 && Number(m[2]) >= 1);
}

/**
 * A test for "this call is a `__gpp` check of the reader's choice" on one page. Built once
 * per page, since the answer for ping depends on the page's version.
 */
export function gppCheckTest(obs: Pick<ObservationSet, "gpp">): (call: Pick<ConsentApiCall, "api" | "command">) => boolean {
  const pingCounts = pingReturnsString(obs.gpp?.gppVersion);
  return (call) => call.api === "__gpp" && (call.command !== "ping" || pingCounts);
}
