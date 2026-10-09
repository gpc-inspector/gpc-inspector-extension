// SPDX-License-Identifier: GPL-3.0-only
/**
 * Disconnect's services.json, read the way the compiler reads it: every hostname with the
 * set of upstream categories it appears under, and the same for its listed parents.
 *
 * For tests that hold the compiled list to what Disconnect actually says, rather than to a
 * named domain that may move between list releases. A test on doubleclick.net breaks when
 * Disconnect moves doubleclick.net; a test over every domain breaks only when the compiler
 * disagrees with the data.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Disconnect's categories that describe a technique rather than a recipient. Never shown. */
export const TECHNIQUE_CATEGORIES: ReadonlySet<string> = new Set([
  "FingerprintingInvasive",
  "FingerprintingGeneral",
  "Cryptomining",
]);

/** The two Disconnect categories the headline counts. */
export const COUNTED_CATEGORIES: ReadonlySet<string> = new Set(["Advertising", "Analytics"]);

/**
 * The engine's name for a Disconnect category: the same name, lower case, words joined by
 * hyphens. Written out here rather than imported from the compiler, so the tests state the
 * rule the compiler's table has to follow instead of repeating the table.
 */
export function engineName(disconnectCategory: string): string {
  return disconnectCategory.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

/** Every category name services.json uses. */
export function upstreamCategoryNames(): string[] {
  return Object.keys(readServices().categories).sort();
}

/** The categories services.json uses that say whom the data is for: the ones shown. */
export function upstreamPurposeNames(): string[] {
  return upstreamCategoryNames().filter((c) => !TECHNIQUE_CATEGORIES.has(c));
}

interface Services {
  readonly categories: Readonly<Record<string, readonly Readonly<Record<string, Readonly<Record<string, unknown>>>>[]>>;
}

function readServices(): Services {
  return JSON.parse(readFileSync(join(here, "..", "data", "services.json"), "utf8")) as Services;
}

/** hostname -> the upstream categories it is listed under, lower-cased, path entries skipped. */
export function upstreamCategories(): Map<string, Set<string>> {
  const services = readServices();
  const out = new Map<string, Set<string>>();
  for (const [category, entries] of Object.entries(services.categories)) {
    for (const entry of entries) {
      for (const sites of Object.values(entry)) {
        for (const domains of Object.values(sites)) {
          if (!Array.isArray(domains)) continue;
          for (const domain of domains as string[]) {
            if (domain.includes("/") || domain.includes(":")) continue;
            const d = domain.toLowerCase();
            const set = out.get(d) ?? new Set<string>();
            set.add(category);
            out.set(d, set);
          }
        }
      }
    }
  }
  return out;
}

/**
 * The categories that apply to a host in Disconnect's own matching: its own entry and every
 * listed parent's, since a listed domain covers the hosts under it.
 */
export function applicableCategories(host: string, upstream: Map<string, Set<string>>): Set<string> {
  const out = new Set<string>();
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    for (const c of upstream.get(labels.slice(i).join(".")) ?? []) out.add(c);
  }
  return out;
}

/** The purposes that apply to a host: `applicableCategories` without the techniques. */
export function applicablePurposes(host: string, upstream: Map<string, Set<string>>): Set<string> {
  return new Set([...applicableCategories(host, upstream)].filter((c) => !TECHNIQUE_CATEGORIES.has(c)));
}

/** Hosts for which a technique is all Disconnect says, on the host or any listed parent. */
export function techniqueOnlyHosts(upstream: Map<string, Set<string>> = upstreamCategories()): string[] {
  return [...upstream.keys()]
    .filter((host) => {
      const cats = applicableCategories(host, upstream);
      return cats.size > 0 && [...cats].every((c) => TECHNIQUE_CATEGORIES.has(c));
    })
    .sort();
}
