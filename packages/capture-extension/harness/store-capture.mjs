#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Save the store frames as PNGs in the folder STORE_SHOTS_DIR names, an absolute path or one
 * relative to the repository root, and in packages/capture-extension/dist-store/ when it
 * names none. dist-store/ is gitignored: the frames are output, not source.
 *
 *   npm run harness                                   # in one terminal
 *   node packages/capture-extension/harness/store-capture.mjs
 *
 * Each frame of store.html (store-shots.mjs) is opened in headless Chrome at exactly its
 * size, one device pixel per CSS pixel, light scheme, and saved; then the 440x280 tile, the
 * 1400x560 marquee tile, and the 300x300 logo Edge Add-ons asks for, rendered from the
 * toolbar icon's SVG. Every PNG's size is read back from its header and must match. CHROME
 * names another browser binary; HARNESS_URL another harness.
 *
 * Build-time only. Nothing here ships inside the extension.
 */

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { SHOTS, FRAME, TILE, MARQUEE } from "./store-shots.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const out = resolve(root, process.env["STORE_SHOTS_DIR"] || "packages/capture-extension/dist-store");
const chrome = process.env["CHROME"] ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const harness = (process.env["HARNESS_URL"] ?? "http://localhost:8731").replace(/\/$/, "");

await mkdir(out, { recursive: true });

// Headless Chrome names itself "HeadlessChrome" in its user agent, and the Download findings
// screen prints the user agent. The frames show the browser a reader has.
const major = spawnSync(chrome, ["--version"], { encoding: "utf8" }).stdout.match(/(\d+)\./)?.[1];
if (!major) throw new Error(`could not read the version of ${chrome}`);
const userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;

/** Width and height from a PNG's IHDR chunk. */
async function pngSize(path) {
  const b = await readFile(path);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

async function capture(query, file, { width, height }) {
  const path = join(out, file);
  const r = spawnSync(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--force-color-profile=srgb",
    "--blink-settings=preferredColorScheme=1",
    `--window-size=${width},${height}`,
    `--user-agent=${userAgent}`,
    // The popup draws after its fetches, and the chrome stub opens its screen at 900ms; the
    // frame scrolls at 1600ms. Virtual time runs those without waiting on the wall clock.
    "--virtual-time-budget=6000",
    `--screenshot=${path}`,
    `${harness}/store.html?${query}`,
  ], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${file}: Chrome exited ${r.status}\n${r.stderr}`);
  const size = await pngSize(path);
  if (size.width !== width || size.height !== height) {
    throw new Error(`${file}: ${size.width}x${size.height}, expected ${width}x${height}`);
  }
  console.log(`  ${file}  ${size.width}x${size.height}`);
}

for (const shot of SHOTS) await capture(`shot=${shot.name}`, `${shot.name}.png`, FRAME);
await capture("tile=small", "promo-small-440x280.png", TILE);
await capture("tile=marquee", "promo-marquee-1400x560.png", MARQUEE);

// Edge Add-ons: a 1:1 logo, 300x300 recommended (the Chrome store takes the 128px icon).
const svg = await readFile(join(here, "../public/icons/gpc-on.svg"), "utf8");
const logo = new Resvg(svg, { fitTo: { mode: "width", value: 300 } }).render().asPng();
await writeFile(join(out, "edge-logo-300.png"), logo);
const logoSize = await pngSize(join(out, "edge-logo-300.png"));
if (logoSize.width !== 300 || logoSize.height !== 300) throw new Error(`edge-logo-300.png: ${logoSize.width}x${logoSize.height}`);
console.log(`  edge-logo-300.png  300x300`);
