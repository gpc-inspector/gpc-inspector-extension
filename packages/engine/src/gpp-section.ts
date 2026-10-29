// SPDX-License-Identifier: GPL-3.0-only
/**
 * Which sections of a GPP string apply: the consent tool's statement, read here, once, for
 * the gpc-vs-gpp and gpp-conflict rules, the popup's mirror of the first, the decoded GPP
 * row and the vendor Read GPC lines, so no two of them judge different sections of the same
 * string. The extension does not choose a section for the site: where the specification and
 * the IAB's published practice do not settle which section applies, the answer is none, and
 * the popup says why.
 *
 * Sources:
 *
 *   IAB Global Privacy Platform, Core/CMP API Specification.md, PingReturn: applicableSections
 *   is the "Section ID considered to be in force for this transaction", set by the CMP. It
 *   should hold a single id, and "may contain up to 2 values" when one cannot be determined.
 *   "[-1]" means no section applies. 0 is the stub's value before the CMP loads, or one a
 *   publisher presets, and the IAB reference library (iabgpp-es CmpApiContext) reports []
 *   until the CMP calls its setter.
 *
 *   IAB Global Privacy Platform, implementation.md 1.4: "only one section should be sent in
 *   a given string". 3.4: the CMP determines which section applies "and should be read by
 *   vendors". IAB MSPA Technical Signaling Implementation Guidelines v1.3, 3.3: a first party
 *   encodes one section for a transaction.
 *
 * So a string carrying a single US section, with nothing specified, is read under the
 * one-section practice; a string carrying two, with nothing specified, has no section this
 * extension can call applicable. No case reads the fields: a rule that preferred the section
 * stating an opt-out, or carrying a Gpc field, would let the string's contents pick which of
 * its sections is judged.
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

/** The us-state section id of a section's name, current or pre-rename, or null for any other kind. */
export function usStateGppSectionId(name: string): number | null {
  return US_STATE_GPP_SECTION_IDS[currentGppSectionName(name)] ?? null;
}

/**
 * Why the applicable sections are what they are.
 *
 *   "specified"      applicableSections names one or two us-state sections the string carries
 *   "only-section"   nothing specified (empty, or 0), and the string carries one us-state
 *                    section: the one-section practice
 *   "none-applies"   applicableSections is [-1]: the site specified that no section applies
 *   "unspecified"    nothing specified, and the string carries two or more us-state sections
 *   "not-carried"    applicableSections names a us-state section, and the string carries no
 *                    named us-state section
 *   "not-us"         applicableSections names sections, none of them a us-state section (a
 *                    TCF section, or uspv1)
 *
 * The last four have no applicable us-state section.
 */
export type GppApplicableBasis = "specified" | "only-section" | "none-applies" | "unspecified" | "not-carried" | "not-us";

export interface ApplicableGppSections {
  /** The applicable us-state sections, by section id, each under the name the string carries. */
  readonly sections: readonly (readonly [string, GppSectionFields])[];
  readonly basis: GppApplicableBasis;
}

/** Every us-state section the string carries, by section id, then name. */
export function carriedUsStateGppSections(
  sections: GppObservation["sections"],
): { readonly name: string; readonly fields: GppSectionFields; readonly id: number }[] {
  return Object.entries(sections)
    .flatMap(([name, fields]) => {
      const id = usStateGppSectionId(name);
      return id === null ? [] : [{ name, fields, id }];
    })
    .sort((a, b) => a.id - b.id || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The applicable us-state sections of a string, or null when it carries none.
 *
 * "Carried" means the string has the section, decoded, with or without fields. Only
 * us-state sections count: the row this feeds reports an opt-out state and a GPC field, and
 * no other kind can express either.
 */
export function applicableGppSections(
  gpp: Pick<GppObservation, "sections" | "applicableSections">,
): ApplicableGppSections | null {
  const carried = carriedUsStateGppSections(gpp.sections);
  if (carried.length === 0) return null;
  const named = new Set(gpp.applicableSections.filter((id) => id > 0));
  const applicable = carried.filter((s) => named.has(s.id));
  if (applicable.length > 0) {
    return { sections: applicable.map((s) => [s.name, s.fields] as const), basis: "specified" };
  }
  if (named.size > 0) {
    // Named sections, and no us-state section the string carries among them: a named
    // us-state section is missing from the string, or every named section is another kind.
    const usIds = new Set(Object.values(US_STATE_GPP_SECTION_IDS));
    return { sections: [], basis: [...named].some((id) => usIds.has(id)) ? "not-carried" : "not-us" };
  }
  if (gpp.applicableSections.includes(-1)) return { sections: [], basis: "none-applies" };
  const only = carried.length === 1 ? carried[0] : undefined;
  return only !== undefined
    ? { sections: [[only.name, only.fields]], basis: "only-section" }
    : { sections: [], basis: "unspecified" };
}
