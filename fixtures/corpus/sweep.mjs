#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Corpus sweep: run the real unpacked extension against a list of sites in a throwaway
 * Chrome, one site at a time in the foreground, and record three things per site: what
 * the worker captured (the ObservationSet, redacted), what the engine found (the same
 * evaluate() the popup runs) and what the popup showed (its overview as text and as a
 * screenshot).
 *
 * The list is the file --sites names; without it, fixtures/corpus/sites.json when that
 * file exists, else fixtures/corpus/sites.example.json, which shows the format.
 *
 *   node fixtures/corpus/sweep.mjs                        # every site
 *   node fixtures/corpus/sweep.mjs --sites my-sites.json  # another list
 *   node fixtures/corpus/sweep.mjs --only retailer-a.example,apparel-c.example
 *   node fixtures/corpus/sweep.mjs --group <group>        # the entries in one group
 *   node fixtures/corpus/sweep.mjs --urls https://a.example/,https://b.invalid/   # not from the list
 *   node fixtures/corpus/sweep.mjs --settle 12000         # ms after load before reading (default 20000)
 *   node fixtures/corpus/sweep.mjs --out fixtures/corpus/runs/<name>
 *   node fixtures/corpus/sweep.mjs --keep                 # leave Chrome open afterwards
 *
 * Output, under the run directory: <host>.json (the summary), <host>.obs.json (the
 * redacted ObservationSet), <host>.popup.txt (the overview as text), <host>.popup.png,
 * then summary.md across every site (report.mjs builds it and can rebuild it alone).
 *
 * Why a Node launcher and not the MCP: the MCP is one page at a time by hand; sixty sites
 * at a minute each is a batch job. The mechanics are the ones fixtures/provenance/launch.mjs
 * established (Google Chrome 137 and later ignore --load-extension; Extensions.loadUnpacked
 * over a debugging pipe is the supported route) and the popup trick is the one the 2026-09-22
 * sweep used: popup.html opened as a tab with chrome.tabs.query replaced so it renders a
 * named tab rather than the active one.
 *
 * Two things this Chrome is not. It is flagged as automated, so bot managers and consent
 * stacks can behave differently; a site that served a challenge page is marked "blocked"
 * in the summary and its numbers describe the challenge page, not the site. And a DevTools
 * session is attached to the service worker for the whole run, which keeps the worker
 * alive; the "capture incomplete after a worker restart" path is not exercised here.
 */
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import {
  evaluate,
  countAdTechRequests,
  countDistinctCookiesSetWithSignal,
  countDistinctCookiesSetWithoutSignal,
  countFirstPartyVendorCookies,
} from "../../packages/engine/dist/index.js";
import { loadDefaultClassifier, loadOwnerCookies } from "../../packages/lists/dist/index.js";
import { redact } from "../../packages/schema/dist/index.js";
import { buildReport } from "./report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const ext = join(root, "packages/capture-extension/dist-ext");
const chrome = process.env["CHROME"] ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// ---- arguments ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const only = opt("only", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const group = opt("group", "");
const adHoc = opt("urls", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const settleMs = Number(opt("settle", 20000));
const loadTimeoutMs = Number(opt("load-timeout", 40000));
const popupTimeoutMs = Number(opt("popup-timeout", 20000));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = resolve(opt("out", join(here, "runs", stamp)));
const keep = flag("keep");

// ---- inputs ------------------------------------------------------------------------------
try {
  await access(join(ext, "manifest.json"));
} catch {
  console.error("dist-ext is missing; run: npm run build:ext --workspace packages/capture-extension");
  process.exit(1);
}
// The list: the file --sites names, else sites.json beside this script, else the short
// sites.example.json, which shows the format.
const sitesPath = opt("sites", "")
  ? resolve(opt("sites", ""))
  : await access(join(here, "sites.json")).then(
      () => join(here, "sites.json"),
      () => join(here, "sites.example.json"),
    );
const sitesFile = await readFile(sitesPath, "utf8").then(JSON.parse, (e) => {
  console.error(`Cannot read the site list ${sitesPath}: ${e.message}`);
  process.exit(1);
});
console.log(`Site list: ${sitesPath}`);
let sites = sitesFile.sites;
if (only.length) sites = sites.filter((s) => only.includes(s.host));
if (group) sites = sites.filter((s) => s.group === group);
// Ad-hoc URLs, for a regression check on a page that is not in the list: an unreachable
// name (.invalid never resolves) gives Chrome's error page, for instance.
if (adHoc.length) {
  const extra = adHoc.map((url) => ({ host: new URL(url).hostname, url, group: "ad-hoc", why: "given on the command line" }));
  sites = only.length || group ? [...sites, ...extra] : extra;
}
if (!sites.length) {
  console.error("No sites selected.");
  process.exit(1);
}
const compiled = JSON.parse(await readFile(join(root, "packages/lists/data/compiled-list.json"), "utf8"));
const classifier = loadDefaultClassifier(compiled);
// The container owners' cookie names (1.25.0), as the extension reads them
// (background/classifier.ts). Without them the counts here charge a cookie written inside a
// tag container differently from the badge and the popup, and the cross-checks disagree.
const ownerList = loadOwnerCookies(JSON.parse(await readFile(join(root, "packages/lists/data/container-owner-cookies.json"), "utf8")));
const owners = {
  match(manager, name) {
    const e = ownerList.entryFor(manager, name);
    return e === null ? null : { entity: { name: e.owner, id: e.owner.toLowerCase() }, category: e.category };
  },
};
await mkdir(outDir, { recursive: true });

// ---- Chrome over the debugging pipe --------------------------------------------------------
let profile = "";
let child = null;
let toChrome = null;
let chromeExited = false;
// Which browser is current: a call begun for an earlier one stops instead of reaching the next.
let browserGen = 0;

/** A fresh profile and a fresh browser; the pipe's replies and events feed the maps below. */
async function launch() {
  profile = await mkdtemp(join(tmpdir(), "gpc-inspector-corpus-"));
  child = spawn(
    chrome,
    [
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  chromeExited = false;
  buffer = "";
  const self = child;
  self.on("exit", (code) => {
    if (self !== child) return;
    chromeExited = true;
    if (!keep) console.log(`Chrome exited (${code})`);
  });
  toChrome = child.stdio[3];
  // A write racing the browser's exit fails with EPIPE; the call's own timeout reports it.
  toChrome.on("error", () => {});
  child.stdio[4].on("data", (chunk) => {
    if (self === child) onPipeData(chunk);
  });
}

/** Kill the browser and remove its profile. */
async function discard() {
  const old = child;
  const dir = profile;
  child = null;
  toChrome = null;
  browserGen++;
  for (const [id, p] of pending) {
    pending.delete(id);
    p.reject(new Error(`${p.method}: browser discarded`));
  }
  // The profile goes only once the browser has exited; removed sooner, it is written again.
  if (old && old.exitCode === null && old.signalCode === null) {
    const exited = new Promise((r) => old.once("exit", r));
    old.kill();
    await Promise.race([exited, sleep(10000)]);
  }
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

let nextId = 0;
const pending = new Map();
const listeners = new Map(); // `${sessionId}|${method}` -> Set<handler>
let buffer = "";
function onPipeData(chunk) {
  buffer += chunk.toString("utf8");
  let nul;
  while ((nul = buffer.indexOf("\0")) >= 0) {
    const raw = buffer.slice(0, nul);
    buffer = buffer.slice(nul + 1);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      continue;
    }
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
    } else if (msg.method) {
      const set = listeners.get(`${msg.sessionId ?? ""}|${msg.method}`);
      if (set) for (const h of set) h(msg.params);
    }
  }
}
function send(method, params = {}, sessionId) {
  if (toChrome === null) return Promise.reject(new Error(`${method}: no browser`));
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    const m = { id, method, params };
    if (sessionId) m.sessionId = sessionId;
    toChrome.write(JSON.stringify(m) + "\0");
  });
}
function on(sessionId, method, handler) {
  const key = `${sessionId ?? ""}|${method}`;
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(handler);
  return () => listeners.get(key)?.delete(handler);
}
function once(sessionId, method, timeoutMs) {
  return new Promise((resolve, reject) => {
    const off = on(sessionId, method, (p) => {
      off();
      clearTimeout(t);
      resolve(p);
    });
    const t = setTimeout(() => {
      off();
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what}: timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

async function shutdown(code) {
  if (!keep && !chromeExited) {
    child?.kill();
    await sleep(500);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  process.exit(code);
}

// ---- the extension's service worker --------------------------------------------------------
let extId = "";
let swSession = null;

async function findWorkerTarget() {
  const { targetInfos } = await send("Target.getTargets");
  return targetInfos.find((t) => t.type === "service_worker" && t.url === `chrome-extension://${extId}/sw.js`);
}
async function attachWorker() {
  const gen = browserGen;
  for (let i = 0; i < 40; i++) {
    if (gen !== browserGen) throw new Error("the browser was replaced");
    const t = await findWorkerTarget();
    if (gen !== browserGen) throw new Error("the browser was replaced");
    if (t) {
      const { sessionId } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      swSession = sessionId;
      on(sessionId, "Target.detachedFromTarget", () => {
        if (swSession === sessionId) swSession = null;
      });
      return;
    }
    await sleep(250);
  }
  throw new Error("the extension's service worker never appeared");
}
/** Evaluate in the worker; the function's source is sent, called, and its result awaited. */
async function sw(fn, ...args) {
  if (!swSession) await attachWorker();
  const expression = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`;
  let r;
  try {
    r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, swSession);
  } catch (e) {
    // The session can go with a worker that was replaced; one re-attach, then the error stands.
    if (/session|closed|detached/i.test(String(e.message))) {
      swSession = null;
      await attachWorker();
      r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, swSession);
    } else throw e;
  }
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "worker evaluate failed");
  }
  return r.result.value;
}

// ---- the popup, rendered for a named tab ---------------------------------------------------
const POPUP_INIT = `(() => {
  const t = Number(new URLSearchParams(location.search).get("t"));
  if (!Number.isFinite(t)) return;
  const orig = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = async (q) => (q && q.active ? [await chrome.tabs.get(t)] : orig(q));
})();`;
const POPUP_IDS = [
  "site",
  "status-text",
  "status-source",
  "notices",
  "site-did",
  "privacy-strings",
  "count-number",
  "count-caption",
  "count-names",
  "count-detail",
  "vendors-source",
  "vendors-check-head",
  "vendors",
  "notices-bottom",
  "tab-requests-count",
];

async function renderPopup(tabId, host) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank", background: true });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  try {
    await send("Page.enable", {}, sessionId);
    await send("Page.addScriptToEvaluateOnNewDocument", { source: POPUP_INIT }, sessionId);
    await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    // The popup reads the tab's record once, as it opens, and never redraws (only the side
    // panel follows changes). So its headline is the worker's count at some moment between
    // these two reads of the badge, and an ad-heavy page still setting cookies at the settle
    // moves the count in between (retailer-k.example, 2026-09-30: popup 59, capture 64 a few seconds
    // later). The report judges the popup against this range, not against the capture.
    const badge = () => sw(async (id) => (await globalThis.gpcFindings(id)).badgeCount, tabId).catch(() => null);
    const workerBadgeBefore = await badge();
    const loaded = once(sessionId, "Page.loadEventFired", popupTimeoutMs);
    await send("Page.navigate", { url: `chrome-extension://${extId}/popup.html?t=${tabId}` }, sessionId);
    await loaded;
    const evalIn = async (fn) => {
      const r = await send("Runtime.evaluate", { expression: `(${fn.toString()})()`, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "popup evaluate failed");
      return r.result.value;
    };
    // Wait for the popup's one read to land.
    const deadline = Date.now() + popupTimeoutMs;
    let fields = {};
    while (Date.now() < deadline) {
      fields = await evalIn(() => {
        const out = {};
        for (const id of ["count-number", "status-text", "site"]) out[id] = document.getElementById(id)?.innerText ?? "";
        out.pendingText = document.body.innerText.includes("Checking this page");
        return out;
      });
      if (!fields.pendingText && fields["count-number"] !== "") break;
      await sleep(1000);
    }
    const popup = await evalIn(() => {
      const ids = ["site", "status-text", "status-source", "notices", "site-did", "privacy-strings", "count-number", "count-caption", "count-names", "count-detail", "vendors-source", "vendors-check-head", "vendors", "notices-bottom", "tab-requests-count"];
      const out = { fields: {}, overviewText: "", firstRunShown: false };
      for (const id of ids) out.fields[id] = (document.getElementById(id)?.innerText ?? "").trim();
      const ov = document.getElementById("overview");
      out.overviewText = (ov?.innerText ?? document.body.innerText).trim();
      const fr = document.getElementById("firstrun");
      out.firstRunShown = !!fr && getComputedStyle(fr).display !== "none";
      return out;
    });
    popup.workerBadgeBefore = workerBadgeBefore;
    popup.workerBadgeAfter = await badge();
    const metrics = await send("Page.getLayoutMetrics", {}, sessionId);
    const height = Math.min(Math.ceil(metrics.cssContentSize?.height ?? 900), 6000);
    const shot = await send(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 420, height, scale: 1 } },
      sessionId,
    );
    await writeFile(join(outDir, `${host}.popup.png`), Buffer.from(shot.data, "base64"));
    await writeFile(join(outDir, `${host}.popup.txt`), popup.overviewText + "\n");
    return popup;
  } finally {
    await send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

// ---- one site ------------------------------------------------------------------------------
// A bare "captcha" is not a challenge: many ordinary pages say "protected by reCAPTCHA".
const CHALLENGE = /access denied|just a moment|verify you are human|pardon our interruption|request blocked|are you a robot|complete the captcha|solve the captcha|attention required|bot detection|unusual traffic|too many requests|403 forbidden|reference #/i;

function summarize(site, obs, findings, worker, page, popup) {
  const flags = {};
  for (const f of findings) flags[f.flag] = (flags[f.flag] ?? 0) + 1;
  const vendors = {};
  for (const f of findings) {
    if (!f.entity?.name) continue;
    const v = (vendors[f.entity.name] ??= { flags: [], cookies: [] });
    if (!v.flags.includes(f.flag)) v.flags.push(f.flag);
    if (f.artifact?.kind === "cookie" && f.flag === "cookie-set-with-signal" && !v.cookies.includes(f.artifact.cookieName)) {
      v.cookies.push(f.artifact.cookieName);
    }
  }
  const gppSections = {};
  if (obs.gpp) {
    for (const [name, fields] of Object.entries(obs.gpp.sections ?? {})) {
      const pick = {};
      for (const k of ["Gpc", "GpcSegmentIncluded", "SaleOptOut", "SharingOptOut", "TargetedAdvertisingOptOut", "SaleOptOutNotice", "SharingOptOutNotice"]) {
        if (fields && fields[k] !== undefined) pick[k] = fields[k];
      }
      gppSections[name] = pick;
    }
  }
  return {
    host: site.host,
    group: site.group,
    url: site.url,
    capturedAt: obs.context.capturedAt,
    page: {
      finalUrl: obs.context.finalUrl || page.url,
      title: page.title,
      blocked: CHALLENGE.test(`${page.title}\n${page.text}`),
      textSample: page.text.slice(0, 200),
      status: page.status,
      noticeTextHits: page.noticeTextHits ?? [],
    },
    context: {
      topSite: obs.context.topSite,
      incomplete: obs.context.incomplete,
      loadObserved: obs.context.loadObserved,
      capabilitiesFailed: Object.entries(obs.capabilities ?? {})
        .filter(([, ok]) => ok === false)
        .map(([k]) => k),
    },
    signal: {
      secGpcRequestCount: obs.signal.secGpcRequestCount,
      totalRequestCount: obs.signal.totalRequestCount,
      source: obs.signal.source,
      propertyValue: obs.signal.propertyValue,
      readTracking: obs.signal.readTracking,
      readCount: obs.signal.readCount,
      scriptsReading: Object.keys(obs.signal.readsByScript ?? {}).length,
    },
    counts: {
      // HTTP requests only, as the Requests tab counts them; script cookie writes apart.
      requests: obs.network.filter((n) => n.method !== "SCRIPT").length,
      scriptCookieWrites: obs.network.filter((n) => n.method === "SCRIPT").length,
      adTechRequests: countAdTechRequests(obs, classifier),
      distinctCookiesSigned: countDistinctCookiesSetWithSignal(obs, classifier, owners),
      distinctCookiesUnsigned: countDistinctCookiesSetWithoutSignal(obs, classifier, owners),
      firstPartyVendorCookies: countFirstPartyVendorCookies(obs, classifier, owners),
      workerBadgeCount: worker?.badgeCount ?? null,
      workerFindings: worker?.findings?.length ?? null,
      consentApiCalls: obs.consentApiCalls.length,
      scriptInsertions: obs.scriptInsertions?.length ?? null,
    },
    gpp: obs.gpp
      ? { applicableSections: obs.gpp.applicableSections, sections: gppSections, unparseable: obs.gpp.unparseable, fromWire: obs.gpp.fromWire !== null, rawString: obs.gpp.rawString }
      : null,
    usPrivacy: obs.usPrivacy,
    tcf: obs.tcf ? { present: true } : null,
    gtm: obs.gtm?.present
      ? { containerIds: obs.gtm.containerIds, gtagIds: obs.gtm.gtagIds, consentMode: obs.gtm.consentMode, effectiveConsent: obs.gtm.effectiveConsent ?? null }
      : { present: false },
    confirmationNotice: obs.confirmationNotice,
    wellKnown: obs.wellKnown ? { present: obs.wellKnown.present, gpc: obs.wellKnown.gpc, reason: obs.wellKnown.reason, fresh: obs.wellKnown.fresh } : null,
    findings: { total: findings.length, flags, vendors },
    popup: popup
      ? { fields: popup.fields, firstRunShown: popup.firstRunShown, workerBadgeBefore: popup.workerBadgeBefore, workerBadgeAfter: popup.workerBadgeAfter }
      : null,
  };
}

async function runSite(site, index) {
  const label = `[${index + 1}/${sites.length}] ${site.host}`;
  console.log(`${label}: opening`);
  const tabId = await sw(async (url) => (await chrome.tabs.create({ url, active: true })).id, site.url);
  try {
    // Wait for the load, then let the ad stack and the consent tool settle.
    const t0 = Date.now();
    while (Date.now() - t0 < loadTimeoutMs) {
      const status = await sw(async (id) => (await chrome.tabs.get(id)).status, tabId);
      if (status === "complete") break;
      await sleep(500);
    }
    await sleep(settleMs);

    // The popup first: opening it asks the worker for the page's published GPC file, which
    // is what a user's popup does, and the dump after it then carries the answer.
    let popup = null;
    try {
      popup = await withTimeout(renderPopup(tabId, site.host), popupTimeoutMs + 15000, "popup");
    } catch (e) {
      console.log(`${label}: popup failed: ${e.message}`);
    }
    await sleep(1000);

    // The worker's findings and the capture Node re-evaluates, taken in one evaluation: as
    // two round trips, a request landing between them made the cross-check report a
    // disagreement that was only the page moving on (retailer-k.example, 2026-09-30: 220 and 221).
    const { worker, obs } = await sw(async (id) => {
      const g = globalThis;
      const [r, dump] = await Promise.all([g.gpcFindings(id), g.gpcDump(id)]);
      return { worker: { badgeCount: r.badgeCount, findings: r.findings }, obs: dump };
    }, tabId);
    // Diagnostics that are deliberately not in the schema: the notice detector's evidence
    // and the raw read counters, for adjudicating a row without reopening the site.
    const state = await sw(async (id) => {
      const s = await globalThis.gpcState(id);
      const stored = (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`] ?? {};
      return {
        confirmationEvidence: s.confirmationEvidence ?? null,
        stateMessages: s.stateMessages ?? null,
        readsByScript: s.readsByScript ?? null,
        // Documents this tab committed and left during the capture: a second commit on the
        // same origin is what turns a gpc.json read into a cached one.
        retiredDocuments: stored.retiredDocuments ?? null,
      };
    }, tabId).catch(() => null);
    const page = await sw(async (id) => {
      const tab = await chrome.tabs.get(id);
      let text = "";
      try {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const all = document.body ? document.body.innerText : "";
            // Lines that talk about the signal, for adjudicating the notice detector
            // against what was actually on the page. Observed text only.
            const hits = all
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => /opt[- ]?out.{0,40}(honou?red|signal)|preference signal|global privacy control|\bGPC\b/i.test(l))
              .slice(0, 12)
              .map((l) => l.slice(0, 200));
            return { text: all.slice(0, 1500), hits };
          },
        });
        text = r?.result?.text ?? "";
        var noticeTextHits = r?.result?.hits ?? [];
      } catch (e) {
        text = `(no page text: ${e && e.message})`;
      }
      return { url: tab.url, title: tab.title ?? "", status: tab.status, text, noticeTextHits: typeof noticeTextHits === "undefined" ? [] : noticeTextHits };
    }, tabId);

    const findings = evaluate(obs, classifier, owners);
    const summary = summarize(site, obs, findings, worker, page, popup);
    summary.diagnostics = state;
    await writeFile(join(outDir, `${site.host}.obs.json`), JSON.stringify(redact(obs), null, 2));
    await writeFile(join(outDir, `${site.host}.json`), JSON.stringify(summary, null, 2));
    const s = summary;
    console.log(
      `${label}: ${s.page.blocked ? "BLOCKED " : ""}${s.signal.secGpcRequestCount}/${s.signal.totalRequestCount} signed, reads ${s.signal.readCount ?? "n/a"}, ad/analytics ${s.counts.adTechRequests}, cookies with signal ${s.counts.distinctCookiesSigned} (badge ${s.counts.workerBadgeCount}), gpp ${s.gpp ? "yes" : "no"}, usp ${s.usPrivacy ? "yes" : "no"}, notice ${s.confirmationNotice}, gpc.json ${s.wellKnown ? (s.wellKnown.present ? `gpc:${s.wellKnown.gpc}` : "none") : "unchecked"}${s.context.incomplete ? ", INCOMPLETE" : ""}`,
    );
    return summary;
  } finally {
    await sw(async (id) => {
      try {
        await chrome.tabs.remove(id);
      } catch {}
      return true;
    }, tabId).catch(() => {});
  }
}

// ---- main ----------------------------------------------------------------------------------
// Edge 154 sometimes drops the extension's worker while a fresh profile starts up: the
// target goes, the origin has no service worker registration, messages get no reply, and
// Edge's own component extensions lose their background pages at the same moment. Loading
// the extension again does not bring it back (2026-10-02). So the first call into the
// worker has a deadline, and a miss discards that browser and starts another.
const STARTUP_ATTEMPTS = 3;
const STARTUP_DEADLINE_MS = 15000;

async function startBrowser() {
  for (let attempt = 1; ; attempt++) {
    await launch();
    try {
      const { id } = await send("Extensions.loadUnpacked", { path: ext });
      extId = id;
      swSession = null;
      // The first-run disclosure would otherwise cover the overview on every popup open.
      await withTimeout(
        sw(async () => {
          const got = await chrome.storage.local.get("settings");
          await chrome.storage.local.set({ settings: { ...(got.settings ?? {}), firstRunComplete: true } });
          return true;
        }),
        STARTUP_DEADLINE_MS,
        "the extension's worker",
      );
      return;
    } catch (e) {
      if (attempt >= STARTUP_ATTEMPTS) throw e;
      console.log(`Startup attempt ${attempt} failed (${e.message}); starting a fresh browser`);
      await discard();
    }
  }
}

try {
  await startBrowser();
  console.log(`Extension loaded: ${extId}; run directory: ${outDir}`);
  const version = await sw(() => chrome.runtime.getManifest().version);
  const meta = {
    startedAt: new Date().toISOString(),
    extensionVersion: version,
    chrome: (await send("Browser.getVersion")).product,
    settleMs,
    loadTimeoutMs,
    listVersion: classifier.provenance.version,
    sites: sites.map((s) => s.host),
  };
  await writeFile(join(outDir, "run.json"), JSON.stringify(meta, null, 2));

  const results = [];
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    try {
      results.push(await withTimeout(runSite(site, i), loadTimeoutMs + settleMs + popupTimeoutMs + 60000, site.host));
    } catch (e) {
      console.log(`[${i + 1}/${sites.length}] ${site.host}: FAILED: ${e.message}`);
      const failure = { host: site.host, group: site.group, url: site.url, error: String(e.message) };
      await writeFile(join(outDir, `${site.host}.json`), JSON.stringify(failure, null, 2));
      results.push(failure);
      if (chromeExited) throw new Error("Chrome exited");
    }
  }
  await writeFile(join(outDir, "summary.md"), await buildReport(outDir));
  console.log(`Done: ${results.length} sites; ${join(outDir, "summary.md")}`);
  await shutdown(0);
} catch (e) {
  console.error("Sweep failed:", e.message);
  await shutdown(1);
}
