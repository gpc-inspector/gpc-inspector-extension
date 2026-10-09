#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Read the fixture back through the DevTools protocol.
 *
 * chrome.sh starts Chrome with --remote-debugging-port, so this can ask the page what ran
 * and ask the extension's service worker for the tab's state, with no browser driving by
 * hand. Node's built-in WebSocket is enough; no dependency.
 *
 *   node fixtures/provenance/inspect.mjs            # page: what ran; worker: tab state
 *   node fixtures/provenance/inspect.mjs --raw      # dump the whole session store
 */
import { expandInsertions } from "../../packages/capture-extension/dist/background/insertions.js";

const PORT = Number(process.env["DEVTOOLS_PORT"] ?? 9333);
const raw = process.argv.includes("--raw");
// How long to let the page settle after a reload before reading the worker. The worker
// persists tab state on a timer, so a short wait reads a partial tally.
const waitIdx = process.argv.indexOf("--wait");
const settleMs = waitIdx >= 0 ? Number(process.argv[waitIdx + 1]) : 8000;

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  return res.json();
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
    ws.onerror = (e) => reject(e);
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

async function evaluate(target, expression) {
  const c = await cdp(target.webSocketDebuggerUrl);
  try {
    const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "evaluate failed");
    return r.result.value;
  } finally {
    c.close();
  }
}

// Our worker is the one whose script is sw.js; a fresh profile can still carry Chrome's
// own component extensions, which also have service workers.
const isOurWorker = (t) => t.type === "service_worker" && /^chrome-extension:\/\/[a-p]{32}\/sw\.js$/.test(t.url);
const isPage = (t) => t.type === "page" && t.url.includes("provenance.localhost");

let all = await targets();
let page = all.find(isPage);
if (!page) {
  console.error("No fixture page open. Targets:", all.map((t) => `${t.type} ${t.url}`).join("\n"));
  process.exit(1);
}

// An MV3 service worker is terminated after about thirty idle seconds and then has no
// target. Reloading the page fires webRequest events, which wake it; the reload also
// re-captures the page from scratch, which is what an assertion run wants anyway.
if (!all.find(isOurWorker) || process.argv.includes("--reload")) {
  const c = await cdp(page.webSocketDebuggerUrl);
  await c.send("Page.reload", { ignoreCache: true });
  c.close();
  await new Promise((r) => setTimeout(r, settleMs));
  all = await targets();
  page = all.find(isPage) ?? page;
}
const worker = all.find(isOurWorker);

const ran = await evaluate(page, "JSON.stringify({ ran: window.__fixtureRan || [], url: location.href, cases: [...document.querySelectorAll('[data-case]')].map(e => e.getAttribute('data-case')) })");
const pageInfo = JSON.parse(ran);
if (!raw) {
  console.log("page:", pageInfo.url);
  console.log("scripts that ran:", pageInfo.ran.length);
  for (const r of pageInfo.ran) console.log("  ", r);
  console.log("elements tagged data-case:", pageInfo.cases.length);
}

if (!worker) {
  console.error("Extension service worker not found among targets; is dist-ext loaded?");
  process.exit(1);
}

const store = await evaluate(
  worker,
  "(async () => { try { return JSON.stringify(await chrome.storage.session.get(null)); } catch (e) { return 'ERR:' + (e && e.message); } })()",
);
if (typeof store !== "string" || store.startsWith("ERR:")) {
  console.error("Could not read the worker's session store:", store);
  process.exit(1);
}
const session = JSON.parse(store);
const tabs = Object.entries(session).filter(([k]) => k.startsWith("tab:"));
const stored = tabs.map(([, v]) => v).find((v) => String(v.finalUrl ?? "").includes("provenance.localhost"));
// The worker persists insertions interned (URLs stored once, referenced by index) and
// expands them when it builds the ObservationSet. Do the same here, with the same code.
const tab = stored
  ? { ...stored, scriptInsertions: expandInsertions(stored.scriptInsertionsInterned), requestInitiators: expandInsertions(stored.requestInitiatorsInterned) }
  : undefined;
if (!tab) {
  console.error("No tab state for the fixture page. Keys:", Object.keys(session).join(", "));
  process.exit(1);
}
if (raw) {
  // JSON only, so assert.mjs can parse the whole of stdout.
  console.log(JSON.stringify({ page: pageInfo, tab }, null, 2));
} else {
  console.log("\nworker tab state:");
  console.log("  topSite:", tab.topSite, " incomplete:", tab.incomplete, " capabilities:", JSON.stringify(tab.capabilities));
  console.log("  gtm:", JSON.stringify(tab.gtm));
  console.log("  consentApiCalls:", (tab.consentApiCalls ?? []).length, " signalReads:", tab.signalReads);
  console.log("  readAttribution:", JSON.stringify(tab.readAttribution));
  console.log("  tallies.byEntity:", Object.keys(tab.tallies?.byEntity ?? {}).join(", "));
  if (tab.scriptInsertions) {
    console.log("  scriptInsertions:", tab.scriptInsertions.length, " coverage:", JSON.stringify(tab.scriptInsertionCoverage));
  } else {
    console.log("  scriptInsertions: (not in this build)");
  }
}
