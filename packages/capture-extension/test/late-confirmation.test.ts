// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import {
  watchForLateConfirmation,
  CONFIRMATION_MIN_GAP_MS,
  CONFIRMATION_WATCH_MS,
  type LateConfirmationDeps,
  type RecordLike,
} from "../src/observe/late-confirmation.js";

/**
 * A page, a fake MutationObserver and a clock driven by hand. The words test is the real
 * shape of the check (a notice phrase in some text); `scanResults` is what each rendered-text
 * scan finds, in order.
 */
function page(opts: { documentText?: string; scanResults?: boolean[]; roots?: string[] } = {}) {
  let callback: ((records: readonly RecordLike[]) => void) | null = null;
  const observeOptions: MutationObserverInit[] = [];
  const observed: { target: unknown; options: MutationObserverInit }[] = [];
  // Open shadow roots: each `{ textContent }`, known at the start or under an inserted node.
  const roots: { textContent: string }[] = (opts.roots ?? []).map((textContent) => ({ textContent }));
  const rootListeners: ((root: { textContent: string }) => void)[] = [];
  const addRoot = (textContent: string) => {
    const root = { textContent };
    roots.push(root);
    for (const l of rootListeners) l(root);
    return root;
  };
  let disconnected = false;
  let now = 1_000_000;
  let nextId = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  const results = [...(opts.scanResults ?? [])];
  const scanTimes: number[] = [];
  let found = false;

  const deps: LateConfirmationDeps = {
    root: {},
    shadowRoots: {
      subscribe: (onRoot) => {
        rootListeners.push(onRoot);
        for (const r of [...roots]) onRoot(r);
      },
      discover: (nodes) => {
        for (let i = 0; i < nodes.length; i++) {
          const shadow = (nodes[i] as { shadow?: string }).shadow;
          if (shadow !== undefined) addRoot(shadow);
        }
      },
    },
    documentText: () => opts.documentText ?? "",
    mightBeNotice: (text) => /opt-out (request|signal) honored/i.test(text),
    scan: () => {
      scanTimes.push(now);
      const hit = results.shift() ?? false;
      if (hit) found = true;
      return hit;
    },
    found: () => found,
    createObserver: (cb) => {
      callback = cb;
      return {
        observe: (target, options) => {
          observeOptions.push(options);
          observed.push({ target, options });
        },
        disconnect: () => {
          disconnected = true;
        },
      };
    },
    setTimeout: (fn, ms) => {
      const id = ++nextId;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (handle) => {
      const i = timers.findIndex((t) => t.id === handle);
      if (i >= 0) timers.splice(i, 1);
    },
    now: () => now,
  };

  return {
    deps,
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > target) break;
        timers.shift();
        now = t.at;
        t.fn();
      }
      now = target;
    },
    mutate: (...records: RecordLike[]) => callback?.(records),
    added: (text: string): RecordLike => ({ type: "childList", target: {}, addedNodes: [{ textContent: text }] }),
    attribute: (): RecordLike => ({ type: "attributes", target: {}, addedNodes: [] }),
    textChange: (data: string): RecordLike => ({ type: "characterData", target: { data }, addedNodes: [] }),
    /** A host inserted with an open root that holds `shadow`. */
    addedHost: (shadow: string): RecordLike => ({
      type: "childList",
      target: {},
      addedNodes: [{ textContent: "", shadow } as { textContent: string }],
    }),
    roots,
    scanTimes,
    observeOptions,
    observed,
    get disconnected() {
      return disconnected;
    },
    timedScanFound: () => {
      found = true;
    },
    get start() {
      return 1_000_000;
    },
  };
}

describe("watchForLateConfirmation (news-f.example's late Osano banner, 2026-09-25)", () => {
  it("never scans a page whose text never carries the notice's words", () => {
    const p = page();
    watchForLateConfirmation(p.deps);
    p.mutate(p.added("Weekly deals, free shipping"), p.attribute(), p.textChange("Opt out of emails"));
    p.advance(CONFIRMATION_WATCH_MS);
    expect(p.scanTimes).toEqual([]);
    // Class and style changes were never watched on this page.
    expect(p.observeOptions).toEqual([{ subtree: true, childList: true, characterData: true }]);
    expect(p.disconnected).toBe(true);
  });

  it("scans when the banner is inserted and stops at the match", () => {
    const p = page({ scanResults: [true] });
    watchForLateConfirmation(p.deps);
    p.advance(8000);
    p.mutate(p.added("Opt-Out Signal Honored"));
    p.advance(0);
    expect(p.scanTimes).toEqual([p.start + 8000]);
    expect(p.disconnected).toBe(true);
  });

  it("keeps rescanning a banner inserted hidden, at most every two seconds, until it shows", () => {
    const p = page({ scanResults: [false, false, true] });
    watchForLateConfirmation(p.deps);
    p.mutate(p.added("Opt-Out Request Honored"));
    p.advance(0);
    // Now class and style changes count: the banner can become visible without new text.
    expect(p.observeOptions[1]?.attributes).toBe(true);
    p.advance(100);
    p.mutate(p.attribute());
    p.mutate(p.attribute());
    p.advance(CONFIRMATION_MIN_GAP_MS);
    p.mutate(p.attribute());
    p.advance(CONFIRMATION_MIN_GAP_MS);
    expect(p.scanTimes).toEqual([p.start, p.start + CONFIRMATION_MIN_GAP_MS, p.start + 2 * CONFIRMATION_MIN_GAP_MS]);
    expect(p.disconnected).toBe(true);
  });

  it("counts the words already in the document when it starts", () => {
    const p = page({ documentText: "… Opt-Out Request Honored …", scanResults: [true] });
    watchForLateConfirmation(p.deps);
    p.advance(0);
    expect(p.scanTimes).toHaveLength(1);
  });

  it("stops after a minute, and scans nothing after that", () => {
    const p = page({ scanResults: [false] });
    watchForLateConfirmation(p.deps);
    p.mutate(p.added("Opt-Out Request Honored"));
    p.advance(CONFIRMATION_WATCH_MS);
    expect(p.disconnected).toBe(true);
    const before = p.scanTimes.length;
    p.mutate(p.attribute());
    p.advance(10_000);
    expect(p.scanTimes).toHaveLength(before);
  });

  it("observes each open root known at the start, and scans when one carries the words", () => {
    const p = page({ roots: ["Cookie choices", "Opt-Out Signal Honored"], scanResults: [true] });
    watchForLateConfirmation(p.deps);
    // The document, then each root; the second root's words make the page a candidate, so
    // every target is observed again with class and style changes.
    expect(p.observed.map((o) => o.target)).toEqual([
      p.deps.root,
      p.roots[0],
      p.roots[1],
      p.deps.root,
      p.roots[0],
      p.roots[1],
    ]);
    expect(p.observed.slice(-3).every((o) => o.options.attributes === true)).toBe(true);
    p.advance(0);
    expect(p.scanTimes).toEqual([p.start]);
    expect(p.disconnected).toBe(true);
  });

  it("observes a root under an inserted host, and scans when its text changes to the notice", () => {
    const p = page({ scanResults: [true] });
    watchForLateConfirmation(p.deps);
    p.advance(3000);
    p.mutate(p.addedHost("Loading"));
    expect(p.observed.map((o) => o.target)).toEqual([p.deps.root, p.roots[0]]);
    p.advance(1500);
    expect(p.scanTimes).toEqual([]);
    // A record from inside the root, delivered to the same observer.
    p.mutate(p.added("Opt-Out Signal Honored"));
    p.advance(0);
    expect(p.scanTimes).toEqual([p.start + 4500]);
  });

  it("scans when an inserted host's root already holds the notice", () => {
    const p = page({ scanResults: [true] });
    watchForLateConfirmation(p.deps);
    p.mutate(p.addedHost("Opt-Out Request Honored"));
    p.advance(0);
    expect(p.scanTimes).toHaveLength(1);
  });

  it("scans for a root found later when the page is already a candidate", () => {
    // The words in an inline script made the page a candidate at the start; the root a
    // custom element attaches as it upgrades comes with no mutation record to scan on.
    const p = page({ documentText: "var t = 'Opt-Out Signal Honored'", scanResults: [false, true] });
    watchForLateConfirmation(p.deps);
    p.advance(8000);
    expect(p.scanTimes).toEqual([p.start]);
    p.deps.shadowRoots.discover([{ shadow: "Opt-Out Signal Honored" }]);
    p.advance(0);
    expect(p.scanTimes).toEqual([p.start, p.start + 8000]);
  });

  it("observes no root found after it stopped", () => {
    const p = page();
    watchForLateConfirmation(p.deps);
    p.advance(CONFIRMATION_WATCH_MS);
    const before = p.observed.length;
    p.deps.shadowRoots.discover([{ shadow: "Opt-Out Request Honored" }]);
    expect(p.observed).toHaveLength(before);
  });

  it("stops without scanning once a timed scan found the notice first", () => {
    const p = page();
    watchForLateConfirmation(p.deps);
    p.timedScanFound();
    p.mutate(p.added("Opt-Out Request Honored"));
    p.advance(5000);
    expect(p.scanTimes).toEqual([]);
    expect(p.disconnected).toBe(true);
  });
});
