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
 * Judged in the applicable section only (gpp-section.ts), the one the site's consent tool
 * specifies and the popup's GPP row displays, so one finding at most. A conflict in another
 * section the string carries is not reported: no vendor is told to read that section, and a
 * notice about it would sit above a row showing a section without one.
 *
 * The artifact carries the section name and the exact field values, so a skeptic re-decodes
 * the raw string and checks.
 */

import type { Finding, ObservationSet } from "@gpc-inspector/schema";
import { RANK } from "../ranks.js";
import { primaryGppSection } from "../gpp-section.js";

/** Fields that, at value 2 (did-not-opt-out) beside Gpc=1, constitute the conflict. */
const OPT_OUT_FIELDS = [
  "SaleOptOut",
  "SharingOptOut",
  "TargetedAdvertisingOptOut",
] as const;

export function gppConflict(obs: ObservationSet): Finding[] {
  const gpp = obs.gpp;
  if (!gpp || gpp.unparseable) return [];

  const applicable = primaryGppSection(gpp);
  if (applicable === null) return [];
  const { name: sectionName, fields } = applicable;
  if (fields.Gpc !== 1) return [];

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

  if (!hasConflict) return [];

  return [
    {
      flag: "gpp-conflict",
      rank: RANK.GPP_CONFLICT,
      entity: null, // site-level: this is the site's own broadcast, not a vendor's
      artifact: {
        kind: "gpp-field",
        section: sectionName,
        fields: conflicting,
      },
    },
  ];
}
