// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { installFakeChrome, type FakeChrome } from "./fakes/chrome.js";
import { emptyTabState } from "../src/background/state.js";
import { tabKey } from "../src/background/tab-key.js";

/**
 * Wiring tests.
 *
 * These assert that messages CROSS between contexts, which no other test in this project
 * does. Failures of that kind pass every unit test:
 *
 *   - a message handler that requires `sender.tab` drops every popup message,
 *   - a bridge that relays the signal state once discards the corrected value,
 *   - a permission flag read once at startup is read before the script that sets it runs,
 *   - a policy that re-applies only at install and startup never applies a change.
 *
 * A unit test asks whether a function behaves when called. It cannot ask whether anything
 * calls it.
 *
 * The service worker registers its listeners at module scope, so the fake must be installed
 * before the import — hence the dynamic import inside each suite.
 */

let fake: FakeChrome;

/** The MAIN-world scripts registered by setting, in order (see applySettingsScripts). */
function settingsScripts(): string[] | undefined {
  const all = fake.registeredScripts() as { id: string; js?: string[] }[];
  expect(all.filter((s) => s.id === "gpc-settings")).toHaveLength(1);
  return all.find((s) => s.id === "gpc-settings")?.js;
}

async function loadWorker(): Promise<void> {
  // Fresh module instance per test: the worker holds per-tab state in module scope, and a
  // shared instance would let one test's observations leak into another's assertions.
  // resetModules rather than a cache-busting import specifier, which Vite cannot resolve.
  vi.resetModules();
  fake = installFakeChrome();
  await import("../src/background/sw.js");
}

/**
 * Tear down between tests.
 *
 * Without this, a pending setTimeout registered by one test's worker instance can still be
 * on the event loop when the next test installs a NEW fake `chrome` and loads a NEW worker
 * module. The stale timer fires against globals that have since been replaced — at best a
 * silent no-op, at worst a callback that races the next test's own async work and steals or
 * delays its resolution. Observed as an intermittent 10-second timeout on a test that is
 * solid in isolation (5/5) and fails only as part of the full file — the signature of a
 * leak between tests rather than a defect in any one of them.
 *
 * Real timers, cleared explicitly: the worker code uses plain setTimeout, not vi's fake
 * timer API, so there is nothing to fake — only stale ones to cancel.
 */
afterEach(() => {
  vi.clearAllTimers();
  fake.reset();
});

/**
 * Warm the module graph once, on a budget sized for it.
 *
 * Every per-test reload re-evaluates the worker's module graph, but only the FIRST import
 * in a process pays to read and transform it — the engine, the schema, the classifier and
 * its 394KB compiled list. Warm, a reload is ~160ms. Cold, the first import has been
 * measured at over 30 seconds and the suite's transform at 63s (2026-09-08).
 *
 * The cause: a checkout under an iCloud-synced folder, where macOS evicts files when the
 * disk runs low, so the first read of each one is a download. A run of 7m20s wall clock
 * with 5s of CPU is that download. A copy of the tree into /private/tmp, which iCloud does
 * not manage, ran cold at 4.5s, and a Linux CI runner never sees any of it. Diagnostic:
 * `find node_modules -type f -flags +dataless | wc -l`.
 *
 * The hook exists for the shape of that cost, not the cause: one large hit on the first
 * import, small ones after. A suite-wide `hookTimeout` is wrong in both directions: too
 * small for the one cold import, too large for every other hook, which should fail in
 * seconds when something genuinely hangs. So the cold cost is paid here, once, with the one
 * generous budget, and per-test reloads keep the default. If this hook ever times out, the
 * failure carries its name rather than that of whichever test ran first. Verified cold: the
 * 63s run above passed under this hook, and would fail under a 30s budget.
 *
 * Torn down like any test's instance: the reload in each `beforeEach` replaces it.
 */
const COLD_IMPORT_BUDGET_MS = 180_000;

beforeAll(async () => {
  await loadWorker();
  vi.clearAllTimers();
  fake.reset();
}, COLD_IMPORT_BUDGET_MS);

describe("popup messages reach the worker", () => {
  beforeEach(async () => {
    await loadWorker();
  });

  it("answers get-signal-status from a sender with no tab", async () => {
    // A popup message has no sender.tab. A handler that returns false for a message with no
    // tab leaves the popup with undefined, which it reads as "not sending": it would render
    // "sending off in settings" while the setting is on and the DNR rule installed, with
    // every layer correct in isolation.
    const response = (await fake.sendFromPopup({ type: "get-signal-status" })) as
      | { sendSignal: boolean; ruleInstalled: boolean }
      | undefined;

    expect(response).toBeDefined();
    expect(typeof response?.sendSignal).toBe("boolean");
    expect(typeof response?.ruleInstalled).toBe("boolean");
  });

  it("answers get-observations for an explicit tab id", async () => {
    const response = await fake.sendFromPopup({ type: "get-observations", tabId: 42 });
    expect(response).toBeDefined();
  });

  it("returns null rather than hanging when no tab can be resolved", async () => {
    const response = await fake.sendFromPopup({ type: "get-observations" });
    expect(response).toBeNull();
  });

  it("acts on settings-changed from the popup", async () => {
    // storage.onChanged is registered too, but it is not a dependable wake-up for a
    // terminated MV3 worker. A setting that only takes effect when the worker happens to be
    // awake is a setting that does not work.
    await fake.sendFromPopup({ type: "settings-changed" });
    // The default is sendSignal: true, so reconciling installs the header rule.
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.dynamicRules().some((r) => r.id === 1)).toBe(true);
  });
});

describe("the send setting actually governs the header rule", () => {
  beforeEach(async () => {
    await loadWorker();
  });

  it("installs the rule when sending is on", async () => {
    await fake.sendFromPopup({ type: "get-signal-status" });
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.dynamicRules().some((r) => r.id === 1)).toBe(true);
  });

  it("titles the default icon with the setting, naming no page", async () => {
    // The default stays on chrome:// and new-tab pages, which never report, so it must not
    // say "a GPC signal is set on this page". "Set on this page" waits for a page's report.
    await fake.sendFromPopup({ type: "get-signal-status" });
    await new Promise((r) => setTimeout(r, 10));
    const defaults = fake.titleCalls().filter((c) => c.tabId === undefined);
    expect(defaults.at(-1)?.title).toBe("actionTitleSending");
    expect(defaults.some((c) => c.title === "actionTitleOn")).toBe(false);
  });

  it("titles a refused rule from messages, and logs the browser's reason instead", async () => {
    // The browser's reason ("rule absent after update") is untranslated, so it goes to the
    // console and never into the title.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fake.refuseRules(true);
    try {
      await fake.sendFromPopup({ type: "get-signal-status" });
      await new Promise((r) => setTimeout(r, 10));
      expect(fake.titleCalls().filter((c) => c.tabId === undefined).at(-1)?.title).toBe("actionTitleRuleFailed");
      expect(warn.mock.calls.some((c) => String(c[0]).includes("rule absent after update"))).toBe(true);
    } finally {
      fake.refuseRules(false);
      warn.mockRestore();
    }
  });

  it("removes the rule when sending is turned off", async () => {
    // Run only at install and startup, applySignalPolicy would never remove the rule, and
    // Sec-GPC would keep going out after the user turned sending off. A privacy tool that
    // ignores its own off switch is worse than one that offers none.
    await fake.sendFromPopup({ type: "get-signal-status" });
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.dynamicRules().some((r) => r.id === 1)).toBe(true);

    await chrome.storage.local.set({
      settings: {
        sendSignal: false,
        observePassively: true,
        showBadge: true,
        checkWellKnown: true,
        firstRunComplete: true,
      },
    });
    await fake.sendFromPopup({ type: "settings-changed" });
    await new Promise((r) => setTimeout(r, 10));

    expect(fake.dynamicRules().some((r) => r.id === 1)).toBe(false);
  });

  it("registers the permission script only while sending is on", async () => {
    // The MAIN-world script that permits assertion is registered dynamically, because a
    // content script in that world cannot read chrome.storage and cannot be told a setting
    // asynchronously — the property must exist before the page's first script runs.
    await fake.sendFromPopup({ type: "get-signal-status" });
    await new Promise((r) => setTimeout(r, 10));
    expect(settingsScripts()).toEqual(["main-world-assert.js", "main-world-insertion.js", "main-world-seal.js"]);

    await chrome.storage.local.set({
      settings: {
        sendSignal: false,
        observePassively: true,
        showBadge: true,
        checkWellKnown: true,
        firstRunComplete: true,
      },
    });
    await fake.sendFromPopup({ type: "settings-changed" });
    await new Promise((r) => setTimeout(r, 10));

    expect(settingsScripts()).toEqual(["main-world-insertion.js", "main-world-seal.js"]);
  });

  it("leaves things as the last setting says when sending is turned on and off at once", async () => {
    // Two policy runs at a time would each read the registration before the other changed
    // it: a slow registration for "on" could land after the run for "off" found nothing to
    // remove, and the assert script would stay registered with sending off.
    const scripting = chrome.scripting as unknown as { registerContentScripts: (items: unknown[]) => Promise<void> };
    const register = scripting.registerContentScripts.bind(scripting);
    let first = true;
    scripting.registerContentScripts = async (items) => {
      if (first) {
        first = false;
        await new Promise((r) => setTimeout(r, 30));
      }
      await register(items);
    };

    const on = fake.sendFromPopup({ type: "settings-changed" });
    await chrome.storage.local.set({
      settings: { sendSignal: false, observePassively: true, showBadge: true, checkWellKnown: true, firstRunComplete: true },
    });
    const off = fake.sendFromPopup({ type: "settings-changed" });
    await Promise.all([on, off]);
    await new Promise((r) => setTimeout(r, 150));

    expect(settingsScripts()).toEqual(["main-world-insertion.js", "main-world-seal.js"]);
    expect(fake.dynamicRules().some((r) => r.id === 1)).toBe(false);
  });

  it("swaps the scripts in place, so a page never starts with no registration", async () => {
    // Unregistering a changed list and then registering it would let a page that started
    // between the two run with no assert script and no seal.
    await fake.sendFromPopup({ type: "get-signal-status" });
    await new Promise((r) => setTimeout(r, 10));
    const scripting = chrome.scripting as unknown as { unregisterContentScripts: (f: { ids: string[] }) => Promise<void> };
    const unregister = scripting.unregisterContentScripts.bind(scripting);
    const removed: string[] = [];
    scripting.unregisterContentScripts = async (f) => {
      removed.push(...f.ids);
      await unregister(f);
    };

    await chrome.storage.local.set({
      settings: { sendSignal: false, observePassively: true, showBadge: true, checkWellKnown: true, firstRunComplete: true },
    });
    await fake.sendFromPopup({ type: "settings-changed" });
    await new Promise((r) => setTimeout(r, 10));

    expect(removed).toEqual([]);
    expect(settingsScripts()).toEqual(["main-world-insertion.js", "main-world-seal.js"]);
  });

  it("replaces the scripts another way when the swap fails, so the assert script never outlives sending", async () => {
    await fake.sendFromPopup({ type: "get-signal-status" });
    await new Promise((r) => setTimeout(r, 10));
    (chrome.scripting as unknown as { updateContentScripts: () => Promise<void> }).updateContentScripts = async () => {
      throw new Error("not supported");
    };

    await chrome.storage.local.set({
      settings: { sendSignal: false, observePassively: true, showBadge: true, checkWellKnown: true, firstRunComplete: true },
    });
    await fake.sendFromPopup({ type: "settings-changed" });
    await new Promise((r) => setTimeout(r, 10));

    expect(settingsScripts()).toEqual(["main-world-insertion.js", "main-world-seal.js"]);
  });

  it("replaces the registrations an earlier version left under their own ids", async () => {
    await chrome.scripting.registerContentScripts([
      { id: "gpc-assert", js: ["main-world-assert.js"], matches: ["<all_urls>"], runAt: "document_start", world: "MAIN" },
    ]);
    await fake.sendFromPopup({ type: "get-signal-status" });
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.registeredScripts().map((s) => s.id)).toEqual(["gpc-settings"]);
  });

  it("repairs drift when the popup asks for status", async () => {
    // Opening the popup reconciles the rule with the setting, rather than reporting the
    // drift as the user's choice.
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1] });
    expect(fake.dynamicRules()).toHaveLength(0);

    await fake.sendFromPopup({ type: "get-signal-status" });
    await new Promise((r) => setTimeout(r, 10));

    expect(fake.dynamicRules().some((r) => r.id === 1)).toBe(true);
  });
});

describe("content script reports reach the worker", () => {
  beforeEach(async () => {
    await loadWorker();
  });

  it("records a signal-state report against the sending tab", async () => {
    await fake.sendFromTab(7, {
      type: "signal-state",
      source: "this-extension",
      readTracking: "active",
      value: true,
    });
    await new Promise((r) => setTimeout(r, 200));

    const state = fake.sessionStore()["tab:7"] as
      | { signalSource: string; stateMessages: number; propertyValue: unknown }
      | undefined;
    expect(state?.signalSource).toBe("this-extension");
    expect(state?.propertyValue).toBe(true);
    expect(state?.stateMessages).toBeGreaterThan(0);
  });

  it("writes the record under the key the side panel watches", async () => {
    // The panel refreshes when this key changes in session storage (ui/panel.ts). A worker
    // writing under any other key would leave an open panel showing the first answer it got.
    await fake.sendFromTab(7, {
      type: "signal-state",
      source: "this-extension",
      readTracking: "active",
      value: true,
    });
    await new Promise((r) => setTimeout(r, 200));

    expect(Object.keys(fake.sessionStore())).toContain(tabKey(7));
  });

  it("records an owner whose property says false, rather than inferring true from the source", async () => {
    // Derived as `source === "none" ? false : true`, propertyValue would make ANY owner
    // mean `true`, and a native or other-extension implementation that exists and reports
    // false (the browser supports GPC, the user has it switched off) would be recorded as an
    // asserted signal. Who owns the property and what it says are two different facts.
    await fake.sendFromTab(20, {
      type: "signal-state",
      source: "native",
      readTracking: "active",
      value: false,
    });
    await new Promise((r) => setTimeout(r, 200));

    const state = fake.sessionStore()["tab:20"] as
      | { signalSource: string; propertyValue: unknown }
      | undefined;
    expect(state?.signalSource).toBe("native");
    expect(state?.propertyValue).toBe(false);
  });

  it("sets the tab's icon from the page's report, not from our own setting", async () => {
    // A native or other-extension signal must light the icon: the icon says whether a
    // signal was observed on the page, and gray beside a browser that is sending would
    // state the opposite of the truth. Needs a site, or the tab keeps the default icon.
    await chrome.storage.session.set({
      "tab:30": { ...emptyTabState(30), topSite: "example.com", finalUrl: "https://example.com/" },
      "tab:31": { ...emptyTabState(31), topSite: "example.com", finalUrl: "https://example.com/" },
    });
    await fake.sendFromTab(30, {
      type: "signal-state",
      source: "native",
      readTracking: "active",
      value: true,
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(fake.iconCalls().some((c) => c.tabId === 30 && c.state === "on")).toBe(true);
    // Only a page's own report says "set on this page".
    expect(fake.titleCalls().filter((c) => c.tabId === 30).at(-1)?.title).toBe("actionTitleOn");

    await fake.sendFromTab(31, {
      type: "signal-state",
      source: "native",
      readTracking: "active",
      value: false,
    });
    await new Promise((r) => setTimeout(r, 200));
    const last31 = fake.iconCalls().filter((c) => c.tabId === 31).at(-1);
    expect(last31?.state).toBe("off");
  });

  it("does not let a subframe's absent property downgrade a concrete report", async () => {
    // Same frame rule the source field follows: content scripts run in every frame and
    // report independently. "absent" is this field's empty state.
    await fake.sendFromTab(21, {
      type: "signal-state",
      source: "this-extension",
      readTracking: "active",
      value: true,
    });
    await new Promise((r) => setTimeout(r, 200));
    await fake.sendFromTab(21, {
      type: "signal-state",
      source: "none",
      readTracking: "active",
      value: "absent",
    });
    await new Promise((r) => setTimeout(r, 200));

    const state = fake.sessionStore()["tab:21"] as { propertyValue: unknown } | undefined;
    expect(state?.propertyValue).toBe(true);
  });

  it("falls back to the source-derived value when a message carries none", async () => {
    // An older content script talking to a newer worker, mid-session after an update.
    // The source-derived value can be wrong (see above), but blanking the field would be
    // worse for that one window.
    await fake.sendFromTab(22, {
      type: "signal-state",
      source: "this-extension",
      readTracking: "active",
    });
    await new Promise((r) => setTimeout(r, 200));

    const state = fake.sessionStore()["tab:22"] as { propertyValue: unknown } | undefined;
    expect(state?.propertyValue).toBe(true);
  });

  it("accepts a CORRECTED signal state after the first one", async () => {
    // The first report is guaranteed wrong: statically declared content scripts run before
    // dynamically registered ones, so the initial announce happens while the permission flag
    // is still unset. Keeping only the first would have the popup say the signal was not set
    // while the property on the page was correct.
    await fake.sendFromTab(8, { type: "signal-state", source: "none", readTracking: "active" });
    await new Promise((r) => setTimeout(r, 200));
    await fake.sendFromTab(8, {
      type: "signal-state",
      source: "this-extension",
      readTracking: "active",
    });
    await new Promise((r) => setTimeout(r, 200));

    const state = fake.sessionStore()["tab:8"] as { signalSource: string } | undefined;
    expect(state?.signalSource).toBe("this-extension");
  });

  it("does not let a subframe's 'none' downgrade a top frame's report", async () => {
    // Content scripts run in all frames and report independently.
    await fake.sendFromTab(9, {
      type: "signal-state",
      source: "this-extension",
      readTracking: "active",
    });
    await new Promise((r) => setTimeout(r, 200));
    await fake.sendFromTab(9, { type: "signal-state", source: "none", readTracking: "active" });
    await new Promise((r) => setTimeout(r, 200));

    const state = fake.sessionStore()["tab:9"] as { signalSource: string } | undefined;
    expect(state?.signalSource).toBe("this-extension");
  });

  it("accumulates read counts", async () => {
    await fake.sendFromTab(10, { type: "signal-read", count: 5 });
    await fake.sendFromTab(10, { type: "signal-read", count: 3 });
    await new Promise((r) => setTimeout(r, 200));

    const state = fake.sessionStore()["tab:10"] as { signalReads: number } | undefined;
    expect(state?.signalReads).toBe(8);
  });

  it("accumulates read attribution alongside the count", async () => {
    // Attribution rides on the same message as the count and arrives once per flush window,
    // several times per page — so it has to merge, not replace.
    await fake.sendFromTab(23, {
      type: "signal-read",
      count: 40,
      attribution: {
        sampled: 4,
        unattributed: 1,
        viaTagManager: 1,
        byScript: { "https://ads.example.com/tag.js": 2 },
      },
    });
    await fake.sendFromTab(23, {
      type: "signal-read",
      count: 10,
      attribution: {
        sampled: 2,
        unattributed: 0,
        viaTagManager: 0,
        byScript: { "https://ads.example.com/tag.js": 1, "https://other.example.net/a.js": 1 },
      },
    });
    await new Promise((r) => setTimeout(r, 200));

    const state = fake.sessionStore()["tab:23"] as
      | {
          signalReads: number;
          readsByScript: Record<string, number>;
          readAttribution: { sampled: number; unattributed: number; viaTagManager: number };
        }
      | undefined;
    // The count stays complete and exact; attribution covers only the sample.
    expect(state?.signalReads).toBe(50);
    expect(state?.readAttribution).toEqual({
      sampled: 6,
      unattributed: 1,
      viaTagManager: 1,
      viaTagManagerByContainer: {},
    });
    expect(state?.readsByScript).toEqual({
      "https://ads.example.com/tag.js": 3,
      "https://other.example.net/a.js": 1,
    });
  });

  it("merges the per-container read split across flush windows", async () => {
    const gtm = "https://www.googletagmanager.com/gtm.js?id=GTM-A";
    const gtag = "https://www.googletagmanager.com/gtag/js?id=G-1";
    await fake.sendFromTab(25, {
      type: "signal-read",
      count: 3,
      attribution: { sampled: 2, unattributed: 0, viaTagManager: 2, byContainer: { [gtm]: 2 }, byScript: {} },
    });
    await fake.sendFromTab(25, {
      type: "signal-read",
      count: 3,
      attribution: {
        sampled: 2,
        unattributed: 0,
        viaTagManager: 2,
        byContainer: { [gtm]: 1, [gtag]: 1 },
        byScript: {},
      },
    });
    await new Promise((r) => setTimeout(r, 200));

    const state = fake.sessionStore()["tab:25"] as
      | { readAttribution: { viaTagManager: number; viaTagManagerByContainer: Record<string, number> } }
      | undefined;
    // The split sums to the total it splits.
    expect(state?.readAttribution.viaTagManager).toBe(4);
    expect(state?.readAttribution.viaTagManagerByContainer).toEqual({ [gtm]: 3, [gtag]: 1 });
  });

  it("merges batched script insertions and the observer's coverage into tab state", async () => {
    const gtm = "https://www.googletagmanager.com/gtm.js?id=GTM-A";
    const loader = {
      insertedBy: [gtm],
      inlineFrames: false,
      currentScriptKey: null,
      containerUrls: [gtm],
      via: "appendChild",
      frameOrigin: "https://example.com",
      topFrame: true,
      count: 1,
      timeMs: 10,
    };
    await fake.sendFromTab(26, {
      type: "script-insertions",
      records: [
        { key: "https://v.example/a.js", url: "https://v.example/a.js?cb=1", element: "script", loader },
        { key: "https://v.example/a.js", url: "https://v.example/a.js?cb=2", element: "script", loader: { ...loader, count: 3 } },
        { key: "https://v.example/b.js", url: "https://v.example/b.js", element: "script", loader: { ...loader, via: "parser", insertedBy: [], containerUrls: [] } },
        { bogus: true },
      ],
    });
    await fake.sendFromTab(26, {
      type: "script-insertion-coverage",
      topFrame: true,
      coverage: { recorded: 2, parser: 1, duplicates: 1, inline: 0, inlineResolvedByCurrentScript: 0, nonExecuting: 0, srcUnresolved: 0, stackFailed: 0, ambiguousContainer: 0, capExceeded: 0, wrappedOver: false, selfDisabled: false },
    });
    await new Promise((r) => setTimeout(r, 200));

    const state = fake.sessionStore()["tab:26"] as
      | {
          scriptInsertionsInterned: { urls: string[]; records: unknown[] };
          scriptInsertionCoverage: { recorded: number };
          scriptInsertions?: unknown;
        }
      | undefined;
    // Persisted interned: the loader URL is stored once, and the plain list is not written.
    expect(state?.scriptInsertions).toBeUndefined();
    expect(state?.scriptInsertionsInterned.urls.filter((u) => u === gtm)).toHaveLength(1);
    expect(state?.scriptInsertionsInterned.records).toHaveLength(2);
    expect(state?.scriptInsertionCoverage.recorded).toBe(2);
  });

  it("merges request initiators apart from insertions, and keeps the top frame's coverage", async () => {
    const gtm = "https://www.googletagmanager.com/gtm.js?id=GTM-A";
    const loader = { insertedBy: [gtm], inlineFrames: false, currentScriptKey: null, containerUrls: [gtm], via: "src", frameOrigin: "https://example.com", topFrame: true, count: 1, timeMs: 10 };
    await fake.sendFromTab(27, {
      type: "request-initiations",
      records: [
        { key: "https://px.example/p.gif", url: "https://px.example/p.gif?cb=1", element: "image", loader },
        { key: "https://v.example/tag.js", url: "https://v.example/tag.js", element: "script", loader }, // not a request kind
      ],
    });
    await fake.sendFromTab(27, { type: "request-initiation-coverage", topFrame: false, coverage: { recorded: 99 } });
    await fake.sendFromTab(27, { type: "request-initiation-coverage", topFrame: true, coverage: { recorded: 1 } });
    await new Promise((r) => setTimeout(r, 200));
    const state = fake.sessionStore()["tab:27"] as
      | { requestInitiatorsInterned: { records: unknown[] }; requestInitiatorCoverage: { recorded: number }; scriptInsertionsInterned: { records: unknown[] } }
      | undefined;
    expect(state?.requestInitiatorsInterned.records).toHaveLength(1);
    expect(state?.scriptInsertionsInterned.records).toHaveLength(0);
    expect(state?.requestInitiatorCoverage.recorded).toBe(1);
  });

  it("still accepts a bare read count with no attribution", async () => {
    // The bridge omits the attribution entirely when nothing was sampled in that window,
    // which is the common case once the sampler thins out.
    await fake.sendFromTab(24, { type: "signal-read", count: 7 });
    await new Promise((r) => setTimeout(r, 200));

    const state = fake.sessionStore()["tab:24"] as
      | {
          signalReads: number;
          readsByScript: Record<string, number>;
          readAttribution: { sampled: number };
        }
      | undefined;
    expect(state?.signalReads).toBe(7);
    expect(state?.readsByScript).toEqual({});
    expect(state?.readAttribution.sampled).toBe(0);
  });

  it("marks the capture incomplete when the bridge reports a delivery gap", async () => {
    await fake.sendFromTab(11, { type: "delivery-gap", lost: 4 });
    await new Promise((r) => setTimeout(r, 200));

    const state = fake.sessionStore()["tab:11"] as { incomplete: boolean; incompleteReasons: string[] } | undefined;
    expect(state?.incomplete).toBe(true);
    expect(state?.incompleteReasons).toEqual(["delivery-gap"]);
  });

  it("counts a JS-written cookie the same way a header-set one is counted (FR-9)", async () => {
    // The retained request list lives in memory, not chrome.storage.session (see
    // state.ts's observationsByTab), so this fake cannot see `network` directly. Tallies
    // DO persist, and this is the only path in this file that can drive countCookies end
    // to end: the fake's webRequest listeners are registered but never fired, so a
    // Set-Cookie RESPONSE can't be simulated here at all — a document.cookie write,
    // arriving as a runtime message, is the one cookie-counting path this harness can
    // actually exercise through the real worker.
    await chrome.storage.session.set({
      "tab:12": {
        ...emptyTabState(12),
        topSite: "shop.example.com",
        finalUrl: "https://shop.example.com/",
        // The signal has to actually be on for this cookie to count as set under it. It is
        // read from the observed property, not hardcoded on the synthetic observation, so the
        // state has to say so.
        propertyValue: true,
      },
    });

    await fake.sendFromTab(12, {
      type: "js-cookie",
      cookie: {
        name: "test_id",
        value: "abc",
        domain: ".doubleclick.net",
        path: "/",
        expiresMs: "session",
        sameSite: "unspecified",
        secure: false,
        partitioned: false,
        writerScriptUrl: "https://stats.g.doubleclick.net/x.js",
        viaTagManager: false,
        via: "documentCookie",
        timeMs: Date.now(),
      },
    });
    await new Promise((r) => setTimeout(r, 200));

    const state = fake.sessionStore()["tab:12"] as
      | { tallies: { adCookieEvents: number; adCookieKeys: string[] } }
      | undefined;
    expect(state?.tallies.adCookieEvents).toBe(1);
    // cookieKey() joins name and domain with a NUL separator (tally.ts); built via
    // fromCharCode rather than a source escape sequence, to keep it unambiguous on disk.
    expect(state?.tallies.adCookieKeys).toContain(`test_id${String.fromCharCode(0)}.doubleclick.net`);
  });

  it("does NOT count a JS-written cookie as set under the signal when the property is off", async () => {
    // The mirror of the test above, and the reason secGpcPresent is not a constant.
    // With sending switched off the property reads false, nothing consulted a signal, and
    // counting the cookie here would put it in the ad-cookie tally and in reach of
    // cookie-set-with-signal — an accusation resting on a signal that was never sent.
    await chrome.storage.session.set({
      "tab:13": {
        ...emptyTabState(13),
        topSite: "shop.example.com",
        finalUrl: "https://shop.example.com/",
        propertyValue: false,
      },
    });

    await fake.sendFromTab(13, {
      type: "js-cookie",
      cookie: {
        name: "test_id",
        value: "abc",
        domain: ".doubleclick.net",
        path: "/",
        expiresMs: "session",
        sameSite: "unspecified",
        secure: false,
        partitioned: false,
        writerScriptUrl: "https://stats.g.doubleclick.net/x.js",
        viaTagManager: false,
        via: "documentCookie",
        timeMs: Date.now(),
      },
    });
    await new Promise((r) => setTimeout(r, 200));

    const state = fake.sessionStore()["tab:13"] as
      | { tallies: { adCookieEvents: number; adCookieKeys: string[] } }
      | undefined;
    expect(state?.tallies.adCookieEvents).toBe(0);
    expect(state?.tallies.adCookieKeys).toEqual([]);
  });

  it("ignores a content-script report with no tab to attribute it to", async () => {
    const response = await fake.sendFromPopup({
      type: "signal-state",
      source: "this-extension",
      readTracking: "active",
    });
    expect(response).toBeUndefined();
    expect(Object.keys(fake.sessionStore()).filter((k) => k.startsWith("tab:"))).toHaveLength(0);
  });
});

describe("the published-file check reaches tabs that never committed under this worker", () => {
  beforeEach(async () => {
    await loadWorker();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts the check when the popup asks for observations and the row is unresolved", async () => {
    // A tab open before the worker started never fires onCommitted, so the check that runs
    // at commit never runs and the row would stay on "checking". The popup asking is the
    // moment that matters.
    const seeded = { ...emptyTabState(31), topSite: "example.com", finalUrl: "https://example.com/" };
    await chrome.storage.session.set({
      "tab:31": seeded,
    });
    const fetchSpy = vi.fn(async (_input: string | URL | Request) =>
      new Response(JSON.stringify({ gpc: true, lastUpdate: "2026-01-01" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await fake.sendFromPopup({ type: "get-observations", tabId: 31 });
    await new Promise((r) => setTimeout(r, 200));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://example.com/.well-known/gpc.json");
    const state = fake.sessionStore()["tab:31"] as
      | { wellKnown: { present: boolean; gpc: boolean | null } | null }
      | undefined;
    expect(state?.wellKnown?.present).toBe(true);
    expect(state?.wellKnown?.gpc).toBe(true);
  });

  it("does not put one site's file on the page the tab moved on to", async () => {
    // Written to whatever the tab holds when it arrives, a slow read of a.example's file
    // (gpc: true), landing after b.example's own check, would give b.example a declared-honor
    // finding resting on another site's declaration.
    let answerA: (r: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) =>
        String(input).startsWith("https://a.example/")
          ? new Promise<Response>((resolve) => (answerA = resolve))
          : Promise.resolve(new Response("", { status: 404 })),
      ),
    );

    await fake.fireBeforeNavigate({ tabId: 33, frameId: 0, url: "https://a.example/" });
    await fake.fireCommitted({ tabId: 33, frameId: 0, url: "https://a.example/" });
    await new Promise((r) => setTimeout(r, 20));
    await fake.fireBeforeNavigate({ tabId: 33, frameId: 0, url: "https://b.example/" });
    await fake.fireCommitted({ tabId: 33, frameId: 0, url: "https://b.example/" });
    await new Promise((r) => setTimeout(r, 50));
    answerA(new Response(JSON.stringify({ gpc: true }), { status: 200, headers: { "content-type": "application/json" } }));
    await new Promise((r) => setTimeout(r, 200));

    const obs = (await fake.sendFromPopup({ type: "get-observations", tabId: 33 })) as {
      wellKnown: { url: string; present: boolean } | null;
    } | null;
    expect(obs?.wellKnown?.url).toBe("https://b.example/.well-known/gpc.json");
    expect(obs?.wellKnown?.present).toBe(false);
  });

  it("caches a read that failed for minutes, so a failing site is not fetched on every page", async () => {
    // Not cached at all, a failed read would request the file of a site answering 503 on
    // every navigation, the pattern the cache exists to prevent.
    const fetchSpy = vi.fn(async () => new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchSpy);
    const visit = async (): Promise<void> => {
      await fake.fireBeforeNavigate({ tabId: 34, frameId: 0, url: "https://down.example/" });
      await fake.fireCommitted({ tabId: 34, frameId: 0, url: "https://down.example/" });
      await new Promise((r) => setTimeout(r, 200));
    };

    await visit();
    const cached = fake.sessionStore()["wk:https://down.example"] as { reason: string; observedAtMs: number };
    expect(cached.reason).toBe("status 503");
    const obs = (await fake.sendFromPopup({ type: "get-observations", tabId: 34 })) as {
      wellKnown: { reason: string | null } | null;
    } | null;
    expect(obs?.wellKnown?.reason).toBe("status 503");

    await visit();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Past the backoff, and still far short of a day, it is read again.
    await chrome.storage.session.set({
      "wk:https://down.example": { ...cached, observedAtMs: Date.now() - 11 * 60 * 1000 },
    });
    await visit();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries a read that got no answer once the page loads, and caches the answer", async () => {
    // A read made while a heavy page loads can time out. Without the retry, the row says
    // "not found" for a site publishing `gpc: true`, and the failure is cached for every page
    // of the site.
    let answering = false;
    const fetchSpy = vi.fn(async () => {
      if (!answering) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ gpc: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const url = "https://slow.example/";

    await fake.fireBeforeNavigate({ tabId: 38, frameId: 0, url });
    await fake.fireCommitted({ tabId: 38, frameId: 0, url });
    await new Promise((r) => setTimeout(r, 200));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fake.sessionStore()["wk:https://slow.example"] as { reason: string }).reason).toMatch(/^request failed/);

    answering = true;
    await fake.fireCompleted({ tabId: 38, frameId: 0, url });
    await new Promise((r) => setTimeout(r, 200));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((fake.sessionStore()["wk:https://slow.example"] as { present: boolean }).present).toBe(true);
    const obs = (await fake.sendFromPopup({ type: "get-observations", tabId: 38 })) as {
      wellKnown: { present: boolean; gpc: boolean | null; fresh: boolean } | null;
    } | null;
    expect(obs?.wellKnown).toMatchObject({ present: true, gpc: true, fresh: true });

    // Once per reading: a second completion asks nothing more.
    await fake.fireCompleted({ tabId: 38, frameId: 0, url });
    await new Promise((r) => setTimeout(r, 100));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failure served from the cache, so a silent site is not read on every page", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const visit = async (url: string): Promise<void> => {
      await fake.fireBeforeNavigate({ tabId: 39, frameId: 0, url });
      await fake.fireCommitted({ tabId: 39, frameId: 0, url });
      await new Promise((r) => setTimeout(r, 100));
      await fake.fireCompleted({ tabId: 39, frameId: 0, url });
      await new Promise((r) => setTimeout(r, 100));
    };

    // The first page: its read, and one retry after the load.
    await visit("https://silent.example/");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Later pages of the site within the backoff: the cached failure, and no request at all.
    await visit("https://silent.example/a");
    await visit("https://silent.example/b");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const obs = (await fake.sendFromPopup({ type: "get-observations", tabId: 39 })) as {
      wellKnown: { present: boolean; reason: string | null } | null;
    } | null;
    expect(obs?.wellKnown?.present).toBe(false);
    expect(obs?.wellKnown?.reason).toMatch(/^request failed/);
  });

  it("reads the whole store for the cache's cap at most once a minute", async () => {
    // Counting the cache's entries reads the whole session store, every open tab's state
    // included, so it must not happen on every cached reading.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const reads = fake.sessionFullReadCount();

    for (const [tabId, host] of [[35, "one.example"], [36, "two.example"], [37, "three.example"]] as const) {
      await fake.fireBeforeNavigate({ tabId, frameId: 0, url: `https://${host}/` });
      await fake.fireCommitted({ tabId, frameId: 0, url: `https://${host}/` });
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(fake.sessionStore()["wk:https://three.example"]).toBeDefined();
    expect(fake.sessionFullReadCount() - reads).toBeLessThanOrEqual(1);
  });

  it("sends one request for an origin however many checks start for it at once", async () => {
    // A tab open before the worker started, navigated: its first requests each find topSite
    // still empty (the reset is queued, not applied), and each asks the tab and starts a
    // check, as does the commit. Unshared, every one of them would fetch the file.
    let answer: (r: Response) => void = () => undefined;
    const fetchSpy = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    vi.stubGlobal("fetch", fetchSpy);
    fake.setTabUrl(38, "https://slow.example/");

    await fake.fireBeforeNavigate({ tabId: 38, frameId: 0, url: "https://slow.example/" });
    await Promise.all(
      ["r1", "r2", "r3", "r4"].map((requestId) =>
        fake.fireSendHeaders({ tabId: 38, requestId, url: `https://slow.example/${requestId}`, type: "script", requestHeaders: [] }),
      ),
    );
    await fake.fireCommitted({ tabId: 38, frameId: 0, url: "https://slow.example/" });
    await new Promise((r) => setTimeout(r, 200));

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Every check that shared the request gets its answer, and the answer is cached.
    answer(new Response(JSON.stringify({ gpc: true }), { status: 200, headers: { "content-type": "application/json" } }));
    await new Promise((r) => setTimeout(r, 200));
    expect(fake.sessionStore()["wk:https://slow.example"]).toBeDefined();
    const obs = (await fake.sendFromPopup({ type: "get-observations", tabId: 38 })) as {
      wellKnown: { present: boolean; gpc: boolean | null } | null;
    } | null;
    expect(obs?.wellKnown?.gpc).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries at once for a tab whose load this worker never saw, when the tab says it has loaded", async () => {
    // A tab open before the worker started: its first request starts the check, no
    // onCompleted ever comes for a page that had loaded already, and the popup skips a row
    // that holds a reading. Without this, the retry a no-answer read is owed is never paid.
    let answering = false;
    const fetchSpy = vi.fn(async () => {
      if (!answering) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ gpc: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchSpy);
    fake.setTabUrl(50, "https://open.example/");

    await fake.fireSendHeaders({ tabId: 50, requestId: "r1", url: "https://open.example/r1", type: "script", requestHeaders: [] });
    await new Promise((r) => setTimeout(r, 200));
    // The retry ran as soon as the first read got no answer: the tab reported its load
    // complete. It got no answer either, and the first failure stays in the row.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const obs = (await fake.sendFromPopup({ type: "get-observations", tabId: 50 })) as { wellKnown: { reason?: string } | null } | null;
    expect(obs?.wellKnown?.reason).toMatch(/^request failed/);

    // Once: the retry's own failure earns nothing further, from a popup refresh either.
    answering = true;
    await fake.sendFromPopup({ type: "get-observations", tabId: 50 });
    await new Promise((r) => setTimeout(r, 200));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("shares one retry between tabs that shared the failed read", async () => {
    let answering = false;
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve, reject) =>
          setTimeout(() => (answering ? resolve(new Response(JSON.stringify({ gpc: true }), { status: 200, headers: { "content-type": "application/json" } })) : reject(new TypeError("Failed to fetch"))), 50),
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const url = "https://shared.example/";

    await fake.fireBeforeNavigate({ tabId: 51, frameId: 0, url });
    await fake.fireBeforeNavigate({ tabId: 52, frameId: 0, url });
    await fake.fireCommitted({ tabId: 51, frameId: 0, url });
    await fake.fireCommitted({ tabId: 52, frameId: 0, url });
    await new Promise((r) => setTimeout(r, 300));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    answering = true;
    await fake.fireCompleted({ tabId: 51, frameId: 0, url });
    await fake.fireCompleted({ tabId: 52, frameId: 0, url });
    await new Promise((r) => setTimeout(r, 400));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const tabId of [51, 52]) {
      const obs = (await fake.sendFromPopup({ type: "get-observations", tabId })) as { wellKnown: { gpc: boolean | null } | null } | null;
      expect(obs?.wellKnown?.gpc, String(tabId)).toBe(true);
    }
  });

  it("does not let a slow read for the page before take the next page's retry", async () => {
    // The tab leaves a.example while its read is still waiting; b.example's own read is
    // refused at once. The old read lands last and must not replace what b.example is owed.
    let failOld: () => void = () => undefined;
    let answering = false;
    const fetchSpy = vi.fn((input: string | URL | Request) => {
      if (String(input).startsWith("https://a.example/")) return new Promise<Response>((_, reject) => (failOld = () => reject(new TypeError("timed out"))));
      if (!answering) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve(new Response(JSON.stringify({ gpc: true }), { status: 200, headers: { "content-type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchSpy);

    await fake.fireBeforeNavigate({ tabId: 53, frameId: 0, url: "https://a.example/" });
    await fake.fireCommitted({ tabId: 53, frameId: 0, url: "https://a.example/" });
    await new Promise((r) => setTimeout(r, 100));
    await fake.fireBeforeNavigate({ tabId: 53, frameId: 0, url: "https://b.example/" });
    await fake.fireCommitted({ tabId: 53, frameId: 0, url: "https://b.example/" });
    await new Promise((r) => setTimeout(r, 200));
    failOld();
    await new Promise((r) => setTimeout(r, 200));

    answering = true;
    await fake.fireCompleted({ tabId: 53, frameId: 0, url: "https://b.example/" });
    await new Promise((r) => setTimeout(r, 200));
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://a.example/.well-known/gpc.json",
      "https://b.example/.well-known/gpc.json",
      "https://b.example/.well-known/gpc.json",
    ]);
    const obs = (await fake.sendFromPopup({ type: "get-observations", tabId: 53 })) as { wellKnown: { gpc: boolean | null } | null } | null;
    expect(obs?.wellKnown?.gpc).toBe(true);
  });

  it("replaces a row that got no answer with the answer another tab cached since, without a request", async () => {
    // Tab 33 read the cached failure (no retry is owed for a reading served from the cache)
    // while another tab's retry then cached the file. The popup opening on tab 33 is the
    // moment that matters: it must show the file, not "could not be checked" for the rest of
    // the page.
    const now = Date.now();
    const failed = { url: "https://example.com/.well-known/gpc.json", present: false, gpc: null, lastUpdate: null, observedAtMs: now, fresh: true, reason: "request failed: TypeError" };
    const answered = { ...failed, present: true, gpc: true, lastUpdate: "2026-01-01", reason: null };
    await chrome.storage.session.set({
      "tab:33": { ...emptyTabState(33), topSite: "example.com", finalUrl: "https://example.com/", wellKnown: failed },
      "wk:https://example.com": answered,
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await fake.sendFromPopup({ type: "get-observations", tabId: 33 });
    await new Promise((r) => setTimeout(r, 100));
    const obs = (await fake.sendFromPopup({ type: "get-observations", tabId: 33 })) as { wellKnown: { gpc: boolean | null } | null } | null;

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(obs?.wellKnown?.gpc).toBe(true);
  });

  it("does not start a second check for a tab whose row is already resolved", async () => {
    const resolved = {
      ...emptyTabState(32),
      topSite: "example.com",
      finalUrl: "https://example.com/",
      wellKnown: { url: "u", present: false, gpc: null, lastUpdate: null, observedAtMs: 1, fresh: true, reason: null },
    };
    await chrome.storage.session.set({
      "tab:32": resolved,
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await fake.sendFromPopup({ type: "get-observations", tabId: 32 });
    await new Promise((r) => setTimeout(r, 100));

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the tab is asked for its site once", () => {
  beforeEach(async () => {
    await loadWorker();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const request = (tabId: number, requestId: string, url: string) =>
    fake.fireSendHeaders({ tabId, requestId, url, type: "script", requestHeaders: [] });

  it("looks a tab up once however many of its requests arrive together", async () => {
    // A tab open before the worker started has no site in state, and the lookup's write is
    // queued: every request until it applies finds the site empty and would ask the tab again.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    fake.setTabUrl(40, "https://open.example/");

    await Promise.all(["r1", "r2", "r3", "r4"].map((id) => request(40, id, `https://open.example/${id}`)));
    await request(40, "r5", "https://open.example/r5");

    expect(fake.tabGetCount()).toBe(1);
    const obs = (await fake.sendFromPopup({ type: "get-observations", tabId: 40 })) as {
      context: { topSite: string };
    } | null;
    expect(obs?.context.topSite).toBe("open.example");
    expect(fake.tabGetCount()).toBe(1);
  });

  it("does not look up a tab whose navigation this worker saw", async () => {
    // The navigation's reset already carries the site, but is queued; asking the tab before
    // the commit reads the page being left, and would start a check of that page's file.
    const fetchSpy = vi.fn(async (_input: string | URL | Request) => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
    fake.setTabUrl(41, "https://old.example/");

    await fake.fireBeforeNavigate({ tabId: 41, frameId: 0, url: "https://new.example/" });
    await Promise.all(["r1", "r2", "r3"].map((id) => request(41, id, `https://new.example/${id}`)));
    await fake.fireCommitted({ tabId: 41, frameId: 0, url: "https://new.example/" });
    await new Promise((r) => setTimeout(r, 200));

    expect(fake.tabGetCount()).toBe(0);
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual(["https://new.example/.well-known/gpc.json"]);
  });

  it("asks the tab again after a navigation to a non-http address that never committed", async () => {
    // The state is cleared for such a navigation. When it does not commit, the page stays on
    // screen and keeps sending: its site has to come from the tab again.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    fake.setTabUrl(42, "https://stays.example/");

    await fake.fireBeforeNavigate({ tabId: 42, frameId: 0, url: "chrome://settings/" });
    await request(42, "r1", "https://stays.example/r1");
    await new Promise((r) => setTimeout(r, 200));

    expect(fake.tabGetCount()).toBe(1);
    const obs = (await fake.sendFromPopup({ type: "get-observations", tabId: 42 })) as { context: { topSite: string } } | null;
    expect(obs?.context.topSite).toBe("stays.example");
  });
});

describe("an update from v0.1.4 keeps the user's choices", () => {
  // v0.1.4 left two things behind that Chrome carries across the update: its options in
  // SYNC storage, and its Sec-GPC rule under dynamic rule id 290. See migrate.ts.
  const V014_RULE_ID = 290;
  const update = { reason: "update", previousVersion: "0.1.4" } as const;
  const settle = () => new Promise((r) => setTimeout(r, 10));

  beforeEach(async () => {
    await loadWorker();
  });

  it("does not turn sending back on for someone who turned it off", async () => {
    // Settings live in local `settings`, and v0.1.4 kept its own in sync `options`. With the
    // new key absent, the defaults written in its place would have sending ON.
    fake.seedSync({ options: { gpc_setting: false, badge_setting: true } });
    fake.seedDynamicRules([]); // v0.1.4 had removed its own rule when sending went off

    await fake.fireInstalled(update);
    await settle();

    const settings = fake.localStore()["settings"] as { sendSignal: boolean; showBadge: boolean };
    expect(settings.sendSignal).toBe(false);
    expect(settings.showBadge).toBe(true);
    expect(fake.dynamicRules()).toHaveLength(0);
    expect(settingsScripts()).toEqual(["main-world-insertion.js", "main-world-seal.js"]);
  });

  it("carries the badge choice over, and still shows the first-run disclosure", async () => {
    fake.seedSync({ options: { gpc_setting: true, badge_setting: false } });

    await fake.fireInstalled(update);
    await settle();

    const settings = fake.localStore()["settings"] as Record<string, boolean>;
    expect(settings["sendSignal"]).toBe(true);
    expect(settings["showBadge"]).toBe(false);
    // Passive observation is new in this version; nobody from v0.1.4 has been told about it.
    expect(settings["firstRunComplete"]).toBe(false);
    // The first-run screen shows these users the state of their signal.
    expect(settings["returningUser"]).toBe(true);
  });

  it("replaces v0.1.4's header rule with ours when sending stays on", async () => {
    fake.seedSync({ options: { gpc_setting: true, badge_setting: true } });
    fake.seedDynamicRules([{ id: V014_RULE_ID }]);

    await fake.fireInstalled(update);
    await settle();

    expect(fake.dynamicRules().map((r) => r.id)).toEqual([1]);
  });

  it("leaves no rule sending the header once sending is turned off after the update", async () => {
    // The off switch removes rule 1 and only rule 1, so v0.1.4's rule 290, left in place,
    // would keep sending Sec-GPC with the toggle off and nothing in the popup to say so.
    fake.seedSync({ options: { gpc_setting: true, badge_setting: true } });
    fake.seedDynamicRules([{ id: V014_RULE_ID }]);
    await fake.fireInstalled(update);
    await settle();

    const current = fake.localStore()["settings"] as Record<string, boolean>;
    await chrome.storage.local.set({ settings: { ...current, sendSignal: false } });
    await settle();

    expect(fake.dynamicRules()).toHaveLength(0);
  });

  it("never overwrites settings made in this version", async () => {
    // A later update (1.0.0 to 1.0.1) fires onInstalled again with the sync key still there.
    fake.seedSync({ options: { gpc_setting: true, badge_setting: true } });
    await chrome.storage.local.set({
      settings: { sendSignal: false, showBadge: false, firstRunComplete: true },
    });

    await fake.fireInstalled({ reason: "update", previousVersion: "1.0.0" });
    await settle();

    const settings = fake.localStore()["settings"] as Record<string, boolean>;
    expect(settings["sendSignal"]).toBe(false);
    expect(settings["showBadge"]).toBe(false);
    expect(settings["firstRunComplete"]).toBe(true);
  });

  it("leaves the sync key alone, for a device still on v0.1.4", async () => {
    fake.seedSync({ options: { gpc_setting: false, badge_setting: true } });

    await fake.fireInstalled(update);
    await settle();

    expect(fake.syncStore()["options"]).toEqual({ gpc_setting: false, badge_setting: true });
  });

  it("writes plain defaults on a fresh install, with nothing to carry over", async () => {
    await fake.fireInstalled({ reason: "install" });
    await settle();

    const settings = fake.localStore()["settings"] as Record<string, boolean>;
    expect(settings["sendSignal"]).toBe(true);
    expect(settings["showBadge"]).toBe(true);
    expect(fake.dynamicRules().map((r) => r.id)).toEqual([1]);
  });

  it("treats a malformed options value as absent rather than as a choice", async () => {
    fake.seedSync({ options: "yes" });

    await fake.fireInstalled(update);
    await settle();

    const settings = fake.localStore()["settings"] as Record<string, boolean>;
    expect(settings["sendSignal"]).toBe(true);
  });
});

describe("a tab that was open before this version says so", () => {
  // Session storage is cleared by an update and the new content scripts are not injected
  // into a document that already exists, so such a tab has no state until something asks.
  beforeEach(async () => {
    await loadWorker();
  });

  type Ctx = { context: { loadObserved?: boolean; topSite: string } };

  it("reports the load as not observed when the worker never saw the navigation", async () => {
    (chrome.tabs as unknown as { get: () => Promise<{ url: string }> }).get = async () => ({
      url: "https://www.example.com/article",
    });

    const got = (await fake.sendFromPopup({ type: "get-observations", tabId: 7 })) as Ctx;

    expect(got.context.loadObserved).toBe(false);
    // In the SAME answer, with no request from the tab to prompt it. An empty site here
    // renders as "not a web page", which is a different and wrong claim.
    expect(got.context.topSite).toBe("www.example.com");
  });

  it("leaves the site empty for a page that really is not a web page", async () => {
    (chrome.tabs as unknown as { get: () => Promise<{ url: string }> }).get = async () => ({
      url: "chrome://extensions/",
    });

    const got = (await fake.sendFromPopup({ type: "get-observations", tabId: 8 })) as Ctx;

    expect(got.context.topSite).toBe("");
  });

  it("keeps saying so after late reports arrive from that tab", async () => {
    // A page left open keeps talking: requests reach webRequest and an orphaned or late
    // script can still report. None of that is a load we watched.
    await fake.sendFromTab(7, { type: "signal-reads", count: 3 });

    const got = (await fake.sendFromPopup({ type: "get-observations", tabId: 7 })) as Ctx;

    expect(got.context.loadObserved).toBe(false);
  });

  it("gives one scan id per capture, and a new one on navigation", async () => {
    type Scan = { context: { scanId?: string } };
    const ask = async (): Promise<string | undefined> =>
      ((await fake.sendFromPopup({ type: "get-observations", tabId: 7 })) as Scan).context.scanId;

    await fake.fireBeforeNavigate({ tabId: 7, frameId: 0, url: "https://www.example.com/a" });
    const first = await ask();
    // Two exports of one capture have to name the same scan.
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await ask()).toBe(first);

    await fake.fireBeforeNavigate({ tabId: 7, frameId: 0, url: "https://www.example.com/b" });
    expect(await ask()).not.toBe(first);
  });

  it("reports the load as observed once the tab navigates under this worker", async () => {
    await fake.fireBeforeNavigate({ tabId: 7, frameId: 0, url: "https://www.example.com/article" });

    const got = (await fake.sendFromPopup({ type: "get-observations", tabId: 7 })) as Ctx;

    expect(got.context.loadObserved).toBe(true);
    expect(got.context.topSite).toBe("www.example.com");
  });
});

describe("session storage stays within budget, and says so when it cannot", () => {
  beforeEach(async () => {
    await loadWorker();
  });

  const uspCall = (timeMs: number) => ({
    type: "consent-call",
    call: {
      api: "__uspapi",
      command: "getUSPData",
      callerScriptUrl: "https://www.news-i.example/static/desktop.js",
      viaTagManager: false,
      timeMs,
    },
  });
  const settle = () => new Promise((r) => setTimeout(r, 200));
  type Stored = { consentApiCalls: { count?: number }[]; incomplete: boolean } | undefined;

  it("stores a polling page's consent calls as one merged record", async () => {
    // news-i.example polled __uspapi 20,096 times and filled session storage for every tab.
    for (let i = 0; i < 500; i++) await fake.sendFromTab(7, uspCall(1000 + i));
    await settle();
    const state = fake.sessionStore()["tab:7"] as Stored;
    expect(state?.consentApiCalls).toHaveLength(1);
    expect(state?.consentApiCalls[0]?.count).toBe(500);
  });

  it("marks the capture incomplete when a write does not land", async () => {
    // Retrying the same write with `incomplete` set, into the store that just refused it,
    // would leave the popup rendering frozen numbers as current.
    fake.setOpenTabs([7]);
    await fake.sendFromTab(7, uspCall(1000));
    await settle();
    fake.setSessionQuota(1);
    await fake.sendFromTab(7, { type: "signal-read", count: 5 });
    await settle();

    const obs = (await fake.sendFromPopup({ type: "get-observations", tabId: 7 })) as {
      context: { incomplete: boolean; incompleteReasons: string[] };
    } | null;
    expect(obs?.context.incomplete).toBe(true);
    expect(obs?.context.incompleteReasons).toEqual(["write-failed"]);
  });

  it("names a full consent-call list as the reason", async () => {
    for (let i = 0; i <= 200; i++) {
      await fake.sendFromTab(7, { ...uspCall(1000), call: { ...uspCall(1000).call, callerScriptUrl: `https://cdn${i}.example/s.js` } });
    }
    await settle();
    const state = fake.sessionStore()["tab:7"] as { incompleteReasons: string[] } | undefined;
    expect(state?.incompleteReasons).toEqual(["consent-calls-capped"]);
  });

  it("carries the flag into the store once a later write lands", async () => {
    fake.setOpenTabs([7]);
    await fake.sendFromTab(7, uspCall(1000));
    await settle();
    fake.setSessionQuota(1);
    await fake.sendFromTab(7, { type: "signal-read", count: 5 });
    await settle();
    fake.setSessionQuota(null);
    await fake.sendFromTab(7, { type: "signal-read", count: 1 });
    await settle();
    expect((fake.sessionStore()["tab:7"] as Stored)?.incomplete).toBe(true);
  });

  it("clears the published-file cache when a closed tab left only its marker", async () => {
    // A closed tab's marker is a few bytes. Counted as space freed, its removal would skip
    // the cache, which is what makes room, and the write would fail again.
    fake.setOpenTabs([7]);
    fake.seedSession({ "dirty:99": "a-worker-that-died", "wk:https://gone.example": { bulk: "x".repeat(20_000) } });
    fake.setSessionQuota(12_000);
    await fake.sendFromTab(7, uspCall(1000));
    await settle();

    const store = fake.sessionStore();
    expect(store["dirty:99"]).toBeUndefined();
    expect(store["wk:https://gone.example"]).toBeUndefined();
    expect((store["tab:7"] as Stored)?.incomplete).toBe(false);
  });

  it("drops another open tab's kept cookie records before the cache, and keeps its state (1.27.0)", async () => {
    fake.setOpenTabs([7, 99]);
    const PX = "https://securepubads.g.doubleclick.net/px";
    await fake.fireBeforeNavigate({ tabId: 99, frameId: 0, url: "https://open.example/" });
    await fake.fireSendHeaders({ tabId: 99, requestId: "o1", url: PX, type: "image", requestHeaders: [] });
    await fake.fireHeadersReceived({ tabId: 99, requestId: "o1", url: PX, statusCode: 200, responseHeaders: [{ name: "Set-Cookie", value: "IDE=1; Domain=.doubleclick.net; Path=/" }] });
    await fake.sendFromTab(7, uspCall(1000));
    fake.seedSession({ "wk:https://kept.example": { small: true } });
    await new Promise((r) => setTimeout(r, 1_300));
    const before = fake.sessionStore();
    expect(typeof before["cookies:99:0"]).toBe("string");
    fake.setSessionQuota(fake.sessionBytes() - Math.floor((before["cookies:99:0"] as string).length / 2));
    await fake.sendFromTab(7, { type: "signal-read", count: 5 });
    await settle();

    const store = fake.sessionStore();
    expect(store["cookies:99:0"]).toBeUndefined();
    expect(store["tab:99"]).toBeDefined();
    expect(store["wk:https://kept.example"]).toBeDefined();
    expect((store["tab:7"] as Stored)?.incomplete).toBe(false);
    // The other tab lists none, says some were not kept, and does not write them back.
    fake.setSessionQuota(null);
    const other = (await fake.sendFromPopup({ type: "get-observations", tabId: 99 })) as { keptCookieResponses: unknown[]; keptCookieResponsesIncomplete?: true } | null;
    expect(other?.keptCookieResponses).toEqual([]);
    expect(other?.keptCookieResponsesIncomplete).toBe(true);
  }, 10_000);

  const keptOn99 = async () => {
    const PX = "https://securepubads.g.doubleclick.net/px";
    await fake.fireBeforeNavigate({ tabId: 99, frameId: 0, url: "https://open.example/" });
    await fake.fireSendHeaders({ tabId: 99, requestId: "o1", url: PX, type: "image", requestHeaders: [] });
    await fake.fireHeadersReceived({ tabId: 99, requestId: "o1", url: PX, statusCode: 200, responseHeaders: [{ name: "Set-Cookie", value: "IDE=1; Domain=.doubleclick.net; Path=/" }] });
  };

  it("frees a step at a time until the write lands, past a step that freed too little (1.27.0)", async () => {
    // A closed tab's few bytes go first. Stopping after one retry would lose the write while
    // another tab's kept records still hold the room it needs.
    fake.setOpenTabs([7, 99]);
    await keptOn99();
    await fake.sendFromTab(7, uspCall(1000));
    fake.seedSession({ "tab:55": { small: true } });
    await new Promise((r) => setTimeout(r, 1_300));
    const before = fake.sessionStore();
    fake.setSessionQuota(JSON.stringify(before).length - Math.floor((before["cookies:99:0"] as string).length / 2));
    const reads = fake.sessionFullReadCount();
    await fake.sendFromTab(7, { type: "signal-read", count: 5 });
    await settle();
    // Two steps, one read of the store: each read carries every value in it.
    expect(fake.sessionFullReadCount() - reads).toBe(1);

    const store = fake.sessionStore();
    expect(store["tab:55"]).toBeUndefined();
    expect(store["cookies:99:0"]).toBeUndefined();
    expect((store["tab:7"] as { signalReads: number }).signalReads).toBe(5);
    const obs = (await fake.sendFromPopup({ type: "get-observations", tabId: 7 })) as { context: { incompleteReasons?: string[] } };
    expect(obs.context.incompleteReasons ?? []).not.toContain("write-failed");
  }, 10_000);

  it("frees nothing for a write that failed for a reason other than room", async () => {
    // Running every step for any failure would let a store that is briefly unavailable take
    // every open tab's kept records with it, and each tab would stop keeping.
    fake.setOpenTabs([7, 99]);
    await keptOn99();
    await fake.sendFromTab(7, uspCall(1000));
    fake.seedSession({ "wk:https://kept.example": { small: true } });
    await new Promise((r) => setTimeout(r, 1_300));
    fake.failSessionWrites("Extension context invalidated.");
    await fake.sendFromTab(7, { type: "signal-read", count: 5 });
    await settle();
    fake.failSessionWrites(null);

    const store = fake.sessionStore();
    expect(typeof store["cookies:99:0"]).toBe("string");
    expect(store["wk:https://kept.example"]).toBeDefined();
    expect((JSON.parse(store["cookies:99:0"] as string) as { id: string }[]).map((k) => k.id)).toEqual(["o1"]);
    const other = (await fake.sendFromPopup({ type: "get-observations", tabId: 99 })) as { keptCookieResponsesIncomplete?: true };
    expect(other.keptCookieResponsesIncomplete).toBeUndefined();
    // The write itself is still reported as failed.
    const own = (await fake.sendFromPopup({ type: "get-observations", tabId: 7 })) as { context: { incompleteReasons?: string[] } };
    expect(own.context.incompleteReasons ?? []).toContain("write-failed");
  }, 10_000);

  it("leaves open tabs' kept records alone near the quota while writes still land (1.27.0)", async () => {
    // Above 80% because of the tab states alone, a check that dropped one more kind each time
    // would go down to the records of the tab it was checking for.
    fake.setOpenTabs([98, 99]);
    fake.seedSession({ "tab:98": { topSite: "big.example", bulk: "x".repeat(8_500_000) } });
    await keptOn99();
    await new Promise((r) => setTimeout(r, 1_300));

    expect((JSON.parse(fake.sessionStore()["cookies:99:0"] as string) as { id: string }[]).map((k) => k.id)).toEqual(["o1"]);
    const obs = (await fake.sendFromPopup({ type: "get-observations", tabId: 99 })) as { keptCookieResponsesIncomplete?: true };
    expect(obs.keptCookieResponsesIncomplete).toBeUndefined();
  }, 10_000);

  it("frees a closed tab's state when the store is full, and keeps the open tab's", async () => {
    fake.setOpenTabs([7]);
    const bulk = "x".repeat(20_000);
    fake.seedSession({ "tab:99": { topSite: "gone.example", bulk } });
    fake.setSessionQuota(12_000);
    await fake.sendFromTab(7, uspCall(1000));
    await settle();

    const store = fake.sessionStore();
    expect(store["tab:99"]).toBeUndefined();
    expect((store["tab:7"] as Stored)?.incomplete).toBe(false);
  });

  it("does not write state back for a tab that has closed", async () => {
    // An unload beacon arrives after tabs.onRemoved; its write would recreate the tab's
    // state, about 2 KB per closed tab (measured 2026-09-22).
    await fake.sendFromTab(8, uspCall(1000));
    await settle();
    await fake.fireTabRemoved(8);
    await fake.sendFromTab(8, { type: "signal-read", count: 1 });
    await settle();
    expect(fake.sessionStore()["tab:8"]).toBeUndefined();
  });

  it("does not let a write already in flight put a closed tab's state back", async () => {
    // Seen live 2026-09-22 with only the guard above: 6 of 10 closed tabs kept their full
    // state (70 to 127 KB each), because a flush that had already read the state finished
    // its write after the key was removed.
    fake.setSessionWriteDelay(100);
    await fake.sendFromTab(8, uspCall(1000));
    await new Promise((r) => setTimeout(r, 150)); // flush started, its write still pending
    await fake.fireTabRemoved(8);
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.sessionStore()["tab:8"]).toBeUndefined();
  });
});

describe("the popup is answered while storage is slow", () => {
  beforeEach(async () => {
    await loadWorker();
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  type Obs = { signal: { readCount: number | null } } | undefined;

  it("answers get-observations without waiting for a write in flight", async () => {
    // Ten news sites loading at once (2026-09-23): every get-observations took over 9
    // seconds, because the popup waited for each tab's writes and the writes waited on one
    // another. The fake gives up on an answer after 50 ms, as a popup left waiting would.
    fake.setSessionWriteDelay(2_000);
    await fake.sendFromTab(7, { type: "signal-read", count: 3 });
    await sleep(150); // the first write has started and will not land for two seconds
    await fake.sendFromTab(7, { type: "signal-read", count: 4 });

    const obs = (await fake.sendFromPopup({ type: "get-observations", tabId: 7 })) as Obs;
    expect(obs?.signal.readCount).toBe(7);
  });

  it("writes a busy tab's changes together instead of queueing one write per flush", async () => {
    // Chained every 120 ms whether or not the last one has finished, flushes pile up: on
    // news-i.co.uk 1,485 were waiting after 30 seconds. Changes made during a write go
    // out in the next one, so the store is current soon after the page goes quiet.
    fake.setSessionWriteDelay(400);
    for (let i = 0; i < 12; i++) {
      await fake.sendFromTab(7, { type: "signal-read", count: 1 });
      await sleep(100);
    }
    await sleep(1_000);

    expect((fake.sessionStore()["tab:7"] as { signalReads: number } | undefined)?.signalReads).toBe(12);
    expect(fake.sessionSetCount()).toBeLessThanOrEqual(5);
  });
});

describe("the page being left is not counted on the next one", () => {
  beforeEach(async () => {
    await loadWorker();
  });

  // news-j.example to news-k.example, logged 2026-09-23: Parse.ly's writes from the old page arrived
  // after the new commit, from the old top document, with documentLifecycle
  // "pending_deletion" and a new frameId; they were counted as news-k.example's cookies.
  const settle = () => new Promise((r) => setTimeout(r, 200));
  const parsely = (name: string, domain: string) => ({
    type: "js-cookie",
    cookie: {
      name, value: "v", domain, path: "/", expiresMs: "session", sameSite: "unspecified", secure: false,
      partitioned: false, viaTagManager: false, via: "documentCookie", timeMs: Date.now(),
      writerScriptUrl: "https://cdn.parsely.com/keys/x/p.js", frameHost: domain.replace(/^\./, "www."),
    },
  });
  // Signed or not: no signal-state is sent here, so these land in the unsigned keys.
  const keysOf = (tab: number): string[] => {
    const t = (fake.sessionStore()[`tab:${tab}`] as { tallies: { adCookieKeys: string[]; adCookieKeysUnsigned?: string[] } } | undefined)?.tallies;
    return [...(t?.adCookieKeys ?? []), ...(t?.adCookieKeysUnsigned ?? [])];
  };

  async function leaveNewsJ(tab: number): Promise<void> {
    await fake.fireBeforeNavigate({ tabId: tab, frameId: 0, url: "https://www.news-j.example/" });
    await fake.fireCommitted({ tabId: tab, frameId: 0, url: "https://www.news-j.example/", documentId: "NEWS_J" });
    await fake.fireCommitted({ tabId: tab, frameId: 7, url: "https://ads.example/f", documentId: "NEWS_J-FRAME", parentDocumentId: "NEWS_J" });
    await fake.sendFromTab(tab, parsely("_parsely_visitor", ".news-j.example"), { frameId: 0, documentId: "NEWS_J", documentLifecycle: "active" });
    await settle();
    expect(keysOf(tab)).toEqual(["_parsely_visitor\u0000.news-j.example"]);
    await fake.fireBeforeNavigate({ tabId: tab, frameId: 0, url: "https://www.news-k.example/" });
  }

  it("drops what the old page writes before the new one commits", async () => {
    await leaveNewsJ(50);
    await fake.sendFromTab(50, parsely("_parsely_session", ".news-j.example"), { frameId: 0, documentId: "NEWS_J", documentLifecycle: "active" });
    await fake.sendFromTab(50, parsely("_parsely_session", ".news-j.example"), { frameId: 7, documentId: "NEWS_J-FRAME", documentLifecycle: "active" });
    await settle();
    expect(keysOf(50)).toEqual([]);
  });

  it("drops what it writes while it unloads, after the commit", async () => {
    await leaveNewsJ(51);
    await fake.fireCommitted({ tabId: 51, frameId: 0, url: "https://www.news-k.example/", documentId: "news-k" });
    await fake.sendFromTab(51, parsely("_parsely_session", ".news-j.example"), { frameId: 39, documentId: "NEWS_J", documentLifecycle: "pending_deletion" });
    await settle();
    expect(keysOf(51)).toEqual([]);
  });

  it("keeps what the new page reports before its commit reaches the worker", async () => {
    await leaveNewsJ(52);
    await fake.sendFromTab(52, parsely("_parsely_session", ".news-k.example"), { frameId: 0, documentId: "news-k", documentLifecycle: "active" });
    await fake.fireCommitted({ tabId: 52, frameId: 0, url: "https://www.news-k.example/", documentId: "news-k" });
    await fake.sendFromTab(52, parsely("_parsely_visitor", ".news-k.example"), { frameId: 0, documentId: "news-k", documentLifecycle: "active" });
    await settle();
    expect(keysOf(52).sort()).toEqual(["_parsely_session\u0000.news-k.example", "_parsely_visitor\u0000.news-k.example"]);
  });

  it("still drops the old page's writes when the navigation before was abandoned", async () => {
    // A is up; a navigation to B starts and never commits; a navigation to C starts. A is
    // still the page being left, and its unload writes must not land on C. The reset for C
    // saw no committed page and would have retired nothing.
    await leaveNewsJ(54);
    await fake.fireBeforeNavigate({ tabId: 54, frameId: 0, url: "https://www.example.com/" });
    await fake.fireCommitted({ tabId: 54, frameId: 0, url: "https://www.example.com/", documentId: "C" });
    await fake.sendFromTab(54, parsely("_parsely_session", ".news-j.example"), { frameId: 39, documentId: "NEWS_J", documentLifecycle: "pending_deletion" });
    await fake.sendFromTab(54, parsely("_parsely_session", ".example.com"), { frameId: 0, documentId: "C", documentLifecycle: "active" });
    await settle();
    expect(keysOf(54)).toEqual(["_parsely_session\u0000.example.com"]);
  });

  it("keeps a message with no document fields, as from a tab open before install", async () => {
    await fake.fireBeforeNavigate({ tabId: 53, frameId: 0, url: "https://www.news-k.example/" });
    await fake.sendFromTab(53, parsely("_parsely_session", ".news-k.example"));
    await settle();
    expect(keysOf(53)).toEqual(["_parsely_session\u0000.news-k.example"]);
  });
});

describe("cookie writes that set nothing are not counted", () => {
  beforeEach(async () => {
    await loadWorker();
  });

  const settle = () => new Promise((r) => setTimeout(r, 200));
  const jsCookie = (over: Record<string, unknown>) => ({
    type: "js-cookie",
    cookie: {
      value: "v", path: "/", expiresMs: "session", sameSite: "unspecified", secure: false,
      partitioned: false, viaTagManager: false, via: "documentCookie", timeMs: Date.now(),
      frameHost: "www.news-g.example", ...over,
    },
  });
  type Stored = {
    tallies: {
      adCookieKeys: string[];
      adCookieKeysUnsigned: string[];
      probeCookies?: Record<string, string[]>;
      refusedCookieWrites?: Record<string, string[]>;
    };
    rejectedCookieWrites: number;
    cookieLedger: { probes: string[] };
  } | undefined;
  const allKeys = (s: Stored) => [...(s?.tallies.adCookieKeys ?? []), ...(s?.tallies.adCookieKeysUnsigned ?? [])];

  it("does not count a write to a public-suffix domain, and counts the one that follows", async () => {
    // media.net on news-g.example, 2026-09-22: `domain=.com`, which Chrome refuses, then
    // `domain=.news-g.example`. Only the second sets a cookie.
    await fake.fireBeforeNavigate({ tabId: 30, frameId: 0, url: "https://www.news-g.example/" });
    const writer = "https://warp.media.net/js/tags/clientag.js";
    await fake.sendFromTab(30, jsCookie({ name: "cto_bidid", domain: ".com", writerScriptUrl: writer }));
    await fake.sendFromTab(30, jsCookie({ name: "cto_bidid", domain: ".news-g.example", writerScriptUrl: writer }));
    await settle();

    const state = fake.sessionStore()["tab:30"] as Stored;
    expect(state?.rejectedCookieWrites).toBe(1);
    expect(allKeys(state).some((k) => k.endsWith("\u0000.com"))).toBe(false);
    // Kept against the writing script's vendor, for its panel (1.18.0).
    expect(Object.values(state?.tallies.refusedCookieWrites ?? {}).flat()).toEqual(["cto_bidid (.com)"]);
  });

  it("takes a cookie set and removed moments later back out of the count", async () => {
    // cto_tld_test and its kind: written to test where writing works, then deleted.
    await fake.fireBeforeNavigate({ tabId: 31, frameId: 0, url: "https://www.news-g.example/" });
    const writer = "https://static.criteo.net/js/ld/publishertag.js";
    await fake.sendFromTab(31, jsCookie({ name: "cto_tld_test", domain: ".news-g.example", writerScriptUrl: writer }));
    await settle();
    const before = fake.sessionStore()["tab:31"] as Stored;
    expect(allKeys(before)).toContain("cto_tld_test\u0000.news-g.example");

    await fake.sendFromTab(31, jsCookie({ name: "cto_tld_test", domain: ".news-g.example", writerScriptUrl: writer, expiresMs: 0 }));
    await settle();
    const after = fake.sessionStore()["tab:31"] as Stored;
    expect(allKeys(after)).not.toContain("cto_tld_test\u0000.news-g.example");
    expect(after?.cookieLedger.probes).toEqual(["cto_tld_test\u0000.news-g.example"]);
    expect(after?.tallies.probeCookies).toEqual({ Criteo: ["cto_tld_test"] });
  });

  it("does not count a deletion of a cookie it never saw set", async () => {
    await fake.fireBeforeNavigate({ tabId: 32, frameId: 0, url: "https://www.news-g.example/" });
    const writer = "https://static.criteo.net/js/ld/publishertag.js";
    await fake.sendFromTab(32, jsCookie({ name: "cto_bundle", domain: ".news-g.example", writerScriptUrl: writer, expiresMs: 0 }));
    await settle();
    expect(allKeys(fake.sessionStore()["tab:32"] as Stored)).toEqual([]);
  });

  type Listed = { network: { id: string; setCookies: { name: string; expiresMs: unknown }[] }[] };
  const listed = async (tabId: number) => (await fake.sendFromPopup({ type: "get-observations", tabId })) as Listed;

  it("gives two writes made in the same millisecond an id each", async () => {
    // fides-gpp on news-g.example, 2026-09-30: each opted-out cookie is removed twice, with
    // `domain=www.news-g.example` and then `domain=.www.news-g.example`. Two page calls, one
    // millisecond, the same record: an id from the name and the time is `js-tuuid-<ms>` for
    // both.
    await fake.fireBeforeNavigate({ tabId: 33, frameId: 0, url: "https://www.news-g.example/" });
    const writer = "https://static01.news-g-cdn.example/vi-assets/static-assets/fides-gpp-00000000000000000000000000000afb.js";
    const removal = jsCookie({ name: "tuuid", domain: ".www.news-g.example", value: "", expiresMs: 0, writerScriptUrl: writer, timeMs: 1790779016168 });
    await fake.sendFromTab(33, removal);
    await fake.sendFromTab(33, removal);
    await settle();

    const ids = (await listed(33)).network.map((o) => o.id);
    expect(ids).toEqual(["js-tuuid-1790779016168", "js-tuuid-1790779016168#1"]);
    expect(allKeys(fake.sessionStore()["tab:33"] as Stored)).toEqual([]);
  });

  it("takes a probe's set out of the list when it is removed in the same millisecond", async () => {
    // dd_testcookie on the DataDome page, 2026-09-30: set and removed in one millisecond.
    // With one id for both, the set would be skipped as the removal's own entry and stay.
    await fake.fireBeforeNavigate({ tabId: 34, frameId: 0, url: "https://www.news-g.example/" });
    const writer = "https://static.criteo.net/js/ld/publishertag.js";
    const at = Date.now();
    await fake.sendFromTab(34, jsCookie({ name: "cto_tld_test", domain: ".news-g.example", writerScriptUrl: writer, timeMs: at }));
    await fake.sendFromTab(34, jsCookie({ name: "cto_tld_test", domain: ".news-g.example", writerScriptUrl: writer, timeMs: at, expiresMs: 0 }));
    await settle();

    expect(allKeys(fake.sessionStore()["tab:34"] as Stored)).toEqual([]);
    const network = (await listed(34)).network;
    expect(network.map((o) => o.setCookies.length)).toEqual([0, 1]);
    expect(network[1]?.setCookies[0]?.expiresMs).toBe(0);
  });

  it("takes both writes of a probe written twice out of the list", async () => {
    // Written twice and removed twice, as fides-gpp writes its removals. The first removal
    // forgets the key, so the second is a plain deletion, and the first write must still go.
    await fake.fireBeforeNavigate({ tabId: 35, frameId: 0, url: "https://www.news-g.example/" });
    const writer = "https://static.criteo.net/js/ld/publishertag.js";
    const at = Date.now();
    const set = jsCookie({ name: "cto_tld_test", domain: ".news-g.example", writerScriptUrl: writer, timeMs: at });
    const removal = jsCookie({ name: "cto_tld_test", domain: ".news-g.example", writerScriptUrl: writer, timeMs: at, expiresMs: 0 });
    await fake.sendFromTab(35, set);
    await fake.sendFromTab(35, set);
    await fake.sendFromTab(35, removal);
    await fake.sendFromTab(35, removal);
    await settle();

    expect(allKeys(fake.sessionStore()["tab:35"] as Stored)).toEqual([]);
    expect((await listed(35)).network.map((o) => o.setCookies.length)).toEqual([0, 0, 1, 1]);
  });

  it("leaves a set from before the probe window in the list", async () => {
    // Only the probe's own writes go. One made six seconds earlier, past the five-second
    // window, is the cookie the page held until then.
    await fake.fireBeforeNavigate({ tabId: 36, frameId: 0, url: "https://www.news-g.example/" });
    const writer = "https://static.criteo.net/js/ld/publishertag.js";
    const at = Date.now();
    await fake.sendFromTab(36, jsCookie({ name: "cto_tld_test", domain: ".news-g.example", writerScriptUrl: writer, timeMs: at - 6_000 }));
    await fake.sendFromTab(36, jsCookie({ name: "cto_tld_test", domain: ".news-g.example", writerScriptUrl: writer, timeMs: at }));
    await fake.sendFromTab(36, jsCookie({ name: "cto_tld_test", domain: ".news-g.example", writerScriptUrl: writer, timeMs: at, expiresMs: 0 }));
    await settle();

    expect(allKeys(fake.sessionStore()["tab:36"] as Stored)).toEqual([]);
    expect((await listed(36)).network.map((o) => o.setCookies.length)).toEqual([1, 0, 1]);
  });
});

describe("cookie writes behind a consent tool, through the worker (1.23.0)", () => {
  beforeEach(async () => {
    await loadWorker();
  });

  const settle = () => new Promise((r) => setTimeout(r, 200));
  const OSANO = "https://cmp.osano.com/NWFexample0000001/d2b0c4b4/osano.js";
  const GTM = "https://www.googletagmanager.com/gtm.js?id=GTM-XNWF100&l=NF2DL";
  const GTAG = "https://www.googletagmanager.com/gtag/js?id=G-XNWF200000&l=dataLayer";
  const UTAG = "https://tags.tiqcdn.com/utag/automakere/tier1aue/prod/utag.js";
  const jsCookie = (over: Record<string, unknown>) => ({
    type: "js-cookie",
    cookie: {
      value: "v", path: "/", expiresMs: "session", sameSite: "unspecified", secure: false,
      partitioned: false, viaTagManager: false, via: "documentCookie", timeMs: Date.now(),
      frameHost: "www.news-f.example", ...over,
    },
  });
  type Stored = {
    tallies: {
      adCookieKeys: string[];
      adCookieKeysUnsigned: string[];
      adCookieEntities?: Record<string, string>;
      adCookieCategories?: Record<string, string>;
      firstPartyVendorCookieKeys: string[];
      byEntityCategory?: Record<string, { cookieKeys: string[]; cookieKeysUnsigned: string[] }>;
      byContainer?: Record<string, { manager: string; id: string | null; frameUrls: string[]; cookieKeys: string[] }>;
      cookieDetails?: Record<string, { container?: string }>;
    };
  } | undefined;
  type Obs = {
    network: { setCookies: { name: string; writerScriptUrl?: string | null; writerWrapperUrl?: string | null }[] }[];
    cookieCoverage?: { wrappedOver: boolean; onInstance: boolean };
  };

  it("keeps a tag manager writer out of the count by the owner's list: nwf_byline under the container, Google's own names counted", async () => {
    // GTM's host is in no company's list, so a test that only looked for nwf_byline outside
    // the count would pass with no rule at all. Google's own names written by the same
    // container and by the Google tag are counted under Google, in each name's category,
    // and the site's names are kept by the container alone (1.25.0).
    await fake.fireBeforeNavigate({ tabId: 50, frameId: 0, url: "https://www.news-f.example/" });
    await fake.sendFromTab(50, { type: "signal-state", source: "this-extension", readTracking: "active", asserted: true, value: true });
    await fake.sendFromTab(50, jsCookie({
      name: "nwf_byline", domain: ".www.news-f.example", writerScriptUrl: GTM, viaTagManager: true, wrapperScriptUrl: OSANO,
    }));
    await fake.sendFromTab(50, jsCookie({
      name: "nwf_section", domain: ".www.news-f.example", writerScriptUrl: GTM, viaTagManager: true, wrapperScriptUrl: OSANO,
    }));
    await fake.sendFromTab(50, jsCookie({ name: "_gcl_au", domain: ".news-f.example", writerScriptUrl: GTM, viaTagManager: true }));
    await fake.sendFromTab(50, jsCookie({ name: "_ga_XNWF200000", domain: ".news-f.example", writerScriptUrl: GTAG, viaTagManager: true }));
    await settle();

    const t = (fake.sessionStore()["tab:50"] as Stored)?.tallies;
    expect(t?.adCookieKeys).toEqual(["_ga_XNWF200000\u0000.news-f.example", "_gcl_au\u0000.news-f.example"]);
    expect(t?.adCookieEntities).toEqual({ "_ga_XNWF200000\u0000.news-f.example": "Google", "_gcl_au\u0000.news-f.example": "Google" });
    expect(t?.adCookieCategories).toEqual({ "_ga_XNWF200000\u0000.news-f.example": "analytics", "_gcl_au\u0000.news-f.example": "advertising" });
    expect(t?.adCookieKeysUnsigned).toEqual([]);
    expect(t?.firstPartyVendorCookieKeys).toEqual([]);
    // Nor is a site's name kept as a company's cookie in a category that does not count:
    // the container names no vendor.
    const recorded = Object.values(t?.byEntityCategory ?? {}).flatMap((p) => [...p.cookieKeys, ...p.cookieKeysUnsigned]);
    expect(recorded.filter((k) => k.startsWith("nwf_"))).toEqual([]);
    // Every name written inside the container is kept by it, counted or not.
    expect(t?.byContainer?.["gtm:GTM-XNWF100"]).toMatchObject({
      manager: "gtm",
      id: "GTM-XNWF100",
      frameUrls: [GTM],
      cookieKeys: ["_gcl_au\u0000.news-f.example", "nwf_byline\u0000.www.news-f.example", "nwf_section\u0000.www.news-f.example"],
    });
    expect(t?.cookieDetails?.["nwf_byline\u0000.www.news-f.example"]?.container).toBe("gtm:GTM-XNWF100");

    // The badge is the counted keys, and the observation set names the list that charged them.
    const got = (await fake.sendFromPopup({ type: "get-observations", tabId: 50 })) as Obs & { ownerList?: { source: string } };
    expect(got.ownerList?.source).toBe("open-cookie-database");
  });

  it("counts Tealium's own names written inside its container, and not Adobe's", async () => {
    await fake.fireBeforeNavigate({ tabId: 53, frameId: 0, url: "https://www.automaker-e.example/us/en" });
    await fake.sendFromTab(53, { type: "signal-state", source: "this-extension", readTracking: "active", asserted: true, value: true });
    const host = { frameHost: "www.automaker-e.example", writerScriptUrl: UTAG, viaTagManager: true };
    await fake.sendFromTab(53, jsCookie({ name: "utag_main_ses_id", domain: ".automaker-e.example", ...host }));
    await fake.sendFromTab(53, jsCookie({ name: "AMCV_3C3B1234%40AdobeOrg", domain: ".automaker-e.example", ...host }));
    await fake.sendFromTab(53, jsCookie({ name: "mbox", domain: ".automaker-e.example", ...host }));
    await settle();

    const t = (fake.sessionStore()["tab:53"] as Stored)?.tallies;
    expect(t?.adCookieKeys).toEqual(["utag_main_ses_id\u0000.automaker-e.example"]);
    expect(t?.adCookieEntities).toEqual({ "utag_main_ses_id\u0000.automaker-e.example": "Tealium" });
    expect(t?.byContainer?.["tealium:automakere/tier1aue"]?.cookieKeys).toEqual([
      "AMCV_3C3B1234%40AdobeOrg\u0000.automaker-e.example",
      "mbox\u0000.automaker-e.example",
      "utag_main_ses_id\u0000.automaker-e.example",
    ]);
    const recorded = Object.values(t?.byEntityCategory ?? {}).flatMap((p) => [...p.cookieKeys, ...p.cookieKeysUnsigned]);
    expect(recorded.filter((k) => /^(AMCV_|mbox)/.test(k))).toEqual([]);
  });

  it("takes a probe written inside a container out of the container's summary, and notes it there", async () => {
    await fake.fireBeforeNavigate({ tabId: 54, frameId: 0, url: "https://www.news-f.example/" });
    await fake.sendFromTab(54, { type: "signal-state", source: "this-extension", readTracking: "active", asserted: true, value: true });
    await fake.sendFromTab(54, jsCookie({ name: "nwf_probe", domain: ".www.news-f.example", writerScriptUrl: GTM }));
    await fake.sendFromTab(54, jsCookie({ name: "nwf_probe", domain: ".www.news-f.example", writerScriptUrl: GTM, expiresMs: Date.now() - 60_000 }));
    await settle();

    const t = (fake.sessionStore()["tab:54"] as Stored)?.tallies as { byContainer?: Record<string, { cookieKeys: string[]; probeCookies: string[] }> } | undefined;
    expect(t?.byContainer?.["gtm:GTM-XNWF100"]).toMatchObject({ cookieKeys: [], probeCookies: ["nwf_probe"] });
    // Charged to no company, so no company's summary notes it.
    const stored = (fake.sessionStore()["tab:54"] as { tallies: { byEntityCategory?: Record<string, { probeCookies: string[] }> } }).tallies;
    expect(Object.values(stored.byEntityCategory ?? {}).flatMap((p) => p.probeCookies)).toEqual([]);
  });

  it("notes a refused write inside a container on the container, and on no company", async () => {
    await fake.fireBeforeNavigate({ tabId: 55, frameId: 0, url: "https://www.news-f.example/" });
    await fake.sendFromTab(55, jsCookie({ name: "nwf_wide", domain: ".com", writerScriptUrl: GTM }));
    await settle();
    const t = (fake.sessionStore()["tab:55"] as { tallies: { byContainer?: Record<string, { refusedWrites: string[]; cookieKeys: string[] }>; refusedCookieWrites?: Record<string, string[]> } }).tallies;
    expect(t.byContainer?.["gtm:GTM-XNWF100"]).toMatchObject({ refusedWrites: ["nwf_wide (.com)"], cookieKeys: [] });
    expect(t.refusedCookieWrites).toEqual({});
  });

  it("records the wrapper that was stepped over on the cookie, and only when one was", async () => {
    await fake.fireBeforeNavigate({ tabId: 51, frameId: 0, url: "https://www.news-f.example/" });
    await fake.sendFromTab(51, jsCookie({ name: "nwf_byline", domain: ".www.news-f.example", writerScriptUrl: GTM, viaTagManager: true, wrapperScriptUrl: OSANO }));
    await fake.sendFromTab(51, jsCookie({ name: "osano_consentmanager_uuid", domain: ".www.news-f.example", writerScriptUrl: OSANO, wrapperScriptUrl: null }));
    await settle();

    const got = (await fake.sendFromPopup({ type: "get-observations", tabId: 51 })) as Obs;
    const byName = new Map(got.network.flatMap((n) => n.setCookies).map((c) => [c.name, c]));
    expect(byName.get("nwf_byline")?.writerWrapperUrl).toBe(OSANO);
    expect(byName.get("osano_consentmanager_uuid")).not.toHaveProperty("writerWrapperUrl");
  });

  it("keeps the top frame's coverage, latched, and ignores a sub-frame's", async () => {
    await fake.fireBeforeNavigate({ tabId: 52, frameId: 0, url: "https://www.ketch.com/" });
    let got = (await fake.sendFromPopup({ type: "get-observations", tabId: 52 })) as Obs;
    expect(got).not.toHaveProperty("cookieCoverage");

    await fake.sendFromTab(52, { type: "cookie-coverage", coverage: { wrappedOver: false, onInstance: true }, topFrame: true });
    await fake.sendFromTab(52, { type: "cookie-coverage", coverage: { wrappedOver: false, onInstance: false }, topFrame: true });
    await fake.sendFromTab(52, { type: "cookie-coverage", coverage: { wrappedOver: true, onInstance: false }, topFrame: false });
    await settle();

    got = (await fake.sendFromPopup({ type: "get-observations", tabId: 52 })) as Obs;
    expect(got.cookieCoverage).toEqual({ wrappedOver: false, onInstance: true });
  });
});

describe("the summaries per company and category, through the worker (1.20.0)", () => {
  beforeEach(async () => {
    await loadWorker();
  });

  const settle = () => new Promise((r) => setTimeout(r, 200));
  const jsCookie = (over: Record<string, unknown>) => ({
    type: "js-cookie",
    cookie: {
      value: "v", path: "/", expiresMs: "session", sameSite: "unspecified", secure: false,
      partitioned: false, viaTagManager: false, via: "documentCookie", timeMs: Date.now(),
      frameHost: "www.news-g.example", ...over,
    },
  });
  type Summary = {
    entity: string; category: string; scriptRan: boolean;
    cookieKeys: string[]; cookieKeysUnsigned: string[]; probeCookies: string[]; refusedWrites: string[];
  };
  type Stored = {
    tallies: {
      adCookieKeys: string[];
      adCookieKeysUnsigned: string[];
      firstPartyVendorCookieKeys: string[];
      probeCookies?: Record<string, string[]>;
      byEntityCategory?: Record<string, Summary>;
      adCookieEntities?: Record<string, string>;
      firstParty?: { cookieKeys: string[]; cookieKeysUnsigned: string[] };
    };
    cookieLedger: { probes: string[] };
  } | undefined;
  const stored = (tab: number) => fake.sessionStore()[`tab:${tab}`] as Stored;
  const summary = (s: Stored, entity: string, category: string) => s?.tallies.byEntityCategory?.[`${entity}\u0000${category}`];
  const recorded = (p: Summary | undefined) => [...(p?.cookieKeys ?? []), ...(p?.cookieKeysUnsigned ?? [])];
  const counted = (s: Stored) => [...(s?.tallies.adCookieKeys ?? []), ...(s?.tallies.adCookieKeysUnsigned ?? []), ...(s?.tallies.firstPartyVendorCookieKeys ?? [])];

  it("records a refused write against the writing script's company and category", async () => {
    await fake.fireBeforeNavigate({ tabId: 60, frameId: 0, url: "https://www.news-g.example/" });
    await fake.sendFromTab(60, jsCookie({ name: "cto_bidid", domain: ".com", writerScriptUrl: "https://static.criteo.net/js/ld/publishertag.js" }));
    await settle();
    expect(summary(stored(60), "Criteo", "advertising")?.refusedWrites).toEqual(["cto_bidid (.com)"]);
  });

  it("records a counted probe against its category, and on the per-vendor list too", async () => {
    await fake.fireBeforeNavigate({ tabId: 61, frameId: 0, url: "https://www.news-g.example/" });
    const writer = "https://static.criteo.net/js/ld/publishertag.js";
    await fake.sendFromTab(61, jsCookie({ name: "cto_tld_test", domain: ".news-g.example", writerScriptUrl: writer }));
    await fake.sendFromTab(61, jsCookie({ name: "cto_tld_test", domain: ".news-g.example", writerScriptUrl: writer, expiresMs: 0 }));
    await settle();
    const s = stored(61);
    expect(s?.tallies.probeCookies).toEqual({ Criteo: ["cto_tld_test"] });
    expect(summary(s, "Criteo", "advertising")).toMatchObject({ probeCookies: ["cto_tld_test"], scriptRan: true, cookieKeys: [], cookieKeysUnsigned: [] });
  });

  it("takes a probe in a category that does not count out of its summary, and touches no count", async () => {
    // Meta's pixel script is Social in Disconnect's list: recorded, never counted. Its probe
    // leaves its row as Criteo's leaves the headline, and the per-vendor list of probes,
    // which is about counted cookies, does not gain a name.
    await fake.fireBeforeNavigate({ tabId: 62, frameId: 0, url: "https://www.news-g.example/" });
    const writer = "https://connect.facebook.net/en_US/fbevents.js";
    const key = "_fbp_test\u0000.news-g.example";
    await fake.sendFromTab(62, jsCookie({ name: "_fbp_test", domain: ".news-g.example", writerScriptUrl: writer }));
    await fake.sendFromTab(62, jsCookie({ name: "_fbp", domain: ".news-g.example", writerScriptUrl: writer }));
    await settle();
    const before = stored(62);
    expect(recorded(summary(before, "Meta", "social")).sort()).toEqual(["_fbp\u0000.news-g.example", key]);
    expect(counted(before)).toEqual([]);

    await fake.sendFromTab(62, jsCookie({ name: "_fbp_test", domain: ".news-g.example", writerScriptUrl: writer, expiresMs: 0 }));
    await settle();
    const after = stored(62);
    expect(recorded(summary(after, "Meta", "social"))).toEqual(["_fbp\u0000.news-g.example"]);
    expect(summary(after, "Meta", "social")?.probeCookies).toEqual(["_fbp_test"]);
    expect(after?.cookieLedger.probes).toEqual([key]);
    expect(after?.tallies.probeCookies ?? {}).toEqual({});
    expect(counted(after)).toEqual([]);
  });

  it("charges a write with no writer found to a cross-site frame's host, and to the page anywhere else", async () => {
    // A script in a cross-site frame can only write its frame's own domain, so the cookie
    // is that frame's. The same kind of write in the top frame is the page's, first party.
    await fake.fireBeforeNavigate({ tabId: 63, frameId: 0, url: "https://www.news-g.example/" });
    await fake.sendFromTab(63, jsCookie({ name: "KADUSERCOOKIE", domain: ".pubmatic.com", writerScriptUrl: null, frameHost: "ads.pubmatic.com" }));
    await fake.sendFromTab(63, jsCookie({ name: "site_pref", domain: ".news-g.example", writerScriptUrl: null }));
    await settle();
    const s = stored(63);
    expect(counted(s)).toEqual(["KADUSERCOOKIE\u0000.pubmatic.com"]);
    expect(s?.tallies.adCookieEntities).toEqual({ "KADUSERCOOKIE\u0000.pubmatic.com": "PubMatic" });
    expect([...(s?.tallies.firstParty?.cookieKeys ?? []), ...(s?.tallies.firstParty?.cookieKeysUnsigned ?? [])]).toEqual(["site_pref\u0000.news-g.example"]);
  });
});

describe("a worker reclaim loses the request list and nothing the Overview is built from (1.22.0)", () => {
  beforeEach(async () => {
    await loadWorker();
  });

  const settle = () => new Promise((r) => setTimeout(r, 200));
  const TAB = 70;
  const SIGNED = [{ name: "Sec-GPC", value: "1" }];
  const setCookie = (value: string) => ({ name: "Set-Cookie", value });

  /** A page with a Google tag, a signed ad cookie, one set on a redirect, and one from a script. */
  async function loadPage(): Promise<void> {
    await fake.fireBeforeNavigate({ tabId: TAB, frameId: 0, url: "https://www.news-g.example/" });
    await fake.sendFromTab(TAB, { type: "signal-state", source: "this-extension", readTracking: "active", value: true });
    await settle();
    const exchange = async (requestId: string, url: string, type: string, headers: { name: string; value: string }[], status = 200) => {
      await fake.fireSendHeaders({ tabId: TAB, requestId, url, type, requestHeaders: SIGNED });
      await fake.fireHeadersReceived({ tabId: TAB, requestId, url, statusCode: status, responseHeaders: headers });
    };
    await exchange("g1", "https://www.googletagmanager.com/gtm.js?id=GTM-TEST", "script", []);
    await exchange("d1", "https://securepubads.g.doubleclick.net/tag/js/gpt.js", "script", [
      setCookie("IDE=abc; Domain=.doubleclick.net; Path=/; Max-Age=31536000; Secure; SameSite=None"),
    ]);
    // A tracking pixel that sets its cookie on the redirect hop, then lands.
    await exchange("c1", "https://sslwidget.criteo.com/event", "image", [
      setCookie("uid=1; Domain=.criteo.com; Path=/; Max-Age=31536000; Secure; SameSite=None"),
      { name: "Location", value: "https://gum.criteo.com/sync" },
    ], 302);
    await fake.fireHeadersReceived({ tabId: TAB, requestId: "c1", url: "https://gum.criteo.com/sync", statusCode: 200, responseHeaders: [] });
    // Written from a script, into the site's jar.
    await fake.sendFromTab(TAB, {
      type: "js-cookie",
      cookie: {
        name: "cto_bundle", value: "v", domain: ".news-g.example", path: "/", expiresMs: "session",
        sameSite: "unspecified", secure: false, partitioned: false, viaTagManager: false,
        via: "documentCookie", timeMs: Date.now(), frameHost: "www.news-g.example",
        writerScriptUrl: "https://static.criteo.net/js/ld/publishertag.js",
      },
    });
    await settle();
  }

  async function reclaim(): Promise<void> {
    // Chrome reclaims a worker 30 seconds after its last event. By then its marker of
    // unwritten changes is gone, a second after the last write; wait that out here.
    await new Promise((r) => setTimeout(r, 1_300));
    fake.reclaimWorker();
    vi.resetModules();
    await import("../src/background/sw.js");
  }

  /** What the popup draws from, built the way popup.ts builds it. */
  async function overview() {
    const [{ evaluate, countDistinctCookiesSetWithSignal, countDistinctCookiesSetWithoutSignal, countAdTechRequests, countFirstPartyVendorCookies }, { getClassifier }, { buildPopupView }, { buildRequestsView }] =
      await Promise.all([
        import("@gpc-inspector/engine"),
        import("../src/background/classifier.js"),
        import("../src/ui/view-model.js"),
        import("../src/ui/requests-view.js"),
      ]);
    const obs = (await fake.sendFromPopup({ type: "get-observations", tabId: TAB })) as import("@gpc-inspector/schema").ObservationSet;
    const classifier = getClassifier();
    const findings = evaluate(obs, classifier);
    const view = buildPopupView({
      observations: obs,
      findings,
      distinctCookies: countDistinctCookiesSetWithSignal(obs, classifier),
      distinctCookiesUnsigned: countDistinctCookiesSetWithoutSignal(obs, classifier),
      adTechRequests: countAdTechRequests(obs, classifier),
      firstPartyVendorCookies: countFirstPartyVendorCookies(obs, classifier),
      classify: (url: string) => {
        const c = classifier.classify(url, obs.context.topSite);
        return { party: c.party, category: c.category, entity: c.entity?.name ?? null, domain: c.registrableDomain };
      },
      sendingSignal: true,
      signalKnown: true,
    });
    return { obs, findings, view, requests: buildRequestsView(obs, classifier, "all") };
  }

  it("keeps every finding, count and vendor panel, and says so only on the Requests tab", async () => {
    await loadPage();
    const before = await overview();
    expect(before.obs.network.length).toBeGreaterThan(0);
    expect(before.findings.filter((f) => f.flag === "cookie-set-on-redirect")).toHaveLength(1);
    expect(before.obs.gtm.scriptFetched).toBe(true);

    await reclaim();
    const after = await overview();

    expect(after.obs.network).toEqual([]);
    expect(after.obs.context.incompleteReasons).toEqual(["worker-restarted"]);
    expect(after.obs.signal.secGpcRequestCount).toBe(before.obs.signal.secGpcRequestCount);
    expect(after.findings).toEqual(before.findings);
    expect(after.view).toEqual(before.view);
    expect(after.requests.requestsDropped).toBe(true);
    expect(before.requests.requestsDropped).toBe(false);
    // The requests that set a cookie are listed again, from the kept records (1.27.0).
    const cookieRows = (rows: typeof before.requests.rows) => rows.filter((r) => r.cookieNames.length > 0).map((r) => [r.id, r.url, r.cookieNames, r.countedCookieNames, r.secGpcPresent, r.isRedirectHop]);
    expect(after.requests.rows.map((r) => r.id)).toEqual(before.requests.rows.filter((r) => r.cookieNames.length > 0).map((r) => r.id));
    expect(after.requests.rows.map((r) => r.id.replace(/-\d+$/, ""))).toEqual(["d1", "c1", "js-cto_bundle"]);
    expect(cookieRows(after.requests.rows)).toEqual(cookieRows(before.requests.rows));
    expect(after.requests.keptShown).toBe(3);
    expect(after.requests.keptIncomplete).toBe(false);
    expect(before.requests.keptShown).toBe(0);
  });

  it("stores the kept records as strings under their own keys, with no cookie value (1.27.0)", async () => {
    await loadPage();
    await new Promise((r) => setTimeout(r, 1_300));
    const store = fake.sessionStore();
    const chunk = store[`cookies:${TAB}:0`];
    expect(typeof chunk).toBe("string");
    expect(JSON.parse(chunk as string).map((k: { id: string }) => k.id.replace(/-\d+$/, ""))).toEqual(["d1", "c1", "js-cto_bundle"]);
    expect(chunk as string).not.toContain("IDE=abc");
    expect(chunk as string).not.toContain('"value"');
    const state = store[`tab:${TAB}`] as { keptCookieChunks?: number; keptCookies?: unknown };
    expect(state.keptCookieChunks).toBe(1);
    expect("keptCookies" in state).toBe(false);
  });

  it("stores the tab's state as one JSON string, and reads it back after a reclaim", async () => {
    // chrome.storage.session counts a nested object at three to four times its JSON length
    // against the quota, and a string at its own (measured 2026-09-30).
    await loadPage();
    await new Promise((r) => setTimeout(r, 1_300));
    const raw = fake.rawSessionStore()[`tab:${TAB}`];
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw as string)).toEqual(fake.sessionStore()[`tab:${TAB}`]);
    const before = await overview();
    await reclaim();
    const after = await overview();
    expect(after.findings).toEqual(before.findings);
    expect(after.view).toEqual(before.view);
    expect(after.obs.tallies).toEqual(before.obs.tallies);
  });

  it("reports a stored state that does not parse as a failed read", async () => {
    fake.reclaimWorker();
    fake.seedSession({ [`tab:${TAB}`]: "{\"topSite\": \"news-g.example\", trunc" });
    vi.resetModules();
    await import("../src/background/sw.js");
    const obs = (await fake.sendFromPopup({ type: "get-observations", tabId: TAB })) as { context: { incompleteReasons?: string[] } } | null;
    expect(obs?.context.incompleteReasons).toContain("read-failed");
  });

  it("starts the kept records over on a new page, and removes them when the tab closes", async () => {
    await loadPage();
    await fake.fireBeforeNavigate({ tabId: TAB, frameId: 0, url: "https://www.news-k.example/" });
    await new Promise((r) => setTimeout(r, 1_300));
    expect(fake.sessionStore()[`cookies:${TAB}:0`]).toBeUndefined();
    expect((fake.sessionStore()[`tab:${TAB}`] as { keptCookieChunks?: number }).keptCookieChunks).toBe(0);

    await fake.fireSendHeaders({ tabId: TAB, requestId: "n1", url: "https://securepubads.g.doubleclick.net/n", type: "image", requestHeaders: SIGNED });
    await fake.fireHeadersReceived({ tabId: TAB, requestId: "n1", url: "https://securepubads.g.doubleclick.net/n", statusCode: 200, responseHeaders: [setCookie("IDE=n; Domain=.doubleclick.net; Path=/; Secure; SameSite=None")] });
    await new Promise((r) => setTimeout(r, 1_300));
    expect(JSON.parse(fake.sessionStore()[`cookies:${TAB}:0`] as string).map((k: { id: string }) => k.id)).toEqual(["n1"]);

    // A later worker, which never loaded this tab, still finds the chunks by the state.
    fake.reclaimWorker();
    vi.resetModules();
    await import("../src/background/sw.js");
    await fake.fireTabRemoved(TAB);
    expect(Object.keys(fake.sessionStore()).filter((k) => k.endsWith(`:${TAB}`) || k.startsWith(`cookies:${TAB}:`))).toEqual([]);
  });

  it("drops the tab's own kept records last to make room, and says none are listed", async () => {
    await loadPage();
    await new Promise((r) => setTimeout(r, 1_300));
    const store = fake.sessionStore();
    const chunkLength = (store[`cookies:${TAB}:0`] as string).length;
    fake.setSessionQuota(fake.sessionBytes() - Math.floor(chunkLength / 2));
    await fake.fireSendHeaders({ tabId: TAB, requestId: "late", url: "https://www.news-g.example/late", type: "xmlhttprequest", requestHeaders: SIGNED });
    await new Promise((r) => setTimeout(r, 1_300));
    expect(fake.sessionStore()[`cookies:${TAB}:0`]).toBeUndefined();
    const state = fake.sessionStore()[`tab:${TAB}`] as { incomplete: boolean; keptCookiesIncomplete?: boolean };
    expect(state.incomplete).toBe(false);
    expect(state.keptCookiesIncomplete).toBe(true);

    // The list still in memory is not written back into the space just freed.
    fake.setSessionQuota(null);
    await fake.fireHeadersReceived({ tabId: TAB, requestId: "late", url: "https://www.news-g.example/late", statusCode: 200, responseHeaders: [setCookie("s=1; Path=/")] });
    await new Promise((r) => setTimeout(r, 1_300));
    expect(fake.sessionStore()[`cookies:${TAB}:0`]).toBeUndefined();

    await reclaim();
    const { requests } = await overview();
    expect(requests.rows).toEqual([]);
    expect(requests.keptShown).toBe(0);
    expect(requests.keptIncomplete).toBe(true);
  }, 15_000);

  const keptIds = () => (JSON.parse(fake.sessionStore()[`cookies:${TAB}:0`] as string) as { id: string }[]).map((k) => k.id);
  const pixel = async (requestId: string, name: string) => {
    const url = `https://securepubads.g.doubleclick.net/${requestId}`;
    await fake.fireSendHeaders({ tabId: TAB, requestId, url, type: "image", requestHeaders: SIGNED });
    await fake.fireHeadersReceived({ tabId: TAB, requestId, url, statusCode: 200, responseHeaders: [setCookie(`${name}=1; Domain=.doubleclick.net; Path=/; Secure; SameSite=None`)] });
  };

  it("stores a record kept while the write before it was in flight (1.27.0)", async () => {
    // A store slower than the 120 ms flush. The second flush keeps a record while the first
    // write is out, and that write must not be taken as holding it, or it is never stored.
    await fake.fireBeforeNavigate({ tabId: TAB, frameId: 0, url: "https://www.news-g.example/" });
    await new Promise((r) => setTimeout(r, 1_300));
    fake.setSessionWriteDelay(400);
    await pixel("w1", "A");
    await new Promise((r) => setTimeout(r, 200));
    await pixel("w2", "B");
    await new Promise((r) => setTimeout(r, 2_000));
    expect(keptIds()).toEqual(["w1", "w2"]);
  }, 10_000);

  it("writes a new page's kept records over the last page's, at the same count (1.27.0)", async () => {
    await loadPage();
    await new Promise((r) => setTimeout(r, 1_300));
    expect(keptIds()).toHaveLength(3);
    // The reset and as many cookie-setting requests as the last page kept, in one flush.
    await fake.fireBeforeNavigate({ tabId: TAB, frameId: 0, url: "https://www.news-k.example/" });
    for (const id of ["n1", "n2", "n3"]) await pixel(id, `N${id}`);
    await new Promise((r) => setTimeout(r, 1_300));
    expect(keptIds()).toEqual(["n1", "n2", "n3"]);
  });

  it("takes a probe's set out of its kept record when the removal comes a flush later (1.27.0)", async () => {
    // Kept on one flush, found to be a probe on a later one: a record that kept the set the
    // list took back out would have the tab draw it as counted after a reclaim.
    await fake.fireBeforeNavigate({ tabId: TAB, frameId: 0, url: "https://www.news-g.example/" });
    await fake.sendFromTab(TAB, { type: "signal-state", source: "this-extension", readTracking: "active", value: true });
    const probe = (over: Record<string, unknown>) => ({
      type: "js-cookie",
      cookie: {
        name: "cto_tld_test", value: "v", domain: ".news-g.example", path: "/", expiresMs: "session",
        sameSite: "unspecified", secure: false, partitioned: false, viaTagManager: false,
        via: "documentCookie", timeMs: Date.now(), frameHost: "www.news-g.example",
        writerScriptUrl: "https://static.criteo.net/js/ld/publishertag.js", ...over,
      },
    });
    await fake.sendFromTab(TAB, probe({}));
    await new Promise((r) => setTimeout(r, 1_300));
    const stored = () => (JSON.parse(fake.sessionStore()[`cookies:${TAB}:0`] as string) as { setCookies: unknown[] }[]).map((k) => k.setCookies.length);
    expect(stored()).toEqual([1]);

    await fake.sendFromTab(TAB, probe({ expiresMs: 0, timeMs: Date.now() }));
    await new Promise((r) => setTimeout(r, 1_300));
    // The set's record stays in place with nothing in it; the removal has its own.
    expect(stored()).toEqual([0, 1]);

    await reclaim();
    const { requests } = await overview();
    expect(requests.rows.map((r) => [r.cookieNames, r.countedCookieNames])).toEqual([[["cto_tld_test"], []]]);
    expect(requests.keptShown).toBe(1);
  }, 10_000);

  it("loses only the kept records when their chunk is unreadable, and keeps every count (1.27.0)", async () => {
    // The records are read with the state, in one read, so no failure of theirs alone can
    // throw the state away. What can still go wrong is a chunk that does not parse.
    await loadPage();
    const before = await overview();
    await new Promise((r) => setTimeout(r, 1_300));
    fake.reclaimWorker();
    fake.seedSession({ [`cookies:${TAB}:0`]: "{not json" });
    vi.resetModules();
    await import("../src/background/sw.js");
    const after = await overview();
    expect(after.obs.context.incompleteReasons).toEqual(["worker-restarted"]);
    expect(after.view).toEqual(before.view);
    expect(after.requests).toMatchObject({ rows: [], keptShown: 0, keptIncomplete: true });
  });

  it("removes a chunk past the ones its state names, on the next write (1.27.0)", async () => {
    // What a failed removal leaves behind after a new page: the state no longer names it.
    await loadPage();
    await reclaim();
    fake.seedSession({ [`cookies:${TAB}:5`]: "[]" });
    await pixel("after", "A");
    await new Promise((r) => setTimeout(r, 1_300));
    expect(fake.sessionStore()[`cookies:${TAB}:5`]).toBeUndefined();
    expect(keptIds()).toHaveLength(4);
  });

  it("sends only the kept records the list lost with the observations (1.27.0)", async () => {
    // The others repeat a request the list still holds: at the cap, about 1.3 MB more on
    // every popup and panel refresh.
    await loadPage();
    expect((await overview()).obs.keptCookieResponses).toEqual([]);
    await reclaim();
    const { obs } = await overview();
    expect(obs.keptCookieResponses?.map((k) => k.id.replace(/-\d+$/, ""))).toEqual(["d1", "c1", "js-cto_bundle"]);
  });

  it("lists a later hop of a request the last worker saw, and the hop it kept (1.27.0)", async () => {
    // The first hop set a cookie and was kept by the bare request id. The next worker, with
    // no list, would give the next hop that id too, and the tab would list one of the two.
    await loadPage();
    const PX = "https://sslwidget.criteo.com/straddle";
    await fake.fireSendHeaders({ tabId: TAB, requestId: "s1", url: PX, type: "image", requestHeaders: SIGNED });
    await fake.fireHeadersReceived({ tabId: TAB, requestId: "s1", url: PX, statusCode: 302, responseHeaders: [
      setCookie("hop0=1; Domain=.criteo.com; Path=/; Max-Age=31536000; Secure; SameSite=None"),
      { name: "Location", value: "https://gum.criteo.com/landed" },
    ] });
    await reclaim();
    await fake.fireHeadersReceived({ tabId: TAB, requestId: "s1", url: "https://gum.criteo.com/landed", statusCode: 200, responseHeaders: [
      setCookie("hop1=1; Domain=.criteo.com; Path=/; Max-Age=31536000; Secure; SameSite=None"),
    ] });
    await new Promise((r) => setTimeout(r, 1_300));

    expect(keptIds().filter((id) => id.startsWith("s1"))).toEqual(["s1", "s1#1"]);
    const { requests } = await overview();
    const hops = requests.rows.filter((r) => r.id.startsWith("s1")).map((r) => [r.id, r.cookieNames, r.kept === true]);
    expect(hops).toEqual([["s1", ["hop0"], true], ["s1#1", ["hop1"], false]]);
  });

  it("says some kept records are missing after a worker that ended mid-batch, and keeps new ones (1.27.0)", async () => {
    await loadPage();
    await new Promise((r) => setTimeout(r, 1_300));
    const stored = fake.sessionStore()[`tab:${TAB}`];
    fake.reclaimWorker();
    fake.seedSession({ [`tab:${TAB}`]: stored, [`dirty:${TAB}`]: "a-worker-that-died" });
    vi.resetModules();
    await import("../src/background/sw.js");
    const { requests } = await overview();
    expect(requests.keptShown).toBe(3);
    expect(requests.keptIncomplete).toBe(true);

    await pixel("after", "A");
    await new Promise((r) => setTimeout(r, 1_300));
    expect(keptIds().at(-1)).toBe("after");
  });

  it("keeps again in a later worker after the records were dropped to make room (1.27.0)", async () => {
    await loadPage();
    await new Promise((r) => setTimeout(r, 1_300));
    const store = fake.sessionStore();
    fake.setSessionQuota(JSON.stringify(store).length - Math.floor((store[`cookies:${TAB}:0`] as string).length / 2));
    await pixel("late", "L");
    await new Promise((r) => setTimeout(r, 1_300));
    expect(fake.sessionStore()[`cookies:${TAB}:0`]).toBeUndefined();
    fake.setSessionQuota(null);

    // The worker that dropped them keeps none. The next one has no list to write back.
    await reclaim();
    await pixel("next", "N");
    await new Promise((r) => setTimeout(r, 1_300));
    expect(keptIds()).toEqual(["next"]);
    const { requests } = await overview();
    expect(requests.keptIncomplete).toBe(true);
  }, 15_000);

  it("names a later redirect hop's own request as a vendor's first, not the first hop's", async () => {
    await fake.fireBeforeNavigate({ tabId: TAB, frameId: 0, url: "https://www.news-g.example/" });
    await fake.fireSendHeaders({ tabId: TAB, requestId: "x1", url: "https://sslwidget.criteo.com/event", type: "image", requestHeaders: SIGNED });
    await fake.fireHeadersReceived({ tabId: TAB, requestId: "x1", url: "https://sslwidget.criteo.com/event", statusCode: 302, responseHeaders: [] });
    await fake.fireSendHeaders({ tabId: TAB, requestId: "x1", url: "https://cm.g.doubleclick.net/pixel", type: "image", requestHeaders: SIGNED });
    await settle();
    const { obs } = await overview();
    const summary = (entity: string) => obs.tallies.byEntityCategory?.[`${entity}\u0000advertising`];
    expect(summary("Criteo")?.firstObservationId).toBe("x1");
    expect(summary("Google")?.firstObservationId).toBe("x1#1");
    expect(obs.network.map((n) => n.id)).toEqual(["x1", "x1#1"]);
  });

  it("marks a busy tab while its changes are unwritten, and clears the mark once quiet", async () => {
    await loadPage();
    await fake.fireSendHeaders({ tabId: TAB, requestId: "late", url: "https://securepubads.g.doubleclick.net/late", type: "image", requestHeaders: SIGNED });
    expect(typeof fake.sessionStore()[`dirty:${TAB}`]).toBe("string");
    await new Promise((r) => setTimeout(r, 1_400));
    expect(fake.sessionStore()[`dirty:${TAB}`]).toBeUndefined();
  });

  it("reports a worker that ended with changes unwritten as a failed save, not a clean reclaim", async () => {
    // What a predecessor that died mid-batch leaves: its last written state, and its marker.
    await loadPage();
    await new Promise((r) => setTimeout(r, 1_300));
    const stored = fake.sessionStore()[`tab:${TAB}`];
    fake.reclaimWorker();
    fake.seedSession({ [`tab:${TAB}`]: stored, [`dirty:${TAB}`]: "a-worker-that-died" });
    vi.resetModules();
    await import("../src/background/sw.js");
    const { obs, view } = await overview();
    expect(obs.context.incompleteReasons).toEqual(["worker-restarted", "write-failed"]);
    expect(view.notices.map((n) => n.textKey)).toContain("stateSaveFailed");
  });

  it("reads a dead worker's marker before writing its own, when an event comes first", async () => {
    // The usual order: the next request wakes the worker, and its first change to the tab
    // would have written this worker's marker over the one it had not yet read.
    await loadPage();
    await new Promise((r) => setTimeout(r, 1_300));
    const stored = fake.sessionStore()[`tab:${TAB}`];
    fake.reclaimWorker();
    fake.seedSession({ [`tab:${TAB}`]: stored, [`dirty:${TAB}`]: "a-worker-that-died" });
    vi.resetModules();
    await import("../src/background/sw.js");
    await fake.fireSendHeaders({ tabId: TAB, requestId: "after", url: "https://securepubads.g.doubleclick.net/after", type: "image", requestHeaders: SIGNED });
    await settle();
    const state = fake.sessionStore()[`tab:${TAB}`] as { incompleteReasons: string[] } | undefined;
    expect(state?.incompleteReasons).toEqual(["worker-restarted", "write-failed"]);
  });

  it("keeps a cookie whose request was lost to a reclaim by name, counted nowhere", async () => {
    // The request goes out, the worker is reclaimed, and the response reaches the next one.
    // Its Set-Cookie matches no observation, and is kept rather than dropped unread.
    await loadPage();
    const LATE = "https://securepubads.g.doubleclick.net/late";
    const CDN = "https://static.example-cdn.net/slow";
    const SITE = "https://www.news-g.example/slow";
    for (const [id, url] of [["lost-ad", LATE], ["lost-cdn", CDN], ["lost-site", SITE]] as const) {
      await fake.fireSendHeaders({ tabId: TAB, requestId: id, url, type: "xmlhttprequest", requestHeaders: SIGNED });
    }
    await settle();
    const before = await overview();
    await reclaim();
    const respond = (requestId: string, url: string, cookie: string) =>
      fake.fireHeadersReceived({ tabId: TAB, requestId, url, statusCode: 200, responseHeaders: [setCookie(cookie)] });
    await respond("lost-ad", LATE, "late_id=1; Domain=.doubleclick.net; Path=/; Max-Age=3600; Secure; SameSite=None");
    await respond("lost-cdn", CDN, "edge=1; Domain=.example-cdn.net; Path=/; Max-Age=3600");
    await respond("lost-site", SITE, "session=1; Domain=.news-g.example; Path=/");
    await settle();
    const after = await overview();

    // Kept, and marked: the Requests tab lists each response, with no signal claimed.
    expect(after.obs.network.map((n) => [n.id, n.requestLost, n.setCookies.map((c) => c.name)])).toEqual([
      ["lost-ad", true, ["late_id"]],
      ["lost-cdn", true, ["edge"]],
      ["lost-site", true, ["session"]],
    ]);
    const lostRows = after.requests.rows.filter((r) => r.id.startsWith("lost-"));
    expect(lostRows).toHaveLength(3);
    expect(lostRows.every((r) => r.requestLost === true && r.countedCookieNames.length === 0)).toBe(true);
    // The page's earlier cookie-setting requests come first, from the kept records (1.27.0).
    expect(after.requests.rows.map((r) => r.id.replace(/-\d+$/, ""))).toEqual(["d1", "c1", "js-cto_bundle", "lost-ad", "lost-cdn", "lost-site"]);
    // In the summary of whoever set it, and in no count.
    const t = after.obs.tallies;
    expect(t.byEntityCategory?.["Google\u0000advertising"]?.cookieKeysRequestLost).toEqual(["late_id\u0000.doubleclick.net"]);
    expect(t.byUnlistedDomain?.["example-cdn.net"]?.cookieKeysRequestLost).toEqual(["edge\u0000.example-cdn.net"]);
    expect(t.firstParty?.cookieKeysRequestLost).toEqual(["session\u0000.news-g.example"]);
    expect(t.cookieDetails?.["late_id\u0000.doubleclick.net"]).toMatchObject({ requestLost: true, firstSignedObservationId: null });
    expect(t.adCookieKeys).toEqual(before.obs.tallies.adCookieKeys);
    expect(t.adCookieKeysUnsigned ?? []).toEqual(before.obs.tallies.adCookieKeysUnsigned ?? []);
    expect(after.obs.signal.totalRequestCount).toBe(before.obs.signal.totalRequestCount);
    expect(after.view.cookieCount).toBe(before.view.cookieCount);
    expect(after.view.countNames).toEqual(before.view.countNames);
    // Listed in the panels, marked, and never on a row.
    const google = after.view.vendors.find((r) => r.name === "Google" && r.category === "advertising");
    expect(google?.cookies).not.toContain("late_id");
    expect(google?.detail.cookies.find((c) => c.name === "late_id")).toMatchObject({ requestLost: true });
    const cdn = after.view.vendors.find((r) => r.name === "example-cdn.net");
    expect(cdn).toMatchObject({ group: "unlisted", cookies: [], emptyKey: "vendorCookiesRequestLost" });
    expect(cdn?.detail.cookies).toMatchObject([{ name: "edge", requestLost: true }]);
  });

  it("drops a response the page before sent for, arriving after the reset, with no restart", async () => {
    // loadPage commits nothing, as a tab open before install: the reset retires no documents,
    // so fromOtherPage cannot tell this response is the old page's. No worker restarted, so
    // every request since the reset was seen, and one matching none is not this page's.
    await loadPage();
    const OLD = "https://static.example-cdn.net/old";
    await fake.fireSendHeaders({ tabId: TAB, requestId: "old", url: OLD, type: "xmlhttprequest", requestHeaders: SIGNED });
    await fake.fireBeforeNavigate({ tabId: TAB, frameId: 0, url: "https://www.news-k.example/" });
    await fake.fireHeadersReceived({ tabId: TAB, requestId: "old", url: OLD, statusCode: 200, responseHeaders: [setCookie("edge=1; Domain=.example-cdn.net; Path=/")] });
    await settle();
    const { obs, view } = await overview();
    expect(obs.network).toEqual([]);
    expect(obs.tallies.byUnlistedDomain?.["example-cdn.net"]).toBeUndefined();
    expect(view.vendors.find((r) => r.name === "example-cdn.net")).toBeUndefined();
  });

  it("counts requests, not script-written cookies, as sent with the signal", async () => {
    await loadPage();
    const { obs } = await overview();
    // Three requests went out signed. The redirect hop is the same request, and the script
    // cookie's observation is not a request; the list holds five observations.
    expect(obs.network).toHaveLength(5);
    expect(obs.signal.secGpcRequestCount).toBe(3);
    expect(obs.signal.totalRequestCount).toBe(3);
  });
});

describe("a top-level redirect is counted against the site it lands on (1.26.0)", () => {
  beforeEach(async () => {
    await loadWorker();
  });

  const settle = () => new Promise((r) => setTimeout(r, 200));
  const SIGNED = [{ name: "Sec-GPC", value: "1" }];
  const setCookie = (value: string) => ({ name: "Set-Cookie", value });
  type Stored = {
    tallies: {
      adCookieKeys: string[];
      totalRequests: number;
      firstParty?: { cookieKeys: string[] };
      byUnlistedDomain?: Record<string, { cookieKeys: string[]; requests: number }>;
      byEntityCategory?: Record<string, { requests: number }>;
    };
    awaitingCommit?: boolean;
    heldTopLevel?: unknown[];
  } | undefined;
  const stored = (tab: number) => fake.sessionStore()[`tab:${tab}`] as Stored;

  /** An ad click tracker that sets its cookie on the redirect, landing on a shop that sets its own. */
  async function click(tab: number): Promise<void> {
    const CLICK = "https://ad.doubleclick.net/ddm/clk/123";
    const SHOP = "https://www.example-shop.com/";
    await fake.fireBeforeNavigate({ tabId: tab, frameId: 0, url: CLICK });
    await fake.fireSendHeaders({ tabId: tab, requestId: "nav", url: CLICK, type: "main_frame", requestHeaders: SIGNED });
    await fake.fireHeadersReceived({
      tabId: tab, requestId: "nav", url: CLICK, statusCode: 302, type: "main_frame",
      responseHeaders: [setCookie("IDE=1; Domain=.doubleclick.net; Path=/; Max-Age=3600; Secure; SameSite=None"), { name: "Location", value: SHOP }],
    });
    await fake.fireSendHeaders({ tabId: tab, requestId: "nav", url: SHOP, type: "main_frame", requestHeaders: SIGNED });
    await fake.fireHeadersReceived({ tabId: tab, requestId: "nav", url: SHOP, statusCode: 200, type: "main_frame", responseHeaders: [setCookie("session=1; Domain=.example-shop.com; Path=/")] });
    await settle();
  }

  it("holds the main frame's requests and cookies until the commit, and counts none before it", async () => {
    await click(80);
    const s = stored(80);
    expect(s?.awaitingCommit).toBe(true);
    expect(s?.heldTopLevel).toHaveLength(4);
    expect(s?.tallies.totalRequests).toBe(0);
    expect(s?.tallies.adCookieKeys).toEqual([]);
  });

  it("charges the tracker's redirect cookie to the tracker, and the landed site's to the site", async () => {
    // Judged against the first URL's site, the tracker's cookie would be first party and
    // the shop's own a third party's.
    await click(81);
    await fake.fireCommitted({ tabId: 81, frameId: 0, url: "https://www.example-shop.com/", documentId: "SHOP" });
    await settle();
    const t = stored(81)?.tallies;
    expect(t?.adCookieKeys).toEqual(["IDE\u0000.doubleclick.net"]);
    expect(t?.firstParty?.cookieKeys).toEqual(["session\u0000.example-shop.com"]);
    expect(t?.byUnlistedDomain?.["example-shop.com"]).toBeUndefined();
    expect(t?.totalRequests).toBe(2);
    expect(t?.byEntityCategory?.["Google\u0000advertising"]?.requests).toBe(1);
    expect(stored(81)?.awaitingCommit).toBe(false);
    expect(stored(81)?.heldTopLevel).toEqual([]);
  });

  it("counts a navigation that never redirected at its commit", async () => {
    await fake.fireBeforeNavigate({ tabId: 82, frameId: 0, url: "https://www.example-shop.com/" });
    await fake.fireSendHeaders({ tabId: 82, requestId: "n", url: "https://www.example-shop.com/", type: "main_frame", requestHeaders: SIGNED });
    await fake.fireHeadersReceived({ tabId: 82, requestId: "n", url: "https://www.example-shop.com/", statusCode: 200, type: "main_frame", responseHeaders: [setCookie("session=1; Path=/")] });
    // A subresource is never held.
    await fake.fireSendHeaders({ tabId: 82, requestId: "s", url: "https://securepubads.g.doubleclick.net/gpt.js", type: "script", requestHeaders: SIGNED });
    await settle();
    expect(stored(82)?.tallies.totalRequests).toBe(1);
    await fake.fireCommitted({ tabId: 82, frameId: 0, url: "https://www.example-shop.com/", documentId: "SHOP2" });
    await settle();
    expect(stored(82)?.tallies.totalRequests).toBe(2);
    expect(stored(82)?.tallies.firstParty?.cookieKeys).toEqual(["session\u0000.www.example-shop.com"]);
  });
});

describe("each counted cookie is checked against the cookie jar (1.30.0)", () => {
  beforeEach(async () => {
    await loadWorker();
  });

  const TAB = 90;
  const SIGNED = [{ name: "Sec-GPC", value: "1" }];
  // A check runs a second after the last write of its key, then the answer is written.
  const checked = () => new Promise((r) => setTimeout(r, 1_400));
  type Stored = {
    tallies: { adCookieKeys: string[]; cookieDetails?: Record<string, unknown>; byEntityCategory?: Record<string, { cookieKeys: string[] }> };
    cookieLedger: { landed?: string[] };
  };
  const stored = () => fake.sessionStore()[`tab:${TAB}`] as Stored;
  type Listed = { network: { id: string; setCookies: { name: string; jar?: string }[] }[] };
  const listed = async () => (await fake.sendFromPopup({ type: "get-observations", tabId: TAB })) as Listed;
  const marks = async () => (await listed()).network.flatMap((n) => n.setCookies.map((c) => [n.id, c.name, c.jar ?? null]));

  async function page(): Promise<void> {
    await fake.fireBeforeNavigate({ tabId: TAB, frameId: 0, url: "https://www.news-g.example/" });
    await fake.sendFromTab(TAB, { type: "signal-state", source: "this-extension", readTracking: "active", value: true });
  }
  async function exchange(requestId: string, url: string, setCookie: string): Promise<void> {
    await fake.fireSendHeaders({ tabId: TAB, requestId, url, type: "image", requestHeaders: SIGNED });
    await fake.fireHeadersReceived({ tabId: TAB, requestId, url, statusCode: 200, responseHeaders: [{ name: "Set-Cookie", value: setCookie }] });
  }
  const IDE = "IDE=abc; Domain=.doubleclick.net; Path=/; Max-Age=3600; Secure; SameSite=None";
  // kargo.com's load balancer cookie on news-h.example, 2026-09-30: no SameSite on a third-party
  // response, so the browser takes it as Lax and does not store it.
  const AWSALB = "AWSALB=x1; Expires=Wed, 07 Oct 2099 17:00:00 GMT; Path=/";
  const KARGO = "https://krk2.kargo.com/api/v1/sync";

  it("keeps a cookie the jar holds, marks it landed, and does not check that key again", async () => {
    fake.setJar([{ name: "IDE", domain: ".doubleclick.net", value: "abc" }]);
    await page();
    await exchange("d1", "https://securepubads.g.doubleclick.net/gpt.js", IDE);
    await checked();
    expect(stored().tallies.adCookieKeys).toContain("IDE\u0000.doubleclick.net");
    expect(stored().cookieLedger.landed).toEqual(["IDE\u0000.doubleclick.net"]);
    expect(await marks()).toEqual([["d1", "IDE", "landed"]]);

    await exchange("d2", "https://securepubads.g.doubleclick.net/slot", IDE);
    await checked();
    expect(fake.jarLookups()).toHaveLength(1);
    expect(await marks()).toEqual([["d1", "IDE", "landed"], ["d2", "IDE", null]]);
  });

  it("takes a cookie the jar does not hold out of every count, and keeps it on its request, marked", async () => {
    fake.setJar([{ name: "IDE", domain: ".doubleclick.net", value: "abc" }]);
    await page();
    await exchange("d1", "https://securepubads.g.doubleclick.net/gpt.js", IDE);
    await exchange("k1", KARGO, AWSALB);
    await new Promise((r) => setTimeout(r, 200));
    expect(stored().tallies.adCookieKeys).toContain("AWSALB\u0000.krk2.kargo.com");
    await checked();

    const t = stored().tallies;
    expect(t.adCookieKeys).toEqual(["IDE\u0000.doubleclick.net"]);
    expect(t.cookieDetails?.["AWSALB\u0000.krk2.kargo.com"]).toBeUndefined();
    expect(Object.values(t.byEntityCategory ?? {}).flatMap((p) => p.cookieKeys)).not.toContain("AWSALB\u0000.krk2.kargo.com");
    expect(await marks()).toEqual([["d1", "IDE", "landed"], ["k1", "AWSALB", "not-stored"]]);
    // Listed as a refused write is, against the company it was charged to.
    expect(Object.values((stored().tallies as { refusedCookieWrites?: Record<string, string[]> }).refusedCookieWrites ?? {}).flat()).toEqual(["AWSALB (.krk2.kargo.com)"]);

    // The Requests tab lists it on its request, counted nowhere.
    const [{ buildRequestsView }, { getClassifier }] = await Promise.all([import("../src/ui/requests-view.js"), import("../src/background/classifier.js")]);
    const obs = (await fake.sendFromPopup({ type: "get-observations", tabId: TAB })) as import("@gpc-inspector/schema").ObservationSet;
    const row = buildRequestsView(obs, getClassifier(), "all").rows.find((r) => r.id === "k1");
    expect(row).toMatchObject({ cookieNames: ["AWSALB"], countedCookieNames: [], notStoredCookieNames: ["AWSALB"] });
  });

  it("gives a kept record the jar's answer, so after a reclaim its row counts nothing the jar did not hold (1.27.0)", async () => {
    // The record is kept on the flush after the response; the answer comes a second later.
    fake.setJar([]);
    await page();
    await exchange("k1", KARGO, AWSALB);
    await checked();
    const kept = JSON.parse(fake.sessionStore()[`cookies:${TAB}:0`] as string) as { id: string; setCookies: { name: string; jar?: string }[] }[];
    expect(kept.map((k) => [k.id, k.setCookies.map((c) => c.jar ?? null)])).toEqual([["k1", ["not-stored"]]]);

    await new Promise((r) => setTimeout(r, 1_300));
    fake.reclaimWorker();
    vi.resetModules();
    await import("../src/background/sw.js");
    const [{ buildRequestsView }, { getClassifier }] = await Promise.all([import("../src/ui/requests-view.js"), import("../src/background/classifier.js")]);
    const obs = (await fake.sendFromPopup({ type: "get-observations", tabId: TAB })) as import("@gpc-inspector/schema").ObservationSet;
    const row = buildRequestsView(obs, getClassifier(), "all").rows.find((r) => r.id === "k1");
    expect(row).toMatchObject({ kept: true, cookieNames: ["AWSALB"], countedCookieNames: [], notStoredCookieNames: ["AWSALB"] });
  });

  it("reads only the cookies a write named, by name and domain", async () => {
    fake.setJar([]);
    await page();
    await exchange("k1", KARGO, AWSALB);
    await checked();
    expect(fake.jarLookups()).toEqual([{ name: "AWSALB", domain: "krk2.kargo.com", storeId: "0" }]);
  });

  it("does not take out a key that landed when a later write of it is not stored", async () => {
    fake.setJar([{ name: "IDE", domain: ".doubleclick.net", value: "abc" }]);
    await page();
    await exchange("d1", "https://securepubads.g.doubleclick.net/gpt.js", IDE);
    await checked();
    fake.setJar([]);
    await exchange("d2", "https://securepubads.g.doubleclick.net/slot", IDE.replace("abc", "def"));
    await checked();
    expect(stored().tallies.adCookieKeys).toEqual(["IDE\u0000.doubleclick.net"]);
  });

  it("counts a cookie the jar holds with another value, and one it cannot check", async () => {
    fake.setJar([{ name: "IDE", domain: ".doubleclick.net", value: "someone-elses" }]);
    await page();
    await exchange("d1", "https://securepubads.g.doubleclick.net/gpt.js", IDE);
    await checked();
    expect(stored().tallies.adCookieKeys).toEqual(["IDE\u0000.doubleclick.net"]);
    expect(await marks()).toEqual([["d1", "IDE", "unknown"]]);

    fake.setJar(null);
    await exchange("k1", KARGO, AWSALB);
    await checked();
    expect(stored().tallies.adCookieKeys).toContain("AWSALB\u0000.krk2.kargo.com");
    expect((await marks()).find(([id]) => id === "k1")).toEqual(["k1", "AWSALB", null]);
  });

  it("looks a host-only script write up under the host of the frame that wrote it", async () => {
    // A write with no domain is recorded with none. Looked up under "", it would match
    // nothing in the jar, and every one would be taken out of the counts as not stored.
    fake.setJar([{ name: "__gads", domain: "www.news-g.example", value: "ID=1" }]);
    await page();
    await fake.sendFromTab(TAB, {
      type: "js-cookie",
      cookie: {
        name: "__gads",
        value: "ID=1",
        domain: "",
        path: "/",
        expiresMs: "session",
        sameSite: "unspecified",
        secure: false,
        partitioned: false,
        writerScriptUrl: "https://securepubads.g.doubleclick.net/tag/js/gpt.js",
        viaTagManager: false,
        via: "documentCookie",
        timeMs: Date.now(),
        frameHost: "www.news-g.example",
      },
    });
    await checked();
    expect(fake.jarLookups()).toEqual([{ name: "__gads", domain: "www.news-g.example", storeId: "0" }]);
    expect((await marks()).map(([, name, jar]) => [name, jar])).toEqual([["__gads", "landed"]]);
    expect(stored().cookieLedger.landed).toEqual(["__gads\u0000"]);
  });

  it("marks each frame's host-only write with its own host's answer, and counts the key once one landed", async () => {
    // Same name, no domain: one key. The frame's write was refused, the top frame's stored.
    fake.setJar([{ name: "__gads", domain: "www.news-g.example", value: "ID=1" }]);
    await page();
    const write = (value: string, frameHost: string) =>
      fake.sendFromTab(TAB, {
        type: "js-cookie",
        cookie: {
          name: "__gads",
          value,
          domain: "",
          path: "/",
          expiresMs: "session",
          sameSite: "unspecified",
          secure: false,
          partitioned: false,
          writerScriptUrl: "https://securepubads.g.doubleclick.net/tag/js/gpt.js",
          viaTagManager: false,
          via: "documentCookie",
          timeMs: Date.now(),
          frameHost,
        },
      });
    await write("ID=frame", "widget.example-chat.com");
    await write("ID=1", "www.news-g.example");
    await checked();
    const byValue = (await listed()).network.flatMap((n) => n.setCookies.map((c) => [(c as { value?: string }).value, c.jar ?? null]));
    expect(byValue).toEqual(expect.arrayContaining([["ID=frame", "not-stored"], ["ID=1", "landed"]]));
    expect(stored().cookieLedger.landed).toEqual(["__gads\u0000"]);
  });

  it("raises no declared-support finding on a site whose only counted cookie the jar did not hold", async () => {
    // The site publishes gpc.json with gpc set to true. Its one counted cookie was not
    // stored: the write stays in the write counter, the count is 0, and the finding rests on
    // the count.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ gpc: true }), { status: 200, headers: { "content-type": "application/json" } })),
    );
    try {
      const [{ evaluate }, { getClassifier }] = await Promise.all([import("@gpc-inspector/engine"), import("../src/background/classifier.js")]);
      const read = async () => {
        const obs = (await fake.sendFromPopup({ type: "get-observations", tabId: TAB })) as import("@gpc-inspector/schema").ObservationSet;
        return { obs, flags: evaluate(obs, getClassifier()).map((f) => f.flag) };
      };
      fake.setJar([{ name: "IDE", domain: ".doubleclick.net", value: "abc" }]);
      await page();
      await fake.fireCommitted({ tabId: TAB, frameId: 0, url: "https://www.news-g.example/" });
      await exchange("k1", KARGO, AWSALB);
      await checked();
      const refused = await read();
      expect(refused.obs.wellKnown).toMatchObject({ present: true, gpc: true, fresh: true });
      expect(refused.obs.tallies).toMatchObject({ adCookieEvents: 1, adCookieKeys: [] });
      expect(refused.flags).not.toContain("declared-honor-cookie-set");

      // A cookie the jar holds is counted, and the finding follows the count.
      await exchange("d1", "https://securepubads.g.doubleclick.net/gpt.js", IDE);
      await checked();
      const counted = await read();
      expect(counted.obs.tallies.adCookieKeys).toEqual(["IDE\u0000.doubleclick.net"]);
      expect(counted.flags).toContain("declared-honor-cookie-set");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("drops a tab's waiting checks when it leaves for a page that is not tracked", async () => {
    fake.setJar([]);
    await page();
    await exchange("k1", KARGO, AWSALB);
    // The check is queued when the response's update runs.
    await new Promise((r) => setTimeout(r, 200));
    await fake.fireBeforeNavigate({ tabId: TAB, frameId: 0, url: "chrome://newtab/" });
    await checked();
    expect(fake.jarLookups()).toEqual([]);
    expect(fake.sessionStore()[`tab:${TAB}`]).toBeUndefined();
  });

  it("drops an answer for the page before when the tab has moved on", async () => {
    fake.setJar([]);
    await page();
    await exchange("k1", KARGO, AWSALB);
    await fake.fireBeforeNavigate({ tabId: TAB, frameId: 0, url: "https://www.news-k.example/" });
    await exchange("k2", KARGO, AWSALB);
    await checked();
    // One check, the new page's: the old page's was dropped with it.
    expect(fake.jarLookups()).toHaveLength(1);
    expect(stored().tallies.adCookieKeys).toEqual([]);
  });
});

describe("a page that did not load, and pages with no Consent Mode to observe", () => {
  beforeEach(async () => {
    await loadWorker();
    // get-observations starts the published-file check; answer it here, not from the network.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  type Got = { context: { loadError?: string | null }; capabilities: { dataLayer: boolean } };
  const observations = async (tabId: number): Promise<Got> =>
    (await fake.sendFromPopup({ type: "get-observations", tabId })) as Got;

  it("records the error Chrome reported for the top document", async () => {
    // ticketing-b.example, 2026-09-25: the load failed and Chrome showed its error page.
    // Without the error, the popup would render the empty defaults as a page with the
    // signal off.
    await fake.fireBeforeNavigate({ tabId: 60, frameId: 0, url: "https://www.ticketing-b.example/" });
    await fake.fireNavigationError({ tabId: 60, frameId: 0, url: "https://www.ticketing-b.example/", error: "net::ERR_CONNECTION_TIMED_OUT" });
    expect((await observations(60)).context.loadError).toBe("net::ERR_CONNECTION_TIMED_OUT");
  });

  it("does not call a navigation that stopped a failed load", async () => {
    // net::ERR_ABORTED: the user went elsewhere, or the response was a download or a 204.
    // The page on screen is the one being left, not an error page.
    await fake.fireBeforeNavigate({ tabId: 61, frameId: 0, url: "https://www.example.com/file.zip" });
    await fake.fireNavigationError({ tabId: 61, frameId: 0, url: "https://www.example.com/file.zip", error: "net::ERR_ABORTED" });
    expect((await observations(61)).context.loadError ?? null).toBeNull();
  });

  it("keeps the error through Chrome's own retry, which ends as an abort", async () => {
    // Every corpus run, 2026-09-25: about a second after a failed load Chrome retries it; the
    // retry starts a navigation (a reset) and, failing again, ends as net::ERR_ABORTED with
    // the same error page on screen. Clearing the error at the retry's start would leave the
    // popup describing the empty defaults again.
    const url = "https://gpc-check.invalid/";
    await fake.fireBeforeNavigate({ tabId: 65, frameId: 0, url });
    await fake.fireNavigationError({ tabId: 65, frameId: 0, url, error: "net::ERR_NAME_NOT_RESOLVED" });
    await fake.fireBeforeNavigate({ tabId: 65, frameId: 0, url });
    await fake.fireNavigationError({ tabId: 65, frameId: 0, url, error: "net::ERR_ABORTED" });
    const got = (await fake.sendFromPopup({ type: "get-observations", tabId: 65 })) as Got & {
      context: { loadObserved?: boolean; topSite: string };
    };
    expect(got.context.loadError).toBe("net::ERR_NAME_NOT_RESOLVED");
    expect(got.context.loadObserved).toBe(true);
  });

  it("does not carry the error into a navigation to another address", async () => {
    // From the error page to a download or a 204: the navigation ends as an abort without
    // committing, and the state is the new address's, which did not fail.
    await fake.fireBeforeNavigate({ tabId: 66, frameId: 0, url: "https://gpc-check.invalid/" });
    await fake.fireNavigationError({ tabId: 66, frameId: 0, url: "https://gpc-check.invalid/", error: "net::ERR_NAME_NOT_RESOLVED" });
    await fake.fireBeforeNavigate({ tabId: 66, frameId: 0, url: "https://www.example.com/file.zip" });
    await fake.fireNavigationError({ tabId: 66, frameId: 0, url: "https://www.example.com/file.zip", error: "net::ERR_ABORTED" });
    expect((await observations(66)).context.loadError ?? null).toBeNull();
  });

  it("ignores a frame that failed, and clears the error when a document commits", async () => {
    await fake.fireBeforeNavigate({ tabId: 62, frameId: 0, url: "https://www.example.com/" });
    await fake.fireNavigationError({ tabId: 62, frameId: 5, url: "https://ads.example/f", error: "net::ERR_BLOCKED_BY_CLIENT" });
    expect((await observations(62)).context.loadError ?? null).toBeNull();

    await fake.fireNavigationError({ tabId: 62, frameId: 0, url: "https://www.example.com/", error: "net::ERR_NAME_NOT_RESOLVED" });
    expect((await observations(62)).context.loadError).toBe("net::ERR_NAME_NOT_RESOLVED");

    // The error page is still on screen while the next navigation is under way.
    await fake.fireBeforeNavigate({ tabId: 62, frameId: 0, url: "https://www.example.com/" });
    expect((await observations(62)).context.loadError).toBe("net::ERR_NAME_NOT_RESOLVED");

    await fake.fireCommitted({ tabId: 62, frameId: 0, url: "https://www.example.com/", documentId: "LOADED" });
    expect((await observations(62)).context.loadError ?? null).toBeNull();
  });

  it("reports an unwatched dataLayer as a gap only on a page where a Google tag loaded", async () => {
    // 20 of the 60 corpus sites had no Google tag. Listing the capability as failed on each
    // would put the bundle at odds with the popup, which correctly says nothing.
    await fake.fireBeforeNavigate({ tabId: 63, frameId: 0, url: "https://www.marketplace-a.example/" });
    await fake.sendFromTab(63, { type: "capabilities", capabilities: { dataLayer: false } });
    expect((await observations(63)).capabilities.dataLayer).toBe(true);

    await fake.fireBeforeNavigate({ tabId: 64, frameId: 0, url: "https://www.apparel-c.example/" });
    await fake.sendFromTab(64, { type: "capabilities", capabilities: { dataLayer: false } });
    await fake.sendFromTab(64, {
      type: "gtm",
      gtm: { present: true, containerIds: ["GTM-XAPC100"], gtagIds: [], consentMode: null },
    });
    expect((await observations(64)).capabilities.dataLayer).toBe(false);

    // apparel-c.example's own case: the consent store was read, so Consent Mode was observed without
    // the dataLayer, and the bundle says so as the popup does.
    await fake.sendFromTab(64, {
      type: "gtm",
      gtm: {
        present: true,
        containerIds: ["GTM-XAPC100"],
        gtagIds: [],
        consentMode: null,
        effectiveConsent: { ad_storage: { default: false, update: false, implicit: true } },
      },
    });
    expect((await observations(64)).capabilities.dataLayer).toBe(true);
  });
});

describe("leaving for a page that is not tracked", () => {
  beforeEach(async () => {
    await loadWorker();
  });

  it("does not write back the changes the page being left still had queued", async () => {
    // Clearing the tab takes its queue with it. A queue left behind would have the next
    // flush apply the old page's last requests to a fresh state, under no site, and write it
    // to the store.
    const PX = "https://securepubads.g.doubleclick.net/px";
    await fake.fireBeforeNavigate({ tabId: 61, frameId: 0, url: "https://news.example/" });
    await fake.fireCommitted({ tabId: 61, frameId: 0, url: "https://news.example/" });
    await new Promise((r) => setTimeout(r, 200));
    await fake.fireSendHeaders({ tabId: 61, requestId: "late", url: PX, type: "image", requestHeaders: [] });
    await fake.fireBeforeNavigate({ tabId: 61, frameId: 0, url: "chrome://newtab/" });
    await new Promise((r) => setTimeout(r, 300));

    expect(fake.sessionStore()["tab:61"]).toBeUndefined();
  });
});

describe("a prerendered page is captured as the page it becomes", () => {
  beforeEach(async () => {
    await loadWorker();
  });

  // The events in the order Chrome 155 sends them for a page prerendered from another one
  // and then shown: the prerender runs in the tab under frame 6 with documentLifecycle
  // "prerender", and its activation is a top-level navigation that commits the same document
  // with no request and no new content-script report.
  const TAB = 95;
  const A = "https://www.shop-a.example/";
  const B = "https://www.shop-a.example/sale/";
  const settle = () => new Promise((r) => setTimeout(r, 200));
  const prerendering = { frameId: 6, documentLifecycle: "prerender" } as const;
  let requestIds = 0;
  const request = (url: string, type: string, from: object) =>
    fake.fireSendHeaders({ tabId: TAB, requestId: `r${++requestIds}`, url, type, ...from });
  const signalState = { type: "signal-state", source: "this-extension", readTracking: "active", value: true };

  async function loadA(): Promise<void> {
    await fake.fireBeforeNavigate({ tabId: TAB, frameId: 0, url: A });
    await request(A, "main_frame", { frameId: 0, documentLifecycle: "active" });
    await fake.fireCommitted({ tabId: TAB, frameId: 0, url: A, documentId: "DOC_A" });
    await fake.sendFromTab(TAB, signalState, { frameId: 0, documentId: "DOC_A", documentLifecycle: "active" });
    await request("https://cdn.shop-a.example/a.js", "script", { frameId: 0, documentId: "DOC_A", documentLifecycle: "active" });
  }

  async function prerenderB(): Promise<void> {
    await fake.fireBeforeNavigate({ tabId: TAB, url: B, parentFrameId: -1, ...prerendering });
    await request(B, "main_frame", prerendering);
    await fake.fireCommitted({ tabId: TAB, url: B, parentFrameId: -1, documentId: "DOC_B", ...prerendering });
    await fake.sendFromTab(TAB, signalState, { documentId: "DOC_B", ...prerendering });
    await request("https://www.google-analytics.com/g/collect?v=2", "ping", { documentId: "DOC_B", ...prerendering });
    // A frame of the prerendered page, and a request from inside it.
    await fake.fireBeforeNavigate({ tabId: TAB, frameId: 7, parentFrameId: 6, url: "https://js.stripe.com/frame", documentLifecycle: "prerender" });
    await request("https://js.stripe.com/frame", "sub_frame", { frameId: 7, parentFrameId: 6, documentLifecycle: "prerender" });
    await fake.fireCommitted({ tabId: TAB, frameId: 7, parentFrameId: 6, url: "https://js.stripe.com/frame", documentId: "DOC_FRAME", parentDocumentId: "DOC_B", documentLifecycle: "prerender" });
    await request("https://m.stripe.com/6", "xmlhttprequest", { frameId: 7, documentId: "DOC_FRAME", documentLifecycle: "prerender" });
  }

  async function showB(): Promise<void> {
    await fake.fireBeforeNavigate({ tabId: TAB, frameId: 0, url: B, documentLifecycle: "active" });
    await fake.fireCommitted({ tabId: TAB, frameId: 0, url: B, documentId: "DOC_B", documentLifecycle: "active" });
    await request("https://www.google-analytics.com/g/collect?v=2&after=1", "ping", { frameId: 0, documentId: "DOC_B", documentLifecycle: "active" });
  }

  type Obs = {
    context: { finalUrl: string; loadObserved?: boolean; incompleteReasons?: string[] };
    signal: { source: string; totalRequestCount: number };
    network: { url: string }[];
  };
  const observations = async () => (await fake.sendFromPopup({ type: "get-observations", tabId: TAB })) as Obs;

  it("keeps what the prerender did off the page on screen", async () => {
    await loadA();
    await prerenderB();
    await settle();
    const obs = await observations();
    expect(obs.network.map((o) => o.url)).toEqual([A, "https://cdn.shop-a.example/a.js"]);
    expect(obs.signal.totalRequestCount).toBe(2);
  });

  it("hands the prerender's capture to the page when it is shown, and keeps what it does after", async () => {
    // Before the fix the activation's reset retired the prerendered document as one of A's,
    // so the page shown had no requests and no signal report, and the view stayed pending.
    await loadA();
    await prerenderB();
    await showB();
    await settle();
    const obs = await observations();
    expect(obs.context.finalUrl).toBe(B);
    expect(obs.context.loadObserved).toBe(true);
    expect(obs.context.incompleteReasons).toEqual([]);
    expect(obs.signal.source).toBe("this-extension");
    expect(obs.network.map((o) => o.url)).toEqual([
      B,
      "https://www.google-analytics.com/g/collect?v=2",
      "https://js.stripe.com/frame",
      "https://m.stripe.com/6",
      "https://www.google-analytics.com/g/collect?v=2&after=1",
    ]);
    expect(obs.signal.totalRequestCount).toBe(5);
  });

  it("drops a prerender's frame's unload writes on the page after, as any frame's", async () => {
    await loadA();
    await prerenderB();
    await showB();
    await fake.fireBeforeNavigate({ tabId: TAB, frameId: 0, url: A });
    await fake.fireCommitted({ tabId: TAB, frameId: 0, url: A, documentId: "DOC_A2" });
    await request("https://m.stripe.com/6?unload=1", "beacon", { frameId: 7, documentId: "DOC_FRAME", documentLifecycle: "pending_deletion" });
    await settle();
    expect((await observations()).network.map((o) => o.url)).toEqual([]);
  });

  it("says the capture is incomplete when the worker that held the prerender stopped", async () => {
    await loadA();
    await prerenderB();
    await new Promise((r) => setTimeout(r, 1_300));
    fake.reclaimWorker();
    vi.resetModules();
    await import("../src/background/sw.js");
    await showB();
    await settle();
    const obs = await observations();
    expect(obs.context.incompleteReasons).toContain("prerender-lost");
    expect(obs.network.map((o) => o.url)).toEqual(["https://www.google-analytics.com/g/collect?v=2&after=1"]);
  });

  it("says so too when the worker stopped before the prerendered page committed", async () => {
    await loadA();
    await fake.fireBeforeNavigate({ tabId: TAB, url: B, parentFrameId: -1, ...prerendering });
    await request(B, "main_frame", prerendering);
    await new Promise((r) => setTimeout(r, 1_300));
    fake.reclaimWorker();
    vi.resetModules();
    await import("../src/background/sw.js");
    await fake.fireCommitted({ tabId: TAB, url: B, parentFrameId: -1, documentId: "DOC_B", ...prerendering });
    await fake.sendFromTab(TAB, signalState, { documentId: "DOC_B", ...prerendering });
    await showB();
    await settle();
    expect((await observations()).context.incompleteReasons).toContain("prerender-lost");
  });

  it("leaves a normal navigation's capture complete", async () => {
    await loadA();
    await prerenderB();
    await fake.fireBeforeNavigate({ tabId: TAB, frameId: 0, url: "https://www.other.example/" });
    await request("https://www.other.example/", "main_frame", { frameId: 0, documentLifecycle: "active" });
    await fake.fireCommitted({ tabId: TAB, frameId: 0, url: "https://www.other.example/", documentId: "DOC_C" });
    await settle();
    const obs = await observations();
    expect(obs.context.incompleteReasons).toEqual([]);
    expect(obs.network.map((o) => o.url)).toEqual(["https://www.other.example/"]);
  });
});

describe("a page restored from the back/forward cache", () => {
  beforeEach(async () => {
    await loadWorker();
  });

  // The events in the order Chrome 155 sends them for P1, then P2, then back to P1 restored
  // from the back/forward cache: the restore commits P1's own document again, with no
  // request and no content-script report.
  const TAB = 96;
  const P1 = "https://www.shop-b.example/";
  const P2 = "https://www.shop-b.example/cart/";
  const P3 = "https://www.shop-b.example/help/";
  const settle = () => new Promise((r) => setTimeout(r, 200));
  let requestIds = 0;
  const request = (url: string, type: string, from: object) =>
    fake.fireSendHeaders({ tabId: TAB, requestId: `b${++requestIds}`, url, type, ...from });
  const signalState = { type: "signal-state", source: "this-extension", readTracking: "active", value: true };

  async function load(url: string, documentId: string): Promise<void> {
    await fake.fireBeforeNavigate({ tabId: TAB, frameId: 0, url });
    await request(url, "main_frame", { frameId: 0, documentLifecycle: "active" });
    await fake.fireCommitted({ tabId: TAB, frameId: 0, url, documentId });
    await fake.sendFromTab(TAB, signalState, { frameId: 0, documentId, documentLifecycle: "active" });
    await request(`${url}app.js`, "script", { frameId: 0, documentId, documentLifecycle: "active" });
  }

  type Obs = {
    context: { finalUrl: string; loadObserved?: boolean; restoredFromCache?: boolean };
    signal: { source: string; propertyValue: unknown; totalRequestCount: number };
    network: { url: string }[];
  };
  const observations = async () => (await fake.sendFromPopup({ type: "get-observations", tabId: TAB })) as Obs;

  it("says the load was not observed, and keeps the page's own signal report", async () => {
    // Before, the reset left an empty capture that no report would ever fill, so the view
    // stayed pending, and the status read "signal is not set".
    await load(P1, "DOC_P1");
    await load(P2, "DOC_P2");
    await fake.fireBeforeNavigate({ tabId: TAB, frameId: 0, url: P1 });
    await fake.fireCommitted({ tabId: TAB, frameId: 0, url: P1, documentId: "DOC_P1" });
    await request("https://www.shop-b.example/api/after", "xmlhttprequest", { frameId: 0, documentId: "DOC_P1", documentLifecycle: "active" });
    await settle();
    const obs = await observations();
    expect(obs.context.finalUrl).toBe(P1);
    expect(obs.context.loadObserved).toBe(false);
    expect(obs.context.restoredFromCache).toBe(true);
    expect(obs.signal.source).toBe("this-extension");
    expect(obs.signal.propertyValue).toBe(true);
    expect(obs.network.map((o) => o.url)).toEqual(["https://www.shop-b.example/api/after"]);
  });

  it("treats a page loaded again, with a new document, as a normal load", async () => {
    await load(P1, "DOC_P1");
    await load(P2, "DOC_P2");
    await load(P1, "DOC_P1_AGAIN");
    await settle();
    const obs = await observations();
    expect(obs.context.loadObserved).toBe(true);
    expect(obs.context.restoredFromCache).toBeUndefined();
    expect(obs.signal.totalRequestCount).toBe(2);
  });

  it("does not carry the restore to the page after it", async () => {
    await load(P1, "DOC_P1");
    await load(P2, "DOC_P2");
    await fake.fireBeforeNavigate({ tabId: TAB, frameId: 0, url: P1 });
    await fake.fireCommitted({ tabId: TAB, frameId: 0, url: P1, documentId: "DOC_P1" });
    await load(P3, "DOC_P3");
    await settle();
    const obs = await observations();
    expect(obs.context.loadObserved).toBe(true);
    expect(obs.context.restoredFromCache).toBeUndefined();
  });

  it("drops what a cached page two pages back sends, as the page before's", async () => {
    // Only the page left last has its documents retired, so a cached page further back
    // was counted on the page on screen.
    await load(P1, "DOC_P1");
    await load(P2, "DOC_P2");
    await load(P3, "DOC_P3");
    await request("https://www.google-analytics.com/g/collect?late=1", "ping", { frameId: 0, documentId: "DOC_P1", documentLifecycle: "cached" });
    await fake.sendFromTab(TAB, { type: "delivery-gap" }, { frameId: 0, documentId: "DOC_P1", documentLifecycle: "cached" });
    await settle();
    const obs = (await observations()) as Obs & { context: { incompleteReasons?: string[] } };
    expect(obs.network.map((o) => o.url)).toEqual([P3, `${P3}app.js`]);
    expect(obs.context.incompleteReasons).toEqual([]);
  });
});
