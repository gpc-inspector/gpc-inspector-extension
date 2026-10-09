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
function page(opts: { documentText?: string; scanResults?: boolean[] } = {}) {
  let callback: ((records: readonly RecordLike[]) => void) | null = null;
  const observeOptions: MutationObserverInit[] = [];
  let disconnected = false;
  let now = 1_000_000;
  let nextId = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  const results = [...(opts.scanResults ?? [])];
  const scanTimes: number[] = [];
  let found = false;

  const deps: LateConfirmationDeps = {
    root: {},
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
        observe: (_target, options) => void observeOptions.push(options),
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
    scanTimes,
    observeOptions,
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
