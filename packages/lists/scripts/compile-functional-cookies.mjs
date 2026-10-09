#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Compiles the list of functional cookie names: the Open Cookie Database at a recorded
 * commit, filtered to infrastructure providers and corrected by this project's overlay
 * (src/functional-overlay.ts). Run at a release, beside the Disconnect refresh; the
 * compiled output is what ships. A BUILD step, never runtime: the extension downloads
 * nothing, and its only request of its own stays the site's published GPC file.
 *
 *   npm run build                       the overlay is read from dist/
 *   npm run compile-functional-cookies  reads the database at the commit the overlay records
 *     --commit <sha>    read another commit, to see what a refresh would change. Writes
 *                       nothing: move DATABASE.commit and DATABASE.csvBlob in the overlay
 *                       to the values printed, then compile again
 *     --csv <path>      read a copy on disk in place of the network; it must hash to the
 *                       blob the overlay records
 *
 * WHAT IT CHECKS BEFORE IT WRITES (Apache-2.0; NOTICE in this package states the
 * obligations):
 *
 *   - the CSV is the one the overlay records, by its git blob;
 *   - the database's LICENSE is still the Apache License 2.0. If it has changed, stop at
 *     the last Apache-2.0 commit;
 *   - the database has no NOTICE file and no copyright line. If it gains either, this
 *     stops: they have to be carried (section 4(c) and 4(d)), which is a change to
 *     NOTICE in this package that a person makes.
 *
 * WHAT IT WRITES. data/likely-functional-cookies.json: names, how each matches, the
 * provider, the database's category, and where the entry came from. NOT the database's
 * descriptions: many are copied from sites' own cookie notices, which the database's
 * license cannot relicense, and the popup quotes none of them. The file says of itself
 * that it is filtered and corrected (section 4(b)) and carries the source's commit, hash
 * and license notice.
 *
 * WHAT IT PRINTS, for the person who reviews the diff:
 *
 *   1. entries added, removed or changed since the last compile;
 *   2. names the overlay adds that the database now has, to take out of the overlay;
 *   3. entries of providers outside the filter that read like infrastructure, as
 *      candidates for it.
 *
 * `version` is the date the list last changed, not the date this script ran: compiled
 * again to the same entries from the same source, it keeps its version.
 */

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMain } from "./is-main.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "data", "likely-functional-cookies.json");

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

/** RFC 4180: quoted fields, doubled quotes, line breaks inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

/** The entries the filter and the overlay yield from the database's rows, by name. */
export function compileEntries(rows, overlay) {
  const { TAKEN, TAKEN_CATEGORIES, EXCLUDED, ADDED } = overlay;
  const rules = new Map(TAKEN.map((r) => [r.platform, r]));
  const entries = new Map();
  const excluded = [];
  for (const row of rows) {
    const rule = rules.get(row["Platform"]);
    const name = row["Cookie / Data Key name"];
    if (rule === undefined || name === "") continue;
    if (!TAKEN_CATEGORIES.includes(row["Category"])) continue;
    if (rule.names !== undefined && !rule.names.includes(name)) continue;
    if (EXCLUDED.some((x) => x.platform === row["Platform"] && x.name === name)) {
      excluded.push(name);
      continue;
    }
    if (entries.has(name)) continue;
    entries.set(name, {
      name,
      match: row["Wildcard match"] === "1" ? "prefix" : "exact",
      provider: rule.provider,
      category: row["Category"],
      source: { kind: "ocd", id: row["ID"] },
    });
  }
  // An exclusion that matched nothing is one the database no longer needs, or a name
  // misspelled here. Either way a person should know.
  const unmatched = EXCLUDED.filter((x) => !excluded.includes(x.name)).map((x) => x.name);

  const inDatabase = new Set(rows.map((r) => r["Cookie / Data Key name"]));
  const nowUpstream = [];
  for (const a of ADDED) {
    if (inDatabase.has(a.name)) nowUpstream.push(a.name);
    // The database's entry wins where the filter took it: the addition was the stand-in.
    if (entries.has(a.name)) continue;
    entries.set(a.name, { name: a.name, match: a.match, provider: a.provider, source: { kind: "provider", url: a.url } });
  }
  return {
    entries: [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    unmatchedExclusions: unmatched,
    nowUpstream,
  };
}

const INFRASTRUCTURE = /load.?balanc|sticky|stickiness|affinity|bot (management|protection|detection|mitigation)|firewall|\bwaf\b|ddos|reverse proxy/i;

/** Entries of providers outside the filter whose own text reads like infrastructure. */
export function candidates(rows, overlay) {
  const taken = new Set(overlay.TAKEN.map((r) => r.platform));
  return rows
    .filter((r) => !taken.has(r["Platform"]) && overlay.TAKEN_CATEGORIES.includes(r["Category"]))
    .filter((r) => INFRASTRUCTURE.test(r["Description"]) || INFRASTRUCTURE.test(r["Platform"]))
    .map((r) => `${r["Platform"]}: ${r["Cookie / Data Key name"]}`);
}

export function gitBlob(buf) {
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

export async function fetched(url, { optional = false } = {}) {
  const res = await fetch(url);
  if (res.status === 404 && optional) return null;
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * The database at `raw` (its raw-file base URL) is still the Apache License 2.0, with no
 * copyright line and no NOTICE file to carry. Throws otherwise. The owner's list reads the
 * same database and makes the same checks (compile-owner-cookies.mjs).
 */
export async function checkDatabaseLicense(raw) {
  const license = (await fetched(`${raw}/LICENSE`)).toString("utf8");
  if (!/Apache License/.test(license) || !/Version 2\.0, January 2004/.test(license)) {
    throw new Error("the database's LICENSE is no longer the Apache License 2.0: stop at the last commit that is");
  }
  const owned = license.split("\n").filter((l) => /^\s*Copyright\b/.test(l) && !/\[yyyy\]/.test(l));
  if (owned.length > 0) {
    throw new Error(`the database's LICENSE has a copyright line, which has to be carried in NOTICE: ${owned[0].trim()}`);
  }
  if ((await fetched(`${raw}/NOTICE`, { optional: true })) !== null) {
    throw new Error("the database has a NOTICE file, which has to be carried in NOTICE (Apache-2.0, 4(d))");
  }
}

async function main() {
  let overlay;
  try {
    overlay = await import(pathToFileURL(join(here, "..", "dist", "functional-overlay.js")).href);
  } catch {
    throw new Error("the overlay is read from dist/functional-overlay.js: run `npm run build` first");
  }
  const { DATABASE, MODIFIED } = overlay;
  const commit = arg("--commit") ?? DATABASE.commit;
  const pinned = commit === DATABASE.commit;
  const raw = `https://raw.githubusercontent.com/${DATABASE.repository.replace("https://github.com/", "")}/${commit}`;

  const local = arg("--csv");
  const csv = local !== undefined ? await readFile(local) : await fetched(`${raw}/${DATABASE.file}`);
  const blob = gitBlob(csv);
  if (pinned && blob !== DATABASE.csvBlob) {
    throw new Error(`${DATABASE.file} is blob ${blob}; the overlay records ${DATABASE.csvBlob} for commit ${commit}`);
  }

  // The license, and what would have to be carried with the data.
  await checkDatabaseLicense(raw);

  const rows = parseCsv(csv.toString("utf8"));
  const { entries, unmatchedExclusions, nowUpstream } = compileEntries(rows, overlay);

  let previous = null;
  try {
    previous = JSON.parse((await readFile(outPath)).toString());
  } catch {
    /* the first compile has nothing to compare against */
  }
  const before = new Map((previous?.entries ?? []).map((e) => [e.name, JSON.stringify(e)]));
  const after = new Map(entries.map((e) => [e.name, JSON.stringify(e)]));
  const added = [...after.keys()].filter((n) => !before.has(n));
  const removed = [...before.keys()].filter((n) => !after.has(n));
  const changed = [...after.keys()].filter((n) => before.has(n) && before.get(n) !== after.get(n));

  const sha256 = createHash("sha256").update(csv).digest("hex");
  const same =
    previous !== null &&
    typeof previous.version === "string" &&
    previous.sources?.[0]?.sha256 === sha256 &&
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
    entries,
  };

  const fromDatabase = entries.filter((e) => e.source.kind === "ocd").length;
  console.log(`database            : ${rows.length} entries at ${commit.slice(0, 7)}, blob ${blob}`);
  console.log(`names               : ${entries.length} (${fromDatabase} from the database, ${entries.length - fromDatabase} added)`);
  console.log(`since last compile  : ${added.length} added, ${removed.length} removed, ${changed.length} changed`);
  for (const n of added) console.log(`  + ${n}`);
  for (const n of removed) console.log(`  - ${n}`);
  for (const n of changed) console.log(`  ~ ${n}`);
  console.log(`additions now in the database, to take out of the overlay: ${nowUpstream.length === 0 ? "none" : nowUpstream.join(", ")}`);
  console.log(`exclusions that matched nothing: ${unmatchedExclusions.length === 0 ? "none" : unmatchedExclusions.join(", ")}`);
  const maybe = candidates(rows, overlay);
  console.log(`candidates outside the filter: ${maybe.length === 0 ? "none" : ""}`);
  for (const c of maybe) console.log(`  ? ${c}`);

  if (!pinned) {
    console.log(`\nNothing written: ${commit} is not the commit the overlay records.`);
    console.log(`To move to it, set DATABASE.commit to "${commit}" and DATABASE.csvBlob to "${blob}", build, and compile again.`);
    return;
  }
  await writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`\nlikely-functional-cookies.json written, version ${output.version}${same ? " (kept: nothing changed)" : ""}`);
}

// Run as a script, and importable for its parts by the tests.
if (isMain(import.meta.url)) {
  await main();
}
