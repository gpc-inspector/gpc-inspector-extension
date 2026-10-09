#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Visual harness. `npm run harness`, then open the printed URL.
 *
 * Builds every popup surface into one scrollable contact sheet at 420px, each panel
 * rendered by the REAL view model and renderers over a fixture capture. The side panel is
 * the same page in a second host, so it is here too, at the widths a reader can drag it to. That fidelity is
 * the whole point: hand-written mock markup lets CSS be reviewed against DOM the code does
 * not emit, and the drift this exists to catch lives in exactly that gap.
 *
 * Inconsistencies across surfaces (docs/DESIGN.md) are invisible one screen at a time and
 * obvious the moment the surfaces sit side by side: a second section-label treatment,
 * another expand caret, an amber that means two things. Re-run it before and after any
 * change to popup.css, popup.html, or the renderers.
 *
 * Build-time only. Nothing here ships inside the extension.
 */

import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePackages } from "../scripts/compile-packages.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const out = join(pkg, "dist-harness");

// Same as build-extension.mjs: the bundle inlines the packages' compiled output.
compilePackages();

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

/**
 * The popup's classifier, swapped for the harness's: the real list plus the store
 * screenshots' fictional vendors, which are all on the reserved .example TLD
 * (fictional-vendors.mjs). Every real domain classifies as it does in the extension.
 */
const harnessClassifier = {
  name: "harness-classifier",
  setup(b) {
    b.onResolve({ filter: /background\/classifier\.js$/ }, () => ({ path: join(here, "classifier.mjs") }));
  },
};

await build({
  bundle: true,
  target: "chrome114",
  format: "esm",
  logLevel: "warning",
  entryPoints: [join(pkg, "src/ui/popup.ts")],
  outfile: join(out, "popup-real.js"),
  plugins: [harnessClassifier],
});

await cp(join(pkg, "public/popup.css"), join(out, "popup.css"));
await cp(join(pkg, "public/_locales/en/messages.json"), join(out, "messages.json"));
await cp(join(here, "chrome-stub.mjs"), join(out, "chrome-stub.mjs"));
// The store frames (store.html), which draw the toolbar icon beside the popup.
await cp(join(here, "store.html"), join(out, "store.html"));
await cp(join(here, "store-shots.mjs"), join(out, "store-shots.mjs"));
await mkdir(join(out, "icons"), { recursive: true });
await cp(join(pkg, "public/icons/gpc-on.svg"), join(out, "icons/gpc-on.svg"));
// Bundled, not copied: the fixtures import the schema's version and the engine's
// withPersistedShape, so a fixture is in the shape a current capture is.
await build({
  bundle: true,
  target: "chrome114",
  format: "esm",
  logLevel: "warning",
  entryPoints: [join(here, "fixtures.mjs")],
  outfile: join(out, "fixtures.mjs"),
});

// The real popup.html, with the chrome stub in front of the real bundle. The stub imports
// popup-real.js itself rather than being a second <script>, so `chrome` is guaranteed to
// exist before the renderer touches it.
const html = await readFile(join(pkg, "public/popup.html"), "utf8");
await writeFile(
  join(out, "popup.html"),
  html.replace(
    '<script type="module" src="popup.js"></script>',
    '<script type="module" src="chrome-stub.mjs"></script>',
  ),
);

/**
 * The contact sheet.
 *
 * Ordered so the cases most likely to disagree with each other are adjacent: the three
 * Overview variants, then the two zero-states (nothing contacted vs. contacted and set
 * nothing), then the two tabs, then the three modal screens.
 */
const PANELS = [
  ["Overview · ad-heavy", "fixture=heavy"],
  ["Overview · strings open", "fixture=heavy&screen=strings-open"],
  ["Overview · vendors open", "fixture=heavy&screen=vendors-open"],
  ["Overview · GPC/GPP mismatch", "fixture=mismatch"],
  ["Overview · mismatch, strings open", "fixture=mismatch&screen=strings-open"],
  ["Overview · mismatch, vendors open", "fixture=mismatch&screen=vendors-open"],
  ["Overview · no container (direct)", "fixture=direct"],
  ["Overview · container, no checks", "fixture=quiet-container"],
  ["Overview · two containers, one checked", "fixture=two-containers"],
  ["Overview · zone and bidder chain, vendors open", "fixture=zone&screen=vendors-open"],
  ["Overview · tag containers", "fixture=containers"],
  ["Overview · tag containers open", "fixture=containers&screen=containers-open"],
  ["Overview · tag containers after a worker reclaim, open", "fixture=containers-reclaimed&screen=containers-open"],
  ["Overview · seven Google tag ids, open", "fixture=sevenTags&screen=containers-open"],
  ["Overview · no company found for this domain", "fixture=unlisted-domains"],
  ["Overview · no company found, vendors open", "fixture=unlisted-domains&screen=vendors-open"],
  ["Overview · no company found after a worker reclaim, open", "fixture=unlisted-domains-reclaimed&screen=unlisted-open"],
  ["Overview · first party", "fixture=first-party"],
  ["Overview · first party, both lists and capped, open", "fixture=first-party&screen=first-party-open"],
  ["Overview · first party, one list empty, open", "fixture=unlisted-domains&screen=first-party-open"],
  ["Requests · a container's script record open", "fixture=containers&screen=requests-container"],
  ["Google Consent Mode · no Google tags", "fixture=clean&screen=strings-open"],
  ["Privacy strings · requests did not agree, open", "fixture=requests-disagree&screen=strings-open"],
  ["Google Consent Mode · 1 of 4 granted, open", "fixture=sevenTags&screen=strings-open"],
  ["Google Consent Mode · not set, open", "fixture=containers&screen=strings-open"],
  ["Google Consent Mode · could not be read", "fixture=quiet-container&screen=strings-open"],
  ["Overview · listed as functional, vendors open", "fixture=functional&screen=vendors-open"],
  ["Requests · listed as functional", "fixture=functional&screen=requests-open"],
  ["Overview · honored", "fixture=honored"],
  ["Overview · confirmation shown, cookies set", "fixture=shown-and-set"],
  ["Overview · signal off", "fixture=signal-off&sending=0"],
  ["Overview · no ad tech", "fixture=clean"],
  ["Overview · capture gaps", "fixture=unavailable"],
  ["Overview · needs reload", "fixture=needs-reload"],
  ["Overview · after a worker reclaim", "fixture=reclaimed"],
  ["Overview · save failed", "fixture=save-failed"],
  ["Overview · page data missing", "fixture=delivery-gap"],
  ["Overview · consent checks capped", "fixture=consent-capped"],
  ["Overview · did not load", "fixture=load-failed"],
  ["Overview · Consent Mode from the consent store", "fixture=consent-store"],
  ["Overview · no data", "fixture=no-data"],
  ["Requests", "fixture=heavy&screen=requests"],
  ["Requests · group open", "fixture=heavy&screen=requests-open"],
  ["Requests · after a worker reclaim", "fixture=reclaimed&screen=requests"],
  ["Requests · after a reclaim, cookie requests kept", "fixture=reclaimed-kept&screen=requests"],
  ["Requests · after a reclaim, some cookie requests kept", "fixture=reclaimed-some-kept&screen=requests"],
  ["Settings", "fixture=heavy&screen=settings"],
  ["Report · finding", "fixture=heavy&screen=report"],
  ["Report · bug", "fixture=heavy&screen=report-bug"],
  ["Report · feature", "fixture=heavy&screen=report-feature"],
  ["Download findings", "fixture=heavy&screen=export"],
  ["First run · new user", "fixture=heavy&screen=firstrun"],
  ["First run · returning, signal on", "fixture=heavy&screen=firstrun&returning=1"],
  ["First run · returning, signal off", "fixture=signal-off&screen=firstrun&returning=1&sending=0"],
  // The browser sends the signal itself (Brave today, Chrome under AB 566): the status row,
  // Settings and the returning user's first-run line all point at the browser. A new user's
  // first run carries no signal line, so it is the one above. -off: the browser has it off.
  ["Overview · the browser sends the signal", "fixture=store-brave"],
  ["Settings · the browser sends the signal", "fixture=store-brave&screen=settings"],
  ["First run · returning, the browser sends the signal", "fixture=store-brave&screen=firstrun&returning=1"],
  ["Overview · the browser has the signal off", "fixture=store-brave-off"],
  ["Settings · the browser has the signal off", "fixture=store-brave-off&screen=settings"],
  ["First run · returning, the browser has the signal off", "fixture=store-brave-off&screen=firstrun&returning=1"],
  // The store screenshots' popups, unframed (store.html frames them).
  ["Store · honored", "fixture=store-honored"],
  ["Store · confirmation notice and cookies", "fixture=store-notice-cookies"],
  ["Store · Read GPC, Adlark open", "fixture=store-read-gpc&screen=vendor-open&vendor=Adlark"],
  ["Store · privacy strings, GPP open", "fixture=store-privacy-strings&screen=gpp-open"],
];

/**
 * The side panel: popup.html with host=panel, as the manifest's side_panel entry opens it.
 *
 * Its width is the reader's, from 320px (the narrowest Chrome makes a panel's content)
 * upward, so the same two tabs are drawn at each width that changes something: 320, the
 * default of about 360, the popup's own 420, and 600 for a panel dragged wide. Request
 * groups are two lines below 400px and one line from there. The clean page is here for the
 * footer, which sits at the foot of the panel when the page does not fill it.
 */
const PANEL_WIDTHS = [320, 360, 420, 600];
const PANEL_PANELS = [
  ...PANEL_WIDTHS.map((w) => [`Panel · Overview · ${w}px`, "fixture=heavy&host=panel", w]),
  ...PANEL_WIDTHS.map((w) => [`Panel · Requests, group open · ${w}px`, "fixture=heavy&host=panel&screen=requests-open", w]),
  ...PANEL_WIDTHS.map((w) => [`Panel · Requests, a script's cookie writes open · ${w}px`, "fixture=containers&host=panel&screen=requests-container", w]),
  ...PANEL_WIDTHS.map((w) => [`Panel · Requests after a reclaim · ${w}px`, "fixture=reclaimed&host=panel&screen=requests", w]),
  ...PANEL_WIDTHS.map((w) => [`Panel · Requests after a reclaim, cookie requests kept · ${w}px`, "fixture=reclaimed-kept&host=panel&screen=requests", w]),
  ...PANEL_WIDTHS.map((w) => [`Panel · save failed · ${w}px`, "fixture=save-failed&host=panel", w]),
  ...PANEL_WIDTHS.map((w) => [`Panel · tag containers open · ${w}px`, "fixture=containers&host=panel&screen=containers-open", w]),
  ...PANEL_WIDTHS.map((w) => [`Panel · seven Google tag ids, open · ${w}px`, "fixture=sevenTags&host=panel&screen=containers-open", w]),
  ...PANEL_WIDTHS.map((w) => [`Panel · no company found, vendors open · ${w}px`, "fixture=unlisted-domains&host=panel&screen=vendors-open", w]),
  ...PANEL_WIDTHS.map((w) => [`Panel · first party, open · ${w}px`, "fixture=first-party&host=panel&screen=first-party-open", w]),
  ...PANEL_WIDTHS.map((w) => [`Panel · first party, one list empty, open · ${w}px`, "fixture=unlisted-domains&host=panel&screen=first-party-open", w]),
  ["Panel · vendors open · 320px", "fixture=heavy&host=panel&screen=vendors-open", 320],
  ["Panel · no ad tech · 360px", "fixture=clean&host=panel", 360],
  ["Panel · Settings · 320px", "fixture=heavy&host=panel&screen=settings", 320],
  ["Panel · Report · 320px", "fixture=heavy&host=panel&screen=report", 320],
  ...PANEL_WIDTHS.map((w) => [`Panel · Download findings · ${w}px`, "fixture=heavy&host=panel&screen=export", w]),
  ["Panel · First run · 320px", "fixture=heavy&host=panel&screen=firstrun", 320],
  ["Panel · store, a domain with no company open · 400px", "fixture=store-side-panel&host=panel&screen=vendor-open&vendor=marketcdn.example", 400],
];

const sheet = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>GPC Inspector — every surface</title>
<style>
  body { margin:0; background:#8a8a84; font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .bar { position:sticky; top:0; z-index:9; display:flex; gap:16px; align-items:center;
         padding:9px 14px; background:#25251f; color:#eee; }
  .bar code { background:#000; padding:1px 5px; border-radius:3px; color:#ccc; }
  .grid { display:flex; flex-wrap:wrap; gap:18px; padding:18px; align-items:flex-start; }
  figure { margin:0; }
  figcaption { color:#fff; font-weight:600; padding:0 0 6px 2px; text-shadow:0 1px 2px rgba(0,0,0,.4); }
  iframe { width:var(--w,420px); height:var(--h,900px); border:0; border-radius:10px;
           box-shadow:0 6px 20px rgba(0,0,0,.28); background:#fff; display:block; }
  h2 { margin:0; padding:6px 20px 0; color:#fff; font-size:14px; text-shadow:0 1px 2px rgba(0,0,0,.4); }
  @media (prefers-color-scheme: dark) { body { background:#0d0d0c; } }
</style></head><body>
<div class="bar">
  <strong>Every popup surface, at 420px, then the side panel</strong>
  <label>panel height <input type="range" id="h" min="380" max="2400" value="900"></label>
  <span>dark mode: switch the OS theme, or emulate <code>prefers-color-scheme</code> in devtools</span>
  <a href="store.html" style="color:#9cc4f0">store frames</a>
</div>
<div class="grid">
${PANELS.map(
  ([label, q]) =>
    `<figure><figcaption>${label}</figcaption><iframe loading="lazy" src="popup.html?${q}"></iframe></figure>`,
).join("\n")}
</div>
<h2>Side panel</h2>
<div class="grid">
${PANEL_PANELS.map(
  ([label, q, w]) =>
    `<figure><figcaption>${label}</figcaption><iframe loading="lazy" style="--w:${w}px" src="popup.html?${q}"></iframe></figure>`,
).join("\n")}
</div>
<script>
  const h = document.getElementById("h");
  const apply = () => document.documentElement.style.setProperty("--h", h.value + "px");
  h.addEventListener("input", apply);
  apply();
</script>
</body></html>`;

await writeFile(join(out, "index.html"), sheet);

// Served rather than opened from file://, because the popup bundle and the stub are ES
// modules and file:// origins cannot import them.
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};
// HARNESS_PORT for a hand-picked port; PORT for a preview tool that assigns one when
// another server already holds 8731.
const PORT = Number(process.env["HARNESS_PORT"] ?? process.env["PORT"] ?? 8731);

createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  // normalize() before joining: without it a request for ../../.. escapes dist-harness.
  const file = join(out, normalize(path === "/" ? "/index.html" : path));
  if (!file.startsWith(out)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, () => {
  console.log(`\n  Harness ready:  http://localhost:${PORT}/\n`);
  console.log(`  One surface:    http://localhost:${PORT}/popup.html?fixture=heavy`);
  console.log(`  Fixtures:       heavy · mismatch · direct · quiet-container · two-containers · zone · containers · sevenTags · unlisted-domains · first-party · honored · clean · unavailable · needs-reload · no-data`);
  console.log(`  Screens:        &screen=requests|settings|report|export|firstrun|vendors-open|unlisted-open|first-party-open|strings-open|containers-open|requests-container`);
  console.log(`  Side panel:     &host=panel, in a window or frame as wide as the panel`);
  console.log(`  Store frames:   http://localhost:${PORT}/store.html (one: ?shot=shot-honored; the tile: ?tile=small)\n`);
  console.log(`  Ctrl-C to stop. Re-run after editing popup.css / popup.html / src/ui.\n`);
});
