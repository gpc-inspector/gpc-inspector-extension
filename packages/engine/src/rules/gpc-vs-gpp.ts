// SPDX-License-Identifier: GPL-3.0-only
/**
 * gpc-vs-gpp — the signal this browser sent, against what the site's GPP string records.
 *
 * WHY THIS IS CONTEXT AND NOT AN ACCUSATION
 *
 * A GPP string carries a `Gpc` field: the site's consent tool recording whether it saw the
 * Global Privacy Control signal. That field can disagree with what we actually sent, in
 * either direction. Without this rule the popup would show "GPC signal is set" at the top
 * and "GPC field: no" three rows below and leave the reader to notice.
 *
 * It stays context because the innocent readings are real and common. A consent tool can
 * load before the property exists, read it in a frame we never reached, take the signal
 * only from the Sec-GPC request header (which we cannot see it do), or rebuild its string
 * from a value stored on an earlier visit. None of that is a fact about the site's intent,
 * and a finding asserting otherwise would be the accusation this product exists not to
 * make. What IS reportable is the disagreement itself: a reader — or a vendor, or another
 * extension — acting on one of these two values is not acting on the other.
 *
 * TWO DIRECTIONS
 *
 *   gpc-sent-gpp-field-no        we sent the signal; the string records Gpc = 0.
 *                                Also the case that hides the flagship: gpp-conflict needs
 *                                Gpc = 1, so a string that never registered us cannot
 *                                exhibit the conflict at all.
 *   gpc-not-sent-gpp-field-yes   we sent nothing; the string records Gpc = 1. Usually a
 *                                string kept from a previous visit.
 *
 * WHAT IS DELIBERATELY NOT A CASE
 *
 * A string with NO `Gpc` field. That is silence, not a statement, and the great majority of
 * strings are silent — reporting it would fire on nearly every GPP site and say nothing.
 *
 * BOTH SENT-SURFACES ARE REQUIRED, not either. A consent tool can consult the property or
 * the request header, and firing on one while the other disagreed would decide a
 * two-mechanism question from one mechanism.
 */

import type { Finding, ObservationSet, PropertyValue } from "@gpc-inspector/schema";
import { RANK } from "../ranks.js";
import { applicableGppSections } from "../gpp-section.js";

/**
 * The applicable sections' `Gpc` fields (gpp-section.ts): the sections the popup's GPP row
 * displays, one comparison each. Reading any other section would let the row say "GPC field:
 * yes" while the note under it said the field disagreed with the signal. A section with no
 * `Gpc` field is silent here, and a string with no applicable section is silent throughout,
 * even if a section it carries has a `Gpc` field, because no vendor is told to read it.
 */
function gpcFields(obs: ObservationSet): { section: string; value: 0 | 1 }[] {
  const gpp = obs.gpp;
  if (!gpp || gpp.unparseable) return [];
  return (applicableGppSections(gpp)?.sections ?? []).flatMap(([section, fields]): { section: string; value: 0 | 1 }[] =>
    fields.Gpc === 0 || fields.Gpc === 1 ? [{ section, value: fields.Gpc }] : [],
  );
}

export function gpcVsGpp(obs: ObservationSet): Finding[] {
  const sig = obs.signal;
  const propertyValue: PropertyValue = sig.propertyValue;
  const sentOnWire = sig.secGpcRequestCount > 0;
  const sentOnProperty = propertyValue === true;

  return gpcFields(obs).flatMap((field): Finding[] => {
    const artifact = {
      kind: "gpc-vs-gpp",
      section: field.section,
      gpcField: field.value,
      propertyValue,
      secGpcRequestCount: sig.secGpcRequestCount,
    } as const;

    if (sentOnProperty && sentOnWire && field.value === 0) {
      return [
        {
          flag: "gpc-sent-gpp-field-no",
          rank: RANK.GPC_SENT_GPP_FIELD_NO,
          entity: null, // site-level: this is the site's own string against our own signal
          artifact,
        },
      ];
    }

    if (!sentOnProperty && !sentOnWire && field.value === 1) {
      return [
        {
          flag: "gpc-not-sent-gpp-field-yes",
          rank: RANK.GPC_NOT_SENT_GPP_FIELD_YES,
          entity: null,
          artifact,
        },
      ];
    }

    return [];
  });
}
