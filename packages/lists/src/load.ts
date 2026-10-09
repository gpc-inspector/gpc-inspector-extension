// SPDX-License-Identifier: GPL-3.0-only
/**
 * Loading the compiled list.
 *
 * Kept separate from the classifier so the classifier itself stays pure and injectable —
 * it takes data, it does not fetch data. This module is the one place that knows where
 * the JSON lives, which means the extension (which imports the JSON directly at
 * build time) and the Node test harness (which reads from disk) can each do the right
 * thing without the classifier caring. The Public Suffix List is the exception: it is a
 * published standard, and public-suffix.ts imports it itself (see there).
 */

import { DisconnectClassifier } from "./classifier.js";
import type { CompiledList, Override } from "./classifier.js";
import { LOCAL_OVERRIDES } from "./overrides.js";

/** Validate the shape of a parsed compiled list before trusting it. */
export function loadCompiledList(raw: unknown): CompiledList {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("compiled list: not an object");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o["version"] !== "string") throw new Error("compiled list: missing version");
  if (typeof o["domains"] !== "object" || o["domains"] === null) {
    throw new Error("compiled list: missing domains");
  }
  if (typeof o["entities"] !== "object" || o["entities"] === null) {
    throw new Error("compiled list: missing entities");
  }
  if (!Array.isArray(o["sources"])) throw new Error("compiled list: missing sources");
  return raw as CompiledList;
}

/** Build a classifier from a parsed compiled list plus the bundled overrides. */
export function loadDefaultClassifier(
  raw: unknown,
  extraOverrides: readonly Override[] = [],
): DisconnectClassifier {
  const list = loadCompiledList(raw);
  return new DisconnectClassifier(list, [...LOCAL_OVERRIDES, ...extraOverrides]);
}
