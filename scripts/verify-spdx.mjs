#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Verify every source file opens with its SPDX-License-Identifier line.
 *
 * The line is how a file lifted out of the repository still shows its license (see the
 * README, Licensing). Adding it by hand is easy to forget, so the check runs with the rest
 * of `npm run check` and in CI.
 *
 * The line is the first line of the file, or the second after a shebang. It reads
 * `GPL-3.0-only` except where EXCEPTIONS says otherwise.
 *
 * Usage: node scripts/verify-spdx.mjs
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const ROOTS = ["packages", "scripts", "fixtures"];
const EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-ext", "dist-harness", "data", ".cert", ".git"]);
const LICENSE = "GPL-3.0-only";

/**
 * Files whose identifier is not the default, with why. None: public-suffix.ts reads the
 * Public Suffix List from data/, which this check skips (MPL-2.0, see packages/lists/NOTICE).
 */
const EXCEPTIONS = {};

async function walk(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(path, out);
    } else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(path);
    }
  }
}

const files = [];
for (const root of ROOTS) await walk(join(ROOT, root), files);
// Source files at the top level (vitest.config.ts), without walking node_modules.
for (const entry of await readdir(ROOT, { withFileTypes: true })) {
  if (entry.isFile() && EXTENSIONS.some((ext) => entry.name.endsWith(ext))) files.push(join(ROOT, entry.name));
}

const wrong = [];
for (const file of files.sort()) {
  const name = relative(ROOT, file).split(sep).join("/");
  const lines = (await readFile(file, "utf8")).split("\n", 2);
  const line = lines[0]?.startsWith("#!") ? lines[1] : lines[0];
  const expected = `// SPDX-License-Identifier: ${EXCEPTIONS[name] ?? LICENSE}`;
  if (line !== expected) wrong.push(`  ${name}: expected "${expected}"`);
}

if (wrong.length > 0) {
  console.error(`spdx: ${wrong.length} file(s) without the identifier line:\n${wrong.join("\n")}`);
  process.exit(1);
}
console.log(`spdx: clean (${files.length} files).`);
