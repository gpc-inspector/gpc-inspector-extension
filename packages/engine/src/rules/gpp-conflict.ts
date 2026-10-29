// SPDX-License-Identifier: GPL-3.0-only
/**
 * gpp-conflict — the flagship finding (PRD FR-12, §2).
 *
 * The IAB's own MSPA Technical Signaling guidance describes a GPP string containing
 * Gpc=1 (browser had GPC enabled) alongside SaleOptOut=2 (consumer did NOT opt out of
 * sale) as "conflicting Signals." We report exactly those fields, from the site's own
 * broadcast, with the industry's own document as the reference. No interpretation.
 *
 * IAB field encoding: 0 = N/A, 1 = opted out, 2 = did NOT opt out.
 * The conflict is: Gpc === 1 AND any of {SaleOptOut, SharingOptOut,
 * TargetedAdvertisingOptOut} === 2, within the SAME section.
 *
 * One finding per applicable section that exhibits the conflict (gpp-section.ts): the
 * sections the site's consent tool specifies, which the popup's GPP row displays. A conflict
 * in a section that is not applicable is not reported, because no vendor is told to read it,
 * and a string with no applicable section gives no finding.
 *
 * The artifact carries the section name and the exact field values, so a skeptic re-decodes
 * the raw string and checks.
 */

import type { Finding, ObservationSet } from "@gpc-inspector/schema";
import { RANK } from "../ranks.js";
import { applicableGppSections } from "../gpp-section.js";

/** Fields that, at value 2 (did-not-opt-out) beside Gpc=1, constitute the conflict. */
const OPT_OUT_FIELDS = [
  "SaleOptOut",
  "SharingOptOut",
  "TargetedAdvertisingOptOut",
] as const;

export function gppConflict(obs: ObservationSet): Finding[] {
  const gpp = obs.gpp;
  if (!gpp || gpp.unparseable) return [];

  const findings: Finding[] = [];

  for (const [sectionName, fields] of applicableGppSections(gpp)?.sections ?? []) {
    if (fields.Gpc !== 1) continue;

    // Collect the specific did-not-opt-out fields present in this section.
    const conflicting: Record<string, number> = { Gpc: 1 };
    let hasConflict = false;
    for (const field of OPT_OUT_FIELDS) {
      const v = fields[field];
      if (v === 2) {
        conflicting[field] = 2;
        hasConflict = true;
      }
    }

    if (!hasConflict) continue;

    findings.push({
      flag: "gpp-conflict",
      rank: RANK.GPP_CONFLICT,
      entity: null, // site-level: this is the site's own broadcast, not a vendor's
      artifact: {
        kind: "gpp-field",
        section: sectionName,
        fields: conflicting,
      },
    });
  }

  return findings;
}
