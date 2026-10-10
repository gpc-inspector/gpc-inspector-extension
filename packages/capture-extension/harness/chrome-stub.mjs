// SPDX-License-Identifier: GPL-3.0-only
/**
 * Minimal `chrome` stub so the REAL popup.js runs in a plain browser tab.
 *
 * Fidelity is the point: hand-written mock markup would let CSS be reviewed against DOM the
 * code does not actually emit. This runs the shipped renderers.
 */

import { FIXTURES, TAB_ADDRESSES } from "./fixtures.mjs";

const params = new URLSearchParams(location.search);
const fixtureName = params.get("fixture") ?? "heavy";
const screen = params.get("screen") ?? "overview";
const sending = params.get("sending") !== "0";
const workerDown = params.get("worker") === "down";
const returning = params.get("returning") === "1";

const messages = await fetch("./messages.json").then((r) => r.json());

function getMessage(key, subs) {
  const entry = messages[key];
  if (!entry) return "";
  let out = entry.message;
  const list = subs === undefined ? [] : Array.isArray(subs) ? subs : [subs];
  for (const [name, def] of Object.entries(entry.placeholders ?? {})) {
    const idx = Number(String(def.content).replace("$", "")) - 1;
    out = out.replaceAll(`$${name.toUpperCase()}$`, list[idx] ?? "");
  }
  return out;
}

const settings = {
  sendSignal: sending,
  returningUser: returning,
  observePassively: true,
  showBadge: true,
  checkWellKnown: true,
  // The first-run screen is a fixture of its own; never block the others.
  firstRunComplete: screen !== "firstrun",
};

const observations = FIXTURES[fixtureName]();
// A tab showing a fixture, at the address the popup reads from it.
const tabFor = (id, name, record) => ({
  id,
  windowId: 1,
  url: TAB_ADDRESSES[name] ?? (record?.context.finalUrl || "https://example.com/"),
});
const tab = tabFor(1, fixtureName, observations);

// A second tab in the same window, for the panel to switch to once the screen is open
// (&switch=<fixture>; &switch=no-data is a tab with no record).
const switchTo = params.get("switch");
const otherObservations = switchTo === null ? null : FIXTURES[switchTo]();
const otherTab = tabFor(2, switchTo, otherObservations);
const activated = [];

globalThis.chrome = {
  i18n: { getMessage },
  runtime: {
    getManifest: () => ({ version: "1.0.0" }),
    async sendMessage(msg) {
      if (workerDown) throw new Error("worker unreachable");
      if (msg.type === "get-signal-status") return { sendSignal: sending, ruleInstalled: sending };
      if (msg.type === "get-observations") return msg.tabId === 2 ? otherObservations : observations;
      return undefined;
    },
  },
  tabs: {
    query: async () => [tab],
    get: async (id) => (id === 2 ? otherTab : tab),
    create: async () => {},
    // The panel listens for these. Only a tab switch is ever fired (&switch).
    onActivated: { addListener: (listener) => activated.push(listener) },
    onReplaced: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  windows: { getCurrent: async () => ({ id: 1 }) },
  // Present so the popup shows its "Open in side panel" button; pressing it does nothing here.
  sidePanel: { open: async () => {} },
  storage: {
    local: {
      get: async () => ({ settings }),
      set: async (patch) => Object.assign(settings, patch.settings ?? {}),
      onChanged: { addListener: () => {} },
    },
    session: { onChanged: { addListener: () => {} } },
  },
};

// Only now is `chrome` safe to touch, so the real bundle is imported rather than being a
// second <script> whose evaluation order relative to this one is not guaranteed.
await import("./popup-real.js");

// After popup.js boots, jump to whichever surface this frame is showing.
{
  setTimeout(() => {
    const click = (id) => document.getElementById(id)?.click();
    if (screen === "settings") click("to-settings");
    if (screen === "requests") click("tab-requests");
    if (screen === "report") click("btn-wrong");
    if (screen === "report-bug") click("btn-report-bug");
    if (screen === "report-feature") click("btn-report-feature");
    if (screen === "export") click("btn-export");
    if (screen === "vendors-open") {
      // Not the First party row: its own screen opens it (first-party-open).
      for (const row of document.querySelectorAll("#vendors .vrow, #containers .vrow")) row.click();
    }
    if (screen === "unlisted-open") {
      // The rows of the vendor list's last group, the domains with no company (1.26.0). Each
      // click redraws the list, so every row is found again by its domain.
      const names = [...document.querySelectorAll("#vendors .vrow .vname-wrap")].map((n) => n.textContent);
      for (const name of names) {
        [...document.querySelectorAll("#vendors .vrow")].find((r) => r.querySelector(".vname-wrap")?.textContent === name)?.click();
      }
      document.querySelector("#vendors .vname-wrap")?.closest(".vrow")?.scrollIntoView();
    }
    if (screen === "first-party-open") {
      document.querySelector("#first-party .vrow")?.click();
      document.getElementById("first-party-section")?.scrollIntoView();
    }
    if (screen === "containers-open") {
      document.getElementById("containers-section")?.scrollIntoView();
      for (const row of document.querySelectorAll("#containers .vrow")) row.click();
    }
    if (screen === "requests-container") {
      // A container's script record: the Google tag's, whose names are counted under Google.
      click("tab-requests");
      setTimeout(() => {
        const group = [...document.querySelectorAll(".grp-row")].find((g) => g.textContent.includes("googletagmanager.com"));
        group?.click();
        setTimeout(() => {
          // The record the Google tag's script wrote its cookies on.
          const row = [...document.querySelectorAll(".req-row")].find((r) => r.textContent.includes("gtag/js") && /set \d+ cookies|set 1 cookie/.test(r.textContent));
          row?.click();
        }, 200);
      }, 200);
    }
    if (screen === "strings-open") {
      for (const d of document.querySelectorAll("details.srow-string")) d.open = true;
    }
    if (screen === "gpp-open") {
      // The GPP row only: the first of the four Privacy strings rows (gpp, usp, tcf, gcm).
      const gpp = document.querySelector("details.srow-string");
      if (gpp) gpp.open = true;
    }
    if (screen === "vendor-open") {
      // One vendor's panel, by the name on its row (&vendor=Criteo).
      const name = params.get("vendor");
      const row = [...document.querySelectorAll("#vendors .vrow")].find((r) => r.querySelector(".vname")?.textContent?.trim() === name);
      row?.click();
    }
    if (screen === "requests-open") {
      click("tab-requests");
      setTimeout(() => {
        document.querySelector(".grp-row")?.click();
      }, 200);
    }
    if (switchTo !== null) {
      setTimeout(() => {
        for (const listener of activated) listener({ tabId: 2, windowId: 1 });
      }, 300);
    }
  }, 900);
}
