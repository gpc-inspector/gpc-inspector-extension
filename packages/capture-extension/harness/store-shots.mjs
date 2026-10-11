// SPDX-License-Identifier: GPL-3.0-only
/**
 * The Chrome Web Store screenshots, one entry per image, in listing order.
 *
 * build.mjs turns each into a frame of store.html (`store.html?shot=<name>`): a fictional page
 * in a plain browser window, the REAL popup.html or side panel in an iframe at its real size,
 * a one-line caption and the "Illustrative data" label, 1280x800 in all. store-capture.mjs
 * saves each frame to STORE_SHOTS_DIR, dist-store/ in this package by default. Nothing here
 * ships inside the extension.
 *
 * Captions describe what the extension shows, in the popup's own words. They name no company
 * and give no verdict, and they pass scripts/wording-lint.mjs (harness-fixtures.test.ts).
 */

/**
 * @typedef {object} StoreShot
 * @property {string} name        File name without extension, and the `shot` parameter.
 * @property {string} fixture     The harness fixture it renders.
 * @property {string} query       Extra popup.html parameters: the screen to open.
 * @property {"popup" | "panel"} host
 * @property {string | null} scrollTo  A selector in the popup scrolled to the top of its frame, as a reader would scroll; "vendor:<name>" for a vendor row, "group:<name>" for a group heading.
 * @property {string} site        The fictional page's address.
 * @property {string} caption
 * @property {boolean} chromeStore  In the Chrome Web Store set, which takes five; Edge takes six.
 */

/** @type {readonly StoreShot[]} */
export const SHOTS = [
  {
    name: "shot-honored",
    fixture: "store-honored",
    query: "",
    host: "popup",
    // Scrolled to the status row, so the count under the privacy strings is in the frame.
    scrollTo: ".statusrow",
    site: "https://www.shop.example/",
    caption: "Whether the page showed a GPC confirmation, and whether the site declares GPC support",
    chromeStore: true,
  },
  {
    name: "shot-read-gpc",
    fixture: "store-read-gpc",
    query: "&screen=vendor-open&vendor=Adlark",
    host: "popup",
    scrollTo: "#vendors-check-head",
    site: "https://www.news.example/world/2026/10/01/harbor-report",
    caption: "Which vendors read GPC, and which cookies went back to the vendor that set them",
    chromeStore: true,
  },
  {
    name: "shot-privacy-strings",
    fixture: "store-privacy-strings",
    query: "&screen=gpp-open",
    host: "popup",
    // Scrolled to the notice, so the decoded opt-out fields under it are in the frame.
    scrollTo: "#notices",
    site: "https://www.travel.example/",
    caption: "The privacy strings a site reports to third parties, decoded field by field",
    chromeStore: true,
  },
  {
    name: "shot-side-panel",
    fixture: "store-side-panel",
    query: "&screen=vendor-open&vendor=marketcdn.example",
    host: "panel",
    // The panel's list scrolls in about 516px, which holds two group headings and one open
    // row, not three: Analytics, then the domains with no company, the first of them open.
    // The eight advertising vendors are above it.
    scrollTo: "group:Analytics",
    site: "https://www.market.example/",
    caption: "Vendors by category in the side panel, each with whether its script read GPC",
    chromeStore: true,
  },
  {
    name: "shot-download",
    fixture: "store-notice-cookies",
    query: "&screen=export",
    host: "popup",
    scrollTo: null,
    site: "https://www.autos.example/",
    caption: "Save the findings for any page as a summary or a log, without cookie values",
    chromeStore: true,
  },
  {
    name: "shot-brave",
    fixture: "store-brave",
    query: "",
    host: "popup",
    // Scrolled to the status row, the line the caption is about, so the block under the
    // privacy strings is whole in the frame.
    scrollTo: ".statusrow",
    site: "https://www.recipes.example/soups/winter-squash",
    caption: "When the browser sends GPC itself, the popup says the signal was set by the browser",
    chromeStore: false,
  },
];

/** The frame's geometry, shared by the page and the capture. */
export const FRAME = { width: 1280, height: 800, caption: 64, toolbar: 46, popupWidth: 420, popupMaxHeight: 600, panelWidth: 400, panelHeader: 40 };

/** The small promotional tile. */
export const TILE = { width: 440, height: 280 };
