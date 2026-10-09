#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Compiles the Public Suffix List (data/public_suffix_list.dat) into the rules the
 * registrable-domain resolver reads (data/public-suffix-list.json). Run offline, as the
 * Disconnect compiler is: the compiled output is what ships.
 *
 * The list is a published standard, maintained at https://publicsuffix.org, and nothing
 * here decides anything about it. Every rule is carried as the list writes it, in both of
 * its sections: the ICANN section (country and generic top-level registries) and the
 * private section (suffixes that companies run for their customers, such as myshopify.com
 * or cloudfront.net). Chrome applies both when it decides whether a site may set a cookie
 * on a domain, and so does the extension.
 *
 * Two conversions, neither a judgment:
 *   - A rule written in Unicode (公司.cn) is converted to the ASCII form a hostname arrives
 *     in (xn--55qx5d.cn), with Node's own IDNA conversion.
 *   - Each rule is lowercased and trimmed, and the list's comments are dropped.
 *
 * Output: { version, commit, source, license, notice, icann: [...], private: [...] }.
 * `notice` is the list's own license header, verbatim, so it travels with the data into
 * the extension's bundles.
 *
 * To update: download https://publicsuffix.org/list/public_suffix_list.dat (the list asks
 * to be pulled from there and nowhere else) over data/public_suffix_list.dat, run
 * `npm run compile-public-suffix -w @gpc-inspector/lists`, and commit both files.
 */

import { readFile, writeFile } from "node:fs/promises";
import { domainToASCII } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");
const SOURCE = "https://publicsuffix.org/list/public_suffix_list.dat";

/** The compiled list, from the text of public_suffix_list.dat. */
export function compilePublicSuffixList(text) {
  // A CRLF checkout (`* text=auto` on Windows) compiles to the same file.
  const lines = text.split(/\r?\n/);

  const version = /^\/\/ VERSION: (\S+)/m.exec(text)?.[1];
  const commit = /^\/\/ COMMIT: (\S+)/m.exec(text)?.[1];
  if (!version || !commit) throw new Error("public_suffix_list.dat: no VERSION or COMMIT line");

  // The license header: the leading comment block, up to the first blank line.
  const notice = [];
  for (const line of lines) {
    if (!line.startsWith("//")) break;
    notice.push(line.replace(/^\/\/ ?/, ""));
  }
  if (!notice.join(" ").includes("Mozilla Public")) throw new Error("public_suffix_list.dat: the license header has changed");

  const sections = { icann: [], private: [] };
  let section = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.includes("===BEGIN ICANN DOMAINS===")) section = "icann";
    else if (line.includes("===BEGIN PRIVATE DOMAINS===")) section = "private";
    else if (line.includes("===END")) section = null;
    if (line === "" || line.startsWith("//") || section === null) continue;
    const rule = line.split(/\s/)[0].toLowerCase();
    // A rule's leading "!" (an exception) or "*." (a wildcard) is kept; the rest is a name.
    const prefix = rule.startsWith("!") ? "!" : rule.startsWith("*.") ? "*." : "";
    const name = rule.slice(prefix.length);
    const ascii = /^[\x00-\x7f]*$/.test(name) ? name : domainToASCII(name);
    if (ascii === "") throw new Error(`public_suffix_list.dat: cannot convert rule ${rule}`);
    sections[section].push(prefix + ascii);
  }
  if (sections.icann.length === 0 || sections.private.length === 0) throw new Error("public_suffix_list.dat: a section is empty");

  return {
    version,
    commit,
    source: SOURCE,
    license: "MPL-2.0",
    notice: notice.join("\n"),
    icann: [...new Set(sections.icann)].sort(),
    private: [...new Set(sections.private)].sort(),
  };
}

async function main() {
  const out = compilePublicSuffixList(await readFile(join(dataDir, "public_suffix_list.dat"), "utf8"));
  await writeFile(join(dataDir, "public-suffix-list.json"), `${JSON.stringify(out, null, 0)}\n`);
  console.log(`public-suffix-list.json: ${out.icann.length} ICANN rules, ${out.private.length} private, version ${out.version}`);
}

// Run as a script, and importable for its parts by the tests.
if (isMain(import.meta.url)) {
  await main();
}
