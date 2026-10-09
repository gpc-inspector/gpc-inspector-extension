#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Add a capture from a corpus run as a regression fixture.
 *
 *   node fixtures/corpus/add-fixture.mjs <run directory> <host> [name]
 *   npx vitest run corpus-replay -u      # writes <name>.expected.json; review its diff
 *
 * Copies <run>/<host>.obs.json (already redacted by the runner: cookie values, Cookie and
 * Authorization headers and query strings masked) to <captures>/<name>.json with request
 * and response headers dropped. <captures> is the folder CORPUS_CAPTURES names, an absolute
 * path or one relative to the repository root, and fixtures/corpus/captures when it names
 * none: the folder corpus-replay.test.ts reads. Neither the engine nor the popup's view model
 * reads them, and they are most of a capture's size. Before writing, the engine's findings
 * and counts are computed with and without them, and the copy is refused if they differ,
 * so a rule that starts reading headers makes this script say so instead of silently
 * producing fixtures that no longer exercise it.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluate,
  countDistinctCookiesSetWithSignal,
  countDistinctCookiesSetWithoutSignal,
  countAdTechRequests,
} from "../../packages/engine/dist/index.js";
import { loadDefaultClassifier, loadOwnerCookies } from "../../packages/lists/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const [runDir, host, name = host] = process.argv.slice(2);
if (!runDir || !host) {
  console.error("usage: node fixtures/corpus/add-fixture.mjs <run directory> <host> [name]");
  process.exit(1);
}

const obs = JSON.parse(await readFile(resolve(runDir, `${host}.obs.json`), "utf8"));
const trimmed = {
  ...obs,
  network: obs.network.map((n) => ({ ...n, requestHeaders: [], responseHeaders: n.responseHeaders === null ? null : [] })),
};

const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
const classifier = loadDefaultClassifier(await readJson(join(root, "packages/lists/data/compiled-list.json")));
// The container owners' cookie names, as the extension reads them (background/classifier.ts).
const ownerList = loadOwnerCookies(await readJson(join(root, "packages/lists/data/container-owner-cookies.json")));
const owners = {
  match(manager, name) {
    const e = ownerList.entryFor(manager, name);
    return e === null ? null : { entity: { name: e.owner, id: e.owner.toLowerCase() }, category: e.category };
  },
};
const outcome = (o) =>
  JSON.stringify({
    findings: evaluate(o, classifier, owners),
    signed: countDistinctCookiesSetWithSignal(o, classifier, owners),
    unsigned: countDistinctCookiesSetWithoutSignal(o, classifier, owners),
    adTech: countAdTechRequests(o, classifier),
  });
if (outcome(obs) !== outcome(trimmed)) {
  console.error(`${host}: the engine's output changes without headers; keep them or teach this script which ones matter.`);
  process.exit(1);
}

const captures = resolve(root, process.env["CORPUS_CAPTURES"] || "fixtures/corpus/captures");
await mkdir(captures, { recursive: true });
const out = join(captures, `${name}.json`);
const text = JSON.stringify(trimmed, null, 1) + "\n";
await writeFile(out, text);
console.log(`wrote ${out} (${Math.round(text.length / 1024)} KB, was ${Math.round(JSON.stringify(obs, null, 1).length / 1024)} KB)`);
