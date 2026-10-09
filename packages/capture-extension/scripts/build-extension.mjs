#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Bundles the extension into packages/capture-extension/dist-ext/, loadable unpacked.
 *
 * Why a bundler: the service worker and content scripts import from
 * @gpc-inspector/schema and /engine, and Chrome cannot resolve workspace packages.
 * esbuild inlines them. MV3 forbids remote code, so everything must be present at load
 * time — bundling is how that requirement is satisfied, not a convenience.
 *
 * Build-time only; nothing from esbuild ships inside the extension.
 */

import { build } from "esbuild";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePackages } from "./compile-packages.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const out = join(pkg, "dist-ext");

// The bundle inlines the packages' compiled output, so compile it first. See
// compile-packages.mjs for what a stale dist/ breaks.
compilePackages();

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// legalComments "inline" keeps the /*! */ notes next to the wrapper lines that
// chrome://extensions shows as the stack frame of a page's own errors (see
// observe/script-insertion.ts). esbuild strips every other comment from the bundle.
const common = { bundle: true, target: "chrome114", logLevel: "warning", legalComments: "inline" };

await build({
  ...common,
  format: "esm",
  entryPoints: [join(pkg, "src/background/sw.ts")],
  outfile: join(out, "sw.js"),
});

// Content scripts cannot be ES modules in Chrome; emit IIFEs. The last four are registered
// dynamically by the worker, by setting (see applySettingsScripts), rather than declared.
for (const name of ["main-world", "bridge", "main-world-assert", "main-world-trace-all", "main-world-insertion", "main-world-seal"]) {
  await build({
    ...common,
    format: "iife",
    entryPoints: [join(pkg, `src/content/${name}.ts`)],
    outfile: join(out, `${name}.js`),
  });
}

// Popup bundle. A module script in the popup can import workspace packages only if
// bundled, same as the worker.
await build({
  ...common,
  format: "esm",
  entryPoints: [join(pkg, "src/ui/popup.ts")],
  outfile: join(out, "popup.js"),
});

// Static assets, copied verbatim.
await cp(join(pkg, "public/manifest.json"), join(out, "manifest.json"));
await cp(join(pkg, "public/popup.html"), join(out, "popup.html"));
await cp(join(pkg, "public/popup.css"), join(out, "popup.css"));
await cp(join(pkg, "public/_locales"), join(out, "_locales"), { recursive: true });
// A message's description is a note for translators. Chrome never reads it, so the
// shipped messages.json leaves it out; the source keeps it.
for (const locale of await readdir(join(pkg, "public/_locales"))) {
  const messages = JSON.parse(await readFile(join(pkg, "public/_locales", locale, "messages.json"), "utf8"));
  for (const entry of Object.values(messages)) delete entry.description;
  await writeFile(join(out, "_locales", locale, "messages.json"), JSON.stringify(messages, null, 2) + "\n");
}
// Rendered by scripts/icons.mjs and committed; the build never rasterizes.
await cp(join(pkg, "public/icons"), join(out, "icons"), { recursive: true });

// The license files, so the built extension carries its own notices. The compiled list is
// inlined into sw.js, and CC BY-NC-SA 4.0 requires Disconnect's copyright notice, the
// license reference, the warranty disclaimer and a link to the list to be retained wherever
// the data is shared. The data package's two files keep their names under lists/, which is
// where the root NOTICE says to look. LICENSE is the GPL text for the code; the Apache-2.0
// text covers the Open Cookie Database compile, and the MPL-2.0 text the Public Suffix List,
// each at the path both NOTICE files give.
const repo = join(pkg, "..", "..");
await cp(join(repo, "LICENSE"), join(out, "LICENSE"));
await cp(join(repo, "NOTICE"), join(out, "NOTICE"));
await mkdir(join(out, "LICENSES"), { recursive: true });
await cp(join(repo, "LICENSES/Apache-2.0.txt"), join(out, "LICENSES/Apache-2.0.txt"));
await cp(join(repo, "LICENSES/MPL-2.0.txt"), join(out, "LICENSES/MPL-2.0.txt"));
await mkdir(join(out, "lists"), { recursive: true });
await cp(join(repo, "packages/lists/LICENSE"), join(out, "lists/LICENSE"));
await cp(join(repo, "packages/lists/NOTICE"), join(out, "lists/NOTICE"));

console.log(`Extension built: ${out}`);
console.log("Load via chrome://extensions -> Developer mode -> Load unpacked");
