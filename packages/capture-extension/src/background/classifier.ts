// SPDX-License-Identifier: GPL-3.0-only
/**
 * The classifier instance for the extension (PRD FR-17, D3).
 *
 * The engine takes classification as an injected input and holds no list data itself.
 * This module is where the extension supplies it: the compiled Disconnect index is
 * imported at BUILD time (esbuild inlines the JSON), never fetched — MV3 forbids remote
 * code, and a runtime fetch would be both a policy problem and a network egress the
 * privacy posture does not permit.
 *
 * Loaded lazily and cached. The index is ~385KB of JSON and parsing it on every service
 * worker wake would blow the performance budget (NFR-1); building the lookup maps once
 * per worker lifetime and letting them die with the worker is the right trade, since a
 * terminated worker had nothing to classify anyway.
 */

import {
  DisconnectClassifier,
  loadDefaultClassifier,
  loadFunctionalCookies,
  loadOwnerCookies,
  type FunctionalCookies,
  type OwnerCookies,
} from "@gpc-inspector/lists";
import type { OwnerNames } from "@gpc-inspector/engine";
import compiledList from "@gpc-inspector/lists/data/compiled-list.json" with { type: "json" };
import functionalList from "@gpc-inspector/lists/data/likely-functional-cookies.json" with { type: "json" };
import ownerList from "@gpc-inspector/lists/data/container-owner-cookies.json" with { type: "json" };

let cached: DisconnectClassifier | null = null;
let cachedFunctional: FunctionalCookies | null = null;
let cachedOwners: OwnerCookies | null = null;
let cachedOwnerNames: OwnerNames | null = null;

/**
 * The list of functional cookie names, compiled from the Open Cookie Database and
 * imported at build time like the classification list. It labels a counted cookie and
 * changes no count: only the popup asks it anything.
 */
export function getFunctionalCookies(): FunctionalCookies {
  if (cachedFunctional === null) cachedFunctional = loadFunctionalCookies(functionalList);
  return cachedFunctional;
}

/**
 * The list of the names each tag manager's owner writes (1.25.0), compiled from the Open
 * Cookie Database and the providers' own pages and imported at build time like the other
 * two. A cookie written inside a container counts only when this list gives its name to the
 * container's owner.
 */
export function getOwnerCookies(): OwnerCookies {
  if (cachedOwners === null) cachedOwners = loadOwnerCookies(ownerList);
  return cachedOwners;
}

/**
 * The owner's list as the engine asks it: an owner's entry as a company, spelled as the
 * classification list spells it, with the id the classifier would give that company.
 */
export function getOwnerNames(): OwnerNames {
  if (cachedOwnerNames === null) {
    const owners = getOwnerCookies();
    cachedOwnerNames = {
      match(manager, cookieName) {
        const entry = owners.entryFor(manager, cookieName);
        return entry === null ? null : { entity: { name: entry.owner, id: entry.owner.toLowerCase() }, category: entry.category };
      },
    };
  }
  return cachedOwnerNames;
}

/** The shared classifier. Built on first use, then reused for this worker's lifetime. */
export function getClassifier(): DisconnectClassifier {
  if (cached === null) {
    cached = loadDefaultClassifier(compiledList);
  }
  return cached;
}

/** Provenance for the evidence bundle (FR-23). */
export function getListProvenance(): { source: string; version: string; hash: string } {
  return getClassifier().provenance;
}
