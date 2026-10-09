#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Verify the working tree matches SOURCE_FILES.txt.
 *
 * A change applied from an archive can add or overwrite a file but cannot delete one, so a
 * file removed upstream lingers locally: still compiled, still referencing symbols that no
 * longer exist. Such an orphan can pass `npm run check` locally, because tsc's incremental
 * build info considers the project current, and fail only in CI on a clean checkout.
 *
 * This gate closes that gap by asking a question tsc cannot: not "does everything here
 * compile" but "is everything here supposed to be here".
 *
 * Two failure directions, both reported:
 *   ORPHANED — present locally, absent from the manifest. Usually a file deleted upstream.
 *   MISSING  — in the manifest, absent locally. Usually an incomplete unzip.
 *
 * Usage:
 *   node scripts/verify-manifest.mjs           # check
 *   node scripts/verify-manifest.mjs --update  # rewrite the manifest from the tree
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const MANIFEST = "SOURCE_FILES.txt";
const ROOTS = ["packages", "scripts"];
const EXTENSIONS = [".ts", ".mjs"];

/** Directories that never contain checked-in source. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-ext",
  // Build output of `npm run harness`, rebuilt from source every run — same status as
  // dist-ext, and it contains a copy of the harness's own .mjs files.
  "dist-harness",
  "data",
  ".git",
]);

const HEADER = `# Authoritative list of source files.
#
# A change applied from an archive can add or overwrite a file but cannot delete one, so a
# file removed upstream lingers locally, still compiled and still referencing symbols that
# no longer exist. Such an orphan can pass local checks and fail only in CI.
#
# Verified by \`npm run check\`. To regenerate after intentionally adding or removing files:
#   node scripts/verify-manifest.mjs --update
#
`;

async function walk(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // a root that does not exist yet is not an error
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full, out);
    } else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      // Normalize separators so the manifest is identical on every platform.
      out.push(relative(process.cwd(), full).split(sep).join("/"));
    }
  }
  return out;
}

async function currentFiles() {
  const found = [];
  for (const root of ROOTS) await walk(root, found);
  return found.sort();
}

async function manifestFiles() {
  const text = await readFile(MANIFEST, "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .sort();
}

const files = await currentFiles();

if (process.argv.includes("--update")) {
  await writeFile(MANIFEST, HEADER + files.join("\n") + "\n");
  console.log(`manifest: updated with ${files.length} files`);
  process.exit(0);
}

let expected;
try {
  expected = await manifestFiles();
} catch {
  console.error(`manifest: ${MANIFEST} is missing. Create it with --update.`);
  process.exit(1);
}

const expectedSet = new Set(expected);
const foundSet = new Set(files);

const orphaned = files.filter((f) => !expectedSet.has(f));
const missing = expected.filter((f) => !foundSet.has(f));

if (orphaned.length === 0 && missing.length === 0) {
  console.log(`manifest: clean (${files.length} files).`);
  process.exit(0);
}

if (orphaned.length > 0) {
  console.error("\nmanifest: ORPHANED — present locally but not in the manifest.");
  console.error("These were probably deleted upstream; an archive cannot delete a file.");
  for (const f of orphaned) console.error(`  rm ${f}`);
}

if (missing.length > 0) {
  console.error("\nmanifest: MISSING — in the manifest but not on disk.");
  console.error("Probably an incomplete unzip.");
  for (const f of missing) console.error(`  ${f}`);
}

console.error("\nIf the change was intentional: node scripts/verify-manifest.mjs --update\n");
process.exit(1);
