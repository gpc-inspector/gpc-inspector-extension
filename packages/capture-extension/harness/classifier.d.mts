// SPDX-License-Identifier: GPL-3.0-only
import type { DisconnectClassifier } from "@gpc-inspector/lists";

/** The real list plus the store screenshots' fictional vendors (classifier.mjs). */
export function getClassifier(): DisconnectClassifier;
export { getFunctionalCookies, getOwnerCookies, getOwnerNames } from "../src/background/classifier.js";
