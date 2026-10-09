#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Which third-party cookies seen on a page have no place on its Overview.
 *
 * The Overview is meant to account for every third-party cookie. This reads a sweep's saved
 * captures (`<site>.obs.json`) and sorts each third-party cookie key the page set by the
 * place the Overview gives it, from the summaries the capture recorded. It changes nothing
 * and judges nothing: it counts.
 *
 * Usage:
 *   ROOT=<checkout with built packages> node fixtures/corpus/gap.mjs <run dir> [--json]
 *
 * ROOT is the checkout whose rules the captures are read by (its packages/*\/dist and lists
 * data); by default the checkout this file is in. A capture keeps what its build recorded:
 * a summary added after that build (the per-domain rows and the first-party section, 1.26.0)
 * is absent from it, and its cookies read as having no place. Sweep the build you are
 * measuring.
 *
 * A key is third party when the count's own rule charges it to a third party (the engine's
 * cookieCharge, the one rule the tally, the findings and the Requests tab use). Its place,
 * first match:
 *
 *   counted        in the headline's keys (signed, unsigned, or first-party vendor)
 *   company        held by a company's summary in a category that does not count
 *   container      held by a tag container's summary
 *   domain row     held by a domain's summary in "No company found for this domain", and
 *                  the domain has a row (unlistedDomainHasRow)
 *   first party    in the First-party cookies section (a vendor's write while unsigned)
 *   request lost   named on a summary as set on a response whose request was lost
 *   probe          named on a panel as set and removed
 *   not stored     named on a panel as not stored by the browser (a refused write, or a
 *                  cookie the cookie jar did not hold, 1.30.0)
 *
 * Everything else has no place, and is listed by why: the charge's kind, whether the list
 * names a company, and for a domain with no company whether it has a summary at all.
 *
 * Seen: every non-deletion cookie record on the page's requests and on its kept records
 * (1.27.0), once per key.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env["ROOT"] ?? join(here, "..", ".."));
const { cookieCharge } = await import(join(ROOT, "packages/engine/dist/index.js"));
const { loadDefaultClassifier, loadOwnerCookies } = await import(join(ROOT, "packages/lists/dist/index.js"));
const schema = await import(join(ROOT, "packages/schema/dist/index.js"));
const { isCookieDeletion } = schema;
const hasRow = schema.unlistedDomainHasRow ?? (() => false);

const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
const classifier = loadDefaultClassifier(await readJson(join(ROOT, "packages/lists/data/compiled-list.json")));
const ownerList = loadOwnerCookies(await readJson(join(ROOT, "packages/lists/data/container-owner-cookies.json")));
const owners = {
  match(manager, name) {
    const e = ownerList.entryFor(manager, name);
    return e === null ? null : { entity: { name: e.owner, id: e.owner.toLowerCase() }, category: e.category };
  },
};

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
if (dir === undefined) {
  console.error("usage: ROOT=<checkout> node gap.mjs <run dir> [--json]");
  process.exit(2);
}

const PLACES = ["counted", "company", "container", "domain row", "first party", "request lost", "probe", "not stored"];
const keyOf = (c) => `${c.name}\u0000${c.domain}`;
const values = (o) => Object.values(o ?? {});

/** Every place a capture's summaries give a key or a name. */
function placesOf(o) {
  const t = o.tallies;
  const signalOn = o.signal.source !== "none";
  const set = () => new Set();
  const p = { counted: set(), company: set(), container: set(), "domain row": set(), "first party": set(), "request lost": set(), probeNames: set(), notStored: set() };
  for (const k of [...t.adCookieKeys, ...(t.adCookieKeysUnsigned ?? []), ...t.firstPartyVendorCookieKeys]) p.counted.add(k);
  for (const s of values(t.byEntityCategory)) {
    for (const k of [...s.cookieKeys, ...s.cookieKeysUnsigned]) p.company.add(k);
    for (const k of s.cookieKeysRequestLost ?? []) p["request lost"].add(k);
    for (const n of s.probeCookies ?? []) p.probeNames.add(n);
    for (const e of s.refusedWrites ?? []) p.notStored.add(e);
  }
  for (const s of values(t.byContainer)) {
    for (const k of [...s.cookieKeys, ...s.cookieKeysUnsigned]) p.container.add(k);
    for (const k of s.cookieKeysRequestLost ?? []) p["request lost"].add(k);
    for (const n of s.probeCookies ?? []) p.probeNames.add(n);
    for (const e of s.refusedWrites ?? []) p.notStored.add(e);
  }
  for (const s of values(t.byUnlistedDomain)) {
    if (!hasRow(s, signalOn)) continue;
    for (const k of [...s.cookieKeys, ...s.cookieKeysUnsigned]) p["domain row"].add(k);
    for (const k of s.cookieKeysRequestLost ?? []) p["request lost"].add(k);
    for (const n of s.probeCookies ?? []) p.probeNames.add(n);
    for (const e of s.refusedWrites ?? []) p.notStored.add(e);
  }
  const fp = t.firstParty;
  if (fp !== undefined) {
    for (const k of [...fp.cookieKeys, ...fp.cookieKeysUnsigned, ...fp.vendorCookieKeysUnsigned]) p["first party"].add(k);
    for (const k of fp.cookieKeysRequestLost ?? []) p["request lost"].add(k);
  }
  for (const names of values(t.probeCookies)) for (const n of names) p.probeNames.add(n);
  for (const entries of values(t.refusedCookieWrites)) for (const e of entries) p.notStored.add(e);
  return p;
}

function placeOf(p, key, name, domain) {
  for (const place of ["counted", "company", "container", "domain row", "first party", "request lost"]) if (p[place].has(key)) return place;
  if (p.probeNames.has(name)) return "probe";
  if (p.notStored.has(`${name} (${domain})`)) return "not stored";
  return null;
}

/** Why a key has no place: the charge, and for a domain with no company, its summary. */
function whyNone(o, charge, domain) {
  if (charge.kind === "container") return "written inside a container, not in its summary";
  if (charge.kind === "owner") return "an owner's name in a container, not in its summary";
  if (charge.entity !== null) return `company in ${charge.category}, not in its summary`;
  const summary = o.tallies.byUnlistedDomain?.[domain];
  if (o.tallies.byUnlistedDomain === undefined) return "no company; the capture has no domain summaries (before 1.26.0)";
  if (summary === undefined) return "no company; no summary for the domain";
  return "no company; the domain's summary has no row";
}

const pages = [];
for (const f of (await readdir(dir)).filter((f) => f.endsWith(".obs.json")).sort()) {
  const o = await readJson(join(dir, f));
  const top = o.context.topSite;
  const p = placesOf(o);
  const seen = new Map();
  const records = [
    ...o.network.flatMap((n) => n.setCookies.map((c) => ({ c, url: n.url, at: n.timeMs }))),
    ...(o.keptCookieResponses ?? []).flatMap((n) => n.setCookies.map((c) => ({ c, url: n.url, at: n.timeMs }))),
  ];
  for (const { c, url, at } of records) {
    if (isCookieDeletion(c, at)) continue;
    const key = keyOf(c);
    if (seen.has(key)) continue;
    const charge = cookieCharge(c, url, top, classifier, owners);
    if (charge.party !== "third") continue;
    seen.set(key, { name: c.name, domain: classifier.classify(url, top).registrableDomain, charge });
  }
  const page = { site: f.replace(/\.obs\.json$/, ""), schema: o.schemaVersion, third: seen.size, placed: {}, none: [] };
  for (const [key, s] of seen) {
    const place = placeOf(p, key, s.name, key.split("\u0000")[1]);
    if (place !== null) page.placed[place] = (page.placed[place] ?? 0) + 1;
    else page.none.push({ name: s.name, domain: s.domain, why: whyNone(o, s.charge, s.domain) });
  }
  pages.push(page);
}

const total = pages.reduce((n, p) => n + p.third, 0);
const none = pages.flatMap((p) => p.none.map((x) => ({ ...x, site: p.site })));
const byPlace = Object.fromEntries(PLACES.map((pl) => [pl, pages.reduce((n, p) => n + (p.placed[pl] ?? 0), 0)]));
const byWhy = {};
for (const x of none) (byWhy[x.why] ??= []).push(x);
const byDomain = {};
for (const x of none) {
  const d = (byDomain[x.domain] ??= { keys: 0, names: new Set(), sites: new Set() });
  d.keys++;
  d.names.add(x.name);
  d.sites.add(x.site);
}

if (args.includes("--json")) {
  console.log(JSON.stringify({ pages: pages.length, thirdPartyKeys: total, noPlace: none.length, byPlace, pagesDetail: pages }, null, 2));
} else {
  const share = total === 0 ? 0 : (100 * none.length) / total;
  const schemas = [...new Set(pages.map((p) => p.schema))].join(", ");
  console.log(`${pages.length} pages (schema ${schemas}), ${total} third-party cookie keys`);
  console.log(`no place: ${none.length} (${share.toFixed(1)}%) on ${new Set(none.map((x) => x.site)).size} pages`);
  console.log("");
  console.log("placed:");
  for (const [pl, n] of Object.entries(byPlace)) console.log(`  ${pl.padEnd(13)} ${n}`);
  console.log("");
  console.log("no place, by why:");
  for (const [why, xs] of Object.entries(byWhy).sort((a, b) => b[1].length - a[1].length)) {
    const sites = new Set(xs.map((x) => x.site));
    console.log(`  ${xs.length}\t${why} (${sites.size} pages): ${xs.slice(0, 6).map((x) => `${x.name} (${x.domain})`).join(", ")}`);
  }
  console.log("");
  console.log("no place, by domain:");
  for (const [d, e] of Object.entries(byDomain).sort((a, b) => b[1].keys - a[1].keys).slice(0, 20)) {
    console.log(`  ${e.keys}\t${d}\t${[...e.sites].slice(0, 3).join(", ")}\t${[...e.names].slice(0, 5).join(", ")}`);
  }
}
