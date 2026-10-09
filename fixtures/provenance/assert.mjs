#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Assert the fixture's insertion records against README.md's table.
 *
 * Runs inspect.mjs --raw --reload (re-captures the page and reads the worker's tab state),
 * then checks one expectation per case at the RECORD level: which method, which container
 * frames, whether the stack was inline-only and resolved through currentScript, and so
 * on. Resolution into "loaded by X" is the engine's job and is not asserted here.
 *
 *   node fixtures/provenance/assert.mjs            # the page as served
 *   node fixtures/provenance/assert.mjs --cmpwrap  # expects the CMP wrapper on the stacks
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cmpwrap = process.argv.includes("--cmpwrap");

const out = execFileSync("node", [join(here, "inspect.mjs"), "--raw", "--reload"], { encoding: "utf8" });
const { page, tab } = JSON.parse(out);
const records = tab.scriptInsertions ?? [];
const coverage = tab.scriptInsertionCoverage;

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + detail}`);
  if (!ok) failures++;
}
const find = (path) => records.find((r) => r.key.includes(path));
const loaderOf = (path) => find(path)?.loaders[0];
const hasId = (urls, id) => (urls ?? []).some((u) => u.includes(`id=${id}`));
const wrapperOrNot = (insertedBy) => (cmpwrap ? insertedBy.filter((u) => !u.includes("cdn.cookielaw.org/cmp.js")) : insertedBy);

console.log(`page ${page.url}: ${page.ran.length} scripts ran; ${records.length} insertion records\n`);
check("capability reported", tab.capabilities?.scriptInsertion === true);
check("coverage present", !!coverage, JSON.stringify(coverage));

// --- every wrapped method, from FIX1 ---
for (const via of ["appendChild", "insertBefore", "replaceChild", "append", "prepend", "before", "after", "replaceWith", "insertAdjacentElement", "insertNode"]) {
  const l = loaderOf(`connect.facebook.net/fixture/${via}.js`);
  check(`method ${via}: via and container FIX1`, l?.via === via && hasId(l?.containerUrls, "GTM-FIX1") && !hasId(l?.containerUrls, "GTM-FIX1-CHILD"), JSON.stringify(l));
}
{
  const l = loaderOf("connect.facebook.net/fixture/fragment.js");
  check("fragment: seen through the fragment, container FIX1", l?.via === "appendChild" && hasId(l?.containerUrls, "GTM-FIX1"), JSON.stringify(l));
}

// --- Custom HTML, synchronous and deferred ---
{
  const l = loaderOf("connect.facebook.net/fixture/custom-html-sync.js");
  check("custom-html-sync: inline frame on top, container FIX1 beneath", l?.inlineFrames === true && hasId(l?.containerUrls, "GTM-FIX1"), JSON.stringify(l));
  const d = loaderOf("connect.facebook.net/fixture/custom-html-deferred.js");
  check("custom-html-deferred: inline-only, no container, currentScript null", d?.inlineFrames === true && (d?.containerUrls ?? []).length === 0 && wrapperOrNot(d?.insertedBy ?? []).length === 0 && d?.currentScriptKey === null, JSON.stringify(d));
}

// --- transitive loader, import, child container, helper, friendly iframe ---
{
  const l = loaderOf("connect.facebook.net/fixture/loader.js");
  check("loader: container FIX1", hasId(l?.containerUrls, "GTM-FIX1"), JSON.stringify(l));
  const late = loaderOf("connect.facebook.net/fixture/late-from-loader.js");
  check("late-from-loader: inserted by the loader's own frames, no container", (late?.insertedBy ?? []).some((u) => u.includes("fixture/loader.js")) && (late?.containerUrls ?? []).length === 0, JSON.stringify(late));
  check("importer: container FIX1", hasId(loaderOf("connect.facebook.net/fixture/importer.js")?.containerUrls, "GTM-FIX1"));
  check("module.js: no record (a dynamic import is not an insertion)", find("connect.facebook.net/fixture/module.js") === undefined);
  const child = records.find((r) => r.key.includes("gtm.js?id=GTM-FIX1-CHILD"));
  check("child-container: its own key, inserted by FIX1", child !== undefined && hasId(child?.loaders[0]?.containerUrls, "GTM-FIX1"), JSON.stringify(child));
  const cv = loaderOf("sb.scorecardresearch.com/fixture/from-child.js");
  check("child-vendor: innermost container is the CHILD", (cv?.containerUrls?.[0] ?? "").includes("GTM-FIX1-CHILD"), JSON.stringify(cv));
  const helper = loaderOf("googletagmanager.com/helper/postscribe.js");
  check("helper: inserted by FIX1", hasId(helper?.containerUrls, "GTM-FIX1"), JSON.stringify(helper));
  const friendly = records.find((r) => r.key === "about:blank" && r.element === "iframe");
  check("friendly-iframe: recorded as an iframe under FIX1", friendly !== undefined && hasId(friendly?.loaders[0]?.containerUrls, "GTM-FIX1"), JSON.stringify(friendly));
}

// --- the second root, and the same vendor loaded several ways ---
{
  const fix2 = records.find((r) => r.key.includes("gtm.js?id=GTM-FIX2"));
  check("gtm-loader-fix2: its own key, inline-only stack resolved to a parser snippet", fix2 !== undefined && fix2?.loaders[0]?.inlineFrames === true && typeof fix2?.loaders[0]?.currentScriptKey === "string", JSON.stringify(fix2));
  const fix1 = records.find((r) => r.key.includes("gtm.js?id=GTM-FIX1") && !r.key.includes("CHILD"));
  check("gtm-loader-fix1: its own key, via insertBefore", fix1?.loaders[0]?.via === "insertBefore", JSON.stringify(fix1));
  check("fix2 vendor: container FIX2", hasId(loaderOf("static.criteo.net/fixture/from-fix2.js")?.containerUrls, "GTM-FIX2"));
  const si = loaderOf("static.criteo.net/fixture/from-site-inline.js");
  check("site-inline-sync: inline-only, currentScript names a parser snippet", si?.inlineFrames === true && typeof si?.currentScriptKey === "string" && si.currentScriptKey.startsWith("inline:"), JSON.stringify(si));
  const snippet = si ? records.find((r) => r.key === si.currentScriptKey) : undefined;
  check("that snippet's own record is parser-inserted", snippet?.loaders[0]?.via === "parser", JSON.stringify(snippet));
  const sf = loaderOf("static.criteo.net/fixture/from-site-file.js");
  check("site-file: inserted by provenance.localhost/site.js", wrapperOrNot(sf?.insertedBy ?? [])[0]?.includes("provenance.localhost/site.js") === true, JSON.stringify(sf));
}

// --- deferred site snippet, write, CMP release, pushState, parser, sub-frame ---
{
  const sd = loaderOf("cdn.permutive.com/fixture/from-site-deferred.js");
  check("site-inline-deferred: inline-only, currentScript null", sd?.inlineFrames === true && sd?.currentScriptKey === null, JSON.stringify(sd));
  const w = loaderOf("js.adsrvr.org/fixture/written.js");
  check("written: via write from an inline writer", w?.via === "write" && w?.inlineFrames === true, JSON.stringify(w));
  const rel = loaderOf("c.amazon-adsystem.com/fixture/released-by-cmp.js");
  check("cmp-release-live: inserted by the CMP's frames", (rel?.insertedBy ?? [])[0]?.includes("cdn.cookielaw.org/cmp.js") === true, JSON.stringify(rel));
  check("the gated text/plain element was counted, not recorded", (coverage?.nonExecuting ?? 0) >= 1 && find("released-by-cmp.js")?.loaders.length === 1);
  const ps = loaderOf("connect.facebook.net/fixture/after-pushstate.js");
  check("after-pushstate: still recognized as inline-only", ps?.inlineFrames === true && wrapperOrNot(ps?.insertedBy ?? []).length === 0, JSON.stringify(ps));
  const parser = loaderOf("cdn.permutive.com/fixture/parser-inserted.js");
  check("parser: recorded positively as parser-inserted", parser?.via === "parser", JSON.stringify(parser));
  const sub = loaderOf("connect.facebook.net/fixture/in-subframe.js");
  check("subframe: recorded from the sub-frame, topFrame false", sub !== undefined && sub?.topFrame === false && sub?.frameOrigin === "https://provenance.localhost", JSON.stringify(sub));
  check("in-friendly-iframe: invisible (no content script in about:blank yet)", find("in-friendly-iframe.js") === undefined);
}

// --- request initiators ---
{
  const reqs = tab.requestInitiators ?? [];
  const req = (path) => reqs.find((r) => r.key.includes(path));
  check("request capability reported", tab.capabilities?.requestInitiation === true);
  for (const [kind, path] of [["image", "pixel-from-fix1.gif"], ["fetch", "fetch-from-fix1.json"], ["xhr", "xhr-from-fix1.json"], ["beacon", "beacon-from-fix1"]]) {
    const r = req(path);
    check(`request ${kind} from FIX1: recorded under the container`, r?.element === kind && hasId(r?.loaders[0]?.containerUrls, "GTM-FIX1"), JSON.stringify(r));
  }
  const sitePx = req("pixel-from-site.gif");
  check("request from a site snippet: inline-only, undetermined by design", sitePx?.loaders[0]?.inlineFrames === true && wrapperOrNot(sitePx?.loaders[0]?.insertedBy ?? []).length === 0, JSON.stringify(sitePx));
  check("request coverage present, never self-disabled", !!tab.requestInitiatorCoverage && tab.requestInitiatorCoverage.selfDisabled === false, JSON.stringify(tab.requestInitiatorCoverage));
}

// --- coverage and the wrapper case ---
check("coverage: wrappedOver matches the CMP wrapper setting", coverage?.wrappedOver === cmpwrap, JSON.stringify(coverage));
check("coverage: never self-disabled, no stack failures", coverage?.selfDisabled === false && coverage?.stackFailed === 0, JSON.stringify(coverage));
if (cmpwrap) {
  const late = loaderOf("connect.facebook.net/fixture/late-from-loader.js");
  check("cmpwrap: the CMP's wrapper frame sits on a later stack", (late?.insertedBy ?? []).some((u) => u.includes("cdn.cookielaw.org/cmp.js")), JSON.stringify(late));
}

console.log(`\n${failures === 0 ? "all green" : failures + " failure(s)"}`);
process.exit(failures === 0 ? 0 : 1);
