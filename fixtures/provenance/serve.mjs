#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Provenance fixture server.
 *
 * One HTTP server that answers for SEVERAL hostnames, routed by the Host header, so the
 * page and its vendors look to the extension exactly as they do on a real site:
 *
 *   provenance.localhost          the page itself (Chrome resolves *.localhost to loopback)
 *   www.googletagmanager.com      the fake container loader, gtm.js?id=GTM-FIX1 etc.
 *   connect.facebook.net, ...     tiny vendor scripts, on REAL vendor hostnames
 *
 * The classifier is a compiled list keyed on real hostnames, so invented ones would
 * classify as unknown and the engine would never treat them as vendors. Chrome is
 * launched (see chrome.sh) with --host-resolver-rules mapping those hostnames to loopback
 * for a throwaway profile only; nothing on the machine changes.
 *
 * HTTPS on port 443, for two reasons. Several of the vendor domains (facebook.net,
 * amazon-adsystem.com, cookielaw.org) are on Chrome's HSTS preload list, so Chrome
 * upgrades http:// requests to them to https:// before any resolver rule applies; a plain
 * HTTP server never sees those requests at all (found on the first run). And not a high
 * port: a stack frame's URL is extracted by a regex that stops at the first colon after
 * the scheme, so "https://host:8443/x.js" would be recorded as "https://host" and every
 * path-based rule would miss. macOS lets an unprivileged process bind 443 since 10.14.
 *
 * The certificate is self-signed, generated on first run with openssl into
 * fixtures/provenance/.cert/ (gitignored), and chrome.sh passes
 * --ignore-certificate-errors for the throwaway profile only.
 *
 *   node fixtures/provenance/serve.mjs
 */
import { createServer } from "node:https";
import { readFile, mkdir, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env["PORT"] ?? 443);

export const PAGE_HOST = "provenance.localhost";
export const GTM_HOST = "www.googletagmanager.com";
/** Real vendor hostnames the compiled list knows, and what each is for in the fixture. */
export const VENDOR_HOSTS = {
  "connect.facebook.net": "Meta: one path per wrapped method, plus the async loader chain",
  "static.criteo.net": "Criteo: inserted by the site's synchronous inline snippet, and by FIX2",
  "cdn.permutive.com": "Permutive: parser-inserted, and inserted from a deferred site snippet",
  "js.adsrvr.org": "The Trade Desk: inserted with document.write",
  "c.amazon-adsystem.com": "Amazon: gated as text/plain, released by the fake CMP",
  "sb.scorecardresearch.com": "Comscore: inserted by the CHILD container FIX1 loads",
  "cdn.cookielaw.org": "OneTrust (functional, not ad/analytics): the fake CMP, optionally wrapping appendChild",
};

async function certificate() {
  const dir = join(here, ".cert");
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  try {
    await access(key);
    await access(cert);
  } catch {
    await mkdir(dir, { recursive: true });
    const sans = [PAGE_HOST, GTM_HOST, ...Object.keys(VENDOR_HOSTS), "localhost"]
      .map((h) => `DNS:${h}`)
      .join(",");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
      "-keyout", key, "-out", cert, "-subj", "/CN=provenance.localhost",
      "-addext", `subjectAltName=${sans}`,
    ], { stdio: "ignore" });
  }
  return { key: await readFile(key), cert: await readFile(cert) };
}

const js = (body) => ({ type: "text/javascript; charset=utf-8", body });
const html = (body) => ({ type: "text/html; charset=utf-8", body });

/** A vendor script: records that it ran, then does whatever its path says. */
function vendorScript(host, path) {
  const mark = `(window.__fixtureRan = window.__fixtureRan || []).push(${JSON.stringify(host + path)});`;
  switch (path) {
    case "/fixture/loader.js":
      // Container-inserted loader that does its real work later, from its own frames.
      // The stack at that later insertion has no container frame; provenance must come
      // transitively from this loader's own record.
      return js(`${mark}
setTimeout(function () {
  var s = document.createElement("script");
  s.src = "https://${host}/fixture/late-from-loader.js";
  document.head.appendChild(s);
}, 50);`);
    case "/fixture/importer.js":
      // A dynamic import fetches with no DOM insertion at all (resource type "script").
      // Expected: no insertion record; undetermined, never "site".
      return js(`${mark}
import("https://${host}/fixture/module.js").catch(function () {});`);
    case "/fixture/module.js":
      return js(`${mark} export default 1;`);
    default:
      return js(mark);
  }
}

/** The fake CMP on the OneTrust host. */
function cmpScript(query) {
  const wrap = query.get("wrap") === "1";
  return js(`(window.__fixtureRan = window.__fixtureRan || []).push("cdn.cookielaw.org/cmp.js");
${
  wrap
    ? `// Script-blocking CMPs and APM agents replace appendChild AFTER the extension does, so
// their wrapper calls ours and their frame sits beneath ours on every stack. Enabled with
// ?cmpwrap=1 on the page, this reproduces that: every later insertion carries a
// cdn.cookielaw.org frame that is NOT the loader.
(function () {
  var orig = Node.prototype.appendChild;
  Node.prototype.appendChild = function (n) { return orig.call(this, n); };
  var origIB = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function (n, r) { return origIB.call(this, n, r); };
})();`
    : ""
}
// Release the gated script the way a CMP does: clone the text/plain element into a live
// one. The clone's insertion stack is the CMP's, so Amazon resolves as "loaded by OneTrust".
setTimeout(function () {
  var gated = document.querySelector('script[type="text/plain"][data-case="cmp-release"]');
  if (!gated) return;
  var live = document.createElement("script");
  live.src = gated.getAttribute("data-src");
  live.setAttribute("data-case", "cmp-release-live");
  document.head.appendChild(live);
}, 30);`);
}

createServer(await certificate(), async (req, res) => {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  const url = new URL(req.url ?? "/", `https://${host}`);
  let out;
  try {
    if (host === GTM_HOST) {
      if (url.pathname === "/gtm.js") {
        out = js(await readFile(join(here, "fake-gtm.js"), "utf8"));
      } else {
        out = js(`(window.__fixtureRan = window.__fixtureRan || []).push("googletagmanager helper ${url.pathname}");`);
      }
    } else if (host === "cdn.cookielaw.org" && url.pathname === "/cmp.js") {
      out = cmpScript(url.searchParams);
    } else if (host in VENDOR_HOSTS) {
      // Request-initiator cases fetch non-script resources; answer them with something.
      if (/\.(gif|json)$|\/beacon-/.test(url.pathname)) out = { type: "application/octet-stream", body: "" };
      else out = vendorScript(host, url.pathname);
    } else if (host === PAGE_HOST || host === "localhost" || host === "127.0.0.1") {
      if (url.pathname === "/site.js") {
        // The site's own named script file: loads a vendor from a first-party file, which
        // is the "site" bucket, distinct from an inline snippet.
        out = js(`(window.__fixtureRan = window.__fixtureRan || []).push("site.js");
var s = document.createElement("script");
s.src = "https://static.criteo.net/fixture/from-site-file.js";
s.setAttribute("data-case", "site-file");
document.head.appendChild(s);`);
      } else if (url.pathname === "/frame.html") {
        out = html(`<!doctype html><title>frame</title><script>
(window.__fixtureRan = window.__fixtureRan || []).push("frame.html");
var s = document.createElement("script"); s.src = "https://connect.facebook.net/fixture/in-subframe.js";
s.setAttribute("data-case", "subframe"); document.head.appendChild(s);
</script>`);
      } else {
        // The page itself, at "/" and at any path a pushState left it on (a reload after
        // the pushstate case lands on /after-pushstate).
        out = html(await readFile(join(here, "index.html"), "utf8"));
      }
    }
  } catch (e) {
    res.writeHead(500).end(String(e));
    return;
  }
  if (!out) {
    res.writeHead(404).end("not found: " + host + url.pathname);
    return;
  }
  // A cross-origin module import (the importer case) is refused without CORS; scripts
  // inserted as elements do not need it. Harmless to send on everything.
  res.writeHead(200, {
    "content-type": out.type,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(out.body);
}).listen(PORT, () => {
  console.log(`\n  Provenance fixture:  https://${PAGE_HOST}${PORT === 443 ? "" : ":" + PORT}/\n`);
  console.log(`  Answers for: ${[PAGE_HOST, GTM_HOST, ...Object.keys(VENDOR_HOSTS)].join(", ")}`);
  console.log(`  Launch Chrome with fixtures/provenance/chrome.sh so those hosts resolve here.\n`);
});
