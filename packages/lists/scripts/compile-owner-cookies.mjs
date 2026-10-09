#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Compiles the list of container owners' cookie names: the Open Cookie Database at the
 * commit the functional list already pins, filtered to the names each tag manager's owner
 * writes and corrected by this project's overlay (src/owner-overlay.ts). Run at a release,
 * beside the functional list; the compiled output is what ships. A BUILD step, never
 * runtime: the extension downloads nothing.
 *
 *   npm run build                  the overlay is read from dist/
 *   npm run compile-owner-cookies  reads the database at the commit the overlay records
 *     --csv <path>   read a copy on disk in place of the network; it must hash to the
 *                    blob the overlay records
 *
 * WHAT IT CHECKS BEFORE IT WRITES, the functional list's checks (compile-functional-cookies.mjs):
 * the CSV is the recorded blob, the database's LICENSE is still the Apache License 2.0,
 * and it has no NOTICE file and no copyright line. And its own: every name the overlay
 * takes is in the database under the platform it names, and every name has a category
 * the engine knows and a source.
 *
 * WHAT IT WRITES. data/container-owner-cookies.json: the owner of each manager, and per
 * name how it matches, its owner, its category in the engine's names, and where it came
 * from. NOT the database's descriptions, for the reason the functional list gives. The
 * file says of itself that it is filtered and corrected, and carries the source's commit,
 * hash and license notice.
 *
 * WHAT IT PRINTS, for the person who reviews the diff: entries added, removed or changed
 * since the last compile, and additions the database now has, to take out of the overlay.
 *
 * `version` is the date the list last changed, not the date this script ran.
 */

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMain } from "./is-main.mjs";
import { parseCsv, gitBlob, fetched, checkDatabaseLicense } from "./compile-functional-cookies.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "data", "container-owner-cookies.json");

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

/** The entries the overlay yields from the database's rows, sorted by owner and name. */
export function compileOwnerEntries(rows, overlay) {
  const { TAKEN, ADDED, CATEGORY_OF } = overlay;
  const entries = new Map();
  const keyOf = (owner, name) => `${owner}\u0000${name}`;
  const missing = [];
  for (const rule of TAKEN) {
    for (const name of rule.names) {
      const row = rows.find((r) => r["Platform"] === rule.platform && r["Cookie / Data Key name"] === name);
      if (row === undefined) {
        missing.push(`${rule.platform}: ${name}`);
        continue;
      }
      entries.set(keyOf(rule.owner, name), {
        name,
        match: row["Wildcard match"] === "1" && !(rule.exact ?? []).includes(name) ? "prefix" : "exact",
        owner: rule.owner,
        category: CATEGORY_OF[row["Category"]] ?? "unknown",
        source: { kind: "ocd", id: row["ID"] },
      });
    }
  }
  // An addition the database now files under one of its owner's platforms. One it files
  // under another company (Segment's names under Trustpilot) is not that.
  const platformsOf = (owner) => new Set(TAKEN.filter((r) => r.owner === owner).map((r) => r.platform));
  const nowUpstream = [];
  for (const a of ADDED) {
    const mine = platformsOf(a.owner);
    if (rows.some((r) => r["Cookie / Data Key name"] === a.name && mine.has(r["Platform"]))) nowUpstream.push(a.name);
    // The database's entry wins where the overlay took it: the addition was the stand-in.
    if (entries.has(keyOf(a.owner, a.name))) continue;
    entries.set(keyOf(a.owner, a.name), {
      name: a.name,
      match: a.match,
      owner: a.owner,
      category: a.category,
      source: { kind: "provider", url: a.url },
    });
  }
  const sorted = [...entries.values()].sort((a, b) =>
    a.owner !== b.owner ? (a.owner < b.owner ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return { entries: sorted, missing, nowUpstream };
}

/** The owner of each manager, in the manager's order. */
export function ownersOf(overlay) {
  return Object.fromEntries(Object.entries(overlay.OWNERS).map(([manager, o]) => [manager, o.owner]));
}

async function main() {
  let overlay;
  try {
    overlay = await import(pathToFileURL(join(here, "..", "dist", "owner-overlay.js")).href);
  } catch {
    throw new Error("the overlay is read from dist/owner-overlay.js: run `npm run build` first");
  }
  const { DATABASE, MODIFIED } = overlay;
  const commit = DATABASE.commit;
  const raw = `https://raw.githubusercontent.com/${DATABASE.repository.replace("https://github.com/", "")}/${commit}`;

  const local = arg("--csv");
  const csv = local !== undefined ? await readFile(local) : await fetched(`${raw}/${DATABASE.file}`);
  const blob = gitBlob(csv);
  if (blob !== DATABASE.csvBlob) {
    throw new Error(`${DATABASE.file} is blob ${blob}; the overlay records ${DATABASE.csvBlob} for commit ${commit}`);
  }
  await checkDatabaseLicense(raw);

  const rows = parseCsv(csv.toString("utf8"));
  const { entries, missing, nowUpstream } = compileOwnerEntries(rows, overlay);
  if (missing.length > 0) {
    throw new Error(`the overlay takes names the database does not have under that platform: ${missing.join(", ")}`);
  }

  let previous = null;
  try {
    previous = JSON.parse((await readFile(outPath)).toString());
  } catch {
    /* the first compile has nothing to compare against */
  }
  const id = (e) => `${e.owner}\u0000${e.name}`;
  const before = new Map((previous?.entries ?? []).map((e) => [id(e), JSON.stringify(e)]));
  const after = new Map(entries.map((e) => [id(e), JSON.stringify(e)]));
  const added = [...after.keys()].filter((n) => !before.has(n));
  const removed = [...before.keys()].filter((n) => !after.has(n));
  const changed = [...after.keys()].filter((n) => before.has(n) && before.get(n) !== after.get(n));
  const owners = ownersOf(overlay);

  const sha256 = createHash("sha256").update(csv).digest("hex");
  const same =
    previous !== null &&
    typeof previous.version === "string" &&
    previous.sources?.[0]?.sha256 === sha256 &&
    JSON.stringify(previous.owners) === JSON.stringify(owners) &&
    added.length + removed.length + changed.length === 0;
  const output = {
    version: same ? previous.version : new Date().toISOString().slice(0, 10),
    modified: MODIFIED,
    sources: [
      {
        name: DATABASE.name,
        repository: DATABASE.repository,
        file: DATABASE.file,
        commit,
        sha256,
        license: DATABASE.license,
        notice: `Open Cookie Database, ${DATABASE.repository}, licensed under the Apache License, Version 2.0 (${DATABASE.licenseUrl}). The repository carries no copyright line and no NOTICE file at this commit.`,
      },
    ],
    owners,
    entries,
  };

  const show = (k) => k.replace("\u0000", ": ");
  const fromDatabase = entries.filter((e) => e.source.kind === "ocd").length;
  console.log(`database            : ${rows.length} entries at ${commit.slice(0, 7)}, blob ${blob}`);
  console.log(`names               : ${entries.length} (${fromDatabase} from the database, ${entries.length - fromDatabase} added)`);
  console.log(`since last compile  : ${added.length} added, ${removed.length} removed, ${changed.length} changed`);
  for (const n of added) console.log(`  + ${show(n)}`);
  for (const n of removed) console.log(`  - ${show(n)}`);
  for (const n of changed) console.log(`  ~ ${show(n)}`);
  console.log(`additions now in the database, to take out of the overlay: ${nowUpstream.length === 0 ? "none" : nowUpstream.join(", ")}`);

  await writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`\ncontainer-owner-cookies.json written, version ${output.version}${same ? " (kept: nothing changed)" : ""}`);
}

// Run as a script, and importable for its parts by the tests.
if (isMain(import.meta.url)) {
  await main();
}
