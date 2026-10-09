#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Launch a throwaway Chrome with the unpacked extension loaded, the fixture's vendor
 * hostnames resolved to loopback, and the self-signed certificate accepted.
 *
 * Why Node and not a shell script: Google Chrome 137 and later ignore --load-extension
 * (found the hard way on 152: the flag is accepted and nothing loads). The supported route
 * is the DevTools command Extensions.loadUnpacked, which Chrome only honors over a
 * debugging PIPE (fds 3 and 4) started with --enable-unsafe-extension-debugging. A shell
 * cannot hold that pipe; this file can. A TCP debugging port is opened as well so
 * inspect.mjs can talk to the page and the worker the ordinary way.
 *
 *   node fixtures/provenance/launch.mjs            # opens https://provenance.localhost/
 *   node fixtures/provenance/launch.mjs "?cmpwrap=1"
 *   node fixtures/provenance/launch.mjs --real     # no host rules: for measuring real sites
 */
import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const ext = join(root, "packages/capture-extension/dist-ext");
const profile = join(process.env["TMPDIR"] ?? tmpdir(), "gpc-inspector-provenance-profile");
const chrome = process.env["CHROME"] ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const devtoolsPort = Number(process.env["DEVTOOLS_PORT"] ?? 9333);
const real = process.argv.includes("--real");
const query = process.argv.find((a) => a.startsWith("?")) ?? "";

try {
  await access(join(ext, "manifest.json"));
} catch {
  console.error("dist-ext is missing; run: npm run build:ext --workspace packages/capture-extension");
  process.exit(1);
}
await mkdir(profile, { recursive: true });

// Exactly the hosts serve.mjs answers for. *.localhost needs no rule.
const hosts = [
  "www.googletagmanager.com",
  "connect.facebook.net",
  "static.criteo.net",
  "cdn.permutive.com",
  "js.adsrvr.org",
  "c.amazon-adsystem.com",
  "sb.scorecardresearch.com",
  "cdn.cookielaw.org",
];
const rules = real ? "" : hosts.map((h) => `MAP ${h} 127.0.0.1`).join(", ");

const child = spawn(
  chrome,
  [
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-pipe",
    `--remote-debugging-port=${devtoolsPort}`,
    "--enable-unsafe-extension-debugging",
    ...(real ? [] : [`--host-resolver-rules=${rules}`, "--ignore-certificate-errors"]),
    "about:blank",
  ],
  // fd 3: we write to Chrome; fd 4: Chrome writes to us. Messages are JSON, NUL-terminated.
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
);
const toChrome = child.stdio[3];
const fromChrome = child.stdio[4];

let nextId = 0;
const pending = new Map();
let buffer = "";
fromChrome.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nul;
  while ((nul = buffer.indexOf("\0")) >= 0) {
    const raw = buffer.slice(0, nul);
    buffer = buffer.slice(nul + 1);
    const msg = JSON.parse(raw);
    const p = pending.get(msg.id);
    if (!p) continue;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  }
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    toChrome.write(JSON.stringify({ id, method, params }) + "\0");
  });
}

child.on("exit", (code) => {
  console.log(`Chrome exited (${code})`);
  process.exit(0);
});

try {
  const { id } = await send("Extensions.loadUnpacked", { path: ext });
  console.log(`Extension loaded: ${id}`);
  if (!real) {
    await send("Target.createTarget", { url: `https://provenance.localhost/${query}` });
    console.log(`Opened https://provenance.localhost/${query}`);
  }
  console.log(`DevTools on http://127.0.0.1:${devtoolsPort}/json; Ctrl-C closes Chrome.`);
} catch (e) {
  console.error("Failed:", e.message);
  child.kill();
  process.exit(1);
}
