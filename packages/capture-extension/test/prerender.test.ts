// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { HeldPrerenders, HELD_CHANGES_CAP, HELD_CHANGES_TAB_CAP, HELD_PRERENDERS_CAP, frameOf } from "../src/background/prerender.js";

type Log = string[];
const TAB = 4;
const prerender = (frameId: number, parentFrameId = -1) => ({ frameId, parentFrameId, documentLifecycle: "prerender" });
const note = (word: string) => (s: Log) => void s.push(word);

/** Replay an activation onto a fresh log, as the tab's queue applies it. */
function replay(held: HeldPrerenders<Log>, documentId: string): { log: Log; complete: boolean } | null {
  const a = held.activate(TAB, documentId);
  if (a === null) return null;
  const log: Log = [];
  for (const change of a.changes) change(log);
  return { log, complete: a.complete };
}

describe("a prerender's changes are held until it is shown", () => {
  it("passes on any event that is not a prerender's", () => {
    const held = new HeldPrerenders<Log>();
    held.started(TAB, prerender(6));
    expect(held.hold(TAB, { frameId: 0, documentLifecycle: "active" }, note("a"))).toBe(false);
    expect(held.hold(TAB, { frameId: 6, documentLifecycle: "pending_deletion" }, note("b"))).toBe(false);
    expect(held.hold(TAB, {}, note("c"))).toBe(false);
  });

  it("hands each prerender its own changes, by frame, in order", () => {
    const held = new HeldPrerenders<Log>();
    held.started(TAB, prerender(6));
    held.started(TAB, prerender(9));
    held.started(TAB, prerender(7, 6));
    held.started(TAB, prerender(8, 7));
    held.committed(TAB, 6, "B");
    held.committed(TAB, 9, "C");
    held.hold(TAB, prerender(6), note("b1"));
    held.hold(TAB, prerender(9), note("c1"));
    held.hold(TAB, prerender(8), note("b2"));
    // A frame's own navigation request names its parent before the frame has started.
    held.hold(TAB, prerender(12, 7), note("b3"));
    expect(replay(held, "B")).toEqual({ log: ["b1", "b2", "b3"], complete: true });
    // Taken once; the other prerender is still held.
    expect(replay(held, "B")).toBeNull();
    expect(replay(held, "C")).toEqual({ log: ["c1"], complete: true });
  });

  it("places a frame it never saw start in the tab's one prerender", () => {
    const held = new HeldPrerenders<Log>();
    held.started(TAB, prerender(6));
    held.committed(TAB, 6, "B");
    held.hold(TAB, prerender(30), note("blank frame"));
    expect(replay(held, "B")).toEqual({ log: ["blank frame"], complete: true });
  });

  it("drops a frame it cannot place among several, and marks each as having lost it", () => {
    const held = new HeldPrerenders<Log>();
    held.started(TAB, prerender(6));
    held.started(TAB, prerender(9));
    held.committed(TAB, 6, "B");
    expect(held.hold(TAB, prerender(30), note("unknown"))).toBe(true);
    expect(replay(held, "B")).toEqual({ log: [], complete: false });
  });

  it("drops a prerender's event when it holds none for the tab, as after a worker restart", () => {
    const held = new HeldPrerenders<Log>();
    expect(held.hold(TAB, prerender(6), note("orphan"))).toBe(true);
    expect(replay(held, "B")).toBeNull();
  });

  it("stops holding past the cap, and says so", () => {
    const held = new HeldPrerenders<Log>();
    held.started(TAB, prerender(6));
    held.committed(TAB, 6, "B");
    for (let i = 0; i <= HELD_CHANGES_CAP; i++) held.hold(TAB, prerender(6), note("x"));
    const r = replay(held, "B");
    expect(r?.log).toHaveLength(HELD_CHANGES_CAP);
    expect(r?.complete).toBe(false);
  });

  it("stops holding past the tab's cap across its prerenders, and says so", () => {
    const held = new HeldPrerenders<Log>();
    const tops = [6, 9, 11];
    for (const f of tops) {
      held.started(TAB, prerender(f));
      held.committed(TAB, f, `D${f}`);
    }
    for (let i = 0; i < HELD_CHANGES_TAB_CAP; i++) held.hold(TAB, prerender(tops[Math.floor(i / HELD_CHANGES_CAP)] ?? 6), note("x"));
    held.hold(TAB, prerender(11), note("one too many"));
    expect(replay(held, "D11")).toEqual({ log: [], complete: false });
    expect(replay(held, "D6")?.complete).toBe(true);
  });

  it("starts a prerender over when its top frame navigates again", () => {
    const held = new HeldPrerenders<Log>();
    held.started(TAB, prerender(6));
    held.hold(TAB, prerender(6), note("first page"));
    held.started(TAB, prerender(6));
    held.committed(TAB, 6, "B2");
    held.hold(TAB, prerender(6), note("second page"));
    expect(replay(held, "B2")).toEqual({ log: ["second page"], complete: true });
  });

  it("keeps the most recent prerenders of a tab, and forgets a closed tab's", () => {
    const held = new HeldPrerenders<Log>();
    for (let f = 1; f <= HELD_PRERENDERS_CAP + 1; f++) {
      held.started(TAB, prerender(f));
      held.committed(TAB, f, `D${f}`);
    }
    expect(replay(held, "D1")).toBeNull();
    expect(replay(held, `D${HELD_PRERENDERS_CAP + 1}`)).toEqual({ log: [], complete: true });
    held.forgetTab(TAB);
    expect(replay(held, "D2")).toBeNull();
  });

  it("reads the frame fields Chrome sends, and nothing else", () => {
    expect(frameOf({ frameId: 6, parentFrameId: -1, documentLifecycle: "prerender", url: "x" })).toEqual({
      frameId: 6,
      parentFrameId: -1,
      documentLifecycle: "prerender",
    });
    expect(frameOf({ frameId: "6" })).toEqual({ frameId: undefined, parentFrameId: undefined, documentLifecycle: undefined });
  });
});
