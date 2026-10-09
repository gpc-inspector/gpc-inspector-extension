#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Measure provenance on real pages.
 *
 *   node fixtures/provenance/launch.mjs --real      # a throwaway Chrome, extension loaded
 *   node fixtures/provenance/measure.mjs https://www.news-f.example/ https://www.apparel-c.example/
 *
 * For each URL: open it in the throwaway Chrome, wait for the page to settle, read the
 * worker's tab state over DevTools, run the engine's resolveLoaders with the real
 * classifier offline, and print per entity what the records resolved to. It prints the
 * numbers; nothing is persisted.
 */
import { createRequire } from "node:module";
import { expandInsertions } from "../../packages/capture-extension/dist/background/insertions.js";
import { resolveLoaders, checksByContainer } from "../../packages/engine/dist/index.js";
import { loadDefaultClassifier } from "../../packages/lists/dist/index.js";

const require = createRequire(import.meta.url);
const classifier = loadDefaultClassifier(require("../../packages/lists/data/compiled-list.json"));
const PORT = Number(process.env["DEVTOOLS_PORT"] ?? 9333);
const SETTLE_MS = Number(process.env["SETTLE_MS"] ?? 15000);
const urls = process.argv.slice(2).filter((a) => a.startsWith("http"));
if (urls.length === 0) {
  console.error("usage: measure.mjs <url> [<url> ...]");
  process.exit(1);
}

function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    };
    ws.onerror = reject;
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const i = ++id;
            pending.set(i, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: i, method, params }));
          }),
        close: () => ws.close(),
      });
  });
}
const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const browserWs = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl;
const isOurWorker = (t) => t.type === "service_worker" && /^chrome-extension:\/\/[a-p]{32}\/sw\.js$/.test(t.url);

async function evaluate(target, expression) {
  const c = await cdp(target.webSocketDebuggerUrl);
  try {
    const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return r.result?.value;
  } finally {
    c.close();
  }
}

const VENDOR = new Set(["advertising", "analytics"]);
function describe(id) {
  switch (id.kind) {
    case "container":
      return `container ${id.identity.manager}:${id.identity.id ?? "?"}${id.ancestors.length ? " < " + id.ancestors.map((a) => a.id).join(" < ") : ""}${id.mixed ? " (mixed)" : ""}`;
    case "entity":
      return `entity ${id.name}`;
    case "host":
      return `host ${id.domain}`;
    case "site":
      return `site ${id.url ?? "(inline or html)"}`;
  }
}

for (const url of urls) {
  const b = await cdp(await browserWs());
  const { targetId } = await b.send("Target.createTarget", { url });
  b.close();
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const all = await targets();
  const worker = all.find(isOurWorker);
  if (!worker) {
    console.log(`${url}: worker not running; skipped`);
    continue;
  }
  const store = await evaluate(worker, "chrome.storage.session.get(null).then(s => JSON.stringify(s))");
  const session = JSON.parse(store);
  const host = new URL(url).hostname;
  const stored = Object.entries(session)
    .filter(([k]) => k.startsWith("tab:"))
    .map(([, v]) => v)
    .find((v) => String(v.finalUrl ?? "").includes(host));
  if (!stored) {
    console.log(`${url}: no tab state; skipped`);
    continue;
  }
  const obs = {
    ...stored,
    scriptInsertions: expandInsertions(stored.scriptInsertionsInterned),
    requestInitiators: expandInsertions(stored.requestInitiatorsInterned),
    network: [],
    context: { finalUrl: stored.finalUrl, topSite: stored.topSite },
    signal: { readsByScript: stored.readsByScript, readAttribution: stored.readAttribution },
  };
  const res = resolveLoaders(obs, classifier);
  const cov = stored.scriptInsertionCoverage;
  const records = obs.scriptInsertions;
  const vendors = new Map();
  let inlineOnly = 0, inlineResolved = 0, undeterminedRecords = 0, scriptRecords = 0;
  for (const r of records) {
    if (r.key.startsWith("inline:")) continue;
    scriptRecords++;
    const ids = res.byKey.get(r.key) ?? [];
    if (ids.length === 0) undeterminedRecords++;
    for (const l of r.loaders) {
      if (l.insertedBy.length === 0 && l.inlineFrames) {
        inlineOnly++;
        if (l.currentScriptKey) inlineResolved++;
      }
    }
    const cls = classifier.classify(r.url, stored.topSite);
    if (cls.party === "third" && VENDOR.has(cls.category) && cls.entity) {
      const set = vendors.get(cls.entity.name) ?? new Set();
      for (const id of ids) set.add(describe(id));
      if (ids.length === 0) set.add("undetermined");
      vendors.set(cls.entity.name, set);
    }
  }
  console.log(`\n=== ${url} (topSite ${stored.topSite})`);
  console.log(`coverage: ${JSON.stringify(cov)}`);
  console.log(`records: ${records.length} (${scriptRecords} with a URL; ${undeterminedRecords} undetermined; inline-only stacks ${inlineOnly}, of which currentScript resolved ${inlineResolved})`);
  console.log(`wrapper frames removed: ${JSON.stringify(res.wrapperFrames)}`);
  console.log(`container graph: ${JSON.stringify([...res.parents].map(([k, v]) => `${k} < ${v.manager}:${v.id}`))}`);
  console.log(`checks by container: ${JSON.stringify([...checksByContainer(obs)].map(([k, v]) => `${k}=${v.checks}`))}`);
  console.log(`vendors (${vendors.size}):`);
  for (const [name, set] of [...vendors].sort()) console.log(`  ${name}: ${[...set].join(" | ")}`);
  // Request initiators, and the XHR question. For each vendor domain reached by XHR,
  // was the XHR made from the vendor's own frames, someone else's, or unobserved?
  const reqs = obs.requestInitiators;
  const kinds = {};
  for (const r of reqs) kinds[r.element] = (kinds[r.element] ?? 0) + 1;
  const xhrByVendor = new Map();
  for (const r of reqs) {
    if (r.element !== "xhr") continue;
    const cls = classifier.classify(r.url, stored.topSite);
    if (!(cls.party === "third" && VENDOR.has(cls.category) && cls.entity)) continue;
    const own = r.loaders.some((l) => l.insertedBy[0] && classifier.classify(l.insertedBy[0], stored.topSite).entity?.name === cls.entity.name);
    const named = r.loaders.some((l) => l.insertedBy.length > 0 || l.containerUrls.length > 0);
    const bucket = own ? "own frames" : named ? "someone else" : "unnamed";
    const set = xhrByVendor.get(cls.entity.name) ?? new Set();
    set.add(bucket);
    xhrByVendor.set(cls.entity.name, set);
  }
  console.log(`request initiators: ${reqs.length} records ${JSON.stringify(kinds)}; coverage ${JSON.stringify(stored.requestInitiatorCoverage)}`);
  console.log(`xhr by vendor (${xhrByVendor.size}):`);
  for (const [name, set] of [...xhrByVendor].sort()) console.log(`  ${name}: ${[...set].join(" | ")}`);
  const b2 = await cdp(await browserWs());
  await b2.send("Target.closeTarget", { targetId });
  b2.close();
}
