#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Renders the toolbar icon: public/icons/gpc-{on,off}-{16,32,48,128}.png, plus the two
 * 128px SVGs as the human-readable source of record.
 *
 * Run by hand when the geometry changes (`npm run icons` in this package) and commit the
 * output, the way `npm run strings` is run for docs/STRINGS.md. The PNGs are committed so
 * `build:ext` never needs the rasterizer, and a checkout without native modules still
 * builds the extension.
 *
 * The mark is the v0.1.4 shield, kept for continuity with the installed base: the store
 * item ID carries over, and an icon that changes shape on update is what a hijacked
 * extension looks like. It is one color, with a magnifier knocked out of the fill: this
 * tool inspects, it does not block. Two states, set per tab by the worker:
 *
 *   on   --accent #185fa5   a GPC signal was observed on this page, whoever set it
 *   off  #5F6368            Google gray 700, the color Chrome paints its own toolbar
 *                           icons, so "off" sits in the same register as the browser's
 *                           controls rather than reading as a warning
 *
 * Each size is its own cut. At 16 a 1.3-unit stroke is a smear, so the lens is bigger
 * and the stroke nearly three units; at 128 the 16px weight is a lollipop. Chrome picks
 * the nearest declared size, so 16 and 32 must still read as the same object — a 2×
 * display shows the 32 where a 1× display shows the 16.
 */

import { Resvg } from "@resvg/resvg-js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "icons");

const GLYPH = "#f5f4ef"; // --bg
const BORDER = "#c9c7bd";
const FILL = { on: "#185fa5", off: "#5F6368" };

// The current silhouette on a 24-unit grid: near-flat top, rounded shoulders, a point.
const SHIELD = "M4.5 4.5h15v7.5c0 4.8-3.6 7.9-7.5 9.5C8.1 19.9 4.5 16.8 4.5 12z";

/** Magnifier cut per rendered size. `r` is the lens radius, `sw` the stroke width. */
function magnifier(px) {
  const c =
    px <= 16
      ? { cx: 13.2, cy: 9.6, r: 3.6, sw: 2.8, hx: 8.2, hy: 14.6 }
      : px <= 32
        ? { cx: 13, cy: 9.8, r: 3.4, sw: 1.8, hx: 8, hy: 14.8 }
        : { cx: 13, cy: 10, r: 3.3, sw: 1.3, hx: 8, hy: 15 };
  // The handle starts on the lens edge at 45°, so it meets the ring rather than crossing it.
  const sx = (c.cx - c.r * Math.SQRT1_2).toFixed(2);
  const sy = (c.cy + c.r * Math.SQRT1_2).toFixed(2);
  return `<g fill="none" stroke="${GLYPH}" stroke-width="${c.sw}" stroke-linecap="round"><circle cx="${c.cx}" cy="${c.cy}" r="${c.r}"/><path d="M${sx} ${sy}L${c.hx} ${c.hy}"/></g>`;
}

function svg(state, px) {
  // Toolbar sizes get a tighter viewBox so the shield fills the button the way Chrome's
  // own 16px glyphs do; the larger sizes keep the full grid, which leaves the 128 inside
  // the store's 96px content area without a separate inset.
  const view = px <= 32 ? "1.5 1.5 21 21" : "0 0 24 24";
  const border = px <= 16 ? 1.8 : 1.6;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}" width="${px}" height="${px}"><path d="${SHIELD}" fill="${FILL[state]}" stroke="${BORDER}" stroke-width="${border}" stroke-linejoin="round"/>${magnifier(px)}</svg>\n`;
}

await mkdir(out, { recursive: true });
for (const state of ["on", "off"]) {
  await writeFile(join(out, `gpc-${state}.svg`), svg(state, 128));
  for (const px of [16, 32, 48, 128]) {
    const png = new Resvg(svg(state, px), { fitTo: { mode: "width", value: px } }).render().asPng();
    await writeFile(join(out, `gpc-${state}-${px}.png`), png);
  }
}
console.log(`Icons written to ${out}`);
