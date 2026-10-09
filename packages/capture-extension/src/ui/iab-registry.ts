// SPDX-License-Identifier: GPL-3.0-only
/**
 * IAB registry data: GPP section names and TCF purpose names.
 *
 * These are DEFINED TERMS published by the IAB, not copy we wrote, so they live here as
 * data rather than in `_locales`. Two reasons, and the second is the load-bearing one:
 *
 *  1. They are identifiers. "US - California" is a row in the GPP Section ID registry the
 *     same way `usca` is; translating one and not the other would be arbitrary.
 *  2. A translator paraphrasing "Use limited data to select advertising" would silently
 *     change what the CMP said. The whole point of showing purpose names instead of
 *     `purpose 2: granted` is that the name is the CMP's own claim — a reworded claim is a
 *     different claim, and this product does not restate a site's assertions in its own
 *     words.
 *
 * Both tables are lookups, never inference: an id we do not recognize renders as the bare
 * id rather than a guess. A section reported under the name it had before the IAB renamed
 * it is looked up under its current name (the engine's LEGACY_GPP_SECTION_NAMES).
 *
 * Sources, both verified against the published tables rather than recalled:
 *   https://github.com/InteractiveAdvertisingBureau/Global-Privacy-Platform
 *     /blob/main/Sections/Section%20Information.md
 *   IAB TCF v2.2 purpose list.
 */

import { currentGppSectionName } from "@gpc-inspector/engine";

/**
 * GPP Section IDs, by the API prefix the CMP reports in `parsedSections`.
 *
 * Note that the numbering is easy to get wrong from memory and expensive to get wrong
 * here: section 8 is California and 9 is Virginia, not the other way round. A mislabeled
 * section would attribute a site's opt-out state to the wrong state's law.
 */
/**
 * What a section is capable of expressing.
 *
 * Load-bearing, as a real capture shows: news-f.example broadcasts
 * `tcfeuv2 ~ tcfcav1 ~ uspv1` and no US state section at all. Picking a section without
 * regard to kind would mean showing a reader in California the Canadian TCF section, then
 * reporting that consent section's lack of opt-out fields as "no opt-out recorded" — while
 * the same string's `uspv1` section said `1YY-`, opted out of sale.
 *
 *   "us-state"  usnat and the state sections. Carry SaleOptOut/SharingOptOut/
 *               TargetedAdvertisingOptOut AND the GPC sub-section. The only sections that
 *               can answer either question this row asks.
 *   "us-legacy" uspv1. Carries an opt-out, in its own four-character encoding, and has no
 *               GPC field. Surfaced in its own USP row rather than decoded twice here.
 *   "consent"   the TCF sections. GDPR and Canadian consent records: no US opt-out concept
 *               and no GPC field, so their silence on both is not a fact about the site.
 */
export type GppSectionKind = "us-state" | "us-legacy" | "consent";

export const GPP_SECTIONS: Readonly<
  Record<string, { id: number; name: string; kind: GppSectionKind }>
> = {
  tcfeuv1: { id: 1, name: "EU TCF v1", kind: "consent" },
  tcfeuv2: { id: 2, name: "EU TCF v2", kind: "consent" },
  header: { id: 3, name: "GPP header", kind: "consent" },
  tcfcav1: { id: 5, name: "Canada TCF", kind: "consent" },
  uspv1: { id: 6, name: "US Privacy", kind: "us-legacy" },
  usnat: { id: 7, name: "US - National", kind: "us-state" },
  usca: { id: 8, name: "US - California", kind: "us-state" },
  usva: { id: 9, name: "US - Virginia", kind: "us-state" },
  usco: { id: 10, name: "US - Colorado", kind: "us-state" },
  usut: { id: 11, name: "US - Utah", kind: "us-state" },
  usct: { id: 12, name: "US - Connecticut", kind: "us-state" },
  usfl: { id: 13, name: "US - Florida", kind: "us-state" },
  usmt: { id: 14, name: "US - Montana", kind: "us-state" },
  usor: { id: 15, name: "US - Oregon", kind: "us-state" },
  ustx: { id: 16, name: "US - Texas", kind: "us-state" },
  usde: { id: 17, name: "US - Delaware", kind: "us-state" },
  usia: { id: 18, name: "US - Iowa", kind: "us-state" },
  usne: { id: 19, name: "US - Nebraska", kind: "us-state" },
  usnh: { id: 20, name: "US - New Hampshire", kind: "us-state" },
  usnj: { id: 21, name: "US - New Jersey", kind: "us-state" },
  ustn: { id: 22, name: "US - Tennessee", kind: "us-state" },
  usmn: { id: 23, name: "US - Minnesota", kind: "us-state" },
  usmd: { id: 24, name: "US - Maryland", kind: "us-state" },
  usin: { id: 25, name: "US - Indiana", kind: "us-state" },
  usky: { id: 26, name: "US - Kentucky", kind: "us-state" },
  usri: { id: 27, name: "US - Rhode Island", kind: "us-state" },
};

/** Reverse lookup, for `applicableSections` — which carries ids, not prefixes. */
const BY_ID: ReadonlyMap<number, { prefix: string; name: string }> = new Map(
  Object.entries(GPP_SECTIONS).map(([prefix, s]) => [s.id, { prefix, name: s.name }]),
);

/**
 * Only a us-state section can carry an opt-out field or a GPC sub-section. Takes an API
 * prefix or an `applicableSections` id, like gppSectionName.
 */
export function gppSectionKind(key: string | number): GppSectionKind | null {
  const prefix = typeof key === "number" ? BY_ID.get(key)?.prefix : currentGppSectionName(key);
  return prefix === undefined ? null : (GPP_SECTIONS[prefix]?.kind ?? null);
}

/**
 * Human-readable name for a GPP section, from either surface.
 *
 * `parsedSections` is keyed by API prefix ("usca"); `applicableSections` carries numeric
 * ids (8). Both reach the UI, so both resolve here — and an unknown value returns null so
 * the caller can render what it actually has rather than inventing a state name.
 */
export function gppSectionName(key: string | number): string | null {
  if (typeof key === "number") return BY_ID.get(key)?.name ?? null;
  return GPP_SECTIONS[currentGppSectionName(key)]?.name ?? null;
}

/** Section id for an API prefix, so the row can show "US - California (8)". */
export function gppSectionId(prefix: string): number | null {
  return GPP_SECTIONS[currentGppSectionName(prefix)]?.id ?? null;
}

/**
 * IAB TCF v2.2 purpose names, verbatim.
 *
 * Shown instead of "purpose 3: denied", which is accurate and tells a reader nothing. The
 * numbering is the CMP's own; we only supply the name that goes with it.
 */
export const TCF_PURPOSES: Readonly<Record<string, string>> = {
  "1": "Store and/or access information on a device",
  "2": "Use limited data to select advertising",
  "3": "Create profiles for personalised advertising",
  "4": "Use profiles to select personalised advertising",
  "5": "Create profiles to personalise content",
  "6": "Use profiles to select personalised content",
  "7": "Measure advertising performance",
  "8": "Measure content performance",
  "9": "Understand audiences through statistics or combinations of data from different sources",
  "10": "Develop and improve services",
  "11": "Use limited data to select content",
};

/** Name for a TCF purpose id, or null when the CMP reports one we have no name for. */
export function tcfPurposeName(id: string): string | null {
  return TCF_PURPOSES[id] ?? null;
}
