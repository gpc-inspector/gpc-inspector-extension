// SPDX-License-Identifier: GPL-3.0-only
/**
 * Which GPP section speaks for a string that carries several: one choice, made here, read by
 * the gpc-vs-gpp rule, by the popup's mirror of that rule and by the decoded GPP row, so the
 * row never shows one section while the mismatch note under it judged another.
 *
 * The case two choices get wrong: a string carrying usca {Gpc: 0} and usnat {Gpc: 1,
 * SaleOptOut: 1}, with the signal sent. A row that prefers usnat (it states an opt-out) shows
 * "GPC field: yes"; a rule that takes the first section with a Gpc field takes usca, and the
 * note under that same row says the two do not match.
 */

import type { GppSectionFields } from "@gpc-inspector/schema";

/**
 * The us-state sections by API prefix: usnat and the state sections, ids 7 to 27. The only
 * sections that carry SaleOptOut / SharingOptOut / TargetedAdvertisingOptOut and the GPC
 * sub-section. uspv1 carries an opt-out in its own encoding and no GPC field; the TCF
 * sections carry neither. The popup's iab-registry.ts names the same set, and a test holds
 * the two together.
 */
export const US_STATE_GPP_SECTIONS: ReadonlySet<string> = new Set([
  "usnat", "usca", "usva", "usco", "usut", "usct", "usfl", "usmt", "usor", "ustx",
  "usde", "usia", "usne", "usnh", "usnj", "ustn", "usmn", "usmd", "usin", "usky", "usri",
]);

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

/** The fields whose value states an opt-out choice: 1 opted out, 2 did not. */
const OPT_OUT_FIELDS = ["SaleOptOut", "SharingOptOut", "TargetedAdvertisingOptOut"] as const;

/**
 * The section that speaks for the string, or null when it carries no us-state section.
 *
 * Only a us-state section is eligible: the row this feeds reports an opt-out state and a GPC
 * field, and no other kind can express either. Among those, prefer one that states an opt-out
 * (a field at 1 or 2), then one carrying a Gpc field, then the first.
 *
 * Sorted by name before any preference applies. Object key order follows insertion, which
 * follows whichever consent tool built the object, and the engine has to decide the same way
 * on every run (PRD FR-21).
 */
export function primaryGppSection(
  sections: Readonly<Record<string, GppSectionFields>>,
): [string, GppSectionFields] | null {
  const eligible = Object.entries(sections)
    .filter(([name]) => US_STATE_GPP_SECTIONS.has(currentGppSectionName(name)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const first = eligible[0];
  if (first === undefined) return null;
  return (
    eligible.find(([, f]) => OPT_OUT_FIELDS.some((k) => f[k] === 1 || f[k] === 2)) ??
    eligible.find(([, f]) => f.Gpc !== undefined) ??
    first
  );
}
