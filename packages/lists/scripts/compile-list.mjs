#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Compiles Disconnect's services.json + entities.json into a single flat lookup index
 * (PRD FR-17). Run offline; the compiled output is what ships. This is a BUILD step, not
 * runtime — MV3 forbids remote code, and parsing 780KB of nested JSON on every page load
 * would blow the performance budget (NFR-1).
 *
 * Three things in the upstream data this compiler resolves, all discovered by inspecting
 * the actual files rather than assuming:
 *
 * 1. DOMAINS APPEAR IN MULTIPLE CATEGORIES. 343 of 4,468 domains are listed under more
 *    than one category — doubleclick.net is under both "Email" and "Advertising"; 140
 *    domains are in both Advertising and FingerprintingInvasive. "First match wins" would
 *    make classification depend on object iteration order, which is not deterministic
 *    enough to build findings on. We apply an explicit precedence order instead, so the
 *    same domain always resolves to the same category.
 *
 * 2. SOME "DOMAINS" ARE PATH PREFIXES. e.g. "google.com/pagead/1p-user-list". A hostname
 *    lookup can never match those. We record them separately rather than silently
 *    dropping them, so the count is visible and we know what we're not covering.
 *
 * 3. SOME CATEGORIES DESCRIBE A TECHNIQUE, NOT A RECIPIENT. FingerprintingInvasive,
 *    FingerprintingGeneral and Cryptomining say how a domain behaves, and Disconnect
 *    applies them beside a purpose category where it has one. The output carries purposes
 *    only, so a technique category is read for the company it names and for nothing else.
 *    A host listed only under a technique category takes the purpose of a listed parent,
 *    because Disconnect's suffix matching applies the parent's entry to it
 *    (edge.fullstory.com under fullstory.com, Analytics), and no category ("unknown")
 *    when no parent has one.
 *
 * WHAT IS OURS AND WHAT IS NOT. Every category in the output is one Disconnect gives the
 * domain or a listed parent, under Disconnect's own name (CATEGORY_MAP is a one-for-one
 * rename). The rules above are this compiler's: which of several categories wins, that a
 * technique category is left out, and parent inheritance. Nothing else is decided here.
 * packages/lists/test/classifier.test.ts holds the output to Disconnect's data, host by
 * host.
 *
 * Output: data/compiled-list.json — { version, sources, domains: {domain: [entityId, category]},
 * entities: {entityId: name} }. Flat, small, fast to load, hashable for provenance.
 *
 * Each entry in `sources` carries the upstream file's own license notice verbatim
 * (`notice`): the copyright line, the license name with both its URLs, the warranty
 * disclaimer and the exclusion of Disconnect's marks. CC BY-NC-SA 4.0 §3(a)(1)(A) requires
 * every one of those to be retained wherever the data is shared, and this file is what the
 * extension bundles into its worker, so the notice travels inside the data rather than only
 * in NOTICE files a build might not copy.
 *
 * `version` is the date the upstream data was taken, not the date this script ran: when
 * the two source files hash the same as the previous compiled output, the previous version
 * is kept, so recompiling for a compiler change does not re-date a list the popup and the
 * evidence bundle already cite.
 */

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");

/**
 * Category precedence. When a domain appears in several Disconnect categories, the
 * earliest one in this list wins, because a request shows one category.
 *
 * Advertising outranks everything because it is the category that drives the product's
 * central finding, and a domain Disconnect considers advertising is advertising even if
 * it also does email. Analytics is next for the same reason.
 *
 * The technique categories are not in the order, because they are never the result (see
 * TECHNIQUE_CATEGORIES). Ranked above Social, they would be the result for the 13 domains
 * Disconnect lists under Social and a technique category both.
 */
const CATEGORY_PRECEDENCE = [
  "Advertising",
  "Analytics",
  "Social",
  "Email",
  "EmailAggressive",
  "ConsentManagers",
  "Anti-fraud",
  "Content",
];

/**
 * The categories that describe a technique rather than a recipient. Never a domain's
 * category in the output: FingerprintingInvasive, FingerprintingGeneral and Cryptomining
 * say how a domain behaves, not whom the data is for, and the product shows the purpose or
 * none. The company Disconnect names under one is kept.
 */
const TECHNIQUE_CATEGORIES = new Set([
  "FingerprintingInvasive",
  "FingerprintingGeneral",
  "Cryptomining",
]);

/**
 * Disconnect's category names, and the engine's name for each: the same name, lower case,
 * words joined by hyphens. One for one, never merged or renamed. The popup labels a request
 * with this category and credits it to Disconnect, so a category Disconnect does not use
 * would be a misattribution in the product's own voice.
 *
 * Only "advertising" and "analytics" drive a finding or a count; the rest label a request
 * in the Requests tab and nothing more. That line is the product's, drawn in the engine.
 *
 * The technique categories have no entry: see TECHNIQUE_CATEGORIES.
 *
 * A category Disconnect adds later is warned about above, ranked last and compiled as
 * "unknown" until it is added here and to the engine's CATEGORIES, or to
 * TECHNIQUE_CATEGORIES; the classifier tests fail on it, so it cannot go unnoticed.
 */
const CATEGORY_MAP = {
  Advertising: "advertising",
  Analytics: "analytics",
  Social: "social",
  Content: "content",
  Email: "email",
  EmailAggressive: "email-aggressive",
  ConsentManagers: "consent-managers",
  "Anti-fraud": "anti-fraud",
};

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** The `license` string an upstream file carries. A file without one is not one to ship. */
function upstreamNotice(file, name) {
  const notice = file.license;
  if (typeof notice !== "string" || notice.length === 0) {
    throw new Error(`${name}: no upstream license notice found; refusing to compile without it`);
  }
  return notice;
}

/** The previous compiled output, or null when there is none to compare against. */
async function readPrevious(path) {
  try {
    return JSON.parse((await readFile(path)).toString());
  } catch {
    return null;
  }
}

/** A valid hostname for lookup: no slashes, no scheme, at least one dot. */
function isHostname(s) {
  return !s.includes("/") && !s.includes(":") && s.includes(".");
}

/** Stable entity id from a display name. */
function entityId(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** The nearest parent of `domain` listed in services.json, or null. */
function nearestListedParent(domain, best) {
  const labels = domain.split(".");
  for (let i = 1; i < labels.length - 1; i++) {
    const parent = best.get(labels.slice(i).join("."));
    if (parent) return parent;
  }
  return null;
}

async function main() {
  const servicesRaw = await readFile(join(dataDir, "services.json"));
  const entitiesRaw = await readFile(join(dataDir, "entities.json"));

  const services = JSON.parse(servicesRaw.toString());
  const entitiesFile = JSON.parse(entitiesRaw.toString());
  const entities = entitiesFile.entities ?? {};

  const sources = [
    {
      name: "disconnect-services",
      file: "services.json",
      sha256: sha256(servicesRaw),
      license: "CC BY-NC-SA 4.0",
      notice: upstreamNotice(services, "services.json"),
    },
    {
      name: "disconnect-entities",
      file: "entities.json",
      sha256: sha256(entitiesRaw),
      license: "CC BY-NC-SA 4.0",
      notice: upstreamNotice(entitiesFile, "entities.json"),
    },
  ];

  // Same upstream data as last time keeps last time's version (see the header).
  const outPath = join(dataDir, "compiled-list.json");
  const previous = await readPrevious(outPath);
  const previousSources = Array.isArray(previous?.sources) ? previous.sources : [];
  const sameData =
    typeof previous?.version === "string" &&
    sources.every((s) => previousSources.some((p) => p.name === s.name && p.sha256 === s.sha256));
  const version = sameData ? previous.version : new Date().toISOString().slice(0, 10);

  const precedenceRank = new Map(CATEGORY_PRECEDENCE.map((c, i) => [c, i]));

  /** domain -> { org, category, rank } — best (lowest rank) wins. */
  const best = new Map();
  /** domain -> the company Disconnect names for it under a technique category. */
  const techniqueOrg = new Map();
  const skippedPaths = [];
  let totalPairs = 0;

  for (const [category, entries] of Object.entries(services.categories ?? {})) {
    const technique = TECHNIQUE_CATEGORIES.has(category);
    const rank = precedenceRank.has(category)
      ? precedenceRank.get(category)
      : Number.MAX_SAFE_INTEGER;
    if (!technique && !precedenceRank.has(category)) {
      console.warn(`WARN: unknown upstream category "${category}" — ranked last.`);
    }

    for (const entry of entries) {
      for (const [org, sites] of Object.entries(entry)) {
        for (const domains of Object.values(sites)) {
          if (!Array.isArray(domains)) continue;
          for (const domain of domains) {
            totalPairs++;
            if (!isHostname(domain)) {
              skippedPaths.push(domain);
              continue;
            }
            const d = domain.toLowerCase();
            if (technique) {
              // The company only, the first by name so the result never depends on
              // iteration order.
              const seen = techniqueOrg.get(d);
              if (seen === undefined || org < seen) techniqueOrg.set(d, org);
              continue;
            }
            const prev = best.get(d);
            // Lower rank wins. Ties: keep the first seen, but sort deterministically by
            // org name so the result never depends on iteration order.
            if (
              !prev ||
              rank < prev.rank ||
              (rank === prev.rank && org < prev.org)
            ) {
              best.set(d, { org, category, rank });
            }
          }
        }
      }
    }
  }

  // Entity ownership from entities.json: map every property/resource domain to its entity.
  // services.json gives category; entities.json gives the fuller ownership graph.
  const domainToEntity = new Map();
  for (const [name, data] of Object.entries(entities)) {
    const id = entityId(name);
    for (const key of ["properties", "resources"]) {
      for (const domain of data[key] ?? []) {
        if (!isHostname(domain)) continue;
        domainToEntity.set(domain.toLowerCase(), { id, name });
      }
    }
  }

  // Build the flat output.
  const entityNames = {};
  const domainIndex = {};
  let withEntity = 0;

  for (const [domain, info] of best) {
    const mapped = CATEGORY_MAP[info.category] ?? "unknown";
    // Prefer entities.json ownership; fall back to the org name from services.json.
    const ent = domainToEntity.get(domain) ?? {
      id: entityId(info.org),
      name: info.org,
    };
    if (domainToEntity.has(domain)) withEntity++;
    entityNames[ent.id] = ent.name;
    domainIndex[domain] = [ent.id, mapped];
  }

  // A host listed only under a technique category keeps the company Disconnect names and
  // takes the purpose of its nearest listed parent, or none. Disconnect matches by suffix,
  // so the parent's entry applies to the host as well: fullstory.com is Analytics, and
  // edge.fullstory.com (FingerprintingInvasive by name) is a request to an analytics domain
  // in Disconnect's terms, the same as any fullstory.com host the list does not name. The
  // entry is written out, not left to the parent's, so the company is the host's own.
  let techniqueOnly = 0;
  let techniqueOnlyUnderParent = 0;
  for (const [domain, org] of techniqueOrg) {
    if (best.has(domain)) continue;
    const ent = domainToEntity.get(domain) ?? { id: entityId(org), name: org };
    if (domainToEntity.has(domain)) withEntity++;
    entityNames[ent.id] = ent.name;
    const parent = nearestListedParent(domain, best);
    domainIndex[domain] = [ent.id, parent ? (CATEGORY_MAP[parent.category] ?? "unknown") : "unknown"];
    if (parent) techniqueOnlyUnderParent++;
    else techniqueOnly++;
  }

  // Domains known to entities.json but absent from services.json still resolve to an
  // entity — useful for attribution without driving findings. Their category is the one
  // services.json gives the nearest listed parent, since Disconnect's suffix matching
  // applies it to them, and unknown when no parent is listed. The index is searched longest
  // suffix first, so writing "unknown" here would hide the parent's category: apps.fbsbx.com
  // (a Meta property) would read as unclassified under fbsbx.com (Social).
  let entityOnly = 0;
  let entityOnlyUnderParent = 0;
  for (const [domain, ent] of domainToEntity) {
    if (!domainIndex[domain]) {
      entityNames[ent.id] = ent.name;
      const parent = nearestListedParent(domain, best);
      domainIndex[domain] = [ent.id, parent ? (CATEGORY_MAP[parent.category] ?? "unknown") : "unknown"];
      if (parent) entityOnlyUnderParent++;
      else entityOnly++;
    }
  }

  const output = {
    version,
    sources,
    entities: Object.fromEntries(
      Object.entries(entityNames).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    domains: Object.fromEntries(
      Object.entries(domainIndex).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  };

  const serialized = JSON.stringify(output);
  await writeFile(outPath, serialized);

  const byCategory = {};
  for (const [, category] of Object.values(domainIndex)) {
    byCategory[category] = (byCategory[category] ?? 0) + 1;
  }

  console.log("compiled-list.json written");
  console.log(`  version                     : ${version}${sameData ? " (kept: upstream data unchanged)" : " (new upstream data)"}`);
  console.log(`  domain->category pairs seen : ${totalPairs}`);
  console.log(`  unique domains indexed      : ${Object.keys(domainIndex).length}`);
  console.log(`    from services.json        : ${best.size + techniqueOnly + techniqueOnlyUnderParent}`);
  console.log(`    technique-only (no category) : ${techniqueOnly}`);
  console.log(`    technique-only, parent's purpose: ${techniqueOnlyUnderParent}`);
  console.log(`    entity-only (no category) : ${entityOnly}`);
  console.log(`    entity-only, parent's category: ${entityOnlyUnderParent}`);
  console.log(`    with entities.json owner  : ${withEntity}`);
  console.log(`  distinct entities           : ${Object.keys(entityNames).length}`);
  console.log(`  by category                 : ${Object.entries(byCategory).sort().map(([c, n]) => `${c} ${n}`).join(", ")}`);
  console.log(`  skipped path-style entries  : ${skippedPaths.length}`);
  if (skippedPaths.length) {
    console.log(`    e.g. ${skippedPaths.slice(0, 3).join(", ")}`);
  }
  console.log(`  output size                 : ${(serialized.length / 1024).toFixed(0)} KB`);
  console.log(`  output sha256               : ${sha256(serialized)}`);
}

await main();
