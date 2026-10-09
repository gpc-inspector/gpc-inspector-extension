// SPDX-License-Identifier: GPL-3.0-only
/**
 * Finding ranks (PRD FR-21). Lower sorts first. This orders findings by how mechanically
 * UNAMBIGUOUS the underlying observation is — NOT by how "bad" it is. A Set-Cookie header
 * you can point at outranks a text-match heuristic that might have missed a settings page.
 *
 * The scale is coarse on purpose (bands of 10) so inserting a new rule between two others
 * is easy and the relative ordering is readable. Two findings may share a rank; ties are
 * broken deterministically by the engine (by flag name then entity) so output is stable.
 *
 * Bands, most to least mechanically certain:
 *   10s  A response header we captured. Zero interpretation. (Set-Cookie, GPP fields.)
 *   20s  A structured value the site published that is internally contradictory.
 *   30s  A request-level fact (a parameter present/absent, a call made/not made).
 *   40s  An attribution-dependent claim (who called what — softens under GTM/bundles).
 *   50s  A DOM text heuristic (could miss legitimate placement elsewhere).
 */
export const RANK = {
  // 10s — captured response headers, no interpretation
  COOKIE_SET_WITH_SIGNAL: 10,
  COOKIE_SET_ON_REDIRECT: 11,
  GPP_CONFLICT: 12, // Gpc=1 beside SaleOptOut=2 — two fields from the site's own broadcast
  DECLARED_HONOR_COOKIE_SET: 13, // site's own gpc.json or confirmation notice vs its own Set-Cookie

  // 20s — structured values, internally contradictory
  USP_SURFACES_DISAGREE: 20,
  GPP_SURFACES_DISAGREE: 21, // __gpp vs the gpp= wire parameter
  USP_REQUESTS_DISAGREE: 22, // no page string; requests carried different ones
  GPP_REQUESTS_DISAGREE: 23,
  // NOTE: there is deliberately no rank for a "container said denied yet cookies were set"
  // finding. Google Consent Mode is a mechanism for propagating a choice to Google's tags;
  // it is not the obligation. Vendors receive Sec-GPC on their own requests whether or not
  // a container told them anything, so pairing the container's state with an unrelated
  // vendor's cookie implies a contradiction that has not been established. The container
  // state is reported as context; the cookies are counted on their own terms.
  GPP_UNPARSEABLE: 25,

  // 30s — request-level facts
  SIGNAL_SENT: 30, // context, not an accusation; ranks low among findings
  SIGNAL_PROPERTY_ABSENT: 31,
  PROPERTY_TAMPERED: 32,
  VENDOR_NO_SCRIPT_OBSERVED: 33, // resourceType fact: only passive requests, question n/a
  RDP_PARAM_ABSENT: 35, // account-level caveat applies
  LDU_PARAM_ABSENT: 36,

  // The signal we sent vs what the site's string recorded. Both sides are captured facts
  // — the Sec-GPC header we put on the wire and a field the site published — which is why
  // these sit in the 30s and not lower. They are CONTEXT, not accusations, and must sort
  // below gpp-conflict and the cookie findings: a contradiction the site's own string
  // carries internally is a stronger claim than the two of us disagreeing.
  GPC_SENT_GPP_FIELD_NO: 37,
  GPC_NOT_SENT_GPP_FIELD_YES: 38,

  // 40s — attribution-dependent
  SIGNAL_NOT_READ: 40, // no script read the property (only when read tracking is active)
  VENDOR_READ_GPC: 41, // attributable __gpp call from this vendor's own script
  VENDOR_DID_NOT_READ_GPC: 42, // this vendor's own script ran, no such call observed
  // vendor-gpc-unread-via-container / -unattributable sit in this band, not in the 10s
  // "response header" band: they rely on the container-wide call count, the same
  // attribution dependency as everything else here, not a captured header.
  VENDOR_GPC_UNREAD_VIA_CONTAINER: 44, // page's container(s) made zero GPC-bearing calls
  VENDOR_GPC_CHECK_UNATTRIBUTABLE: 45, // page's container(s) made calls; which tag, unknown

  // 50s — DOM text heuristics
  CONFIRMATION_NOT_DETECTED: 50,
} as const;
