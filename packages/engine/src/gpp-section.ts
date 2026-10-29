// SPDX-License-Identifier: GPL-3.0-only
/**
 * Which GPP section speaks for a string that carries several: the applicable section. One
 * choice, made here, read by the gpc-vs-gpp rule, by the gpp-conflict rule, by the popup's
 * mirror of the first and by the decoded GPP row and the vendor Read GPC lines, so no two of
 * them judge different sections of the same string.
 *
 * The site's consent tool says which section applies, and the choice is its own. The IAB
 * CMP API Specification defines PingReturn `applicableSections` as the "Section ID
 * considered to be in force for this transaction", set by the CMP: up to two ids, and [-1]
 * when none applies. A section the string carries that the CMP did not name is not the one
 * in force, whatever its fields say.
 *
 * When the CMP names none, or names two the string carries, a state section is taken over
 * the national one. The IAB MSPA Technical Signaling Implementation Guidelines (3.3): a
 * first party encodes a state section when it determined the user's state of residency, and
 * usnat when it treats the user as national, so a state section is the narrower statement.
 *
 * No choice reads the fields. A rule that preferred the section stating an opt-out, or
 * carrying a Gpc field, would let the string's contents pick which of its sections is
 * judged, and a site could not tell in advance which one a reader would be shown.
 */

import type { GppObservation, GppSectionFields } from "@gpc-inspector/schema";

/**
 * The us-state sections by API prefix, with their GPP section ids: usnat (7) and the state
 * sections, 8 to 27. The only sections that carry SaleOptOut / SharingOptOut /
 * TargetedAdvertisingOptOut and the GPC sub-section. uspv1 carries an opt-out in its own
 * encoding and no GPC field; the TCF sections carry neither. The popup's iab-registry.ts
 * names the same sections and ids, and a test holds the two together.
 */
export const US_STATE_GPP_SECTION_IDS: Readonly<Record<string, number>> = {
  usnat: 7, usca: 8, usva: 9, usco: 10, usut: 11, usct: 12, usfl: 13, usmt: 14, usor: 15,
  ustx: 16, usde: 17, usia: 18, usne: 19, usnh: 20, usnj: 21, ustn: 22, usmn: 23, usmd: 24,
  usin: 25, usky: 26, usri: 27,
};

/** The us-state sections by API prefix: the keys of US_STATE_GPP_SECTION_IDS. */
export const US_STATE_GPP_SECTIONS: ReadonlySet<string> = new Set(Object.keys(US_STATE_GPP_SECTION_IDS));

/** The id of usnat, the one us-state section that is not a state's. */
const USNAT_ID = 7;

/**
 * The names six us-state sections had before the IAB reference library dropped "v1" from
 * them (iabgpp-es 7f802c6, July 2024, released in 3.1.2). A consent tool built on an older
 * library still reports these in `parsedSections` (streaming-e.example sends `usnatv1`, verified
 * 2026-10-02), and the section is the same one: same id, same fields.
 */
export const LEGACY_GPP_SECTION_NAMES: Readonly<Record<string, string>> = {
  usnatv1: "usnat",
  uscav1: "usca",
  usvav1: "usva",
  uscov1: "usco",
  usutv1: "usut",
  usctv1: "usct",
};

/** A section's current API prefix: its own name, or the one a legacy name was renamed to. */
export function currentGppSectionName(name: string): string {
  return LEGACY_GPP_SECTION_NAMES[name] ?? name;
}

/** The section the string's readers judge, and whether the consent tool specified it. */
export interface ApplicableGppSection {
  /** The section's name as the string carries it, which may be a pre-rename name. */
  readonly name: string;
  readonly fields: GppSectionFields;
  /**
   * True when `applicableSections` names exactly one us-state section the string carries
   * and this is it. False when the choice fell back: none named, two named, or only sections
   * the string lacks.
   */
  readonly specified: boolean;
}

/** The us-state section id of a carried section's name, or null for any other kind. */
export function usStateGppSectionId(name: string): number | null {
  return US_STATE_GPP_SECTION_IDS[currentGppSectionName(name)] ?? null;
}

/**
 * The applicable section, or null when the string carries no us-state section.
 *
 * Only a us-state section is eligible: the row this feeds reports an opt-out state and a GPC
 * field, and no other kind can express either. A carried section with no decoded fields is
 * still carried.
 *
 * Exactly one carried section whose id `applicableSections` names: that one. Otherwise a
 * state section over usnat, then the lowest id, then the name, so the engine decides the same
 * way on every run whatever order the consent tool built the object in (PRD FR-21).
 */
export function primaryGppSection(
  gpp: Pick<GppObservation, "sections" | "applicableSections">,
): ApplicableGppSection | null {
  const carried = Object.entries(gpp.sections)
    .flatMap(([name, fields]) => {
      const id = usStateGppSectionId(name);
      return id === null ? [] : [{ name, fields, id }];
    })
    .sort(
      (a, b) =>
        Number(a.id === USNAT_ID) - Number(b.id === USNAT_ID) ||
        a.id - b.id ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
  const named = carried.filter((s) => gpp.applicableSections.includes(s.id));
  const only = named.length === 1 ? named[0] : undefined;
  if (only !== undefined) return { name: only.name, fields: only.fields, specified: true };
  const first = carried[0];
  return first === undefined ? null : { name: first.name, fields: first.fields, specified: false };
}
