// SPDX-License-Identifier: GPL-3.0-only
/**
 * The classifier the harness's popup uses: the real compiled list, plus the fictional
 * vendors of the store screenshots (fictional-vendors.mjs). build.mjs substitutes this
 * module for src/background/classifier.ts in the harness bundle only, and the
 * harness-fixtures tests classify with it, so a fixture is held to exactly what the frame
 * draws. Every real domain classifies as the shipped extension classifies it: the
 * fictional entries are all on the reserved .example TLD, which the list does not carry.
 */

import { loadDefaultClassifier } from "@gpc-inspector/lists";
import compiledList from "@gpc-inspector/lists/data/compiled-list.json" with { type: "json" };
import { FICTIONAL_VENDORS } from "./fictional-vendors.mjs";

export { getFunctionalCookies, getOwnerCookies, getOwnerNames } from "../src/background/classifier.ts";

let cached = null;

/** The real list with the fictional vendors added. Built on first use. */
export function getClassifier() {
  if (cached === null) cached = loadDefaultClassifier(compiledList, FICTIONAL_VENDORS);
  return cached;
}
